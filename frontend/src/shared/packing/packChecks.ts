/**
 * A breakdown checked PACK BY PACK (2026-10-27) — the GRN ("which cartons arrived,
 * which came short") and inward QC ("which cartons were kept, what came out of
 * them"), the inward mirror of the outward package check.
 *
 * A breakdown says "2 Carton + 1 Carton (20 of 50) + 6 loose". Checking it means
 * naming each physical pack, so it is expanded into one row per pack — Carton 1,
 * Carton 2, Carton 3 — with loose units as a single row of their own. The verdict is
 * the `PackageCheck` the outward screens already use: the packs KEPT, and for a kept
 * pack the units taken out of it. It folds back into two breakdowns:
 *
 *   kept     — a whole kept pack is a full pack again; a kept pack with units out of it
 *              is a PART pack of the same level ("1 Carton (45 of 50)").
 *   lost     — a pack left out whole stays the pack it was; units out of a kept pack
 *              are loose units.
 *
 * Per level the two never hold more packs than the reference did, which is the rule
 * the server checks at both doors (`packing.assert_within` at the GRN,
 * `inspection_line_packs` at QC).
 */
import type { PackageCheck, PackageToCheck } from "@/shared/components/PackageCheckModal";
import { LOOSE, hierarchyOf, heldOf, isPartial, num, type PackEntry } from "./packing";

