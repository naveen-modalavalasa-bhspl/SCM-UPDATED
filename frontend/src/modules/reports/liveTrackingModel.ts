/** Pure helpers behind the Live Tracking screen.
 *
 *  The screen composes two existing read endpoints — the indent Journey (who raised
 *  it, every approval rung, where it sits now) and the Reports traceability chain
 *  (every downstream document). Nothing here computes business state: every value is
 *  read off the payloads, the same way the screens they mirror do. */

export interface TrackStage {
  sequence: number;
  title: string;
  status: string;
  is_current?: boolean;
  approver_name?: string | null;
  position_name?: string | null;
  timestamp?: string | null;
  comments?: string | null;
  duration_seconds?: number | null;
  stage_type: string;
}

export interface TrackJourney {
  indent_id: number;
  indent_no: string;
  status: string;
  requested_by_name?: string | null;
  requested_by_position?: string | null;
  created_at: string;
  current_stage?: string | null;
  current_stage_message?: string | null;
  stages: TrackStage[];
  phases?: TrackStage[];
}

/** The approval-ladder stamp the traceability endpoints now carry on every tracked
 *  row: which ladder version governed the document, which project/module it came
 *  from, and where a click on the chip should land. Optional everywhere — a document
 *  that was never submitted has run no ladder (`approval` is null), and a document
 *  type the backend does not code simply has no short badge. Nothing on the screen
 *  is derived from the doctype; every value here arrived from the backend. */
export interface TrackApproval {
  doctype?: string | null;
  doctype_code?: string | null;
  approval_ladder_version?: string | number | null;
  approval_ladder_label?: string | null;
  ladder_name?: string | null;
  ladder_code?: string | null;
  project?: string | null;
  project_id?: number | null;
  module?: string | null;
  navigation_route?: string | null;
}

export interface TrackHit {
  key: string;
  id: number;
  doc_no: string | null;
  status: string | null;
  label: string;
  date?: string | null;
  doctype_code?: string | null;
  approval?: TrackApproval | null;
}

/** The one indent among the search hits. A partial number can match several kinds —
 *  an IND-… number is what this screen tracks, so an indent hit wins; anything else
 *  means the person typed something that is not an indent number. */
export function indentHit(hits: TrackHit[]): TrackHit | undefined {
  return hits.find((hit) => hit.key === "indent");
}

/** Latest first, or oldest first, by the indent date (falling back to id so an
 *  unknown date never mis-orders). The list is small enough to sort in the screen —
 *  the backend already returned the full register for the landing view. */
export function sortHits(hits: TrackHit[], order: "latest" | "oldest"): TrackHit[] {
  const value = (h: TrackHit) => {
    const d = h.date ? new Date(h.date).getTime() : Number.NaN;
    return Number.isNaN(d) ? h.id : d;
  };
  return [...hits].sort((a, b) =>
    order === "latest" ? value(b) - value(a) : value(a) - value(b),
  );
}

/** The ladder as a person reads it: creation, submission, then every approval rung
 *  including the final one. Operational evidence (allocation events, issue events)
 *  lives in the phase strip and the downstream trail instead — repeating it here made
 *  the ladder unreadable. */
export function ladderStages(journey: TrackJourney): TrackStage[] {
  return (journey.stages ?? []).filter((stage) =>
    ["draft", "submission", "approval", "final"].includes(stage.stage_type),
  );
}

/** When the document arrived where it is now: the last rung that actually happened,
 *  falling back to creation. This is what "waiting since" is counted from. */
export function waitingSince(journey: TrackJourney): string | undefined {
  const stamped = (journey.stages ?? []).filter((stage) => stage.timestamp);
  const last = stamped[stamped.length - 1];
  return last?.timestamp ?? journey.created_at ?? undefined;
}

/** Seconds on one leg, said the way a desk says it. */
export function fmtWait(seconds?: number | null, dash = "—"): string {
  if (seconds == null || seconds < 0) return dash;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** What a tracking row wears as its doctype badge: the backend's short code (IND,
 *  ALL, MR) when it sent one, else the row's own label, and an honest dash when it
 *  sent neither. A new document type needs no screen change — it is whatever code
 *  the backend stamps, or the label it already had. */
export function doctypeBadge(
  row: { doctype_code?: string | null; label?: string | null },
): string {
  return row.doctype_code
    ?? ((row.label ?? "").trim() || "—");
}

/** The version line the chip shows: the backend's own wording ("Approval Ladder
 *  v2.1") when it sent one, else the ladder's name, else a quiet "No approval
 *  ladder" for a document that never reached a workflow. */
export function ladderChipLabel(
  approval?: TrackApproval | null,
): string {
  return approval?.approval_ladder_label ?? approval?.ladder_name
    ?? "No approval ladder";
}

/** Where the chip opens: the project's approval-flow editor for this document type —
 *  the screen that answers "which version is running" for project 104's ladder — so
 *  the chip lands on the config page, not the raw document. Falls back to the route
 *  the backend resolved for this record, then to inert. */
export function ladderRoute(
  approval?: TrackApproval | null,
): string | undefined {
  if (!approval) return undefined;
  if (approval.project_id != null && approval.doctype) {
    return `/admin/approval-flow/${approval.doctype}?project=${approval.project_id}`;
  }
  return approval.navigation_route ?? undefined;
}

/** The origin line for the chip's visible tail and its tooltip: project first,
 *  module behind it, whichever arrived. Empty when nothing did. */
export function ladderOrigin(approval?: TrackApproval | null): string {
  if (!approval) return "";
  return [approval.project, approval.module].filter(Boolean).join(" · ");
}
