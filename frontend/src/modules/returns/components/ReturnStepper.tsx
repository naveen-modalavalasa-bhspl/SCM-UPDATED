import { Skeleton } from "@heroui/react";
import { Ban, Check, Clock, X } from "lucide-react";
import { roleOnly } from "../constants";
import type { JourneyPhase, JourneyState, ReturnJourney } from "../types";

/**
 * The progress tracker, drawn to match the indent's `FlowStepper` exactly —
 * same circles, same connectors, same "Stage N of M" summary — so the two documents
 * read as one system.
 *
 * The phases and their states come from `GET /api/returns/{id}/journey`, never from a
 * status-to-steps table kept here: a second copy of the flow in the browser is how a
 * rejected document ends up rendering as though the stock moved.
 *
 * A caption naming an approver is reduced to the RANK (`roleOnly`). The server sends
 * "MAHENDRA Y scm (SCM HEAD)" and a dot has about ninety pixels for it, so the label
 * wrapped over three lines and shoved its neighbours out of alignment. A rung is a rank
 * (CLAUDE.md rule 8) and the rank is the half that answers "who signs this"; the holder is
 * named in full on the current-stage line directly below, in the approval trail and on the
 * journey screen, so the name is unstacked rather than lost.
 */
/** Must match the leg COUNT in `enums.PHASES_APPROVAL_FIRST` — 8 legs: draft, submitted,
 *  approval, decision, sign-off, logistics, movement, acknowledged. Only the count is
 *  pinned here, never the sequence: the backend sends the legs in the order this document
 *  actually travels, and a row raised under the older order sends the same 8 in a
 *  different sequence (`enums.PHASES`). The tracker went from six legs to seven when the
 *  decision desk and the sign-off were split apart; the grid stayed at six, so the
 *  seventh leg wrapped onto its own row. Now 8. */
const PHASE_COUNT = 8;

const HALTED_STATES: JourneyState[] = ["rejected", "cancelled"];

function iconFor(state: JourneyState, index: number) {
  if (state === "completed") return <Check className="h-4 w-4" />;
  if (state === "current") return <Clock className="h-4 w-4" />;
  if (state === "rejected") return <X className="h-4 w-4" />;
  if (state === "cancelled") return <Ban className="h-4 w-4" />;
  return index + 1;
}

/* The indent stepper's `--color-step-*` fills exactly - filled means done, same halo
 * on the live step - because the two documents are meant to read as one system. See
 * the token block in `index.css`. */
function stateClasses(state: JourneyState) {
  const classes: Record<JourneyState, string> = {
    completed: "border-transparent bg-step-done text-white",
    current: "border-transparent bg-step-live text-white ring-4 ring-step-live/20",
    pending: "border-line bg-content1 text-muted",
    rejected: "border-transparent bg-step-bad text-white",
    cancelled: "border-transparent bg-step-off text-white",
  };
  return classes[state] ?? classes.pending;
}

function connectorClass(left: JourneyState, right: JourneyState) {
  const halted = HALTED_STATES.includes(right);
  return left === "completed" && !halted ? "bg-step-done-rail" : "bg-line";
}

/* The label under a dot. The live leg is the one the reader is looking for, so it is the
 * one carrying weight and colour; a leg nobody has reached yet stays quiet. */
function labelClass(state: JourneyState) {
  if (state === "current") return "text-step-live";
  if (state === "pending") return "text-muted";
  if (state === "rejected") return "text-bad";
  return "text-body";
}

function captionFor(phase: JourneyPhase) {
  if (phase.caption) return phase.caption;
  const fallback: Record<JourneyState, string> = {
    completed: "Completed",
    current: "Current",
    pending: "Pending",
    rejected: "Rejected",
    cancelled: "Cancelled",
  };
  return fallback[phase.state] ?? "";
}

