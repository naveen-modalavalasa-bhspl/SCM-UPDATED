import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  cancelIndentDecisionReads,
  commitConfirmedIndentDecision,
  isDecisionAffectedQuery,
  projectConfirmedIndentDecision,
} from "../approvalRefresh";
import { indentKeys } from "../api";
import type { Indent, IndentJourney } from "../types";

const scope = { employeeId: 7, activePositionId: 11 };

function indent(overrides: Partial<Indent> = {}): Indent {
  return {
    id: 42,
    indent_no: "IND/42",
    requested_by_id: 3,
    status: "PENDING_APPROVAL",
    priority: "NORMAL",
    total_items: 1,
    total_qty: 2,
    is_bookmarked: "NO",
    can_submit: false,
    can_approve: false,
    can_reject: false,
    created_at: "2026-08-02T09:00:00Z",
    items: [],
    ...overrides,
  };
}

function journey(): IndentJourney {
  return {
    indent_id: 42,
    indent_no: "IND/42",
    status: "PENDING_APPROVAL",
    created_at: "2026-08-02T09:00:00Z",
    current_stage: "Custom Budget Review",
    current_stage_message: "Waiting for Custom Budget Review",
    phases: [
      { sequence: 1, title: "Draft", status: "APPROVED", stage_type: "phase" },
      { sequence: 2, title: "Submitted", status: "APPROVED", stage_type: "phase" },
      { sequence: 3, title: "Approvals", status: "PENDING", stage_type: "phase", is_current: true },
      { sequence: 4, title: "Allocation", status: "PENDING", stage_type: "phase" },
      { sequence: 5, title: "Warehouse", status: "PENDING", stage_type: "phase" },
      { sequence: 6, title: "Delivery", status: "PENDING", stage_type: "phase" },
      { sequence: 7, title: "Acknowledgement", status: "PENDING", stage_type: "phase" },
    ],
    stages: [
      { sequence: 1, title: "Request submitted", status: "SUBMITTED", stage_type: "submission", timestamp: "2026-08-02T09:05:00Z" },
      { sequence: 2, title: "Custom Budget Review", status: "PENDING", stage_type: "approval", is_current: true, approver_name: "Budget Holder" },
    ],
    history: [],
    missing_sources: [],
  };
}

describe("confirmed Indent approval/rejection cache projection", () => {
  it("records the confirmed decision without inventing the next frozen-chain stage", () => {
    const result = projectConfirmedIndentDecision(
      journey(), indent({ current_approver_name: "Assurance Holder" }), "approve",
    )!;

    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]).toMatchObject({ title: "Request submitted", status: "SUBMITTED" });
    expect(result.current_stage_message).toBe("Approval completed");
    expect(result.phases[2]).toMatchObject({ title: "Approvals", status: "PENDING", is_current: true });
  });

  it("moves phases after final approval without inventing an allocation card", () => {
    const result = projectConfirmedIndentDecision(
      journey(), indent({ status: "AWAITING_ALLOCATION" }), "approve",
    )!;

    expect(result.stages).toHaveLength(1);
    expect(result.stages.some((stage) => stage.title === "Ready for allocation")).toBe(false);
    expect(result.phases[2]).toMatchObject({ status: "APPROVED", is_current: false });
    expect(result.phases[3]).toMatchObject({ status: "PENDING", is_current: true });
  });

  it("marks rejection without manufacturing a rejection action snapshot", () => {
    const result = projectConfirmedIndentDecision(
      journey(), indent({ status: "REJECTED" }), "reject", "Budget code is invalid",
    )!;

    expect(result.status).toBe("REJECTED");
    expect(result.current_stage_message).toBe("Request rejected");
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0].title).toBe("Request submitted");
    expect(result.phases[2]).toMatchObject({ status: "REJECTED", is_current: false });
    expect(result.phases.slice(3).map((phase) => phase.status)).toEqual([
      "PENDING", "PENDING", "PENDING", "PENDING",
    ]);
    expect(result.history).toEqual([]);
  });

  it("invalidates and refetches affected scoped query families once", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
    client.setQueryData(indentKeys.journey(scope, 42), journey());

    await commitConfirmedIndentDecision(
      client, scope, 42, indent({ status: "REJECTED" }), "reject", "Invalid request",
    );

    expect(client.getQueryData<Indent>(indentKeys.detail(scope, 42))?.status).toBe("REJECTED");
    expect(client.getQueryData<IndentJourney>(indentKeys.journey(scope, 42))?.status).toBe("REJECTED");
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate.mock.calls[0][0]?.refetchType).toBe("all");

    for (const key of ["detail", "journey", "list", "recent", "stats", "activity", "notifications"]) {
      expect(isDecisionAffectedQuery({ queryKey: ["indents-module", 7, 11, key] } as never, scope)).toBe(true);
    }
    expect(isDecisionAffectedQuery({ queryKey: ["indents-module", 99, 11, "detail"] } as never, scope)).toBe(false);
  });

  it("cancels and ignores a stale detail response started before the mutation", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let resolveStale!: (value: Indent) => void;
    const stale = new Promise<Indent>((resolve) => { resolveStale = resolve; });
    const request = client.fetchQuery({ queryKey: indentKeys.detail(scope, 42), queryFn: () => stale });

    await cancelIndentDecisionReads(client, scope, 42);
    client.setQueryData(indentKeys.detail(scope, 42), indent({ status: "REJECTED" }));
    resolveStale(indent({ status: "PENDING_APPROVAL" }));
    await expect(request).rejects.toBeDefined();

    expect(client.getQueryData<Indent>(indentKeys.detail(scope, 42))?.status).toBe("REJECTED");
  });
});
