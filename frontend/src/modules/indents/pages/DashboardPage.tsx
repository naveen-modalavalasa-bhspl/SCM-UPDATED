import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarDays, CheckCircle2, ChevronRight, Clock, FileText, Package,
  PackageCheck, PackageOpen, Percent, PencilLine, TrendingDown, XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import { Card } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import {
  INDENT_QUERY_GC_TIME,
  INDENT_QUERY_STALE_TIME,
  indentApi,
  indentKeys,
  normalizeIndentQueryParams,
  useIndentAccountCacheIsolation,
  useIndentAccountScope,
} from "../api";
import { IndentModuleHeader } from "../components/IndentModuleHeader";
import { getRaisedDateRange } from "../components/IndentFilterBar";
import { IndentSummaryStatusBadge } from "../components/IndentSummaryStatusBadge";
import { StatusBreakdownChart } from "../components/StatusBreakdownChart";
import { IndentFilterProvider, useIndentFilters } from "../context/IndentFilterContext";
import { INDENT_REQUEST_STATUS_FILTER_OPTIONS } from "../constants";
// Indents reads inventory, which is the allowed direction — inventory is the base
// module and nothing in it reads back.
import { getReplenishments } from "@/modules/inventory/api";

/* ---------------------------------------------------------------------------
 * The Overview answers two questions only: what needs MY action (the
 * queue tiles, each opening its own pre-filtered worklist), and how is the
 * pipeline shaped right now (context strip + status breakdown). Everything
 * else is decoration and was removed.
 *
 * The tiles are navigation, never permission bypasses: they deep-link into the
 * same /indents list, whose rows and actions stay gated exactly as before.
 * ------------------------------------------------------------------------- */

type DashboardStats = Awaited<ReturnType<typeof indentApi.stats>>;

interface Queue {
  key: string;
  label: string;
  icon: ReactNode;
  /** Chip tint = the urgency colour the rest of the app already uses. */
  chip: string;
  value: (stats: DashboardStats | undefined) => number | undefined;
  /** Pre-filtered worklist the tile opens. Empty → opens the unfiltered list. */
  statuses?: string[];
}

const QUEUES: Queue[] = [
  {
    key: "awaiting_approval",
    label: "Awaiting approval",
    icon: <Clock className="h-5 w-5" />,
    chip: "bg-warn-bg text-warn",
    value: (stats) => stats?.awaiting_approval,
    statuses: ["PENDING_APPROVAL", "RETURNED_FOR_CORRECTION"],
  },
  {
    key: "approved_active",
    label: "Approved active",
    icon: <CheckCircle2 className="h-5 w-5" />,
    chip: "bg-ok-bg text-ok",
    value: (stats) => (
      stats ? stats.approved_active - (stats.by_status?.PARTIALLY_FULFILLED ?? 0) : undefined
    ),
    statuses: [
      "APPROVED",
      "AWAITING_ALLOCATION",
      "ALLOCATED",
      "PENDING_PROCUREMENT",
      "PARTIALLY_ORDERED",
      "ORDERED",
    ],
  },
  {
    key: "draft",
    label: "In draft",
    icon: <PencilLine className="h-5 w-5" />,
    chip: "bg-neutral-bg text-neutral",
    value: (stats) => stats?.draft,
    statuses: ["DRAFT"],
  },
  {
    key: "rejected",
    label: "Rejected",
    icon: <XCircle className="h-5 w-5" />,
    chip: "bg-bad-bg text-bad",
    value: (stats) => stats?.rejected,
    statuses: ["REJECTED"],
  },
  {
    key: "partially_fulfilled",
    label: "Partially fulfilled",
    icon: <PackageOpen className="h-5 w-5" />,
    chip: "bg-brand-050 text-brand",
    value: (stats) => stats?.by_status?.PARTIALLY_FULFILLED,
    statuses: ["PARTIALLY_FULFILLED"],
  },
  {
    key: "fulfilled",
    label: "Fulfilled",
    icon: <PackageCheck className="h-5 w-5" />,
    chip: "bg-brand-050 text-brand",
    value: (stats) => stats?.by_status?.CLOSED,
    statuses: ["CLOSED"],
  },
];

