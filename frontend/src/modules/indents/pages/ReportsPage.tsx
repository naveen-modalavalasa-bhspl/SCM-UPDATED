import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ResponsiveList, type Column } from "@/shared/components";
import {
  INDENT_QUERY_GC_TIME,
  INDENT_QUERY_STALE_TIME,
  indentApi,
  indentKeys,
  normalizeIndentQueryParams,
  useIndentAccountCacheIsolation,
  useIndentAccountScope,
} from "../api";
import type { ActivityRow } from "../types";
import { IndentModuleHeader } from "../components/IndentModuleHeader";
import { PaginatedResults, useAdjacentPagePrefetch } from "../components/PaginatedResults";
import { IndentFilterValueProvider, useIndentFilters } from "../context/IndentFilterContext";
import {
  activityLedgerReturnState,
  readActivityLedgerScroll,
  saveActivityLedgerScroll,
  useActivityLedgerUrlState,
} from "../context/ActivityLedgerUrlState";
import { formatIndentDateTime, parseIndentTimestamp } from "../dateTime";
import { INDENT_ACTIVITY_EVENT_FILTER_OPTIONS } from "../constants";

const EVENT_LABELS: Record<string, string> = {
  REQUEST_CREATED: "Request created",
  RAISED: "Request created",
  REQUEST_SUBMITTED: "Request submitted",
  SUBMITTED: "Request submitted",
  APPROVAL_COMPLETED: "Approval completed",
  APPROVED: "Approval completed",
  REQUEST_REJECTED: "Request rejected",
  REJECTED: "Request rejected",
  REQUEST_RETURNED: "Request returned",
  RETURNED: "Request returned",
  RETURNED_FOR_CORRECTION: "Returned for correction",
  APPROVAL_ROUTED_AUTOMATICALLY: "Approval routed automatically",
  FALLBACK: "Approval routed automatically",
  STOCK_ALLOCATED: "Stock allocated",
  PROCUREMENT_REQUEST_CREATED: "Procurement request created",
  BOOKMARK_ADDED: "Bookmark added",
  BOOKMARK_REMOVED: "Bookmark removed",
};

const RESULT_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  RETURNED: "Returned",
  RETURNED_FOR_CORRECTION: "Returned for correction",
  ROUTED_AUTOMATICALLY: "Routed Automatically",
  AWAITING_ALLOCATION: "Awaiting Allocation",
  ALLOCATED: "Allocated",
  PARTIALLY_ALLOCATED: "Partially Allocated",
  PARTIALLY_FULFILLED: "Partially Fulfilled",
  FULFILLED: "Fulfilled",
  CLOSED: "Fulfilled",
  PENDING_APPROVAL: "Pending Approval",
  BOOKMARKED: "Bookmarked",
  BOOKMARK_REMOVED: "Bookmark Removed",
};

const LEGACY_EVENT_RESULTS: Record<string, string> = {
  REQUEST_CREATED: "Draft",
  RAISED: "Draft",
  REQUEST_SUBMITTED: "Submitted",
  SUBMITTED: "Submitted",
  APPROVAL_COMPLETED: "Approved",
  APPROVED: "Approved",
  REQUEST_REJECTED: "Rejected",
  REJECTED: "Rejected",
  REQUEST_RETURNED: "Returned",
  RETURNED: "Returned",
  RETURNED_FOR_CORRECTION: "Returned for correction",
  APPROVAL_ROUTED_AUTOMATICALLY: "Routed Automatically",
  FALLBACK: "Routed Automatically",
  PROCUREMENT_REQUEST_CREATED: "Pending Approval",
  BOOKMARK_ADDED: "Bookmarked",
  BOOKMARK_REMOVED: "Bookmark Removed",
};

