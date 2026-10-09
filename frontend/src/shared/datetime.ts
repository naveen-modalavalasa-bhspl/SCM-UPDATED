/**
 * One clock for the whole UI: Indian Standard Time.
 *
 * The backend stores wall-clock IST and, on most routes, serialises it naive —
 * `"2026-08-09T09:39:19"` with no offset. `new Date(that)` reads a naive string as
 * the *browser's* local time, so the same event rendered as 09:39 on a laptop in
 * Hyderabad and 04:09 on one set to UTC. A few routes do send an offset. Screens
 * that called `toLocaleString()` directly therefore disagreed with each other, which
 * is the drift seen between modules.
 *
 * `parseIst` closes both holes: a string with no offset is taken as IST (which is
 * what it is), and everything is then rendered in `Asia/Kolkata` regardless of where
 * the browser thinks it is.
 */

const IST = "Asia/Kolkata";

/** True when the string already says which zone it is in (`Z`, `+05:30`, `-08:00`). */
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;

/** A plain calendar date — `2026-08-24`. Every `date` column serialises like this:
 *  due dates, needed-by dates, expected delivery, PO date. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Parses an API timestamp. A naive one means IST, never UTC and never browser-local.
 *
 *  A date-only string gets a midnight of its own FIRST. Without it the offset was
 *  glued straight onto the date — `new Date("2026-08-24+05:30")` — which is not a
 *  format any engine parses, so it came back Invalid Date and every `date` column in
 *  the app rendered as an em-dash: an RFQ that closes, a line that is needed by, an
 *  order that is expected. The data was there the whole time. */
export function parseIst(value?: string | number | Date | null): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") return new Date(value);
  const text = value.trim();
  const stamp = DATE_ONLY.test(text) ? `${text}T00:00:00` : text.replace(" ", "T");
  const d = new Date(HAS_OFFSET.test(stamp) ? stamp : `${stamp}+05:30`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const DATE_OPTS: Intl.DateTimeFormatOptions = {
  day: "2-digit", month: "short", year: "numeric", timeZone: IST,
};
const TIME_OPTS: Intl.DateTimeFormatOptions = {
  hour: "2-digit", minute: "2-digit", hour12: true, timeZone: IST,
};

export const fmtDate = (value?: string | number | Date | null, dash = "—") =>
  parseIst(value)?.toLocaleDateString("en-IN", DATE_OPTS) ?? dash;

export const fmtTime = (value?: string | number | Date | null, dash = "—") =>
  parseIst(value)?.toLocaleTimeString("en-IN", TIME_OPTS) ?? dash;

export const fmtDateTime = (value?: string | number | Date | null, dash = "—") => {
  const d = parseIst(value);
  return d ? d.toLocaleString("en-IN", { ...DATE_OPTS, ...TIME_OPTS }) : dash;
};

/** `2 h ago`, `3 d ago` — for feeds. Falls back to the full stamp past a week. */
export function fmtRelative(value?: string | number | Date | null, dash = "—") {
  const d = parseIst(value);
  if (!d) return dash;
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)} h ago`;
  if (secs < 604_800) return `${Math.floor(secs / 86_400)} d ago`;
  return fmtDate(d);
}

/** Today in IST as `YYYY-MM-DD` — what every date input and API filter takes. */
export const todayIst = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: IST });
