import type { ConsolidatedItem, ConsolidatedItemAllocation } from "./types";
import type { CycleDecisions } from "./consolidationDecisions";

/**
 * What a consolidation cycle's draft resolves to, line by line.
 *
 * Pure, and deliberately the ONLY place the numbers are worked out: the item page, the
 * consolidation table and Approve all all read it, so the quantity an approver sees is
 * the quantity that goes out. Nothing is stored that could go stale against its inputs.
 *
 * There is no batch total any more. Each indent's line carries the quantity the approver
 * typed (or the full ceiling when they typed nothing), and a percentage reduction is just
 * a way of filling those boxes in — it writes quantities, it does not remain as a rule.
 */

/** The most one indent line may be passed: what the rung below approved for it, falling
 *  back to the request at the first rung. Never its share of somebody else's ask. */
export const lineCap = (allocation: ConsolidatedItemAllocation): number =>
  Number.isFinite(allocation.ceiling_quantity)
    ? allocation.ceiling_quantity
    : allocation.requested_quantity;

/** Down to the unit's own places, like every other quantity door in the system. UOM-BOX
 *  is a countable unit, so 4.9 boxes is not a quantity: it is 4. Rounded before the
 *  floor, because 4.9 * 1000 is 4899.999… in binary floating point and flooring that
 *  would lose a whole step. */
