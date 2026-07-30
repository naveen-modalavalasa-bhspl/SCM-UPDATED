import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { Card } from "@/shared/components";
import { indentApi, indentKeys, useIndentAccountCacheIsolation, useIndentAccountScope } from "../api";
import type { AcknowledgmentRow } from "../types";
import { IndentModuleHeader } from "../components/IndentModuleHeader";
import { IndentFilterProvider, useIndentFilters } from "../context/IndentFilterContext";
import { formatIndentDateTime } from "../dateTime";

function actionLabel(row: AcknowledgmentRow) {
  return row.action.replace(/_/g, " ").toLowerCase();
}

function isFulfillmentAcknowledgment(row: AcknowledgmentRow) {
  const status = row.action.toUpperCase();
  return status === "FULFILLED" || status === "PARTIALLY_FULFILLED";
}

function IndentAcknowledgmentsContent() {
  const nav = useNavigate();
  const accountScope = useIndentAccountScope();
  useIndentAccountCacheIsolation(accountScope);
  const size = 20;
  const {
    search,
    startDate,
    endDate,
    requiredByFrom,
    requiredByTo,
    selectedStatuses,
    selectedPriorities,
    page,
    setPage,
  } = useIndentFilters();
  const hasCompleteDateRange = Boolean(startDate && endDate);

  const queryParams = useMemo(() => ({
    page,
    size,
    search: search || undefined,
    date_from: hasCompleteDateRange ? startDate : undefined,
    date_to: hasCompleteDateRange ? endDate : undefined,
    required_from: requiredByFrom || undefined,
    required_to: requiredByTo || undefined,
    status: selectedStatuses.length ? selectedStatuses : undefined,
    priority: selectedPriorities.length ? selectedPriorities : undefined,
  }), [endDate, hasCompleteDateRange, page, requiredByFrom, requiredByTo, search, selectedPriorities, selectedStatuses, size, startDate]);

  const { data, isLoading, error } = useQuery({
    queryKey: indentKeys.acknowledgments(accountScope, queryParams),
    queryFn: () => indentApi.acknowledgments(queryParams),
    placeholderData: (previousData) => previousData,
  });

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / size));
  const fulfillmentRows = (data?.items ?? []).filter(isFulfillmentAcknowledgment);

  return (
    <>
      <IndentModuleHeader title="Acknowledgments" showCreate={false} filterMode="acknowledgments" />

      {error && (
        <p className="mb-4 rounded-lg border border-bad/30 bg-bad-bg px-4 py-3 text-sm text-bad">
          {error.message}
        </p>
      )}

      <Card className="overflow-hidden rounded-2xl border border-line/70 bg-white shadow-sm">
        {isLoading && <p className="p-5 text-sm text-muted">Loading acknowledgments...</p>}

        {!isLoading && fulfillmentRows.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => nav(`/indents/${row.indent_id}`)}
            className="flex w-full items-center gap-4 border-b border-line/70 px-5 py-4 text-left last:border-b-0 hover:bg-content2/70"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ok-bg text-ok">
              <CheckCircle2 className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <strong className="mono block truncate text-sm font-bold text-ink">{row.indent_no}</strong>
              <span className="mt-1 block truncate text-sm text-body">
                {row.actor_name ?? "System"} {" · "} {actionLabel(row)}
              </span>
            </span>
            <time className="shrink-0 text-right text-xs tabular-nums text-muted" dateTime={row.acted_at}>
              {formatIndentDateTime(row.acted_at)}
            </time>
          </button>
        ))}

        {!isLoading && fulfillmentRows.length === 0 && (
          <p className="p-8 text-center text-sm text-muted">
            No fulfilment acknowledgments found
          </p>
        )}
      </Card>

      {data && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
          <span>Page {page} of {totalPages} ({data.total} total)</span>
          <span className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
              className="rounded-lg border border-line px-3 py-1.5 font-medium text-body disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
              className="rounded-lg border border-line px-3 py-1.5 font-medium text-body disabled:opacity-40"
            >
              Next
            </button>
          </span>
        </div>
      )}
    </>
  );
}

export function IndentAcknowledgmentsPage() {
  return (
    <IndentFilterProvider>
      <IndentAcknowledgmentsContent />
    </IndentFilterProvider>
  );
}
