import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@heroui/react";
import { Ban, Check, Clock, X } from "lucide-react";
import { Card } from "@/shared/components";
import { returnsApi } from "../api";
import type { ApprovalFlowStep, JourneyState } from "../types";

/**
 * The approval this return WILL follow — the route ahead, not the trail behind.
 *
 * ADDED 2026-09-07. Where the return names an indent, this is the INDENT's chain: a
 * storekeeper's indent already has an approval flow configured for his rank, and the
 * return that undoes that request goes past the same people.
 *
 * Two ways in, because the flow has to be visible before the document exists:
 *
 *   * `indentId` — on the form, as the raiser picks an indent.
 *   * `returnId` — on the detail screen, for a return that has already been raised.
 *
 * DRAWN AS A STEPPER (2026-09-07), across the top of the page and in the same visual
 * language as the indent's `FlowStepper` and this module's `ReturnStepper` — same
 * circles, same rails, same "Stage N of M" summary — so the three read as one system.
 *
 * Every state on it is SERVED. `GET .../approval-flow` reads each rung's state off the
 * press made on it (`wf_actions`) and off the live instance's `current_sequence`, and
 * once the chain has started it draws the instance's FROZEN `resolved_chain` rather than
 * a fresh preview — editing a ladder must never move a document already in approval.
 * Nothing here maps a document status onto a step: a second copy of the flow in the
 * browser is how a rejected return ends up rendering as though it were still live.
 *
 * Before the chain starts (a draft, or a return still at the decision desk) every rung is
 * `pending` and `is_live` is false — a forecast, and the panel says so.
 *
 * `is_configured: false` is deliberately its own state: "nobody is configured" and
 * "configured to need no signature" are different answers and the second is a real
 * choice an admin can make.
 */

function iconFor(state: JourneyState, index: number) {
  if (state === "completed") return <Check className="h-3.5 w-3.5" />;
  if (state === "current") return <Clock className="h-3.5 w-3.5" />;
  if (state === "rejected") return <X className="h-3.5 w-3.5" />;
  if (state === "cancelled") return <Ban className="h-3.5 w-3.5" />;
  return index + 1;
}

/* The stepper tokens from `index.css`, the same ones the journey tracker fills its
 * circles with — filled means done, the halo marks the live rung. */
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
  const halted = right === "rejected" || right === "cancelled";
  return left === "completed" && !halted ? "bg-step-done-rail" : "bg-line";
}

/** The people on a rung, or the fact that there is nobody in the chair. */
function peopleOf(step: ApprovalFlowStep) {
  if (step.actor_name) return step.actor_name;
  if (step.approver_names.length > 0) return step.approver_names.join(", ");
  return "Nobody in this chair";
}

