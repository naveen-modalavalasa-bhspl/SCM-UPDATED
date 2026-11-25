import { CircleCheck, Split, Undo2 } from "lucide-react";
import { Input, Select } from "@/shared/components";
import { ReasonRowsEditor } from "./ReasonRowsEditor";
import { newReasonRow, reasonProblems, reasonTotal, type ReasonRow } from "../reasonRows";

/**
 * Why ONE item is going back (SCM_0129, 2026-11-13).
 *
 * Most lines have one reason, so a line opens on one compact row — the reason, a note —
 * and the reason covers the whole line without a number being typed. "Split reasons"
 * opens the rows editor for the line ("Damaged 3, Expired 2" on a line of 5), whose
 * rows must add up to the line's quantity; "One reason" folds it back, keeping the first.
 *
 * The rows themselves are the same `ReasonRowsEditor` the whole-return reasons used, so
 * the arithmetic and the wording are the same ones the checklist and the save read.
 */
export function LineReasons({ rows, reasons, total, uom, itemLabel, readOnly, onChange }: {
  rows: ReasonRow[];
  reasons: { value: string; label: string }[];
  /** This line's quantity — what its reasons have to add up to. */
  total: number;
  uom?: string | null;
  itemLabel: string;
  readOnly?: boolean;
  onChange: (rows: ReasonRow[]) => void;
}) {
  const split = rows.length > 1;
  const first = rows[0] ?? newReasonRow();
  const problems = reasonProblems(rows, total);
  const done = problems.length === 0 && rows.every((row) => row.reason);
  // Said only once somebody has started — a fresh line is not "wrong", it is unanswered.
  const started = rows.some((row) => row.reason || row.note.trim());
  const labelOf = (value: string) => reasons.find((r) => r.value === value)?.label ?? value;

  const splitIt = () => {
    const given = Math.min(Math.max(total - 1, 0), total);
    onChange([
      { ...first, quantity: total > 1 ? String(given) : "" },
      newReasonRow(total > 1 ? String(Math.round((total - given) * 1000) / 1000) : ""),
    ]);
  };
  const unsplit = () => onChange([{ ...first, quantity: String(total || "") }]);

  if (readOnly) {
    return (
      <div className="flex flex-wrap items-center gap-1.5" data-testid="line-reasons">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Why</span>
        {rows.filter((row) => row.reason).length === 0 ? (
          <span className="text-xs text-muted">No reason given</span>
        ) : rows.filter((row) => row.reason).map((row) => (
          <span
            key={row.id}
            title={row.note || undefined}
            className="inline-flex items-center gap-1 rounded-full border border-line bg-content2/70 px-2.5 py-0.5 text-xs font-medium text-ink"
          >
            {labelOf(row.reason)}
            {split && <span className="tabular-nums text-muted">{row.quantity}</span>}
            {row.note && <span className="max-w-[14rem] truncate text-muted">· {row.note}</span>}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div
      data-testid="line-reasons"
      className={`rounded-xl border px-3 py-2.5 transition-colors ${
        done ? "border-ok/30 bg-ok-bg/40"
          : started ? "border-warn/40 bg-warn-bg/40" : "border-line bg-content2/40"
      }`}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
          {done && <CircleCheck className="h-3.5 w-3.5 text-ok" aria-hidden />}
          {split ? `Reasons for ${itemLabel}` : "Why is it coming back?"}
          <span className="font-normal normal-case tracking-normal">
            {split
              ? `· ${reasonTotal(rows)} of ${total || 0}${uom ? ` ${uom}` : ""} given a reason`
              : total > 0 ? `· all ${total}${uom ? ` ${uom}` : ""}` : ""}
          </span>
        </span>
        <button
          type="button"
          onClick={split ? unsplit : splitIt}
          disabled={!split && (total <= 0 || reasons.length < 2)}
          title={split ? "Keep only the first reason, for the whole line"
            : "Some of this item for one reason, some for another"}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-brand hover:bg-brand/10 disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent"
        >
          {split
            ? <><Undo2 className="h-3.5 w-3.5" aria-hidden /> One reason</>
            : <><Split className="h-3.5 w-3.5" aria-hidden /> Split reasons</>}
        </button>
      </div>

      {split ? (
        <ReasonRowsEditor
          rows={rows} reasons={reasons} total={total} uom={uom} onChange={onChange}
        />
      ) : (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
          <Select
            value={first.reason}
            onChange={(next) => onChange([{ ...first, reason: next, quantity: String(total || "") }])}
            options={reasons}
            placeholder="Pick a reason"
            searchable={false}
            ariaLabel={`Reason for ${itemLabel}`}
          />
          <Input
            aria-label={`Note for ${itemLabel}`}
            placeholder={first.reason === "OTHER" ? "What is wrong? (required)" : "Note (optional)"}
            value={first.note}
            isInvalid={first.reason === "OTHER" && !first.note.trim()}
            onChange={(event) => onChange([{ ...first, note: event.target.value }])}
          />
        </div>
      )}

      {started && problems.length > 0 && (
        <p className="mt-2 text-xs text-warn">{problems[0]}</p>
      )}
    </div>
  );
}
