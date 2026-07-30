import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ResponsiveList, StatusPill, type Column } from "@/shared/components";
import { indentApi, indentKeys, useIndentAccountCacheIsolation, useIndentAccountScope } from "../api";
import type { ActivityRow } from "../types";
import { IndentModuleHeader } from "../components/IndentModuleHeader";
import { IndentFilterProvider, useIndentFilters } from "../context/IndentFilterContext";
import { formatIndentDateTime } from "../dateTime";

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
  ROUTED_AUTOMATICALLY: "Routed Automatically",
  ALLOCATED: "Allocated",
  PARTIALLY_ALLOCATED: "Partially Allocated",
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
  APPROVAL_ROUTED_AUTOMATICALLY: "Routed Automatically",
  FALLBACK: "Routed Automatically",
  PROCUREMENT_REQUEST_CREATED: "Pending Approval",
  BOOKMARK_ADDED: "Bookmarked",
  BOOKMARK_REMOVED: "Bookmark Removed",
};

const HEADER_CURSOR_CLASS = "[&:is(th)]:cursor-default";

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

function requestLabel(row: ActivityRow) {
  return nonEmptyText(row.indent_no) ?? "Request unavailable";
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
    itemId,
    page,
    setPage,
  } = useIndentFilters();

  const size = 20;
  const filters = useMemo(() => ({
    search: search || undefined,
    date_from: startDate || undefined,
    date_to: endDate || undefined,
    required_from: requiredByFrom || undefined,
    required_to: requiredByTo || undefined,
    status: selectedStatuses.length ? selectedStatuses : undefined,
    priority: selectedPriorities.length ? selectedPriorities : undefined,
    transaction_type: transactionType || undefined,
    item_id: itemId ? Number(itemId) : undefined,
    page,
    size,
  }), [
    endDate,
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

  const {
    data,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey: indentKeys.activity(accountScope, filters),
    queryFn: () => indentApi.activity(filters),
    placeholderData: (previousData) => previousData,
  });

  const rows = Array.isArray(data?.items) ? data.items : [];
  const columns: Column<ActivityRow>[] = [
    { key: "when", header: "WHEN", className: HEADER_CURSOR_CLASS, render: (row) => <span className="text-muted">{occurredAtLabel(row)}</span> },
    { key: "no", header: "REQUEST", className: HEADER_CURSOR_CLASS, render: (row) => <span className="mono font-semibold text-ink">{requestLabel(row)}</span> },
    { key: "event", header: "EVENT", className: HEADER_CURSOR_CLASS, render: (row) => eventLabel(row) },
    { key: "details", header: "DETAILS", className: HEADER_CURSOR_CLASS, render: (row) => <DetailCell row={row} /> },
    { key: "qty", header: "QTY", className: HEADER_CURSOR_CLASS, render: (row) => <span className="tabular-nums">{formatQuantity(row)}</span> },
    { key: "dept", header: "DEPARTMENT", className: HEADER_CURSOR_CLASS, render: (row) => <DepartmentCell row={row} /> },
    { key: "result", header: "RESULT", className: HEADER_CURSOR_CLASS, render: (row) => <StatusPill status={resultLabel(row)} /> },
  ];

  const total = typeof data?.total === "number" && Number.isFinite(data.total)
    ? data.total
    : rows.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const hasBlockingError = Boolean(error && !data);

  return (
    <>
      <IndentModuleHeader
        title="Activity ledger"
        showCreate={false}
        filterMode="activity"
        showTransaction
        showMovement={false}
        showItem
      />

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
            onRowClick={(row) => nav(`/indents/${row.indent_id}`)}
            columns={columns}
            empty="No activity matches active filters."
            renderCard={(row) => (
              <div className="space-y-1 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="mono text-sm font-semibold text-ink">{requestLabel(row)}</span>
                  <StatusPill status={resultLabel(row)} />
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
      {data && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
          <span>Page {page} of {totalPages} ({total} total)</span>
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
