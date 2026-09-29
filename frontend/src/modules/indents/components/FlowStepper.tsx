import { Skeleton } from "@heroui/react";
import { Ban, Check, Circle, Clock, Minus, Undo2, X } from "lucide-react";
import {
  INDENT_APPROVAL_STAGE_TYPES, INDENT_APPROVALS_PHASE_INDEX, INDENT_PHASES,
  INDENT_PROCUREMENT_STATUSES, INDENT_STATUS,
} from "../constants";
import type { IndentJourney, IndentJourneyStage, RaiserTracking } from "../types";
import { tripProgressText } from "./tripLeg";

type StepState =
  | "completed" | "current" | "pending" | "rejected" | "returned" | "cancelled"
  | "skipped" | "unknown";

interface SummaryStep {
  key: string;
  label: string;
  state: StepState;
  caption?: string;
}

interface FlowStepperProps {
  status: string;
  journey?: IndentJourney;
  /** Present only for the raiser. These legs replace the old warehouse delivery guess. */
  shipments?: RaiserTracking[];
  isLoading?: boolean;
}

const PHASES = INDENT_PHASES;

/** Every status the fallback can reason about — the module owns this list. */
const RECOGNISED_STATUSES = new Set<string>(Object.values(INDENT_STATUS));

const PROCUREMENT_STATUSES = new Set(INDENT_PROCUREMENT_STATUSES);

const POST_APPROVAL_STATUSES = new Set<string>([
  INDENT_STATUS.APPROVED,
  INDENT_STATUS.AWAITING_ALLOCATION,
  INDENT_STATUS.ALLOCATED,
  INDENT_STATUS.PARTIALLY_FULFILLED,
  ...INDENT_PROCUREMENT_STATUSES,
  INDENT_STATUS.CLOSED,
]);

const PROCUREMENT_MESSAGES: Record<string, string> = {
  [INDENT_STATUS.PENDING_PROCUREMENT]: "Not in stock — with procurement",
  [INDENT_STATUS.PARTIALLY_ORDERED]: "Partly ordered — with procurement",
  [INDENT_STATUS.ORDERED]: "Ordered — waiting for goods receipt",
};

/** A phase reached here stops the flow; nothing after it may claim progress. */
const HALTED_STATES: StepState[] = ["rejected", "returned", "cancelled"];

function isHalted(state: StepState) {
  return HALTED_STATES.includes(state);
}

function statusCaption(state: StepState) {
  const captions: Record<StepState, string> = {
    completed: "Completed",
    current: "Current",
    pending: "Pending",
    rejected: "Rejected",
    returned: "Returned for correction",
    cancelled: "Cancelled",
    skipped: "Not required",
    unknown: "Status unavailable",
  };
  return captions[state];
}

function stateFromStage(stage?: IndentJourneyStage): StepState {
  if (!stage) return "pending";
  const status = String(stage.status ?? "").trim().toUpperCase();
  if (status === "REJECTED") return "rejected";
  if (status === "RETURNED" || status === INDENT_STATUS.RETURNED_FOR_CORRECTION) return "returned";
  if (status === "CANCELLED") return "cancelled";
  if (status === "NOT_REQUIRED" || status === "SKIPPED") return "skipped";
  if (stage.is_current) return "current";
  if (status === "APPROVED" || status === "SUBMITTED" || status === "COMPLETED") return "completed";
  if (status === "PENDING") return "pending";
  return "unknown";
}

/**
 * The backend puts a phase's explanatory message on `approver_name` (see the
 * `phase()` helper it is built with). Approvals uses it for who holds the document;
 * Allocation uses it to say the shortfall went to procurement rather than leaving a
 * bare "Current" that reads the same as an indent nobody has looked at yet.
 */
const CAPTIONED_PHASE_KEYS = ["approvals", "allocation"];

function stageCaption(phaseKey: string, stage: IndentJourneyStage, state: StepState) {
  if (CAPTIONED_PHASE_KEYS.includes(phaseKey) && state === "current" && stage.approver_name) {
    return stage.approver_name;
  }
  return statusCaption(state);
}

function activeApprovalStage(journey: IndentJourney) {
  return journey.stages?.find((stage) => (
    stage.is_current
    && String(stage.status ?? "").trim().toUpperCase() === "PENDING"
    && INDENT_APPROVAL_STAGE_TYPES.includes(String(stage.stage_type))
  ));
}

