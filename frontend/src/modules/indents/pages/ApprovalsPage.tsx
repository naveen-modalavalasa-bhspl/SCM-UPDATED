import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import { AlarmClock, Inbox, RefreshCw, Search, TriangleAlert, X } from "lucide-react";
import {
  Button, Card, PageHeader, ResponsiveList, StatCard, type Column,
} from "@/shared/components";
import { indentApi, indentKeys, useIndentAccountCacheIsolation, useIndentAccountScope } from "../api";
import type { PendingApproval } from "../types";

/**
 * Everything blocked on this person, whatever kind of document it is.
 *
 * This screen used to drop every row whose doc_type was not INDENT, which made it a
 * lie: a procurement head with three POs waiting saw an empty page and had to know to
 * go looking somewhere else. `/api/workflow/pending` is already scoped to the caller
 * (wf_pending.approver_id == me), so showing every type does not widen what anyone can
 * see — it only stops hiding their own work from them.
 */

/**
 * The record itself, per document type — never the module's list screen.
 *
 * Allocations use the `?review=` deep link the approvals screen already honours; it
 * opens that allocation's review modal directly. Every warehouse document has a
 * `/:id` form inside the warehouse module's own router.
 *
 * PO is deliberately absent: `POListPage` is still a `Placeholder`, so there is no
 * record to open. The row says so instead of dumping someone on an empty page.
 */
const ROUTES: Record<string, (id: number) => string> = {
  INDENT: (id) => `/indents/${id}`,
  MR: (id) => `/inventory/material-requests/${id}`,
  ALLOCATION: (id) => `/inventory/allocation-approvals?review=${id}`,
  GRN: (id) => `/warehouse/grn/${id}`,
  ISSUE: (id) => `/warehouse/material-issues/${id}`,
  WH_ISSUE: (id) => `/warehouse/material-issues/${id}`,
  DISPATCH: (id) => `/warehouse/dispatch/${id}`,
  PURCHASE_RETURN: (id) => `/warehouse/purchase-returns/${id}`,
};

const DOC_LABELS: Record<string, string> = {
  INDENT: "Indent",
  ALLOCATION: "Stock allocation",
  MR: "Material request",
  PO: "Purchase order",
  GRN: "Goods receipt",
  ISSUE: "Material issue",
  WH_ISSUE: "Warehouse issue",
  DISPATCH: "Dispatch",
  PURCHASE_RETURN: "Purchase return",
};

const label = (docType: string) => DOC_LABELS[docType] ?? docType;

const DAY = 86_400_000;

const daysSince = (iso?: string | null) =>
  iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / DAY)) : null;

const isOverdue = (row: PendingApproval) =>
  !!row.due_at && new Date(row.due_at).getTime() < Date.now();

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export type RangeKey = "" | "24h" | "7d" | "30d" | "custom";

export const RANGES: { key: RangeKey; label: string }[] = [
  { key: "", label: "Any time" },
  { key: "24h", label: "Last 24 hours" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "custom", label: "Custom" },
];

/** Local midnight of a `YYYY-MM-DD`. `new Date("2026-07-15")` would parse as UTC and
 *  drag an evening row into the previous day east of Greenwich. */
const startOfDay = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
};

/**
 * The `[from, to)` window a range selection means, or null for "no date filter".
 *
 * The presets are rolling hours, not calendar days — "last 24 hours" at 2pm means
 * since 2pm yesterday, which is why this returns timestamps rather than date strings.
 * Custom stays calendar days, both ends inclusive, so picking the same day twice
 * gives you that whole day.
 */
export function rangeWindow(
  range: RangeKey, from = "", to = "", now = Date.now(),
): [number, number] | null {
  if (range === "24h") return [now - DAY, Infinity];
  if (range === "7d") return [now - 7 * DAY, Infinity];
  if (range === "30d") return [now - 30 * DAY, Infinity];
  if (range === "custom" && (from || to)) {
    return [from ? startOfDay(from) : -Infinity, to ? startOfDay(to) + DAY : Infinity];
  }
  return null;
}

interface ApprovalFilters {
  search?: string;
  docType?: string;
  overdueOnly?: boolean;
  /** From `rangeWindow`. Rows with no `waiting_since` drop out when a window is set. */
  window?: [number, number] | null;
}

/**
 * Search, type, overdue and date filtering over the pending list.
 *
 * Exported because it is the one piece of this screen worth testing on its own: the
 * rendering is a table, the filtering is a decision about what someone sees. Takes an
 * options object — six positional arguments was already one too many to read.
 */
