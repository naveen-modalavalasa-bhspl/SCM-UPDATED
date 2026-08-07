import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Spinner, Skeleton, Table, TableBody, TableCell, TableColumn, TableHeader, TableRow,
} from "@heroui/react";
import {
  INDENT_QUERY_GC_TIME,
  INDENT_QUERY_STALE_TIME,
  indentApi,
  indentKeys,
  normalizeIndentQueryParams,
  useIndentAccountCacheIsolation,
  useIndentAccountScope,
} from "../api";
import type { IndentListRow } from "../types";
import { IndentModuleHeader } from "../components/IndentModuleHeader";
import { IndentSummaryStatusBadge } from "../components/IndentSummaryStatusBadge";
import { IndentFilterValueProvider, useIndentFilters } from "../context/IndentFilterContext";
import {
  allRequestsReturnState,
  readAllRequestsScroll,
  saveAllRequestsScroll,
  useAllRequestsUrlState,
} from "../context/AllRequestsUrlState";
import { formatIndentShortDate } from "../dateTime";
import { INDENT_REQUEST_STATUS_FILTER_OPTIONS } from "../constants";

interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  className: string;
  hideOnNarrow?: boolean;
}

function Pager({
  page,
  size,
  total,
  onPage,
}: {
  page: number;
  size: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / size));
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
      <span>
        Page {page} of {totalPages} ({total} total)
      </span>
      <span className="flex gap-2">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          className="rounded-lg border border-line px-3 py-1.5 font-medium text-body disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
          className="rounded-lg border border-line px-3 py-1.5 font-medium text-body disabled:opacity-40"
        >
          Next
        </button>
      </span>
    </div>
  );
}

