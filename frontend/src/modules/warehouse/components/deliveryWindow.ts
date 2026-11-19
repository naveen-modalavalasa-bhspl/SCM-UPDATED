/**
 * The expected delivery window's rules, pure — the screen's copy of the server's
 * `_guard_delivery_window` (`warehouse/service.py`), so the form says what the save
 * would refuse before anyone presses it. Dates are ISO `YYYY-MM-DD`, which compare
 * correctly as strings.
 */

/** Why the window cannot be saved, in a sentence — or null when it can. */
export function deliveryWindowIssue(
  from: string | null | undefined,
  to: string | null | undefined,
  leaves?: string | null,
): string | null {
  if (from && leaves && from < leaves) {
    return "Delivery cannot start before the consignment leaves.";
  }
  if (to && leaves && to < leaves) {
    return "Delivery cannot end before the consignment leaves.";
  }
  if (from && to && to < from) {
    return "The window ends before it starts — pick an end on or after the start.";
  }
  return null;
}

/** What is still missing, phrased for the form's "cannot save yet" list. */
export function deliveryWindowMissing(
  from: string | null | undefined,
  to: string | null | undefined,
): string | null {
  if (!from && !to) return "Enter the expected delivery window (from and to).";
  if (!from) return "Enter when delivery can start (Arrives from).";
  if (!to) return "Enter the last day of delivery (Arrives by).";
  return null;
}

/** Days the window spans, both ends counted: 22 → 25 is 4. Null when incomplete. */
export function windowDays(
  from: string | null | undefined,
  to: string | null | undefined,
): number | null {
  if (!from || !to) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}
