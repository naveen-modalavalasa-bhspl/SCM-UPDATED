/**
 * Formatting helpers shared by the warehouse screens.
 *
 * These replace the module's old `utils/helpers.ts`, which carried its own colour
 * table (antd hex values) for every status. Colour is a design-token decision and
 * lives in `index.css`; a module that hardcodes `#fa8c16` drifts the moment the
 * theme moves. Everything here is text and number formatting only.
 */

/** `whs_warehouse_items.status` is lower_snake in the schema while every other
 *  document is UPPER_SNAKE. `<StatusPill>` keys off the upper form, so normalise
 *  once here rather than remembering per screen. */
export const normaliseStatus = (status?: string | null) =>
  (status ?? "").toString().trim().toUpperCase().replace(/[\s-]+/g, "_");

/** Sentence-cases a status/enum for prose. `IN_PROGRESS` -> `In progress`. */
export const humanise = (value?: string | null) => {
  const s = normaliseStatus(value);
  if (!s) return "—";
  const words = s.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

// Dates come from `@/shared/datetime`, which pins every screen to IST. These used to
// format in whatever zone the browser was in, against a backend that serialises IST
// without an offset — so the same GRN read 09:39 on one machine and 04:09 on another.
export { fmtDate, fmtDateTime, fmtTime } from "@/shared/datetime";

/** Today as `YYYY-MM-DD`, the shape every date input and the API both take. IST:
 *  `toISOString()` is UTC, so after 18:30 it handed back yesterday. */
export { todayIst as today } from "@/shared/datetime";

/** Quantities carry 3 decimals in the schema and are shown at TWO, always.
 *
 *  Trimming the trailing zeros reads as tidier and is worse on a warehouse screen:
 *  a column of 12.5, 3, 7.25 has its decimal point in a different place on every
 *  row, so a storekeeper scanning it cannot compare two figures at a glance, and
 *  `12.5` beside `12.05` is one keystroke away from being read as the same number.
 *  A fixed two is what every quantity on a printed picking list has. */
export const fmtQty = (value?: number | string | null) => {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0.00";
  return n.toLocaleString(undefined,
                          { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** A rate, at the two decimals money is written in.
 *
 *  `whs` rate columns are `NUMERIC(16, 4)` and Pydantic serialises a Decimal at the
 *  scale the database holds, so every rate arrives as `125.0000` and a plain number
 *  box shows it that way. Four decimals on a purchase rate is not extra accuracy on
 *  a screen, it is two digits of noise on every line of a GRN, and an invoice has
 *  two. Returns null for a blank so an empty box stays empty rather than becoming 0,
 *  which is a price somebody would have had to agree to.
 *
 *  The COLUMN keeps its four: this rounds what a person reads and types, and a rate
 *  already stored finer than this is only re-rounded if the line is edited. */
export const rate2 = (value?: number | string | null) => {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

export const fmtMoney = (value?: number | string | null) => {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0.00";
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** Compact money for KPI tiles — 12.4L reads better than 1,240,000 in a 120px box. */
export const fmtMoneyShort = (value?: number | string | null) => {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)} K`;
  return n.toFixed(0);
};

/** Whole days until `value`. Negative means it is already past. */
export const daysUntil = (value?: string | null) =>
  value ? Math.ceil((new Date(value).getTime() - Date.now()) / 86_400_000) : null;

export const num = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Guards a division so an empty warehouse renders 0%, not NaN%. */
export const percent = (part: unknown, whole: unknown) => {
  const w = num(whole);
  return w === 0 ? 0 : Math.round((num(part) / w) * 100);
};
