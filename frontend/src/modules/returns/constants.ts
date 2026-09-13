/** Returns vocabulary the screens share. Values mirror `returns/enums.py`. */

export const RETURN_STATUS = {
  DRAFT: "DRAFT",
  PENDING_APPROVAL: "PENDING_APPROVAL",
  APPROVED: "APPROVED",
  /** Logistics released the load: the stock has left the branch and is on the road. */
  DISPATCHED: "DISPATCHED",
  RECEIVED: "RECEIVED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
} as const;

/** Draft first, then the live flow, then the endings — the order a return travels. */
export const STATUS_ORDER: string[] = [
  RETURN_STATUS.DRAFT,
  RETURN_STATUS.PENDING_APPROVAL,
  RETURN_STATUS.APPROVED,
  RETURN_STATUS.DISPATCHED,
  RETURN_STATUS.RECEIVED,
  RETURN_STATUS.REJECTED,
  RETURN_STATUS.CANCELLED,
];

export const STATUS_LABEL: Record<string, string> = {
  [RETURN_STATUS.DRAFT]: "Draft",
  [RETURN_STATUS.PENDING_APPROVAL]: "Pending approval",
  // No longer "stock moved": approval and despatch stopped being the same instant when
  // the logistics leg landed, and a travelling return is still on the branch shelf here.
  [RETURN_STATUS.APPROVED]: "Approved",
  [RETURN_STATUS.DISPATCHED]: "Dispatched",
  [RETURN_STATUS.RECEIVED]: "Completed",
  [RETURN_STATUS.REJECTED]: "Rejected",
  [RETURN_STATUS.CANCELLED]: "Withdrawn",
};

/** The two journeys a decision can put the material on. Mirrors `ReturnLeg`. */
export const RETURN_LEG = {
  STORE: "STORE",
  SUPPLIER: "SUPPLIER",
} as const;

/**
 * Which stage is holding the document. Mirrors the phase markers in `returns/service.py`.
 * The first three are all PENDING_APPROVAL, so the status alone cannot separate them.
 */
export const PHASE = {
  DECISION: "DECISION",
  ENDORSE: "ENDORSE",
  FIELD: "FIELD",
  LOGISTICS: "LOGISTICS",
} as const;

export const STATUS_FILTER_OPTIONS = [
  { value: "", label: "All statuses" },
  ...STATUS_ORDER.map((value) => ({ value, label: STATUS_LABEL[value] })),
];

/**
 * Which family of return this is — recorded on the document rather than inferred from
 * which table the row came out of, because the register shows both and a row has to say
 * which it is. Mirrors `ReturnKind` in `returns/enums.py`.
 *
 * A FIELD return comes off a branch shelf and goes back into our own network; a PURCHASE
 * return goes back to the vendor who supplied it and the outcome is a credit note or a
 * replacement. The choice does not skip the decision desk — where the material actually
 * ends up is still that desk's call (`TO_VENDOR` is the disposition that sends it out) —
 * it tells the desk what the branch believes it is looking at.
 */
export const KIND_OPTIONS = [
  {
    value: "FIELD",
    label: "Return",
    hint: "Back into our own network — another stocking point, or written off here.",
  },
  {
    value: "PURCHASE",
    label: "Purchase return",
    hint: "Back to the vendor who supplied it. Expect a credit note or a replacement.",
  },
] as const;

/**
 * What the returner wants to happen next. NOT asked on the raise form any more
 * (2026-09-07) — the branch answering it changed nothing about how the stock moves, and
 * where the material ends up was always the decision desk's call, so a new return
 * carries the RETURN default. The field is still on the document and the desk, the
 * queue and the detail page all read `intent_label` off the server, never this list;
 * these labels are kept only for a screen that wants to offer the choice again.
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
  /** Not an approval backlog — what is waiting on a vehicle, and what is on one. */
  LOGISTICS: "logistics",
  /** ADDED 2026-09-10. What has LEFT the gate and is waiting to be signed for at the
   *  far end. Not an approval backlog either: the press on it is a receipt. */
  RECEIPT: "receipt",
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

/**
 * The RANK on its own, out of an approver label the server sends as `NAME (RANK)`.
 *
 * The tracker has ~90px of width and a 10px caption per dot, and the whole label wrapped
 * to three lines there — "MAHENDRA Y scm (SCM HEAD)" under a 28px circle reads as a name
 * with something bracketed after it rather than as the desk the document is sitting on.
 * A rung is a RANK (CLAUDE.md rule 8), which is the part that answers "who signs this",
 * so the tracker keeps the rank and drops the holder. The person is still named in full
 * where there is room for it — the current-stage line, the approval trail, the journey
 * screen — so nothing is lost, only unstacked.
 *
 * A no-op on anything without a bracketed tail, which is every other caption the journey
 * serves ("Raised", "Nothing to move", "Scrap · … · sent back 2×"). Comma-separated
 * because that is exactly how the server joins several holders of one rung; duplicates
 * collapse, since two people at the same rank are one rank.
 */
const NAMED_RANK = /\(([^()]+)\)\s*$/;

export const roleOnly = (text: string | null | undefined): string => {
  const ranks = String(text ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.match(NAMED_RANK)?.[1]?.trim() || part);
  return [...new Set(ranks)].join(", ");
};
