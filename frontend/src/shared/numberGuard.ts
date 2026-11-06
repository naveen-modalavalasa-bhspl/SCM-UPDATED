import { useEffect, useState } from "react";
import { api } from "@/shared/api/client";

/**
 * Quantity boxes refuse what the save would refuse, AS IT IS TYPED (2026-11-03).
 *
 * The server already rejects a fraction of a whole unit at flush (`shared/uom.py`),
 * but every screen let the storekeeper type "5.5" — or "12abc", or "1e3" — into a
 * quantity and only told him at Submit. This guard is installed ONCE, on the document,
 * so every numeric box in every module is covered without each one remembering to:
 *
 * - A numeric box (`type="number"`, `inputmode="numeric|decimal"`, or anything tagged
 *   `data-uom` / `data-decimals`) takes digits only — never a letter, a space, "e" or
 *   "+". A minus sign is refused where the box says `min >= 0` or is a tagged
 *   quantity; a box with no floor at all (a temperature) keeps it.
 * - A box tagged with its line's unit (`data-uom="NOS"`) takes a "." ONLY when that
 *   unit has "Allows decimal" switched on on Masters > UOM (2026-11-04), read
 *   from `GET /api/uom/decimals` — the SAME table the flush guard enforces, resolved the
 *   same way (code, code case-folded, name). Anything else — the table still loading, a
 *   unit or type nobody defined — is whole numbers. `data-decimals="0"` says it outright
 *   (a count of packs is always whole).
 * - Typing, pasting and dropping are all checked; a paste that is not a number for this
 *   box is refused whole rather than half-applied.
 *
 * The server stays the authority for boxes that carry no unit at all; those take a "."
 * and the save decides.
 */

export interface GuardRule {
  /** Decimal places allowed; null = not restricted (the server decides). */
  decimals: number | null;
  /** May the value be negative? */
  negative: boolean;
}

interface UnitRow { code: string; name?: string | null; decimals: number }

let maps: { byCode: Map<string, number>; folded: Map<string, number>; byName: Map<string, number> } | null = null;
let loading: Promise<void> | null = null;

/** Fill the table (exported for tests and for a screen that wants it early). */
export function setUomDecimals(rows: UnitRow[]): void {
  const byCode = new Map<string, number>();
  const folded = new Map<string, number>();
  const byName = new Map<string, number>();
  for (const r of rows) {
    if (!r.code) continue;
    byCode.set(r.code, r.decimals);
    folded.set(r.code.trim().toLowerCase(), r.decimals);
    if (r.name) byName.set(r.name.trim().toLowerCase(), r.decimals);
  }
  maps = { byCode, folded, byName };
}

/** Forget the table, so the next box re-reads it — called after a UOM is saved, so
 *  switching "Allows decimal" bites without a page reload. */
export function resetUomDecimals(): void {
  maps = null;
}

/** Decimals for a unit as a document snapshots it (code or name); null if unknown. */
export function uomDecimals(code: string | null | undefined): number | null {
  if (!code || !maps) return null;
  const key = code.trim().toLowerCase();
  return maps.byCode.get(code) ?? maps.folded.get(key) ?? maps.byName.get(key) ?? null;
}

const onVendorPortal = () =>
  location.pathname.startsWith("/supplier") || location.pathname.startsWith("/carrier");

/** Load the table once per page; a failure is forgotten so the next focus retries. */
export function loadUomDecimals(): Promise<void> {
  if (maps) return Promise.resolve();
  if (loading) return loading;
  const vendor = onVendorPortal();
  // Signed out (the login screen): nothing to ask, and asking would only 401.
  if (!vendor && !localStorage.getItem("token")) return Promise.resolve();
  loading = api
    .get<{ items: UnitRow[] }>(vendor ? "/api/supplier/uom/decimals" : "/api/uom/decimals")
    .then((r) => setUomDecimals(r.data.items ?? []))
    .catch(() => undefined)
    .finally(() => { loading = null; });
  return loading;
}

/** Decimals for a unit, from a component: loads the table on first use and re-renders
 *  once it has arrived. null while unknown — the caller must then treat the unit as
 *  whole (decimals are allowed only where the UOM says so). */
export function useUomDecimals(code: string | null | undefined): number | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!code || maps) return;
    let live = true;
    void loadUomDecimals().then(() => { if (live) setTick((n) => n + 1); });
    return () => { live = false; };
  }, [code]);
  return uomDecimals(code);
}

