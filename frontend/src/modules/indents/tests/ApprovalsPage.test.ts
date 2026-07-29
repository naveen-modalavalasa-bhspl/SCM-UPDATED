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
    doc_type: "PO",
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

  it("returns every assigned document type when search is blank", () => {
    expect(filterPendingApprovals(approvals, "  ")).toEqual(approvals);
  });

  it("filters the unified inbox by document type without hiding other workflow tasks", () => {
    expect(filterPendingApprovals(approvals, "purchase")).toEqual([approvals[2]]);
    expect(filterPendingApprovals(approvals, "", "INDENT")).toEqual([approvals[0], approvals[1]]);
  });
});
