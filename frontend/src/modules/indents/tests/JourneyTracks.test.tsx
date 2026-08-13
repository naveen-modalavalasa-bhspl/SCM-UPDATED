import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IndentJourneyPage } from "../pages/JourneyPage";
import {
  buildJourneyTracks, derivedJourneyStages, journeyEventStageType, journeyEventStatus,
  journeySteps, journeyTrackKey,
} from "../journeyModel";
import { indentApi } from "../api";
import type { IndentJourney } from "../types";

const mockAccount = vi.hoisted(() => ({ employeeId: 1, activePositionId: 10 }));

vi.mock("@/shared/auth/AuthContext", () => ({
  useAuth: () => ({
    can: () => true,
    me: {
      employee: { id: mockAccount.employeeId, name: "Test User" },
      active_position: { id: mockAccount.activePositionId, name: "OE-TEST", is_primary: true },
      permissions: [],
    },
  }),
}));

vi.mock("../api", () => {
  const scoped = (scope: { employeeId: number | null; activePositionId: number | null }) =>
    ["indents-module", scope.employeeId, scope.activePositionId] as const;
  return {
    INDENT_QUERY_STALE_TIME: 45_000,
    INDENT_QUERY_GC_TIME: 5 * 60_000,
    indentKeys: {
      all: scoped,
      detail: (scope: Parameters<typeof scoped>[0], id: number) => [...scoped(scope), "detail", id] as const,
      journey: (scope: Parameters<typeof scoped>[0], id: number) => [...scoped(scope), "journey", 4, id] as const,
    },
    isIndentUnavailableError: () => false,
    useIndentAccountScope: () => ({ ...mockAccount }),
    useIndentAccountCacheIsolation: () => undefined,
    indentApi: { journey: vi.fn() },
  };
});

/**
 * An indent that has travelled the whole chain: its own ladder came back as
 * `stages`, everything downstream only as immutable history events — which is
 * exactly what the Journey endpoint serves.
 */
