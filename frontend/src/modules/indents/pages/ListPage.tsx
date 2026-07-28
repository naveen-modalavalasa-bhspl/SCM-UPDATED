import { useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Spinner, Skeleton, Table, TableBody, TableCell, TableColumn, TableHeader, TableRow,
} from "@heroui/react";
import { StatusPill } from "@/shared/components";
import { indentApi, indentKeys, useIndentAccountCacheIsolation, useIndentAccountScope } from "../api";
import type { IndentListRow } from "../types";
import { IndentBookmarkButton } from "../components/IndentBookmarkButton";
import { IndentModuleHeader } from "../components/IndentModuleHeader";
import { IndentFilterProvider, useIndentFilters } from "../context/IndentFilterContext";
import { formatIndentShortDate } from "../dateTime";

interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  className?: string;
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

function IndentListContent() {
  const nav = useNavigate();
  const accountScope = useIndentAccountScope();
  useIndentAccountCacheIsolation(accountScope);
  const [bookmarkError, setBookmarkError] = useState("");
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
    page,
    setPage,
  } = useIndentFilters();

  const size = 20;
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
    page,
    size,
  };

  const { data, isLoading, error } = useQuery({
    queryKey: indentKeys.list(accountScope, filterParams),
    queryFn: () => indentApi.list(filterParams),
    placeholderData: (previousData) => previousData,
  });
  const rows = data?.items ?? [];

  const columns: Column<IndentListRow>[] = [
    { key: "no", header: "Indent", render: (row) => <span className="mono font-semibold text-ink">{row.indent_no}</span> },
    { key: "req", header: "Requested by", render: (row) => row.requested_by_name ?? "-", hideOnNarrow: true },
    { key: "dept", header: "Department", render: (row) => row.department_name ?? "-" },
    { key: "items", header: "Lines", render: (row) => <span className="tabular-nums text-muted">{row.total_items}</span> },
    { key: "status", header: "Status", render: (row) => <StatusPill status={row.status} /> },
    { key: "date", header: "Raised", render: (row) => <span className="text-muted">{formatIndentShortDate(row.created_at)}</span>, hideOnNarrow: true },
    {
      key: "bookmark",
      header: "",
      className: "text-right",
      render: (row) => (
        <span className="flex justify-end">
          <IndentBookmarkButton row={row} accountScope={accountScope} onError={setBookmarkError} />
        </span>
      ),
    },
  ];
  const colByKey = Object.fromEntries(columns.map((column) => [column.key, column])) as Record<string, Column<IndentListRow>>;
  const rowByKey = new Map(rows.map((row) => [String(row.id), row]));

  return (
    <>
      <IndentModuleHeader title="All requests" />

      {bookmarkError && <p className="mb-4 rounded-lg border border-bad/30 bg-bad-bg px-4 py-3 text-sm text-bad">{bookmarkError}</p>}
      {error && <p className="mb-4 rounded-lg border border-bad/30 bg-bad-bg px-4 py-3 text-sm text-bad">{error.message}</p>}
      <div className="hidden md:block">
        <Table
          aria-label="List"
          removeWrapper
          selectionMode="none"
          onRowAction={(key) => {
            const row = rowByKey.get(String(key));
            if (row) nav(`/indents/${row.id}`);
          }}
          classNames={{
            base: "overflow-hidden rounded-2xl border border-line/70 bg-content1",
            th: "bg-content2 text-[11px] font-semibold uppercase tracking-wider text-muted",
            tr: "cursor-pointer transition-colors hover:bg-brand-050/50",
            td: "py-3.5 text-sm",
          }}
        >
          <TableHeader columns={columns}>
            {(column) => (
              <TableColumn key={column.key} className={column.hideOnNarrow ? "hidden lg:table-cell" : ""}>
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
                    <TableCell className={`${column.className ?? ""} ${column.hideOnNarrow ? "hidden lg:table-cell" : ""}`}>
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
                  onClick={() => nav(`/indents/${row.id}`)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      nav(`/indents/${row.id}`);
                    }
                  }}
                  className="block w-full rounded-2xl border border-line/70 bg-content1 p-4 text-left shadow-sm transition-transform active:scale-[0.99]"
                >
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0">
                        <span className="mono block truncate font-semibold text-ink">{row.indent_no}</span>
                        <span className="mt-1 block text-xs text-muted">{row.department_name ?? "-"}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <StatusPill status={row.status} />
                        <IndentBookmarkButton row={row} accountScope={accountScope} onError={setBookmarkError} />
                      </span>
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
    </>
  );
}

export function IndentListPage() {
  return (
    <IndentFilterProvider>
      <IndentListContent />
    </IndentFilterProvider>
  );
}
