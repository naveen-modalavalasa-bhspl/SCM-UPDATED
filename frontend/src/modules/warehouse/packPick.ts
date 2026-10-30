import type { BoxSource } from "./types";

/**
 * The package pick, as plain functions (2026-10-28).
 *
 * `PackagePickerModal` draws these; nothing here touches React, so the rules a
 * storekeeper relies on — what is suggested, when ten strips become a box, what the
 * sentence at the top says — are tested without a screen.
 *
 * Packs are the Issue-level packs `GET /issues/box-sources` serves. A pack whose
 * parent is ALSO an Issue pack (a strip inside a box, when both are Issue containers)
 * is "inner": it is drawn inside its box, never as a box of its own. The carton a box
 * sits in is its group.
 */

const EPS = 1e-6;

export const plural = (name: string, n: number) =>
  n === 1 ? name : /(s|x|z|ch|sh)$/.test(name) ? `${name}es` : `${name}s`;

/** "PK-WH-1549-0000593" -> "…0593": enough to find it on a carton, the full code on hover. */
export const shortCode = (code: string | null | undefined) => {
  if (!code) return "";
  const tail = code.split("-").pop() ?? code;
  return code.length <= 8 ? code : `…${tail.slice(-4)}`;
};

export const packNoun = (p: { pack_name?: string | null } | undefined, fallback = "pack") =>
  (p?.pack_name ?? fallback).toLowerCase();

export const isFree = (p: BoxSource) => !p.held_by || p.held_by_this_issue;

export interface PackGroup {
  key: string;
  code: string | null;
  name: string | null;
  holds: number | null;
  size: number | null;
  opened: boolean;
  packs: BoxSource[];
}

export interface PackIndex {
  byId: Map<number, BoxSource>;
  byCode: Map<string, BoxSource>;
  /** The Issue packs inside an Issue pack, oldest first — the strips of a box. */
  inner: Map<number, BoxSource[]>;
  groups: PackGroup[];
  /** The group a pack (or the box it sits in) belongs to. */
  groupOf: Map<string, string>;
}

export function indexPacks(packs: BoxSource[]): PackIndex {
  const byId = new Map(packs.map((p) => [p.id, p]));
  const byCode = new Map(packs.map((p) => [p.code, p]));
  const inner = new Map<number, BoxSource[]>();
  for (const p of packs) {
    if (p.parent_id != null && byId.has(p.parent_id)) {
      inner.set(p.parent_id, [...(inner.get(p.parent_id) ?? []), p]);
    }
  }
  for (const list of inner.values()) list.sort((a, b) => a.id - b.id);

  const out = new Map<string, PackGroup>();
  const groupOf = new Map<string, string>();
  for (const p of packs) {
    if (p.parent_id != null && byId.has(p.parent_id)) continue;
    const key = p.parent_id ? String(p.parent_id) : "loose";
    const holds = p.parent_holds ?? null;
    const size = p.parent_size ?? null;
    const g = out.get(key) ?? {
      key, code: p.parent_code ?? null, name: p.parent_pack_name ?? null, holds, size,
      opened: holds != null && size != null && holds < size - EPS, packs: [],
    };
    g.packs.push(p);
    out.set(key, g);
    groupOf.set(p.code, key);
    for (const q of inner.get(p.id) ?? []) groupOf.set(q.code, key);
  }
  const groups = [...out.values()];
  // Part packs first inside a carton (use what is already open), then oldest.
  for (const g of groups) g.packs.sort((a, b) => Number(b.part) - Number(a.part) || a.id - b.id);
  // Opened cartons first (fewer cartons broken), then the fullest.
  groups.sort((a, b) => Number(b.opened) - Number(a.opened)
    || b.packs.length - a.packs.length || a.key.localeCompare(b.key));
  return { byId, byCode, inner, groups, groupOf };
}

/** Is this pack inside another pack the line already takes whole? */
export function coveredBy(p: BoxSource, picked: string[], idx: PackIndex): boolean {
  let node = p.parent_id ? idx.byId.get(p.parent_id) : undefined;
  while (node) {
    if (picked.includes(node.code)) return true;
    node = node.parent_id ? idx.byId.get(node.parent_id) : undefined;
  }
  return false;
}

export interface PlanRow { code: string; p?: BoxSource; take: number }

/** What the picks give, in order — whole while the quantity lasts, the last in part. */
export function planOf(picked: string[], idx: PackIndex, quantity: number): PlanRow[] {
  let rest = quantity;
  return picked.map((code) => {
    const p = idx.byCode.get(code);
    const take = p ? Math.max(0, Math.min(p.holds, rest)) : 0;
    rest -= take;
    return { code, p, take };
  });
}