function StepperSkeleton() {
  return (
    <div
      className="-mx-1 min-h-20 overflow-hidden px-1 pb-1"
      role="status"
      aria-label="Loading return progress"
    >
      {/* Mirrors the real phase grid so nothing shifts when the data lands. */}
      <div className="grid grid-cols-1 items-start gap-1 lg:grid-cols-8 lg:gap-0">
        {Array.from({ length: PHASE_COUNT }, (_unused, index) => (
          <div
            key={index}
            className="flex min-w-0 items-center gap-2 px-1 lg:flex-col lg:gap-0"
          >
            <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
            <div className="w-full min-w-0 max-w-24">
              <Skeleton className="h-2.5 w-full max-w-16 rounded lg:mt-2" />
              <Skeleton className="mt-1 h-2 w-full max-w-12 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ReturnStepper({
  journey,
  isLoading = false,
}: {
  journey?: ReturnJourney;
  isLoading?: boolean;
}) {
  const phases = journey?.phases ?? [];

  if (isLoading && phases.length === 0) return <StepperSkeleton />;

  if (phases.length === 0) {
    return (
      <div className="rounded-md border border-bad/30 bg-bad-bg px-3 py-2 text-sm font-medium text-bad">
        Status unavailable
      </div>
    );
  }

  const summaryIndex = Math.min(
    Math.max((journey?.current_sequence ?? 1) - 1, 0),
    phases.length - 1,
  );

  return (
    <div role="group" className="-mx-1 overflow-hidden px-1 pb-1" aria-label="Return progress">
      <ol
        className="grid min-w-0 grid-cols-1 items-start gap-1 lg:grid-cols-8 lg:gap-0"
        data-testid="return-progress"
      >
        {phases.map((phase, index) => (
          <li
            key={phase.key}
            className="relative flex min-w-0 items-center gap-3 px-1 text-left lg:flex-col lg:gap-0 lg:text-center"
          >
            {index > 0 && (
              <span
                className={`absolute left-0 top-4 hidden h-0.5 w-1/2 -translate-y-1/2 lg:block ${connectorClass(phases[index - 1].state, phase.state)}`}
                aria-hidden="true"
              />
            )}
            {index < phases.length - 1 && (
              <>
                <span
                  className={`absolute right-0 top-4 hidden h-0.5 w-1/2 -translate-y-1/2 lg:block ${connectorClass(phase.state, phases[index + 1].state)}`}
                  aria-hidden="true"
                />
                {/* The vertical rail is what keeps the steps connected once the grid
                 * collapses to a single column on a phone. */}
                <span
                  className={`absolute left-5 top-9 h-[calc(100%+0.25rem)] w-0.5 -translate-x-1/2 lg:hidden ${connectorClass(phase.state, phases[index + 1].state)}`}
                  aria-hidden="true"
                />
              </>
            )}
            <span
              aria-label={`${phase.label}, ${phase.state}${phase.caption ? `: ${phase.caption}` : ""}`}
              className={`relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full border text-[11px] font-bold transition-colors ${stateClasses(phase.state)}`}
            >
              {iconFor(phase.state, index)}
            </span>
            <div className="w-full min-w-0 max-w-28 text-left lg:mx-auto lg:text-center">
              <span
                className={`block text-balance break-words text-[11px] font-semibold leading-[14px] lg:mt-2 lg:min-h-7 ${labelClass(phase.state)}`}
              >
                {phase.label}
              </span>
              {/* The rank, not the holder — see the note at the top of this file. The full
                * label stays on the element's `title`, so the name is one hover away. */}
              <span
                title={captionFor(phase)}
                className="mt-0.5 block max-w-full break-words text-[10px] font-medium leading-3 text-muted"
              >
                {roleOnly(captionFor(phase))}
              </span>
            </div>
          </li>
        ))}
      </ol>

      {journey?.current_stage_message && (
        <div className="mt-4 rounded-xl border border-line bg-content2/50 px-3.5 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">
            Current stage
          </p>
          <p className="mt-1 break-words text-sm font-bold text-ink">
            Stage {summaryIndex + 1} of {phases.length} · {phases[summaryIndex].label}
          </p>
          <p className="mt-0.5 break-words text-xs font-medium text-body">
            {journey.current_stage_message}
          </p>
        </div>
      )}
    </div>
  );
}
