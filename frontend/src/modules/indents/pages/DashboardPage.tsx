import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, CheckCircle2, Clock, FileText, Package, PencilLine, XCircle } from "lucide-react";
import { Card, StatCard, StatusPill } from "@/shared/components";
import { indentApi, indentKeys, useIndentAccountCacheIsolation, useIndentAccountScope } from "../api";
import { IndentModuleHeader } from "../components/IndentModuleHeader";
import { StatusBreakdownChart } from "../components/StatusBreakdownChart";
import { IndentFilterProvider, useIndentFilters } from "../context/IndentFilterContext";

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
    toggleStatus,
  } = useIndentFilters();
  const hasCompleteDateRange = Boolean(startDate && endDate);

  const filterParams = {
    search: search || undefined,
    created_date_from: hasCompleteDateRange ? startDate : undefined,
    created_date_to: hasCompleteDateRange ? endDate : undefined,
    required_by_from: requiredByFrom || undefined,
    required_by_to: requiredByTo || undefined,
    status: selectedStatuses.length ? selectedStatuses : undefined,
    priority: selectedPriorities.length ? selectedPriorities : undefined,
  };

  const {
    data: stats,
    isLoading: statsLoading,
    error: statsError,
  } = useQuery({
    queryKey: indentKeys.stats(accountScope, filterParams),
    queryFn: () => indentApi.stats(filterParams),
    placeholderData: (previousData) => previousData,
  });

  const {
    data: recent,
    isLoading: recentLoading,
    error: recentError,
  } = useQuery({
    queryKey: indentKeys.recent(accountScope, filterParams),
    queryFn: () => indentApi.list({ ...filterParams, size: 6 }),
    placeholderData: (previousData) => previousData,
  });
  const recentIndents = recent?.items ?? [];
  const handleViewAll = () => nav("/indents");

  return (
    <>
      <IndentModuleHeader title="Overview" />

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
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Status Breakdown</h2>
            <p className="mt-1 text-xs text-muted">Current distribution by workflow status</p>
          </div>
          {statsLoading && <p className="py-4 text-sm text-muted">Loading status breakdown...</p>}
          {stats && <StatusBreakdownChart byStatus={stats.by_status} onStatusClick={toggleStatus} />}
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between gap-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted">Recent Indents</h3>
            <button
              type="button"
              onClick={handleViewAll}
              className="shrink-0 rounded text-sm font-semibold text-brand transition-colors hover:text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
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
                <StatusPill status={indent.status} />
              </button>
            ))}
            {!recentLoading && recent?.items.length === 0 && (
              <p className="py-4 text-center text-sm text-muted">No indents match active filters.</p>
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