/** Is this one of the boxes the guard looks after? */
export function isNumericBox(el: EventTarget | null): el is HTMLInputElement {
  if (!(el instanceof HTMLInputElement)) return false;
  if (el.readOnly || el.disabled) return false;
  if (el.type === "number") return true;
  if (el.dataset.uom !== undefined || el.dataset.decimals !== undefined) return true;
  const mode = (el.getAttribute("inputmode") || "").toLowerCase();
  return mode === "numeric" || mode === "decimal";
}

/** The rule for one box, read off its attributes. */
export function ruleFor(el: HTMLInputElement): GuardRule {
  const min = el.getAttribute("min");
  const quantity = el.dataset.uom !== undefined || el.dataset.decimals !== undefined;
  // A box that states no floor keeps its minus sign (a cold-room temperature is -18);
  // one that says min >= 0, or is a tagged quantity, never goes below zero.
  const negative = min === null || min === ""
    ? !quantity
    : Number(min) < 0;
  let decimals: number | null = null;
  if (el.dataset.decimals !== undefined && el.dataset.decimals !== "") {
    const d = Number(el.dataset.decimals);
    decimals = Number.isFinite(d) ? Math.max(0, Math.floor(d)) : null;
  } else if (el.dataset.uom !== undefined) {
    // Strict (2026-11-03): a "." only where the unit's UOM type is DEFINED to allow
    // decimals. Not loaded yet, a unit nobody defined, or no unit on the line at all
    // all mean whole numbers — never "let it through and let the save decide".
    decimals = uomDecimals(el.dataset.uom) ?? 0;
  } else if ((el.getAttribute("inputmode") || "").toLowerCase() === "numeric") {
    decimals = 0;
  }
  return { decimals, negative };
}

/** May this one character be typed into a box with this rule? */
export function charAllowed(ch: string, rule: GuardRule): boolean {
  if (/^[0-9]$/.test(ch)) return true;
  if (ch === ".") return rule.decimals === null || rule.decimals > 0;
  if (ch === "-") return rule.negative;
  return false;
}

/** Is this whole text (a paste, a drop) a number this box may hold? */
export function textAllowed(text: string, rule: GuardRule): boolean {
  const t = text.trim();
  if (t === "") return true;
  const sign = rule.negative ? "-?" : "";
  const frac = rule.decimals === 0 ? "" : rule.decimals === null ? "(\\.\\d*)?" : `(\\.\\d{0,${rule.decimals}})?`;
  return new RegExp(`^${sign}\\d*${frac}$`).test(t) && /\d/.test(t);
}

/** For a text-type box the caret is known: refuse a digit past the allowed decimals. */
function exceedsDecimals(el: HTMLInputElement, insert: string, rule: GuardRule): boolean {
  if (rule.decimals === null || el.type === "number") return false;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const next = el.value.slice(0, start) + insert + el.value.slice(end);
  return !textAllowed(next, rule);
}

let installed = false;

/** Install once, before the app renders. Safe to call twice. */
export function installNumberGuard(doc: Document = document): void {
  if (installed) return;
  installed = true;

  doc.addEventListener("focusin", (e) => {
    if (isNumericBox(e.target) && e.target.dataset.uom) void loadUomDecimals();
  }, true);

  doc.addEventListener("keydown", (e) => {
    if (!isNumericBox(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length !== 1) return; // Backspace, arrows, Tab, Enter …
    const rule = ruleFor(e.target);
    if (!charAllowed(e.key, rule) || exceedsDecimals(e.target, e.key, rule)) e.preventDefault();
  }, true);

  // Mobile keyboards often send "Unidentified" keydowns; the text arrives here.
  doc.addEventListener("beforeinput", (e) => {
    const ev = e as InputEvent;
    if (!isNumericBox(ev.target) || ev.inputType !== "insertText" || !ev.data) return;
    const rule = ruleFor(ev.target);
    if ([...ev.data].some((ch) => !charAllowed(ch, rule)) || exceedsDecimals(ev.target, ev.data, rule)) {
      ev.preventDefault();
    }
  }, true);

  const onTransfer = (text: string | undefined, target: EventTarget | null, e: Event) => {
    if (!isNumericBox(target) || text === undefined) return;
    const rule = ruleFor(target);
    if (!textAllowed(text, rule)) e.preventDefault();
  };
  doc.addEventListener("paste", (e) => onTransfer(e.clipboardData?.getData("text"), e.target, e), true);
  doc.addEventListener("drop", (e) => onTransfer(e.dataTransfer?.getData("text"), e.target, e), true);
}
