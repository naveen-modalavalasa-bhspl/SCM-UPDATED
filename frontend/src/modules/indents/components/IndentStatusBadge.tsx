import { StatusPill } from "@/shared/components";
import { INDENT_STATUS } from "../constants";
import type { IndentJourney, IndentJourneyStage } from "../types";

const TOP_ALLOCATION_STATUS_TONE: Partial<Record<string, string>> = {
  [INDENT_STATUS.ALLOCATED]: "bg-ok-bg text-ok",
  [INDENT_STATUS.PARTIALLY_ALLOCATED]: "bg-warn-bg text-warn",
  [INDENT_STATUS.AWAITING_ALLOCATION]: "bg-info-bg text-info",
};

/**
 * Who a stage belongs to, taken straight from the resolved chain. The ladder is
 * configured per project, so no rank is ever assumed, mapped or abbreviated
 * here — the only edit is dropping a trailing "Review"/"Approval" from a stage
 * title so the badge reads "Pending at X" rather than "Pending at X Review".
 *
 * A hardcoded RM/DM/OE/SPH/COO lookup was tried here and taken back out. The rungs
 * are HCM role ids and an admin picks them per project on Approvals Config, so a map
 * in the frontend is wrong twice: a rank nobody listed renders as a bare abbreviation,
 * and the next HCM cutover re-keys the roles without touching this file. The rung is
 * READ from the configured stage, never abbreviated.
 */
function stageOwner(stage?: IndentJourneyStage) {
  // The badge names the RUNG, not the person sitting on it: "Pending at OE", not
  // "Pending at C Ramakrishna". Who exactly holds the rung today is already on the
  // stage card below ("Approval 1 of 3 · <name>"), and a list of indents reads as a
  // queue of ranks, not of colleagues. The approver's name stays as the last resort
  // for a stage that carries no title and no position.
  const title = stage?.title?.trim().replace(/\s+/g, " ")
    .replace(/\s+(Review|Approval)$/i, "").trim();
  if (title) return title;
  const position = stage?.position_name?.trim().replace(/\s+/g, " ");
  if (position) return position;
  return stage?.approver_name?.trim().replace(/\s+/g, " ") || null;
}

function pendingStageLabel(journey?: IndentJourney) {
  const owner = stageOwner(journey?.stages?.find((stage) => stage.is_current));
  return owner ? `Pending at ${owner}` : "Pending Approval";
}

/** Only a real actor names a decision — never a stage title. */
function decisionActor(stage?: IndentJourneyStage) {
  return stage?.approver_name?.trim().replace(/\s+/g, " ")
    || stage?.position_name?.trim().replace(/\s+/g, " ")
    || null;
}

function rejectedStageLabel(journey?: IndentJourney) {
  const actor = decisionActor(journey?.stages?.find((stage) => stage.status === "REJECTED"));
  return actor ? `Rejected by ${actor}` : null;
}

function returnedStageLabel(journey?: IndentJourney) {
  const actor = decisionActor(journey?.stages?.find((stage) => (
    String(stage.status ?? "").trim().toUpperCase() === "RETURNED"
    || String(stage.status ?? "").trim().toUpperCase() === INDENT_STATUS.RETURNED_FOR_CORRECTION
  )));
  return actor ? `Returned by ${actor}` : "Returned for correction";
}

