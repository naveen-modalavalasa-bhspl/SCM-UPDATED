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

/** Quantities carry 3 decimals in the schema; trailing zeros are noise on screen. */
export const fmtQty = (value?: number | string | null) => {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0.00";
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
