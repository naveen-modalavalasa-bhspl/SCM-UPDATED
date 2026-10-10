import { displayUom } from "@/modules/indents/displayFormat";

import type { ApprovalIndentLine } from "./types";

/** Quantities are stored as NUMERIC(16,3); anything finer cannot be persisted. */
export const QUANTITY_DECIMALS = 3;
/** The shape of a number part-way through being typed: "", "-", "1.", "1.25". */
const NUMERIC_SHAPE = /^-?\d*(\.\d*)?$/;
const FALLBACK_WHOLE_UNIT_CODES = new Set([
  "NOS", "NO", "NUM", "EA", "EACH", "PCS", "PC", "PIECE", "PIECES",
  "PAIR", "PACK", "PACKET", "BOX", "BOTTLE", "CAN", "UNIT", "UNITS",
]);

/** The API's UOM classification is authoritative. The code fallback keeps this safe
 * while an older backend is being rolled forward. Unknown units remain divisible. */
export function quantityDecimals(line: ApprovalIndentLine): number {
  const configured = Number(line.uom_decimals);
  if (Number.isInteger(configured) && configured >= 0 && configured <= QUANTITY_DECIMALS) {
    return configured;
  }
  const code = displayUom(line.uom_code).trim().toUpperCase();
  return FALLBACK_WHOLE_UNIT_CODES.has(code) ? 0 : QUANTITY_DECIMALS;
}

/** Whether a value is a valid in-progress edit for this line's unit. */
export function acceptsQuantityInput(line: ApprovalIndentLine, raw: string): boolean {
  const decimals = quantityDecimals(line);
  if (decimals === 0) return /^\d*$/.test(raw);
  return new RegExp(`^\\d*(?:\\.\\d{0,${decimals}})?$`).test(raw);
}

export function quantityEntryHint(line: ApprovalIndentLine): string {
  const decimals = quantityDecimals(line);
  return decimals === 0
    ? "Whole numbers only."
    : `Up to ${decimals} decimal places.`;
}

/**
 * The most this approver may pass on.
 *
 * The server sends it as `max_quantity`: the requested quantity at the first rung of
 * the ladder, and whatever the rung below approved at every rung after that. Quantities
 * only ever come down the ladder, so this — never `requested_quantity` — is the cap the
 * screen enforces. Capping against the request would let the second approver put back
 * what the first one cut, and the server would then reject the decision.
 */
export function approvalCeiling(line: ApprovalIndentLine): number {
  const ceiling = Number(line.max_quantity);
  if (Number.isFinite(ceiling) && ceiling >= 0) return ceiling;
  const requested = Number(line.requested_quantity);
  return Number.isFinite(requested) ? requested : 0;
}

/** 5.000 reads as 5 on a screen someone has to act on. */
export const formatQuantity = (value: number) =>
  String(Number(value.toFixed(QUANTITY_DECIMALS)));

/** True when the line was already cut by an approver below this one. */
export const wasReducedBelow = (line: ApprovalIndentLine) =>
  approvalCeiling(line) < Number(line.requested_quantity);

/** "15 EA" — the cap with its unit, for messages that name the limit itself. */
export function ceilingLabel(line: ApprovalIndentLine): string {
  const unit = displayUom(line.uom_code);
  return `${formatQuantity(approvalCeiling(line))}${unit ? ` ${unit}` : ""}`;
}

/**
 * "0 to 15 EA" — every hint and every error on the screen is built from this one
 * phrase, so an approver is told the same range wherever they happen to look.
 */
export function allowedRange(line: ApprovalIndentLine): string {
  return `0 to ${ceilingLabel(line)}`;
}

/** Digits typed after the decimal point — "1.2345" has four, one more than we store. */
function decimalPlaces(raw: string): number {
  const point = raw.indexOf(".");
  return point < 0 ? 0 : raw.length - point - 1;
}

/**
 * Null when the line may be submitted, else the message to show under the input.
 *
 * The field takes any keystroke — an over-ceiling or nonsense entry is answered here,
 * never by swallowing the key. A box that silently refuses to take a 6 reads as a
 * broken keyboard to someone who does not know the rule, which is exactly the person
 * this screen is for.
 */
export function quantityError(
  line: ApprovalIndentLine, raw: string | undefined,
): string | null {
  const ceiling = approvalCeiling(line);
  const range = allowedRange(line);
  const text = (raw ?? "").trim();

  if (text === "") {
    return `Enter a quantity from ${range}. Enter 0 to reject this item.`;
  }
  // The minus sign is caught on its own keystroke, before the number is even
  // complete: "-" and "-1" are the same mistake, and the approver hears about it
  // at the first one rather than after typing a value we were never going to take.
  if (text.startsWith("-")) {
    return "Cannot enter a negative number.";
  }
  const value = Number(text);
  if (!NUMERIC_SHAPE.test(text) || !Number.isFinite(value)) {
    return `Enter a valid number from ${range}.`;
  }
  const decimals = quantityDecimals(line);
  if (decimals === 0 && text.includes(".")) {
    const unit = displayUom(line.uom_code) || "This unit";
    return `${unit} accepts whole numbers only (for example 1 or 10).`;
  }
  if (value > ceiling) {
    return `You can't approve more than ${ceilingLabel(line)}.`;
  }
  if (decimalPlaces(text) > decimals) {
    return `Use up to ${decimals} decimal places (for example 1.5).`;
  }
  return null;
}

/** The number to send. Only meaningful once `quantityError` returns null. */
export const quantityValue = (raw: string | undefined) => Number(raw ?? 0);
