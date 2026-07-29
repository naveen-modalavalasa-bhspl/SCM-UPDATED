import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import { ClipboardList, Loader2, Pin } from "lucide-react";
import type { Paginated } from "@/shared/types";
import {
  INDENT_QUERY_ROOT,
  indentApi,
  indentKeys,
  type IndentAccountScope,
  useIndentAccountCacheIsolation,
  useIndentAccountScope,
} from "../api";
import type { IndentListRow, IndentStats } from "../types";
import { IndentModuleHeader } from "../components/IndentModuleHeader";
import { IndentFilterProvider, useIndentFilters } from "../context/IndentFilterContext";
import { INDENT_STATUS } from "../constants";

const COLUMNS: { title: string; statuses: string[]; dot: string }[] = [
  { title: "Draft", statuses: [INDENT_STATUS.DRAFT], dot: "bg-neutral" },
  { title: "In approval", statuses: [INDENT_STATUS.PENDING_APPROVAL, INDENT_STATUS.SUBMITTED], dot: "bg-warn" },
  { title: "Approved", statuses: [INDENT_STATUS.APPROVED, INDENT_STATUS.AWAITING_ALLOCATION, INDENT_STATUS.ALLOCATED, INDENT_STATUS.PARTIALLY_FULFILLED], dot: "bg-ok" },
  { title: "Ordered", statuses: [INDENT_STATUS.ORDERED, INDENT_STATUS.PARTIALLY_ORDERED, INDENT_STATUS.PENDING_PROCUREMENT], dot: "bg-info" },
  { title: "Rejected", statuses: [INDENT_STATUS.REJECTED], dot: "bg-bad" },
  { title: "Closed", statuses: [INDENT_STATUS.CLOSED], dot: "bg-neutral" },
];

const BOARD_PREVIEW_SIZE = 50;
const UNPIN_ANIMATION_MS = 200;

function waitForUnpinAnimation() {
  return new Promise((resolve) => window.setTimeout(resolve, UNPIN_ANIMATION_MS));
}