function IndentListContent({
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
    requiredByFrom,
    requiredByTo,
    selectedStatuses,
    selectedPriorities,
    selectedDepartments,
    selectedRegions,
    includeUnassignedRegion,
    sortBy,
    sortDir,
    page,
    setPage,
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
    department_id: selectedDepartments,
    region_id: selectedRegions,
    // Only when on: sending `false` would put a param in every query key for a
    // filter nobody asked for.
    region_unassigned: includeUnassignedRegion || undefined,
    sort_by: sortBy,
    sort_dir: sortDir,
    page,
    size,
  }), [
    endDate,
    hasCompleteDateRange,
    includeUnassignedRegion,
    page,
    requiredByFrom,
    requiredByTo,
    search,
    selectedDepartments,
    selectedPriorities,
    selectedRegions,
    selectedStatuses,
    sortBy,
    sortDir,
    startDate,
  ]);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: indentKeys.list(accountScope, filterParams),
    queryFn: ({ signal }) => indentApi.list(filterParams, signal),
    placeholderData: (previousData) => previousData,
    staleTime: INDENT_QUERY_STALE_TIME,
    gcTime: INDENT_QUERY_GC_TIME,
  });
  const rows = data?.items ?? [];
  const isRefreshing = isFetching && Boolean(data);
  const restoredScrollUrl = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (!data) return;
    const lastPage = Math.max(1, Math.ceil(data.total / size));
    if (page > lastPage) replacePage(lastPage);
  }, [data, page, replacePage, size]);

  useEffect(() => {
    if (!data || restoredScrollUrl.current === listUrl) return;
    restoredScrollUrl.current = listUrl;
    const scrollY = readAllRequestsScroll(listUrl);
    if (scrollY === null) return;
    const frame = window.requestAnimationFrame(() => window.scrollTo(0, scrollY));
    return () => window.cancelAnimationFrame(frame);
  }, [data, listUrl]);

  useEffect(() => () => saveAllRequestsScroll(listUrl), [listUrl]);

  const openIndent = useCallback((indentId: number) => {
    saveAllRequestsScroll(listUrl);
    nav(`/indents/${indentId}`, { state: allRequestsReturnState(listUrl) });
  }, [listUrl, nav]);

  const columns: Column<IndentListRow>[] = [
    {
      key: "no",
      header: "Indent",
      className: "w-[26%] px-4 text-left align-middle lg:w-[16%]",
      render: (row) => <span className="mono font-semibold text-ink">{row.indent_no}</span>,
    },
    {
      key: "req",
      header: "Requested by",
      className: "w-0 overflow-hidden px-4 text-left align-middle lg:w-[16%]",
      hideOnNarrow: true,
      render: (row) => <span className="block truncate">{row.requested_by_name ?? "-"}</span>,
    },
    {
      key: "dept",
      header: "Department",
      className: "w-[30%] overflow-hidden px-4 text-left align-middle lg:w-[16%]",
      render: (row) => <span className="block truncate">{row.department_name ?? "-"}</span>,
    },
    {
      key: "region",
      header: "Region",
      className: "w-0 overflow-hidden px-4 text-left align-middle lg:w-[16%]",
      hideOnNarrow: true,
      render: (row) => (
        <span className="block truncate" title={row.region_name ?? undefined}>
          {row.region_name ?? "-"}
        </span>
      ),
    },
    {
      key: "items",
      header: "Items",
      className: "w-[12%] px-4 text-center align-middle lg:w-[8%]",
      render: (row) => <span className="block tabular-nums text-muted">{row.total_items}</span>,
    },
    {
      key: "status",
      header: "Status",
      className: "w-[32%] px-4 text-left align-middle lg:w-[16%]",
      render: (row) => <IndentSummaryStatusBadge status={row.status} />,
    },
    {
      key: "date",
      header: "Raised",
      className: "w-0 px-4 text-left align-middle lg:w-[12%]",
      hideOnNarrow: true,
      render: (row) => <span className="whitespace-nowrap text-muted">{formatIndentShortDate(row.created_at)}</span>,
    },
  ];
  const colByKey = Object.fromEntries(columns.map((column) => [column.key, column])) as Record<string, Column<IndentListRow>>;
  const rowByKey = new Map(rows.map((row) => [String(row.id), row]));

  return (
    <>
      <IndentModuleHeader
        title="All requests"
        statusFilterOptions={INDENT_REQUEST_STATUS_FILTER_OPTIONS}
        separateDateFilters
        searchPlaceholder="Search by indent no., requester, department or status..."
        showRegion
      />

      {error && <p className="mb-4 rounded-lg border border-bad/30 bg-bad-bg px-4 py-3 text-sm text-bad">{error.message}</p>}
      <section className="relative" aria-label="Indent results" aria-busy={isFetching}>
        <div
          role="status"
          aria-live="polite"
          className={`pointer-events-none absolute right-3 top-2 z-20 rounded-full bg-content1/95 px-2.5 py-1 text-xs font-medium text-muted shadow-sm transition-opacity duration-150 ${isRefreshing ? "opacity-100" : "opacity-0"}`}
        >
          {isRefreshing ? "Updating results…" : ""}
        </div>
        <div className={`transition-opacity duration-150 ${isRefreshing ? "opacity-70" : "opacity-100"}`}>
      <div className="hidden md:block">
        <Table
          aria-label="List"
          removeWrapper
          selectionMode="none"
          onRowAction={(key) => {
            const row = rowByKey.get(String(key));
            if (row) openIndent(row.id);
          }}
          classNames={{
            base: "overflow-hidden rounded-2xl border border-line/70 bg-content1",
            table: "table-fixed",
            th: "bg-content2 text-[11px] font-semibold uppercase tracking-wider text-muted",
            tr: "cursor-pointer transition-colors hover:bg-brand-050/50",
            td: "py-3.5 text-sm",
          }}
        >
          <TableHeader columns={columns}>
            {(column) => (
              <TableColumn key={column.key} className={`${column.className} ${column.hideOnNarrow ? "hidden lg:table-cell" : ""}`}>
                {column.header}
              </TableColumn>
            )}
          </TableHeader>
          <TableBody
            items={rows}
            isLoading={isLoading}
            loadingContent={<Spinner color="primary" />}
            emptyContent={isLoading ? " " : "No indents match active filters."}
          >
            {(row) => (
              <TableRow key={row.id}>
                {(columnKey) => {
                  const column = colByKey[String(columnKey)];
                  return (
                    <TableCell className={`${column.className} ${column.hideOnNarrow ? "hidden lg:table-cell" : ""}`}>
                      {column.render(row)}
                    </TableCell>
                  );
                }}
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-3 md:hidden">
        {isLoading
          ? Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-[76px] rounded-2xl" />)
          : rows.length === 0
            ? <div className="py-16 text-center text-muted">No indents match active filters.</div>
            : rows.map((row) => (
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
                  className="block w-full rounded-2xl border border-line/70 bg-content1 p-4 text-left shadow-sm transition-transform active:scale-[0.99]"
                >
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0">
                        <span className="mono block truncate font-semibold text-ink">{row.indent_no}</span>
                        <span className="mt-1 block truncate text-xs text-muted">
                          {row.department_name ?? "-"}
                          {row.region_name ? ` · ${row.region_name}` : ""}
                        </span>
                      </span>
                      <IndentSummaryStatusBadge status={row.status} />
                    </div>
                    <div className="flex items-center justify-between gap-3 text-sm text-muted">
                      <span>{row.requested_by_name ?? "-"}</span>
                      <span className="tabular-nums">{row.total_items} lines - {formatIndentShortDate(row.created_at)}</span>
                    </div>
                  </div>
                </div>
              ))}
      </div>
      {data && <Pager page={page} size={size} total={data.total} onPage={setPage} />}
        </div>
      </section>
    </>
  );
}

export function IndentListPage() {
  const { filters, listUrl, replacePage, size } = useAllRequestsUrlState();
  return (
    <IndentFilterValueProvider value={filters}>
      <IndentListContent listUrl={listUrl} size={size} replacePage={replacePage} />
    </IndentFilterValueProvider>
  );
}