function approvalPhaseState(
  journey: IndentJourney,
  phase: IndentJourneyStage,
  statusValue: string,
): StepState {
  const status = String(statusValue || journey.status || "").trim().toUpperCase();
  if (status === INDENT_STATUS.REJECTED) return "rejected";
  if (status === INDENT_STATUS.RETURNED || status === INDENT_STATUS.RETURNED_FOR_CORRECTION) {
    return "returned";
  }
  if (
    status === INDENT_STATUS.PENDING_APPROVAL
    || status === INDENT_STATUS.SUBMITTED
    || activeApprovalStage(journey)
  ) {
    return "current";
  }
  if (POST_APPROVAL_STATUSES.has(status)) return "completed";

  const state = stateFromStage(phase);
  return isHalted(state) ? "pending" : state;
}

/**
 * The configured ladder, read straight off the resolved chain: never a fixed set
 * of ranks, and never a fixed length. Peers of an ANY_ONE rung are excluded so
 * the total counts decisions still owed, not authorities that could have acted.
 */
export function approvalLadder(journey?: IndentJourney) {
  const rungs = (journey?.stages ?? []).filter(
    (stage) => INDENT_APPROVAL_STAGE_TYPES.includes(String(stage.stage_type)),
  );
  if (rungs.length === 0) return null;
  const currentIndex = rungs.findIndex((stage) => stage.is_current);
  const current = currentIndex >= 0 ? rungs[currentIndex] : undefined;
  return {
    total: rungs.length,
    position: currentIndex >= 0 ? currentIndex + 1 : null,
    approverName: current?.approver_name?.trim() || null,
    positionName: current?.position_name?.trim() || null,
  };
}

function normalizeBackendSteps(journey: IndentJourney, statusValue: string): SummaryStep[] | null {
  if (!Array.isArray(journey.phases)) return null;
  const bySequence = new Map<number, IndentJourneyStage>();
  for (const stage of journey.phases) {
    if (
      !Number.isInteger(stage?.sequence)
      || stage.sequence < 1
      || stage.sequence > PHASES.length
      || bySequence.has(stage.sequence)
    ) return null;
    bySequence.set(stage.sequence, stage);
  }
  if (bySequence.size !== PHASES.length) return null;

  const steps: SummaryStep[] = [];
  for (let index = 0; index < PHASES.length; index += 1) {
    const definition = PHASES[index];
    const stage = bySequence.get(index + 1);
    if (!stage) return null;
    const state = definition.key === "approvals"
      ? approvalPhaseState(journey, stage, statusValue)
      : stateFromStage(stage);
    if (state === "unknown") return null;
    steps.push({
      key: definition.key,
      label: definition.label,
      state,
      caption: definition.key === "approvals" && state === "current"
        ? approvalDetail(journey) ?? stageCaption(definition.key, stage, state)
        : stageCaption(definition.key, stage, state),
    });
  }
  return steps;
}

function approvalDetail(journey: IndentJourney) {
  const currentStage = journey.stages?.find((stage) => (
    stage.is_current && INDENT_APPROVAL_STAGE_TYPES.includes(String(stage.stage_type))
  ));
  if (currentStage?.title?.trim()) return currentStage.title.trim();

  const approvalPhase = journey.phases?.find((stage) => (
    stage.is_current
    || String(stage.title ?? "").trim().toLowerCase().includes("approval")
  ));
  return approvalPhase?.approver_name?.trim() || undefined;
}

function fallbackSteps(statusValue: string, journey: IndentJourney): SummaryStep[] | null {
  const status = String(statusValue ?? "").trim().toUpperCase();
  if (!RECOGNISED_STATUSES.has(status)) return null;

  let states: StepState[];
  if (status === INDENT_STATUS.DRAFT) {
    states = ["current", "pending", "pending", "pending", "pending", "pending", "pending"];
  } else if (status === INDENT_STATUS.SUBMITTED || status === INDENT_STATUS.PENDING_APPROVAL) {
    states = ["completed", "completed", "current", "pending", "pending", "pending", "pending"];
  } else if (status === INDENT_STATUS.REJECTED) {
    states = ["completed", "completed", "rejected", "pending", "pending", "pending", "pending"];
  } else if (status === INDENT_STATUS.RETURNED || status === INDENT_STATUS.RETURNED_FOR_CORRECTION) {
    states = ["completed", "completed", "returned", "pending", "pending", "pending", "pending"];
  } else if (status === INDENT_STATUS.CANCELLED) {
    states = ["completed", "completed", "cancelled", "pending", "pending", "pending", "pending"];
  } else if (
    status === INDENT_STATUS.APPROVED
    || status === INDENT_STATUS.AWAITING_ALLOCATION
    // Procurement sits between allocation and the warehouse: the goods were not
    // issued from stock, so no warehouse progress may be claimed.
    || PROCUREMENT_STATUSES.has(status)
  ) {
    states = ["completed", "completed", "completed", "current", "pending", "pending", "pending"];
  } else if (status === INDENT_STATUS.CLOSED) {
    states = ["completed", "completed", "completed", "completed", "completed", "completed", "completed"];
  } else {
    states = ["completed", "completed", "completed", "completed", "current", "pending", "pending"];
  }

  const detail = approvalDetail(journey);
  return PHASES.map((phase, index) => ({
    key: phase.key,
    label: phase.label,
    state: states[index],
    caption: phase.key === "approvals" && states[index] === "current" && detail
      ? detail : statusCaption(states[index]),
  }));
}

