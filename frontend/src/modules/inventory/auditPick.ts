/**
 * What a stock-audit write-off picks, and how much that covers (2026-10-31).
 *
 * The server is the authority (`warehouse/audit_writeoff.py`) — it refuses any pick
 * that does not cover the shortfall exactly. These rules only let the screen say so
 * before the press, off the same `AuditSources` the server checks against:
 *
 * - a pack picked whole takes everything inside it, so whatever is inside is COVERED
 *   and cannot be picked as well (the same goods counted twice);
 * - picking a pack replaces any pick already made inside it;
 * - nothing may take the pick past the shortfall;
 * - `suggestPick` fills a CODES lot with whole packs first (largest that fit), then
 *   loose units, then units out of part-open packs. It never runs for serials or
 *   IMEIs: those are picked by hand, one unit at a time, everywhere in the app.
 */
import type { AuditPack, AuditSources, AuditUnit } from "./types";

export interface Pick {
  packIds: Set<number>;
  unitIds: Set<number>;
}

export const emptyPick = (): Pick => ({ packIds: new Set(), unitIds: new Set() });

/** Packs by the pack they sit in (`null` = standing on its own in this lot). */
export function childrenOf(packs: AuditPack[]): Map<number | null, AuditPack[]> {
  const out = new Map<number | null, AuditPack[]>();
  for (const pack of packs) {
    const list = out.get(pack.parent_id) ?? [];
    list.push(pack);
    out.set(pack.parent_id, list);
  }
  return out;
}

/** Every pack inside `packId`, at any depth. */
export function descendants(packId: number, children: Map<number | null, AuditPack[]>): Set<number> {
  const out = new Set<number>();
  const stack = [...(children.get(packId) ?? [])];
  while (stack.length) {
    const pack = stack.pop()!;
    out.add(pack.id);
    stack.push(...(children.get(pack.id) ?? []));
  }
  return out;
}

/** Every pack around `packId`, innermost first. */
export function ancestors(packId: number | null, byId: Map<number, AuditPack>): number[] {
  const out: number[] = [];
  let id = packId != null ? byId.get(packId)?.parent_id ?? null : null;
  while (id != null && !out.includes(id)) {
    out.push(id);
    id = byId.get(id)?.parent_id ?? null;
  }
  return out;
}

/** What the picked packs already take: the packs and units inside them. */
export function covered(pick: Pick, sources: AuditSources): { packs: Set<number>; units: Set<number> } {
  const children = childrenOf(sources.packs);
  const packs = new Set<number>();
  for (const id of pick.packIds) for (const inner of descendants(id, children)) packs.add(inner);
  const inside = new Set<number>([...pick.packIds, ...packs]);
  const units = new Set<number>(
    sources.units.filter((u) => u.pack_id != null && inside.has(u.pack_id)).map((u) => u.id));
  return { packs, units };
}

/** How much the pick writes off: what each picked pack holds, plus one per unit. */
export function pickedTotal(pick: Pick, sources: AuditSources): number {
  const byId = new Map(sources.packs.map((p) => [p.id, p]));
  let total = 0;
  for (const id of pick.packIds) total += byId.get(id)?.holds ?? 0;
  return total + pick.unitIds.size;
}

/** What picking this pack would ADD: its contents, less whatever inside it is
 *  already picked (that pick is replaced by the whole pack). */
export function packDelta(pack: AuditPack, pick: Pick, sources: AuditSources): number {
  if (pick.packIds.has(pack.id)) return 0;
  const inner = { packIds: new Set<number>(), unitIds: new Set<number>() };
  const children = childrenOf(sources.packs);
  const under = descendants(pack.id, children);
  under.add(pack.id);
  for (const id of pick.packIds) if (under.has(id) && id !== pack.id) inner.packIds.add(id);
  for (const unit of sources.units) {
    if (pick.unitIds.has(unit.id) && unit.pack_id != null && under.has(unit.pack_id)) {
      inner.unitIds.add(unit.id);
    }
  }
  return pack.holds - pickedTotal(inner, sources);
}

/** Why this pack cannot be picked right now, or null when it can. */
export function packBlocked(pack: AuditPack, pick: Pick, sources: AuditSources,
                            shortfall: number): string | null {
  if (pick.packIds.has(pack.id)) return null;
  if (!pack.selectable) return pack.held_by ? `Held — ${pack.held_by}` : "Cannot be written off whole";
  const byId = new Map(sources.packs.map((p) => [p.id, p]));
  if (ancestors(pack.id, byId).some((id) => pick.packIds.has(id))) return "Inside a pack you picked";
  const left = shortfall - pickedTotal(pick, sources);
  if (packDelta(pack, pick, sources) > left) return `Holds more than the ${fmt(left)} still to pick`;
  return null;
}

