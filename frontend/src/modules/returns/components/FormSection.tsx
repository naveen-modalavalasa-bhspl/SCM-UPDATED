import type { ReactNode } from "react";
import { Check, Lock } from "lucide-react";
import { CardBody } from "@heroui/react";
import { Card } from "@/shared/components";

/**
 * One numbered step of the raise form.
 *
 * ADDED 2026-09-07. The form had three cards of equal weight with no stated order, and
 * the question that GATED the other two (which indent is this coming back from?) sat in
 * the narrow right-hand rail while the card it gated filled the wide left one. So the
 * page opened with the eye landing on a locked, empty Line items card carrying a note
 * telling the reader to look somewhere else first. Numbering the steps and putting them
 * in the order they must be answered is the whole fix; the fields inside them are
 * unchanged.
 *
 * The badge is the module stepper's own circle — `bg-step-done` filled with a tick once
 * the step is satisfied, an outlined number until then — so "done" means the same thing
 * and wears the same colour here as it does on the approval flow above it and on the
 * journey tracker on the detail page. A locked step shows a padlock instead of its
 * number, because a step that cannot be answered yet and a step nobody has got to yet
 * look identical otherwise.
 *
 * `done` is presentational only. What may actually be saved or submitted is decided by
 * the form's own `canSave` / `canSubmit` and, after that, by the server.
 */
export function FormSection({
  step,
  title,
  hint,
  done = false,
  locked = false,
  current = false,
  required = false,
  aside,
  children,
  className = "",
}: {
  step: number;
  title: string;
  /** The sentence under the heading. Says what the step is for, once. */
  hint?: string;
  done?: boolean;
  locked?: boolean;
  /**
   * The step to fill in next — the first one that is neither done nor locked.
   *
   * ADDED 2026-09-07. Without it a fresh form drew step 1 and step 3 in the same grey
   * outline, so nothing on the screen said where to start; the reader picked the top
   * card because it was the top card, not because it was marked. It wears the module
   * stepper's live rung exactly — `bg-step-live` with its halo — so "you are here"
   * means the same thing and is the same colour on this form, on the approval flow
   * below it and on the journey tracker on the detail page.
   */
  current?: boolean;
  /** Draws the same asterisk `Field` draws — "you cannot submit without this". */
  required?: boolean;
  /** A read-out on the right of the heading — a count, a total, a status word. */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  /* The four states, in the order they beat each other: signed off, cannot be reached
   * yet, next to do, not yet. Same tokens as `ReturnStepper` and `ApprovalFlowPanel`. */
  const badge = done
    ? "border-transparent bg-step-done text-white"
    : locked
      ? "border-line bg-content2 text-muted"
      : current
        ? "border-transparent bg-step-live text-white ring-4 ring-step-live/20"
        : "border-line bg-content1 text-muted";

  return (
    <Card className={className}>
      <CardBody className="gap-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <div className="flex min-w-0 items-start gap-3">
            <span
              aria-hidden="true"
              className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border text-[11px] font-bold transition-colors ${badge}`}
            >
              {done ? (
                <Check className="h-3.5 w-3.5" />
              ) : locked ? (
                <Lock className="h-3 w-3" />
              ) : (
                step
              )}
            </span>
            <div className="min-w-0">
              <h2
                className={`text-sm font-semibold uppercase tracking-wider ${
                  current && !done ? "text-body" : "text-muted"
                }`}
              >
                <span className="sr-only">{`Step ${step}: `}</span>
                {title}
                {required && (
                  <>
                    <span aria-hidden="true" className="ml-0.5 text-danger">*</span>
                    <span className="sr-only"> (required)</span>
                  </>
                )}
              </h2>
              {hint && <p className="mt-1 max-w-prose text-xs text-muted">{hint}</p>}
            </div>
          </div>
          {aside && <div className="shrink-0 text-xs font-semibold text-muted">{aside}</div>}
        </div>
        {children}
      </CardBody>
    </Card>
  );
}