function buildSteps(status: string, journey?: IndentJourney): SummaryStep[] | null {
  if (!journey) return null;
  const effectiveStatus = status || journey.status;
  const steps = normalizeBackendSteps(journey, effectiveStatus)
    ?? fallbackSteps(effectiveStatus, journey);
  if (!steps) return null;

  const haltedIndex = steps.findIndex((step) => isHalted(step.state));
  if (haltedIndex >= 0) {
    return steps.map((step, index) => {
      if (index <= haltedIndex) return step;
      return {
        ...step,
        state: step.state === "skipped" ? "skipped" : "pending",
        caption: step.state === "skipped" ? "Not required" : "Pending",
      };
    });
  }
  return steps;
}

const ARRIVED_SHIPMENT_STATUSES = new Set(["DELIVERED", "ACKNOWLEDGED", "CLOSED"]);
const SIGNED_SHIPMENT_STATUSES = new Set(["ACKNOWLEDGED", "CLOSED"]);

function shipmentLocation(shipments: RaiserTracking[]) {
  const events = shipments.flatMap((leg) => leg.events ?? []);
  return [...events]
    .sort((left, right) => Date.parse(right.event_at) - Date.parse(left.event_at))
    .find((event) => event.location_name?.trim())?.location_name?.trim();
}

/**
 * Once logistics has a leg, it is the source of truth for the final two steps.
 * The old journey contract stops at warehouse dispatch and cannot tell whether a
 * courier is still moving, has delivered, or the raiser has actually signed.
 */
function applyShipmentProgress(
  steps: SummaryStep[],
  shipments: RaiserTracking[] | undefined,
) {
  if (shipments === undefined) return steps;
  const deliveryIndex = steps.findIndex((step) => step.key === "delivery");
  const receiptIndex = steps.findIndex((step) => step.key === "acknowledgement");
  if (deliveryIndex < 0 || receiptIndex < 0) return steps;

  const next = steps.map((step) => ({ ...step }));
  if (shipments.length === 0) {
    // Do not drag a draft/approval/allocation request forward. Only rename the live
    // delivery step once the existing journey says the request has reached it.
    if (next[deliveryIndex].state === "current") {
      next[deliveryIndex].caption = "Waiting for logistics dispatch";
      next[receiptIndex] = { ...next[receiptIndex], state: "pending", caption: "After arrival" };
    }
    return next;
  }

  const statuses = shipments.map((leg) => String(leg.status ?? "").toUpperCase());
  const allArrived = statuses.every((status) => ARRIVED_SHIPMENT_STATUSES.has(status));
  const allSigned = shipments.every((leg, index) => (
    Boolean(leg.acknowledged_at) || SIGNED_SHIPMENT_STATUSES.has(statuses[index])
  ));
  const location = shipmentLocation(shipments);
  // A consignment on a shared truck is told from its own stop, not the truck's.
  const onTrip = shipments.find((leg) => leg.trip_no
    && !ARRIVED_SHIPMENT_STATUSES.has(String(leg.status ?? "").toUpperCase()));

  next[deliveryIndex] = {
    ...next[deliveryIndex],
    state: allArrived ? "completed" : "current",
    caption: allArrived
      ? `${shipments.length} shipment${shipments.length === 1 ? "" : "s"} arrived`
      : onTrip
        ? `Shared truck · stop ${onTrip.stop_sequence ?? "?"} of ${onTrip.total_stops ?? "?"}`
        : location ? `In transit · ${location}` : "Being handled by logistics",
  };
  next[receiptIndex] = {
    ...next[receiptIndex],
    state: allSigned ? "completed" : allArrived ? "current" : "pending",
    caption: allSigned
      ? "Signed by you"
      : allArrived ? "Waiting for your signature" : "Sign when it arrives",
  };
  return next;
}

