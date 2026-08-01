import type {
  ApprovalDecisionRow, ApprovalReportRow, PendingApproval,
} from "./types";

const HOUR = 3_600_000;

export interface ReportFilters {
  window?: [number, number] | null;
  docType?: string;
  status?: string;
  requester?: string;
  stage?: string;
  approver?: string;
  overdueOnly?: boolean;
}

export function buildReportRows(
  pending: PendingApproval[],
  decisions: ApprovalDecisionRow[],
  now = Date.now(),
): ApprovalReportRow[] {
  const waiting = pending.map((row): ApprovalReportRow => {
    const started = row.waiting_since ? new Date(row.waiting_since).getTime() : NaN;
    const due = row.due_at ? new Date(row.due_at).getTime() : NaN;
    return {
      key: `pending-${row.instance_id}-${row.stage_sequence}`,
      doc_type: row.doc_type,
      doc_id: row.doc_id,
      doc_no: row.doc_no,
      requester: row.requested_by_name,
      approver_name: row.approver_name,
      stage: row.current_stage_name ?? `Stage ${row.stage_sequence}`,
      status: "PENDING",
      report_at: row.waiting_since,
      raised_at: row.waiting_since,
      duration_hours: Number.isNaN(started) ? null : Math.max(0, (now - started) / HOUR),
      overdue: !Number.isNaN(due) && due < now,
      within_sla: Number.isNaN(due) ? null : due >= now,
    };
  });
  const completed = decisions.map((row): ApprovalReportRow => ({
    key: `decision-${row.id}`,
    doc_type: row.doc_type,
    doc_id: row.doc_id,
    doc_no: row.doc_no,
    requester: row.requester,
    approver_name: row.approver_name,
    stage: row.stage_name ?? `Stage ${row.stage_sequence}`,
    status: row.decision,
    report_at: row.decision_at,
    raised_at: row.started_at,
    duration_hours: row.duration_hours,
    overdue: row.within_sla === false,
    within_sla: row.within_sla,
    comments: row.comments,
  }));
  return [...waiting, ...completed];
}

export function filterReportRows(
  rows: ApprovalReportRow[],
  filters: ReportFilters,
): ApprovalReportRow[] {
  const requester = filters.requester?.trim().toLowerCase() ?? "";
  return rows.filter((row) => {
    if (filters.docType && row.doc_type !== filters.docType) return false;
    if (filters.status && row.status !== filters.status) return false;
    if (filters.stage && row.stage !== filters.stage) return false;
    if (filters.approver && row.approver_name !== filters.approver) return false;
    if (filters.overdueOnly && !row.overdue) return false;
    if (requester && !String(row.requester ?? "").toLowerCase().includes(requester)) return false;
    if (filters.window) {
      const at = row.report_at ? new Date(row.report_at).getTime() : NaN;
      if (Number.isNaN(at) || at < filters.window[0] || at >= filters.window[1]) return false;
    }
    return true;
  });
}

export function reportKpis(rows: ApprovalReportRow[]) {
  const decisions = rows.filter((row) => row.status !== "PENDING");
  const approved = decisions.filter((row) => row.status === "APPROVED").length;
  const rejected = decisions.filter((row) => row.status === "REJECTED").length;
  const returned = decisions.filter((row) => row.status === "RETURNED").length;
  const pending = rows.filter((row) => row.status === "PENDING").length;
  const overdue = rows.filter((row) => row.overdue).length;
  const durations = decisions
    .map((row) => row.duration_hours)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const slaRows = decisions.filter((row) => row.within_sla != null);
  return {
    total: new Set(rows.map((row) => `${row.doc_type}:${row.doc_id}`)).size,
    approved, rejected, returned, pending, overdue,
    averageHours: durations.length
      ? Math.round((durations.reduce((sum, value) => sum + value, 0) / durations.length) * 10) / 10
      : 0,
    approvalRate: decisions.length ? Math.round((approved / decisions.length) * 100) : 0,
    slaRate: slaRows.length
      ? Math.round((slaRows.filter((row) => row.within_sla).length / slaRows.length) * 100)
      : null,
  };
}

export function countBy(
  rows: ApprovalReportRow[],
  valueOf: (row: ApprovalReportRow) => string,
) {
  const counts = new Map<string, number>();
  rows.forEach((row) => {
    const name = valueOf(row) || "Not specified";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  });
  return [...counts.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

export function decisionTrend(rows: ApprovalReportRow[]) {
  const decisions = rows.filter((row) => row.status !== "PENDING" && row.report_at);
  const grouped = new Map<string, { name: string; approved: number; rejected: number; returned: number }>();
  decisions.forEach((row) => {
    const date = new Date(row.report_at!);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const result = grouped.get(key) ?? { name: key, approved: 0, rejected: 0, returned: 0 };
    if (row.status === "APPROVED") result.approved += 1;
    if (row.status === "REJECTED") result.rejected += 1;
    if (row.status === "RETURNED") result.returned += 1;
    grouped.set(key, result);
  });
  return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(-31);
}

export function ageingBuckets(rows: ApprovalReportRow[]) {
  const buckets = [
    { name: "0–1 day", value: 0 },
    { name: "2–3 days", value: 0 },
    { name: "4–7 days", value: 0 },
    { name: "7+ days", value: 0 },
  ];
  rows.filter((row) => row.status === "PENDING").forEach((row) => {
    const days = (row.duration_hours ?? 0) / 24;
    buckets[days <= 1 ? 0 : days <= 3 ? 1 : days <= 7 ? 2 : 3].value += 1;
  });
  return buckets;
}

export function stagePerformance(rows: ApprovalReportRow[]) {
  const stages = new Map<string, number[]>();
  rows.forEach((row) => {
    if (row.duration_hours == null) return;
    const values = stages.get(row.stage) ?? [];
    values.push(row.duration_hours);
    stages.set(row.stage, values);
  });
  return [...stages.entries()].map(([name, values]) => ({
    name,
    count: values.length,
    averageHours: Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10,
  })).sort((a, b) => b.averageHours - a.averageHours);
}
