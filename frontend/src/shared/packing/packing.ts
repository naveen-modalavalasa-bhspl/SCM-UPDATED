/**
 * Pack hierarchies — the screen half of `backend/app/shared/packing.py` (2026-10-08).
 *
 * An item is COUNTED in its base unit (the tablet) everywhere; a pack hierarchy says
 * how those units are bagged: "Strip of 10" → Strip (10 TAB) → Box (10 Strip) →
 * Carton (12 Box). A document line names ONE hierarchy and a BREAKDOWN inside it —
 * "1 Carton + 10 Box + 20 Strip" — whose total in base units is the line's quantity.
 *
 * Same rules as the server, so the number a storekeeper watches add up is the number
 * the save will compute. The server is still the one that decides; this only lets the
 * screen say so before the press.
 *
 * PART PACKS (2026-10-11): a level's size is the most one pack holds, not what every
 * pack holds. "1 Carton (500 of 600)" is an entry with `fill: 500`. A level may carry
 * a `min_fill`; making a pack under it is refused where a pack is made, and a pack
 * that falls under it is flagged (`packWarnings`) until somebody repacks it.
 */

export interface PackLevel {
  item_packaging_id: number | null;
  /** 0 = loose base units, 1 = the smallest pack, upwards. */
  level: number;
  name: string;
  /** Base units in ONE of these. */
  size: number;
  /** How many of the level below fit in one. */
  ratio: number;
  /** "Box · 10 Strip (100 TAB)", written by the server. */
  label: string;
  is_default_putaway_unit?: boolean;
  /** The least one pack of this level may be made with, in base units. */
  min_fill?: number | null;
}

export interface PackHierarchy {
  hierarchy_id: number | null;
  name: string;
  base_uom?: string | null;
  /** levels[0] is always LOOSE. */
  levels: PackLevel[];
  is_default?: boolean;
}

/** One level of a breakdown, as stored (snapshotted sizes) or as being edited. */
export interface PackEntry {
  item_packaging_id?: number | null;
  level: number;
  name?: string;
  size?: number | string;
  qty: number | string;
  hierarchy?: string;
  /** A PART pack: what each of these packs really holds. Absent: full. */
  fill?: number | string | null;
  /** On the shelf: the pack is under its level's minimum and wants a repack. */
  below_min?: boolean;
  min_fill?: number | string | null;
}

/** What a request body carries — the server snapshots names and sizes itself. */
export interface PackEntryIn {
  item_packaging_id: number | null;
  level: number;
  qty: number;
  fill?: number;
}

export const LOOSE = "Loose";

export const num = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** 2,400 not 2400.000 — the same figure the server's `fmt` writes. */
export function fmtQty(value: unknown): string {
  const n = num(value);
  return Number.isInteger(n)
    ? n.toLocaleString("en-IN")
    : n.toLocaleString("en-IN", { maximumFractionDigits: 3 });
}

/** Base units in ONE pack of this entry: its fill when it is a part pack. */
export function heldOf(e: PackEntry): number {
  return e.fill != null && e.fill !== "" ? num(e.fill) : num(e.size ?? 1);
}

/** A pack entry holding less than its level's size. */
export function isPartial(e: PackEntry): boolean {
  return e.level > 0 && e.fill != null && e.fill !== "" && num(e.fill) < num(e.size);
}

/** Base units a breakdown holds, off each entry's own (snapshot) size or fill. */
export function baseOf(entries: PackEntry[] | null | undefined): number {
  return round3((entries ?? []).reduce((sum, e) => sum + num(e.qty) * heldOf(e), 0));
}

/** Full packs per level — the tiles of the editor. Part packs are listed apart. */
export function fullCountsOf(entries: PackEntry[] | null | undefined): Record<number, number> {
  const out: Record<number, number> = {};
  for (const e of entries ?? []) {
    if (isPartial(e)) continue;
    out[e.level] = (out[e.level] ?? 0) + num(e.qty);
  }
  return out;
}

