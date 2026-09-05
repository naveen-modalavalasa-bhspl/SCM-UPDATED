import { num } from "./format";
import type { IssueItemWrite, IssueStockSource, TrackingType } from "./types";

/**
 * A material issue line names ONE batch and ONE bin. The shelf frequently does not.
 *
 * Fifteen monitors sitting five in one bay and ten in another are two picks, and the
 * form could express only one of them: the storekeeper typed 15 against a bin holding
 * 5, the unit picker then offered him 5 codes for a line claiming 15, and the gap
 * between "codes selected" and "issued quantity" was the only hint that anything was
 * wrong. It was read as a bug in the picker. It was the document being unable to say
 * what was actually happening.
 *
 * **A split is a sibling LINE, not a new table.** `out_issue_items` already carries
 * `indent_item_id`, already allows several rows per item, and every downstream
 * reader — the reservation stamp, `_issue_unit_supply`, `move_stock_out`, the
 * occupancy preview, the ledger — is already per line. So two bins are two lines
 * against the same indent line, and nothing behind the screen changes. What this
 * file adds is the GROUPING: the flat array the form holds, read as one parent per
 * item with its splits under it.
 *
 * The one rule that makes it work: **`requested_qty` is distributed across the
 * splits, never repeated.** The backend refuses a line requesting nothing and
 * refuses a line issuing more than it requests (`_apply_issue_lines`), and the
 * document's totals are a plain SUM over lines — so a group asking for 15 must have
 * splits whose requested quantities add to 15. `normalizeSplits` is what guarantees
 * that, applied once on the way out to the server rather than maintained on every
 * keystroke.
 *
 * **There is deliberately no automatic split.** A machine spreading an ask over the
 * oldest stock it can find writes a document nobody decided: the storekeeper is
 * standing at the shelf, he can see which bay is reachable and which pallet is
 * behind another, and the picks are his to make. What the screen owes him instead is
 * every source stated plainly — what is there, what his own allocation holds, and
 * what he has left to place — which is what `groupIssueLines` assembles here.
 */

/** Which lines belong to the same ask. The indent line when there is one — that is
 *  the thing being fulfilled — and otherwise the item, because two hand-added lines
 *  of one item on one issue ARE two picks of the same thing. */
export const groupKeyOf = (line: IssueItemWrite): string =>
  line.indent_item_id ? `indent:${line.indent_item_id}` : `item:${line.item_id}`;

/** The "no bin" / "no batch" sentinel the warehouse writes is 0, not a real id. */
const src = (value: number | null | undefined): number | null => (value ? value : null);

export const sourceKey = (batchId?: number | null, binId?: number | null): string =>
  `${src(batchId) ?? 0}:${src(binId) ?? 0}`;

export interface IssueSplit {
  /** Where this split sits in the flat `form.items` array. */
  index: number;
  line: IssueItemWrite;
  issued: number;
  /** How many identifiers the storekeeper has named on it. */
  codes: number;

  /* --- what the shelf holds here. Three numbers, not one, because they answer
   * three different questions and collapsing them is what made a correct document
   * look impossible. `null` on all of them = the sources have not been read yet,
   * which is NOT the same as zero. */

  /** What this pick may actually take: free stock plus this document's OWN hold. */
  drawable: number | null;
  /** Free to anybody. Zero here is normal on an approved allocation. */
  available: number | null;
  /** The part of the hold that belongs to this document's own indent. */
  ownReserved: number | null;
  /** Held by everyone, this document included. */
  reserved: number | null;
  total: number | null;

  /** How many CODED units this pick could name, served per line by
   *  `_issue_unit_supply`. A different number off a different table from `drawable`
   *  — a quantity is not an identity — and the screen shows both because a
   *  storekeeper reading one as the other is the whole confusion. Capped at
   *  `issued + 1` by the probe, so a value above `issued` only means "enough". */
  unitsAvailable: number | null;

  /** The walk down to this pick's location — `F1 / F1-A1 / F1-A1-R1 / …-B2`.
   *  A bin code alone is not somewhere a person can be sent. */
  binPath: string | null;
  binCode: string | null;
  batchNo: string | null;
  /** Is this one of the locations INVENTORY reserved for the indent? A pick that is
   *  not, on a document that has an allocation, is a hold about to be moved. */
  isAllocated: boolean;
}

