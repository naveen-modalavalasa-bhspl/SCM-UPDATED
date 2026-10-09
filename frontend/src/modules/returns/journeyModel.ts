import { parseReturnTimestamp, formatReturnDateTime } from "./dateTime";
import type { JourneyPhase, ReturnJourney, ReturnJourneyStage } from "./types";

/**
 * The return's journey, grouped into the legs it actually travels.
 *
 * Same shape of model as the indent's, deliberately — the two documents are meant to read
 * as one system — but every leg here is a RETURN's own: the decision desk, the sign-off,
 * the raiser's reporting line, the shipment, the movement, the acknowledgement. Where a
 * return names an indent that is a reference on the header and nothing more; the indent's
 * rungs belong to the indent's own journey screen and are never drawn here.
 *
 * A leg is a place the document goes, not a fixed number of approvals: the rungs inside it
 * come from whatever the workflow engine actually resolved and recorded, served by
 * `GET /api/returns/{id}/journey`, never from a status-to-steps table kept in the browser.
 */
export interface JourneyTrackDefinition {
  key: string;
  label: string;
  caption: string;
  /** `stage.stage_type` values that belong to this leg. */
  stageTypes: readonly string[];
  /** `journey.phases` keys that aggregate into this leg, in phase order. */
  phaseKeys: readonly string[];
}

export type JourneyTrackState =
  | "COMPLETED" | "CURRENT" | "PENDING" | "REJECTED" | "RETURNED";

export interface JourneyTrack extends JourneyTrackDefinition {
  state: JourneyTrackState;
  summary: string;
  occurred: ReturnJourneyStage[];
  upcoming: ReturnJourneyStage[];
}

/** The eight legs of `enums.PHASES`, gathered into the seven the reader thinks in. */
export const RETURN_JOURNEY_TRACKS: readonly JourneyTrackDefinition[] = [
  {
    key: "request",
    label: "Return raised",
    caption: "Who sent the material back, and when it was submitted",
    stageTypes: ["draft", "submission"],
    phaseKeys: ["draft", "submitted"],
  },
  {
    key: "decision",
    label: "Decision desk",
    caption: "Where the material was told to go, and who decided it",
    stageTypes: ["decision"],
    phaseKeys: ["decision"],
  },
  {
    key: "sign_off",
    label: "Sign-off",
    caption: "The floor agreeing the decision is workable",
    stageTypes: ["sign_off"],
    phaseKeys: ["endorsement"],
  },
  {
    key: "approval",
    label: "Approval ladder",
    caption: "Every rung of the resolved approval ladder",
    stageTypes: ["approval", "final"],
    phaseKeys: ["approvals"],
  },
  {
    key: "logistics",
    label: "Logistics",
    caption: "The shipment carrying the return, and its gate-out",
    stageTypes: ["logistics"],
    phaseKeys: ["logistics"],
  },
  {
    key: "movement",
    label: "Stock movement",
    caption: "The stock leaving the branch shelf",
    stageTypes: ["movement"],
    phaseKeys: ["movement"],
  },
  {
    key: "acknowledgement",
    label: "Returner confirmation and closure",
    caption: "The return signed off by whoever raised it, and closed",
    stageTypes: ["acknowledgement", "completion"],
    phaseKeys: ["acknowledged"],
  },
];

/** Anything the contract grows later still has somewhere honest to land. */
const OTHER_TRACK: JourneyTrackDefinition = {
  key: "activity",
  label: "Other recorded activity",
  caption: "Steps recorded outside the standard flow",
  stageTypes: [],
  phaseKeys: [],
};

const TRACK_BY_STAGE_TYPE = new Map<string, string>();
RETURN_JOURNEY_TRACKS.forEach((track) => {
  track.stageTypes.forEach((stageType) => TRACK_BY_STAGE_TYPE.set(stageType, track.key));
});

export function stageStatus(stage: { status?: string | null }) {
  return String(stage.status ?? "").trim().toUpperCase();
}

export function journeyTrackKey(stageType?: string | null) {
  const key = String(stageType ?? "").trim().toLowerCase();
  const known = TRACK_BY_STAGE_TYPE.get(key);
  if (known) return known;
  // An unseen `<leg>_approval` still belongs with its leg.
  if (key.endsWith("_approval")) {
    return TRACK_BY_STAGE_TYPE.get(key.slice(0, -"_approval".length)) ?? OTHER_TRACK.key;
  }
  return OTHER_TRACK.key;
}

/** The step that closes a send-back: the corrected return went back up from the top. */
export const RESUBMISSION_STAGE_TITLE = "Resubmitted after correction";

export function isResubmissionStage(stage: ReturnJourneyStage) {
  return stageStatus(stage) === "SUBMITTED"
    && String(stage.title ?? "").trim().toLowerCase() === RESUBMISSION_STAGE_TITLE.toLowerCase();
}

const OCCURRED_STAGE_STATUSES = new Set([
  "COMPLETED", "APPROVED", "SUBMITTED", "REJECTED", "RETURNED", "ACKNOWLEDGED",
  "CANCELLED",
  // A rung that was stood down is a real, timestamped outcome: it is the only thing that
  // explains why one authority acted and its peers never did.
  "NOT_REQUIRED",
]);

const UPCOMING_STAGE_STATUSES = new Set(["PENDING", "NOT_REQUIRED"]);

