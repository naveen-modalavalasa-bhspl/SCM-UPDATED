import { fmtDate } from "@/shared/datetime";
import type { UnitWarranty } from "../types";

/** The chip colour for a warranty's state — red ended, amber ending within 30 days. */
export function warrantyTone(status?: UnitWarranty["status"] | null): string {
  if (status === "EXPIRED") return "bg-danger-bg text-danger";
  if (status === "EXPIRING") return "bg-warn-bg text-warn";
  if (status === "ACTIVE") return "bg-ok-bg text-ok";
  return "bg-content3 text-muted";
}

/** `YYYY-MM-DD` plus whole years, minus a day: a 1-year warranty from 20 Nov 2026
 *  runs to 19 Nov 2027. 29 Feb lands on 28 Feb in a common year. */
export function addYears(iso: string, years: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const target = new Date(Date.UTC(y + years, m - 1, 1));
  const lastDay = new Date(Date.UTC(y + years, m, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  target.setUTCDate(target.getUTCDate() - 1);
  return target.toISOString().slice(0, 10);
}

/** "20 Nov 2026 – 19 Nov 2027 · card W-22 · added by Anita". */
export function coverSentence(w: UnitWarranty): string {
  return [
    `${fmtDate(w.start_date)} – ${fmtDate(w.end_date)}`,
    w.card_no && `card ${w.card_no}`,
    w.added_by_name && `added by ${w.added_by_name}`,
  ].filter(Boolean).join(" · ");
}
