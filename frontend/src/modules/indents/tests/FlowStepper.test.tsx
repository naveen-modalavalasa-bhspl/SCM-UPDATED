import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FlowStepper } from "../components/FlowStepper";
import type { IndentJourney, IndentJourneyStage } from "../types";

const PHASE_TITLES = [
  "Draft", "Submitted", "Approvals", "Allocation", "Warehouse", "In-Transit",
  "Acknowledgement",
];

function phase(
  sequence: number,
  title: string,
  status = "PENDING",
  is_current = false,
  approver_name?: string,
): IndentJourneyStage {
  return { sequence, title, status, is_current, approver_name, stage_type: "phase" };
}

function phases(overrides: Partial<Record<number, IndentJourneyStage>> = {}) {
  const rows = [
    phase(1, "Draft", "APPROVED"),
    phase(2, "Submitted", "APPROVED"),
    phase(3, "Approvals", "PENDING", true, "Area Coordinator Review"),
    phase(4, "Allocation"),
    phase(5, "Warehouse"),
    phase(6, "Delivery"),
    phase(7, "Acknowledgement"),
  ];
  return rows.map((row) => overrides[row.sequence] ?? row);
}

function journey(summary: IndentJourneyStage[] = phases()): IndentJourney {
  return {
    indent_id: 42,
    indent_no: "IND/42",
    status: "PENDING_APPROVAL",
    requested_by_name: "Requester",
    created_at: "2026-07-27T09:30:00Z",
    current_stage_message: "Waiting for Area Coordinator review",
    stages: [],
    phases: summary,
    history: [],
    missing_sources: [],
  };
}

