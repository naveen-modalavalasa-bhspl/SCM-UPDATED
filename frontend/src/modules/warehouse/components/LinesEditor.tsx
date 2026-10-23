import { useState, useEffect, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/shared/components";

/**
 * The editable line grid behind every warehouse document form.
 *
 * `<ResponsiveList>` is the read-only list surface — it renders cells, it does not
 * own row state. Document forms need the other thing: rows the user edits in place,
 * a footer that totals them, and a phone layout that stacks each line into a card
 * instead of scrolling a twelve-column table sideways. GRN, inspection, issue,
 * dispatch and return forms all needed exactly this, so it is one component rather
 * than five hand-rolled tables that disagree about where the delete button goes.
 *
 * Rollups are the caller's job: it holds the rows, so it computes `total_qty` and
 * friends from the same array the user is editing and they cannot drift.
 */

export interface LineColumn<T> {
  key: string;
  header: string;
  /** Tailwind width class, e.g. `w-32`. Omit to let the column size itself. */
  width?: string;
  /** Right-aligns the cell — use for every quantity and amount. */
  numeric?: boolean;
  /** Hidden below `lg`, where only the identifying columns fit. */
  hideOnNarrow?: boolean;
  render: (row: T, index: number) => ReactNode;
}

interface Props<T> {
  rows: T[];
  columns: LineColumn<T>[];
  keyOf: (row: T, index: number) => string | number;
  /** Omit to hide the delete column — a posted document has no removable lines. */
  onRemove?: (index: number) => void;
  onAdd?: () => void;
  addLabel?: string;
  /** Rendered under the grid, e.g. a totals row. */
  footer?: ReactNode;
  empty?: string;
  /** Shown when the caller wants a line marked, e.g. a rejected quantity in red. */
  rowTone?: (row: T, index: number) => string | undefined;
  /** Minimum table width for dense documents whose cells need room to breathe. */
  minTableWidth?: string;
}

export function LinesEditor<T>({
  rows,
  columns,
  keyOf,
  onRemove,
  onAdd,
  addLabel = "Add line",
  footer,
  empty = "No lines yet.",
  rowTone,
  minTableWidth = "min-w-[720px]",
}: Props<T>) {
  const head = (
    <>
      {columns.map((c) => (
        <th
          key={c.key}
          className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted ${
            c.numeric ? "text-right" : "text-left"
          } ${c.width ?? ""} ${c.hideOnNarrow ? "hidden lg:table-cell" : ""}`}
        >
          {c.header}
        </th>
      ))}
      {onRemove && <th className="w-12 px-3 py-2" aria-label="Remove" />}
    </>
  );

  return (
    <div>
      {/* Desktop: a real grid. The scroll box is here so a wide document scrolls
       * inside its own card rather than pushing the page sideways. */}
      <div className="hidden overflow-x-auto rounded-2xl border border-line/70 bg-content1 md:block">
        <table className={`w-full ${minTableWidth} border-collapse`}>
          <thead className="bg-content2">
            <tr>{head}</tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + (onRemove ? 1 : 0)}
                  className="px-3 py-10 text-center text-sm text-muted"
                >
                  {empty}
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr key={keyOf(row, i)} className={`border-t border-line/70 transition-colors ${rowTone?.(row, i) ?? ""}`}>
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={`px-3 py-2 align-middle text-sm ${c.numeric ? "text-right" : ""} ${
                        c.hideOnNarrow ? "hidden lg:table-cell" : ""
                      } ${c.width ?? ""}`}
                    >
                      {c.render(row, i)}
                    </td>
                  ))}
                  {onRemove && (
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => onRemove(i)}
                        aria-label={`Remove line ${i + 1}`}
                        className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted transition-colors hover:bg-bad-bg hover:text-bad"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
        {footer && <div className="border-t border-line/70 bg-content2/50 px-3 py-2">{footer}</div>}
      </div>

      {/* Phone: one card per line. */}
      <div className="space-y-3 md:hidden">
        {rows.length === 0 ? (
          <div className="rounded-2xl border border-line/70 bg-content1 py-10 text-center text-sm text-muted">
            {empty}
          </div>
        ) : (
          rows.map((row, i) => (
            <div
              key={keyOf(row, i)}
              className={`rounded-2xl border border-line/70 bg-content1 p-4 transition-colors ${rowTone?.(row, i) ?? ""}`}
            >
              <div className="mb-3 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Line {i + 1}
                </span>
                {onRemove && (
                  <button
                    type="button"
                    onClick={() => onRemove(i)}
                    aria-label={`Remove line ${i + 1}`}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:text-bad"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div className="space-y-3">
                {columns.map((c) => (
                  <div key={c.key}>
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
                      {c.header}
                    </div>
                    <div className="text-sm">{c.render(row, i)}</div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
        {footer && <div className="rounded-2xl border border-line/70 bg-content2/50 p-3">{footer}</div>}
      </div>

      {onAdd && (
        <div className="mt-3">
          <Button variant="soft" onClick={onAdd}>
            <Plus className="h-4 w-4" /> {addLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

/** A compact numeric cell editor, sized for the grid. */
export function QtyInput({
  value,
  onChange,
  max,
  disabled,
  invalid,
  ariaLabel,
  step,
  decimals,
}: {
  value: number | string;
  onChange: (value: any) => void;
  max?: number;
  disabled?: boolean;
  invalid?: boolean;
  ariaLabel: string;
  /** Warehouse quantities and money are entered at two decimal places by
   *  default. Overridden by `decimals` when the item's own unit is whole. */
  step?: string;
  /** How many decimal places this quantity's unit allows. 0 means a
   *  whole-unit UOM (Nos, Box…) — the input then blocks "." entirely and
   *  rounds on blur, instead of letting a fraction through for the server to
   *  refuse afterwards (SCM_0080). `undefined`/`null` keeps the old 2-dp
   *  behaviour for a line whose unit is not yet known. */
  decimals?: number | null;
}) {
  const places = decimals === 0 ? 0 : 2;
  const effectiveStep = step ?? (places === 0 ? "1" : "0.01");
  const fmt = (n: number) => n.toFixed(places);
  const [local, setLocal] = useState<string>(
    value === 0 ? fmt(0) : value === "" || value == null ? "" : fmt(Number(value))
  );

  useEffect(() => {
    if (value === "" || value == null) {
      if (local !== "") setLocal("");
    } else {
      const currentNum = Number(local);
      const newNum = Number(value);
      if (currentNum !== newNum && !(Number.isNaN(currentNum) && Number.isNaN(newNum))) {
        setLocal(fmt(Number(value)));
      }
    }
  }, [value, local, places]);

  return (
    <input
      type="number"
      inputMode={places === 0 ? "numeric" : "decimal"}
      min={0}
      max={max}
      step={effectiveStep}
      value={local}
      disabled={disabled}
      aria-label={ariaLabel}
      onKeyDown={(e) => {
        // Whole-unit items (Nos, Box…) never take a fraction — refuse the
        // decimal point at the keyboard rather than only on blur or save.
        if (places === 0 && (e.key === "." || e.key === ",")) e.preventDefault();
      }}
      onChange={(e) => {
        setLocal(e.target.value);
        onChange(e.target.value === "" ? "" : e.target.value);
      }}
      onBlur={(e) => {
        if (e.target.value !== "") {
          const num = Number(e.target.value);
          if (!Number.isNaN(num)) {
            const formatted = fmt(num);
            setLocal(formatted);
            onChange(formatted);
          }
        }
      }}
      className={`min-h-11 w-full rounded-md border bg-content1 px-2 text-right text-sm text-ink outline-none focus:border-brand disabled:bg-content2 disabled:text-muted ${
        invalid ? "border-bad" : "border-line"
      }`}
    />
  );
}

/** A compact text cell editor, sized for the grid. */
export function TextInput({
  value,
  onChange,
  placeholder,
  disabled,
  ariaLabel,
}: {
  value?: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <input
      value={value ?? ""}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      className="min-h-11 w-full rounded-md border border-line bg-content1 px-2 text-sm text-ink outline-none placeholder:text-muted focus:border-brand disabled:bg-content2 disabled:text-muted"
    />
  );
}

/** A compact date cell editor, sized for the grid. */
export function DateInput({
  value,
  onChange,
  disabled,
  ariaLabel,
  min,
  max,
}: {
  value?: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  min?: string;
  max?: string;
}) {
  return (
    <input
      type="date"
      value={value ?? ""}
      min={min}
      max={max}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      className="min-h-11 w-full rounded-md border border-line bg-content1 px-2 text-sm text-ink outline-none focus:border-brand disabled:bg-content2 disabled:text-muted"
    />
  );
}