export function countsOf(entries: PackEntry[] | null | undefined): Record<number, number> {
  const out: Record<number, number> = {};
  for (const e of entries ?? []) out[e.level] = (out[e.level] ?? 0) + num(e.qty);
  return out;
}

export function hierarchyOf(entries: PackEntry[] | null | undefined): string | undefined {
  return (entries ?? []).find((e) => e.hierarchy)?.hierarchy;
}

/** "1 Carton + 10 Box + 20 Strip = 2,400 TAB" — the sentence every screen shows. */
export function describe(entries: PackEntry[] | null | undefined, uom?: string | null,
                         withTotal = true): string {
  const unit = uom || "units";
  const parts = [...(entries ?? [])]
    .filter((e) => num(e.qty) > 0)
    .sort((a, b) => b.level - a.level)
    .map((e) => e.level === 0
      ? `${fmtQty(e.qty)} loose ${unit}`
      : isPartial(e)
        ? `${fmtQty(e.qty)} ${e.name ?? "pack"} (${fmtQty(e.fill)} of ${fmtQty(e.size)})`
        : `${fmtQty(e.qty)} ${e.name ?? "pack"}`);
  if (!parts.length) return `0 ${unit}`;
  const onlyLoose = (entries ?? []).every((e) => e.level === 0 || num(e.qty) === 0);
  return withTotal && !onlyLoose
    ? `${parts.join(" + ")} = ${fmtQty(baseOf(entries))} ${unit}`
    : parts.join(" + ");
}

/** Make full entries (name, size) from level counts in a hierarchy. */
export function entriesFrom(h: PackHierarchy, counts: Record<number, number>): PackEntry[] {
  return h.levels
    .filter((lv) => num(counts[lv.level]) > 0)
    .sort((a, b) => b.level - a.level)
    .map((lv) => ({
      item_packaging_id: lv.item_packaging_id, level: lv.level,
      name: lv.level === 0 ? LOOSE : lv.name, size: lv.size,
      qty: num(counts[lv.level]), hierarchy: h.name,
    }));
}

/** One part pack of a level, holding `fill`. */
export function partEntry(h: PackHierarchy, level: number, fill: number, qty = 1): PackEntry {
  const lv = h.levels[level];
  return { item_packaging_id: lv.item_packaging_id, level, name: lv.name, size: lv.size,
           qty, fill, hierarchy: h.name };
}

/** Whole packs of the biggest level, and the remainder as ONE part pack of that same
 *  level — "1,000 → 1 Carton + 1 Carton (400 of 600)". Falls back to `greedy` when
 *  the remainder is under the level's minimum: such a pack could not be made. */
export function greedyWithPart(h: PackHierarchy, base: number, level?: number): PackEntry[] {
  const top = Math.min(level ?? h.levels.length - 1, h.levels.length - 1);
  if (top < 1) return greedy(h, base);
  const size = h.levels[top].size;
  const whole = Math.floor((num(base) + 1e-9) / size);
  const rest = round3(num(base) - whole * size);
  const floor = num(h.levels[top].min_fill);
  if (rest > 0 && floor > 0 && rest < floor) return greedy(h, base, top);
  const out = whole > 0 ? entriesFrom(h, { [top]: whole }) : [];
  if (rest > 0) out.push(partEntry(h, top, rest));
  return out;
}

/** Biggest packs first — mirror of `packing.greedy`. A remainder is loose. */
export function greedy(h: PackHierarchy, base: number, maxLevel?: number): PackEntry[] {
  let remaining = num(base);
  const top = Math.min(maxLevel ?? h.levels.length - 1, h.levels.length - 1);
  const counts: Record<number, number> = {};
  for (let level = top; level >= 1; level -= 1) {
    const size = h.levels[level].size;
    const whole = Math.floor((remaining + 1e-9) / size);
    if (whole > 0) {
      counts[level] = whole;
      remaining = round3(remaining - whole * size);
    }
  }
  if (remaining > 0) counts[0] = remaining;
  return entriesFrom(h, counts);
}

