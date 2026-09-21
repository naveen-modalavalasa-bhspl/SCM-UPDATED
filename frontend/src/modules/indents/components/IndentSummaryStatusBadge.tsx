import { StatusPill } from "@/shared/components";
import { INDENT_STATUS } from "../constants";
import { pendingApprovalLabel } from "../displayFormat";
import { statusChipStyle } from "../statusPalette";

/**
 * The wording only. The colour comes from `statusPalette`, the same table the
 * Overview donut paints its slices from — a status reads the same colour on the
 * chart, in a list row and on a notification card.
 */
const SUMMARY_LABEL: Record<string, string> = {
  [INDENT_STATUS.AWAITING_ALLOCATION]: "AWAITING ALLOCATION",
  [INDENT_STATUS.ALLOCATED]: "ALLOCATED",
  [INDENT_STATUS.PARTIALLY_FULFILLED]: "PARTIALLY FULFILLED",
  [INDENT_STATUS.RETURNED_FOR_CORRECTION]: "Returned for correction",
  [INDENT_STATUS.RETURNED]: "Returned for correction",
  [INDENT_STATUS.CLOSED]: "FULFILLED",
  FULFILLED: "FULFILLED",
};

export function IndentSummaryStatusBadge({
  status,
  currentApproverName,
}: {
  status: string;
  currentApproverName?: string | null;
}) {
  // FULFILLED is not an indent status; it is what CLOSED is called on screen, and
  // the palette keys off the real status.
  const style = statusChipStyle(status === "FULFILLED" ? INDENT_STATUS.CLOSED : status);
  if (!style) return <StatusPill status={status} />;
  const label = status === INDENT_STATUS.PENDING_APPROVAL
    ? pendingApprovalLabel(currentApproverName)
    : SUMMARY_LABEL[status] ?? status.replace(/_/g, " ");
  const casing = status === INDENT_STATUS.RETURNED_FOR_CORRECTION
    || status === INDENT_STATUS.RETURNED
    ? "normal-case"
    : "uppercase";

  return (
    <span
      data-status={status}
      style={style}
      className={`inline-flex h-6 max-w-full shrink-0 items-center whitespace-nowrap rounded-full px-2 text-[11px] font-semibold uppercase tracking-wide ${casing}`}
    >
      <span className="block max-w-full truncate" title={label}>{label}</span>
    </span>
  );
}