const RESULT_TONE: Record<string, string> = {
  DRAFT: "bg-neutral-bg text-neutral",
  SUBMITTED: "bg-info-bg text-info",
  APPROVED: "bg-ok-bg text-ok",
  REJECTED: "bg-bad-bg text-bad",
  RETURNED: "bg-warn-bg text-warn",
  RETURNED_FOR_CORRECTION: "bg-warn-bg text-warn",
  ROUTED_AUTOMATICALLY: "bg-info-bg text-info",
  AWAITING_ALLOCATION: "bg-info-bg text-info",
  ALLOCATED: "bg-purple-50 text-purple-600",
  PARTIALLY_ALLOCATED: "bg-warn-bg text-warn",
  PARTIALLY_FULFILLED: "bg-warn-bg text-warn",
  FULFILLED: "bg-ok-bg text-ok",
  PENDING_APPROVAL: "bg-warn-bg text-warn",
  BOOKMARKED: "bg-brand-050 text-brand",
  BOOKMARK_REMOVED: "bg-neutral-bg text-neutral",
  STATUS_UNAVAILABLE: "bg-neutral-bg text-neutral",
};

const HEADER_CURSOR_CLASS = "[&:is(th)]:cursor-default";
const ACTIVITY_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  month: "short",
  year: "numeric",
});
const ACTIVITY_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

function nonEmptyText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedCode(value: unknown) {
  const text = nonEmptyText(value);
  return text ? text.toUpperCase().replace(/[\s-]+/g, "_") : null;
}

function eventCode(row: ActivityRow) {
  return normalizedCode(row.event_type) ?? normalizedCode(row.transaction_type);
}

function eventLabel(row: ActivityRow) {
  const preferred = nonEmptyText(row.event_label);
  if (preferred && !/^[A-Z0-9_]+$/.test(preferred)) return preferred;
  const preferredCode = normalizedCode(preferred);
  const code = eventCode(row);
  return (
    (preferredCode ? EVENT_LABELS[preferredCode] : null)
    ?? (code ? EVENT_LABELS[code] : null)
    ?? "Activity event"
  );
}

function resultLabel(row: ActivityRow) {
  const preferred = nonEmptyText(row.result_label);
  const preferredCode = normalizedCode(preferred);
  if (preferredCode) return RESULT_LABELS[preferredCode] ?? "Status unavailable";
  const resultCode = normalizedCode(row.result);
  if (resultCode) return RESULT_LABELS[resultCode] ?? "Status unavailable";
  const code = eventCode(row);
  return (
    (code ? LEGACY_EVENT_RESULTS[code] : null)
    ?? "Status unavailable"
  );
}

function decimalText(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const sign = trimmed.startsWith("-") ? "-" : "";
  const unsigned = trimmed.replace(/^[+-]/, "");
  const [whole, fraction = ""] = unsigned.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = fraction.replace(/0+$/, "");
  const normalized = normalizedFraction
    ? `${normalizedWhole}.${normalizedFraction}`
    : normalizedWhole;
  return normalized === "0" ? "0" : `${sign}${normalized}`;
}

function formatQuantity(row: ActivityRow) {
  const quantity = decimalText(row.quantity);
  if (quantity === null) return "—";
  const requestedQuantity = decimalText(row.requested_quantity);
  const uomCode = nonEmptyText(row.uom_code);
  const uom = uomCode ? ` ${uomCode}` : "";
  if (
    eventCode(row) === "STOCK_ALLOCATED"
    && requestedQuantity !== null
    && Number(quantity) !== Number(requestedQuantity)
  ) {
    return `${quantity} of ${requestedQuantity}${uom}`;
  }
  return `${quantity}${uom}`;
}

function DetailCell({ row }: { row: ActivityRow }) {
  const itemName = nonEmptyText(row.item_name);
  const remarks = nonEmptyText(row.remarks) ?? nonEmptyText(row.comments);
  if (itemName) {
    const secondary = [
      nonEmptyText(row.item_code),
      eventCode(row) === "PROCUREMENT_REQUEST_CREATED"
        ? nonEmptyText(row.actor_position)
        : null,
    ].filter(Boolean).join(" · ");
    return (
      <div>
        <p className="text-body">{itemName}</p>
        {secondary && <p className="text-xs text-muted">{secondary}</p>}
        {remarks && <p className="text-xs text-muted">{remarks}</p>}
      </div>
    );
  }
  const code = eventCode(row);
  const actorName = (
    nonEmptyText(row.actor_name)
    ?? (code === "REQUEST_CREATED" || code === "RAISED"
      ? nonEmptyText(row.requested_by_name)
      : null)
    ?? (code === "APPROVAL_ROUTED_AUTOMATICALLY" || code === "FALLBACK"
      ? "System"
      : null)
  );
  const actorPosition = nonEmptyText(row.actor_position);
  const details = [actorName, actorPosition].filter(Boolean).join(" · ");
  return (
    <div>
      <p className="text-body">{details || "Details unavailable"}</p>
      {remarks && <p className="text-xs text-muted">{remarks}</p>}
    </div>
  );
}