export function filterPendingApprovals(
  approvals: PendingApproval[],
  { search = "", docType = "", overdueOnly = false, window = null }: ApprovalFilters = {},
) {
  const term = search.trim().toLocaleLowerCase();
  return approvals.filter((approval) => {
    if (docType && approval.doc_type !== docType) return false;
    if (overdueOnly && !isOverdue(approval)) return false;
    if (window) {
      const at = approval.waiting_since ? new Date(approval.waiting_since).getTime() : NaN;
      if (Number.isNaN(at) || at < window[0] || at >= window[1]) return false;
    }
    if (!term) return true;
    return [
      approval.doc_no,
      approval.summary,
      approval.requested_by_name,
      approval.current_stage_name,
      label(approval.doc_type),
      String(approval.doc_id),
    ]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(term));
  });
}

export function IndentApprovalsPage() {
  const nav = useNavigate();
  const accountScope = useIndentAccountScope();
  useIndentAccountCacheIsolation(accountScope);

  const [search, setSearch] = useState("");
  const [docType, setDocType] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [range, setRange] = useState<RangeKey>("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const { data = [], isLoading, isFetching, refetch } = useQuery({
    queryKey: indentKeys.pendingApprovals(accountScope),
    queryFn: indentApi.pendingApprovals,
  });

  // Built from what is actually waiting, not from the DocType enum: a filter offering
  // seven types when two are present is noise.
  const types = useMemo(() => {
    const counts = new Map<string, number>();
    data.forEach((r) => counts.set(r.doc_type, (counts.get(r.doc_type) ?? 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);

  const rows = useMemo(
    () =>
      filterPendingApprovals(data, {
        search, docType, overdueOnly,
        window: rangeWindow(range, dateFrom, dateTo),
      })
        // Oldest first: the thing that has been waiting longest is the thing to do next.
        .sort((a, b) => (daysSince(b.waiting_since) ?? 0) - (daysSince(a.waiting_since) ?? 0)),
    [data, search, docType, overdueOnly, range, dateFrom, dateTo],
  );

  const overdue = useMemo(() => data.filter(isOverdue).length, [data]);
  const oldest = useMemo(
    () => Math.max(0, ...data.map((r) => daysSince(r.waiting_since) ?? 0)),
    [data],
  );

  const activeFilters =
    [search, docType, range].filter(Boolean).length + (overdueOnly ? 1 : 0);
  const clear = () => {
    setSearch(""); setDocType(""); setOverdueOnly(false);
    setRange(""); setDateFrom(""); setDateTo("");
  };

  const open = (row: PendingApproval) => {
    const to = ROUTES[row.doc_type]?.(row.doc_id);
    if (to) nav(to);
  };

  const columns: Column<PendingApproval>[] = [
    {
      key: "doc",
      header: "Document",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-xs font-semibold text-ink">
            {r.doc_no ?? `#${r.doc_id}`}
          </div>
          <Chip size="sm" variant="flat">{label(r.doc_type)}</Chip>
        </div>
      ),
    },
    {
      key: "summary",
      header: "What it is",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-ink">{r.summary ?? "Awaiting your decision"}</div>
          {r.current_stage_name && (
            <div className="truncate text-[11px] text-muted">Stage: {r.current_stage_name}</div>
          )}
        </div>
      ),
    },
    {
      key: "who",
      header: "Raised by",
      hideOnNarrow: true,
      render: (r) => <span className="text-sm text-body">{r.requested_by_name ?? "—"}</span>,
    },
    {
      key: "amount",
      header: "Value",
      className: "text-right",
      hideOnNarrow: true,
      render: (r) =>
        r.amount ? <span className="text-sm text-ink">{inr(r.amount)}</span>
                 : <span className="text-muted">—</span>,
    },
    {
      key: "waiting",
      header: "Waiting",
      className: "text-right",
      render: (r) => {
        const d = daysSince(r.waiting_since);
        const late = isOverdue(r);
        return (
          <div>
            <div className={late ? "font-semibold text-danger" : d && d > 3 ? "text-warning" : "text-body"}>
              {d === null ? "—" : `${d}d`}
            </div>
            {r.due_at && (
              <div className="text-[11px] text-muted">
                {late ? "Overdue" : `Due ${new Date(r.due_at).toLocaleDateString()}`}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: "action",
      header: "",
      render: (r) =>
        ROUTES[r.doc_type] ? (
          <Button onClick={() => open(r)}>Review</Button>
        ) : (
          // Better an honest dead end than a click that lands on a placeholder.
          <span className="text-xs text-muted">No screen yet</span>
        ),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Approvals"
        title="Waiting for me"
        actions={
          <Button variant="ghost" disabled={isFetching} onClick={() => refetch()}>
            <RefreshCw size={14} className={isFetching ? "animate-spin" : ""} /> Refresh
          </Button>
        }
      />

      <div className="mb-4 grid grid-cols-3 gap-3">
        <StatCard label="Waiting on you" value={data.length} icon={<Inbox size={16} />} />
        <StatCard
          label="Past due"
          value={overdue}
          icon={<TriangleAlert size={16} />}
          tone={overdue ? "text-danger" : "text-muted"}
        />
        <StatCard
          label="Longest wait"
          value={data.length ? `${oldest}d` : "—"}
          icon={<AlarmClock size={16} />}
          tone={oldest > 3 ? "text-warning" : "text-muted"}
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search number, summary, requester or stage…"
            aria-label="Search approvals"
            className="h-11 w-full rounded-lg border border-line bg-content1 pl-9 pr-3 text-sm text-ink outline-none focus:border-brand"
          />
        </div>

        {/* Type chips rather than a dropdown: there are rarely more than four, and the
            count is the useful part — it says where the backlog actually is. */}
        <div className="flex flex-wrap gap-1">
          {types.map(([type, count]) => {
            const on = docType === type;
            return (
              <button
                key={type}
                onClick={() => setDocType(on ? "" : type)}
                aria-pressed={on}
                className={`h-11 rounded-lg border px-3 text-sm font-medium ${
                  on ? "border-brand bg-brand/10 text-brand" : "border-line bg-content1 text-body hover:bg-content2"
                }`}
              >
                {label(type)} <span className="text-muted">{count}</span>
              </button>
            );
          })}
        </div>

        <button
          onClick={() => setOverdueOnly(!overdueOnly)}
          aria-pressed={overdueOnly}
          className={`h-11 rounded-lg border px-3 text-sm font-medium ${
            overdueOnly ? "border-danger bg-danger/10 text-danger" : "border-line bg-content1 text-body hover:bg-content2"
          }`}
        >
          Past due only
        </button>

        {activeFilters > 0 && (
          <Button variant="ghost" onClick={clear}><X size={14} /> Clear</Button>
        )}
      </div>

      {/* How long it has been waiting. Rolling windows by default, because "did this
          land today" is the question people actually ask; exact dates are a click away
          for the rarer case of chasing a specific week. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Raised</span>
        <div className="inline-flex rounded-xl border border-line/70 bg-content2 p-1">
          {RANGES.map((r) => {
            const on = range === r.key;
            return (
              <button
                key={r.key || "any"}
                onClick={() => setRange(r.key)}
                aria-pressed={on}
                className={`h-10 rounded-lg px-3 text-sm font-semibold transition-colors ${
                  on ? "bg-content1 text-brand shadow-sm" : "text-muted hover:text-ink"
                }`}
              >
                {r.label}
              </button>
            );
          })}
        </div>

        {range === "custom" && (
          <div className="flex items-center gap-1">
            <input
              type="date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(e) => setDateFrom(e.target.value)}
              aria-label="Raised from"
              className="h-11 rounded-lg border border-line bg-content1 px-3 text-sm text-ink outline-none focus:border-brand"
            />
            <span className="text-sm text-muted">to</span>
            <input
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => setDateTo(e.target.value)}
              aria-label="Raised to"
              className="h-11 rounded-lg border border-line bg-content1 px-3 text-sm text-ink outline-none focus:border-brand"
            />
          </div>
        )}
      </div>

      <Card className="p-2">
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(r) => r.instance_id}
          loading={isLoading}
          onRowClick={open}
          empty={
            activeFilters
              ? "Nothing matches these filters."
              : "Nothing is waiting for your approval in this position."
          }
          renderCard={(r) => {
            const d = daysSince(r.waiting_since);
            return (
              <div className="space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-mono text-sm font-semibold text-ink">
                    {r.doc_no ?? `#${r.doc_id}`}
                  </span>
                  <Chip size="sm" variant="flat" color={isOverdue(r) ? "danger" : "default"}>
                    {label(r.doc_type)}
                  </Chip>
                </div>
                <p className="text-sm text-body">{r.summary ?? "Awaiting your decision"}</p>
                <p className="text-xs text-muted">
                  {r.requested_by_name ?? "—"}
                  {d !== null ? ` · waiting ${d}d` : ""}
                  {isOverdue(r) ? " · overdue" : ""}
                </p>
                <Button onClick={() => open(r)}>Review</Button>
              </div>
            );
          }}
        />
      </Card>
    </div>
  );
}
