import { INDENT_STATUS } from "./constants";
import { formatIndentDateTime, parseIndentTimestamp } from "./dateTime";
import type { IndentJourney, IndentJourneyHistoryEvent, IndentJourneyStage } from "./types";

/**
 * One leg of the end-to-end journey. A leg is a place the document physically
 * goes, not a fixed number of approvals: the rungs inside it (OE → DM → RM →
 * SPH/COO for the indent, the two assistant managers plus the inventory manager
 * for an allocation, and so on) come from whatever the workflow engine actually
 * resolved and recorded, never from a list held here.
 */
export interface JourneyTrackDefinition {
  key: string;
  label: string;
  caption: string;
  stageTypes: readonly string[];
  /** `journey.phases` titles that aggregate into this leg, in phase order. */
  phaseTitles: readonly string[];
}

export type JourneyTrackState =
  | "COMPLETED" | "CURRENT" | "PENDING" | "REJECTED" | "RETURNED";

export interface JourneyTrack extends JourneyTrackDefinition {
  state: JourneyTrackState;
  summary: string;
  occurred: IndentJourneyStage[];
  upcoming: IndentJourneyStage[];
}

export const INDENT_JOURNEY_TRACKS: readonly JourneyTrackDefinition[] = [
  {
    key: "request",
    label: "Request raised",
    caption: "Who raised the indent, and when it was submitted",
    stageTypes: ["draft", "submission"],
    phaseTitles: ["draft", "submitted"],
  },
  {
    key: "approvals",
    label: "Indent approvals",
    caption: "Every rung of the resolved approval ladder",
    stageTypes: ["approval", "final", "final_any_one_peer"],
    phaseTitles: ["approvals"],
  },
  {
    key: "allocation",
    label: "Inventory allocation",
    caption: "Allocation approvals and the stock reserved against them",
    stageTypes: ["allocation", "allocation_approval", "material_request"],
    phaseTitles: ["allocation"],
  },
  {
    key: "warehouse",
    label: "Warehouse",
    caption: "Warehouse approvals, picking and the issue from stock",
    stageTypes: ["warehouse", "warehouse_approval", "picking", "picking_approval"],
    phaseTitles: ["warehouse"],
  },
  {
    key: "delivery",
    label: "Dispatch and delivery",
    caption: "Dispatch approvals, gate-out and delivery",
    stageTypes: ["delivery", "dispatch_approval"],
    phaseTitles: ["delivery"],
  },
  {
    key: "acknowledgement",
    label: "Receipt and closure",
    caption: "What the requester confirmed as received, and closure",
    stageTypes: ["acknowledgement", "completion"],
    phaseTitles: ["acknowledgement"],
  },
];

/** Anything the contract grows later still has somewhere honest to land. */
const OTHER_TRACK: JourneyTrackDefinition = {
  key: "activity",
  label: "Other recorded activity",
  caption: "Steps recorded outside the standard flow",
  stageTypes: [],
  phaseTitles: [],
};

const TRACK_BY_STAGE_TYPE = new Map<string, string>();
INDENT_JOURNEY_TRACKS.forEach((track) => {
  track.stageTypes.forEach((stageType) => TRACK_BY_STAGE_TYPE.set(stageType, track.key));
});

/** The legs that only ever arrive as history events, never as `stages` rungs. */
const DOWNSTREAM_TRACKS = new Set(["allocation", "warehouse", "delivery", "acknowledgement"]);

const ACTION_SUFFIXES = ["SUBMITTED", "APPROVED", "REJECTED", "RETURNED"];

const HISTORY_STAGE_TYPES: Record<string, string> = {
  CREATED: "draft",
  SUBMITTED: "submission",
  APPROVED: "approval",
  REJECTED: "approval",
  RETURNED: "approval",
  READY_FOR_ALLOCATION: "allocation",
  ALLOCATION_CREATED: "allocation",
  ALLOCATION_COMPLETED: "allocation",
  STOCK_ALLOCATED: "allocation",
  MATERIAL_REQUEST_CREATED: "material_request",
  MATERIAL_ISSUE_CREATED: "warehouse",
  WAREHOUSE_ISSUED: "warehouse",
  WAREHOUSE_ISSUE_COMPLETED: "warehouse",
  DISPATCH_CREATED: "delivery",
  DISPATCHED: "delivery",
  DELIVERED: "delivery",
  ACKNOWLEDGEMENT_SUBMITTED: "acknowledgement",
  PARTIALLY_RECEIVED: "acknowledgement",
  FULLY_RECEIVED: "acknowledgement",
  COMPLETED: "completion",
};

