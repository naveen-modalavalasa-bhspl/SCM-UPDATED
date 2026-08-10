import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, CheckCircle2, Clock, FileText, Package, PencilLine, XCircle } from "lucide-react";
import { Card, StatCard } from "@/shared/components";
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
import { IndentSummaryStatusBadge } from "../components/IndentSummaryStatusBadge";
import { StatusBreakdownChart } from "../components/StatusBreakdownChart";
import { IndentFilterProvider, useIndentFilters } from "../context/IndentFilterContext";
import { INDENT_REQUEST_STATUS_FILTER_OPTIONS } from "../constants";

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
    isFetching: statsFetching,
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
    isFetching: recentFetching,
    error: recentError,
  } = useQuery({
    queryKey: indentKeys.recent(accountScope, filterParams),
    queryFn: ({ signal }) => indentApi.list({ ...filterParams, size: 6 }, signal),
    placeholderData: (previousData) => previousData,
    staleTime: INDENT_QUERY_STALE_TIME,
    gcTime: INDENT_QUERY_GC_TIME,
  });
  const recentIndents = recent?.items ?? [];
  const isFetching = statsFetching || recentFetching;
  const isRefreshing = isFetching && Boolean(stats || recent);
  const handleViewAll = () => nav("/indents");

  return (
    <>
      <IndentModuleHeader
        title="Overview"
        statusFilterOptions={INDENT_REQUEST_STATUS_FILTER_OPTIONS}
        separateDateFilters
        searchPlaceholder="Search by indent no., requester, department or status..."
      />

      <section className="relative" aria-label="Overview results" aria-busy={isFetching}>
        <div
          role="status"
          aria-live="polite"
          className={`pointer-events-none absolute right-3 top-2 z-20 rounded-full bg-content1/95 px-2.5 py-1 text-xs font-medium text-muted shadow-sm transition-opacity duration-150 ${isRefreshing ? "opacity-100" : "opacity-0"}`}
        >
          {isRefreshing ? "Updating results…" : ""}
        </div>
        <div className={`transition-opacity duration-150 ${isRefreshing ? "opacity-70" : "opacity-100"}`}>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Total indents" tone="text-ink" icon={<FileText className="h-4 w-4" />} value={stats?.total ?? "-"} />
        <StatCard label="Awaiting approval" tone="text-warn" icon={<Clock className="h-4 w-4" />} value={stats?.awaiting_approval ?? "-"} />
        <StatCard label="Approved active" tone="text-ok" icon={<CheckCircle2 className="h-4 w-4" />} value={stats?.approved_active ?? "-"} />
        <StatCard label="Raised this month" tone="text-brand" icon={<CalendarDays className="h-4 w-4" />} value={stats?.this_month ?? "-"} />
        <StatCard label="In draft" tone="text-muted" icon={<PencilLine className="h-4 w-4" />} value={stats?.draft ?? "-"} />
        <StatCard label="Units requested" tone="text-info" icon={<Package className="h-4 w-4" />} value={stats?.total_qty ?? "-"} />
        <StatCard label="Rejected" tone="text-bad" icon={<XCircle className="h-4 w-4" />} value={stats?.rejected ?? "-"} />
        <StatCard label="Approval rate" tone="text-ok" icon={<CheckCircle2 className="h-4 w-4" />} value={stats ? `${stats.approval_rate}%` : "-"} />
      </div>

      {statsError && (
        <p className="mt-4 rounded-lg border border-bad/30 bg-bad-bg px-4 py-3 text-sm text-bad">
          {statsError.message}
        </p>
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="mb-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">STATUS BREAKDOWN</h2>
            <p className="mt-1 text-xs text-muted">Current distribution by workflow status</p>
          </div>
          {statsLoading && <p className="py-4 text-sm text-muted">Loading status breakdown...</p>}
          {stats && (
            <StatusBreakdownChart
              byStatus={stats.by_status}
              selectedStatuses={selectedStatuses}
            />
          )}
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between gap-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted">Recent Indents</h3>
            <button
              type="button"
              onClick={handleViewAll}
              className="shrink-0 cursor-pointer rounded text-sm font-semibold text-brand transition-colors hover:text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            >
              View all
            </button>
          </div>
          {recentError && <p className="py-4 text-sm text-bad">{recentError.message}</p>}
          {recentLoading && <p className="py-4 text-sm text-muted">Loading recent indents...</p>}
          <div className="divide-y divide-line/70">
            {recentIndents.slice(0, 5).map((indent) => (
              <button
                key={indent.id}
                type="button"
                onClick={() => nav(`/indents/${indent.id}`)}
                className="flex w-full items-center justify-between rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-content2"
              >
                <span>
                  <span className="mono block text-sm font-semibold text-ink">{indent.indent_no}</span>
                  <span className="text-xs text-muted">{indent.requested_by_name || indent.department_name || "Unknown"}</span>
                </span>
                <IndentSummaryStatusBadge status={indent.status} />
              </button>
            ))}
            {!recentLoading && recent?.items.length === 0 && (
              <p className="py-4 text-center text-sm text-muted">No indents match active filters.</p>
            )}
          </div>
        </Card>
      </div>
        </div>
      </section>
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
