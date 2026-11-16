import { Plus, X } from "lucide-react";
import { Input, Select } from "@/shared/components";
import { QuantityInput } from "@/shared/components/QuantityInput";
import { newReasonRow, reasonTotal, type ReasonRow } from "../reasonRows";

/**
 * The reasons for one return: a row each for a reason, how many, and a note (2026-11-07).
 *
 * The delivery screen only says how much is going back; WHY is asked here. With one row
 * the quantity is the return's whole total and is not asked for; "Add another reason"
 * splits it, and the rows must then add up to the total. The line under them says how
 * many units still have no reason.
 */
export function ReasonRowsEditor({ rows, reasons, total, uom, readOnly, onChange }: {
  rows: ReasonRow[];
  reasons: { value: string; label: string }[];
  /** Every unit on the return: what the rows have to add up to. */
  total: number;
  uom?: string | null;
  readOnly?: boolean;
  onChange: (rows: ReasonRow[]) => void;
}) {
  const single = rows.length === 1;
  const given = reasonTotal(rows);
  const remaining = Math.round((total - given) * 1000) / 1000;
  const patch = (id: string, change: Partial<ReasonRow>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...change } : row)));
  // A reason already on another row is not offered again: it would only be refused.
  const optionsFor = (row: ReasonRow) => reasons.filter((option) =>
    option.value === row.reason
    || !rows.some((other) => other.id !== row.id && other.reason === option.value));

  return (
    <div data-testid="reason-rows" className="space-y-2.5">
      <ul className="space-y-2.5">
        {rows.map((row, index) => (
          <li
            key={row.id}
            className="grid gap-2 sm:grid-cols-[minmax(0,13rem)_7.5rem_minmax(0,1fr)_auto] sm:items-start"
          >
            <Select
              value={row.reason}
              onChange={(next) => patch(row.id, { reason: next })}
              options={optionsFor(row)}
              placeholder="Why is this coming back?"
              isDisabled={readOnly}
              searchable={false}
              ariaLabel={`Reason ${index + 1}`}
            />
            {single ? (
              <div className="flex h-11 items-center rounded-xl border border-line bg-content2/60 px-3 text-sm text-muted">
                All {total || 0}{uom ? ` ${uom}` : ""}
              </div>
            ) : (
              <div className="flex h-11 items-center rounded-xl border border-line bg-content1 pr-2.5 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/25">
                <QuantityInput
                  decimals={3}
                  min={0}
                  max={total}
                  aria-label={`How many for reason ${index + 1}`}
                  placeholder="Qty"
                  disabled={readOnly}
                  value={row.quantity}
                  onChange={(raw) => patch(row.id, { quantity: raw })}
                  className="h-full min-w-0 flex-1 rounded-xl bg-transparent px-2.5 text-right font-semibold tabular-nums outline-none placeholder:font-normal placeholder:text-muted"
                />
                {uom && <span className="shrink-0 text-xs text-muted">{uom}</span>}
              </div>
            )}
            <Input
              aria-label={`Note for reason ${index + 1}`}
              placeholder={row.reason === "OTHER" ? "What is wrong? (required)" : "Note (optional)"}
              value={row.note}
              disabled={readOnly}
              isInvalid={row.reason === "OTHER" && !row.note.trim()}
              onChange={(event) => patch(row.id, { note: event.target.value })}
            />
            {!readOnly && !single ? (
              <button
                type="button"
                aria-label={`Remove reason ${index + 1}`}
                onClick={() => onChange(rows.filter((other) => other.id !== row.id))}
                className="grid h-11 w-11 place-items-center rounded-full text-muted hover:bg-content2 hover:text-bad"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            ) : <span className="hidden h-11 w-11 sm:block" aria-hidden />}
          </li>
        ))}
      </ul>

      {!readOnly && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            disabled={rows.length >= reasons.length}
            onClick={() => onChange([
              ...rows,
              newReasonRow(remaining > 0 && !single ? String(remaining) : ""),
            ])}
            className="flex min-h-9 items-center gap-1.5 text-xs font-semibold text-brand hover:underline disabled:cursor-not-allowed disabled:text-muted disabled:no-underline"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add another reason
          </button>
          {!single && (
            <span className={`text-xs font-semibold tabular-nums ${
              remaining === 0 ? "text-ok" : "text-warn"
            }`}>
              {remaining === 0
                ? `All ${total} have a reason`
                : remaining > 0
                  ? `${remaining} still without a reason`
                  : `${Math.abs(remaining)} too many`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
