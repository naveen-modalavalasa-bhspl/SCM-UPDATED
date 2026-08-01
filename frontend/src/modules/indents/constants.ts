export const INDENT_STATUS = {
  DRAFT: "DRAFT",
  SUBMITTED: "SUBMITTED",
  PENDING_APPROVAL: "PENDING_APPROVAL",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  AWAITING_ALLOCATION: "AWAITING_ALLOCATION",
  ALLOCATED: "ALLOCATED",
  PARTIALLY_FULFILLED: "PARTIALLY_FULFILLED",
  PENDING_PROCUREMENT: "PENDING_PROCUREMENT",
  PARTIALLY_ORDERED: "PARTIALLY_ORDERED",
  ORDERED: "ORDERED",
  CLOSED: "CLOSED",
} as const;

export const INDENT_PRIORITY = {
  NORMAL: "NORMAL",
  URGENT: "URGENT",
} as const;

export const INDENT_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: INDENT_STATUS.DRAFT, label: "Draft" },
  { value: INDENT_STATUS.SUBMITTED, label: "Submitted" },
  { value: INDENT_STATUS.PENDING_APPROVAL, label: "In approval" },
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
  { value: INDENT_STATUS.REJECTED, label: "Rejected" },
  { value: INDENT_STATUS.AWAITING_ALLOCATION, label: "Awaiting allocation" },
];

export const INDENT_ACTIVITY_EVENT_FILTER_OPTIONS: { value: string; label: string }[] = [
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
  { value: "BOOKMARK_ADDED", label: "Bookmark added" },
  { value: "BOOKMARK_REMOVED", label: "Bookmark removed" },
];
