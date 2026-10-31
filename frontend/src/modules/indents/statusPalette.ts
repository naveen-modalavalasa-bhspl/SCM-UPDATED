/**
 * One palette for every indent status, wherever it is drawn.
 *
 * The donut on the Overview and the status labels on the lists, the activity
 * ledger and the notification cards used to keep their own colour tables, so a
 * slice could be cyan while the same status read amber two rows below it. They
 * all read this file now: `STATUS_COLOR` is the slice, `statusChipStyle` is the
 * same colour as a label, and neither can drift from the other.
 */

/**
 * Four statuses used to share a colour with another status: SUBMITTED with
 * PENDING_APPROVAL, APPROVED with CLOSED, PENDING_PROCUREMENT with ALLOCATED and
 * PARTIALLY_ORDERED with ORDERED. That was harmless while the donut drew neither
 * half of any pair; now that it draws every status, two same-coloured arcs read as
 * one slice. Each pair keeps the colour of the status that was already on the
 * chart, and the newcomer takes a distinct one.
 */
/** Legend dot classes — the marker beside a slice in the chart's legend. */
export const STATUS_INDICATOR: Record<string, string> = {
  DRAFT: "bg-neutral",
  PENDING_APPROVAL: "bg-warn",
  RETURNED_FOR_CORRECTION: "bg-orange-600",
  SUBMITTED: "bg-amber-500",
  APPROVED: "bg-lime-600",
  AWAITING_ALLOCATION: "bg-info",
  ALLOCATED: "bg-purple-500",
  PARTIALLY_FULFILLED: "bg-cyan-600",
  PENDING_PROCUREMENT: "bg-pink-600",
  PARTIALLY_ORDERED: "bg-blue-400",
  ORDERED: "bg-blue-600",
  REJECTED: "bg-bad",
  CLOSED: "bg-ok",
  QC_PASSED: "bg-ok",
  QC_IN_PROGRESS: "bg-warn",
  IN_CONSIGNMENT: "bg-info",
  IN_TRANSIT: "bg-info",
  DELIVERED: "bg-ok",
};

export const STATUS_COLOR: Record<string, string> = {
  DRAFT: "var(--color-neutral)",
  PENDING_APPROVAL: "var(--color-warn)",
  RETURNED_FOR_CORRECTION: "#ea580c",
  RETURNED: "#ea580c",
  SUBMITTED: "#f59e0b",
  APPROVED: "#65a30d",
  AWAITING_ALLOCATION: "var(--color-info)",
  ALLOCATED: "#8b5cf6",
  PARTIALLY_FULFILLED: "#0891b2",
  PENDING_PROCUREMENT: "#db2777",
  PARTIALLY_ORDERED: "#60a5fa",
  ORDERED: "#2563eb",
  REJECTED: "var(--color-bad)",
  CLOSED: "var(--color-ok)",
  CANCELLED: "var(--color-bad)",
  QC_PASSED: "var(--color-ok)",
  QC_IN_PROGRESS: "var(--color-warn)",
  IN_CONSIGNMENT: "var(--color-info)",
  IN_TRANSIT: "var(--color-info)",
  DELIVERED: "var(--color-ok)",
};

export const DEFAULT_STATUS_COLOR = "var(--color-neutral)";

export interface StatusChipStyle {
  color: string;
  backgroundColor: string;
}

/**
 * A label in the slice's own colour: the text is the exact colour the donut
 * paints, on a wash of the same colour so the two are unmistakably one thing.
 * `color-mix` keeps it a single source — a tinted background per status would be
 * a second table to keep in step, which is the bug this file exists to remove.
 */
export function statusChipStyle(status: string): StatusChipStyle | null {
  const color = STATUS_COLOR[status];
  if (!color) return null;
  return { color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` };
}
