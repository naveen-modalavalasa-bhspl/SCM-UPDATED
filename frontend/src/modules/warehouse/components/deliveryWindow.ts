/**
 * The consignment's two dates, pure (2026-11-20): the DISPATCH DATE (when it leaves —
 * `expected_delivery_from` on the wire) and the EXPECTED DELIVERY (when it should be
 * there — `expected_delivery`). The screen's copy of the server's
 * `_guard_delivery_window` (`warehouse/service.py`), so the form says what the save
 * would refuse before anyone presses it. Dates are ISO `YYYY-MM-DD`, which compare
 * correctly as strings.
 */

/** Why the dates cannot be saved, in a sentence — or null when they can. */
export function deliveryWindowIssue(
  dispatch: string | null | undefined,
  delivery: string | null | undefined,
  consignmentDate?: string | null,
): string | null {
  if (dispatch && consignmentDate && dispatch < consignmentDate) {
    return "The dispatch date cannot be before the consignment date.";
  }
  if (delivery && consignmentDate && delivery < consignmentDate) {
    return "Expected delivery cannot be before the consignment date.";
  }
  if (dispatch && delivery && delivery < dispatch) {
    return "Expected delivery cannot be before the dispatch date.";
  }
  return null;
}

/** What is still missing, phrased for the form's "complete these" list. */
export function deliveryWindowMissing(
  dispatch: string | null | undefined,
  delivery: string | null | undefined,
): string | null {
  if (!dispatch && !delivery) return "Enter the dispatch date and the expected delivery date.";
  if (!dispatch) return "Enter the dispatch date.";
  if (!delivery) return "Enter the expected delivery date.";
  return null;
}

/** Days on the road, both ends counted as calendar days: 22 → 25 is 3. Null when incomplete. */
export function windowDays(
  dispatch: string | null | undefined,
  delivery: string | null | undefined,
): number | null {
  if (!dispatch || !delivery) return null;
  const a = Date.parse(`${dispatch}T00:00:00Z`);
  const b = Date.parse(`${delivery}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return Math.round((b - a) / 86_400_000);
}

export type DueTone = "ok" | "soon" | "late" | "muted";

/**
 * A date read against today, in the words a desk uses: "Today", "Tomorrow",
 * "In 3 days", "2 days ago" — and, for a date the goods should have MET and have not
 * (`pending`), "2 days late" in the late tone. `today` is passed in so it is testable.
 */
export function dueHint(
  date: string | null | undefined,
  today: string,
  { pending = false }: { pending?: boolean } = {},
): { text: string; tone: DueTone } | null {
  if (!date) return null;
  const d = Math.round((Date.parse(`${date.slice(0, 10)}T00:00:00Z`)
    - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (Number.isNaN(d)) return null;
  if (d === 0) return { text: "Today", tone: pending ? "soon" : "muted" };
  if (d === 1) return { text: "Tomorrow", tone: pending ? "soon" : "muted" };
  if (d > 1) return { text: `In ${d} days`, tone: "muted" };
  if (pending) return { text: `${-d} day${d === -1 ? "" : "s"} late`, tone: "late" };
  return { text: `${-d} day${d === -1 ? "" : "s"} ago`, tone: "muted" };
}

/** Which of the two dates a document still has to MEET, by its status — the only
 *  case a date is called "late". Covers a consignment's statuses and a shipment's. */
const LEFT = new Set(["DISPATCHED", "IN_TRANSIT", "DELIVERED", "ACKNOWLEDGED", "CLOSED",
  "CANCELLED", "REJECTED"]);
const ARRIVED = new Set(["DELIVERED", "ACKNOWLEDGED", "CLOSED", "CANCELLED", "REJECTED"]);

export function schedulePending(status?: string | null): { dispatch: boolean; delivery: boolean } {
  const value = (status ?? "").toUpperCase();
  return { dispatch: !LEFT.has(value), delivery: !ARRIVED.has(value) };
}
