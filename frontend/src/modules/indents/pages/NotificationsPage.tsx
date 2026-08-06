import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { Card } from "@/shared/components";
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
import { PaginatedResults, useAdjacentPagePrefetch } from "../components/PaginatedResults";
import { INDENT_REQUEST_STATUS_FILTER_OPTIONS } from "../constants";
import { IndentFilterValueProvider, useIndentFilters } from "../context/IndentFilterContext";
import {
  notificationsReturnState,
  readNotificationsScroll,
  saveNotificationsScroll,
  useNotificationsUrlState,
} from "../context/NotificationsUrlState";
import { formatIndentDateTime } from "../dateTime";

function IndentNotificationsContent({
  listUrl,
  size,
  replacePage,
}: {
  listUrl: string;
  size: number;
  replacePage: (page: number) => void;
}) {
  const nav = useNavigate();
  const accountScope = useIndentAccountScope();
  useIndentAccountCacheIsolation(accountScope);
  const { search, startDate, endDate, selectedStatuses, page, setPage } = useIndentFilters();
  const filters = useMemo(() => normalizeIndentQueryParams({
    search: search || undefined,
    date_from: startDate || undefined,
    date_to: endDate || undefined,
    status: selectedStatuses.length ? selectedStatuses : undefined,
    page,
    size,
  }), [endDate, page, search, selectedStatuses, size, startDate]);
  const { data, isLoading, isFetching, isPlaceholderData, error } = useQuery({
    queryKey: indentKeys.notifications(accountScope, filters),
    queryFn: ({ signal }) => indentApi.notifications(filters, signal),
    placeholderData: (previousData) => previousData,
    staleTime: INDENT_QUERY_STALE_TIME,
    gcTime: INDENT_QUERY_GC_TIME,
  });
  const rows = data?.items ?? [];
  const total = typeof data?.total === "number" && Number.isFinite(data.total)
    ? data.total
    : rows.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const prefetchSequenceKey = JSON.stringify([
    accountScope.employeeId,
    accountScope.activePositionId,
    { ...filters, page: null },
  ]);
  useAdjacentPagePrefetch({
    sequenceKey: prefetchSequenceKey,
    page,
    size,
    total,
    enabled: Boolean(data) && !isPlaceholderData && !error,
    queryKey: (adjacentPage) => indentKeys.notifications(accountScope, {
      ...filters,
      page: adjacentPage,
    }),
    queryFn: (adjacentPage, signal) => indentApi.notifications({
      ...filters,
      page: adjacentPage,
    }, signal),
    staleTime: INDENT_QUERY_STALE_TIME,
    gcTime: INDENT_QUERY_GC_TIME,
  });
  const restoredScroll = useRef(false);

  useLayoutEffect(() => {
    if (!data || page <= totalPages) return;
    replacePage(totalPages);
  }, [data, page, replacePage, totalPages]);

  useEffect(() => {
    if (!data || restoredScroll.current) return;
    restoredScroll.current = true;
    const scrollY = readNotificationsScroll(listUrl);
    if (scrollY === null) return;
    const frame = window.requestAnimationFrame(() => window.scrollTo(0, scrollY));
    return () => window.cancelAnimationFrame(frame);
  }, [data, listUrl]);

  useEffect(() => () => saveNotificationsScroll(listUrl), [listUrl]);

  const openIndent = useCallback((indentId: number) => {
    saveNotificationsScroll(listUrl);
    nav(`/indents/${indentId}`, { state: notificationsReturnState(listUrl) });
  }, [listUrl, nav]);

  return (
    <>
      <IndentModuleHeader
        title="Alert & Notification"
        showCreate={false}
        filterMode="notifications"
        statusFilterOptions={INDENT_REQUEST_STATUS_FILTER_OPTIONS}
        statusFilterLabel="Status"
        separateDateFilters
        showRequiredBy={false}
        showPriority={false}
        showTransaction={false}
        showMovement={false}
        showItem={false}
        searchPlaceholder="Search by indent no., title or message..."
      />
      <PaginatedResults
        ariaLabel="Notification results"
        isFetching={isFetching}
        hasData={Boolean(data)}
        pageKey={page}
        footer={data && (
          <div data-testid="notification-pagination-footer" className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
            <span>Page {page} of {totalPages} ({total} total)</span>
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
      >
          <Card className="divide-y divide-line">
            {isLoading && <p className="p-5 text-sm text-muted">Loading notifications…</p>}
            {rows.map((note) => (
              <button
                key={note.id}
                onClick={() => openIndent(note.indent_id)}
                className="flex w-full items-start gap-3 p-4 text-left hover:bg-content2"
              >
                <span className="rounded-full bg-info-bg p-2 text-info"><Bell className="h-4 w-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="text-sm text-ink">{note.title}</strong>
                    <IndentSummaryStatusBadge status={note.status} />
                  </span>
                  <span className="mt-1 block text-sm text-body">{note.message}</span>
                  <span className="mt-1 block text-xs text-muted">
                    {formatIndentDateTime(note.created_at)}
                  </span>
                </span>
              </button>
            ))}
            {!isLoading && rows.length === 0 && (
              <p className="p-8 text-center text-sm text-muted">No status notifications yet.</p>
            )}
          </Card>
      </PaginatedResults>
    </>
  );
}

export function IndentNotificationsPage() {
  const { filters, listUrl, replacePage, size } = useNotificationsUrlState();
  return (
    <IndentFilterValueProvider value={filters}>
      <IndentNotificationsContent
        listUrl={listUrl}
        size={size}
        replacePage={replacePage}
      />
    </IndentFilterValueProvider>
  );
}
