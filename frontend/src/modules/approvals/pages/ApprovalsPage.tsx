import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AlarmClock, BarChart3, Inbox, RefreshCw, Search, TriangleAlert, X } from "lucide-react";
import {
  Button, Card, PageHeader, ResponsiveList, StatCard, StatusPill, type Column,
} from "@/shared/components";
import { approvalsApi } from "../api";
import { approvalDocumentPath } from "../documentRoutes";
import { approvalTypeCounts, raisedWindow, type RaisedRange } from "../filters";
import { ApprovalCorrectionPage } from "./CorrectionPage";
import { IndentApprovalReviewPage } from "./IndentApprovalReviewPage";
import { ApprovalReportsPage } from "./ReportsPage";
import { ApprovalPager } from "../components/Pager";
import type { PendingApproval } from "../types";

const LABELS: Record<string, string> = {
  INDENT: "Indent", ALLOCATION: "Stock allocation", MR: "Material request",
  PO: "Purchase order", GRN: "Goods receipt", ISSUE: "Material issue",
  WH_ISSUE: "Warehouse issue", DISPATCH: "Dispatch", PURCHASE_RETURN: "Purchase return",
};
const label = (value: string) => LABELS[value] ?? value.replace(/_/g, " ");
const DAY = 86_400_000;
const daysSince = (value?: string | null) => value
  ? Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / DAY)) : null;
const overdue = (row: PendingApproval) => Boolean(
  row.due_at && new Date(row.due_at).getTime() < Date.now(),
);

type Sort = "oldest" | "newest" | "due" | "value";

const RAISED_RANGES: Array<{ value: RaisedRange; label: string }> = [
  { value: "", label: "Any time" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "custom", label: "Custom" },
];