export function IndentStatusBadge({ status, journey }: { status: string; journey?: IndentJourney }) {
  // If the indent is in an approval / review / terminal state, keep those authoritative outcome labels
  const terminalOrApproval = [
    INDENT_STATUS.DRAFT,
    INDENT_STATUS.PENDING_APPROVAL,
    INDENT_STATUS.REJECTED,
    INDENT_STATUS.RETURNED,
    INDENT_STATUS.RETURNED_FOR_CORRECTION,
    INDENT_STATUS.CANCELLED,
    INDENT_STATUS.CLOSED,
  ];

  if (!terminalOrApproval.includes(status as any)) {
    const csgStatus = journey?.consignment_status ? String(journey.consignment_status).toUpperCase() : null;
    const qcStatus = journey?.qc_status ? String(journey.qc_status).toUpperCase() : null;
    const isQcComplete = Boolean(journey?.qc_complete || qcStatus === "COMPLETED" || qcStatus === "PASSED");
    const qcRef = journey?.qc_inspection_no ? ` · ${journey.qc_inspection_no.split("/").pop()}` : "";
    const csgRef = journey?.consignment_no ? ` · ${journey.consignment_no.split("/").pop()}` : "";

    if (csgStatus === "DELIVERED") {
      return (
        <span className="inline-flex h-6 max-w-fit items-center justify-center whitespace-nowrap rounded-full bg-ok-bg px-2.5 text-[11px] font-semibold uppercase tracking-wide text-ok">
          DELIVERED{csgRef}
        </span>
      );
    }

    if (csgStatus && ["DISPATCHED", "GATED_OUT", "IN_TRANSIT"].includes(csgStatus)) {
      return (
        <span className="inline-flex h-6 max-w-fit items-center justify-center whitespace-nowrap rounded-full bg-info-bg px-2.5 text-[11px] font-semibold uppercase tracking-wide text-info">
          {csgStatus === "DISPATCHED" ? "DISPATCHED" : "IN TRANSIT"}{csgRef}
        </span>
      );
    }

    if (journey?.consignment_no) {
      return (
        <span className="inline-flex h-6 max-w-fit items-center justify-center whitespace-nowrap rounded-full bg-info-bg px-2.5 text-[11px] font-semibold uppercase tracking-wide text-info">
          CONSIGNMENT: {journey.consignment_status || "CREATED"}{csgRef}
        </span>
      );
    }

    if (isQcComplete) {
      return (
        <span className="inline-flex h-6 max-w-fit items-center justify-center whitespace-nowrap rounded-full bg-ok-bg px-2.5 text-[11px] font-semibold uppercase tracking-wide text-ok">
          QC: PASSED{qcRef}
        </span>
      );
    }

    if (qcStatus === "REJECTED" || qcStatus === "FAILED") {
      return (
        <span className="inline-flex h-6 max-w-fit items-center justify-center whitespace-nowrap rounded-full bg-bad-bg px-2.5 text-[11px] font-semibold uppercase tracking-wide text-bad">
          QC: FAILED{qcRef}
        </span>
      );
    }

    if (qcStatus && qcStatus !== "PENDING") {
      return (
        <span className="inline-flex h-6 max-w-fit items-center justify-center whitespace-nowrap rounded-full bg-warn-bg px-2.5 text-[11px] font-semibold uppercase tracking-wide text-warn">
          QC: {qcStatus}{qcRef}
        </span>
      );
    }
  }

  const allocationTone = TOP_ALLOCATION_STATUS_TONE[status];
  if (allocationTone) {
    return (
      <span
        className={`inline-flex h-6 max-w-fit items-center justify-center whitespace-nowrap rounded-full px-2.5 text-[11px] font-semibold uppercase tracking-wide ${allocationTone}`}
      >
        {status.replace(/_/g, " ")}
      </span>
    );
  }

  const label = status === INDENT_STATUS.PENDING_APPROVAL
    ? pendingStageLabel(journey)
    : status === INDENT_STATUS.REJECTED
      ? rejectedStageLabel(journey)
      : status === INDENT_STATUS.RETURNED_FOR_CORRECTION
        ? "Returned for correction"
      : status === INDENT_STATUS.RETURNED
        ? returnedStageLabel(journey)
        : null;
  if (!label) return <StatusPill status={status} />;

  // The outcome tokens, the same five `StatusPill` and the decision ledgers draw
  // from (2026-09-21). This badge used to reach for HeroUI's `danger`/`warning`
  // while the two allocation states above it used `bg-ok-bg`/`bg-info-bg` and the
  // fall-through went to `StatusPill` — three palettes inside one component, which
  // on a list of indents meant three different ambers in one column.
  //
  // RETURNED and RETURNED_FOR_CORRECTION leave the amber. "I approved less than you
  // asked for" and "I sent it back to you" are the two outcomes a requester most
  // needs to tell apart, and they were the same fill; the violet is the token
  // `index.css` carries for exactly that, and it is what the decision ledgers
  // already draw a returned decision with.
  const tone = status === INDENT_STATUS.REJECTED
    ? "bg-bad-bg text-bad"
    : status === INDENT_STATUS.RETURNED || status === INDENT_STATUS.RETURNED_FOR_CORRECTION
      ? "bg-chart-returned-bg text-chart-returned"
      : "bg-warn-bg text-warn";

  return (
    <span
      className={`inline-flex h-6 max-w-fit items-center justify-center whitespace-nowrap rounded-full px-2.5 text-[11px] font-semibold uppercase tracking-wide ${tone} ${status === INDENT_STATUS.RETURNED_FOR_CORRECTION ? "normal-case" : ""}`}
    >
      {/* Names come from HCM and can be long — truncate, never abbreviate.
        *
        * WIDENED 2026-08-23. The cap was a flat 224px, which is narrower than the
        * ordinary case: "Pending at Final Approval - SCM HEAD" is a configured rung
        * name, not a long person's name, and it lost its last word on every screen
        * wide enough to have shown it twice over. A badge that ends in an ellipsis
        * where the room was there anyway just hides the answer it exists to give.
        *
        * Responsive rather than simply bigger: 224px is right on a phone, where the
        * badge shares a row with the document number, and the ellipsis is the correct
        * behaviour there. `title` still carries the full text at every width. */}
      <span className="block max-w-56 truncate sm:max-w-md" title={label}>{label}</span>
    </span>
  );
}