function shipmentStageMessage(shipments: RaiserTracking[] | undefined) {
  if (!shipments?.length) return undefined;
  const unsigned = shipments.filter((leg) => !leg.acknowledged_at
    && !SIGNED_SHIPMENT_STATUSES.has(String(leg.status ?? "").toUpperCase()));
  if (unsigned.length === 0) return "All delivered material has been signed for";
  const arrived = unsigned.filter((leg) =>
    String(leg.status ?? "").toUpperCase() === "DELIVERED").length;
  if (arrived > 0) {
    return `${arrived} delivery${arrived === 1 ? " is" : "ies are"} waiting for your signature`;
  }
  const trip = unsigned.find((leg) => leg.trip_no);
  if (trip) return tripProgressText(trip);
  const location = shipmentLocation(unsigned);
  return location ? `Your material is in transit at ${location}` : "Your material is with logistics";
}

function fallbackStageMessage(journey: IndentJourney, steps: SummaryStep[], status: string) {
  const currentIndex = steps.findIndex((step) => step.state === "current");
  if (currentIndex === 0) return "Draft — submit the indent to begin approval";
  if (currentIndex === 1) return "Request submitted — waiting for approval";
  if (currentIndex === 2) {
    const detail = approvalDetail(journey);
    return detail ? `Waiting for ${detail}` : "Request submitted — waiting for approval";
  }
  if (currentIndex === 3) return PROCUREMENT_MESSAGES[status] ?? "Waiting for allocation";
  if (currentIndex === 4) return "Waiting for warehouse issue";
  if (currentIndex === 5) return "Waiting for dispatch";
  if (currentIndex === 6) return "Waiting for acknowledgement";
  if (steps.some((step) => step.state === "returned")) {
    return "Returned for correction — update the indent and resubmit";
  }
  if (steps.some((step) => step.state === "cancelled")) return "Request cancelled";
  if (steps.some((step) => step.state === "rejected")) return "Request rejected";
  if (steps.every((step) => step.state === "completed" || step.state === "skipped")) {
    return "Completed";
  }
  return undefined;
}

function iconFor(state: StepState, index: number) {
  if (state === "completed") return <Check className="h-3.5 w-3.5" />;
  if (state === "current") return <Clock className="h-3.5 w-3.5" />;
  if (state === "rejected") return <X className="h-3.5 w-3.5" />;
  if (state === "returned") return <Undo2 className="h-3.5 w-3.5" />;
  if (state === "cancelled") return <Ban className="h-3.5 w-3.5" />;
  if (state === "skipped") return <Minus className="h-3.5 w-3.5" />;
  if (state === "unknown") return <Circle className="h-3.5 w-3.5" />;
  return index + 1;
}

/* The brand sweep, the same fill the shipment stepper uses (`logistics/components/
 * FlowStepper`): `.bg-brand` carries `background-image: var(--brand-gradient)`, so a
 * dot or a rail painted with it gets the four-stop Bavya gradient rather than a flat
 * crimson. Progress reads as one continuous track this way, which green dots on a
 * grey rail never did.
 *
 * Only completed and current take it. Rejected, returned, cancelled and skipped keep
 * their semantic colours — a stopped indent must never wear the same fill as one that
 * finished. A completed step is the check, a current step the ring; that is the same
 * pair the shipment stepper distinguishes them by. */
const BRAND_FILL = "border-transparent bg-brand text-white";

function stateClasses(state: StepState) {
  const classes: Record<StepState, string> = {
    completed: BRAND_FILL,
    current: `${BRAND_FILL} ring-4 ring-brand/20`,
    pending: "border-line bg-white text-muted",
    rejected: "border-bad bg-bad text-white",
    // Returned is recoverable and must never read as a rejection.
    returned: "border-warn bg-warn text-white",
    cancelled: "border-neutral bg-neutral text-white",
    skipped: "border-line bg-content2 text-muted",
    unknown: "border-bad/40 bg-bad-bg text-bad",
  };
  return classes[state];
}

/**
 * The rail between two dots. Horizontal rails take the sweep; the vertical rail of the
 * mobile layout takes flat crimson, because the gradient runs at 90deg and a 2px-wide
 * column of it is all four stops compressed into two pixels — a brown smear, not a
 * gradient.
 */
function connectorClass(left: StepState, right: StepState, vertical = false) {
  if (left === "completed" && !isHalted(right)) {
    return vertical ? "bg-[var(--grad-3)]" : "bg-brand";
  }
  return "bg-line";
}