export interface PhysicalPack extends PackageToCheck {
  level: number;
  /** The entry it was expanded from — its name, size and part fill. */
  entry: PackEntry;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** One row per physical pack, biggest level first and full before part; loose units
 *  are one row. Codes are stable for the same breakdown, so a verdict can be kept. */
export function expandPacks(entries: PackEntry[] | null | undefined): PhysicalPack[] {
  const sorted = [...(entries ?? [])]
    .filter((e) => num(e.qty) > 0)
    .sort((a, b) => b.level - a.level || heldOf(b) - heldOf(a));
  const out: PhysicalPack[] = [];
  const seen: Record<string, number> = {};
  let loose = 0;
  let looseEntry: PackEntry | null = null;
  for (const e of sorted) {
    if (e.level === 0) {
      loose = round3(loose + num(e.qty));
      looseEntry = looseEntry ?? e;
      continue;
    }
    const name = e.name ?? "Pack";
    for (let i = 0; i < Math.floor(num(e.qty)); i += 1) {
      const n = (seen[name] = (seen[name] ?? 0) + 1);
      const part = isPartial(e);
      out.push({
        code: `${name}-${n}`,
        label: `${name} ${n}`,
        group: name,
        detail: part ? `part pack · ${num(e.fill)} of ${num(e.size)}` : `full · ${num(e.size)}`,
        carries: heldOf(e),
        level: e.level,
        entry: e,
      });
    }
  }
  if (loose > 0) {
    out.push({
      code: LOOSE, label: "Loose units", detail: "outside any pack", carries: loose, level: 0,
      entry: looseEntry ?? { level: 0, qty: loose, name: LOOSE, size: 1, item_packaging_id: null },
    });
  }
  return out;
}

/** Everything arrived / kept: the starting verdict. */
export const allKept = (packs: PhysicalPack[]): PackageCheck =>
  ({ kept: packs.map((p) => p.code), partial: {} });

/**
 * Read a verdict back off a breakdown that was decided against `packs` — a saved GRN
 * count, a saved QC acceptance, or a quantity typed into the box and cut down by the
 * form. Each kept entry is matched to the reference pack of its level that holds the
 * most; what is left over (a typed short count lands as loose units) is laid into the
 * unmatched packs biggest first, as packs kept with units missing from them.
 */
export function checkFrom(packs: PhysicalPack[], kept: PackEntry[] | null | undefined): PackageCheck {
  const keptCodes: string[] = [];
  const partial: Record<string, number> = {};
  const free = [...packs];
  let spare = 0;
  const units = expandPacks(kept);
  for (const unit of units) {
    if (unit.level === 0) {
      const ref = free.find((p) => p.level === 0);
      if (!ref) { spare = round3(spare + unit.carries); continue; }
      free.splice(free.indexOf(ref), 1);
      const take = Math.min(unit.carries, ref.carries);
      keptCodes.push(ref.code);
      if (take < ref.carries) partial[ref.code] = round3(ref.carries - take);
      spare = round3(spare + unit.carries - take);
      continue;
    }
    const candidates = free.filter((p) => p.level === unit.level && p.carries >= unit.carries)
      .sort((a, b) => a.carries - b.carries);
    const ref = candidates[0];
    if (!ref) { spare = round3(spare + unit.carries); continue; }
    free.splice(free.indexOf(ref), 1);
    keptCodes.push(ref.code);
    if (unit.carries < ref.carries) partial[ref.code] = round3(ref.carries - unit.carries);
  }
  // Units the matching could not place — a typed count read as loose — go into the
  // packs still unaccounted for, as kept packs short of what they held.
  for (const ref of [...free].sort((a, b) => b.carries - a.carries)) {
    if (spare <= 0) break;
    const take = Math.min(spare, ref.carries);
    keptCodes.push(ref.code);
    if (take < ref.carries) partial[ref.code] = round3(ref.carries - take);
    spare = round3(spare - take);
  }
  return { kept: keptCodes, partial };
}

function entryLike(e: PackEntry, qty: number, fill?: number): PackEntry {
  const out: PackEntry = {
    item_packaging_id: e.item_packaging_id ?? null, level: e.level, name: e.name,
    size: e.size, qty, hierarchy: e.hierarchy,
  };
  if (fill !== undefined && e.level > 0 && fill < num(e.size)) out.fill = fill;
  return out;
}

function merge(rows: PackEntry[]): PackEntry[] {
  const by = new Map<string, PackEntry>();
  for (const e of rows) {
    if (num(e.qty) <= 0) continue;
    const key = `${e.level}:${isPartial(e) ? num(e.fill) : "full"}`;
    const at = by.get(key);
    if (at) at.qty = round3(num(at.qty) + num(e.qty));
    else by.set(key, { ...e });
  }
  return [...by.values()].sort((a, b) => b.level - a.level || heldOf(b) - heldOf(a));
}

/** The verdict as two breakdowns: what is kept, and what is lost (missing / rejected). */
export function splitByCheck(packs: PhysicalPack[], check: PackageCheck):
  { kept: PackEntry[]; lost: PackEntry[]; keptQty: number; lostQty: number } {
  const keptRows: PackEntry[] = [];
  const lostRows: PackEntry[] = [];
  let lostLoose = 0;
  const hierarchy = hierarchyOf(packs.map((p) => p.entry));
  const looseOf = (qty: number): PackEntry =>
    ({ item_packaging_id: null, level: 0, name: LOOSE, size: 1, qty, hierarchy });
  for (const p of packs) {
    const isKept = check.kept.includes(p.code);
    const out = isKept ? Math.min(num(check.partial[p.code]), p.carries) : p.carries;
    const stays = round3(p.carries - out);
    if (p.level === 0) {
      if (stays > 0) keptRows.push(looseOf(stays));
      lostLoose = round3(lostLoose + out);
      continue;
    }
    if (!isKept) {
      lostRows.push(entryLike(p.entry, 1, p.carries));
      continue;
    }
    if (stays > 0) keptRows.push(entryLike(p.entry, 1, stays));
    lostLoose = round3(lostLoose + out);
  }
  if (lostLoose > 0) lostRows.push(looseOf(lostLoose));
  const kept = merge(keptRows.map((e) => ({ ...e, hierarchy: e.hierarchy ?? hierarchy })));
  const lost = merge(lostRows.map((e) => ({ ...e, hierarchy: e.hierarchy ?? hierarchy })));
  const sum = (rows: PackEntry[]) => round3(rows.reduce((s, e) => s + num(e.qty) * heldOf(e), 0));
  return { kept, lost, keptQty: sum(kept), lostQty: sum(lost) };
}

/** "2 of 3 Carton · 10 short" — the line's summary of a verdict, for the grid. */
export function checkSummary(packs: PhysicalPack[], check: PackageCheck,
                             lostNoun: string): string {
  const real = packs.filter((p) => p.level > 0);
  const keptPacks = real.filter((p) => check.kept.includes(p.code)).length;
  const { lostQty } = splitByCheck(packs, check);
  const head = real.length ? `${keptPacks}/${real.length} packs` : "Loose only";
  return lostQty > 0 ? `${head} · ${round3(lostQty).toLocaleString("en-IN")} ${lostNoun}` : head;
}
