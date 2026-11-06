/**
 * Goods that reached the requester and are NOT being accepted — the arithmetic and the
 * rules, apart from the screen (2026-11-06).
 *
 * A delivery is counted item by item, carton by carton. Of what was sent, some is accepted,
 * some is turned away for a stated reason (damaged, expired, near expiry, leakage, a broken
 * package, other) and the rest has not come. The rows below are what the person typed for
 * ONE item in ONE carton; `rejectionPayload` is what is sent, and `rejectionProblems` is why
 * it cannot be sent yet, in words, so the same rule drives the tick and the to-do list.
 */

/** One reason a quantity can be turned away for, as the server serves it. */
export interface RejectionReason {
  value: string;
  label: string;
  /** "Other" on its own tells whoever handles the return nothing. */
  needs_comment: boolean;
  /** Goods harmed in transit also open a claim against the carrier. */
  claims_carrier: boolean;
}

/** What is typed in one row. Strings, so "5." and "" can exist while typing. */
export interface RejectionRow {
  id: string;
  reason: string;
  quantity: string;
  comment: string;
}

/** What goes to the server for one row. */
export interface ReceiptRejection {
  reason: string;
  quantity: number;
  comment?: string;
}

let counter = 0;

export const newRejectionRow = (): RejectionRow => ({
  id: `rejection-${++counter}`, reason: "", quantity: "", comment: "",
});

const positive = (value: string): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

/** How much of this item is being turned away, however many reasons it is split over. */
export const rejectedTotal = (rows: RejectionRow[] | undefined): number =>
  Math.round((rows ?? []).reduce((sum, row) => sum + positive(row.quantity), 0) * 1000) / 1000;

const isBlank = (row: RejectionRow) =>
  !row.reason && !row.quantity.trim() && !row.comment.trim();

/**
 * Why these rows cannot be sent yet, one sentence each; empty when they can.
 *
 * A row nobody has touched is not a problem — it is simply not sent — but one that is half
 * filled in is, because "Expired" with no quantity would otherwise be dropped in silence and
 * the person would believe it had been recorded.
 */
export function rejectionProblems(
  rows: RejectionRow[] | undefined, max: number, reasons: RejectionReason[],
): string[] {
  const problems: string[] = [];
  const byValue = new Map(reasons.map((reason) => [reason.value, reason]));
  for (const row of rows ?? []) {
    if (isBlank(row)) continue;
    if (!row.reason) problems.push("Pick a reason for each quantity you are not accepting.");
    else if (positive(row.quantity) <= 0) problems.push("Enter how many you are not accepting.");
    else if (byValue.get(row.reason)?.needs_comment && !row.comment.trim()) {
      problems.push("Say what the problem is when the reason is Other.");
    }
  }
  if (rejectedTotal(rows) > max + 1e-9) {
    problems.push(`Only ${max} came in this package, so no more than that can be turned away.`);
  }
  return [...new Set(problems)];
}

/** The rows that are complete enough to send, as the server wants them. */
export function rejectionPayload(rows: RejectionRow[] | undefined): ReceiptRejection[] {
  return (rows ?? [])
    .filter((row) => row.reason && positive(row.quantity) > 0)
    .map((row) => ({
      reason: row.reason,
      quantity: positive(row.quantity),
      ...(row.comment.trim() ? { comment: row.comment.trim() } : {}),
    }));
}