/**
 * A step that has already happened. Undated is allowed on purpose: a leg the return has
 * finished with but that nobody pressed anything in — "nothing to move" on an outcome that
 * never travels — is a fact about the journey, and dropping it would leave a hole in the
 * rail where a completed leg belongs.
 */
export function isOccurredJourneyStage(stage: ReturnJourneyStage) {
  return !stage.is_current && OCCURRED_STAGE_STATUSES.has(stageStatus(stage));
}

/** The rest of the road: who holds it now, and who is still owed a decision. */
export function isUpcomingJourneyStage(stage: ReturnJourneyStage) {
  if (isOccurredJourneyStage(stage)) return false;
  return Boolean(stage.is_current) || UPCOMING_STAGE_STATUSES.has(stageStatus(stage));
}

/**
 * Chronological, with the served sequence as the tie-break — never array order.
 *
 * An undated step sorts by its sequence alone, which is its leg's own place in the flow,
 * so it lands inside the leg it describes rather than at the top of the timeline.
 */
export function sortOccurredStages(stages: ReturnJourneyStage[]) {
  return [...stages].sort((left, right) => {
    const leftAt = parseReturnTimestamp(left.timestamp)?.getTime();
    const rightAt = parseReturnTimestamp(right.timestamp)?.getTime();
    if (leftAt !== undefined && rightAt !== undefined && leftAt !== rightAt) {
      return leftAt - rightAt;
    }
    return (left.sequence ?? 0) - (right.sequence ?? 0);
  });
}

export interface JourneySteps {
  occurred: ReturnJourneyStage[];
  upcoming: ReturnJourneyStage[];
}

export function journeySteps(journey?: ReturnJourney): JourneySteps {
  const all = journey?.stages ?? [];
  return {
    occurred: sortOccurredStages(all.filter(isOccurredJourneyStage)),
    upcoming: all.filter(isUpcomingJourneyStage)
      .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0)),
  };
}

/** The last phase a leg aggregates wins, so Draft + Submitted read as Submitted. */
function phaseByTrack(journey: ReturnJourney) {
  const byTrack = new Map<string, JourneyPhase>();
  RETURN_JOURNEY_TRACKS.forEach((track) => {
    track.phaseKeys.forEach((key) => {
      const phase = (journey.phases ?? []).find((row) => row.key === key);
      if (phase) byTrack.set(track.key, phase);
    });
  });
  return byTrack;
}

/**
 * The setback the leg is still sitting on, if any. A send-back that was corrected and
 * resubmitted is history — the leg moved on — so only an unanswered one counts.
 * `occurred` is chronological, so a single pass settles it.
 */
function outstandingSetback(occurred: ReturnJourneyStage[]): JourneyTrackState | null {
  let setback: JourneyTrackState | null = null;
  for (const stage of occurred) {
    const status = stageStatus(stage);
    if (status === "REJECTED") setback = "REJECTED";
    else if (status === "RETURNED") setback = "RETURNED";
    else if (setback === "RETURNED" && isResubmissionStage(stage)) setback = null;
  }
  return setback;
}

function trackState(
  occurred: ReturnJourneyStage[],
  upcoming: ReturnJourneyStage[],
  phase?: JourneyPhase,
): JourneyTrackState {
  const setback = outstandingSetback(occurred);
  if (setback) return setback;
  if (upcoming.some((stage) => stage.is_current)) return "CURRENT";
  if (phase) {
    if (phase.state === "rejected") return "REJECTED";
    if (phase.state === "cancelled") return "REJECTED";
    if (phase.state === "current") return "CURRENT";
    if (phase.state === "completed") return "COMPLETED";
    return occurred.length > 0 ? "COMPLETED" : "PENDING";
  }
  if (upcoming.length > 0) return occurred.length > 0 ? "CURRENT" : "PENDING";
  return occurred.length > 0 ? "COMPLETED" : "PENDING";
}

function actorOf(stage: ReturnJourneyStage) {
  return stage.approver_name?.trim() || stage.position_name?.trim() || null;
}

function trackSummary(
  state: JourneyTrackState,
  occurred: ReturnJourneyStage[],
  upcoming: ReturnJourneyStage[],
): string {
  if (state === "REJECTED" || state === "RETURNED") {
    const decisive = [...occurred].reverse().find((stage) => {
      const status = stageStatus(stage);
      return state === "REJECTED"
        ? status === "REJECTED" || status === "CANCELLED"
        : status === "RETURNED";
    });
    const actor = decisive ? actorOf(decisive) : null;
    const verb = state === "REJECTED" ? "Stopped here" : "Sent back for correction";
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
    const dated = [...occurred].reverse().find((stage) => stage.timestamp);
    const when = formatReturnDateTime(dated?.timestamp);
    const steps = `${occurred.length} ${occurred.length === 1 ? "step" : "steps"}`;
    return when ? `${steps} · completed ${when}` : `${steps} recorded`;
  }
  return "Not started yet";
}

/**
 * Group the whole journey into its legs. Every leg is returned — including ones nothing has
 * happened in yet — so the screen shows how far the return still has to travel, not only
 * how far it has come.
 */
export function buildJourneyTracks(journey?: ReturnJourney, steps?: JourneySteps): JourneyTrack[] {
  if (!journey) return [];
  const { occurred, upcoming } = steps ?? journeySteps(journey);
  const phases = phaseByTrack(journey);
  const definitions = [...RETURN_JOURNEY_TRACKS, OTHER_TRACK];

  return definitions
    .map((definition) => {
      const inTrack = (stage: ReturnJourneyStage) => (
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
