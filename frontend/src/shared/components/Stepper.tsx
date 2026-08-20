import { Check, Clock, X } from "lucide-react";

export interface Step {
  id: string;
  label: string;
  status: "complete" | "current" | "upcoming" | "error";
  description?: string;
}

/**
 * The document progress rail — the same shape the Indents flow stepper uses.
 *
 * REDESIGNED 2026-08-20. It used to be an absolutely-positioned row: fixed `pr-20`
 * gaps between the dots and the labels hung off `absolute top-10`, outside the
 * element's own box. That made it wrong in three ways at once — the row could not
 * centre itself in the card, long labels overlapped their neighbours, and the rail ran
 * off the side of a narrow screen with no way to reach the end of it. The labels being
 * out of flow also meant the container had to reserve their height by guesswork.
 *
 * This is a grid instead: one column per step, connectors drawn as two half-width
 * lines that meet under the circle, and the label in normal flow beneath it. Columns
 * share the width evenly however many steps there are, and on a narrow screen the rail
 * scrolls sideways inside its own box rather than crushing five labels into single
 * characters. Same `Step[]` API, so every caller gained it without a change.
 *
 * The state colours are deliberately the Indents ones (ok / brand / line): two rails
 * in one product that disagree about what "done" looks like is worse than either.
 */

function iconFor(status: Step["status"], index: number) {
  if (status === "complete") return <Check className="h-3.5 w-3.5" />;
  if (status === "current") return <Clock className="h-3.5 w-3.5" />;
  if (status === "error") return <X className="h-3.5 w-3.5" />;
  return index + 1;
}

function circleClass(status: Step["status"]) {
  const classes: Record<Step["status"], string> = {
    complete: "border-ok bg-ok text-white",
    current: "border-brand bg-brand text-white shadow-sm shadow-brand/20",
    upcoming: "border-line bg-content1 text-muted",
    error: "border-bad bg-bad text-white",
  };
  return classes[status];
}

/** A leg is only "done" when the step behind it is, and nothing has gone wrong ahead. */
function connectorClass(left: Step["status"], right: Step["status"]) {
  if (left === "complete" && right !== "error") return "bg-ok";
  return "bg-line";
}

function labelClass(status: Step["status"]) {
  if (status === "current") return "text-brand";
  if (status === "error") return "text-bad";
  if (status === "upcoming") return "text-muted";
  return "text-body";
}

export function Stepper({ steps, className = "" }: { steps: Step[]; className?: string }) {
  if (!steps.length) return null;

  return (
    <nav aria-label="Progress" className={`overflow-x-auto px-2 py-4 ${className}`}>
      {/* Columns are set inline, not with a `grid-cols-N` class: Tailwind cannot
        * generate a class from a runtime value and the number of steps differs per
        * document. `min-w-[32rem]` with the scroller below keeps a five-step rail
        * readable on a phone instead of crushing the labels into single characters. */}
      <ol
        className="grid min-w-[32rem] items-start gap-0"
        style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
      >
        {steps.map((step, index) => (
          <li
            key={step.id}
            className="relative flex min-w-0 flex-col items-center px-1 text-center"
            aria-current={step.status === "current" ? "step" : undefined}
          >
            {index > 0 && (
              <span
                className={`absolute left-0 top-4 h-0.5 w-1/2 -translate-y-1/2 ${
                  connectorClass(steps[index - 1].status, step.status)}`}
                aria-hidden="true"
              />
            )}
            {index < steps.length - 1 && (
              <span
                className={`absolute right-0 top-4 h-0.5 w-1/2 -translate-y-1/2 ${
                  connectorClass(step.status, steps[index + 1].status)}`}
                aria-hidden="true"
              />
            )}
            <span
              className={`relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full border text-xs font-bold transition-colors ${circleClass(step.status)}`}
            >
              {iconFor(step.status, index)}
              <span className="sr-only">{step.label}</span>
            </span>
            <span
              className={`mt-2 block max-w-28 text-balance break-words text-[11px] font-semibold leading-4 ${labelClass(step.status)}`}
            >
              {step.label}
            </span>
            {step.description && (
              <span className="mt-0.5 block max-w-28 break-words text-[10px] font-medium leading-3 text-muted">
                {step.description}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