export function ApprovalsPage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [docType, setDocType] = useState("");
  const [pastDueOnly, setPastDueOnly] = useState(false);
  const [raisedRange, setRaisedRange] = useState<RaisedRange>("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sort, setSort] = useState<Sort>("oldest");
  const [page, setPage] = useState(1);
  const size = 20;
  const serverWindow = raisedWindow(raisedRange, dateFrom, dateTo);
  const queryFilters = {
    search: search.trim(), doc_type: docType, overdue_only: pastDueOnly, sort,
    raised_from: serverWindow && Number.isFinite(serverWindow[0]) ? new Date(serverWindow[0]).toISOString() : undefined,
    raised_to: serverWindow && Number.isFinite(serverWindow[1]) ? new Date(serverWindow[1]).toISOString() : undefined,
  };
  const query = useQuery({ queryKey: ["approvals", "pending", page, size, queryFilters], queryFn: () => approvalsApi.pending(page, size, queryFilters) });
  useEffect(() => setPage(1), [dateFrom, dateTo, docType, pastDueOnly, raisedRange, search, sort]);
  const all = useMemo(() => query.data?.items ?? [], [query.data?.items]);
  const types = useMemo(() => approvalTypeCounts(all), [all]);
  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    const window = raisedWindow(raisedRange, dateFrom, dateTo);
    return all.filter((row) => {
      if (docType && row.doc_type !== docType) return false;
      if (pastDueOnly && !overdue(row)) return false;
      const waiting = row.waiting_since ? new Date(row.waiting_since).getTime() : NaN;
      if (window && (Number.isNaN(waiting) || waiting < window[0] || waiting >= window[1])) return false;
      return !term || [row.doc_no, row.summary, row.requested_by_name, row.current_stage_name]
        .some((value) => String(value ?? "").toLowerCase().includes(term));
    }).sort((a, b) => {
      if (sort === "newest") return new Date(b.waiting_since ?? 0).getTime() - new Date(a.waiting_since ?? 0).getTime();
      if (sort === "due") return new Date(a.due_at ?? "9999-12-31").getTime() - new Date(b.due_at ?? "9999-12-31").getTime();
      if (sort === "value") return Number(b.amount ?? 0) - Number(a.amount ?? 0);
      return new Date(a.waiting_since ?? 0).getTime() - new Date(b.waiting_since ?? 0).getTime();
    });
  }, [all, dateFrom, dateTo, docType, pastDueOnly, raisedRange, search, sort]);

  const setSelected = (row: PendingApproval) => nav(approvalDocumentPath(row));

  const columns: Column<PendingApproval>[] = [
    { key: "document", header: "Document", render: (row) => <div><strong className="font-mono text-ink">{row.doc_no ?? `#${row.doc_id}`}</strong><p className="text-xs text-muted">{label(row.doc_type)}</p></div> },
    { key: "summary", header: "What it is", render: (row) => <div><p className="text-sm text-ink">{row.summary ?? "Awaiting your decision"}</p><p className="text-xs text-muted">{row.current_stage_name ?? `Stage ${row.stage_sequence}`}</p></div> },
    { key: "requester", header: "Raised by", hideOnNarrow: true, render: (row) => row.requested_by_name ?? "—" },
    { key: "waiting", header: "Waiting", render: (row) => <div className={overdue(row) ? "font-semibold text-danger" : (daysSince(row.waiting_since) ?? 0) > 3 ? "font-semibold text-warning" : "text-body"}>{daysSince(row.waiting_since) === null ? "—" : `${daysSince(row.waiting_since)}d`}{overdue(row) && <p className="text-xs">Overdue</p>}</div> },
    { key: "action", header: "", render: (row) => <Button onClick={() => setSelected(row)}>View details</Button> },
  ];
  const pastDue = all.filter(overdue).length;
  const oldest = Math.max(0, ...all.map((row) => daysSince(row.waiting_since) ?? 0));
  const filtered = Boolean(search || docType || pastDueOnly || raisedRange);
  const clear = () => { setSearch(""); setDocType(""); setPastDueOnly(false); setRaisedRange(""); setDateFrom(""); setDateTo(""); setSort("oldest"); setPage(1); };

  if (params.get("view") === "reports") {
    return <>
      <Button variant="ghost" onClick={() => setParams({})}>Back to approvals</Button>
      <ApprovalReportsPage />
    </>;
  }

  const correctionId = Number(params.get("correction"));
  if (Number.isFinite(correctionId) && correctionId > 0) {
    return <ApprovalCorrectionPage indentId={correctionId} onClose={() => setParams({})} />;
  }

  const reviewIndentId = Number(params.get("reviewIndent"));
  if (Number.isFinite(reviewIndentId) && reviewIndentId > 0) {
    return <IndentApprovalReviewPage indentId={reviewIndentId} />;
  }

  return <>
    <PageHeader eyebrow="Approvals" title="Waiting for me" actions={<div className="flex gap-2"><Button variant="ghost" onClick={() => setParams({ view: "reports" })}><BarChart3 className="h-4 w-4" /> Reports</Button><Button variant="ghost" disabled={query.isFetching} onClick={() => query.refetch()}><RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} /> Refresh</Button></div>} />
    <div className="mb-4 grid grid-cols-3 gap-3"><StatCard label="Waiting on you" value={all.length} icon={<Inbox size={16} />} /><StatCard label="Past due" value={pastDue} icon={<TriangleAlert size={16} />} tone={pastDue ? "text-danger" : "text-muted"} /><StatCard label="Longest wait" value={all.length ? `${oldest}d` : "—"} icon={<AlarmClock size={16} />} tone={oldest > 3 ? "text-warning" : "text-muted"} /></div>
    <Card className="mb-4 space-y-3 p-4">
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-60 flex-1"><Search className="absolute left-3 top-3.5 h-4 w-4 text-muted" /><input className="h-11 w-full rounded-lg border border-line bg-content1 pl-9 pr-3 text-sm text-ink" aria-label="Search approvals" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search document, requester or stage" /></div>
        {types.map(([type, count]) => <Button key={type} variant={docType === type ? "primary" : "ghost"} onClick={() => setDocType(docType === type ? "" : type)}>{label(type)} {count}</Button>)}
        <Button variant={pastDueOnly ? "danger" : "ghost"} onClick={() => setPastDueOnly(!pastDueOnly)}>Past due only</Button>
        <select aria-label="Sort approvals" value={sort} onChange={(event) => setSort(event.target.value as Sort)} className="h-11 rounded-lg border border-line bg-content1 px-3 text-sm text-ink"><option value="oldest">Oldest first</option><option value="newest">Newest first</option><option value="due">Due date</option><option value="value">Highest value</option></select>
        {filtered && <Button variant="ghost" onClick={clear}><X className="h-4 w-4" /> Clear</Button>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Raised</span>
        <div className="inline-flex flex-wrap rounded-xl border border-line/70 bg-content2 p-1">
          {RAISED_RANGES.map((range) => {
            const selected = raisedRange === range.value;
            return <button
              key={range.value || "any"}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                setRaisedRange(range.value);
                if (range.value !== "custom") { setDateFrom(""); setDateTo(""); }
              }}
              className={`h-10 rounded-lg px-3 text-sm font-semibold transition-colors ${selected ? "bg-content1 text-brand shadow-sm" : "text-muted hover:text-ink"}`}
            >{range.label}</button>;
          })}
        </div>
        {raisedRange === "custom" && <>
          <label className="text-xs text-muted">From<input type="date" value={dateFrom} max={dateTo || undefined} onChange={(event) => setDateFrom(event.target.value)} className="ml-1 h-11 rounded-lg border border-line bg-content1 px-2 text-sm text-ink" /></label>
          <label className="text-xs text-muted">To<input type="date" value={dateTo} min={dateFrom || undefined} onChange={(event) => setDateTo(event.target.value)} className="ml-1 h-11 rounded-lg border border-line bg-content1 px-2 text-sm text-ink" /></label>
        </>}
      </div>
    </Card>
    {query.error ? <p className="rounded-xl bg-danger/10 p-4 text-sm text-danger">{(query.error as Error).message}</p> : <Card className="p-2"><ResponsiveList data={rows} loading={query.isLoading} keyOf={(row) => row.instance_id} columns={columns} onRowClick={setSelected} empty={filtered ? "Nothing matches these filters." : "Nothing is waiting for your approval."} renderCard={(row) => <div className={`space-y-2 rounded-lg p-2 ${overdue(row) ? "bg-danger/5" : ""}`}><div className="flex justify-between gap-2"><strong className="font-mono text-ink">{row.doc_no ?? `#${row.doc_id}`}</strong><StatusPill status={overdue(row) ? "OVERDUE" : row.doc_type} /></div><p className="text-sm text-body">{row.summary ?? "Awaiting your decision"}</p><p className="text-xs text-muted">{row.requested_by_name ?? "—"} · waiting {daysSince(row.waiting_since) ?? "—"}d</p><Button onClick={() => setSelected(row)}>View details</Button></div>} /></Card>}
    {!query.error && <ApprovalPager page={page} size={size} total={query.data?.total ?? 0} onPage={setPage} />}
  </>;
}
