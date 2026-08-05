import type { ReactNode } from "react";
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell, Spinner, Skeleton,
  Pagination,
} from "@heroui/react";

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  className?: string;
  hideOnNarrow?: boolean; // hide on medium widths where space is tight
}

interface Props<T> {
  data: T[];
  columns: Column<T>[];
  renderCard: (row: T) => ReactNode;
  onRowClick?: (row: T) => void;
  keyOf: (row: T) => string | number;
  loading?: boolean;
  empty?: ReactNode;
  /** Pagination is opt-in: pass all three and a pager renders under the rows.
   * Callers that omit them keep the old un-paged behaviour untouched. */
  page?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
}

/** HeroUI Table on desktop, stacked HeroUI cards under 768px. Every list screen uses
 * this — we never horizontal-scroll a table on a phone. */
export function ResponsiveList<T>({
  data, columns, renderCard, onRowClick, keyOf, loading, empty,
  page, totalPages, onPageChange,
}: Props<T>) {
  const colByKey = Object.fromEntries(columns.map((c) => [c.key, c])) as Record<string, Column<T>>;
  const rowByKey = new Map(data.map((r) => [String(keyOf(r)), r]));

  const pager = onPageChange && totalPages && totalPages > 1 ? (
    <div className="flex w-full justify-center p-4">
      <Pagination
        isCompact
        showControls
        color="primary"
        page={page ?? 1}
        total={totalPages}
        onChange={onPageChange}
      />
    </div>
  ) : null;

  return (
    <>
      {/* Desktop / tablet.
       * The scroll container is here, not on the Table: `base` carried overflow-hidden,
       * which CLIPPED a table wider than the page instead of scrolling it — the last
       * columns were simply unreachable, with no scrollbar to say so. Wide content
       * scrolls inside its own box; the page itself never scrolls sideways. */}
      <div className="hidden overflow-x-auto md:block">
        <Table
          aria-label="List"
          removeWrapper
          selectionMode="none"
          bottomContent={pager}
          onRowAction={onRowClick ? (key) => {
            const r = rowByKey.get(String(key));
            if (r) onRowClick(r);
          } : undefined}
          classNames={{
            base: "rounded-2xl border border-line/70 bg-content1",
            th: "bg-content2 text-[11px] font-semibold uppercase tracking-wider text-muted",
            tr: onRowClick ? "cursor-pointer transition-colors hover:bg-brand-050/50" : "",
            td: "py-3.5 text-sm",
          }}
        >
          <TableHeader columns={columns}>
            {(col) => (
              <TableColumn key={col.key} className={col.hideOnNarrow ? "hidden lg:table-cell" : ""}>
                {col.header}
              </TableColumn>
            )}
          </TableHeader>
          <TableBody
            items={data}
            isLoading={loading}
            loadingContent={<Spinner color="primary" />}
            emptyContent={loading ? " " : (empty ?? "Nothing here yet.")}
          >
            {(item) => (
              <TableRow key={keyOf(item)}>
                {(columnKey) => {
                  const col = colByKey[String(columnKey)];
                  return (
                    <TableCell className={`${col.className ?? ""} ${col.hideOnNarrow ? "hidden lg:table-cell" : ""}`}>
                      {col.render(item)}
                    </TableCell>
                  );
                }}
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Mobile cards */}
      <div className="space-y-3 md:hidden">
        {loading
          ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[76px] rounded-2xl" />)
          : data.length === 0
            ? <div className="py-16 text-center text-muted">{empty ?? "Nothing here yet."}</div>
            : data.map((row) => (
                <button
                  key={keyOf(row)}
                  onClick={() => onRowClick?.(row)}
                  className="block w-full rounded-2xl border border-line/70 bg-content1 p-4 text-left shadow-sm transition-transform active:scale-[0.99]"
                >
                  {renderCard(row)}
                </button>
              ))}
        {pager}
      </div>
    </>
  );
}
