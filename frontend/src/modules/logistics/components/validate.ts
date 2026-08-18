/** Field rules for the logistics screens — one copy, used by every form.
 *
 * Kept beside `modeCopy.ts` rather than inside a page for the same reason the mode
 * rules are served by the backend: a phone number is ten digits on the transport form
 * and on the dispatch form and on the vendor register, and three screens each holding
 * their own idea of that is three screens that disagree the first time one is changed.
 *
 * These are FRONT-of-house checks: they stop a press that the service would refuse
 * anyway, and they say which field is wrong before the round trip. They are not the
 * authority — `service.py` still validates everything (rule 2, and hiding a button is
 * not security). Nothing here may be the only place a rule exists.
 *
 * Every function returns a message or `null`, so a caller reads as
 * `const err = phoneError(v)` and a form collects them in one list.
 */

/** An Indian mobile number as the business writes it: ten digits, nothing else.
 *
 *  Anything the user might reasonably paste — spaces, dashes, brackets, a +91 or a
 *  leading 0 — is stripped before counting, because refusing "+91 98765 43210" as
 *  "not ten digits" is technically true and useless. What is left must be ten digits
 *  and must not start with a 0..5: no Indian mobile does, and a landline typed into a
 *  driver's mobile field is a number nobody answers on the day. */
export const PHONE_HINT = "10 digits";

export function digitsOf(value: string | null | undefined): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  // Drop a country code or a trunk prefix so the ten that matter are what is counted.
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

export function phoneError(value: string | null | undefined,
                           label = "Phone"): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;                      // optional unless a caller says otherwise
  const digits = digitsOf(raw);
  if (!/^\d+$/.test(digits) || digits.length !== 10) {
    return `${label} must be 10 digits`;
  }
  if (/^[0-5]/.test(digits)) {
    return `${label} does not look like a mobile number`;
  }
  return null;
}

/** Today, as the `yyyy-mm-dd` a native date input wants for `min`.
 *
 *  Built from the LOCAL date parts, never `toISOString()`: that converts to UTC first,
 *  so anywhere east of Greenwich — India by five and a half hours — it hands back
 *  yesterday for most of the evening, and the calendar quietly blocks today. */
export function todayISO(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** A date that must not be in the past — a delivery is always promised forward.
 *
 *  Compared as strings, which is safe for `yyyy-mm-dd` and avoids the timezone trap of
 *  parsing the value into a Date and comparing instants. `min` on the input already
 *  greys out the earlier days; this catches the value typed in by keyboard, which no
 *  browser blocks. */
export function notPastError(value: string | null | undefined,
                             label = "Date"): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw < todayISO()) return `${label} cannot be in the past`;
  return null;
}

export function requiredError(value: unknown, label: string): string | null {
  const empty = value === null || value === undefined
    || (typeof value === "string" && !value.trim())
    || (Array.isArray(value) && value.length === 0);
  return empty ? `${label} is required` : null;
}

/** A quantity, weight or amount. Zero is allowed only where a caller says so — a
 *  freight of 0 is a real answer on an own-vehicle leg, a quantity of 0 never is. */
export function numberError(value: string | number | null | undefined, label: string,
                            { min = 0, allowZero = true, max }:
                            { min?: number; allowZero?: boolean; max?: number } = {},
                            ): string | null {
  const raw = typeof value === "string" ? value.trim() : value;
  if (raw === "" || raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return `${label} must be a number`;
  if (n < min) return `${label} cannot be less than ${min}`;
  if (!allowZero && n === 0) return `${label} must be more than 0`;
  if (max !== undefined && n > max) return `${label} cannot be more than ${max}`;
  return null;
}

/** Keystroke filter for a phone box: digits, and the punctuation people paste. Lets a
 *  half-typed number exist — validation is what judges it, not the keyboard. */
export const sanitizePhone = (value: string) =>
  value.replace(/[^\d+\-\s()]/g, "").slice(0, 18);

/** Keystroke filter for a numeric box that must stay non-negative. */
export const sanitizeNumber = (value: string) =>
  value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");

/** The problems worth showing, in order, with the empties dropped. */
export const problems = (...errors: (string | null | undefined)[]): string[] =>
  errors.filter((e): e is string => Boolean(e));
