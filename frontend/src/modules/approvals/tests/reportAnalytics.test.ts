import { describe, expect, it } from "vitest";
import { buildReportRows, filterReportRows, reportKpis } from "../reportAnalytics";

describe("approval report analytics", () => {
  const now = new Date("2026-08-01T12:00:00Z").getTime();
  const rows = buildReportRows([
    {
      instance_id: 1, doc_type: "INDENT", doc_id: 10, stage_sequence: 1,
      waiting_since: "2026-07-29T12:00:00Z", due_at: "2026-07-31T12:00:00Z",
      requested_by_name: "Ravi", current_stage_name: "Manager",
    },
  ], [
    {
      id: 2, doc_type: "MR", doc_id: 20, stage_sequence: 1, decision: "APPROVED",
      decision_at: "2026-08-01T10:00:00Z", duration_hours: 5, within_sla: true,
      requester: "Meena", workflow_status: "COMPLETED",
    },
  ], now);

  it("combines pending and completed approval work", () => {
    expect(reportKpis(rows)).toMatchObject({
      total: 2, pending: 1, overdue: 1, approved: 1, approvalRate: 100, slaRate: 100,
    });
  });

  it("filters by document type, requester and overdue state", () => {
    expect(filterReportRows(rows, {
      docType: "INDENT", requester: "rav", overdueOnly: true,
    }).map((row) => row.doc_id)).toEqual([10]);
  });
});