/** One tappable work queue: the number IS the button. */
function QueueTile({ queue, value, onOpen }: {
  queue: Queue;
  value: number | undefined;
  onOpen: (statuses?: string[]) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(queue.statuses)}
      aria-label={`${queue.label}: ${value ?? 0}. Show these indents`}
      className="group flex min-h-20 w-full items-center gap-3 rounded-xl border border-line/70 bg-content1 p-4 text-left shadow-sm transition duration-150 hover:-translate-y-px hover:border-brand/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 active:translate-y-0 active:scale-[0.99]"
    >
      <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${queue.chip}`}>
        {queue.icon}
      </span>
      <span className="min-w-0">
        <span className="block font-display text-[26px] font-bold leading-none tabular text-ink">
          {value ?? "–"}
        </span>
        <span className="mt-1 block truncate text-xs font-medium text-muted">{queue.label}</span>
      </span>
      <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-brand opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
    </button>
  );
}

/** Quiet context numbers under the queues. `to` builds the one deep-link that
 * is a date range rather than a status ("raised this month"). */
function ContextStat({ label, value, icon, onClick }: {
  label: string;
  value: ReactNode;
  icon: ReactNode;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <span className="text-muted/80">{icon}</span>
        {label}
      </span>
      <span className="mt-0.5 block text-lg font-bold tabular text-ink">{value}</span>
    </>
  );
  if (!onClick) return <div className="min-w-0 px-1 py-2 sm:px-4">{body}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-w-0 rounded-lg px-1 py-2 text-left transition hover:bg-content2 sm:px-4"
    >
      {body}
    </button>
  );
}

function IndentDashboardContent() {
  const nav = useNavigate();
  const accountScope = useIndentAccountScope();
  useIndentAccountCacheIsolation(accountScope);
  const {
    search,
    startDate,
    endDate,
    requiredByFrom,
    requiredByTo,
    selectedStatuses,
    selectedPriorities,
    selectedRegions,
    includeUnassignedRegion,
  } = useIndentFilters();
  const hasCompleteDateRange = Boolean(startDate && endDate);

  const filterParams = useMemo(() => normalizeIndentQueryParams({
    search,
    created_date_from: hasCompleteDateRange ? startDate : undefined,
    created_date_to: hasCompleteDateRange ? endDate : undefined,
    required_by_from: requiredByFrom,
    required_by_to: requiredByTo,
    status: selectedStatuses,
    priority: selectedPriorities,
    region_id: selectedRegions,
    region_unassigned: includeUnassignedRegion || undefined,
  }), [
    endDate,
    hasCompleteDateRange,
    includeUnassignedRegion,
    requiredByFrom,
    requiredByTo,
    search,
    selectedPriorities,
    selectedRegions,
    selectedStatuses,
    startDate,
  ]);

  const {
    data: stats,
    isLoading: statsLoading,
    error: statsError,
  } = useQuery({
    queryKey: indentKeys.stats(accountScope, filterParams),
    queryFn: ({ signal }) => indentApi.stats(filterParams, signal),
    placeholderData: (previousData) => previousData,
    staleTime: INDENT_QUERY_STALE_TIME,
    gcTime: INDENT_QUERY_GC_TIME,
  });

  const {
    data: recent,
    isLoading: recentLoading,
    error: recentError,
  } = useQuery({
    queryKey: indentKeys.recent(accountScope, filterParams),
    queryFn: ({ signal }) => indentApi.list({ ...filterParams, size: 8 }, signal),
    placeholderData: (previousData) => previousData,
    staleTime: INDENT_QUERY_STALE_TIME,
    gcTime: INDENT_QUERY_GC_TIME,
  });
  const recentIndents = recent?.items ?? [];

  // The shortage tile reads /api/stock/replenishment, which is guarded by
  // stock.view. Gate the QUERY on the same code, not just the button: a requester
  // without it would otherwise spend a 403 on every visit to their own Overview.
  const { can } = useAuth();
  const canSeeStock = can("stock.view");
  const { data: replenishments, isLoading: replenishmentsLoading } = useQuery({
    queryKey: ["indent-dashboard", "replenishment-low-stock"],
    queryFn: () => getReplenishments(),
    enabled: canSeeStock,
    staleTime: INDENT_QUERY_STALE_TIME,
    gcTime: INDENT_QUERY_GC_TIME,
  });
  const replenishmentLowStock = Array.isArray(replenishments)
    ? replenishments.length
    : undefined;

  const openQueue = (statuses?: string[]) => {
    if (!statuses?.length) {
      nav("/indents");
      return;
    }
    const params = new URLSearchParams();
    statuses.forEach((status) => params.append("status", status));
    nav(`/indents?${params.toString()}`);
  };
  const openThisMonth = () => {
    const range = getRaisedDateRange("this_month");
    if (!range.from || !range.to) {
      nav("/indents");
      return;
    }
    nav(`/indents?date_preset=this_month&date_from=${range.from}&date_to=${range.to}`);
  };

  return (
    <>
      <IndentModuleHeader
        title="Overview"
        statusFilterOptions={INDENT_REQUEST_STATUS_FILTER_OPTIONS}
        separateDateFilters
        regionFilterLabel="Department"
        searchPlaceholder="Search by indent no., requester, department or status..."
      />

      {/* Work queues first — this is what a person came here to do. */}
      <section aria-label="Work queues" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {QUEUES.map((queue) => (
          <QueueTile
            key={queue.key}
            queue={queue}
            value={queue.value(stats)}
            onOpen={openQueue}
          />
        ))}
        {canSeeStock && (
          <button
            type="button"
            onClick={() => nav("/inventory/replenishment")}
            aria-label={`${replenishmentLowStock ?? 0} low-stock replenishment items. Open replenishment`}
            className="group flex min-h-20 w-full items-center gap-3 rounded-xl border border-line/70 bg-content1 p-4 text-left shadow-sm transition duration-150 hover:-translate-y-px hover:border-brand/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 active:translate-y-0 active:scale-[0.99]"
          >
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-warn-bg text-warn">
              <TrendingDown className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block font-display text-[26px] font-bold leading-none tabular text-ink">
                {replenishmentsLoading ? "–" : replenishmentLowStock ?? "–"}
              </span>
              <span className="mt-1 block truncate text-xs font-medium text-muted">
                Replenishment low stock
              </span>
            </span>
            <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-brand opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
          </button>
        )}
      </section>

      {statsError && (
        <p role="alert" className="mt-3 rounded-xl border border-bad/30 bg-bad-bg px-4 py-3 text-sm text-bad">
          {statsError.message}
        </p>
      )}

      {/* Context strip: the totals that inform but need no decision. */}
      <Card className="mt-3 grid grid-cols-2 gap-y-1 px-3 py-2 sm:grid-cols-4 sm:gap-0 sm:divide-x sm:divide-line/60">
        <ContextStat
          label="Total indents"
          value={stats?.total ?? "–"}
          icon={<FileText className="h-3.5 w-3.5" />}
          onClick={() => nav("/indents")}
        />
        <ContextStat
          label="Raised this month"
          value={stats?.this_month ?? "–"}
          icon={<CalendarDays className="h-3.5 w-3.5" />}
          onClick={openThisMonth}
        />
        <ContextStat
          label="Units requested"
          value={stats?.total_qty ?? "–"}
          icon={<Package className="h-3.5 w-3.5" />}
        />
        <ContextStat
          label="Approval rate"
          value={stats ? `${stats.approval_rate}%` : "–"}
          icon={<Percent className="h-3.5 w-3.5" />}
        />
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted">STATUS BREAKDOWN</h2>
          {statsLoading && <p className="py-4 text-sm text-muted">Loading…</p>}
          {stats && (
            <StatusBreakdownChart
              byStatus={stats.by_status}
              selectedStatuses={selectedStatuses}
            />
          )}
        </Card>

        <Card className="p-5">
          <div className="mb-2 flex items-center justify-between gap-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted">Recent Indents</h3>
            <button
              type="button"
              onClick={() => nav("/indents")}
              className="shrink-0 cursor-pointer rounded text-sm font-semibold text-brand transition-colors hover:text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            >
              View all
            </button>
          </div>
          {recentError && <p className="py-4 text-sm text-bad">{recentError.message}</p>}
          {recentLoading && <p className="py-4 text-sm text-muted">Loading…</p>}
          <div className="divide-y divide-line/70">
            {recentIndents.slice(0, 7).map((indent) => (
              <button
                key={indent.id}
                type="button"
                onClick={() => nav(`/indents/${indent.id}`)}
                className="flex min-h-12 w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-content2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
              >
                <span className="min-w-0">
                  <span className="mono block truncate text-sm font-semibold text-ink">{indent.indent_no}</span>
                  <span className="block truncate text-xs text-muted">{indent.requested_by_name || indent.department_name || "Unknown"}</span>
                </span>
                <IndentSummaryStatusBadge
                  status={indent.status}
                  currentApproverName={indent.current_approver_name}
                />
              </button>
            ))}
            {!recentLoading && recent?.items.length === 0 && (
              <p className="py-6 text-center text-sm text-muted">Nothing here matches the filters.</p>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}

export function IndentDashboardPage() {
  return (
    <IndentFilterProvider>
      <IndentDashboardContent />
    </IndentFilterProvider>
  );
}
