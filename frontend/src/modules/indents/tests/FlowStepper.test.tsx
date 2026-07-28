import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FlowStepper } from "../components/FlowStepper";
import type { IndentJourney, IndentJourneyStage } from "../types";

function stage(overrides: Partial<IndentJourneyStage>): IndentJourneyStage {
  return {
    sequence: 1,
    title: "Stage",
    status: "PENDING",
    stage_type: "approval",
    ...overrides,
  };
}

function journey(stages: IndentJourneyStage[], status = "PENDING_APPROVAL"): IndentJourney {
  return {
    indent_id: 42,
    indent_no: "IND/42",
    status,
    requested_by_name: "Requester",
    created_at: "2026-07-27T09:30:00Z",
    current_stage_message: "In approval",
    stages,
    history: [],
  };
}

const submitted = stage({
  sequence: 1,
  title: "Request Submitted",
  status: "SUBMITTED",
  stage_type: "request",
  approver_name: "Requester",
});

describe("FlowStepper", () => {
  it("uses requester information for draft indents when journey is available", () => {
    render(<FlowStepper status="DRAFT" journey={journey([
      stage({
        sequence: 1,
        title: "Draft Request",
        status: "PENDING",
        stage_type: "request",
        approver_name: "V Suresh Kumar",
        is_current: true,
      }),
    ], "DRAFT")} />);

    expect(screen.getByLabelText("Draft: V Suresh Kumar")).toHaveClass("bg-brand");
    expect(screen.queryByText("Submitted")).not.toBeInTheDocument();
  });

  it("builds compact progress directly from journey stages", () => {
    render(<FlowStepper status="PENDING_APPROVAL" journey={journey([
      submitted,
      stage({ sequence: 2, title: "Reporting Manager Review", status: "APPROVED" }),
      stage({ sequence: 3, title: "Finance Review", status: "PENDING", is_current: true }),
      stage({ sequence: 4, title: "Final Approval - CEO", status: "PENDING", stage_type: "final" }),
    ])} />);

    expect(screen.getByLabelText("Draft: Requester")).toHaveClass("bg-ok");
    expect(screen.getByLabelText("Submitted: Requester")).toHaveClass("bg-ok");
    expect(screen.getByLabelText("Reporting Manager Review: Completed")).toHaveClass("bg-ok");
    expect(screen.getByLabelText("Finance Review: Current")).toHaveClass("bg-brand");
    expect(screen.getByLabelText("Final Approval - CEO: Pending")).toHaveClass("border-line");
    expect(screen.queryByText("OE Review")).not.toBeInTheDocument();
    expect(screen.queryByText("DM Review")).not.toBeInTheDocument();
    expect(screen.queryByText("RM Review")).not.toBeInTheDocument();
  });

  it("includes Ready for Allocation only when journey says it applies", () => {
    render(<FlowStepper status="AWAITING_ALLOCATION" journey={journey([
      submitted,
      stage({ sequence: 2, title: "Approval", status: "APPROVED" }),
      stage({ sequence: 3, title: "Ready for Allocation", status: "PENDING", stage_type: "allocation", is_current: true }),
    ], "AWAITING_ALLOCATION")} />);

    expect(screen.getByLabelText("Ready for Allocation: Current")).toHaveClass("bg-brand");
  });

  it("marks rejected or returned stages and leaves following actual stages pending", () => {
    render(<FlowStepper status="REJECTED" journey={journey([
      submitted,
      stage({ sequence: 2, title: "District Review", status: "REJECTED" }),
      stage({ sequence: 3, title: "Final Approval", status: "PENDING", stage_type: "final" }),
    ], "REJECTED")} />);

    expect(screen.getByLabelText("District Review: Rejected")).toHaveClass("bg-bad");
    expect(screen.getByLabelText("Final Approval: Pending")).toHaveClass("border-line");
  });

  it("does not silently fall back for unknown statuses", () => {
    render(<FlowStepper status="SOMETHING_NEW" />);
    expect(screen.getByText("Status unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Draft")).not.toBeInTheDocument();
  });

  it("uses a horizontally scrollable compact layout without fixed grid columns", () => {
    render(<FlowStepper status="PENDING_APPROVAL" journey={journey([
      submitted,
      stage({ sequence: 2, title: "Approval", status: "PENDING", is_current: true }),
    ])} />);

    expect(screen.getByLabelText("Compact approval progress")).toHaveClass("overflow-x-auto");
    expect(screen.getByTestId("compact-approval-progress")).toHaveClass("grid-flow-col");
    expect(screen.getByTestId("compact-approval-progress")).not.toHaveClass("grid-cols-6");
  });
});