/** Why this unit cannot be picked right now, or null when it can. */
export function unitBlocked(unit: AuditUnit, pick: Pick, sources: AuditSources,
                            shortfall: number): string | null {
  if (pick.unitIds.has(unit.id)) return null;
  if (!unit.selectable) return unit.held_by ? `Held — ${unit.held_by}` : "Not available";
  if (covered(pick, sources).units.has(unit.id)) return "Inside a pack you picked";
  if (pickedTotal(pick, sources) >= shortfall) return "The shortfall is covered";
  return null;
}

/** Pick or unpick a whole pack. Picking it replaces any pick made inside it. */
export function togglePack(pick: Pick, pack: AuditPack, sources: AuditSources): Pick {
  const packIds = new Set(pick.packIds);
  const unitIds = new Set(pick.unitIds);
  if (packIds.has(pack.id)) {
    packIds.delete(pack.id);
    return { packIds, unitIds };
  }
  const under = descendants(pack.id, childrenOf(sources.packs));
  for (const id of under) packIds.delete(id);
  under.add(pack.id);
  for (const unit of sources.units) {
    if (unit.pack_id != null && under.has(unit.pack_id)) unitIds.delete(unit.id);
  }
  packIds.add(pack.id);
  return { packIds, unitIds };
}

export function toggleUnit(pick: Pick, unit: AuditUnit): Pick {
  const unitIds = new Set(pick.unitIds);
  if (unitIds.has(unit.id)) unitIds.delete(unit.id);
  else unitIds.add(unit.id);
  return { packIds: new Set(pick.packIds), unitIds };
}

/** A starting pick for a CODES lot: whole packs (largest that fit, outermost first),
 *  then loose units, then units out of part-open packs. Never for serials / IMEIs. */
export function suggestPick(sources: AuditSources, shortfall: number): Pick {
  let pick = emptyPick();
  if (sources.mode !== "CODES") return pick;
  const byId = new Map(sources.packs.map((p) => [p.id, p]));
  const packs = [...sources.packs].sort((a, b) =>
    b.holds - a.holds || ancestors(a.id, byId).length - ancestors(b.id, byId).length || a.id - b.id);
  for (const pack of packs) {
    if (pickedTotal(pick, sources) >= shortfall) break;
    if (!packBlocked(pack, pick, sources, shortfall)) pick = togglePack(pick, pack, sources);
  }
  const units = [...sources.units].sort((a, b) =>
    Number(a.pack_id != null) - Number(b.pack_id != null) || a.id - b.id);
  for (const unit of units) {
    if (pickedTotal(pick, sources) >= shortfall) break;
    if (!unitBlocked(unit, pick, sources, shortfall)) pick = toggleUnit(pick, unit);
  }
  return pick;
}

/** The codes the server is sent: picked pack codes, then picked unit codes. */
export function codesOf(pick: Pick, sources: AuditSources): string[] {
  return [
    ...sources.packs.filter((p) => pick.packIds.has(p.id)).map((p) => p.code),
    ...sources.units.filter((u) => pick.unitIds.has(u.id)).map((u) => u.code),
  ];
}

/** A saved line's codes read back into a pick against the lot as it stands now. */
export function pickFromCodes(codes: string[], sources: AuditSources): Pick {
  const wanted = new Set(codes);
  return {
    packIds: new Set(sources.packs.filter((p) => wanted.has(p.code)).map((p) => p.id)),
    unitIds: new Set(sources.units.filter((u) => wanted.has(u.code)
      || (u.alt != null && wanted.has(u.alt))).map((u) => u.id)),
  };
}

/** A scanned or typed code: the pack or unit it names, if this lot has one. */
export function findCode(code: string, sources: AuditSources):
  { pack: AuditPack } | { unit: AuditUnit } | null {
  const value = code.trim();
  if (!value) return null;
  const pack = sources.packs.find((p) => p.code === value);
  if (pack) return { pack };
  const unit = sources.units.find((u) => u.code === value || u.alt === value);
  return unit ? { unit } : null;
}

export const fmt = (n: number) => Number(n.toFixed(3)).toString();