export function stepDown(value: number, places = 3): number {
  const factor = 10 ** Math.max(0, places);
  return Math.floor(Math.round(value * factor * 1000) / 1000) / factor;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** Excluded by this approver's draft, or already dropped at a rung BELOW this one.
 *  `is_excluded` is the SERVER's answer and wins: a decision made lower down stays made,
 *  whatever this draft says (BUG_SCM_0007 / BUG_SCM_0008). */
export const isLineExcluded = (
  allocation: ConsolidatedItemAllocation, decisions: CycleDecisions,
): boolean => Boolean(allocation.is_excluded) || decisions[String(allocation.line_id)]?.excluded === true;

export interface ResolvedLine {
  allocation: ConsolidatedItemAllocation;
  cap: number;
  /** Out of this item for this indent — by this approver or a rung below. */
  excluded: boolean;
  /** Dropped further down the ladder: read-only here, not this approver's to undo. */
  excludedBelow: boolean;
  /** What is in the box ("" when untouched). */
  typed: string;
  invalid: boolean;
  /** Typed past the ceiling. */
  over: boolean;
  /** Typed with more precision than the unit has, so what goes out differs from it. */
  rounded: boolean;
  /** What will be sent for this line: 0 when excluded. */
  value: number;
}

export function resolveLine(
  allocation: ConsolidatedItemAllocation, decisions: CycleDecisions, places = 3,
): ResolvedLine {
  const cap = lineCap(allocation);
  const excludedBelow = Boolean(allocation.is_excluded);
  const draft = decisions[String(allocation.line_id)];
  const excluded = excludedBelow || draft?.excluded === true;
  const typed = draft?.approved ?? "";
  const trimmed = typed.trim();
  const parsed = trimmed === "" ? null : Number(trimmed);
  const invalid = !excluded && parsed !== null && (Number.isNaN(parsed) || parsed < 0);
  const over = !excluded && parsed !== null && !invalid && parsed > cap;
  const rounded = !excluded && parsed !== null && !invalid && !over
    && stepDown(parsed, places) !== parsed;
  const value = excluded
    ? 0
    : parsed === null || invalid
      ? stepDown(cap, places)
      : stepDown(Math.min(parsed, cap), places);
  return { allocation, cap, excluded, excludedBelow, typed, invalid, over, rounded, value };
}

/** One item, every indent's line resolved, with the totals the screens print. */
export function resolveItem(item: ConsolidatedItem, decisions: CycleDecisions) {
  const places = item.uom_decimals ?? 3;
  const lines = (item.allocations ?? []).map((a) => resolveLine(a, decisions, places));
  const included = lines.filter((line) => !line.excluded);
  const droppedCount = lines.length - included.length;
  // Excluding an indent takes its ceiling out with it: offering the item's full total
  // afterwards proposed quantities nobody was entitled to receive.
  const ceiling = droppedCount === 0 && Number.isFinite(item.total_ceiling_quantity)
    ? item.total_ceiling_quantity
    : round3(included.reduce((sum, line) => sum + line.cap, 0));
  const total = round3(included.reduce((sum, line) => sum + line.value, 0));
  return {
    lines,
    included,
    droppedCount,
    ceiling,
    total,
    invalid: included.some((line) => line.invalid),
    over: included.some((line) => line.over),
    rounded: included.some((line) => line.rounded),
  };
}

/** Every line one indent has across the cycle's items, minus the ones a rung below has
 *  already dropped (those are not this approver's to move either way). */
export function indentLineIds(items: ConsolidatedItem[], indentId: number): number[] {
  return items.flatMap((item) =>
    (item.allocations ?? [])
      .filter((a) => a.indent_id === indentId && !a.is_excluded)
      .map((a) => a.line_id));
}

/** The indent is out of every item it is on (and is on at least one this approver can
 *  still decide). What "Remove from all items" produces. */
export function isIndentRemoved(
  items: ConsolidatedItem[], indentId: number, decisions: CycleDecisions,
): boolean {
  const ids = indentLineIds(items, indentId);
  return ids.length > 0 && ids.every((id) => decisions[String(id)]?.excluded === true);
}

/** Indents left out of EVERY line they appear on — they get nothing from this round.
 *
 *  They are HELD, not approved: sending them on with zeros used to pass them up the
 *  ladder as decided-and-empty, so the next approver saw an indent nobody meant to send.
 *  Held here, the indent simply stays in this approver's queue, exactly where it was
 *  before Approve all. Excluded on SOME items only is not a hold: those lines go out at
 *  zero and the rest at their quantity, which is an ordinary partial approval. */
export function heldIndentIds(items: ConsolidatedItem[], decisions: CycleDecisions): Set<number> {
  const allOut = new Map<number, boolean>();
  for (const item of items) {
    for (const allocation of item.allocations ?? []) {
      allOut.set(
        allocation.indent_id,
        (allOut.get(allocation.indent_id) ?? true) && isLineExcluded(allocation, decisions),
      );
    }
  }
  return new Set([...allOut].filter(([, all]) => all).map(([id]) => id));
}

export interface PercentReduction {
  /** What to write into each included line's box. Blank at 100: back to the full ceiling. */
  entries: Array<{ lineId: number; approved: string; value: number; cap: number }>;
  /** The included lines' ceilings added up, and what they come to after the reduction. */
  before: number;
  after: number;
  /** Lines the reduction takes down to nothing — said before it is applied, because a
   *  box of 10 at 5% becomes 0 and that is not something to find out afterwards. */
  zeroed: number;
}

/** Give every INCLUDED indent the same percentage of its own ceiling for this one item.
 *
 *  A share of what reached this approver, not a further cut off whatever is typed: so
 *  pressing it twice with the same number does the same thing, and 100 puts every line
 *  back to its full ceiling. Down to the unit — a countable item never goes out in
 *  fractions. Excluded lines (here or below) are left alone, and so are the other items
 *  of the same indents. */
export function reducePercent(
  item: ConsolidatedItem, decisions: CycleDecisions, percent: number,
): PercentReduction {
  const places = item.uom_decimals ?? 3;
  const share = Math.min(100, Math.max(0, percent));
  const entries = (item.allocations ?? [])
    .map((a) => resolveLine(a, decisions, places))
    .filter((line) => !line.excluded)
    .map((line) => {
      const value = share >= 100 ? stepDown(line.cap, places) : stepDown((line.cap * share) / 100, places);
      return {
        lineId: line.allocation.line_id,
        approved: share >= 100 ? "" : String(value),
        value,
        cap: line.cap,
      };
    });
  return {
    entries,
    before: round3(entries.reduce((sum, entry) => sum + entry.cap, 0)),
    after: round3(entries.reduce((sum, entry) => sum + entry.value, 0)),
    zeroed: entries.filter((entry) => entry.value === 0 && entry.cap > 0).length,
  };
}
