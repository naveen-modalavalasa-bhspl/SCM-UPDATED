export const INDENT_STATUS = {
  DRAFT: "DRAFT",
  SUBMITTED: "SUBMITTED",
  PENDING_APPROVAL: "PENDING_APPROVAL",
  RETURNED: "RETURNED",
  RETURNED_FOR_CORRECTION: "RETURNED_FOR_CORRECTION",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
  AWAITING_ALLOCATION: "AWAITING_ALLOCATION",
  ALLOCATED: "ALLOCATED",
  PARTIALLY_FULFILLED: "PARTIALLY_FULFILLED",
  PENDING_PROCUREMENT: "PENDING_PROCUREMENT",
  PARTIALLY_ORDERED: "PARTIALLY_ORDERED",
  ORDERED: "ORDERED",
  CLOSED: "CLOSED",
} as const;

/** An indent is with procurement, not with the warehouse, in these statuses. */
export const INDENT_PROCUREMENT_STATUSES: readonly string[] = [
  INDENT_STATUS.PENDING_PROCUREMENT,
  INDENT_STATUS.PARTIALLY_ORDERED,
  INDENT_STATUS.ORDERED,
];

/**
 * The lifecycle the progress card renders, and the contract `journey.phases`
 * is read against: `sequence` is 1-based against this list. The approval ladder
 * is aggregated into the single `approvals` phase, so a ladder of any length —
 * and any rank names — fits without changing this list.
 */
export const INDENT_PHASES = [
  { key: "draft", label: "Draft" },
  { key: "submitted", label: "Submitted" },
  { key: "approvals", label: "Approvals" },
  { key: "allocation", label: "Allocation" },
  { key: "warehouse", label: "Warehouse" },
  { key: "delivery", label: "In-Transit" },
  { key: "acknowledgement", label: "Acknowledgement" },
] as const;

export const INDENT_APPROVALS_PHASE_INDEX = INDENT_PHASES
  .findIndex((phase) => phase.key === "approvals");

/** `stage_type` values that make up one rung of the configured approval ladder. */
export const INDENT_APPROVAL_STAGE_TYPES: readonly string[] = ["approval", "final"];

export const INDENT_PRIORITY = {
  NORMAL: "NORMAL",
  URGENT: "URGENT",
} as const;

export const INDENT_TYPE = {
  REGULAR: "REGULAR",
  MONTHLY: "MONTHLY",
} as const;

/**
 * Regular is the ad-hoc, one-off request; Monthly is the recurring one. Regular is
 * offered alongside Monthly because it is what all existing indents are, and whether
 * it is retired is still an open decision. Removing it from the picker would silently
 * reclassify every request raised from today.
 */
export const INDENT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: INDENT_TYPE.REGULAR, label: "Regular" },
  { value: INDENT_TYPE.MONTHLY, label: "Monthly indent" },
];

const INDENT_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  INDENT_TYPE_OPTIONS.map((option) => [option.value, option.label]),
);

/** Falls back to the raw value so an unknown type still reads as something. */
export function indentTypeLabel(value?: string | null) {
  if (!value) return null;
  return INDENT_TYPE_LABELS[value] ?? value;
}

export const INDENT_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: INDENT_STATUS.DRAFT, label: "Draft" },
  { value: INDENT_STATUS.SUBMITTED, label: "Submitted" },
  { value: INDENT_STATUS.PENDING_APPROVAL, label: "In approval" },
  { value: INDENT_STATUS.RETURNED_FOR_CORRECTION, label: "Returned for correction" },
  { value: INDENT_STATUS.REJECTED, label: "Rejected" },
  { value: INDENT_STATUS.APPROVED, label: "Approved" },
  { value: INDENT_STATUS.AWAITING_ALLOCATION, label: "Awaiting allocation" },
  { value: INDENT_STATUS.ALLOCATED, label: "Allocated" },
  { value: INDENT_STATUS.PARTIALLY_FULFILLED, label: "Partially fulfilled" },
  { value: INDENT_STATUS.PENDING_PROCUREMENT, label: "Pending procurement" },
  { value: INDENT_STATUS.PARTIALLY_ORDERED, label: "Partially ordered" },
  { value: INDENT_STATUS.ORDERED, label: "Ordered" },
  { value: INDENT_STATUS.CLOSED, label: "Closed" },
];

