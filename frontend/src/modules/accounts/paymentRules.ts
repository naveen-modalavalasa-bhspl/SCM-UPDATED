import type { PayableRow } from "./types";

/** Today as YYYY-MM-DD in the browser's own day, for date inputs. */
export function todayISO(now: Date = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/** How much of an order has gone out, 0–100, for the progress bar on the list. */
export function paidPercent(row: Pick<PayableRow, "paid" | "total_amount">): number {
  if (!row.total_amount) return 0;
  return Math.max(0, Math.min(100, Math.round((row.paid / row.total_amount) * 100)));
}