const HISTORY_STATUSES: Record<string, string> = {
  CREATED: "COMPLETED",
  SUBMITTED: "SUBMITTED",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  RETURNED: "RETURNED",
  ACKNOWLEDGEMENT_SUBMITTED: "ACKNOWLEDGED",
};

export function stageStatus(stage: { status?: string | null }) {
  return String(stage.status ?? "").trim().toUpperCase();
}

/**
 * `<DOMAIN>_APPROVAL_APPROVED` and friends are emitted per downstream document
 * type, so the leg is read off the event name rather than enumerated here.
 */
export function journeyEventStageType(eventType?: string | null) {
  const type = String(eventType ?? "").trim().toUpperCase();
  if (!type) return "activity";
  const direct = HISTORY_STAGE_TYPES[type];
  if (direct) return direct;
  const suffix = ACTION_SUFFIXES.find((value) => type.endsWith(`_${value}`));
  if (suffix) return type.slice(0, -(suffix.length + 1)).toLowerCase();
  return "activity";
}

export function journeyEventStatus(eventType?: string | null) {
  const type = String(eventType ?? "").trim().toUpperCase();
  const direct = HISTORY_STATUSES[type];
  if (direct) return direct;
  const suffix = ACTION_SUFFIXES.find((value) => type.endsWith(`_${value}`));
  return suffix ?? "COMPLETED";
}

export function journeyTrackKey(stageType?: string | null) {
  const key = String(stageType ?? "").trim().toLowerCase();
  const known = TRACK_BY_STAGE_TYPE.get(key);
  if (known) return known;
  // An unseen `<domain>_approval` still belongs with its domain.
  if (key.endsWith("_approval")) {
    return TRACK_BY_STAGE_TYPE.get(key.slice(0, -"_approval".length)) ?? OTHER_TRACK.key;
  }
  return OTHER_TRACK.key;
}

const OCCURRED_STAGE_STATUSES = new Set([
  "COMPLETED", "APPROVED", "SUBMITTED", "REJECTED", "RETURNED", "RETURNED_FOR_CORRECTION",
  "ACKNOWLEDGED", "CANCELLED",
  // An ANY_ONE peer that was stood down is a real, timestamped outcome: it is the
  // only thing that explains why one authority acted and its peers never did.
  "NOT_REQUIRED",
]);

const UPCOMING_STAGE_STATUSES = new Set(["PENDING", "NOT_REQUIRED"]);

export function isOccurredJourneyStage(stage: IndentJourneyStage) {
  return Boolean(stage.timestamp)
    && !stage.is_current
    && OCCURRED_STAGE_STATUSES.has(stageStatus(stage));
}

/** The rest of the chain: who holds it now, and who is still owed a decision. */
export function isUpcomingJourneyStage(stage: IndentJourneyStage) {
  if (isOccurredJourneyStage(stage)) return false;
  return Boolean(stage.is_current) || UPCOMING_STAGE_STATUSES.has(stageStatus(stage));
}

/** Chronological, with sequence as the tie-break — never trust array order. */
export function sortOccurredStages(stages: IndentJourneyStage[]) {
  return [...stages].sort((left, right) => {
    const leftAt = parseIndentTimestamp(left.timestamp)?.getTime() ?? 0;
    const rightAt = parseIndentTimestamp(right.timestamp)?.getTime() ?? 0;
    return leftAt - rightAt || (left.sequence ?? 0) - (right.sequence ?? 0);
  });
}

function fingerprints(row: {
  title?: string | null;
  timestamp?: string | null;
  reference_no?: string | null;
}) {
  const title = String(row.title ?? "").trim().toLowerCase();
  const at = parseIndentTimestamp(row.timestamp)?.toISOString() ?? "";
  return [`${title}|${at}`, `${title}|${at}|${String(row.reference_no ?? "").trim()}`];
}

