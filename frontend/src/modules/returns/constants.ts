/** Returns vocabulary the screens share. Values mirror `returns/enums.py`. */

export const RETURN_STATUS = {
  DRAFT: "DRAFT",
  PENDING_APPROVAL: "PENDING_APPROVAL",
  APPROVED: "APPROVED",
  RECEIVED: "RECEIVED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
} as const;

/** Draft first, then the live flow, then the endings — the order a return travels. */
export const STATUS_ORDER: string[] = [
  RETURN_STATUS.DRAFT,
  RETURN_STATUS.PENDING_APPROVAL,
  RETURN_STATUS.APPROVED,
  RETURN_STATUS.RECEIVED,
  RETURN_STATUS.REJECTED,
  RETURN_STATUS.CANCELLED,
];

export const STATUS_LABEL: Record<string, string> = {
  [RETURN_STATUS.DRAFT]: "Draft",
  [RETURN_STATUS.PENDING_APPROVAL]: "Pending approval",
  [RETURN_STATUS.APPROVED]: "Approved — stock moved",
  [RETURN_STATUS.RECEIVED]: "Acknowledged",
  [RETURN_STATUS.REJECTED]: "Rejected",
  [RETURN_STATUS.CANCELLED]: "Withdrawn",
};

export const STATUS_FILTER_OPTIONS = [
  { value: "", label: "All statuses" },
  ...STATUS_ORDER.map((value) => ({ value, label: STATUS_LABEL[value] })),
];

/**
 * What the returner wants to happen next. Two options only, so they are radio-shaped
 * rather than a dropdown — the choice changes nothing about how the stock moves and
 * everything about what the decision desk decides.
 */
export const INTENT_OPTIONS = [
  {
    value: "RETURN",
    label: "Return only",
    hint: "Done with it — take it off our books.",
  },
  {
    value: "REPLACEMENT",
    label: "Replacement wanted",
    hint: "Still needed here. Somebody has to watch for it coming back.",
  },
] as const;

/**
 * The desks. Kept as constants because the queue name is a URL parameter the backend
 * validates — a typo here would read as "unknown queue" rather than as an empty list.
 */
export const QUEUE = {
  DECISION: "decision",
  ENDORSEMENT: "endorsement",
} as const;

/**
 * Whether an outcome is destructive enough to be styled as such. Nothing here decides
 * what is ALLOWED — `is_blocked` comes off the server for that, and the service refuses
 * it again regardless of what the button looks like.
 */
export const DESTRUCTIVE_DISPOSITIONS: string[] = [
  "SCRAP",
  "CONTROLLED_DISPOSAL",
  "REJECT_UNECONOMIC",
];

/** Every value that ends the document without moving anything. */
export const STATIC_DISPOSITIONS: string[] = ["USE_AT_SOURCE", "REJECT_UNECONOMIC"];

/** A rupee figure, or an em dash where nothing has been costed. Never ₹0 — the whole
 *  freight-versus-value decision is made against this number, and a zero invented in the
 *  browser is worse than an honest gap. */
export const money = (value: string | number | null | undefined): string =>
  value === null || value === undefined || value === ""
    ? "—"
    : `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