function fulfilledJourney(overrides: Partial<IndentJourney> = {}): IndentJourney {
  return {
    indent_id: 42,
    indent_no: "IND/2026/0042",
    status: "CLOSED",
    requested_by_name: "A Anil Kumar",
    requested_by_position: "DRIVER-AP-104",
    created_at: "2026-07-27T09:00:00Z",
    current_stage: "Completed",
    current_stage_message: "Completed",
    final_any_one_outcome: "Approved by SPH",
    phases: [
      { sequence: 1, title: "Draft", status: "APPROVED", stage_type: "phase" },
      { sequence: 2, title: "Submitted", status: "APPROVED", stage_type: "phase" },
      { sequence: 3, title: "Approvals", status: "APPROVED", stage_type: "phase" },
      { sequence: 4, title: "Allocation", status: "APPROVED", stage_type: "phase" },
      { sequence: 5, title: "Warehouse", status: "APPROVED", stage_type: "phase" },
      { sequence: 6, title: "Delivery", status: "APPROVED", stage_type: "phase" },
      { sequence: 7, title: "Acknowledgement", status: "APPROVED", stage_type: "phase" },
    ],
    stages: [
      {
        sequence: 1, title: "Draft created", status: "APPROVED", stage_type: "draft",
        approver_name: "A Anil Kumar", timestamp: "2026-07-27T09:00:00Z",
      },
      {
        sequence: 2, title: "Request submitted", status: "SUBMITTED", stage_type: "submission",
        approver_name: "A Anil Kumar", timestamp: "2026-07-27T09:05:00Z",
      },
      {
        sequence: 3, title: "OE Review", status: "APPROVED", stage_type: "approval",
        approver_name: "C Ramakrishna", position_name: "OE-AP-104", timestamp: "2026-07-27T09:30:00Z",
      },
      {
        sequence: 4, title: "DM Review", status: "APPROVED", stage_type: "approval",
        approver_name: "A Raveendra Prasad", position_name: "District Manager",
        timestamp: "2026-07-27T09:45:00Z",
      },
      {
        sequence: 5, title: "RM Review", status: "APPROVED", stage_type: "approval",
        approver_name: "K Suresh", position_name: "Regional Manager",
        timestamp: "2026-07-27T10:00:00Z",
      },
      {
        sequence: 6, title: "Final Approval - SPH or COO", status: "APPROVED", stage_type: "final",
        approver_name: "SPH", position_name: "SPH-AP-104", timestamp: "2026-07-27T10:30:00Z",
      },
    ],
    history: [
      {
        id: "workflow:6", event_type: "APPROVED", title: "SPH approved",
        actor_name: "SPH", timestamp: "2026-07-27T10:30:00Z",
      },
      {
        id: "allocation-created:5", event_type: "ALLOCATION_CREATED", title: "Allocation created",
        actor_name: "Store Keeper", reference_no: "ALLOC/2026/0005",
        timestamp: "2026-07-27T11:00:00Z",
      },
      {
        id: "workflow:11:31", event_type: "ALLOCATION_APPROVAL_APPROVED",
        title: "Assistant Manager approved", actor_name: "M Kiran",
        position_name: "Assistant Manager - Inventory", reference_no: "ALLOC/2026/0005",
        timestamp: "2026-07-27T11:20:00Z",
      },
      {
        id: "workflow:11:32", event_type: "ALLOCATION_APPROVAL_APPROVED",
        title: "Assistant Manager approved", actor_name: "R Latha",
        position_name: "Assistant Manager - Stores", reference_no: "ALLOC/2026/0005",
        timestamp: "2026-07-27T11:40:00Z",
      },
      {
        id: "workflow:11:33", event_type: "ALLOCATION_APPROVAL_APPROVED",
        title: "Inventory Manager approved", actor_name: "P Naveen",
        position_name: "Inventory Manager", reference_no: "ALLOC/2026/0005",
        timestamp: "2026-07-27T12:00:00Z",
      },
      {
        id: "allocation:5", event_type: "STOCK_ALLOCATED", title: "Stock allocated",
        actor_name: "Store Keeper", reference_no: "ALLOC/2026/0005",
        quantity_summary: "5 of 5 allocated", timestamp: "2026-07-27T12:05:00Z",
      },
      {
        id: "workflow:21:41", event_type: "WAREHOUSE_APPROVAL_APPROVED",
        title: "Warehouse Manager approved", actor_name: "S Bhaskar",
        position_name: "Warehouse Manager", reference_no: "ISS/2026/0009",
        timestamp: "2026-07-28T09:00:00Z",
      },
      {
        id: "warehouse-issue:9", event_type: "WAREHOUSE_ISSUED", title: "Issued from warehouse",
        actor_name: "S Bhaskar", reference_no: "ISS/2026/0009",
        quantity_summary: "5 of 5 issued", timestamp: "2026-07-28T09:30:00Z",
      },
      {
        id: "dispatch:3", event_type: "DISPATCHED", title: "Dispatched",
        actor_name: "Gate Security", reference_no: "DSP/2026/0003",
        timestamp: "2026-07-28T11:00:00Z",
      },
      {
        id: "delivery:3", event_type: "DELIVERED", title: "Delivered",
        reference_no: "DSP/2026/0003", timestamp: "2026-07-28T15:00:00Z",
      },
      {
        id: "acknowledgement:77", event_type: "ACKNOWLEDGEMENT_SUBMITTED",
        title: "Acknowledgement submitted", actor_name: "A Anil Kumar",
        quantity_summary: "5 of 5 received", timestamp: "2026-07-28T16:00:00Z",
      },
      {
        id: "completion:audit:78", event_type: "COMPLETED", title: "Completed",
        actor_name: "A Anil Kumar", timestamp: "2026-07-28T16:05:00Z",
      },
    ],
    missing_sources: [],
    ...overrides,
  };
}