/**
 * The suggested pick: carton by carton, opened ones first, so a pick finishes inside
 * the carton it started in before it breaks another. Inside a carton, whole packs
 * while they fit; the remainder comes out of ONE box — as its strips when the box has
 * an inner Issue level, else as part of the box — part-opened boxes first.
 */
export function suggestPick(idx: PackIndex, quantity: number): string[] {
  let rest = quantity;
  const out: string[] = [];
  for (const g of idx.groups) {
    if (rest <= EPS) break;
    const free = g.packs.filter(isFree);
    const left: BoxSource[] = [];
    for (const p of free) {
      if (rest > EPS && p.holds <= rest + EPS) {
        out.push(p.code);
        rest -= p.holds;
      } else {
        left.push(p);
      }
    }
    // The remainder, from the box already opened if there is one.
    const order = [...left].sort((a, b) => Number(b.part) - Number(a.part) || a.id - b.id);
    for (const box of order) {
      if (rest <= EPS) break;
      const strips = (idx.inner.get(box.id) ?? []).filter(isFree);
      if (!strips.length) {
        out.push(box.code);
        rest = 0;
        break;
      }
      for (const s of strips) {
        if (rest <= EPS) break;
        out.push(s.code);
        rest -= Math.min(s.holds, rest);
      }
    }
  }
  return out;
}

/**
 * Every strip of a box taken is the box taken: one code instead of ten, and the
 * sentence says "1 box" — the defect where a carton read "0" while its boxes had
 * been emptied strip by strip. Only when the strips account for the whole box and
 * the box itself is free to take.
 */
export function rollUp(picked: string[], idx: PackIndex): string[] {
  // Repeated until nothing changes: ten strips make a box, and ten such boxes make a
  // carton when the carton is an Issue container too — any depth.
  let out = rollUpOnce(picked, idx);
  for (let i = 0; i < 8; i += 1) {
    const next = rollUpOnce(out, idx);
    if (next.length === out.length && next.every((c, k) => c === out[k])) break;
    out = next;
  }
  return out;
}

function rollUpOnce(picked: string[], idx: PackIndex): string[] {
  let out = [...picked];
  for (const [boxId, strips] of idx.inner) {
    const box = idx.byId.get(boxId);
    if (!box || !isFree(box) || out.includes(box.code) || !strips.length) continue;
    if (!strips.every((s) => out.includes(s.code))) continue;
    const sum = strips.reduce((s, q) => s + q.holds, 0);
    if (Math.abs(sum - box.holds) > EPS) continue;
    const codes = new Set(strips.map((s) => s.code));
    const at = Math.min(...strips.map((s) => out.indexOf(s.code)));
    out = out.filter((c) => !codes.has(c));
    out.splice(Math.min(at, out.length), 0, box.code);
  }
  return out;
}

/** Tap the j-th strip of a box: take its strips up to there; tap the last one taken
 *  again to give it back. A box taken whole is opened into strips by the tap. */
export function takeStripsUpTo(picked: string[], box: BoxSource, j: number, idx: PackIndex): string[] {
  const strips = idx.inner.get(box.id) ?? [];
  let base = picked;
  const wasWhole = base.includes(box.code);
  if (wasWhole) base = base.filter((c) => c !== box.code);
  const taken = strips.filter((s) => base.includes(s.code));
  let want = strips.slice(0, j + 1).filter(isFree);
  if (!wasWhole && taken.length === want.length && want.every((s) => base.includes(s.code))) {
    want = strips.slice(0, j).filter(isFree);
  }
  const keep = new Set(want.map((s) => s.code));
  const stripCodes = new Set(strips.map((s) => s.code));
  const next = base.filter((c) => !stripCodes.has(c) || keep.has(c));
  for (const s of want) if (!next.includes(s.code)) next.push(s.code);
  return rollUp(next, idx);
}

/** Take N strips out of a box (the −/+ beside the strip bar). */
export function setStripCount(picked: string[], box: BoxSource, n: number, idx: PackIndex): string[] {
  const strips = idx.inner.get(box.id) ?? [];
  const free = strips.filter(isFree);
  const base = picked.filter((c) => c !== box.code);
  // Keep the strips already taken where they can be kept, so a −/+ never reshuffles codes.
  const already = free.filter((s) => base.includes(s.code));
  const target = Math.max(0, Math.min(free.length, n));
  const want = target <= already.length
    ? already.slice(0, target)
    : [...already, ...free.filter((s) => !base.includes(s.code)).slice(0, target - already.length)];
  const keep = new Set(want.map((s) => s.code));
  const stripCodes = new Set(strips.map((s) => s.code));
  const next = base.filter((c) => !stripCodes.has(c) || keep.has(c));
  for (const s of want) if (!next.includes(s.code)) next.push(s.code);
  return rollUp(next, idx);
}

