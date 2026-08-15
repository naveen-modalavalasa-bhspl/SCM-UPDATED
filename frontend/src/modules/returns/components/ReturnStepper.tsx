import { Skeleton } from "@heroui/react";
import { Ban, Check, Clock, X } from "lucide-react";
import type { JourneyPhase, JourneyState, ReturnJourney } from "../types";

/**
 * The progress tracker, drawn to match the indent's `FlowStepper` exactly —
 * same circles, same connectors, same "Stage N of M" summary — so the two documents
 * read as one system.
 *
 * The phases and their states come from `GET /api/returns/{id}/journey`, never from a
 * status-to-steps table kept here: a second copy of the flow in the browser is how a
 * rejected document ends up rendering as though the stock moved.
 */
/** Must match `enums.PHASES`. The tracker went from six legs to seven when the decision
 *  desk and the sign-off were split apart; the grid stayed at six, so the seventh leg
 *  wrapped onto its own row and every connector after it pointed at nothing. */
const PHASE_COUNT = 7;

function iconFor(state: JourneyState, index: number) {
  if (state === "completed") return <Check className="h-3.5 w-3.5" />;
  if (state === "current") return <Clock className="h-3.5 w-3.5" />;
  if (state === "rejected") return <X className="h-3.5 w-3.5" />;
  if (state === "cancelled") return <Ban className="h-3.5 w-3.5" />;
  return index + 1;
}

function stateClasses(state: JourneyState) {
  const classes: Record<JourneyState, string> = {
    completed: "border-ok bg-ok text-white",
    current: "border-brand bg-brand text-white shadow-sm shadow-brand/20",
    pending: "border-line bg-white text-muted",
    rejected: "border-bad bg-bad text-white",
    cancelled: "border-neutral bg-neutral text-white",
  };
  return classes[state] ?? classes.pending;
}

function connectorClass(left: JourneyState, right: JourneyState) {
  const halted = right === "rejected" || right === "cancelled";
  return left === "completed" && !halted ? "bg-ok" : "bg-line";
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
      <div className="grid grid-cols-1 items-start gap-2 lg:grid-cols-7 lg:gap-0">
        {Array.from({ length: PHASE_COUNT }, (_unused, index) => (
          <div
            key={index}
            className="flex min-w-0 items-center gap-3 px-1 lg:flex-col lg:gap-0"
          >
            <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
            <div className="w-full min-w-0 max-w-28">
              <Skeleton className="h-3 w-full max-w-20 rounded lg:mt-2" />
              <Skeleton className="mt-1 h-2.5 w-full max-w-14 rounded" />
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
        className="grid min-w-0 grid-cols-1 items-start gap-2 lg:grid-cols-7 lg:gap-0"
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
                  className={`absolute left-5 top-8 h-[calc(100%+0.5rem)] w-0.5 -translate-x-1/2 lg:hidden ${connectorClass(phase.state, phases[index + 1].state)}`}
                  aria-hidden="true"
                />
              </>
            )}
            <span
              aria-label={`${phase.label}, ${phase.state}${phase.caption ? `: ${phase.caption}` : ""}`}
              className={`relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full border text-xs font-bold transition-colors ${stateClasses(phase.state)}`}
            >
              {iconFor(phase.state, index)}
            </span>
            <div className="w-full min-w-0 max-w-28 text-left lg:mx-auto lg:text-center">
              <span
                className={`block text-balance break-words text-[11px] font-semibold leading-4 lg:mt-2 lg:min-h-8 ${
                  phase.state === "pending" ? "text-muted" : "text-body"
                }`}
              >
                {phase.label}
              </span>
              <span className="mt-0.5 block max-w-full break-words text-[10px] font-medium leading-3 text-muted">
                {captionFor(phase)}
              </span>
            </div>
          </li>
        ))}
      </ol>

      {journey?.current_stage_message && (
        <div className="mt-3 border-t border-line pt-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">
            Current stage
          </p>
          <p className="mt-0.5 break-words text-xs font-semibold text-body">
            Stage {summaryIndex + 1} of {phases.length} · {phases[summaryIndex].label}
          </p>
          <p className="mt-0.5 break-words text-xs font-semibold text-body">
            {journey.current_stage_message}
          </p>
        </div>
      )}
    </div>
  );
}