export const INDENT_REQUEST_STATUS_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: INDENT_STATUS.PENDING_APPROVAL, label: "Pending approvals" },
  { value: INDENT_STATUS.ALLOCATED, label: "Allocated" },
  { value: INDENT_STATUS.DRAFT, label: "Draft" },
  { value: INDENT_STATUS.RETURNED_FOR_CORRECTION, label: "Returned for correction" },
  { value: INDENT_STATUS.REJECTED, label: "Rejected" },
  { value: INDENT_STATUS.AWAITING_ALLOCATION, label: "Awaiting allocation" },
  // Procurement sits INSIDE the allocation leg, not after it: the goods were not on a
  // shelf, so the requirement is being bought. Leaving it out of this filter meant the
  // one question a requester whose indent has stalled actually asks — "which of mine
  // are out of stock?" — was the one the board could not be asked.
  { value: INDENT_STATUS.PENDING_PROCUREMENT, label: "Pending procurement" },
  { value: INDENT_STATUS.PARTIALLY_FULFILLED, label: "Partially fulfilled" },
  { value: INDENT_STATUS.CLOSED, label: "Fulfilled" },
];

export const INDENT_ACTIVITY_EVENT_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "RECEIPT_ACKNOWLEDGED", label: "Receipt acknowledged" },
  { value: "MATERIAL_DISPATCHED", label: "Material dispatched" },
  { value: "MATERIAL_ISSUED", label: "Material issued" },
  { value: "STOCK_ALLOCATED", label: "Stock allocated" },
  { value: "APPROVAL_COMPLETED", label: "Approval completed" },
  { value: "REQUEST_SUBMITTED", label: "Request submitted" },
  { value: "REQUEST_CREATED", label: "Request created" },
];

const groupStatuses = (values: readonly string[]) =>
  INDENT_STATUS_OPTIONS.filter((option) => values.includes(option.value));

export const INDENT_STATUS_GROUPS: { label: string; options: { value: string; label: string }[] }[] = [
  {
    label: "Request",
    options: groupStatuses([
      INDENT_STATUS.DRAFT,
      INDENT_STATUS.SUBMITTED,
      INDENT_STATUS.PENDING_APPROVAL,
      INDENT_STATUS.RETURNED_FOR_CORRECTION,
      INDENT_STATUS.REJECTED,
    ]),
  },
  {
    label: "Approved / Fulfilment",
    options: groupStatuses([
      INDENT_STATUS.APPROVED,
      INDENT_STATUS.AWAITING_ALLOCATION,
      INDENT_STATUS.ALLOCATED,
      INDENT_STATUS.PARTIALLY_FULFILLED,
    ]),
  },
  {
    label: "Procurement",
    options: groupStatuses([
      INDENT_STATUS.PENDING_PROCUREMENT,
      INDENT_STATUS.PARTIALLY_ORDERED,
      INDENT_STATUS.ORDERED,
    ]),
  },
  {
    label: "Completed",
    options: INDENT_STATUS_OPTIONS.filter((option) => option.value === INDENT_STATUS.CLOSED),
  },
];

export const INDENT_PRIORITY_OPTIONS: { value: string; label: string }[] = [
  { value: INDENT_PRIORITY.NORMAL, label: "Normal" },
  { value: INDENT_PRIORITY.URGENT, label: "Urgent" },
];

export const INDENT_ACTIVITY_TRANSACTION_OPTIONS: { value: string; label: string }[] = [
  { value: "REQUEST_CREATED", label: "Request created" },
  { value: "REQUEST_SUBMITTED", label: "Request submitted" },
  { value: "APPROVAL_COMPLETED", label: "Approval completed" },
  { value: "REQUEST_REJECTED", label: "Request rejected" },
  { value: "REQUEST_RETURNED", label: "Request returned" },
  {
    value: "APPROVAL_ROUTED_AUTOMATICALLY",
    label: "Approval routed automatically",
  },
  { value: "STOCK_ALLOCATED", label: "Stock allocated" },
  {
    value: "PROCUREMENT_REQUEST_CREATED",
    label: "Procurement request created",
  },
  { value: "MATERIAL_ISSUED", label: "Material issued" },
  { value: "MATERIAL_DISPATCHED", label: "Material dispatched" },
  { value: "RECEIPT_ACKNOWLEDGED", label: "Receipt acknowledged" },
  { value: "BOOKMARK_ADDED", label: "Bookmark added" },
  { value: "BOOKMARK_REMOVED", label: "Bookmark removed" },
];
