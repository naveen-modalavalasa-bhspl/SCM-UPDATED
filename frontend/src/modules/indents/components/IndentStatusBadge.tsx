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
 * and the next HCM cutover re-keys the roles without touching this file. It also hid
 * the approver's NAME behind their rank, which is the one thing the badge is for.
 */
function stageOwner(stage?: IndentJourneyStage) {
  const approver = stage?.approver_name?.trim().replace(/\s+/g, " ");
  if (approver) return approver;
  const position = stage?.position_name?.trim().replace(/\s+/g, " ");
  if (position) return position;
  const title = stage?.title?.trim().replace(/\s+/g, " ")
    .replace(/\s+(Review|Approval)$/i, "").trim();
  return title || null;
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
      {/* Names come from HCM and can be long — truncate, never abbreviate. */}
      <span className="block max-w-56 truncate" title={label}>{label}</span>
    </Chip>
  );
}