function formatStatus(status: string) {
  return status
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isScopedIndentQuery(query: Query, scope: IndentAccountScope, area: "list" | "board") {
  return (
    query.queryKey[0] === INDENT_QUERY_ROOT
    && query.queryKey[1] === scope.employeeId
    && query.queryKey[2] === scope.activePositionId
    && query.queryKey[3] === area
  );
}

function isScopedBoardStatsQuery(query: Query, scope: IndentAccountScope) {
  return (
    query.queryKey[0] === INDENT_QUERY_ROOT
    && query.queryKey[1] === scope.employeeId
    && query.queryKey[2] === scope.activePositionId
    && query.queryKey[3] === "stats"
    && Array.isArray(query.queryKey[4])
    && query.queryKey[4][0] === "board"
  );
}

function markListRowsUnpinned(data: Paginated<IndentListRow> | undefined, rowId: number) {
  if (!data) return data;
  return {
    ...data,
    items: data.items.map((item) =>
      item.id === rowId ? { ...item, is_bookmarked: "NO" } : item
    ),
  };
}

function removeBoardRow(data: Paginated<IndentListRow> | undefined, rowId: number) {
  if (!data) return data;
  const exists = data.items.some((item) => item.id === rowId);
  return {
    ...data,
    items: data.items.filter((item) => item.id !== rowId),
    total: exists ? Math.max(0, data.total - 1) : data.total,
  };
}

function decrementBoardStats(data: IndentStats | undefined, row: IndentListRow) {
  if (!data) return data;
  return {
    ...data,
    total: Math.max(0, data.total - 1),
    total_items: Math.max(0, data.total_items - row.total_items),
    by_status: {
      ...data.by_status,
      [row.status]: Math.max(0, (data.by_status?.[row.status] ?? 0) - 1),
    },
  };
}

function IndentBoardContent() {
  const nav = useNavigate();
  const accountScope = useIndentAccountScope();
  useIndentAccountCacheIsolation(accountScope);
  const qc = useQueryClient();
  const [bookmarkError, setBookmarkError] = useState("");
  const [removingIds, setRemovingIds] = useState<Record<number, boolean>>({});
  const {
    search,
    startDate,
    endDate,
    requiredByFrom,
    requiredByTo,
    selectedStatuses,
    selectedPriorities,
    selectedDepartments,
    sortBy,
    sortDir,
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
    department_id: selectedDepartments.length ? selectedDepartments : undefined,
    sort_by: sortBy,
    sort_dir: sortDir,
    is_bookmarked: "YES",
    size: BOARD_PREVIEW_SIZE,
  };

  const { data, isLoading, error } = useQuery({
    queryKey: indentKeys.board(accountScope, filterParams),
    queryFn: () => indentApi.list(filterParams),
    placeholderData: (previousData) => previousData,
  });
  const statsParams = { ...filterParams, page: undefined, size: undefined };
  const { data: stats } = useQuery({
    queryKey: indentKeys.stats(accountScope, ["board", statsParams]),
    queryFn: () => indentApi.stats(statsParams),
    placeholderData: (previousData) => previousData,
  });

  const rows = data?.items ?? [];
  const bucket = (statuses: string[]) => rows.filter((row) => statuses.includes(row.status));
  const columnTotal = (statuses: string[]) =>
    statuses.reduce((sum, status) => sum + (stats?.by_status?.[status] ?? 0), 0);
  const remaining = Math.max(0, (data?.total ?? 0) - rows.length);
  const boardTotal = stats?.total ?? data?.total ?? 0;

  const unpin = useMutation({
    mutationFn: async (row: IndentListRow) => {
      const [updated] = await Promise.all([indentApi.unbookmark(row.id), waitForUnpinAnimation()]);
      return updated;
    },
    onMutate: (row) => {
      setBookmarkError("");
      setRemovingIds((current) => ({ ...current, [row.id]: true }));
    },
    onSuccess: (_updated, row) => {
      qc.getQueriesData<Paginated<IndentListRow>>({
        predicate: (query) => isScopedIndentQuery(query, accountScope, "list"),
      }).forEach(([key, value]) => qc.setQueryData(key, markListRowsUnpinned(value, row.id)));
      qc.getQueriesData<Paginated<IndentListRow>>({
        predicate: (query) => isScopedIndentQuery(query, accountScope, "board"),
      }).forEach(([key, value]) => qc.setQueryData(key, removeBoardRow(value, row.id)));
      qc.getQueriesData<IndentStats>({
        predicate: (query) => isScopedBoardStatsQuery(query, accountScope),
      }).forEach(([key, value]) => qc.setQueryData(key, decrementBoardStats(value, row)));
    },
    onError: (_error, row) => {
      setRemovingIds((current) => {
        const next = { ...current };
        delete next[row.id];
        return next;
      });
      setBookmarkError("Could not update board bookmark. Please try again.");
    },
    onSettled: (_data, error, row) => {
      if (!error) {
        setRemovingIds((current) => {
          const next = { ...current };
          delete next[row.id];
          return next;
        });
      }
    },
  });

  const openIndent = (id: number) => nav(`/indents/${id}`);

  return (
    <>
      <IndentModuleHeader title="Board" showCreate={false} />

      {bookmarkError && <p className="mb-4 rounded-lg border border-bad/30 bg-bad-bg px-4 py-3 text-sm text-bad">{bookmarkError}</p>}
      {isLoading && <p className="py-12 text-center text-sm text-muted">Loading board...</p>}
      {error && <p className="mb-4 rounded-lg border border-bad/30 bg-bad-bg px-4 py-3 text-sm text-bad">{error.message}</p>}
      {!isLoading && !error && remaining > 0 && (
        <p className="mb-4 rounded-lg border border-line bg-content2 px-4 py-3 text-sm text-muted">
          Showing the first {rows.length} matching requests on the board. Column counts include all {data?.total ?? 0} matching requests.
        </p>
      )}
      {!isLoading && !error && boardTotal === 0 && (
        <p className="mb-4 rounded-lg border border-line bg-content1 px-4 py-3 text-sm text-muted shadow-sm">
          No pinned requests on this Board yet. Pin a request from All requests.
        </p>
      )}

      {!isLoading && !error && (
        <div className="-mx-4 overflow-x-auto overflow-y-hidden px-4 pb-3 md:mx-0 md:px-0">
          <div className="flex min-w-max gap-4 md:grid md:min-w-0 md:grid-cols-6">
            {COLUMNS.map((column) => {
              const items = bucket(column.statuses);
              const total = columnTotal(column.statuses);
              return (
                <section
                  key={column.title}
                  className="flex min-h-[26rem] w-80 shrink-0 flex-col rounded-lg border border-line bg-content1 p-3 shadow-sm md:w-auto"
                >
                  <div className="mb-3 flex items-center justify-between">
                    <span className="flex items-center gap-2 text-sm font-semibold text-body">
                      <span className={`h-2.5 w-2.5 rounded-full ${column.dot}`} />
                      {column.title}
                    </span>
                    <span className="grid h-6 min-w-6 place-items-center rounded-full bg-content2 px-2 text-xs font-bold tabular-nums text-muted">
                      {total}
                    </span>
                  </div>

                  <div className="flex min-h-72 flex-1 flex-col gap-3">
                    {total === 0 && (
                      <div className="grid min-h-52 flex-1 place-items-center rounded-lg border border-dashed border-line bg-white/70 px-4 text-center">
                        <div>
                          <span className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-content2 text-muted">
                            <ClipboardList className="h-5 w-5" aria-hidden="true" />
                          </span>
                          <p className="text-sm font-semibold text-body">No pinned requests</p>
                          <p className="mt-1 text-xs text-muted">Pin a request from All requests</p>
                        </div>
                      </div>
                    )}
                    {items.map((row: IndentListRow) => (
                      <div
                        key={row.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => openIndent(row.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            openIndent(row.id);
                          }
                        }}
                        data-removing={removingIds[row.id] ? "true" : "false"}
                        className="group relative flex min-h-36 w-full flex-col rounded-lg border border-line/80 bg-white p-4 text-left shadow-sm outline-none transition duration-200 ease-out hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-md focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/25 data-[removing=true]:scale-[0.98] data-[removing=true]:opacity-45"
                      >
                        <div className="flex items-start gap-3 pr-10">
                          <div className="min-w-0 flex-1">
                            <p className="mono break-words text-sm font-bold leading-5 text-gray-950">{row.indent_no}</p>
                            <p className="mt-2 break-words text-sm font-medium leading-5 text-gray-700">
                              {row.requested_by_name ?? "Unknown requester"}
                            </p>
                          </div>
                        </div>
                        <button
                          type="button"
                          aria-label="Remove from Board"
                          aria-pressed="true"
                          title="Remove from Board"
                          disabled={removingIds[row.id] || unpin.isPending}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (!removingIds[row.id]) unpin.mutate(row);
                          }}
                          className="absolute right-3 top-3 grid h-10 w-10 place-items-center rounded-full border border-brand bg-brand/10 text-brand shadow-sm transition hover:bg-brand/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:cursor-wait disabled:opacity-70"
                        >
                          {removingIds[row.id] ? (
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          ) : (
                            <Pin className="h-4 w-4" fill="currentColor" aria-hidden="true" />
                          )}
                        </button>
                        <div className="mt-3 min-w-0 flex-1">
                          <p className="truncate text-xs font-medium uppercase tracking-wide text-muted">
                            {row.department_name ?? "No department"}
                          </p>
                        </div>
                        <div className="mt-4 flex items-center justify-between gap-3">
                          <span className="text-xs font-medium tabular-nums text-gray-500">
                            {row.total_items} {row.total_items === 1 ? "line" : "lines"}
                          </span>
                          {column.statuses.length > 1 && (
                            <span className="max-w-36 truncate rounded-full border border-line bg-content2 px-2.5 py-1 text-xs font-semibold text-muted">
                              {formatStatus(row.status)}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                    {items.length < total && (
                      <p className="rounded-lg border border-line bg-content2 px-3 py-2 text-xs text-muted">
                        Showing {items.length} of {total}. Refine filters or open All requests for paging.
                      </p>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

export function IndentBoardPage() {
  return (
    <IndentFilterProvider>
      <IndentBoardContent />
    </IndentFilterProvider>
  );
}
