import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Bell, CheckCheck } from "lucide-react";
import { Button, Card, EmptyState, SubNav } from "@/shared/components";
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
  readNotificationsTab,
  saveNotificationsScroll,
  saveNotificationsTab,
  useNotificationsUrlState,
  type NotificationsTab,
} from "../context/NotificationsUrlState";
import { formatIndentDateTime } from "../dateTime";
import { useIndentNotificationReads } from "../notificationReads";
import type { IndentNotification } from "../types";
import { NOTIFICATION_SUBNAV_PASTEL, TONE_BLUE } from "../buttonTones";

/**
 * Alert & Notification.
 *
 * Read/unread is a client-side flag (see `notificationReads.ts`) because the rows are
 * derived from the indents and there is nothing server-side to mark. That leaves two
 * ways to fill a page of 20:
 *
 *  - **Everything**, and **Unread** before anything has ever been read, are the same
 *    list, so the server pages them 20 at a time exactly as before.
 *  - Once something is read, unread rows are the list minus holes, so pages are filled
 *    from a stream of chunks. It stops as soon as it reaches the "mark all read"
 *    watermark: the list is newest-first, so everything past that point is read.
 */

const TABS = [
  { key: "unread", label: "Unread" },
  { key: "all", label: "Everything" },
];

const UNREAD_CHUNK_SIZE = 20;
// A stop for a list nobody could page through anyway, so a stale watermark on a huge
// account cannot turn one tab into hundreds of requests.
const MAX_UNREAD_CHUNKS = 25;

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
  const [tab, setTab] = useState<NotificationsTab>(readNotificationsTab);
  const reads = useIndentNotificationReads(accountScope.employeeId);
  // Before anything is read the two tabs hold the same rows, so the plain server
  // pagination is already correct and nothing has to be streamed.
  const streamed = tab === "unread" && reads.hasReadState;

  const baseFilters = useMemo(() => normalizeIndentQueryParams({
    search: search || undefined,
    date_from: startDate || undefined,
    date_to: endDate || undefined,
    status: selectedStatuses.length ? selectedStatuses : undefined,
  }), [endDate, search, selectedStatuses, startDate]);
  const filters = useMemo(
    () => ({ ...baseFilters, page, size }),
    [baseFilters, page, size],
  );

  const { data, isLoading, isFetching, isPlaceholderData, error } = useQuery({
    queryKey: indentKeys.notifications(accountScope, filters),
    queryFn: ({ signal }) => indentApi.notifications(filters, signal),
    placeholderData: (previousData) => previousData,
    staleTime: INDENT_QUERY_STALE_TIME,
    gcTime: INDENT_QUERY_GC_TIME,
    enabled: !streamed,
  });

  const stream = useInfiniteQuery({
    queryKey: indentKeys.notifications(accountScope, { ...baseFilters, view: "unread-stream" }),
    queryFn: ({ pageParam, signal }) => indentApi.notifications(
      { ...baseFilters, page: pageParam, size: UNREAD_CHUNK_SIZE },
      signal,
    ),
    initialPageParam: 1,
    getNextPageParam: (lastChunk, chunks) => {
      const loaded = chunks.reduce((count, chunk) => count + chunk.items.length, 0);
      if (lastChunk.items.length === 0 || loaded >= lastChunk.total) return undefined;
      return chunks.length + 1;
    },
    staleTime: INDENT_QUERY_STALE_TIME,
    gcTime: INDENT_QUERY_GC_TIME,
    enabled: streamed,
  });

  // A row can shift between chunk requests, so the same id can arrive twice.
  const streamedRows = useMemo(() => {
    const seen = new Map<string, IndentNotification>();
    (stream.data?.pages ?? []).forEach((chunk) => {
      chunk.items.forEach((note) => {
        if (!seen.has(note.id)) seen.set(note.id, note);
      });
    });
    return [...seen.values()];
  }, [stream.data]);
  const unreadRows = useMemo(
    () => streamedRows.filter((note) => !reads.isRead(note)),
    [reads, streamedRows],
  );
  const chunkCount = stream.data?.pages.length ?? 0;
  // Newest-first ordering: once a row sits at or below the watermark, so does the rest.
  const reachedReadRows = streamedRows.length > unreadRows.length
    && reads.isRead(streamedRows[streamedRows.length - 1]);
  const streamComplete = streamed
    && (!stream.hasNextPage || reachedReadRows || chunkCount >= MAX_UNREAD_CHUNKS);

  const serverRows = data?.items ?? [];
  const rows = streamed
    ? unreadRows.slice((page - 1) * size, page * size)
    : serverRows;
  const total = streamed
    ? unreadRows.length
    : typeof data?.total === "number" && Number.isFinite(data.total)
      ? data.total
      : serverRows.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const moreToCount = streamed && !streamComplete;
  const isBusy = streamed ? stream.isFetching : isFetching;
  const hasData = streamed ? Boolean(stream.data) : Boolean(data);
  const showLoading = streamed ? stream.isLoading : isLoading;
  const unreadOnPage = rows.filter((note) => !reads.isRead(note)).length;

  // Page 3 of unread needs 60 unread rows; keep pulling chunks until it has them.
  const { fetchNextPage: fetchNextChunk } = stream;
  useEffect(() => {
    if (!streamed || streamComplete || isBusy) return;
    if (unreadRows.length > page * size) return;
    void fetchNextChunk();
  }, [fetchNextChunk, isBusy, page, size, streamComplete, streamed, unreadRows.length]);

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
    enabled: !streamed && Boolean(data) && !isPlaceholderData && !error,
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
    if (streamed) {
      // Only clamp once the count has settled, or it would fight the chunk loader.
      if (!streamComplete || page <= totalPages) return;
      replacePage(totalPages);
      return;
    }
    if (!data || page <= totalPages) return;
    replacePage(totalPages);
  }, [data, page, replacePage, streamComplete, streamed, totalPages]);

  useEffect(() => {
    if (!hasData || restoredScroll.current) return;
    restoredScroll.current = true;
    const scrollY = readNotificationsScroll(listUrl);
    if (scrollY === null) return;
    const frame = window.requestAnimationFrame(() => window.scrollTo(0, scrollY));
    return () => window.cancelAnimationFrame(frame);
  }, [hasData, listUrl]);

  useEffect(() => () => saveNotificationsScroll(listUrl), [listUrl]);

  const changeTab = useCallback((next: string) => {
    const value: NotificationsTab = next === "all" ? "all" : "unread";
    setTab(value);
    saveNotificationsTab(value);
    setPage(1);
  }, [setPage]);

  const openNotification = useCallback((note: IndentNotification) => {
    reads.markRead(note.id);
    saveNotificationsScroll(listUrl);
    nav(`/indents/${note.indent_id}`, { state: notificationsReturnState(listUrl) });
  }, [listUrl, nav, reads]);

  return (
    <>
      <IndentModuleHeader
        title="Alert & Notification"
        showCreate={false}
        actions={unreadOnPage > 0 ? (
          <Button className={TONE_BLUE} onClick={reads.markAllRead}>
            <CheckCheck className="h-4 w-4" /> Mark all read
          </Button>
        ) : undefined}
        subNav={<SubNav label="Notifications" items={TABS} value={tab} onChange={changeTab}
                        className={NOTIFICATION_SUBNAV_PASTEL} />}
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
        isFetching={isBusy}
        hasData={hasData}
        pageKey={page}
        footer={hasData && (rows.length > 0 || page > 1) && (
          <div data-testid="notification-pagination-footer" className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
            <span>
              {`Page ${page} of ${totalPages}${moreToCount ? "+" : ""}`
                + ` (${total}${moreToCount ? "+" : ""} total)`}
            </span>
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
                disabled={page >= totalPages && !moreToCount}
                onClick={() => setPage(page + 1)}
                className="rounded-lg border border-line px-3 py-1.5 font-medium text-body disabled:opacity-40"
              >
                Next
              </button>
            </span>
          </div>
        )}
      >
        {showLoading ? (
          <Card><p className="p-5 text-sm text-muted">Loading notifications…</p></Card>
        ) : rows.length === 0 ? (
          <EmptyState
            title={tab === "unread" ? "Nothing unread" : "No notifications"}
            hint="Approvals, allocations and orders raise a notification as your requests move."
          />
        ) : (
          <ul className="space-y-2">
            {rows.map((note) => {
              const isRead = reads.isRead(note);
              return (
                <li key={note.id}>
                  <button
                    type="button"
                    onClick={() => openNotification(note)}
                    className="block w-full text-left"
                  >
                    <Card className={`p-4 transition-colors ${isRead ? "" : "border-brand/40 bg-brand-050/40"}`}>
                      <div className="flex items-start gap-3">
                        <span className={`rounded-full p-2 ${isRead ? "bg-content2 text-muted" : "bg-info-bg text-info"}`}>
                          <Bell className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className={`text-sm ${isRead ? "font-medium text-body" : "font-semibold text-ink"}`}>
                              {note.title}
                            </span>
                            <IndentSummaryStatusBadge status={note.status} />
                          </div>
                          <p className="mt-1 text-sm text-body">{note.message}</p>
                          <p className="mt-1 text-xs text-muted">
                            {formatIndentDateTime(note.created_at)}
                          </p>
                        </div>
                        {!isRead && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" />}
                      </div>
                    </Card>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
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
