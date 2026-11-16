import { displayUom } from "@/modules/indents/displayFormat";
import { quantityProblem } from "@/shared/quantity";

import type { ApprovalIndentLine } from "./types";

/** Quantities are stored as NUMERIC(16,3); anything finer cannot be persisted. */
export const QUANTITY_DECIMALS = 3;

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

/**
 * True when the line was already cut by an approver below this one. What was allocated
 * is not a cut: 6 of 10 served leaves 4 to decide, and the 10 still stands.
 */
export const wasReducedBelow = (line: ApprovalIndentLine) =>
  approvalCeiling(line) + (line.served_quantity ?? 0) < Number(line.requested_quantity);

/**
 * What this approver signs for the whole line: what they typed, plus what is already
 * allocated. The field shows only what is left, but the server stores one approved
 * figure per line. Sending the field alone turned "10, with 6 served" into an approved
 * 4, which read as nothing owed, and the 4 still owed was never served.
 */
export const signedTotal = (line: ApprovalIndentLine, raw: string | undefined) =>
  Number((quantityValue(raw) + (line.served_quantity ?? 0)).toFixed(QUANTITY_DECIMALS));

/** A line at 0 with nothing allocated is rejected; with stock allocated it just stops there. */
export const isRejectedLine = (line: ApprovalIndentLine, raw: string | undefined) =>
  (raw ?? "").trim() !== "" && quantityValue(raw) === 0 && !(line.served_quantity ?? 0);

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

/** Places this line's unit allows — the UOM type's "Allows decimal", else the stored three. */
export const lineDecimals = (line: ApprovalIndentLine): number =>
  line.uom_decimals ?? QUANTITY_DECIMALS;

/** The lowest this approver may enter. 0 unless the server says otherwise. */
export const lineMinimum = (line: ApprovalIndentLine): number => line.min_quantity ?? 0;

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
  const range = allowedRange(line);
  const text = (raw ?? "").trim();

  if (text === "") {
    return `Enter a quantity from ${range}. Enter 0 to reject this item.`;
  }
  // The same judgement the box itself uses, so the keystroke filter and this message
  // can never disagree: the unit's places, the minimum, and the ceiling.
  const unit = displayUom(line.uom_code);
  const problem = quantityProblem(text, {
    decimals: lineDecimals(line), min: lineMinimum(line), max: approvalCeiling(line), unit,
  });
  if (problem?.startsWith("You can't enter more than")) {
    return `You can't approve more than ${ceilingLabel(line)}.`;
  }
  return problem;
}

/** The number to send. Only meaningful once `quantityError` returns null. */
export const quantityValue = (raw: string | undefined) => Number(raw ?? 0);