/** "4 boxes + 5 strips + 1 part strip (3)" — the pack mix of some plan rows. */
export function mixOf(rows: PlanRow[]): string {
  const whole = new Map<string, number>();
  const parts: string[] = [];
  for (const r of rows) {
    if (!r.p || r.take <= EPS) continue;
    const name = packNoun(r.p);
    if (r.take < r.p.holds - EPS) parts.push(`part ${name} (${fmt(r.take)})`);
    else whole.set(name, (whole.get(name) ?? 0) + 1);
  }
  return [...[...whole.entries()].map(([name, n]) => `${n} ${plural(name, n)}`), ...parts]
    .join(" + ");
}

/** The same mix, off the boxes an issue line already holds (`IssueItemRead.box_codes`). */
export function heldMix(boxes: { pack_name?: string | null; take: number | string; holds: number | string }[]): string {
  return mixOf(boxes.map((b) => ({
    code: "", take: Number(b.take) || 0,
    p: { pack_name: b.pack_name, holds: Number(b.holds) || 0 } as BoxSource,
  })));
}

const fmt = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 3 });

export const groupLabel = (g: PackGroup | undefined) =>
  !g || !g.code ? "packs not in a carton"
    : `${(g.name ?? "carton").toLowerCase()} ${shortCode(g.code)}`;

/** The sentence at the top of the picker: what to take, and from where. */
export function pickSentence(rows: PlanRow[], idx: PackIndex): string {
  const used = rows.filter((r) => r.p && r.take > EPS);
  if (!used.length) return "Nothing picked yet";
  const byGroup = new Map<string, PlanRow[]>();
  for (const r of used) {
    const key = idx.groupOf.get(r.code) ?? "loose";
    byGroup.set(key, [...(byGroup.get(key) ?? []), r]);
  }
  const group = (key: string) => idx.groups.find((g) => g.key === key);
  const parts = [...byGroup.entries()];
  if (parts.length === 1) return `Take ${mixOf(parts[0][1])} from ${groupLabel(group(parts[0][0]))}`;
  if (parts.length === 2) {
    return `Take ${mixOf(parts[0][1])} from ${groupLabel(group(parts[0][0]))} and `
      + `${mixOf(parts[1][1])} from ${groupLabel(group(parts[1][0]))}`;
  }
  return `Take ${mixOf(used)} from ${parts.length} cartons`;
}

/** How many cartons the pick breaks into. */
export function cartonsTouched(rows: PlanRow[], idx: PackIndex): number {
  return new Set(rows.filter((r) => r.p && r.take > EPS)
    .map((r) => idx.groupOf.get(r.code) ?? "loose")).size;
}

/** What the units of a picked pack are — its own, and those of the strips inside it
 *  (the server files a unit under whichever of the two it reached first). */
export function unitsOf(p: BoxSource, idx: PackIndex): string[] {
  const out = [...(p.units ?? [])];
  for (const q of idx.inner.get(p.id) ?? []) {
    for (const u of q.units ?? []) if (!out.includes(u)) out.push(u);
  }
  return out;
}

export type ScanVerdict =
  | { tone: "ok"; text: string; next: string[] }
  | { tone: "bad"; text: string; next: string[] };

/** A scanned label, judged before anything changes. */
export function judgeScan(code: string, picked: string[], idx: PackIndex): ScanVerdict {
  const hit = idx.byCode.get(code) ?? [...idx.byCode.values()]
    .find((p) => p.code.toLowerCase() === code.toLowerCase());
  if (!hit) {
    return { tone: "bad", text: `${code} is not a pack of this item at this batch and location`, next: picked };
  }
  const name = packNoun(hit);
  if (!isFree(hit)) return { tone: "bad", text: `${name} ${shortCode(hit.code)} is held by ${hit.held_by}`, next: picked };
  if (coveredBy(hit, picked, idx)) {
    return { tone: "bad", text: `${name} ${shortCode(hit.code)} is inside a pack already taken`, next: picked };
  }
  if (picked.includes(hit.code)) {
    return { tone: "ok", text: `Removed ${name} ${shortCode(hit.code)}`, next: picked.filter((c) => c !== hit.code) };
  }
  const strips = new Set((idx.inner.get(hit.id) ?? []).map((s) => s.code));
  const next = rollUp([...picked.filter((c) => !strips.has(c)), hit.code], idx);
  return { tone: "ok", text: `Added ${name} ${shortCode(hit.code)} — ${fmt(hit.holds)}`, next };
}

// ---------------------------------------------------------------------------------
//  The whole tree, for the drill-down picker (2026-10-28)
// ---------------------------------------------------------------------------------

/**
 * One node of the shelf as it stands: a carton, a box, a strip. `pack` is set when the
 * node is an Issue pack the line may name; a node with no `pack` (a carton that is not
 * an Issue container) can only be OPENED. Built from each source's `path`, so the tree
 * goes as deep as the item's ladder does.
 */
