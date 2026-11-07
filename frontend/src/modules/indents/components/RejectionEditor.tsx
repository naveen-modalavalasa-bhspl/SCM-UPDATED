import { useState } from "react";
import { Plus, X } from "lucide-react";
import { SerialNumbersModal } from "@/modules/warehouse/components/SerialNumbersModal";
import { Input, Select } from "@/shared/components";
import { QuantityInput } from "@/shared/components/QuantityInput";
import {
  newRejectionRow, rejectedTotal, rejectionProblems,
  type RejectionReason, type RejectionRow,
} from "../receiptRejections";

/**
 * "Not all of it is usable" — the part of ONE item in ONE carton that is not being
 * accepted, split over the reasons it was turned away for (2026-11-06).
 *
 * Collapsed to a single quiet button until it is needed, because most deliveries are
 * simply correct and an empty form on every item would teach everyone to scroll past it.
 * Each row is a reason, a quantity and a comment; the same item can be split over several
 * ("Expired 2, Damaged 10"). What is turned away is taken off what is being accepted by
 * the screen that owns this, so the two never overlap.
 */
export function RejectionEditor({ rows, reasons, max, uom, label, serials = [], onChange }: {
  rows: RejectionRow[];
  reasons: RejectionReason[];
  /** The most that came in this package: the cap on what can be turned away. */
  max: number;
  uom?: string | null;
  label: string;
  /** The units that came with this item (empty for bulk goods). Which of them are turned
   *  away is chosen per reason, so a return sends back those very units. */
  serials?: string[];
  onChange: (rows: RejectionRow[]) => void;
}) {
  const options = reasons.map((reason) => ({ value: reason.value, label: reason.label }));
  const coded = serials.length > 0;
  const problems = rejectionProblems(rows, max, reasons, coded);
  const [picking, setPicking] = useState<string | null>(null);
  const pickingRow = rows.find((row) => row.id === picking);
  const takenElsewhere = (id: string) =>
    new Set(rows.filter((row) => row.id !== id).flatMap((row) => row.serials));
  const total = rejectedTotal(rows);
  const patch = (id: string, change: Partial<RejectionRow>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...change } : row)));

  if (rows.length === 0) {
    return (
      <button
        type="button"
        onClick={() => onChange([newRejectionRow()])}
        className="flex min-h-9 items-center gap-1.5 text-xs font-semibold text-brand hover:underline"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Some of it is not usable (damaged, expired…)
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-warn/40 bg-warn/5 p-3" data-testid="rejection-editor">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-ink">Not accepting</span>
        <span className="text-[11px] text-muted">
          {total > 0
            ? `${total} ${uom ?? ""} will be returned, not counted as received`.replace("  ", " ")
            : "Say how many, and why"}
        </span>
      </div>

      <ul className="mt-2.5 space-y-2.5">
        {rows.map((row, index) => (
          <li key={row.id} className="grid gap-2 sm:grid-cols-[minmax(0,11rem)_7rem_minmax(0,1fr)_auto] sm:items-start">
            <Select
              ariaLabel={`Reason ${index + 1} for ${label}`}
              placeholder="Reason"
              searchable={false}
              value={row.reason}
              onChange={(next) => patch(row.id, { reason: next })}
              options={options}
            />
            <div className="flex h-11 items-center rounded-xl border border-line bg-content1 pr-2.5 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/25">
              <QuantityInput
                decimals={3}
                min={0}
                max={max}
                aria-label={`How many ${label} for reason ${index + 1}`}
                placeholder="Qty"
                value={row.quantity}
                onChange={(raw) => patch(row.id, { quantity: raw })}
                className="h-full min-w-0 flex-1 rounded-xl bg-transparent px-2.5 text-right font-semibold tabular-nums outline-none placeholder:font-normal placeholder:text-muted"
              />
              {uom && <span className="shrink-0 text-xs text-muted">{uom}</span>}
            </div>
            <Input
              aria-label={`Comment ${index + 1} for ${label}`}
              placeholder={reasons.find((r) => r.value === row.reason)?.needs_comment
                ? "What is wrong? (required)" : "Comment (optional)"}
              value={row.comment}
              onChange={(event) => patch(row.id, { comment: event.target.value })}
            />
            {coded && (
              <button
                type="button"
                disabled={!(Number(row.quantity) >= 1)}
                onClick={() => setPicking(row.id)}
                className="min-h-9 text-left text-xs font-semibold text-brand hover:underline disabled:cursor-not-allowed disabled:text-muted disabled:no-underline sm:col-span-4"
              >
                {row.serials.length > 0
                  ? `${row.serials.length} serial number${row.serials.length === 1 ? "" : "s"} chosen — change`
                  : "Choose the serial numbers"}
              </button>
            )}
            <button
              type="button"
              aria-label={`Remove reason ${index + 1} for ${label}`}
              onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
              className="grid h-11 w-11 place-items-center rounded-full text-muted hover:bg-content2 hover:text-bad"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => onChange([...rows, newRejectionRow()])}
          className="flex min-h-9 items-center gap-1.5 text-xs font-semibold text-brand hover:underline"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add another reason
        </button>
      </div>

      {coded && (
        <SerialNumbersModal
          isOpen={!!pickingRow}
          onClose={() => setPicking(null)}
          itemLabel={label}
          quantity={Math.floor(Number(pickingRow?.quantity ?? 0))}
          available={serials.filter((code) => !takenElsewhere(picking ?? "").has(code))}
          initial={pickingRow?.serials ?? []}
          pickMode="select"
          noun="serial"
          onSave={(chosen) => {
            if (pickingRow) patch(pickingRow.id, { serials: chosen });
            setPicking(null);
          }}
        />
      )}

      {problems.length > 0 && (
        <ul role="alert" className="mt-2 space-y-0.5 text-xs font-medium text-bad">
          {problems.map((problem) => <li key={problem}>{problem}</li>)}
        </ul>
      )}
    </div>
  );
}