function DepartmentCell({ row }: { row: ActivityRow }) {
  const departmentName = nonEmptyText(row.department_name);
  const officeName = nonEmptyText(row.office_name);
  return (
    <div>
      <p className="text-body">{departmentName ?? "—"}</p>
      {officeName && <p className="text-xs text-muted">{officeName}</p>}
    </div>
  );
}

function occurredAtLabel(row: ActivityRow) {
  const timestamp = nonEmptyText(row.occurred_at) ?? nonEmptyText(row.event_at);
  return timestamp ? (formatIndentDateTime(timestamp) ?? "Time unavailable") : "Time unavailable";
}

function ActivityResultBadge({ label }: { label: string }) {
  const code = normalizedCode(label) ?? "STATUS_UNAVAILABLE";
  const tone = RESULT_TONE[code] ?? "bg-neutral-bg text-neutral";
  return (
    <span className={`inline-flex h-6 items-center whitespace-nowrap rounded-full px-2 text-[11px] font-semibold uppercase tracking-wide ${tone}`}>
      {label}
    </span>
  );
}

function OccurredAtCell({ row }: { row: ActivityRow }) {
  const timestamp = nonEmptyText(row.occurred_at) ?? nonEmptyText(row.event_at);
  const parsed = parseIndentTimestamp(timestamp);
  if (!parsed) return <span className="text-muted">Time unavailable</span>;
  return (
    <span className="tabular-nums text-muted">
      <span className="block whitespace-nowrap">{ACTIVITY_DATE_FORMATTER.format(parsed)},</span>
      <span className="block whitespace-nowrap">{ACTIVITY_TIME_FORMATTER.format(parsed)}</span>
    </span>
  );
}

function requestLabel(row: ActivityRow) {
  return nonEmptyText(row.indent_no) ?? "Request unavailable";
}