function renderJourney(journey: IndentJourney) {
  vi.mocked(indentApi.journey).mockResolvedValue(journey);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/indents/42/journey"]}>
        <Routes>
          <Route path="/indents/:id/journey" element={<IndentJourneyPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("journey model", () => {
  it("reads the leg of a downstream workflow event off its own name", () => {
    expect(journeyEventStageType("ALLOCATION_APPROVAL_APPROVED")).toBe("allocation_approval");
    expect(journeyEventStageType("WAREHOUSE_APPROVAL_REJECTED")).toBe("warehouse_approval");
    expect(journeyEventStageType("DISPATCH_APPROVAL_RETURNED")).toBe("dispatch_approval");
    expect(journeyEventStageType("STOCK_ALLOCATED")).toBe("allocation");
    expect(journeyEventStageType("COMPLETED")).toBe("completion");
    expect(journeyEventStageType("SOMETHING_NEW")).toBe("activity");

    expect(journeyTrackKey("allocation_approval")).toBe("allocation");
    expect(journeyTrackKey("warehouse_approval")).toBe("warehouse");
    expect(journeyTrackKey("dispatch_approval")).toBe("delivery");
    expect(journeyTrackKey("completion")).toBe("acknowledgement");
    // An approval leg the contract grows later still lands with its own domain.
    expect(journeyTrackKey("material_request_approval")).toBe("allocation");
    expect(journeyTrackKey("something_new")).toBe("activity");

    expect(journeyEventStatus("ALLOCATION_APPROVAL_REJECTED")).toBe("REJECTED");
    expect(journeyEventStatus("STOCK_ALLOCATED")).toBe("COMPLETED");
  });

  it("projects every downstream approval that only exists as history", () => {
    const derived = derivedJourneyStages(fulfilledJourney());

    // The indent's own ladder already arrives as stages and must not repeat.
    expect(derived.some((stage) => stage.title === "SPH approved")).toBe(false);
    expect(derived.filter((stage) => stage.stage_type === "allocation_approval")).toHaveLength(3);
    expect(derived.map((stage) => stage.approver_name)).toEqual([
      "Store Keeper", "M Kiran", "R Latha", "P Naveen", "Store Keeper",
      "S Bhaskar", "S Bhaskar", "Gate Security", null, "A Anil Kumar", "A Anil Kumar",
    ]);
  });

  it("never counts a step a backend already served as a stage", () => {
    const journey = fulfilledJourney();
    const alreadyServed = fulfilledJourney({
      stages: [
        ...journey.stages,
        {
          sequence: 7, title: "Stock allocated", status: "COMPLETED", stage_type: "allocation",
          approver_name: "Store Keeper", reference_no: "ALLOC/2026/0005",
          timestamp: "2026-07-27T12:05:00Z",
        },
      ],
    });

    const titles = derivedJourneyStages(alreadyServed).map((stage) => stage.title);
    expect(titles.filter((title) => title === "Stock allocated")).toHaveLength(0);
    expect(journeySteps(alreadyServed).occurred
      .filter((stage) => stage.title === "Stock allocated")).toHaveLength(1);
  });

  it("groups the whole chain into its legs, in the order it travelled", () => {
    const tracks = buildJourneyTracks(fulfilledJourney());
    const byKey = Object.fromEntries(tracks.map((track) => [track.key, track]));

    expect(tracks.map((track) => track.key)).toEqual([
      "request", "approvals", "allocation", "warehouse", "delivery", "acknowledgement",
    ]);
    expect(byKey.approvals.occurred.map((stage) => stage.approver_name)).toEqual([
      "C Ramakrishna", "A Raveendra Prasad", "K Suresh", "SPH",
    ]);
    expect(byKey.allocation.occurred.map((stage) => stage.approver_name)).toEqual([
      "Store Keeper", "M Kiran", "R Latha", "P Naveen", "Store Keeper",
    ]);
    expect(tracks.every((track) => track.state === "COMPLETED")).toBe(true);
  });

  it("keeps a correction that a later resubmission wiped off its rung", () => {
    // The DM returned the indent, the requester corrected it, and the DM then
    // approved: the rung now reads APPROVED, so only the history still holds the
    // return — and that is the record of what was asked for and why.
    const corrected = fulfilledJourney({
      status: "PENDING_APPROVAL",
      stages: [
        {
          sequence: 1, title: "Draft created", status: "APPROVED", stage_type: "draft",
          approver_name: "A Anil Kumar", timestamp: "2026-07-27T09:00:00Z",
        },
        {
          sequence: 2, title: "Request submitted", status: "SUBMITTED", stage_type: "submission",
          approver_name: "A Anil Kumar", timestamp: "2026-07-27T09:05:00Z",
        },
        {
          sequence: 3, title: "DM Review", status: "APPROVED", stage_type: "approval",
          approver_name: "A Raveendra Prasad", timestamp: "2026-07-27T14:00:00Z",
        },
      ],
      phases: [],
      history: [
        {
          id: "workflow:1", event_type: "SUBMITTED", title: "Request submitted",
          actor_name: "A Anil Kumar", timestamp: "2026-07-27T09:05:00Z",
        },
        {
          id: "workflow:2", event_type: "RETURNED", title: "Request returned",
          actor_name: "A Raveendra Prasad", position_name: "District Manager",
          comments: "Quantity looks wrong, please revise", timestamp: "2026-07-27T10:00:00Z",
        },
        {
          id: "workflow:3", event_type: "SUBMITTED", title: "Request submitted",
          actor_name: "A Anil Kumar", timestamp: "2026-07-27T13:00:00Z",
        },
        {
          id: "workflow:4", event_type: "APPROVED", title: "DM approved",
          actor_name: "A Raveendra Prasad", timestamp: "2026-07-27T14:00:00Z",
        },
      ],
    });

    const derived = derivedJourneyStages(corrected);
    expect(derived.map((stage) => [stage.title, stage.status])).toEqual([
      ["Request returned", "RETURNED"],
      ["Resubmitted after correction", "SUBMITTED"],
    ]);
    // The reason travels with the correction, and both sit in the approval leg.
    expect(derived[0].comments).toBe("Quantity looks wrong, please revise");
    expect(derived.every((stage) => stage.stage_type === "approval")).toBe(true);
    // The first submission and the approval are already stages: never twice.
    expect(journeySteps(corrected).occurred.map((stage) => stage.title)).toEqual([
      "Draft created", "Request submitted", "Request returned",
      "Resubmitted after correction", "DM Review",
    ]);
  });

  it("carries the ladder past a return the resubmit reopened", () => {
    // What the endpoint really serves: a correction resubmit reopens the returned
    // rung instead of writing a second SUBMITTED action, so the only evidence it
    // happened is the RESUBMITTED event the audit trail produces.
    const resubmitted = fulfilledJourney({
      status: "PENDING_APPROVAL",
      stages: [
        {
          sequence: 1, title: "Draft created", status: "APPROVED", stage_type: "draft",
          approver_name: "A Anil Kumar", timestamp: "2026-07-27T09:00:00Z",
        },
        {
          sequence: 2, title: "Request submitted", status: "SUBMITTED", stage_type: "submission",
          approver_name: "A Anil Kumar", timestamp: "2026-07-27T09:05:00Z",
        },
        {
          sequence: 3, title: "Final Approval - OE", status: "PENDING", stage_type: "final",
          approver_name: "Srinivasu Madicherla", is_current: true,
        },
      ],
      phases: [
        { sequence: 1, title: "Draft", status: "APPROVED", stage_type: "phase" },
        { sequence: 2, title: "Submitted", status: "APPROVED", stage_type: "phase" },
        { sequence: 3, title: "Approvals", status: "PENDING", stage_type: "phase", is_current: true },
      ],
      history: [
        {
          id: "workflow:2", event_type: "RETURNED", title: "Request returned",
          actor_name: "Srinivasu Madicherla", position_name: "OE-104-RAJAMAHENDRAVARAM-2",
          comments: "testing", timestamp: "2026-07-27T10:00:00Z",
        },
        {
          id: "resubmitted:9", event_type: "RESUBMITTED", title: "Resubmitted after correction",
          actor_name: "A Anil Kumar", position_name: "STORE KEEPER LIP Chagallu-2",
          timestamp: "2026-07-27T11:00:00Z",
        },
      ],
    });

    expect(journeyEventStageType("RESUBMITTED")).toBe("approval");
    expect(journeyEventStatus("RESUBMITTED")).toBe("SUBMITTED");
    expect(journeySteps(resubmitted).occurred.map((stage) => stage.title)).toEqual([
      "Draft created", "Request submitted", "Request returned",
      "Resubmitted after correction",
    ]);
    // The leg moved on: an answered return is history, not the state of the leg.
    const approvals = buildJourneyTracks(resubmitted).find((track) => track.key === "approvals");
    expect(approvals?.state).toBe("CURRENT");
    expect(approvals?.summary).toBe("Waiting at Final Approval - OE · Srinivasu Madicherla");
  });

  it("names the leg that holds the request now, and the ones not reached yet", () => {
    const inAllocation = fulfilledJourney({
      status: "AWAITING_ALLOCATION",
      current_stage_message: "Waiting for allocation",
      phases: [
        { sequence: 1, title: "Draft", status: "APPROVED", stage_type: "phase" },
        { sequence: 2, title: "Submitted", status: "APPROVED", stage_type: "phase" },
        { sequence: 3, title: "Approvals", status: "APPROVED", stage_type: "phase" },
        { sequence: 4, title: "Allocation", status: "PENDING", stage_type: "phase", is_current: true },
        { sequence: 5, title: "Warehouse", status: "PENDING", stage_type: "phase" },
        { sequence: 6, title: "Delivery", status: "PENDING", stage_type: "phase" },
        { sequence: 7, title: "Acknowledgement", status: "PENDING", stage_type: "phase" },
      ],
      history: fulfilledJourney().history.slice(0, 3),
    });

    const byKey = Object.fromEntries(
      buildJourneyTracks(inAllocation).map((track) => [track.key, track]),
    );
    expect(byKey.approvals.state).toBe("COMPLETED");
    expect(byKey.allocation.state).toBe("CURRENT");
    expect(byKey.warehouse.state).toBe("PENDING");
    expect(byKey.warehouse.summary).toBe("Not started yet");
    expect(byKey.delivery.occurred).toEqual([]);
  });

  it("reports a rejected leg by the approver who rejected it", () => {
    const rejected = fulfilledJourney({
      status: "REJECTED",
      stages: [{
        sequence: 3, title: "DM Review", status: "REJECTED", stage_type: "approval",
        approver_name: "A Raveendra Prasad", timestamp: "2026-07-27T09:45:00Z",
      }],
      phases: [],
      history: [],
    });

    const approvals = buildJourneyTracks(rejected).find((track) => track.key === "approvals");
    expect(approvals?.state).toBe("REJECTED");
    expect(approvals?.summary).toBe("Rejected by A Raveendra Prasad");
  });
});

describe("complete indent journey screen", () => {
  it("shows every leg of the chain, not only the indent approvals", async () => {
    renderJourney(fulfilledJourney());

    const timeline = await screen.findByRole("list", { name: "Complete indent journey timeline" });
    expect(within(timeline).getByText("Inventory allocation")).toBeInTheDocument();
    expect(within(timeline).getByText("Warehouse")).toBeInTheDocument();
    expect(within(timeline).getByText("Dispatch and delivery")).toBeInTheDocument();
    expect(within(timeline).getByText("Receipt and closure")).toBeInTheDocument();

    // The allocation ladder is as dynamic as the indent's own: two assistant
    // managers and an inventory manager here, because that is what was recorded.
    expect(within(timeline).getAllByRole("heading", { name: "Assistant Manager approved" })).toHaveLength(2);
    expect(within(timeline).getByRole("heading", { name: "Inventory Manager approved" })).toBeInTheDocument();
    expect(within(timeline).getByText("M Kiran · Assistant Manager - Inventory")).toBeInTheDocument();
    expect(within(timeline).getByText("P Naveen · Inventory Manager")).toBeInTheDocument();
    expect(within(timeline).getByRole("heading", { name: "Issued from warehouse" })).toBeInTheDocument();
    expect(within(timeline).getByRole("heading", { name: "Dispatched" })).toBeInTheDocument();
    expect(within(timeline).getByRole("heading", { name: "Completed" })).toBeInTheDocument();
  });

  it("keeps a correction and its reason in the timeline after resubmission", async () => {
    renderJourney(fulfilledJourney({
      status: "PENDING_APPROVAL",
      current_stage_message: "Waiting for DM review",
      stages: [
        {
          sequence: 1, title: "Draft created", status: "APPROVED", stage_type: "draft",
          approver_name: "A Anil Kumar", timestamp: "2026-07-27T09:00:00Z",
        },
        {
          sequence: 2, title: "Request submitted", status: "SUBMITTED", stage_type: "submission",
          approver_name: "A Anil Kumar", timestamp: "2026-07-27T09:05:00Z",
        },
        {
          sequence: 3, title: "DM Review", status: "PENDING", stage_type: "approval",
          approver_name: "A Raveendra Prasad", is_current: true,
        },
      ],
      phases: [],
      history: [
        {
          id: "workflow:2", event_type: "RETURNED", title: "Request returned",
          actor_name: "A Raveendra Prasad", position_name: "District Manager",
          comments: "Quantity looks wrong, please revise", timestamp: "2026-07-27T10:00:00Z",
        },
        {
          id: "workflow:3", event_type: "SUBMITTED", title: "Request submitted",
          actor_name: "A Anil Kumar", timestamp: "2026-07-27T13:00:00Z",
        },
      ],
    }));

    const timeline = await screen.findByRole("list", { name: "Complete indent journey timeline" });
    const returned = within(timeline).getByRole("heading", { name: "Request returned" })
      .closest("article");
    expect(within(returned!).getByText("Correction requested")).toBeInTheDocument();
    expect(within(returned!).getByText("Quantity looks wrong, please revise")).toBeInTheDocument();
    expect(within(returned!).getByText("A Raveendra Prasad · District Manager")).toBeInTheDocument();
    expect(within(timeline).getByRole("heading", { name: "Resubmitted after correction" })).toBeInTheDocument();
    // The rung itself still holds the request; the correction is history, not a wait.
    expect(within(screen.getByRole("list", { name: "Remaining indent journey stages" }))
      .getByRole("heading", { name: "DM Review" })).toBeInTheDocument();
  });
});