describe("FlowStepper", () => {
  it("shows a progress skeleton instead of unavailable status during initial loading", () => {
    render(<FlowStepper status="PENDING_APPROVAL" isLoading />);

    expect(screen.getByRole("status", { name: "Loading approval progress" })).toBeInTheDocument();
    expect(screen.queryByText("Status unavailable")).not.toBeInTheDocument();
  });

  it("keeps the cached seven-phase summary visible while refetching", () => {
    render(<FlowStepper status="PENDING_APPROVAL" journey={journey()} isLoading />);

    expect(screen.getByText("Approvals")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading approval progress" })).not.toBeInTheDocument();
  });

  it("aggregates any resolved approval-chain length into Approvals", () => {
    render(<FlowStepper status="PENDING_APPROVAL" journey={journey()} />);

    expect(screen.getByLabelText("Approvals, current: Area Coordinator Review")).toHaveClass("bg-step-live");
    expect(screen.queryByText("OE Review")).not.toBeInTheDocument();
    expect(screen.queryByText("DM Review")).not.toBeInTheDocument();
    expect(screen.queryByText("Final Approval")).not.toBeInTheDocument();
    expect(screen.getByText("Current stage")).toBeInTheDocument();
    expect(screen.getByText("Stage 3 of 7 · Approvals")).toBeInTheDocument();
    expect(screen.getByText("Waiting for Area Coordinator review")).toBeInTheDocument();
  });

  it("renders the real pending-approval response shape for IND/2026-27/00141", () => {
    const runtime = journey([
      phase(1, "Draft", "APPROVED"),
      phase(2, "Submitted", "APPROVED"),
      phase(3, "Approvals", "PENDING", true, "OE Review"),
      phase(4, "Allocation"),
      phase(5, "Warehouse"),
      phase(6, "Delivery"),
      phase(7, "Acknowledgement"),
    ]);
    runtime.indent_id = 141;
    runtime.indent_no = "IND/2026-27/00141";
    runtime.current_stage_message = "Waiting for OE review";
    runtime.stages = [{
      sequence: 3,
      title: "OE Review",
      status: "PENDING",
      is_current: true,
      approver_name: "C RAMAKRISHNA",
      stage_type: "approval",
    }];

    render(<FlowStepper status="PENDING_APPROVAL" journey={runtime} />);

    expect(screen.getByLabelText("Draft, completed")).toHaveClass("bg-step-done");
    expect(screen.getByLabelText("Submitted, completed")).toHaveClass("bg-step-done");
    expect(screen.getByLabelText("Approvals, current: OE Review")).toHaveClass("bg-step-live");
    expect(screen.getByText("Stage 3 of 7 · Approvals")).toBeInTheDocument();
    expect(screen.getByText("Waiting for OE review")).toBeInTheDocument();
    expect(screen.queryByText("Status unavailable")).not.toBeInTheDocument();
  });

  it("normalizes phase order and ignores user-facing title wording", () => {
    const differentlyNamed = [
      phase(7, "Goods received"),
      phase(4, "stock allocation"),
      phase(2, "REQUEST SENT", "APPROVED"),
      phase(6, "In delivery"),
      phase(1, "draft created", "APPROVED"),
      phase(5, "Store issue"),
      phase(3, "approval workflow", "PENDING", true, "Custom Controller Review"),
    ];

    render(<FlowStepper status="PENDING_APPROVAL" journey={journey(differentlyNamed)} />);

    expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      "DraftCompleted",
      "SubmittedCompleted",
      "ApprovalsCustom Controller Review",
      "4AllocationPending",
      "5WarehousePending",
      "6In-TransitPending",
      "7AcknowledgementPending",
    ]);
    expect(screen.getByLabelText("Approvals, current: Custom Controller Review")).toBeInTheDocument();
  });

  it("accepts seven phases when optional detail fields are absent", () => {
    const minimal = PHASE_TITLES.map((title, index) => ({
      sequence: index + 1,
      title,
      status: index < 2 ? "APPROVED" : "PENDING",
      is_current: index === 2,
      stage_type: "phase",
    })) as IndentJourneyStage[];
    const response = journey(minimal);
    response.current_stage_message = "";

    render(<FlowStepper status="PENDING_APPROVAL" journey={response} />);

    expect(screen.getAllByRole("listitem")).toHaveLength(7);
    expect(screen.getByText("Request submitted — waiting for approval")).toBeInTheDocument();
    expect(screen.queryByText("Status unavailable")).not.toBeInTheDocument();
  });

  it("renders a genuine draft as current without unavailable or downstream progress", () => {
    const draft = journey(phases({
      1: phase(1, "Draft", "PENDING", true),
      2: phase(2, "Submitted"),
      3: phase(3, "Approvals"),
    }));
    draft.status = "DRAFT";
    draft.current_stage_message = "Draft — submit the indent to begin approval";

    render(<FlowStepper status="DRAFT" journey={draft} />);

    expect(screen.getByLabelText("Draft, current")).toHaveClass("bg-step-live");
    expect(screen.getByLabelText("Submitted, pending")).toHaveClass("border-line");
    expect(screen.getByText("Stage 1 of 7 · Draft")).toBeInTheDocument();
    expect(screen.queryByText("Status unavailable")).not.toBeInTheDocument();
  });

  it("marks only genuine downstream evidence complete", () => {
    render(<FlowStepper status="PARTIALLY_FULFILLED" journey={journey(phases({
      3: phase(3, "Approvals", "APPROVED"),
      4: phase(4, "Allocation", "APPROVED"),
      5: phase(5, "Warehouse", "APPROVED"),
      6: phase(6, "Delivery", "PENDING", true),
    }))} />);

    expect(screen.getByLabelText("Allocation, completed")).toHaveClass("bg-step-done");
    expect(screen.getByLabelText("Warehouse, completed")).toHaveClass("bg-step-done");
    expect(screen.getByLabelText("In-Transit, current")).toHaveClass("bg-step-live");
    expect(screen.getByLabelText("Acknowledgement, pending")).toHaveClass("border-line");
  });

  it("shows a return for correction as recoverable, never as a rejection", () => {
    const returned = journey(phases({ 3: phase(3, "Approvals", "RETURNED") }));
    returned.status = "RETURNED";
    returned.current_stage_message = "";

    render(<FlowStepper status="RETURNED" journey={returned} />);

    const step = screen.getByLabelText("Approvals, returned");
    expect(step).toHaveClass("bg-step-hold");
    expect(step).not.toHaveClass("bg-step-bad");
    expect(screen.getByLabelText("Allocation, pending")).toHaveClass("border-line");
    expect(screen.getByText("Stage 3 of 7 · Approvals")).toBeInTheDocument();
    expect(screen.getByText("Returned for correction — update the indent and resubmit")).toBeInTheDocument();
  });

  it("keeps a cancelled request off the rejection colour and stops downstream progress", () => {
    const cancelled = journey([]);
    cancelled.status = "CANCELLED";
    cancelled.current_stage_message = "";

    render(<FlowStepper status="CANCELLED" journey={cancelled} />);

    expect(screen.getByLabelText("Approvals, cancelled")).toHaveClass("bg-step-off");
    expect(screen.getByLabelText("Allocation, pending")).toBeInTheDocument();
    expect(screen.getByText("Request cancelled")).toBeInTheDocument();
  });

  it.each([
    ["PENDING_PROCUREMENT", "Not in stock — with procurement"],
    ["PARTIALLY_ORDERED", "Partly ordered — with procurement"],
    ["ORDERED", "Ordered — waiting for goods receipt"],
  ])("keeps %s with procurement instead of claiming warehouse progress", (status, message) => {
    const procurement = journey([]);
    procurement.status = status;
    procurement.current_stage_message = "";

    render(<FlowStepper status={status} journey={procurement} />);

    expect(screen.getByLabelText("Allocation, current")).toHaveClass("bg-step-live");
    expect(screen.getByLabelText("Warehouse, pending")).toHaveClass("border-line");
    expect(screen.getByText("Stage 4 of 7 · Allocation")).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it("still numbers the stage once every phase has completed", () => {
    const closed = journey([]);
    closed.status = "CLOSED";
    closed.current_stage_message = "";

    render(<FlowStepper status="CLOSED" journey={closed} />);

    expect(screen.getByText("Stage 7 of 7 · Acknowledgement")).toBeInTheDocument();
    // Seven phase captions plus the current-stage message.
    expect(screen.getAllByText("Completed")).toHaveLength(8);
  });

  it("counts the live rung of a ladder of any length, with no fixed ranks", () => {
    const ladder = journey();
    ladder.stages = [
      { sequence: 1, title: "Site Review", status: "APPROVED", stage_type: "approval" },
      { sequence: 2, title: "Cluster Review", status: "APPROVED", stage_type: "approval" },
      {
        sequence: 3,
        title: "Zonal Review",
        status: "PENDING",
        is_current: true,
        approver_name: "K Sundaram",
        stage_type: "approval",
      },
      { sequence: 4, title: "Custom Final Gate", status: "PENDING", stage_type: "final" },
    ];

    render(<FlowStepper status="PENDING_APPROVAL" journey={ladder} />);

    expect(screen.getByText("Approval 3 of 4 · K Sundaram")).toBeInTheDocument();
  });

  it("shows an actual approval rejection and keeps later phases pending", () => {
    render(<FlowStepper status="REJECTED" journey={journey(phases({
      3: phase(3, "Approvals", "REJECTED"),
    }))} />);

    expect(screen.getByLabelText("Approvals, rejected")).toHaveClass("bg-step-bad");
    expect(screen.getByLabelText("Allocation, pending")).toHaveClass("border-line");
  });

  it("uses a compact mobile column and seven equal desktop columns without overflow", () => {
    render(<FlowStepper status="PENDING_APPROVAL" journey={journey()} />);

    expect(screen.getByLabelText("Compact indent progress")).toHaveClass("overflow-hidden");
    expect(screen.getByTestId("compact-approval-progress")).toHaveClass(
      "grid-cols-1",
      "lg:grid-cols-7",
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
  });

  it("centers every stage label and detail on the same width contract", () => {
    render(<FlowStepper status="PENDING_APPROVAL" journey={journey()} />);

    for (const stage of screen.getAllByRole("listitem")) {
      const copy = stage.querySelector("div");
      expect(copy).toHaveClass("w-full", "max-w-28", "lg:mx-auto", "lg:text-center");
    }

    const approvalLabel = screen.getByText("Approvals");
    const approvalDetail = screen.getByText("Area Coordinator Review");
    expect(approvalLabel.parentElement).toBe(approvalDetail.parentElement);
    expect(approvalDetail).toHaveClass("max-w-full", "break-words");
  });

  it("uses a safe pending-approval fallback for a stale six-phase response", () => {
    const stale = journey([
      phase(1, "Request", "APPROVED"),
      phase(2, "Approvals", "PENDING", true, "OE Review"),
      phase(3, "Allocation"),
      phase(4, "Warehouse"),
      phase(5, "Delivery"),
      phase(6, "Acknowledgement"),
    ]);
    stale.current_stage_message = "Waiting for OE review";
    stale.stages = [{
      sequence: 2,
      title: "OE Review",
      status: "PENDING",
      is_current: true,
      stage_type: "approval",
    }];

    render(<FlowStepper status="PENDING_APPROVAL" journey={stale} />);

    expect(screen.getByLabelText("Draft, completed")).toHaveClass("bg-step-done");
    expect(screen.getByLabelText("Submitted, completed")).toHaveClass("bg-step-done");
    expect(screen.getByLabelText("Approvals, current: OE Review")).toHaveClass("bg-step-live");
    expect(screen.getByLabelText("Allocation, pending")).toHaveClass("border-line");
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
    expect(screen.queryByText("Status unavailable")).not.toBeInTheDocument();
  });

  it.each([
    ["DRAFT", "Draft, current"],
    ["REJECTED", "Approvals, rejected"],
    ["ALLOCATED", "Warehouse, current"],
  ])("uses a safe broad fallback for recognised %s responses", (status, currentLabel) => {
    const incomplete = journey([]);
    incomplete.status = status;
    incomplete.current_stage_message = "";

    render(<FlowStepper status={status} journey={incomplete} />);

    expect(screen.getByLabelText(currentLabel)).toBeInTheDocument();
    expect(screen.queryByText("Status unavailable")).not.toBeInTheDocument();
  });

  it("rejects genuinely malformed phase contracts safely", () => {
    const malformed = phases();
    malformed[1] = phase(1, "Submitted", "APPROVED");
    const response = journey(malformed);
    response.status = "SOMETHING_NEW";

    render(<FlowStepper status="SOMETHING_NEW" journey={response} />);

    expect(screen.getByText("Status unavailable")).toBeInTheDocument();
  });

  it("reports unavailable data when the backend summary is missing", () => {
    render(<FlowStepper status="SOMETHING_NEW" />);
    expect(screen.getByText("Status unavailable")).toBeInTheDocument();
  });
});
