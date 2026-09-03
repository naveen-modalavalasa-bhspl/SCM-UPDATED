import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/shared/components";

/**
 * Tick the columns an API exposes.
 *
 * It was a bare checkbox grid with a "Select all" over it, which is fine for the ten
 * columns of a small master and unusable on the wide ones — `pro_purchase_orders` and
 * the indent tables run to forty and more, so finding `expected_delivery_date` meant
 * reading a three-column wall of mono text. A filter box and a way back OUT of "select
 * all" are the whole difference between composing an API in a minute and giving up on
 * it.
 *
 * The type is drawn beside each name because it is the one thing that decides whether
 * a column is worth exposing — a consumer asking for "the date" wants to know which of
 * the four datetime columns it is, and the picker already has the answer.
 *
 * Shared by the base table and by every joined table (`JoinEditor`), so the two cannot
 * grow different ideas of what picking a column looks like.
 */
export function ColumnPicker({
  label, columns, selected, onToggle, onAdd, onClear, hint, dense = false,
}: {
  label: string;
  columns: { column: string; type?: string }[];
  /** Column names currently ticked. */
  selected: string[];
  onToggle: (name: string) => void;
  /** Tick everything currently listed — which is everything matching the filter. */
  onAdd: (names: string[]) => void;
  onClear: () => void;
  hint?: string;
  /** Inside a join card, where the box is nested one level deeper. */
  dense?: boolean;
}) {
  const [search, setSearch] = useState("");

  const query = search.trim().toLowerCase();
  const shown = useMemo(
    () => (query ? columns.filter((c) => c.column.toLowerCase().includes(query)) : columns),
    [columns, query],
  );

  const chosen = new Set(selected);
  // "Select all" against a filtered list would silently tick columns the reader
  // cannot see. Filtered, it ticks the matches and says so.
  const addLabel = query ? `Select these ${shown.length}` : "Select all";

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className={`font-medium text-body ${dense ? "text-xs" : "text-sm"}`}>
          {label}{" "}
          <span className="text-muted">
            ({selected.length} of {columns.length} ticked)
          </span>
        </span>
        <span className="flex items-center gap-1">
          <Button variant="ghost" disabled={!shown.length}
                  onClick={() => onAdd(shown.map((c) => c.column))}>
            {addLabel}
          </Button>
          {/* There was no way back. Ticking 44 columns by accident meant unticking
              them one at a time. */}
          <Button variant="ghost" disabled={!selected.length} onClick={onClear}>
            Clear
          </Button>
        </span>
      </div>

      {columns.length > 8 && (
        <div className="relative mb-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4
                             -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={`Filter ${columns.length} columns…`}
            aria-label={`Filter columns for ${label}`}
            className="min-h-9 w-full rounded-lg border border-line bg-content1 pl-9 pr-3
                       text-sm text-ink outline-none placeholder:text-muted
                       focus:border-brand"
          />
        </div>
      )}

      <div className="grid max-h-56 grid-cols-1 gap-1 overflow-y-auto rounded-xl border
                      border-line p-3 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((column) => (
          <label key={column.column}
                 className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-1
                            text-sm text-body hover:bg-content2">
            <input type="checkbox" className="h-4 w-4"
                   checked={chosen.has(column.column)}
                   onChange={() => onToggle(column.column)} />
            <span className="min-w-0">
              <span className="block truncate font-mono text-xs text-ink">
                {column.column}
              </span>
              {column.type && (
                <span className="block truncate text-[10px] text-muted">{column.type}</span>
              )}
            </span>
          </label>
        ))}
        {!shown.length && (
          <p className="col-span-full py-3 text-center text-xs text-muted">
            {columns.length
              ? `No column matches “${search}”.`
              : "This table has no columns to offer."}
          </p>
        )}
      </div>

      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}
