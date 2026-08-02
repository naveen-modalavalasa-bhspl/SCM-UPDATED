import { Skeleton } from "@heroui/react";
import { Check, Circle, Clock, Minus, X } from "lucide-react";
import type { FulfilmentStep, IndentJourney, IndentJourneyStage } from "../types";

type StepState = "completed" | "current" | "pending" | "rejected" | "returned" | "skipped" | "unknown";

interface SummaryStep {
  key: string;
  label: string;
  state: StepState;
  caption?: string;
}

interface FlowStepperProps {
  status: string;
  journey?: IndentJourney;
  isLoading?: boolean;
  /**
   * What physically happened to the goods, appended after the approval stages.
   * The approval journey ends at "Ready for Allocation"; everything the warehouse then
   * did to the order used to be invisible here.
   */
  fulfilment?: FulfilmentStep[];
}

function statusCaption(state: StepState) {
  const captions: Record<StepState, string> = {
    completed: "Completed",
    current: "Current",
    pending: "Pending",
    rejected: "Rejected",
    returned: "Returned",
    skipped: "Not required",
    unknown: "Status unavailable",
  };
  return captions[state];
}

function stateFromStage(stage?: IndentJourneyStage): StepState {
  if (!stage) return "pending";
  if (stage.status === "REJECTED") return "rejected";
  if (stage.status === "RETURNED") return "returned";
  if (stage.status === "NOT_REQUIRED") return "skipped";
  if (stage.is_current) return "current";
  if (stage.status === "APPROVED" || stage.status === "SUBMITTED") return "completed";
  if (stage.status === "PENDING") return "pending";
  return "unknown";
}

function compactFinalLabel(title?: string | null) {
  if (!title) return "Final Approval";
  return title
    .replace(/\s*-\s*/g, " - ")
    .replace(/\bor\b/gi, "/")
    .replace(/\s*\/\s*/g, "/");
}

function stageLabel(stage: IndentJourneyStage) {
  if (stage.stage_type === "request") return stage.status === "SUBMITTED" ? "Submitted" : "Draft";
  if (stage.stage_type === "final") return compactFinalLabel(stage.title);
  return stage.title;
}

function stageCaption(stage: IndentJourneyStage, state: StepState) {
  if (stage.stage_type === "request" && stage.approver_name) return stage.approver_name;
  return statusCaption(state);
}

function buildSteps(status: string, journey?: IndentJourney): SummaryStep[] | null {
  if (!journey || !Array.isArray(journey.stages) || journey.stages.length === 0) return null;

  const sortedStages = [...journey.stages].sort((a, b) => a.sequence - b.sequence);
  const requestStage = sortedStages.find((stage) => stage.stage_type === "request");
  const workflowStages = sortedStages.filter((stage) =>
    ["approval", "final", "allocation"].includes(stage.stage_type)
  );
  const requestSubmitted = requestStage?.status === "SUBMITTED";
  const draftState: StepState = requestSubmitted ? "completed" : status === "DRAFT" ? "current" : "completed";
  const steps: SummaryStep[] = [{
    key: "draft",
    label: "Draft",
    state: draftState,
    caption: requestStage?.approver_name ?? journey.requested_by_name ?? statusCaption(draftState),
  }];

  if (requestStage && requestSubmitted) {
    const state = stateFromStage(requestStage);
    steps.push({
      key: `stage-${requestStage.sequence}`,
      label: stageLabel(requestStage),
      state,
      caption: stageCaption(requestStage, state),
    });
  }

  workflowStages.forEach((stage) => {
    const state = stateFromStage(stage);
    steps.push({
      key: `stage-${stage.sequence}-${stage.stage_type}`,
      label: stageLabel(stage),
      state,
      caption: stageCaption(stage, state),
    });
  });

  const rejectedIndex = steps.findIndex((step) => step.state === "rejected" || step.state === "returned");
  if (rejectedIndex >= 0) {
    return steps.map((step, index) => {
      if (index <= rejectedIndex) return step;
      return {
        ...step,
        state: step.state === "skipped" ? "skipped" : "pending",
        caption: step.state === "skipped" ? "Not required" : "Pending",
      };
    });
  }
  return steps;
}