function outcomeKey(row: { status?: string | null; timestamp?: string | null }) {
  const at = parseIndentTimestamp(row.timestamp)?.toISOString();
  return at ? `${String(row.status ?? "").toUpperCase()}|${at}` : null;
}

/**
 * The Journey contract carries the indent's own ladder in `stages`, but a rung
 * only ever shows its latest decision: once a returned indent is corrected and
 * resubmitted, the rung reads APPROVED and the return disappears from it.
 * Everything downstream — allocation approvals, the warehouse issue, dispatch,
 * receipt — never reaches `stages` at all.
 *
 * Both survive in the immutable history, so project those events into the same
 * stage shape: the timeline then keeps every correction that was ever asked for,
 * with its reason, and carries the whole chain past approval. Anything a backend
 * already served as a stage is dropped so nothing is counted twice.
 */
export function derivedJourneyStages(journey: IndentJourney): IndentJourneyStage[] {
  const seen = new Set<string>();
  (journey.stages ?? []).forEach((stage) => {
    if (stage.event_id) seen.add(`id:${stage.event_id}`);
    fingerprints(stage).forEach((value) => seen.add(value));
    const outcome = outcomeKey(stage);
    if (outcome) seen.add(outcome);
  });

  const ordered = [...(journey.history ?? [])].sort((left, right) => (
    (parseIndentTimestamp(left.timestamp)?.getTime() ?? 0)
    - (parseIndentTimestamp(right.timestamp)?.getTime() ?? 0)
  ));

  const derived: IndentJourneyStage[] = [];
  let returnedEarlier = false;
  ordered.forEach((event: IndentJourneyHistoryEvent, index) => {
    const eventStageType = journeyEventStageType(event.event_type);
    const status = journeyEventStatus(event.event_type);
    const track = journeyTrackKey(eventStageType);
    // The indent's own submit/approve cycle, as opposed to a downstream document.
    const ownCycle = track === "request" || track === "approvals";
    const correction = ownCycle && status === "RETURNED";
    const resubmission = ownCycle && status === "SUBMITTED" && returnedEarlier;
    if (correction) returnedEarlier = true;
    if (!DOWNSTREAM_TRACKS.has(track) && !correction && !resubmission) return;

    if (seen.has(`id:${event.id}`)) return;
    const keys = fingerprints(event);
    if (keys.some((key) => seen.has(key))) return;
    const outcome = ownCycle ? outcomeKey({ status, timestamp: event.timestamp }) : null;
    if (outcome && seen.has(outcome)) return;
    keys.forEach((key) => seen.add(key));
    if (outcome) seen.add(outcome);

    derived.push({
      event_id: event.id,
      // Sorted chronologically for display; kept after contract stages so a tie
      // on the timestamp never pushes a derived step above its own document.
      sequence: 1000 + index,
      title: resubmission ? "Resubmitted after correction" : event.title,
      status,
      is_current: false,
      approver_name: event.actor_name ?? null,
      position_name: event.position_name ?? null,
      timestamp: event.timestamp,
      comments: event.comments ?? null,
      // A correction belongs to the approval leg it came from, never to a leg of
      // its own, so the ladder still reads as one continuous chain.
      stage_type: correction || resubmission ? "approval" : eventStageType,
      reference_no: event.reference_no ?? null,
      quantity_summary: event.quantity_summary ?? null,
      evidence_source: event.id,
    });
  });
  return derived;
}

export interface JourneySteps {
  occurred: IndentJourneyStage[];
  upcoming: IndentJourneyStage[];
}

/** Every step of the journey: the contract stages plus the recovered evidence. */
export function journeySteps(journey?: IndentJourney): JourneySteps {
  if (!journey) return { occurred: [], upcoming: [] };
  const all = [...(journey.stages ?? []), ...derivedJourneyStages(journey)];
  return {
    occurred: sortOccurredStages(all.filter(isOccurredJourneyStage)),
    upcoming: all.filter(isUpcomingJourneyStage)
      .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0)),
  };
}

function phaseByTrack(journey: IndentJourney) {
  const byTrack = new Map<string, IndentJourneyStage>();
  INDENT_JOURNEY_TRACKS.forEach((track) => {
    track.phaseTitles.forEach((title) => {
      const phase = (journey.phases ?? []).find(
        (row) => String(row.title ?? "").trim().toLowerCase() === title,
      );
      // Later phases win, so Draft + Submitted collapse to the Submitted state.
      if (phase) byTrack.set(track.key, phase);
    });
  });
  return byTrack;
}