export interface IssueGroup {
  key: string;
  itemId: number;
  itemCode?: string | null;
  itemName?: string | null;
  trackingType: TrackingType;
  /** Whether this item's units can be named at all at this point. */
  pickable: boolean;
  isBatchTracked: boolean;
  splits: IssueSplit[];
  /** The whole ask, summed over the splits — the indent's number, redistributed. */
  requested: number;
  issued: number;
  codes: number;
  /** Still to allocate against the ask. Never negative: over-issue is its own error. */
  remaining: number;
  /** Sources this group has not drawn on yet, oldest first. */
  spare: IssueStockSource[];

  /** Where INVENTORY put the hold for this ask — the sources carrying a reservation
   *  belonging to this document's own indent. */
  allocated: IssueStockSource[];
  /** Allocated locations this document has stopped naming. Saving releases the hold
   *  on each of them back to free stock and takes it where the picks now point, so
   *  the screen has to say so BEFORE the press rather than after. */
  releasing: IssueStockSource[];
}

/**
 * Which kind of identifier a line is asking for.
 *
 * The backend serves `tracking_type` per line and that is the answer whenever it has
 * been read back. On a line the storekeeper has only just added there is no answer
 * yet, so the item's own flags stand in — narrower, because the master's `is_asset`
 * is not carried on the picked option, but enough to draw the right badge for the
 * two cases that are unambiguous.
 */
export const trackingOf = (line: IssueItemWrite): TrackingType => {
  if (line.tracking_type) return line.tracking_type;
  if (line.is_serial_tracked) return "SERIAL";
  if (line.is_imei_tracked) return "IMEI";
  if (line.has_units === false) return "NONE";
  return "CONSUMABLE";
};

/** Whether this line has identifiable units to pick at all. Mirrors the old inline
 *  test on the Units column: unknown (`undefined`) still offers the picker, because
 *  an unsaved draft has not been read back yet. */
export const isPickable = (line: IssueItemWrite): boolean =>
  !!line.is_serial_tracked || !!line.is_imei_tracked || line.has_units !== false;

/**
 * The flat line array, read as parents and their splits.
 *
 * Order is the array's own: a group takes the position of its first line, and the
 * splits keep the order they were added in, so nothing jumps as the user edits.
 */
export function groupIssueLines(
  lines: IssueItemWrite[],
  sourcesByItem: Record<number, IssueStockSource[]> = {},
): IssueGroup[] {
  const groups: IssueGroup[] = [];
  const byKey = new Map<string, IssueGroup>();

  lines.forEach((line, index) => {
    const key = groupKeyOf(line);
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        itemId: line.item_id,
        itemCode: line.item_code,
        itemName: line.item_name,
        trackingType: trackingOf(line),
        pickable: isPickable(line),
        isBatchTracked: !!line.is_batch_tracked,
        splits: [],
        requested: 0,
        issued: 0,
        codes: 0,
        remaining: 0,
        spare: [],
        allocated: [],
        releasing: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    const sources = sourcesByItem[line.item_id] ?? [];
    const match = sources.find(
      (row) => sourceKey(row.batch_id, row.bin_id) === sourceKey(line.batch_id, line.bin_id),
    );
    const issued = num(line.issued_qty);
    const codes = line.serial_numbers?.length ?? 0;
    const unread = sources.length === 0;
    group.splits.push({
      index,
      line,
      issued,
      codes,
      drawable: unread ? null : num(match?.drawable_qty),
      available: unread ? null : num(match?.available_qty),
      ownReserved: unread ? null : num(match?.own_reserved_qty),
      reserved: unread ? null : num(match?.reserved_qty),
      total: unread ? null : num(match?.total_qty),
      unitsAvailable: line.units_available ?? null,
      binPath: match?.bin_path ?? null,
      binCode: match?.bin_code ?? line.bin_code ?? null,
      batchNo: match?.batch_no ?? line.batch_no ?? null,
      isAllocated: num(match?.own_reserved_qty) > 0,
    });
    group.requested += num(line.requested_qty);
    group.issued += issued;
    group.codes += codes;
    // A group's identity comes from whichever of its lines the backend has already
    // described. A freshly added split carries no `tracking_type` yet and must not
    // drag the badge back to a guess.
    if (line.tracking_type) group.trackingType = line.tracking_type;
    if (line.item_code) group.itemCode = line.item_code;
    if (line.item_name) group.itemName = line.item_name;
    if (line.is_batch_tracked) group.isBatchTracked = true;
  });

  for (const group of groups) {
    group.remaining = Math.max(round(group.requested - group.issued), 0);
    const taken = new Set(group.splits.map((s) => sourceKey(s.line.batch_id, s.line.bin_id)));
    const rows = sourcesByItem[group.itemId] ?? [];
    group.spare = rows.filter((row) => !taken.has(sourceKey(row.batch_id, row.bin_id)));
    // Where inventory put the hold. `own_reserved_qty` is this document's own indent's
    // reservation on that balance row — served by `issue_stock_sources` precisely so a
    // screen never has to guess which stock is spoken for by itself.
    group.allocated = rows.filter((row) => num(row.own_reserved_qty) > 0);
    group.releasing = group.allocated.filter(
      (row) => !taken.has(sourceKey(row.batch_id, row.bin_id)),
    );
  }
  return groups;
}

