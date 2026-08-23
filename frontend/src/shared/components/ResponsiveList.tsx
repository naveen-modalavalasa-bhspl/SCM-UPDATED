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
  /** Bump this when the CELLS must be rebuilt although `data` has not changed.
   *
   * HeroUI's Table is a react-stately collection: it caches the built rows against
   * the identity of `items`, so a column whose `render` closes over something that
   * arrived LATER — a serial/asset-code lookup fetched for the page after the list
   * itself — kept painting the first render's cells forever. TanStack Query's
   * structural sharing keeps `data` identity stable, so nothing told the collection
   * to rebuild. Changing this value remounts the table, which does. */
  revision?: string | number;
}

/** HeroUI Table on desktop, stacked HeroUI cards under 768px. Every list screen uses
 * this — we never horizontal-scroll a table on a phone. */
export function ResponsiveList<T>({
  data, columns, renderCard, onRowClick, keyOf, loading, empty,
  page, totalPages, onPageChange, revision,
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
      <div className="hidden md:block">
      <div className="overflow-x-auto">
        <Table
          key={revision ?? "static"}
          aria-label="List"
          removeWrapper
          selectionMode="none"
          onRowAction={onRowClick ? (key) => {
            const r = rowByKey.get(String(key));
            if (r) onRowClick(r);
          } : undefined}
          classNames={{
            // `w-max min-w-full` is load-bearing, not styling (2026-08-23).
            //
            // HeroUI's `base` slot is a plain block `<div>` (theme: "flex flex-col
            // relative gap-4") and it wraps the table WHETHER OR NOT `removeWrapper`
            // is set — that flag only drops the inner scroll box. A block div takes
            // the width of its container, while the `<table>` inside it is
            // `min-w-full h-auto` and grows past that whenever the columns need more
            // room. So on every list wide enough to scroll, the border below was
            // painted at the CONTAINER's width and the last columns hung outside it:
            // a hard vertical rule straight down the middle of the table, in every
            // module, wherever the visible edge happened to fall.
            //
            // `w-max` sizes the div to its content (the table's real width) and
            // `min-w-full` keeps it at least as wide as the scroll container, so a
            // narrow table still fills the card. The border now wraps the whole
            // table, and there is nothing left to draw a line through it.
            base: "w-max min-w-full rounded-2xl border border-line/70 bg-content1",
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
        {/* The pager sits OUTSIDE the scroll box, not in the Table's `bottomContent`.
            Inside, it lives in the same `base` div as the table — which is now as wide
            as the table — so on a wide register it scrolled sideways with the columns
            and could end up off-screen. Out here it stays put, and it is still inside
            whichever <Card> the screen wrapped this list in. */}
        {pager}
      </div>

      {/* Mobile cards */}
      <div className="space-y-3 md:hidden">
        {loading
          ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[76px] rounded-2xl" />)
          : data.length === 0
            ? <div className="py-16 text-center text-muted">{empty ?? "Nothing here yet."}</div>
            : data.map((row) => (
                // Not a <button>. Cards carry their own actions — "View details" on
                // the approvals queue is a real button — and a button inside a
                // button is invalid HTML: React warns, and the browser is free to
                // decide which of the two a tap belongs to. A div with the button
                // role keeps the whole card clickable and keyboard-reachable while
                // the controls inside it stay controls.
                <div
                  key={keyOf(row)}
                  role={onRowClick ? "button" : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={onRowClick ? (event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onRowClick(row);
                    }
                  } : undefined}
                  className={`block w-full rounded-2xl border border-line/70 bg-content1 p-4 text-left shadow-sm ${
                    onRowClick ? "cursor-pointer transition-transform active:scale-[0.99]" : ""
                  }`}
                >
                  {renderCard(row)}
                </div>
              ))}
        {pager}
      </div>
    </>
  );
}
