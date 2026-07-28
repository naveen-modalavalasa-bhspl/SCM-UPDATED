import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ResponsiveList, StatusPill, type Column } from "@/shared/components";
import { indentApi, indentKeys, useIndentAccountCacheIsolation, useIndentAccountScope } from "../api";
import type { ActivityRow } from "../types";
import { IndentModuleHeader } from "../components/IndentModuleHeader";
import { IndentFilterProvider, useIndentFilters } from "../context/IndentFilterContext";
import { formatIndentDateTime } from "../dateTime";

function transactionLabel(type: string) {
  const labels: Record<string, string> = {
    RAISED: "Request raised",
    SUBMITTED: "Submitted",
    APPROVED: "Approved",
    REJECTED: "Rejected",
    RETURNED: "Returned",
    ACKNOWLEDGED: "Acknowledged",
  };
  return labels[type] ?? type.replace(/_/g, " ").toLowerCase();
}

function IndentReportsContent() {
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
    transactionType,
    direction,
    itemId,
    page,
    setPage,
  } = useIndentFilters();

  const size = 20;
  const hasCompleteDateRange = Boolean(startDate && endDate);
  const filters = useMemo(() => ({
    search: search || undefined,
    date_from: hasCompleteDateRange ? startDate : undefined,
    date_to: hasCompleteDateRange ? endDate : undefined,
    required_from: requiredByFrom || undefined,
    required_to: requiredByTo || undefined,
    status: selectedStatuses.length ? selectedStatuses : undefined,
    priority: selectedPriorities.length ? selectedPriorities : undefined,
    transaction_type: transactionType || undefined,
    direction: direction || undefined,
    item_id: itemId ? Number(itemId) : undefined,
    page,
    size,
  }), [
    direction,
    endDate,
    hasCompleteDateRange,
    itemId,
    page,
    requiredByFrom,
    requiredByTo,
    search,
    selectedPriorities,
    selectedStatuses,
    size,
    startDate,
    transactionType,
  ]);

  const { data, isLoading, error } = useQuery({
    queryKey: indentKeys.activity(accountScope, filters),
    queryFn: () => indentApi.activity(filters),
    placeholderData: (previousData) => previousData,
  });

  const columns: Column<ActivityRow>[] = [
    { key: "when", header: "When", render: (row) => <span className="text-muted">{formatIndentDateTime(row.event_at)}</span> },
    { key: "no", header: "Request", render: (row) => <span className="mono font-semibold text-ink">{row.indent_no}</span> },
    { key: "tx", header: "Transaction", render: (row) => transactionLabel(row.transaction_type) },
    { key: "item", header: "Item / action", render: (row) => row.item_name ?? row.actor_name ?? "Workflow action" },
    { key: "qty", header: "Qty", render: (row) => <span className="tabular-nums">{row.quantity ? `${row.quantity} ${row.uom_code ?? ""}` : "-"}</span> },
    { key: "dept", header: "Department", render: (row) => <span className="text-muted">{row.department_name ?? "-"}</span> },
    { key: "status", header: "Status", render: (row) => <StatusPill status={row.status} /> },
  ];

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / size));

  return (
    <>
      <IndentModuleHeader
        title="Activity ledger"
        showCreate={false}
        filterMode="activity"
        showTransaction
        showMovement
        showItem
      />

      {error && <p className="mb-4 rounded-lg border border-bad/30 bg-bad-bg px-4 py-3 text-sm text-bad">{error.message}</p>}
      <ResponsiveList
        data={data?.items ?? []}
        loading={isLoading}
        keyOf={(row) => row.event_id}
        onRowClick={(row) => nav(`/indents/${row.indent_id}`)}
        columns={columns}
        empty="No activity matches active filters."
        renderCard={(row) => (
          <div className="space-y-1 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="mono text-sm font-semibold text-ink">{row.indent_no}</span>
              <StatusPill status={row.status} />
            </div>
            <div className="text-muted">
              {transactionLabel(row.transaction_type)} - {row.item_name ?? row.actor_name ?? "Workflow action"}
            </div>
            <div className="flex justify-between gap-3 pt-1 text-muted">
              <span>{row.department_name ?? "-"}</span>
              <span className="tabular-nums">{formatIndentDateTime(row.event_at)}</span>
            </div>
          </div>
        )}
      />
      {data && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
          <span>Page {page} of {totalPages} ({data.total} total)</span>
          <span className="flex gap-2">
            <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded-lg border border-line px-3 py-1.5 font-medium text-body disabled:opacity-40">Previous</button>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="rounded-lg border border-line px-3 py-1.5 font-medium text-body disabled:opacity-40">Next</button>
          </span>
        </div>
      )}
    </>
  );
}

export function IndentReportsPage() {
  return (
    <IndentFilterProvider>
      <IndentReportsContent />
    </IndentFilterProvider>
  );
}
