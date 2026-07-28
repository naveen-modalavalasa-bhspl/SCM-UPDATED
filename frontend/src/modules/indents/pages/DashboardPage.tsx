import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, CheckCircle2, Clock, FileText, Package, PencilLine, XCircle } from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Card, StatCard, StatusPill } from "@/shared/components";
import { indentApi, indentKeys, useIndentAccountCacheIsolation, useIndentAccountScope } from "../api";
import { IndentModuleHeader } from "../components/IndentModuleHeader";
import { IndentFilterProvider, useIndentFilters } from "../context/IndentFilterContext";

const BAR: Record<string, string> = {
  DRAFT: "bg-neutral",
  PENDING_APPROVAL: "bg-warn",
  SUBMITTED: "bg-warn",
  APPROVED: "bg-ok",
  AWAITING_ALLOCATION: "bg-info",
  ALLOCATED: "bg-info",
  PARTIALLY_FULFILLED: "bg-info",
  PENDING_PROCUREMENT: "bg-purple-500",
  ORDERED: "bg-blue-600",
  PARTIALLY_ORDERED: "bg-blue-600",
  REJECTED: "bg-bad",
  CLOSED: "bg-neutral",
};

const PIE: Record<string, string> = {
  DRAFT: "var(--color-neutral)",
  PENDING_APPROVAL: "var(--color-warn)",
  SUBMITTED: "var(--color-warn)",
  APPROVED: "var(--color-ok)",
  AWAITING_ALLOCATION: "var(--color-info)",
  ALLOCATED: "var(--color-info)",
  PARTIALLY_FULFILLED: "var(--color-info)",
  PENDING_PROCUREMENT: "#8b5cf6",
  ORDERED: "#2563eb",
  PARTIALLY_ORDERED: "#2563eb",
  REJECTED: "var(--color-bad)",
  CLOSED: "var(--color-neutral)",
};

function StatusBar({ by, onStatusClick }: { by: Record<string, number>; onStatusClick: (status: string) => void }) {
  const total = Object.values(by).reduce((sum, count) => sum + count, 0);
  if (!total) return <p className="text-sm text-muted">No indents match active filters.</p>;

  const entries = Object.entries(by)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  const chartData = entries.map(([status, count]) => ({
    status,
    count,
    name: status.replace(/_/g, " ").toLowerCase(),
  }));

  return (
    <div className="grid min-h-80 gap-5 md:grid-cols-[minmax(260px,1fr)_minmax(240px,0.85fr)]">
      <div className="relative min-h-72">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
            <Pie
              data={chartData}
              dataKey="count"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius="58%"
              outerRadius="86%"
              paddingAngle={2}
              stroke="#ffffff"
              strokeWidth={3}
              onClick={(entry) => onStatusClick(entry.status)}
              className="cursor-pointer outline-none"
            >
              {chartData.map((entry) => (
                <Cell
                  key={entry.status}
                  fill={PIE[entry.status] ?? "var(--color-neutral)"}
                  className="transition-opacity hover:opacity-85"
                />
              ))}
            </Pie>
            <Tooltip
              formatter={(value: number, _name, entry) => [
                `${value} (${Math.round((value / total) * 100)}%)`,
                String(entry.payload.name).replace(/\b\w/g, (char) => char.toUpperCase()),
              ]}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="text-center">
            <span className="block text-xs font-semibold uppercase text-muted">Total</span>
            <span className="mono text-4xl font-bold text-ink">{total}</span>
          </div>
        </div>
      </div>

      <div className="grid content-center gap-2">
        {entries.map(([status, count]) => (
          <button
            key={status}
            type="button"
            onClick={() => onStatusClick(status)}
            className="grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-muted transition-colors hover:bg-content2 hover:text-ink"
          >
            <span className={`h-2.5 w-2.5 rounded-full ${BAR[status] ?? "bg-neutral"}`} />
            <span className="capitalize">{status.replace(/_/g, " ").toLowerCase()}</span>
            <span className="font-semibold tabular-nums text-body">{count}</span>
          </button>
        ))}
      </div>
    </div>
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
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted">Status Breakdown</h2>
          {statsLoading && <p className="py-4 text-sm text-muted">Loading status breakdown...</p>}
          {stats && <StatusBar by={stats.by_status} onStatusClick={toggleStatus} />}
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted">Recent Indents</h2>
          {recentError && <p className="py-4 text-sm text-bad">{recentError.message}</p>}
          {recentLoading && <p className="py-4 text-sm text-muted">Loading recent indents...</p>}
          <div className="divide-y divide-line/70">
            {(recent?.items ?? []).map((indent) => (
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