/** Quantities are DECIMAL(_, 3) on the server. Rounding here keeps 15 - 5 - 10 from
 *  leaving 1.7763568394002505e-15 of an ask behind and drawing a group as short. */
export const round = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * Replace one group's lines in the flat array, keeping every other group's position.
 *
 * The replacements land where the group's first line was, so a re-split does not
 * shuffle the document.
 */
export function replaceGroup(
  lines: IssueItemWrite[],
  group: IssueGroup,
  replacement: IssueItemWrite[],
): IssueItemWrite[] {
  const owned = new Set(group.splits.map((s) => s.index));
  const at = group.splits[0]?.index ?? lines.length;
  const out: IssueItemWrite[] = [];
  lines.forEach((line, index) => {
    if (index === at) out.push(...replacement);
    if (!owned.has(index)) out.push(line);
  });
  if (at >= lines.length) out.push(...replacement);
  return out;
}

/**
 * What actually goes to the server.
 *
 * `_apply_issue_lines` refuses a line requesting nothing and refuses a line issuing
 * more than it requests, and `out_issues.total_qty` is a plain sum — so the group's
 * ask is put back onto its splits here, once, on the way out:
 *
 *  - every split requests exactly what it issues, so `issued <= requested` holds;
 *  - the shortfall (ask minus everything issued) rides on the FIRST split, so the
 *    sum of the requested quantities is still the ask and a short issue is still
 *    visibly short;
 *  - a split left requesting nothing is dropped, because it names no goods.
 *
 * Doing it here rather than on every keystroke means the number in the Issued box is
 * the storekeeper's, unedited, right up until Save.
 */
export function normalizeSplits(lines: IssueItemWrite[]): IssueItemWrite[] {
  const out: IssueItemWrite[] = [];
  for (const group of groupIssueLines(lines)) {
    for (const row of redistribute(group.splits.map((s) => s.line), group.requested)) {
      if (num(row.requested_qty) > 0) out.push(row);
    }
  }
  return out;
}

/**
 * Put one group's ask back onto its picks, without changing the ask.
 *
 * This is the invariant that keeps a split honest. `groupIssueLines` reads a group's
 * requested quantity as the SUM over its lines, so a pick added carrying the whole
 * remainder would silently inflate the ask — fifteen monitors becoming twenty-five
 * because the storekeeper split them over two bays. Adding and removing a pick both
 * run through here with the ask measured BEFORE the change, so the number the indent
 * asked for survives every rearrangement of how it is served.
 *
 * The shape is the one the server requires: each pick requests exactly what it
 * issues, and whatever the shelf could not cover rides on the first pick, where it
 * stays visible as a shortfall.
 */
export function redistribute(lines: IssueItemWrite[], ask: number): IssueItemWrite[] {
  const issued = lines.map((line) => num(line.issued_qty));
  const shortfall = Math.max(round(ask - issued.reduce((a, b) => a + b, 0)), 0);
  return lines.map((line, position) => ({
    ...line,
    issued_qty: issued[position],
    requested_qty: round(issued[position] + (position === 0 ? shortfall : 0)),
  }));
}

export type ProblemLevel = "error" | "warn";

export interface SplitProblem {
  level: ProblemLevel;
  groupKey: string;
  /** Flat index of the split at fault, when one split is at fault. */
  index?: number;
  message: string;
}

