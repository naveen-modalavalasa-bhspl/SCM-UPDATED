import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  AlarmClock, BarChart3, CheckCheck, ChevronRight, ClipboardList, FileText, Inbox,
  Lock, Package, RefreshCw, Search, Truck, TriangleAlert, X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  Button, Card, ErrorBanner, PageHeader, ResponsiveList, type Column,
  FILTER_FIELD, FILTER_RAIL, FILTER_TOGGLE, FILTER_TOGGLE_OFF, FILTER_TOGGLE_ON,
  Select,
} from "@/shared/components";
import { fmtDate, fmtDateTime, fmtRelative, parseIst } from "@/shared/datetime";
import { approvalsApi } from "../api";
import { approvalDocumentPath } from "../documentRoutes";
import { docTypeLabel } from "../docTypes";
import { Kpi } from "../components/ApprovalPulse";
import { approvalTypeCounts, raisedWindow, type RaisedRange } from "../filters";
import { ApprovalCorrectionPage } from "./CorrectionPage";
import { IndentApprovalReviewPage } from "./IndentApprovalReviewPage";
import { ApprovalReportsPage } from "./ReportsPage";
import { ApprovalPager } from "../components/Pager";
import type { PendingApproval } from "../types";


/** Document types this screen can sign without opening them.
 *
 *  Deliberately a list rather than "everything in the queue". An indent approval sets
 *  per-line quantities and an allocation picks the stocking point to serve from —
 *  approving either from a checkbox would silently accept a default the approver never
 *  looked at. What is here are the documents whose decision really is yes or no.
 */
const BULK_SIGNABLE = new Set([
  "REQUISITION", "CONSOLIDATION", "RFQ", "PO", "MR", "GRN", "PURCHASE_RETURN",
  // Outward QC belongs here: the inspector already recorded a result per line, so
  // what is left for the approver really is yes or no — there is no default hiding
  // behind the checkbox for them to accept without looking.
  "QC_OUTWARD",
]);

/**
 * One glyph and one tint per document FAMILY, so an approver reads what a row is
 * before reading its number: a request, a buying document, something moving stock,
 * something on the road. Per-type colour would be fifteen shades of decoration —
 * four families is a signal you can scan a queue by.
 */
const FAMILY: Record<string, { icon: LucideIcon; tint: string }> = {
  INDENT: { icon: ClipboardList, tint: "bg-brand-050 text-brand" },
  MR: { icon: ClipboardList, tint: "bg-brand-050 text-brand" },
  CONSOLIDATION: { icon: ClipboardList, tint: "bg-brand-050 text-brand" },
  REQUISITION: { icon: FileText, tint: "bg-info-bg text-info" },
  RFQ: { icon: FileText, tint: "bg-info-bg text-info" },
  PO: { icon: FileText, tint: "bg-info-bg text-info" },
  ALLOCATION: { icon: Package, tint: "bg-ok-bg text-ok" },
  OWN_STOCK_ALLOCATION: { icon: Package, tint: "bg-ok-bg text-ok" },
  ISSUE: { icon: Package, tint: "bg-ok-bg text-ok" },
  WH_ISSUE: { icon: Package, tint: "bg-ok-bg text-ok" },
  OWN_STOCK_ISSUE: { icon: Package, tint: "bg-ok-bg text-ok" },
  GRN: { icon: Package, tint: "bg-ok-bg text-ok" },
  PURCHASE_RETURN: { icon: Package, tint: "bg-ok-bg text-ok" },
  QC_OUTWARD: { icon: Package, tint: "bg-ok-bg text-ok" },
  DISPATCH: { icon: Truck, tint: "bg-warn-bg text-warn" },
  CARRIER_AWARD: { icon: Truck, tint: "bg-warn-bg text-warn" },
};
const familyOf = (type: string) =>
  FAMILY[type] ?? { icon: FileText, tint: "bg-neutral-bg text-neutral" };

const refOf = (row: PendingApproval) => `${row.doc_type}:${row.doc_id}`;
// The table moved to ../docTypes so the dashboard names a type the same way.
const label = docTypeLabel;
const DAY = 86_400_000;

