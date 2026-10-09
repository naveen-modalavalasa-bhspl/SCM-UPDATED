import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import * as XLSX from "xlsx";
import {
  CheckCircle2, Clock, Download, FileCheck2, RotateCcw,
  ShieldCheck, TriangleAlert, X, XCircle,
} from "lucide-react";
import {
  Button, Card, PageHeader, ResponsiveList, StatCard, StatusPill, type Column,
  Select, SearchField,
} from "@/shared/components";
import { approvalsApi } from "../api";
import { docTypeLabel, rowDocTypeLabel } from "../docTypes";
import { raisedWindow, type RaisedRange } from "../filters";
import {
  ageingBuckets, buildReportRows, decisionTrend, filterReportRows, reportKpis,
} from "../reportAnalytics";
import type { ApprovalReportRow } from "../types";
import { ApprovalPager } from "../components/Pager";
import { TONE_BLUE } from "@/shared/components/tones";

const COLORS = ["#4169e1", "#16a34a", "#dc2626", "#d97706", "#7c3aed", "#0891b2"];
const typeLabel = docTypeLabel;
const RANGE_OPTIONS: Array<{ value: RaisedRange; label: string }> = [
  { value: "", label: "All time" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "custom", label: "Custom" },
];

function hours(value?: number | null) {
  if (value == null) return "—";
  if (value < 24) return `${Math.round(value * 10) / 10}h`;
  return `${Math.round((value / 24) * 10) / 10}d`;
}

function ChartCard({ title, subtitle, children }: {
  title: string; subtitle: string; children: React.ReactNode;
}) {
  return <Card className="p-4">
    <h2 className="font-display text-base font-bold text-ink">{title}</h2>
    <p className="mb-3 text-xs text-muted">{subtitle}</p>
    <div className="h-72">{children}</div>
  </Card>;
}

function EmptyChart() {
  return <div className="flex h-full items-center justify-center text-sm text-muted">No data for these filters.</div>;
}

