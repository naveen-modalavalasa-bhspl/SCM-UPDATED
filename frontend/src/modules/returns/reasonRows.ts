/**
 * Why a return is going back, as rows: a reason, how many, and a note (2026-11-07).
 *
 * One return can hold several ("Damaged 10, Expired 2"); together they must account for
 * every unit on it. The arithmetic lives here, apart from the screen, so the tick on the
 * form, the checklist and the body that is sent all read the same rule. So does the
 * server, which checks it again (`service._assert_reasons`).
 */

/** What is typed in one row. Strings, so "5." and "" can exist while typing. */
export interface ReasonRow {
  id: string;
  reason: string;
  quantity: string;
  note: string;
}

/** What goes to the server for one row. */
export interface ReasonRowWrite {
  reason: string;
  quantity: string;
  note: string | null;
}

let counter = 0;

export const newReasonRow = (quantity = ""): ReasonRow => ({
  id: `reason-${++counter}`, reason: "", quantity, note: "",
});

const positive = (value: string): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** How many units the rows give a reason to. */
export const reasonTotal = (rows: ReasonRow[]): number =>
  round3(rows.reduce((sum, row) => sum + positive(row.quantity), 0));

/**
 * One row is "all of it": its quantity IS the return's total, so nobody is asked to type
 * a number the form already knows. From the second row on, the quantities are theirs.
 */
export const withSingleRowFollowingTotal = (rows: ReasonRow[], total: number): ReasonRow[] =>
  rows.length === 1 ? [{ ...rows[0], quantity: total > 0 ? String(total) : "" }] : rows;

/** Why the rows cannot be saved yet, one sentence each; empty when they can. */
export function reasonProblems(rows: ReasonRow[], total: number): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.reason) problems.push("Pick a reason for every row.");
    else if (seen.has(row.reason)) problems.push("Each reason can be on one row only.");
    else seen.add(row.reason);
    if (row.reason === "OTHER" && !row.note.trim()) {
      problems.push("Say what the problem is when the reason is Others.");
    }
    // A lone row is "all of it" and takes the total, so it is never asked for a number.
    if (rows.length > 1 && positive(row.quantity) <= 0) {
      problems.push("Enter how many for every reason.");
    }
  }
  if (rows.length > 0 && total > 0 && Math.abs(reasonTotal(rows) - total) > 0.0005) {
    problems.push(
      `The reasons add up to ${reasonTotal(rows)} but ${total} is being returned.`);
  }
  return [...new Set(problems)];
}

export const reasonRowsPayload = (rows: ReasonRow[]): ReasonRowWrite[] =>
  rows.filter((row) => row.reason && positive(row.quantity) > 0).map((row) => ({
    reason: row.reason,
    quantity: String(positive(row.quantity)),
    note: row.note.trim() || null,
  }));

/**
 * The rows a saved return opens with: its reasons, else the one it always had, else a
 * blank row (an acknowledgement raises the return before anybody has been asked why).
 */
export function reasonRowsFrom(
  reasons: { reason: string; quantity: string | number; note?: string | null }[] | undefined,
  reason: string | null | undefined,
  reasonNote: string | null | undefined,
  total: number,
): ReasonRow[] {
  if (reasons && reasons.length > 0) {
    return reasons.map((row) => ({
      ...newReasonRow(String(row.quantity)), reason: row.reason, note: row.note ?? "",
    }));
  }
  if (reason) {
    return [{ ...newReasonRow(total > 0 ? String(total) : ""), reason, note: reasonNote ?? "" }];
  }
  return [newReasonRow(total > 0 ? String(total) : "")];
}
