import { Chip } from "@heroui/react";
import { StatusPill } from "@/shared/components";
import { INDENT_STATUS } from "../constants";
import type { IndentJourney, IndentJourneyStage } from "../types";

const TOP_ALLOCATION_STATUS_TONE: Partial<Record<string, string>> = {
  [INDENT_STATUS.ALLOCATED]: "bg-ok-bg text-ok",
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
  const allocationTone = TOP_ALLOCATION_STATUS_TONE[status];
  if (allocationTone) {
    return (
      <Chip
        size="sm"
        radius="full"
        variant="flat"
        classNames={{
          base: allocationTone,
          content: "text-[11px] font-semibold uppercase tracking-wide",
        }}
      >
        {status.replace(/_/g, " ")}
      </Chip>
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

  return (
    <Chip
      size="sm"
      radius="full"
      variant="flat"
      color={status === INDENT_STATUS.REJECTED ? "danger" : "warning"}
      classNames={{ content: `text-[11px] font-semibold uppercase tracking-wide ${status === INDENT_STATUS.RETURNED_FOR_CORRECTION ? "normal-case" : ""}` }}
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
    </Chip>
  );
}