function IndentReportsContent({
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
  const {
    search,
    startDate,
    endDate,
    selectedStatuses,
    page,
    setPage,
  } = useIndentFilters();

  const filters = useMemo(() => normalizeIndentQueryParams({
    search: search || undefined,
    date_from: startDate || undefined,
    date_to: endDate || undefined,
    transaction_type: selectedStatuses[0] || undefined,
    page,
    size,
  }), [
    endDate,
    page,
    search,
    selectedStatuses,
    size,
    startDate,
  ]);

  const {
    data,
    isLoading,
    isFetching,
    isPlaceholderData,
    error,
    refetch,
  } = useQuery({
    queryKey: indentKeys.activity(accountScope, filters),
    queryFn: ({ signal }) => indentApi.activity(filters, signal),
    placeholderData: (previousData) => previousData,
    staleTime: INDENT_QUERY_STALE_TIME,
    gcTime: INDENT_QUERY_GC_TIME,
  });

  const rows = Array.isArray(data?.items) ? data.items : [];
  const restoredScroll = useRef(false);
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
    queryKey: (adjacentPage) => indentKeys.activity(accountScope, {
      ...filters,
      page: adjacentPage,
    }),
    queryFn: (adjacentPage, signal) => indentApi.activity({
      ...filters,
      page: adjacentPage,
    }, signal),
    staleTime: INDENT_QUERY_STALE_TIME,
    gcTime: INDENT_QUERY_GC_TIME,
  });

  useLayoutEffect(() => {
    if (!data || page <= totalPages) return;
    replacePage(totalPages);
  }, [data, page, replacePage, totalPages]);

  useEffect(() => {
    if (!data || restoredScroll.current) return;
    restoredScroll.current = true;
    const scrollY = readActivityLedgerScroll(listUrl);
    if (scrollY === null) return;
    const frame = window.requestAnimationFrame(() => window.scrollTo(0, scrollY));
    return () => window.cancelAnimationFrame(frame);
  }, [data, listUrl]);

  useEffect(() => () => saveActivityLedgerScroll(listUrl), [listUrl]);

  const openIndent = useCallback((indentId: number) => {
    saveActivityLedgerScroll(listUrl);
    nav(`/indents/${indentId}`, { state: activityLedgerReturnState(listUrl) });
  }, [listUrl, nav]);

  const columns: Column<ActivityRow>[] = [
    { key: "when", header: "WHEN", className: `${HEADER_CURSOR_CLASS} w-40 min-w-40`, render: (row) => <OccurredAtCell row={row} /> },
    { key: "no", header: "REQUEST", className: HEADER_CURSOR_CLASS, render: (row) => <span className="mono font-semibold text-ink">{requestLabel(row)}</span> },
    { key: "event", header: "EVENT", className: HEADER_CURSOR_CLASS, render: (row) => eventLabel(row) },
    { key: "details", header: "DETAILS", className: HEADER_CURSOR_CLASS, render: (row) => <DetailCell row={row} /> },
    { key: "qty", header: "QTY", className: HEADER_CURSOR_CLASS, render: (row) => <span className="tabular-nums">{formatQuantity(row)}</span> },
    { key: "dept", header: "DEPARTMENT", className: HEADER_CURSOR_CLASS, render: (row) => <DepartmentCell row={row} /> },
    { key: "result", header: "RESULT", className: HEADER_CURSOR_CLASS, render: (row) => <ActivityResultBadge label={resultLabel(row)} /> },
  ];

  const hasBlockingError = Boolean(error && !data);

  return (
    <>
      <IndentModuleHeader
        title="Activity ledger"
        showCreate={false}
        filterMode="activity"
        statusFilterOptions={INDENT_ACTIVITY_EVENT_FILTER_OPTIONS}
        statusFilterLabel="Event"
        singleStatusSelection
        separateDateFilters
        showRequiredBy={false}
        showPriority={false}
        showTransaction={false}
        showMovement={false}
        showItem={false}
        searchPlaceholder="Search by indent no., event, actor, department or result..."
      />

      <PaginatedResults
        ariaLabel="Activity ledger results"
        isFetching={isFetching}
        hasData={Boolean(data)}
        pageKey={page}
        footer={data && (
          <div data-testid="activity-pagination-footer" className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
            <span>Page {page} of {totalPages} ({total} total)</span>
            <span className="flex gap-2">
              <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded-lg border border-line px-3 py-1.5 font-medium text-body disabled:opacity-40">Previous</button>
              <button type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="rounded-lg border border-line px-3 py-1.5 font-medium text-body disabled:opacity-40">Next</button>
            </span>
          </div>
        )}
      >
          {error && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-bad/30 bg-bad-bg px-4 py-3">
              <p className="text-sm font-medium text-bad">Unable to load activity ledger</p>
              <button
                type="button"
                disabled={isFetching}
                onClick={() => void refetch()}
                className="rounded-lg border border-bad/30 px-3 py-1.5 text-sm font-semibold text-bad disabled:opacity-50"
              >
                Retry
              </button>
            </div>
          )}
          {!hasBlockingError && (
            <div className="[&_th]:cursor-default [&_th]:select-none">
              <ResponsiveList
                data={rows}
                loading={isLoading}
                keyOf={(row) => row.event_id}
                onRowClick={(row) => openIndent(row.indent_id)}
                columns={columns}
                empty="No activity matches active filters."
                renderCard={(row) => (
                  <div className="space-y-1 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <span className="mono text-sm font-semibold text-ink">{requestLabel(row)}</span>
                      <ActivityResultBadge label={resultLabel(row)} />
                    </div>
                    <p className="font-medium text-body">{eventLabel(row)}</p>
                    <DetailCell row={row} />
                    <p className="tabular-nums text-body">{formatQuantity(row)}</p>
                    <div className="flex justify-between gap-3 pt-1 text-muted">
                      <DepartmentCell row={row} />
                      <span className="tabular-nums">{occurredAtLabel(row)}</span>
                    </div>
                  </div>
                )}
              />
            </div>
          )}
      </PaginatedResults>
    </>
  );
}

export function IndentReportsPage() {
  const { filters, listUrl, replacePage, size } = useActivityLedgerUrlState();
  return (
    <IndentFilterValueProvider value={filters}>
      <IndentReportsContent listUrl={listUrl} size={size} replacePage={replacePage} />
    </IndentFilterValueProvider>
  );
}