function iconFor(state: StepState, index: number) {
  if (state === "completed") return <Check className="h-3.5 w-3.5" />;
  if (state === "current") return <Clock className="h-3.5 w-3.5" />;
  if (state === "rejected" || state === "returned") return <X className="h-3.5 w-3.5" />;
  if (state === "skipped") return <Minus className="h-3.5 w-3.5" />;
  if (state === "unknown") return <Circle className="h-3.5 w-3.5" />;
  return index + 1;
}

function stateClasses(state: StepState) {
  const classes: Record<StepState, string> = {
    completed: "border-ok bg-ok text-white",
    current: "border-brand bg-brand text-white shadow-sm shadow-brand/20",
    pending: "border-line bg-white text-muted",
    rejected: "border-bad bg-bad text-white",
    returned: "border-bad bg-bad text-white",
    skipped: "border-line bg-content2 text-muted",
    unknown: "border-bad/40 bg-bad-bg text-bad",
  };
  return classes[state];
}

function connectorClass(left: StepState, right: StepState) {
  if (left === "completed" && right !== "rejected" && right !== "returned") return "bg-ok";
  return "bg-line";
}

function FlowStepperSkeleton() {
  return (
    <div
      className="-mx-1 min-h-20 overflow-hidden px-1 pb-1"
      role="status"
      aria-label="Loading approval progress"
    >
      {/* mobile-ok: loading placeholder — four 8px dots, no content to squash. */}
      <div className="grid grid-cols-4 items-start gap-2" data-testid="approval-progress-skeleton">
        {[0, 1, 2, 3].map((step) => (
          <div key={step} className="flex min-w-0 flex-col items-center px-1">
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="mt-2 h-3 w-full max-w-20 rounded" />
            <Skeleton className="mt-1 h-2.5 w-full max-w-14 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function FlowStepper({
  status, journey, isLoading = false, fulfilment,
}: FlowStepperProps) {
  const approvalSteps = buildSteps(status, journey);
  // Only once approval is genuinely done. Showing "Issued from store" beside a request
  // that was rejected, or is still with an approver, would promise a delivery that is
  // not coming.
  const approvalSettled = !!approvalSteps?.length
    && approvalSteps.every((step) => step.state === "completed" || step.state === "skipped");
  const steps = approvalSteps && approvalSettled && fulfilment?.length
    ? [...approvalSteps, ...fulfilment.map((step) => ({
        key: `fulfilment-${step.key}`,
        label: step.label,
        state: step.state as StepState,
        caption: step.caption ?? undefined,
      }))]
    : approvalSteps;

  if (isLoading && !steps) return <FlowStepperSkeleton />;

  if (!steps) {
    return (
      <div className="rounded-md border border-bad/30 bg-bad-bg px-3 py-2 text-sm font-medium text-bad">
        Status unavailable
      </div>
    );
  }

  return (
    <div className="-mx-1 overflow-x-auto px-1 pb-1" aria-label="Compact approval progress">
      <ol
        className="grid min-w-max auto-cols-[minmax(7rem,1fr)] grid-flow-col items-start gap-0 md:min-w-0"
        data-testid="compact-approval-progress"
      >
        {steps.map((step, index) => (
          <li key={step.key} className="relative flex min-w-0 flex-col items-center px-1 text-center">
            {index > 0 && (
              <span
                className={`absolute left-0 top-4 h-0.5 w-1/2 -translate-y-1/2 ${connectorClass(steps[index - 1].state, step.state)}`}
                aria-hidden="true"
              />
            )}
            {index < steps.length - 1 && (
              <span
                className={`absolute right-0 top-4 h-0.5 w-1/2 -translate-y-1/2 ${connectorClass(step.state, steps[index + 1].state)}`}
                aria-hidden="true"
              />
            )}
            <span
              aria-label={`${step.label}: ${step.caption ?? statusCaption(step.state)}`}
              className={`relative z-10 grid h-8 w-8 place-items-center rounded-full border text-xs font-bold transition-colors ${stateClasses(step.state)}`}
            >
              {iconFor(step.state, index)}
            </span>
            <span className={`mt-2 min-h-8 max-w-28 text-balance break-words text-[11px] font-semibold leading-4 ${
              step.state === "skipped" || step.state === "pending" ? "text-muted" : "text-body"
            }`}>
              {step.label}
            </span>
            {step.caption && (
              <span className="mt-0.5 text-[10px] font-medium leading-3 text-muted">{step.caption}</span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
