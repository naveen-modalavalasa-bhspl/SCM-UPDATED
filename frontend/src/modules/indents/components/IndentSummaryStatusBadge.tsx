import { StatusPill } from "@/shared/components";
import { INDENT_STATUS } from "../constants";

const SUMMARY_STATUS: Record<string, { label: string; tone: string }> = {
  [INDENT_STATUS.AWAITING_ALLOCATION]: {
    label: "AWAITING ALLOCATION",
    tone: "bg-info-bg text-info",
  },
  [INDENT_STATUS.ALLOCATED]: {
    label: "ALLOCATED",
    tone: "bg-purple-50 text-purple-600",
  },
  [INDENT_STATUS.PARTIALLY_FULFILLED]: {
    label: "PARTIALLY FULFILLED",
    tone: "bg-warn-bg text-warn",
  },
  [INDENT_STATUS.RETURNED_FOR_CORRECTION]: {
    label: "Returned for correction",
    tone: "bg-warn-bg text-warn",
  },
  [INDENT_STATUS.CLOSED]: {
    label: "FULFILLED",
    tone: "bg-ok-bg text-ok",
  },
  FULFILLED: {
    label: "FULFILLED",
    tone: "bg-ok-bg text-ok",
  },
};

export function IndentSummaryStatusBadge({ status }: { status: string }) {
  const presentation = SUMMARY_STATUS[status];
  if (!presentation) return <StatusPill status={status} />;
  const casing = status === INDENT_STATUS.RETURNED_FOR_CORRECTION ? "normal-case" : "uppercase";

  return (
    <span className={`inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-full px-2 text-[11px] font-semibold uppercase tracking-wide ${casing} ${presentation.tone}`}>
      {presentation.label}
    </span>
  );
}