function accessibleState(state: StepState) {
  if (state === "skipped") return "not required";
  if (state === "unknown") return "status unavailable";
  return state;
}

function FlowStepperSkeleton() {
  return (
    <div
      className="-mx-1 min-h-20 overflow-hidden px-1 pb-1 pt-1"
      role="status"
      aria-label="Loading approval progress"
    >
      {/* Mirrors the real seven-phase grid so nothing shifts when data lands. */}
      <div
        className="grid grid-cols-1 items-start gap-2 lg:grid-cols-7 lg:gap-0"
        data-testid="approval-progress-skeleton"
      >
        {PHASES.map((phase) => (
          <div
            key={phase.key}
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

export function FlowStepper({
  status, journey, shipments, isLoading = false,
}: FlowStepperProps) {
  const builtSteps = buildSteps(status, journey);
  const steps = builtSteps ? applyShipmentProgress(builtSteps, shipments) : null;

  if (isLoading && !steps) return <FlowStepperSkeleton />;

  if (!steps) {
    return (
      <div className="rounded-md border border-bad/30 bg-bad-bg px-3 py-2 text-sm font-medium text-bad">
        Status unavailable
      </div>
    );
  }

  const effectiveStatus = String(status || journey?.status || "").trim().toUpperCase();
  const currentIndex = steps.findIndex((step) => step.state === "current");
  const haltedIndex = steps.findIndex((step) => isHalted(step.state));
  const currentStageMessage = shipmentStageMessage(shipments)
    || journey?.current_stage_message?.trim()
    || (journey ? fallbackStageMessage(journey, steps, effectiveStatus) : undefined);
  const settled = steps.every((step) => step.state === "completed" || step.state === "skipped");
  const summaryIndex = currentIndex >= 0
    ? currentIndex
    : haltedIndex >= 0
      ? haltedIndex
      : settled
        ? steps.length - 1
        : -1;
  const ladder = approvalLadder(journey);
  // Only meaningful while the aggregated Approvals phase is the live one.
  const showLadder = Boolean(
    currentIndex === INDENT_APPROVALS_PHASE_INDEX && ladder?.position && ladder.total,
  );
  const ladderApprover = ladder?.approverName || ladder?.positionName;

  return (
    <div
      role="group"
      className="-mx-1 overflow-hidden px-1 pb-1 pt-1"
      aria-label="Compact indent progress"
    >
      <ol
        className="grid min-w-0 grid-cols-1 items-start gap-2 lg:grid-cols-7 lg:gap-0"
        data-testid="compact-approval-progress"
      >
        {steps.map((step, index) => (
          <li
            key={step.key}
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
                <span
                  className={`absolute left-5 top-8 h-[calc(100%+0.5rem)] w-0.5 -translate-x-1/2 lg:hidden ${connectorClass(step.state, steps[index + 1].state, true)}`}
                  aria-hidden="true"
                />
              </>
            )}
            <span
              aria-label={`${step.label}, ${accessibleState(step.state)}${
                step.caption && step.caption !== statusCaption(step.state)
                  ? `: ${step.caption}` : ""
              }`}
              className={`relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full border text-xs font-bold transition-colors ${stateClasses(step.state)}`}
            >
              {iconFor(step.state, index)}
            </span>
            <div className="w-full min-w-0 max-w-28 text-left lg:mx-auto lg:text-center">
              <span className={`block text-balance break-words text-[11px] font-semibold leading-4 lg:mt-2 lg:min-h-8 ${
                step.state === "skipped" || step.state === "pending" ? "text-muted" : "text-body"
              }`}>
                {step.label}
              </span>
              {step.caption && (
                <span className="mt-0.5 block max-w-full break-words text-[10px] font-medium leading-3 text-muted">{step.caption}</span>
              )}
            </div>
          </li>
        ))}
      </ol>
      {currentStageMessage && (
        <div className="mt-3 border-t border-line pt-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Current stage</p>
          {summaryIndex >= 0 && (
            <p className="mt-0.5 break-words text-xs font-semibold text-body">
              Stage {summaryIndex + 1} of {steps.length} · {steps[summaryIndex].label}
            </p>
          )}
          <p className="mt-0.5 break-words text-xs font-semibold text-body">
            {currentStageMessage}
          </p>
          {showLadder && (
            <p className="mt-0.5 break-words text-xs font-medium text-muted">
              Approval {ladder!.position} of {ladder!.total}
              {ladderApprover ? ` · ${ladderApprover}` : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
