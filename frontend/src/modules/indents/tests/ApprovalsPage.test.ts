import { describe, expect, it } from "vitest";
import type { PendingApproval } from "../types";
import { filterPendingApprovals } from "../pages/ApprovalsPage";

const approvals: PendingApproval[] = [
  {
    instance_id: 1,
    doc_type: "INDENT",
    doc_id: 42,
    stage_sequence: 1,
    doc_no: "IND-00042",
    summary: "Cotton rolls required",
    requested_by_name: "Asha Rao",
  },
  {
    instance_id: 2,
    doc_type: "INDENT",
    doc_id: 77,
    stage_sequence: 1,
    doc_no: "IND-00077",
    summary: "Lab reagents required",
    requested_by_name: "Dev Kumar",
  },
  {
    instance_id: 3,
    doc_type: "PURCHASE_ORDER",
    doc_id: 88,
    stage_sequence: 1,
    doc_no: "PO-00088",
    summary: "Purchase order approval",
    requested_by_name: "Nisha Rao",
  },
];

describe("filterPendingApprovals", () => {
  it("matches approval rows by indent number, summary, requester or id", () => {
    expect(filterPendingApprovals(approvals, "cotton")).toEqual([approvals[0]]);
    expect(filterPendingApprovals(approvals, "dev")).toEqual([approvals[1]]);
    expect(filterPendingApprovals(approvals, "77")).toEqual([approvals[1]]);
  });

  it("returns every approval when search is blank", () => {
    expect(filterPendingApprovals(approvals, "  ")).toEqual([approvals[0], approvals[1]]);
  });

  it("displays only INDENT workflow tasks", () => {
    expect(filterPendingApprovals(approvals, "purchase")).toEqual([]);
  });
});