/** The packs of `declared` that make up `base`, never more of a level than was
 *  declared — mirror of `packing.shrink_snapshot`. How a short delivery reads. */
export function shrinkWithin(declared: PackEntry[], base: number): PackEntry[] {
  let remaining = num(base);
  const out: PackEntry[] = [];
  for (const e of [...declared].sort((a, b) => heldOf(b) - heldOf(a))) {
    if (e.level === 0) continue;
    const size = heldOf(e);
    const whole = Math.min(num(e.qty), Math.floor((remaining + 1e-9) / size));
    if (whole > 0) {
      out.push({ ...e, qty: whole });
      remaining = round3(remaining - whole * size);
    }
  }
  if (remaining > 0) {
    out.push({ item_packaging_id: null, level: 0, name: LOOSE, size: 1, qty: remaining,
               hierarchy: hierarchyOf(declared) });
  }
  return out;
}

/** Strip a breakdown down to what a request carries. */
export function toPayload(entries: PackEntry[] | null | undefined): PackEntryIn[] {
  return (entries ?? [])
    .filter((e) => num(e.qty) > 0)
    .map((e) => ({ item_packaging_id: e.item_packaging_id ?? null, level: e.level,
                   qty: num(e.qty), ...(isPartial(e) ? { fill: num(e.fill) } : {}) }));
}

/** What is allowed but worth saying — mirror of `packing.warnings`. Never blocks:
 *  two part packs of one level on a line, and a part pack under its minimum. */
export function packWarnings(entries: PackEntry[] | null | undefined, h?: PackHierarchy | null,
                             uom?: string | null): string[] {
  const unit = uom || h?.base_uom || "units";
  const out: string[] = [];
  const part: Record<number, { qty: number; name: string }> = {};
  for (const e of entries ?? []) {
    if (!isPartial(e)) continue;
    const row = part[e.level] ?? { qty: 0, name: e.name ?? "pack" };
    row.qty += num(e.qty);
    part[e.level] = row;
    const floor = num(e.min_fill ?? h?.levels[e.level]?.min_fill);
    if (e.below_min || (floor > 0 && heldOf(e) < floor)) {
      out.push(`${e.name ?? "Pack"} (${fmtQty(e.fill)} of ${fmtQty(e.size)}) is below the ${
        fmtQty(floor)} ${unit} minimum — repack it.`);
    }
  }
  for (const [, row] of Object.entries(part).sort((a, b) => Number(b[0]) - Number(a[0]))) {
    if (row.qty > 1) {
      out.push(`${fmtQty(row.qty)} part-filled ${row.name} on one line — usually only one pack is short. Check the count.`);
    }
  }
  return out;
}

/** Re-read a stored breakdown against the live ladder (sizes may differ only if the
 *  master changed; the stored snapshot stays the truth for what was written). */
export function sameShape(a: PackEntry[] | null | undefined,
                          b: PackEntry[] | null | undefined): boolean {
  const key = (list: PackEntry[] | null | undefined) => (list ?? [])
    .filter((e) => num(e.qty) > 0)
    .map((e) => `${e.level}:${isPartial(e) ? num(e.fill) : "full"}:${num(e.qty)}`)
    .sort().join("|");
  return key(a) === key(b);
}

/** Where a breakdown stands against the quantity it must make. */
export function matchState(entries: PackEntry[] | null | undefined, target?: number | null):
  { state: "match" | "short" | "over" | "free"; gap: number } {
  if (target === undefined || target === null) return { state: "free", gap: 0 };
  const gap = round3(baseOf(entries) - num(target));
  if (gap === 0) return { state: "match", gap: 0 };
  return gap < 0 ? { state: "short", gap: -gap } : { state: "over", gap };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