/* Every timestamp goes through `parseIst`, never `new Date` directly: the API
   serialises most of them naive, so a browser set to another zone read the same row
   as a day older or younger than the desk beside it. One clock for the whole UI —
   see shared/datetime.ts. */
const msOf = (value?: string | null) => parseIst(value)?.getTime() ?? NaN;
const daysSince = (value?: string | null) => {
  const at = msOf(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.floor((Date.now() - at) / DAY));
};
const overdue = (row: PendingApproval) => {
  const due = msOf(row.due_at);
  return !Number.isNaN(due) && due < Date.now();
};
const inr = (value: number) =>
  `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/**
 * How long a row has sat with this approver, said in one chip.
 *
 * Colour is earned, not decorative: nothing for something raised today, amber once it
 * has been waiting more than three days, red only when a due date has actually
 * passed. A queue where every row is red says nothing about what to do first.
 */
function age(row: PendingApproval) {
  const days = daysSince(row.waiting_since);
  const text = days === null ? "—" : days === 0 ? "Today" : `${days}d`;
  if (overdue(row)) return { text, note: "Past due", tone: "bg-bad-bg text-bad" };
  if ((days ?? 0) > 3) return { text, note: null, tone: "bg-warn-bg text-warn" };
  return { text, note: null, tone: "bg-neutral-bg text-neutral" };
}

type Sort = "oldest" | "newest" | "due" | "value";

const SORTS: Array<{ value: Sort; label: string }> = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Longest waiting first" },
  { value: "due", label: "Due date" },
  { value: "value", label: "Highest value" },
];

/** A summary that only repeats the document number tells the approver nothing —
 *  the live data says "Indent IND/2026-27/00008" for every indent in the queue,
 *  printed beside a column that already shows IND/2026-27/00008. */
const summaryOf = (row: PendingApproval) => {
  const text = (row.summary ?? "").trim();
  if (!text || (row.doc_no && text.includes(row.doc_no))) return "Awaiting your decision";
  return text;
};

const RAISED_RANGES: Array<{ value: RaisedRange; label: string }> = [
  { value: "", label: "Any time" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "custom", label: "Custom" },
];

/* ---------------------------------------------------------------------------
 * Local controls: a filter chip, a KPI that filters, and a checkbox with a real
 * tap target. Everything with a shared primitive behind it — button, card, tile,
 * list, banner — still comes from `@/shared/components` untouched.
 *
 * A chip is deliberately NOT a <Button>: eight solid brand buttons of differing
 * label lengths wrapping across one row is what made this screen read as a pile of
 * controls rather than a queue with a filter above it.
 * ------------------------------------------------------------------------- */

function Chip({
  active, onClick, title, tone = "brand", children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  tone?: "brand" | "danger";
  children: ReactNode;
}) {
  const on = tone === "danger" ? "border-bad/40 bg-bad-bg text-bad" : FILTER_TOGGLE_ON;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`${FILTER_TOGGLE} ${active ? on : FILTER_TOGGLE_OFF}`}
    >
      {children}
    </button>
  );
}


/** A tick with 44px around it, and a click that never reaches the row behind it. */
function Tick({
  checked, onChange, aria,
}: {
  checked: boolean;
  onChange: () => void;
  aria: string;
}) {
  return (
    <span
      className="inline-grid h-11 w-11 place-items-center"
      onClick={(event) => event.stopPropagation()}
    >
      <input
        type="checkbox"
        aria-label={aria}
        checked={checked}
        onChange={onChange}
        className="h-5 w-5 cursor-pointer accent-brand"
      />
    </span>
  );
}

export function ApprovalsPage() {
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");
  /* Seeded from the URL, once, so the Overview can hand this screen a question
     rather than just a door: /approvals?doc_type=INDENT&overdue=1. Read at mount
     only — after that the controls own the state, and re-reading the params on
     every render would fight the user's own clicks. */
  const [docType, setDocType] = useState(() => params.get("doc_type") ?? "");
  const [pastDueOnly, setPastDueOnly] = useState(() => params.get("overdue") === "1");
  const [raisedRange, setRaisedRange] = useState<RaisedRange>("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sort, setSort] = useState<Sort>(() => {
    const asked = params.get("sort");
    return SORTS.some((option) => option.value === asked) ? asked as Sort : "newest";
  });
  const [page, setPage] = useState(1);
  const size = 20;
  const serverWindow = raisedWindow(raisedRange, dateFrom, dateTo);
  const queryFilters = {
    search: search.trim(), doc_type: docType, overdue_only: pastDueOnly, sort,
    raised_from: serverWindow && Number.isFinite(serverWindow[0]) ? new Date(serverWindow[0]).toISOString() : undefined,
    raised_to: serverWindow && Number.isFinite(serverWindow[1]) ? new Date(serverWindow[1]).toISOString() : undefined,
  };
  const query = useQuery({
    queryKey: ["approvals", "pending", page, size, queryFilters],
    queryFn: () => approvalsApi.pending(page, size, queryFilters),
  });
  // The tiles and the type chips describe the whole queue, so they read the whole
  // queue. Counting `query.data.items` counted one page of 20, which made "Waiting on
  // you" disagree with the same number on Home.
  const queueQuery = useQuery({
    queryKey: ["approvals", "pending", "queue"],
    queryFn: () => approvalsApi.pendingAll(),
  });
  const queue = useMemo(() => queueQuery.data ?? [], [queueQuery.data]);
  useEffect(() => setPage(1), [dateFrom, dateTo, docType, pastDueOnly, raisedRange, search, sort]);
  const all = useMemo(() => query.data?.items ?? [], [query.data?.items]);
  const types = useMemo(() => approvalTypeCounts(queue), [queue]);
  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    const window = raisedWindow(raisedRange, dateFrom, dateTo);
    return all.filter((row) => {
      if (docType && row.doc_type !== docType) return false;
      if (pastDueOnly && !overdue(row)) return false;
      const waiting = msOf(row.waiting_since);
      if (window && (Number.isNaN(waiting) || waiting < window[0] || waiting >= window[1])) return false;
      return !term || [row.doc_no, row.summary, row.requested_by_name, row.current_stage_name]
        .some((value) => String(value ?? "").toLowerCase().includes(term));
    }).sort((a, b) => {
      const waited = (row: PendingApproval) => {
        const at = msOf(row.waiting_since);
        return Number.isNaN(at) ? 0 : at;
      };
      const due = (row: PendingApproval) => {
        const at = msOf(row.due_at);
        return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
      };
      if (sort === "newest") return waited(b) - waited(a);
      if (sort === "due") return due(a) - due(b);
      if (sort === "value") return Number(b.amount ?? 0) - Number(a.amount ?? 0);
      return waited(a) - waited(b);
    });
  }, [all, dateFrom, dateTo, docType, pastDueOnly, raisedRange, search, sort]);

  const setSelected = (row: PendingApproval) => nav(approvalDocumentPath(row));

  // --- bulk signing ------------------------------------------------------------
  // Keyed by doc_type:doc_id, not by instance id: that is what the endpoint takes, and
  // it survives a refetch that renumbers nothing but re-creates the row objects.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulkNote, setBulkNote] = useState("");
  const signable = useMemo(() => rows.filter((row) => BULK_SIGNABLE.has(row.doc_type)), [rows]);
  // A selection is dropped as soon as its row leaves the page — a filter change or a
  // page turn means the approver is no longer looking at what they ticked.
  useEffect(() => {
    const onPage = new Set(signable.map(refOf));
    setPicked((current) => {
      const kept = new Set([...current].filter((ref) => onPage.has(ref)));
      return kept.size === current.size ? current : kept;
    });
  }, [signable]);
  const toggle = (row: PendingApproval) => setPicked((current) => {
    const next = new Set(current);
    if (!next.delete(refOf(row))) next.add(refOf(row));
    return next;
  });
  const allPicked = signable.length > 0 && picked.size === signable.length;
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const [bulkFailed, setBulkFailed] = useState(false);
  const bulk = useMutation({
    mutationFn: (approve: boolean) => {
      const documents = [...picked].map((ref) => {
        const [doc_type, doc_id] = ref.split(":");
        return { doc_type, doc_id: Number(doc_id) };
      });
      return approve
        ? approvalsApi.bulkApprove(documents, bulkNote)
        : approvalsApi.bulkReject(documents, bulkNote);
    },
    onSuccess: (result) => {
      // Partial success is normal — someone else may have signed a row in between —
      // so the count is always reported rather than assumed.
      setBulkFailed(result.failed.length > 0);
      setBulkResult(result.failed.length === 0
        ? `${result.succeeded} signed.`
        : `${result.succeeded} of ${result.requested} signed. ${result.failed.length} could not be: `
          + result.failed.map((row) => `${row.doc_type} #${row.doc_id} — ${row.error}`).join("; "));
      setPicked(new Set());
      setBulkNote("");
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (error: Error) => { setBulkFailed(true); setBulkResult(error.message); },
  });

  /** Icon, number and type — the row's identity, built once for both layouts. */
  const identity = (row: PendingApproval) => {
    const { icon: Icon, tint } = familyOf(row.doc_type);
    return (
      <div className="flex min-w-0 items-center gap-2.5">
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${tint}`}>
          <Icon className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0">
          <strong className="block truncate font-mono text-[13px] font-semibold text-ink">
            {row.doc_no ?? `#${row.doc_id}`}
          </strong>
          <span className="text-xs text-muted">{label(row.doc_type)}</span>
        </div>
      </div>
    );
  };

  const columns: Column<PendingApproval>[] = [
    {
      key: "pick", header: "", className: "w-12",
      render: (row) => BULK_SIGNABLE.has(row.doc_type)
        ? <Tick
            checked={picked.has(refOf(row))}
            onChange={() => toggle(row)}
            aria={`Select ${row.doc_no ?? row.doc_id}`}
          />
        : <span
            className="grid h-11 w-11 place-items-center text-muted/50"
            title="Open this one to decide it — it sets quantities or a source"
          ><Lock className="h-3.5 w-3.5" /></span>,
    },
    { key: "document", header: "Document", className: "w-[230px]", render: identity },
    {
      key: "summary", header: "What it is",
      render: (row) => (
        <div className="min-w-0">
          <p className="text-sm text-ink">{summaryOf(row)}</p>
          {/* The value when there is one, the stage when there is not. Every row in
              THIS queue is at the stage this approver holds, so printing it twelve
              times down the page was twelve lines all saying the same thing. */}
          {row.amount != null
            ? <p className="mt-0.5 text-xs font-semibold text-body">{inr(Number(row.amount))}</p>
            : <p className="mt-0.5 text-xs text-muted">{row.current_stage_name ?? `Stage ${row.stage_sequence}`}</p>}
        </div>
      ),
    },
    {
      key: "requester", header: "Raised by", hideOnNarrow: true,
      render: (row) => (
        <div>
          <p className="text-sm text-body">{row.requested_by_name ?? "—"}</p>
          {row.waiting_since && <p className="text-xs text-muted">{fmtDate(row.waiting_since)}</p>}
        </div>
      ),
    },
    {
      key: "waiting", header: "Waiting", className: "w-28",
      render: (row) => {
        const state = age(row);
        return (
          <div className="flex flex-col items-start gap-1">
            <span
              title={row.waiting_since ? `Waiting since ${fmtDateTime(row.waiting_since)}` : undefined}
              className={`inline-flex min-h-7 items-center rounded-full px-2.5 text-xs font-semibold tabular ${state.tone}`}
            >{state.text}</span>
            {state.note
              ? <span className="text-[11px] font-semibold text-bad">{state.note}</span>
              : row.due_at && <span className="text-[11px] text-muted">Due {fmtDate(row.due_at)}</span>}
          </div>
        );
      },
    },
    {
      key: "action", header: "", className: "w-32",
      // Ghost, not filled: twelve solid buttons down the right-hand side turned the
      // queue into a column of blue and pulled the eye off the documents themselves.
      render: (row) => (
        <Button variant="ghost" onClick={() => setSelected(row)}>
          Review <ChevronRight className="h-4 w-4" />
        </Button>
      ),
    },
  ];

  const pastDue = queue.filter(overdue).length;
  const oldest = Math.max(0, ...queue.map((row) => daysSince(row.waiting_since) ?? 0));
  const filtered = Boolean(search || docType || pastDueOnly || raisedRange);
  const clear = () => { setSearch(""); setDocType(""); setPastDueOnly(false); setRaisedRange(""); setDateFrom(""); setDateTo(""); setSort("newest"); setPage(1); };

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

  const total = query.data?.total ?? 0;

  return <>
    <PageHeader
      eyebrow="Approvals"
      title="Waiting for me"
      actions={<div className="flex flex-wrap items-center gap-2">
        {/* An inbox that refreshes itself has to say when it last did, or the approver
            cannot tell an empty queue from a stale one. */}
        <span className="hidden text-xs text-muted sm:inline">
          Updated {fmtRelative(query.dataUpdatedAt)}
        </span>
        <Button variant="ghost" onClick={() => setParams({ view: "reports" })}>
          <BarChart3 className="h-4 w-4" /> Reports
        </Button>
        <Button variant="subtle" disabled={query.isFetching} onClick={() => query.refetch()}>
          <RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>}
    />

    {/* The three numbers this screen is opened for — each one also the filter it
        names. Reading "3 past due" and then hunting for the control that shows those
        three rows is the step this removes. */}
    {/* The same tiles the dashboard draws, from ../components/ApprovalPulse — one
        component, so the two screens cannot end up reporting the same queue in two
        shapes. Here each one is also the FILTER it names: reading "3 past due" and
        then hunting for the control that shows those three rows is the step this
        removes, which is why they set state rather than navigate. */}
    <section aria-label="Approval queues" className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Kpi
        label="Waiting on you"
        value={queue.length}
        icon={Inbox}
        tint="bg-brand-050 text-brand"
        muted={queue.length === 0}
        onOpen={clear}
      />
      <Kpi
        label="Past due"
        value={pastDue}
        icon={TriangleAlert}
        tint="bg-bad-bg text-bad"
        muted={pastDue === 0}
        onOpen={() => setPastDueOnly(!pastDueOnly)}
      />
      <Kpi
        label="Longest wait"
        value={queue.length ? `${oldest}d` : "—"}
        icon={AlarmClock}
        tint="bg-warn-bg text-warn"
        muted={queue.length === 0}
        onOpen={() => setSort("oldest")}
      />
    </section>

    <Card className={`mb-4 divide-y divide-line/70 !p-0 ${FILTER_RAIL}`}>
      {/* Band one: what it says, how far back, in what order, and the one narrowing
          that is none of those — four controls on a single laptop row, wrapping on a
          phone. As three separate bands this card put the first document 590px down
          the page, which on a 900px screen left room for three rows. */}
      <div className="flex flex-wrap items-center gap-2 p-3 sm:p-4">
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            className={`${FILTER_FIELD} pl-9 pr-10`}
            aria-label="Search approvals"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search document, requester or stage"
          />
          {search && <button
            type="button"
            aria-label="Clear search"
            onClick={() => setSearch("")}
            className="absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full text-muted transition hover:bg-bad-bg hover:text-bad"
          ><X className="h-4 w-4" /></button>}
        </div>
        {/* Every option says the word "Raised", so the control needs no label beside
            it — a bare "7 days" sitting next to a sort box could mean either one. */}
        {/* The shared Select — HeroUI, the same control Logistics filters with and
            the same one the dropdowns beside it are. These were native <select>s,
            which no amount of CSS makes match: the browser draws the box. */}
        <div className="w-full sm:w-52">
          <Select
            ariaLabel="Raised within"
            placeholder="Raised: Any time"
            value={raisedRange}
            onChange={(next) => {
              const value = next as RaisedRange;
              setRaisedRange(value);
              if (value !== "custom") { setDateFrom(""); setDateTo(""); }
            }}
            options={RAISED_RANGES.filter((range) => range.value !== "").map((range) => ({
              value: range.value,
              label: `Raised: ${range.label}`,
            }))}
          />
        </div>
        <div className="w-full sm:w-56">
          <Select
            ariaLabel="Sort approvals"
            value={sort}
            onChange={(next) => setSort(next as Sort)}
            options={SORTS.map((option) => ({ value: option.value, label: option.label }))}
          />
        </div>
        <Chip
          active={pastDueOnly}
          tone="danger"
          onClick={() => setPastDueOnly(!pastDueOnly)}
          title="Show only what is past its due date"
        >
          <TriangleAlert className="h-4 w-4" /> Past due
        </Chip>
        {filtered && <Button variant="ghost" onClick={clear}><X className="h-4 w-4" /> Clear all</Button>}
        {raisedRange === "custom" && <div className="flex w-full flex-wrap items-center gap-2">
          <label className="text-xs text-muted">From
            <input
              type="date" value={dateFrom} max={dateTo || undefined}
              onChange={(event) => setDateFrom(event.target.value)}
              className="ml-1 h-11 rounded-xl border-2 border-line bg-content1 px-3 text-sm font-medium text-ink outline-none transition-colors hover:border-ink/40 focus:border-ink"
            />
          </label>
          <label className="text-xs text-muted">To
            <input
              type="date" value={dateTo} min={dateFrom || undefined}
              onChange={(event) => setDateTo(event.target.value)}
              className="ml-1 h-11 rounded-xl border-2 border-line bg-content1 px-3 text-sm font-medium text-ink outline-none transition-colors hover:border-ink/40 focus:border-ink"
            />
          </label>
        </div>}
      </div>

      {/* Band two: the queue by type, with its counts. Scrolls sideways on a phone
          and wraps on a laptop — a chip clipped through the middle of its own count
          is the one thing worse than a second line of chips. */}
      <div className="flex items-center gap-2 p-3 sm:gap-3 sm:p-4">
        <span className="w-11 shrink-0 text-[11px] font-semibold uppercase tracking-wider text-muted">Type</span>
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-x-visible sm:pb-0">
          <Chip active={!docType} onClick={() => setDocType("")} title="Every document type">
            All <span className="tabular opacity-75">{queue.length}</span>
          </Chip>
          {/* A type with nothing in it can only ever produce an empty list, so it is
              not offered — unless it is the one currently picked, which has to stay
              on screen to be switched off. */}
          {types.filter(([type, count]) => count > 0 || docType === type).map(([type, count]) => (
            <Chip
              key={type}
              active={docType === type}
              onClick={() => setDocType(docType === type ? "" : type)}
            >
              {label(type)} <span className="tabular opacity-75">{count}</span>
            </Chip>
          ))}
        </div>
      </div>
    </Card>

    {/* Select-all and the count sit directly above the rows they describe, as a plain
        strip: another bordered card here would have been chrome, not information. */}
    <div className="mb-2 flex items-center justify-between gap-2 px-1">
      {signable.length > 0
        ? <label className="flex cursor-pointer items-center gap-1 text-sm font-medium text-body">
            <Tick
              checked={allPicked}
              onChange={() => setPicked(allPicked ? new Set() : new Set(signable.map(refOf)))}
              aria="Select every signable document on this page"
            />
            Select all {signable.length}
          </label>
        : <span />}
      <span className="tabular text-sm text-muted">
        {total === 0 ? "" : `Showing ${rows.length} of ${total}`}
      </span>
    </div>

    <ErrorBanner error={query.error} />

    {!query.error && <ResponsiveList
      data={rows}
      loading={query.isLoading}
      keyOf={(row) => row.instance_id}
      columns={columns}
      onRowClick={setSelected}
      // The tick column renders out of `picked`, which changes while `data` does not.
      // HeroUI's Table is a react-stately collection and caches its built cells
      // against the identity of `items`, so without this the box you clicked stayed
      // visibly empty — the selection was really made (the action bar appeared) and
      // the row simply never repainted. `revision` is the shared list's own answer to
      // that; it just was never passed.
      revision={`${page}|${[...picked].sort().join(",")}`}
      empty={<div className="flex flex-col items-center gap-2 py-10 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-ok-bg text-ok">
          <CheckCheck className="h-6 w-6" />
        </span>
        <p className="font-display text-lg font-semibold text-ink">
          {filtered ? "Nothing matches these filters" : "You are all caught up"}
        </p>
        <p className="max-w-sm text-sm text-muted">
          {filtered
            ? "Widen the search or clear the filters to see the rest of your queue."
            : "Nothing is waiting for your approval. New requests land here the moment they are raised."}
        </p>
        {filtered && <span className="mt-1"><Button variant="soft" onClick={clear}>Clear filters</Button></span>}
      </div>}
      renderCard={(row) => {
        const state = age(row);
        return <div className="space-y-3">
          <div className="flex items-start justify-between gap-2">
            {identity(row)}
            <span className={`inline-flex min-h-7 shrink-0 items-center rounded-full px-2.5 text-xs font-semibold tabular ${state.tone}`}>
              {state.note ?? state.text}
            </span>
          </div>
          <p className="text-sm text-body">{summaryOf(row)}</p>
          <p className="text-xs text-muted">
            {row.requested_by_name ?? "—"}
            {row.amount != null
              ? <span className="font-semibold text-body"> · {inr(Number(row.amount))}</span>
              : ` · ${row.current_stage_name ?? `Stage ${row.stage_sequence}`}`}
          </p>
          <div className="flex items-center justify-between gap-2">
            {BULK_SIGNABLE.has(row.doc_type)
              // The whole card navigates, so the label's TEXT has to stop the click
              // too — the tick itself does, but tapping the word "Select" would
              // otherwise both select the row and open it.
              ? <label
                  className="flex cursor-pointer items-center gap-1 text-xs font-medium text-body"
                  onClick={(event) => event.stopPropagation()}
                >
                  <Tick
                    checked={picked.has(refOf(row))}
                    onChange={() => toggle(row)}
                    aria={`Select ${row.doc_no ?? row.doc_id}`}
                  />
                  Select
                </label>
              : <span />}
            <Button variant="soft" onClick={() => setSelected(row)}>
              Review <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>;
      }}
    />}

    {/* A bulk result stays put until it is dismissed: it can carry the one row that
        did NOT sign, and a toast that fades takes that away with it. */}
    {bulkResult && <div
      role="status"
      className={`mt-3 flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${
        bulkFailed ? "border-bad/30 bg-bad-bg text-bad" : "border-ok/30 bg-ok-bg text-ok"
      }`}
    >
      <span>{bulkResult}</span>
      <button
        type="button" aria-label="Dismiss" onClick={() => setBulkResult(null)}
        className="shrink-0 opacity-70 hover:opacity-100"
      ><X className="h-4 w-4" /></button>
    </div>}

    {!query.error && <ApprovalPager page={page} size={size} total={total} onPage={setPage} />}

    {/* One decision, one request. The bar rides the bottom of the screen only once
        something is ticked — an approver working document by document never sees it,
        and one working through forty never scrolls back up to sign. */}
    {picked.size > 0 && <div className="sticky bottom-24 z-20 mt-4 md:bottom-6">
      <Card className="flex flex-wrap items-center gap-2 border-brand/40 bg-content1/95 p-3 shadow-lg backdrop-blur">
        <span className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-050 px-3 text-sm font-semibold text-brand">
          <CheckCheck className="h-4 w-4" /> {picked.size} selected
        </span>
        <input
          className="h-11 min-w-52 flex-1 rounded-xl border border-line bg-content1 px-3 text-sm text-ink outline-none focus:border-brand"
          aria-label="Comment for every document in this batch"
          value={bulkNote}
          onChange={(event) => setBulkNote(event.target.value)}
          placeholder="Comment (required to reject)"
        />
        <Button disabled={bulk.isPending} onClick={() => bulk.mutate(true)}>
          {bulk.isPending ? "Signing…" : `Approve ${picked.size}`}
        </Button>
        <Button
          variant="danger"
          disabled={bulk.isPending || !bulkNote.trim()}
          onClick={() => bulk.mutate(false)}
        >
          Reject {picked.size}
        </Button>
        <Button variant="ghost" onClick={() => setPicked(new Set())}>Cancel</Button>
        {!bulkNote.trim() && <p className="w-full text-xs text-muted">
          A rejection needs a comment — it is the only thing the requester is told.
        </p>}
      </Card>
    </div>}
    {/* Room under the bar, so the rows it floats over can always be scrolled clear of
        it. Without this the last row of a full page sits behind the bar and cannot be
        ticked at all — Playwright found it before an approver had to. */}
    {picked.size > 0 && <div aria-hidden="true" className="h-24 md:h-16" />}
  </>;
}