function FlowSkeleton() {
  return (
    <div className="-mx-1 min-h-16 px-1 pb-1" role="status" aria-label="Loading approval flow">
      <div className="grid grid-cols-1 items-start gap-1 lg:auto-cols-fr lg:grid-flow-col lg:gap-0">
        {Array.from({ length: 3 }, (_unused, index) => (
          <div key={index} className="flex min-w-0 items-center gap-2 px-1 lg:flex-col lg:gap-0">
            <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
            <div className="w-full min-w-0 max-w-28">
              <Skeleton className="h-2.5 w-full max-w-20 rounded lg:mt-1.5" />
              <Skeleton className="mt-1 h-2 w-full max-w-12 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ApprovalFlowPanel({
  indentId,
  returnId,
  className = "",
}: {
  indentId?: number | null;
  returnId?: number;
  className?: string;
}) {
  const byReturn = returnId !== undefined;
  const { data: flow, isLoading } = useQuery({
    queryKey: byReturn
      ? ["returns", returnId, "approval-flow"]
      : ["returns", "approval-flow", indentId ?? null],
    queryFn: () =>
      byReturn
        ? returnsApi.approvalFlow(returnId as number)
        : returnsApi.approvalFlowFor(indentId ?? null),
  });

  const steps = flow?.steps ?? [];
  // The rung the document is sitting on, else the one that stopped it, else the last —
  // the same choice the indent's stepper makes for its own summary line.
  const summaryIndex = (() => {
    const current = steps.findIndex((step) => step.state === "current");
    if (current >= 0) return current;
    const halted = steps.findIndex(
      (step) => step.state === "rejected" || step.state === "cancelled",
    );
    if (halted >= 0) return halted;
    return steps.length - 1;
  })();

  return (
    <Card className={`p-5 ${className}`}>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
          Approval flow
        </h2>
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
          {flow?.indent_no && (
            <span>
              Following indent{" "}
              <span className="font-semibold text-ink">{flow.indent_no}</span>
            </span>
          )}
          {/* Said out loud, because a forecast and a signed chain look identical
            * otherwise and only one of them is a fact about this document. */}
          {flow && steps.length > 0 && !flow.is_live && <span>· not started yet</span>}
        </div>
      </div>

      {isLoading && !flow && <FlowSkeleton />}

      {!isLoading && !flow && (
        <p className="text-sm text-muted">The approval flow could not be read.</p>
      )}

      {flow && steps.length > 0 && (
        <div role="group" className="-mx-1 px-1 pb-1" aria-label="Approval progress">
          <ol
            className="grid min-w-0 grid-cols-1 items-start gap-1 lg:auto-cols-fr lg:grid-flow-col lg:gap-0"
            data-testid="return-approval-flow"
          >
            {steps.map((step, index) => (
              <li
                key={step.sequence}
                className="relative flex min-w-0 items-center gap-3 px-1 text-left lg:flex-col lg:gap-0 lg:text-center"
              >
                {index > 0 && (
                  <span
                    className={`absolute left-0 top-4 hidden h-0.5 w-1/2 -translate-y-1/2 lg:block ${connectorClass(steps[index - 1].state, step.state)}`}
                    aria-hidden="true"
                  />
                )}
                {index < steps.length - 1 && (
                  <>
                    <span
                      className={`absolute right-0 top-4 hidden h-0.5 w-1/2 -translate-y-1/2 lg:block ${connectorClass(step.state, steps[index + 1].state)}`}
                      aria-hidden="true"
                    />
                    {/* The vertical rail keeps the rungs connected once the grid
                      * collapses to one column on a phone. */}
                    <span
                      className={`absolute left-5 top-8 h-[calc(100%+0.25rem)] w-0.5 -translate-x-1/2 lg:hidden ${connectorClass(step.state, steps[index + 1].state)}`}
                      aria-hidden="true"
                    />
                  </>
                )}
                <span
                  aria-label={`${step.name}, ${step.caption ?? step.state}`}
                  className={`relative z-10 grid h-7 w-7 shrink-0 place-items-center rounded-full border text-[11px] font-bold transition-colors ${stateClasses(step.state)}`}
                >
                  {iconFor(step.state, index)}
                </span>
                <div className="w-full min-w-0 max-w-32 text-left lg:mx-auto lg:text-center">
                  <span
                    className={`block text-balance break-words text-[10px] font-semibold uppercase leading-3 tracking-wider lg:mt-1.5 lg:min-h-7 ${
                      step.state === "pending" ? "text-muted" : "text-body"
                    }`}
                  >
                    {step.name}
                  </span>
                  <span className="mt-0.5 block max-w-full break-words text-[10px] font-medium leading-3 text-muted">
                    {step.caption ?? ""}
                  </span>
                  {/* The people, not just the chair. A rung names everybody who may sign
                    * it — any one of them is enough (ANY_ONE is the ladder's mode) — and
                    * once it is signed it names whoever actually did. */}
                  <span className="mt-1 block max-w-full break-words text-[10px] leading-3 text-muted">
                    {peopleOf(step)}
                  </span>
                </div>
              </li>
            ))}
          </ol>

          {flow.current_stage_message && (
            <div className="mt-3 border-t border-line pt-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                Current stage
              </p>
              {summaryIndex >= 0 && (
                <p className="mt-0.5 break-words text-xs font-semibold text-body">
                  Stage {summaryIndex + 1} of {steps.length} · {steps[summaryIndex].name}
                </p>
              )}
              <p className="mt-0.5 break-words text-xs font-semibold text-body">
                {flow.current_stage_message}
              </p>
            </div>
          )}
        </div>
      )}

      {!isLoading && flow && steps.length === 0 && (
        <p className="text-sm text-muted">
          {flow.is_configured
            ? "No signature is needed at this stage."
            : "No chain is configured — the return goes up the reporting line."}
        </p>
      )}

      {!isLoading && flow?.note && (
        <p className="mt-3 border-t border-line pt-3 text-xs text-muted">{flow.note}</p>
      )}
    </Card>
  );
}