function trackState(
  occurred: IndentJourneyStage[],
  upcoming: IndentJourneyStage[],
  phase?: IndentJourneyStage,
): JourneyTrackState {
  const statuses = occurred.map(stageStatus);
  if (statuses.includes("REJECTED")) return "REJECTED";
  if (statuses.includes("RETURNED") || statuses.includes(INDENT_STATUS.RETURNED_FOR_CORRECTION)) {
    return "RETURNED";
  }
  if (upcoming.some((stage) => stage.is_current)) return "CURRENT";
  if (phase) {
    const status = stageStatus(phase);
    if (status === "REJECTED") return "REJECTED";
    if (status === "RETURNED" || status === INDENT_STATUS.RETURNED_FOR_CORRECTION) return "RETURNED";
    if (phase.is_current) return "CURRENT";
    if (["APPROVED", "COMPLETED", "SUBMITTED", "ACKNOWLEDGED"].includes(status)) return "COMPLETED";
    return occurred.length > 0 ? "COMPLETED" : "PENDING";
  }
  if (upcoming.length > 0) return occurred.length > 0 ? "CURRENT" : "PENDING";
  return occurred.length > 0 ? "COMPLETED" : "PENDING";
}

function actorOf(stage: IndentJourneyStage) {
  return stage.approver_name?.trim() || stage.position_name?.trim() || null;
}

function trackSummary(
  state: JourneyTrackState,
  occurred: IndentJourneyStage[],
  upcoming: IndentJourneyStage[],
): string {
  if (state === "REJECTED" || state === "RETURNED") {
    const decisive = [...occurred].reverse().find((stage) => {
      const status = stageStatus(stage);
      return state === "REJECTED"
        ? status === "REJECTED"
        : status === "RETURNED" || status === INDENT_STATUS.RETURNED_FOR_CORRECTION;
    });
    const actor = decisive ? actorOf(decisive) : null;
    const verb = state === "REJECTED" ? "Rejected" : "Returned for correction";
    return actor ? `${verb} by ${actor}` : verb;
  }
  if (state === "CURRENT") {
    const live = upcoming.find((stage) => stage.is_current) ?? upcoming[0];
    if (!live) {
      return occurred.length > 0
        ? `${occurred.length} ${occurred.length === 1 ? "step" : "steps"} · waiting on the next one`
        : "Waiting to start";
    }
    const actor = actorOf(live);
    const title = String(live.title ?? "").trim();
    const at = title ? `Waiting at ${title}` : "Waiting";
    return actor ? `${at} · ${actor}` : at;
  }
  if (state === "COMPLETED") {
    const last = occurred[occurred.length - 1];
    const when = formatIndentDateTime(last?.timestamp);
    const steps = `${occurred.length} ${occurred.length === 1 ? "step" : "steps"}`;
    return when ? `${steps} · completed ${when}` : `${steps} recorded`;
  }
  return "Not started yet";
}

/**
 * Group the whole journey into its legs. Every leg is returned — including ones
 * nothing has happened in yet — so the screen shows how far the request still
 * has to travel, not only how far it has come.
 */
export function buildJourneyTracks(journey?: IndentJourney, steps?: JourneySteps): JourneyTrack[] {
  if (!journey) return [];
  const { occurred, upcoming } = steps ?? journeySteps(journey);
  const phases = phaseByTrack(journey);
  const definitions = [...INDENT_JOURNEY_TRACKS, OTHER_TRACK];

  return definitions
    .map((definition) => {
      const inTrack = (stage: IndentJourneyStage) => (
        journeyTrackKey(stage.stage_type) === definition.key
      );
      const trackOccurred = occurred.filter(inTrack);
      const trackUpcoming = upcoming.filter(inTrack);
      const state = trackState(trackOccurred, trackUpcoming, phases.get(definition.key));
      return {
        ...definition,
        state,
        summary: trackSummary(state, trackOccurred, trackUpcoming),
        occurred: trackOccurred,
        upcoming: trackUpcoming,
      };
    })
    .filter((track) => (
      track.key !== OTHER_TRACK.key || track.occurred.length > 0 || track.upcoming.length > 0
    ));
}