export function ApprovalReportsPage() {
  const pending = useQuery({ queryKey: ["approvals", "report-pending"], queryFn: approvalsApi.pendingAll });
  const decisions = useQuery({ queryKey: ["approvals", "report-decisions"], queryFn: approvalsApi.decisionsAll });

  const [range, setRange] = useState<RaisedRange>("30d");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [docType, setDocType] = useState("");
  const [status, setStatus] = useState("");
  const [requester, setRequester] = useState("");
  const [stage, setStage] = useState("");
  const [approver, setApprover] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [page, setPage] = useState(1);
  const size = 20;

  const now = Date.now();
  const allRows = useMemo(
    () => buildReportRows(pending.data ?? [], decisions.data ?? [], now),
    [decisions.data, pending.data, now],
  );
  const window = raisedWindow(range, dateFrom, dateTo, now);
  const filters = useMemo(() => ({
    window, docType, status, requester, stage, approver, overdueOnly,
  }), [approver, docType, overdueOnly, requester, stage, status, window]);
  const rows = useMemo(
    () => filterReportRows(allRows, filters)
      .sort((a, b) => new Date(b.report_at ?? 0).getTime() - new Date(a.report_at ?? 0).getTime()),
    [allRows, filters],
  );
  const pageRows = useMemo(() => rows.slice((page - 1) * size, page * size), [page, rows]);
  useEffect(() => {
    const pages = Math.max(1, Math.ceil(rows.length / size));
    if (page > pages) setPage(pages);
  }, [page, rows.length]);
  const kpis = useMemo(() => reportKpis(rows), [rows]);
  const trend = useMemo(() => decisionTrend(rows), [rows]);
  const ageing = useMemo(() => ageingBuckets(rows), [rows]);

  const docTypes = [...new Set(allRows.map((row) => row.doc_type))].sort();
  const statuses = [...new Set(allRows.map((row) => row.status))].sort();
  const stageOptions = [...new Set(allRows.map((row) => row.stage))].sort();
  const approvers = [...new Set([
    ...allRows.map((row) => row.approver_name).filter(Boolean),
  ] as string[])].sort();
  const activeFilters = Boolean(
    range !== "30d" || docType || status || requester || stage || approver || overdueOnly,
  );

  const previousTotal = useMemo(() => {
    if (!window || !Number.isFinite(window[0])) return null;
    const end = Number.isFinite(window[1]) ? window[1] : now + 1;
    const duration = end - window[0];
    if (duration <= 0) return null;
    return reportKpis(filterReportRows(allRows, {
      ...filters, window: [window[0] - duration, window[0]],
    })).total;
  }, [allRows, filters, now, window]);
  const totalDelta = previousTotal && previousTotal > 0
    ? Math.round(((kpis.total - previousTotal) / previousTotal) * 100)
    : undefined;

  const clear = () => {
    setRange("30d"); setDateFrom(""); setDateTo(""); setDocType("");
    setStatus(""); setRequester(""); setStage(""); setApprover(""); setOverdueOnly(false);
  };
  const exportExcel = () => {
    const sheet = XLSX.utils.json_to_sheet(rows.map((row) => ({
      Document: row.doc_no ?? `#${row.doc_id}`,
      Type: rowDocTypeLabel(row),
      Requester: row.requester ?? "",
      Approver: row.approver_name ?? "",
      Stage: row.stage,
      Status: row.status,
      "Raised / decision date": row.report_at ? new Date(row.report_at).toLocaleString() : "",
      "Waiting / turnaround hours": row.duration_hours == null ? "" : Math.round(row.duration_hours * 10) / 10,
      Overdue: row.overdue ? "Yes" : "No",
      Comments: row.comments ?? "",
    })));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Approval report");
    XLSX.writeFile(workbook, "approval-report.xlsx");
  };

  const columns: Column<ApprovalReportRow>[] = [
    { key: "date", header: "Date", render: (row) => row.report_at ? new Date(row.report_at).toLocaleString() : "—" },
    { key: "document", header: "Document", render: (row) => <div><strong className="font-mono text-ink">{row.doc_no ?? `#${row.doc_id}`}</strong><p className="text-xs text-muted">{rowDocTypeLabel(row)}</p></div> },
    { key: "requester", header: "Requester", hideOnNarrow: true, render: (row) => row.requester ?? "—" },
    { key: "stage", header: "Stage", render: (row) => row.stage },
    { key: "status", header: "Status", render: (row) => <StatusPill status={row.overdue && row.status === "PENDING" ? "OVERDUE" : row.status} /> },
    { key: "time", header: "Time", render: (row) => hours(row.duration_hours) },
    { key: "comments", header: "Comments", hideOnNarrow: true, render: (row) => <span className="line-clamp-2 max-w-56 text-sm text-body">{row.comments ?? "—"}</span> },
  ];
  const error = pending.error || decisions.error;
  const loading = pending.isLoading || decisions.isLoading;

  return <>
    <PageHeader
      eyebrow="Approvals"
      title="Approval reports"
      actions={<Button className={TONE_BLUE} variant="ghost" disabled={!rows.length} onClick={exportExcel}><Download className="h-4 w-4" /> Export Excel</Button>}
    />
    {error && <p className="mb-4 rounded-lg bg-danger/10 p-3 text-sm text-danger">{(error as Error).message}</p>}

    <Card className="mb-5 space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Period</span>
        <div className="inline-flex flex-wrap rounded-xl border border-line/70 bg-content2 p-1">
          {RANGE_OPTIONS.map((option) => <button
            key={option.value || "all"}
            type="button"
            aria-pressed={range === option.value}
            onClick={() => { setRange(option.value); if (option.value !== "custom") { setDateFrom(""); setDateTo(""); } }}
            className={`h-10 rounded-lg px-3 text-sm font-semibold ${range === option.value ? "bg-content1 text-brand shadow-sm" : "text-muted hover:text-ink"}`}
          >{option.label}</button>)}
        </div>
        {range === "custom" && <>
          <input aria-label="Report from date" type="date" value={dateFrom} max={dateTo || undefined} onChange={(event) => setDateFrom(event.target.value)} className="h-11 rounded-lg border border-line bg-content1 px-3 text-sm text-ink" />
          <input aria-label="Report to date" type="date" value={dateTo} min={dateFrom || undefined} onChange={(event) => setDateTo(event.target.value)} className="h-11 rounded-lg border border-line bg-content1 px-3 text-sm text-ink" />
        </>}
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {/* The shared Select, like every other filter in the app. These were four
            native <select>s, which the browser draws — no CSS makes them match. */}
        <Select ariaLabel="Document type" placeholder="All document types" value={docType} onChange={setDocType}
          options={docTypes.map((value) => ({ value, label: typeLabel(value) }))} />
        <Select ariaLabel="Decision status" placeholder="All statuses" value={status} onChange={setStatus}
          options={statuses.map((value) => ({ value, label: value.replace(/_/g, " ") }))} />
        <Select ariaLabel="Approval stage" placeholder="All stages" value={stage} onChange={setStage}
          options={stageOptions.map((value) => ({ value, label: value }))} />
        <Select ariaLabel="Approver" placeholder="All approvers" value={approver} onChange={setApprover}
          options={approvers.map((value) => ({ value, label: value }))} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-64 flex-1"><SearchField label="Requester filter" value={requester} onChange={setRequester} placeholder="Search requester" /></div>
        <Button variant={overdueOnly ? "danger" : "ghost"} onClick={() => setOverdueOnly(!overdueOnly)}>Overdue only</Button>
        {activeFilters && <Button variant="ghost" onClick={clear}><X className="h-4 w-4" /> Reset</Button>}
        <span className="ml-auto text-xs text-muted">Showing {rows.length} approval records</span>
      </div>
    </Card>

    <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="Total requests" value={loading ? "—" : kpis.total} delta={totalDelta} icon={<FileCheck2 className="h-4 w-4" />} />
      <StatCard label="Pending" value={loading ? "—" : kpis.pending} icon={<Clock className="h-4 w-4" />} />
      <StatCard label="Approved" value={loading ? "—" : kpis.approved} icon={<CheckCircle2 className="h-4 w-4" />} tone="text-success" />
      <StatCard label="Rejected" value={loading ? "—" : kpis.rejected} icon={<XCircle className="h-4 w-4" />} tone="text-danger" />
      <StatCard label="Returned" value={loading ? "—" : kpis.returned} icon={<RotateCcw className="h-4 w-4" />} tone="text-warning" />
      <StatCard label="Overdue" value={loading ? "—" : kpis.overdue} icon={<TriangleAlert className="h-4 w-4" />} tone={kpis.overdue ? "text-danger" : "text-muted"} />
      <StatCard label="Average approval time" value={loading ? "—" : hours(kpis.averageHours)} icon={<Clock className="h-4 w-4" />} />
      <StatCard label="Approval success rate" value={loading ? "—" : `${kpis.approvalRate}%`} icon={<ShieldCheck className="h-4 w-4" />} tone="text-success" />
      {kpis.slaRate != null && <StatCard label="SLA compliance" value={`${kpis.slaRate}%`} icon={<ShieldCheck className="h-4 w-4" />} tone={kpis.slaRate >= 90 ? "text-success" : "text-warning"} />}
    </div>

    <div className="mb-5 grid gap-4 xl:grid-cols-2">
      <ChartCard title="Decision trend" subtitle="Approved, rejected and returned decisions over time">
        {!trend.length ? <EmptyChart /> : <ResponsiveContainer width="100%" height="100%"><LineChart data={trend}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="name" tick={{ fontSize: 11 }} /><YAxis allowDecimals={false} tick={{ fontSize: 11 }} /><Tooltip /><Legend /><Line type="monotone" dataKey="approved" stroke="#16a34a" strokeWidth={2} /><Line type="monotone" dataKey="rejected" stroke="#dc2626" strokeWidth={2} /><Line type="monotone" dataKey="returned" stroke="#d97706" strokeWidth={2} /></LineChart></ResponsiveContainer>}
      </ChartCard>
      <ChartCard title="Pending ageing" subtitle="How long current requests have been waiting">
        <ResponsiveContainer width="100%" height="100%"><BarChart data={ageing}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="name" tick={{ fontSize: 11 }} /><YAxis allowDecimals={false} /><Tooltip /><Bar dataKey="value" radius={[6, 6, 0, 0]}>{ageing.map((item, index) => <Cell key={item.name} fill={COLORS[index % COLORS.length]} />)}</Bar></BarChart></ResponsiveContainer>
      </ChartCard>
    </div>

    <div className="mb-2 flex items-end justify-between gap-3"><div><h2 className="font-display text-lg font-bold text-ink">Detailed approval report</h2><p className="text-xs text-muted">The table and Excel export use the filters above.</p></div></div>
    <Card className="p-2"><ResponsiveList data={pageRows} loading={loading} keyOf={(row) => row.key} columns={columns} empty="No approval records match these report filters." renderCard={(row) => <div className="space-y-1"><div className="flex justify-between"><strong className="font-mono text-ink">{row.doc_no ?? `#${row.doc_id}`}</strong><StatusPill status={row.overdue && row.status === "PENDING" ? "OVERDUE" : row.status} /></div><p className="text-sm text-body">{rowDocTypeLabel(row)} · {row.stage}</p><p className="text-xs text-muted">{row.requester ?? "—"} · {hours(row.duration_hours)}</p>{row.comments && <p className="text-xs text-body">{row.comments}</p>}</div>} /><ApprovalPager page={page} size={size} total={rows.length} onPage={setPage} /></Card>
  </>;
}
