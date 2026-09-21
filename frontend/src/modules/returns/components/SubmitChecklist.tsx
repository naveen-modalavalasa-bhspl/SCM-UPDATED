import { AlertTriangle, Check, Circle } from "lucide-react";
import { CardBody } from "@heroui/react";
import { Card } from "@/shared/components";

/**
 * What is still missing before this return can go to an approver — the right-hand rail.
 *
 * ADDED 2026-09-07. `Submit for approval` is gated on five separate conditions (a
 * reason, at least one good line, no line over the shelf quantity, no item twice, a
 * photo of the stock, and a description when the reason is Other) and every one of them
 * expressed itself as the button being greyed out. A disabled primary action with no
 * stated cause is the single most common complaint about a form: the reader has done
 * something wrong, cannot see what, and the only feedback available is pressing a button
 * that does not respond.
 *
 * So each condition is listed, in the order the steps ask for it, with the same words the
 * step itself uses. A `blocked` row is a mistake that must be corrected (a quantity over
 * the shelf); a plain unticked row is simply work not done yet. The two are different
 * news and are coloured differently — `bad` for the first, muted for the second — never
 * both red, because a fresh empty form is not an error state.
 *
 * NOTHING HERE GATES ANYTHING. It reads the same booleans the form computes for
 * `canSave` / `canSubmit`, and the service refuses a bad submit regardless of what this
 * card says. A second copy of the rules in a summary panel is how a screen ends up
 * claiming everything is ready for a document the server then rejects — which is why it
 * is handed the flags rather than recomputing them.
 */
export interface ChecklistItem {
  key: string;
  label: string;
  done: boolean;
  /** Not merely undone — actively wrong, and the reader must go and fix it. */
  blocked?: boolean;
  /** What to do about it. Shown only while the row is not ticked. */
  hint?: string;
}

export function SubmitChecklist({
  items,
  summary,
  className = "",
}: {
  items: ChecklistItem[];
  /** The one-line read-out of what has been built so far — lines, and their total. */
  summary?: { lines: number; quantity: number };
  className?: string;
}) {
  const outstanding = items.filter((row) => !row.done);
  const blocked = outstanding.filter((row) => row.blocked);
  const ready = outstanding.length === 0;

  return (
    <Card className={className}>
      <CardBody className="gap-3 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
            Ready to submit
          </h2>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              ready
                ? "bg-ok-bg text-ok"
                : blocked.length > 0
                  ? "bg-bad-bg text-bad"
                  : "bg-neutral-bg text-neutral"
            }`}
          >
            {ready
              ? "All set"
              : `${outstanding.length} to go`}
          </span>
        </div>

        <ul className="space-y-2.5">
          {items.map((row) => {
            const tone = row.done
              ? "text-ok"
              : row.blocked
                ? "text-bad"
                : "text-muted";
            return (
              <li key={row.key} className="flex items-start gap-2.5">
                <span className={`mt-0.5 shrink-0 ${tone}`} aria-hidden="true">
                  {row.done ? (
                    <Check className="h-4 w-4" />
                  ) : row.blocked ? (
                    <AlertTriangle className="h-4 w-4" />
                  ) : (
                    <Circle className="h-4 w-4" />
                  )}
                </span>
                <span className="min-w-0">
                  <span
                    className={`block text-sm font-medium ${
                      row.done ? "text-muted line-through decoration-line" : "text-body"
                    }`}
                  >
                    {row.label}
                    <span className="sr-only">{row.done ? " — done" : " — still to do"}</span>
                  </span>
                  {!row.done && row.hint && (
                    <span className={`mt-0.5 block text-xs ${row.blocked ? "text-bad" : "text-muted"}`}>
                      {row.hint}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>

        {/* The document as it stands. A count of nothing is still worth drawing — it is
          * the line that changes the moment the first item is picked, and a rail that
          * appears out of nowhere halfway through filling a form is worse than one that
          * was always there saying zero. */}
        {summary && (
          <div className="mt-1 grid grid-cols-2 gap-3 border-t border-line pt-3">
            <div>
              <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted">
                Items
              </span>
              <span className="mt-0.5 block font-display text-xl font-bold tabular text-ink">
                {summary.lines.toLocaleString("en-IN")}
              </span>
            </div>
            <div>
              <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted">
                Total qty
              </span>
              <span className="mt-0.5 block font-display text-xl font-bold tabular text-ink">
                {summary.quantity.toLocaleString("en-IN", { maximumFractionDigits: 3 })}
              </span>
            </div>
          </div>
        )}

        {ready && (
          <p className="rounded-xl border border-ok/25 bg-ok-bg px-3 py-2 text-xs font-medium text-ok">
            Everything an approver needs is on the return. Submit it when you are ready.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