export interface TreeNode {
  code: string;
  name: string | null;
  level: number | null;
  pack?: BoxSource;
  parent: string | null;
  children: string[];
}

export interface PackTree { nodes: Map<string, TreeNode>; roots: string[] }

export function buildTree(packs: BoxSource[]): PackTree {
  const nodes = new Map<string, TreeNode>();
  const roots: string[] = [];
  const ensure = (code: string, name: string | null | undefined, level: number | null | undefined,
                  parent: string | null) => {
    let n = nodes.get(code);
    if (!n) {
      n = { code, name: name ?? null, level: level ?? null, parent, children: [] };
      nodes.set(code, n);
      if (parent) nodes.get(parent)!.children.push(code);
      else roots.push(code);
    }
    return n;
  };
  for (const p of packs) {
    let parent: string | null = null;
    for (const ref of p.path ?? []) {
      ensure(ref.code, ref.name, ref.level, parent);
      parent = ref.code;
    }
    const node = ensure(p.code, p.pack_name, p.level, parent);
    node.pack = p;
    node.name = p.pack_name ?? node.name;
  }
  return { nodes, roots };
}

/** Every Issue pack inside a node (not the node itself), outermost first. */
export function packsInside(tree: PackTree, code: string): BoxSource[] {
  const out: BoxSource[] = [];
  const walk = (c: string) => {
    for (const k of tree.nodes.get(c)?.children ?? []) {
      const n = tree.nodes.get(k)!;
      if (n.pack) out.push(n.pack);
      walk(k);
    }
  };
  walk(code);
  return out;
}

/** The Issue packs nearest the top inside a node — what "take everything" takes. */
export function nearestPacks(tree: PackTree, code: string): BoxSource[] {
  const out: BoxSource[] = [];
  const walk = (c: string) => {
    for (const k of tree.nodes.get(c)?.children ?? []) {
      const n = tree.nodes.get(k)!;
      if (n.pack) out.push(n.pack);
      else walk(k);
    }
  };
  walk(code);
  return out;
}

/** How much a node holds: its own pack, else the packs nearest the top inside it. */
export function nodeHolds(tree: PackTree, code: string): number {
  const n = tree.nodes.get(code);
  if (n?.pack) return n.pack.holds;
  return nearestPacks(tree, code).reduce((s, p) => s + p.holds, 0);
}

export type NodeState = "all" | "some" | "none";

/** What the line takes of a node, from the plan: whole, some of it, or nothing. */
export function nodeTaken(tree: PackTree, code: string, rows: PlanRow[]): { qty: number; state: NodeState } {
  const take = new Map(rows.map((r) => [r.code, r.take]));
  const n = tree.nodes.get(code);
  if (n?.pack && take.has(code)) {
    const q = take.get(code) ?? 0;
    return { qty: q, state: q >= n.pack.holds - EPS ? "all" : "some" };
  }
  // Covered by an ancestor taken whole.
  let up = n?.parent ? tree.nodes.get(n.parent) : undefined;
  while (up) {
    if (up.pack && (take.get(up.code) ?? 0) >= up.pack.holds - EPS) {
      return { qty: n?.pack?.holds ?? nodeHolds(tree, code), state: "all" };
    }
    up = up.parent ? tree.nodes.get(up.parent) : undefined;
  }
  const inside = packsInside(tree, code);
  const qty = inside.reduce((s, p) => s + (take.get(p.code) ?? 0), 0);
  const holds = nodeHolds(tree, code);
  return { qty, state: qty <= EPS ? "none" : qty >= holds - EPS ? "all" : "some" };
}

/** Take everything inside a node: its nearest Issue packs, whole, the ones free. */
export function takeAllInside(picked: string[], tree: PackTree, code: string, idx: PackIndex): string[] {
  const take = nearestPacks(tree, code).filter((p) => isFree(p));
  const drop = new Set(packsInside(tree, code).map((p) => p.code));
  for (const p of take) drop.delete(p.code);
  const next = picked.filter((c) => !drop.has(c));
  for (const p of take) if (!next.includes(p.code) && !coveredBy(p, next, idx)) next.push(p.code);
  return rollUp(next, idx);
}

/** Take nothing from inside a node (and not the node itself). */
export function clearInside(picked: string[], tree: PackTree, code: string): string[] {
  const drop = new Set([code, ...packsInside(tree, code).map((p) => p.code)]);
  return picked.filter((c) => !drop.has(c));
}

/** The breadcrumb to a node, outermost first. */
export function trailTo(tree: PackTree, code: string | null): TreeNode[] {
  const out: TreeNode[] = [];
  let n = code ? tree.nodes.get(code) : undefined;
  while (n) {
    out.unshift(n);
    n = n.parent ? tree.nodes.get(n.parent) : undefined;
  }
  return out;
}