/**
 * Everything wrong with the allocation as it stands, in the order a storekeeper
 * would fix it. `error` blocks the save; `warn` is a document that saves but cannot
 * be posted, which is worth saying before approval freezes the batch.
 *
 * The parity check is the one this whole screen exists for: a tracked split must
 * name exactly as many identifiers as it issues. When it does not, the message says
 * how many are missing and what they are called — served wording, via `unitLabel`.
 */
export function splitProblems(
  groups: IssueGroup[],
  {
    binManaged,
    unitLabel,
    requireUnits = true,
  }: {
    binManaged: boolean;
    /** Plural noun for one group's identifier, from the served catalogue. */
    unitLabel: (type: TrackingType, count: number) => string;
    /** False once the document is posted — nothing is left to fix. */
    requireUnits?: boolean;
  },
): SplitProblem[] {
  const problems: SplitProblem[] = [];
  for (const group of groups) {
    const label = group.itemCode || group.itemName || "This item";
    if (round(group.issued - group.requested) > 0) {
      problems.push({
        level: "error",
        groupKey: group.key,
        message: `${label}: ${group.issued} allocated against a request for ${group.requested}.`,
      });
    }
    const seen = new Map<string, number>();
    for (const split of group.splits) {
      const key = sourceKey(split.line.batch_id, split.line.bin_id);
      const first = seen.get(key);
      if (first !== undefined && (split.line.batch_id || split.line.bin_id)) {
        problems.push({
          level: "error",
          groupKey: group.key,
          index: split.index,
          message: `${label}: two picks draw on the same batch and storage location. Merge them, or move one elsewhere.`,
        });
      } else {
        seen.set(key, split.index);
      }

      if (binManaged && split.issued > 0 && !split.line.bin_id) {
        problems.push({
          level: "error", groupKey: group.key, index: split.index,
          message: `${label}: name the storage location this is picked from.`,
        });
      }
      if (group.isBatchTracked && split.issued > 0 && !split.line.batch_id) {
        problems.push({
          level: "error", groupKey: group.key, index: split.index,
          message: `${label}: name the batch this is picked from.`,
        });
      }
      // Against DRAWABLE. Against `available` this fired on every correct document
      // drawn from an approved allocation, because the allocation had already
      // reserved exactly what the line was about to issue.
      if (split.drawable !== null && round(split.issued - split.drawable) > 0) {
        const held = split.reserved !== null && split.ownReserved !== null
          ? round(split.reserved - split.ownReserved)
          : 0;
        problems.push({
          level: "error", groupKey: group.key, index: split.index,
          message: `${label}: this location can give ${split.drawable} and the pick takes ${split.issued}.`
            + (held > 0
              ? ` ${held} more is here but reserved for another document.`
              : "")
            + " Split the rest onto another location, or reduce the quantity.",
        });
      }

      // A SEPARATE question with a separate answer. `drawable` is a quantity off
      // `stk_balance`; this is how many physical units carry an identifier that this
      // pick could name, off `whs_serial_numbers`. They can legitimately differ —
      // stock put away before the item was coded has quantity and no identity — and a
      // pick can be fine on one and short on the other, so neither is allowed to
      // stand in for the other.
      if (group.pickable && group.trackingType !== "NONE"
          && split.unitsAvailable !== null && split.issued > 0
          && split.unitsAvailable < Math.trunc(split.issued)) {
        problems.push({
          level: "warn", groupKey: group.key, index: split.index,
          message: `${label}: the quantity is here, but only ${split.unitsAvailable} `
            + `${unitLabel(group.trackingType, split.unitsAvailable)} can be named `
            + `for ${Math.trunc(split.issued)} units. The rest have no identifier on `
            + `the shelf.`,
        });
      }
      if (requireUnits && group.pickable && group.trackingType !== "NONE") {
        const need = Math.trunc(split.issued);
        const gap = need - split.codes;
        if (gap > 0) {
          problems.push({
            level: "warn", groupKey: group.key, index: split.index,
            message: `${label}: ${gap} more ${unitLabel(group.trackingType, gap)} to assign at this location.`,
          });
        } else if (gap < 0) {
          problems.push({
            level: "error", groupKey: group.key, index: split.index,
            message: `${label}: ${split.codes} ${unitLabel(group.trackingType, split.codes)} named for ${need} units.`,
          });
        }
      }
    }
  }
  return problems;
}
