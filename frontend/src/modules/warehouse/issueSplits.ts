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
  (line.indent_item_id ? `indent:${line.indent_item_id}` : `item:${line.item_id}`)
  + `|${comboKeyOf(line)}`;

/** A line's brand / variant / model as a key, "" where it names none (2026-10-23).
 *  Two combinations of one item are two asks, drawn from two different shelves. */
export const comboKeyOf = (row: { brand_id?: number | null; variant_id?: number | null;
                                  model_id?: number | null }): string =>
  row.brand_id ? `${row.brand_id}|${row.variant_id || 0}|${row.model_id || 0}` : "";

/** An item's sources narrowed to one combination; "" keeps every row. */
export const sourcesFor = (sourcesByItem: Record<number, IssueStockSource[]>,
                           itemId: number, combo: string): IssueStockSource[] =>
  (sourcesByItem[itemId] ?? []).filter((row) => !combo || comboKeyOf(row) === combo);

/** The "no bin" / "no batch" sentinel the warehouse writes is 0, not a real id. */
const src = (value: number | null | undefined): number | null => (value ? value : null);

export const sourceKey = (batchId?: number | null, binId?: number | null): string =>
  `${src(batchId) ?? 0}:${src(binId) ?? 0}`;

/** How many identifiers a pick must name (2026-10-24): one per unit, except an item
 *  issued in a container, which names one code per box — served as `codes_needed` for
 *  the quantity it was served for, and dropped the moment that quantity changes. */
export function codesNeeded(line: { issued_qty?: number | string | null;
                                    codes_needed?: number | null;
                                    codes_needed_at?: number | null }): number {
  const issued = Math.trunc(Number(line.issued_qty ?? 0) || 0);
  return line.codes_needed != null && line.codes_needed_at === issued
    ? line.codes_needed : issued;
}

export interface IssueSplit {
  /** Where this split sits in the flat `form.items` array. */
  index: number;
  line: IssueItemWrite;
  issued: number;
  /** How many identifiers the storekeeper has named on it. */
  codes: number;
  /** How many it must name: one per unit, or one per container (`codesNeeded`). */
  need: number;

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

  /* --- the same shelf, read one step wider. A pick is one location inside one
   * batch inside one warehouse, and a storekeeper deciding how to split fifteen
   * monitors needs all three: what is at this bay, what the rest of the batch holds,
   * and what the warehouse holds altogether. Served on the source row rather than
   * summed here — see `IssueStockSource`. */

  /** When this pick's batch expires. The whole of the FEFO question, and the one
   *  fact a batch code does not carry — `batch-25aug` and `batch-02sep` are six weeks
   *  apart and one character apart to read. `null` is "nobody recorded one", which is
   *  not "never expires". */
  batchExpiry: string | null;
  /** Everything of this item, in this pick's batch, anywhere in the warehouse. */
  batchTotal: number | null;
  /** What this document could still take out of that batch, wherever it sits. */
  batchDrawable: number | null;

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
  /** The group's brand / variant / model key — "" for none. */
  combo: string;
  itemCode?: string | null;
  itemName?: string | null;
  /** How many decimal places this item's unit allows — 0 for a whole-unit UOM
   *  (Nos, Box…). `null` until a line has carried one back from the server. */
  qtyDecimals: number | null;
  trackingType: TrackingType;
  /** Whether this item's units can be named at all at this point. */
  pickable: boolean;
  isBatchTracked: boolean;
  splits: IssueSplit[];
  /** No pick of this item answers an indent line: a direct issue (2026-10-21). There
   *  is nothing being asked for, so the ask IS what is issued — never shown, never
   *  checked, and sent to the server as requested = issued per pick. */
  direct: boolean;
  /** The whole ask, summed over the splits — the indent's number, redistributed. */
  requested: number;
  issued: number;
  codes: number;
  /** Identifiers the picks must name, summed — see `codesNeeded`. */
  need: number;
  /** Still to allocate against the ask. Never negative: over-issue is its own error. */
  remaining: number;
  /** Sources this group has not drawn on yet, oldest first. */
  spare: IssueStockSource[];

  /** Everything of this item in the warehouse — every batch, every location, the
   *  rows other documents have reserved included. The outermost of the three
   *  quantities the grid states. `null` until the sources have been read. */
  warehouseTotal: number | null;
  /** What THIS document could take of it altogether, summed over the locations it is
   *  allowed to draw on. Never larger than `warehouseTotal`. */
  warehouseDrawable: number | null;
  /** Of `warehouseTotal`, what nobody has reserved (`item_available_qty`). */
  warehouseFree: number | null;
  /** Of `warehouseTotal`, what is held for THIS document — its indent's reservation
   *  plus a direct issue's own hold. */
  heldForThis: number | null;
  /** Of `warehouseTotal`, what other documents have reserved: the rest. */
  heldByOthers: number | null;
  /** Every source row of the item here (expired excluded), for the per-batch view. */
  stockRows: IssueStockSource[];

  /** Where INVENTORY put the hold for this ask — the sources carrying a reservation
   *  belonging to this document's own indent. */
  allocated: IssueStockSource[];
  /** Allocated locations this document has stopped naming. Saving releases the hold
   *  on each of them back to free stock and takes it where the picks now point, so
   *  the screen has to say so BEFORE the press rather than after. */
  releasing: IssueStockSource[];
  /** Batches unlocked by the coded-item exception: the item must leave with a code
   *  per unit, the allocated batch carries none, so FEFO moves on to the oldest batch
   *  that does. Empty when the exception does not apply. See `codedSwapBatches`. */
  codedSwap: Set<number>;
  /** The FEFO plan for the ask, and the batch ids it names. */
  plan: FefoStep[];
  required: Set<number>;
  /** The earliest-expiring batch with stock. */
  earliest: { batchId: number; batchNo: string | null; expiry: string | null; drawable: number } | null;
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
  if (!line.item_id) return "NONE";
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
  !!line.item_id && (!!line.is_serial_tracked || !!line.is_imei_tracked || line.has_units !== false);

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
        combo: comboKeyOf(line),
        itemCode: line.item_code,
        itemName: line.item_name,
        qtyDecimals: line.qty_decimals ?? null,
        trackingType: trackingOf(line),
        pickable: isPickable(line),
        isBatchTracked: !!line.is_batch_tracked,
        splits: [],
        direct: true,
        requested: 0,
        issued: 0,
        codes: 0,
        need: 0,
        remaining: 0,
        spare: [],
        warehouseTotal: null,
        warehouseDrawable: null,
        warehouseFree: null,
        heldForThis: null,
        heldByOthers: null,
        stockRows: [],
        allocated: [],
        releasing: [],
        codedSwap: new Set<number>(),
        earliest: null,
        plan: [],
        required: new Set<number>(),
      };
      byKey.set(key, group);
      groups.push(group);
    }
    const sources = sourcesFor(sourcesByItem, line.item_id, comboKeyOf(line));
    const match = sources.find(
      (row) => sourceKey(row.batch_id, row.bin_id) === sourceKey(line.batch_id, line.bin_id),
    );
    // The batch this pick names, wherever in the warehouse it sits — a different
    // question from the (batch, bin) row above, and the reason the batch cell can
    // say "another 40 of this batch, elsewhere" while this bay holds five.
    const batchRows = sources.filter(
      (row) => sourceKey(row.batch_id, null) === sourceKey(line.batch_id, null),
    );
    const issued = num(line.issued_qty);
    const codes = line.serial_numbers?.length ?? 0;
    const unread = sources.length === 0;
    const need = codesNeeded(line);
    group.splits.push({
      index,
      line,
      issued,
      codes,
      need,
      drawable: unread ? null : num(match?.drawable_qty),
      available: unread ? null : num(match?.available_qty),
      ownReserved: unread ? null : num(match?.own_reserved_qty),
      reserved: unread ? null : num(match?.reserved_qty),
      total: unread ? null : num(match?.total_qty),
      batchExpiry: batchRows[0]?.expiry_date ?? null,
      batchTotal: unread || !batchRows.length ? null : num(batchRows[0].batch_total_qty),
      batchDrawable: unread || !batchRows.length
        ? null
        : round(batchRows.reduce((sum, row) => sum + num(row.drawable_qty), 0)),
      unitsAvailable: line.units_available ?? null,
      binPath: match?.bin_path ?? null,
      binCode: match?.bin_code ?? line.bin_code ?? null,
      batchNo: match?.batch_no ?? line.batch_no ?? null,
      // An indent hold floats between batches (2026-10-12): no row is "the allocated one".
      isAllocated: false,
    });
    group.requested += num(line.requested_qty);
    group.issued += issued;
    if (line.indent_item_id) group.direct = false;
    group.codes += codes;
    group.need += need;
    // A group's identity comes from whichever of its lines the backend has already
    // described. A freshly added split carries no `tracking_type` yet and must not
    // drag the badge back to a guess.
    if (line.tracking_type) group.trackingType = line.tracking_type;
    if (line.item_code) group.itemCode = line.item_code;
    if (line.item_name) group.itemName = line.item_name;
    if (line.is_batch_tracked) group.isBatchTracked = true;
    if (line.qty_decimals != null) group.qtyDecimals = line.qty_decimals;
  });

  for (const group of groups) {
    // Direct: what is issued is the whole of it — no ask to fall short of or pass.
    if (group.direct) group.requested = group.issued;
    group.remaining = Math.max(round(group.requested - group.issued), 0);
    const today = new Date().toISOString().slice(0, 10);
    const all = sourcesFor(sourcesByItem, group.itemId, group.combo).filter(
      (row) => !(row.expiry_date && row.expiry_date < today)
    );
    // `item_total_qty` is the same number on every row of the item, so the first row
    // carries the answer; the drawable side IS a sum, because it is only ever over
    // the locations this document may use.
    group.warehouseTotal = all.length ? num(all[0].item_total_qty) : null;
    group.warehouseDrawable = all.length
      ? round(all.reduce((sum, row) => sum + num(row.drawable_qty), 0))
      : null;
    // The three parts of the shelf, item-wise (2026-11-03): free to anybody, held for
    // this document, held by other documents. Free and total are served per item;
    // what this document holds is a sum over its rows; the rest is everybody else's.
    group.stockRows = all;
    if (all.length) {
      const total = num(all[0].item_total_qty);
      const free = Math.min(num(all[0].item_available_qty), total);
      const mine = round(all.reduce(
        (sum, row) => sum + num(row.own_reserved_qty) + num(row.issue_hold_qty ?? 0), 0));
      group.warehouseFree = free;
      group.heldForThis = Math.min(mine, round(total - free));
      group.heldByOthers = Math.max(round(total - free - group.heldForThis), 0);
    } else {
      group.warehouseFree = group.heldForThis = group.heldByOthers = null;
    }
    const taken = new Set(group.splits.map((s) => sourceKey(s.line.batch_id, s.line.bin_id)));
    const rows = all;
    // Where inventory put the hold. `own_reserved_qty` is this document's own indent's
    // reservation on that balance row — served by `issue_stock_sources` precisely so a
    // screen never has to guess which stock is spoken for by itself.
    // Holds float between batches (2026-10-12): no row is "where inventory put it",
    // so the old same-day swap lock, restore button and "hold moves" notice — all of
    // which read this list — stay off. The FEFO plan below is the only rule.
    group.allocated = [];
    // The FEFO plan for the ask: the batches it needs, earliest expiry first.
    group.plan = fefoPlan(rows, Math.max(group.requested, group.issued));
    group.required = new Set(group.plan.flatMap((step) => step.batches.map((b) => b.batchId as number)));
    const firstBatch = group.plan[0]?.batches[0];
    group.earliest = firstBatch
      ? { batchId: firstBatch.batchId as number, batchNo: firstBatch.batchNo, expiry: firstBatch.expiry,
          drawable: firstBatch.drawable }
      : null;
    // Somewhere this ask may ACTUALLY go next, which is not simply "a source it is not
    // already on". A pick drafted from an allocation may only move onto a batch
    // expiring on the same day (see `allowedExpiries`), so a spare row on a later
    // batch is one the server would refuse — and this list is what prefills the next
    // pick and what the "more available elsewhere" hint names. Offering stock nobody
    // may take is worse than saying the item is short.
    const allow = allowedExpiries(group.allocated);
    group.codedSwap = codedSwapBatches(group.allocated, rows);
    group.spare = rows.filter(
      (row) => !taken.has(sourceKey(row.batch_id, row.bin_id))
        && (!allow || allow.has(row.expiry_date ?? "")
          || group.codedSwap.has(src(row.batch_id) ?? 0)),
    );
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

/* ------------------------------------------------ what a pick may be moved onto -- */

/**
 * One batch this item can be picked from here, and everything a storekeeper needs to
 * decide whether to walk to it.
 *
 * Built from the SAME rows the server validates against (`issue_stock_sources`), so a
 * batch the screen offers is a batch the save accepts. A dropdown that offers what the
 * server refuses is a dropdown nobody trusts twice.
 */
export interface BatchChoice {
  batchId: number | null;
  batchNo: string | null;
  /** ISO date, or null when nobody recorded one — which is NOT "never expires". */
  expiry: string | null;
  mfg: string | null;
  /** What this document may take from the batch, across every location here. */
  drawable: number;
  /** What the batch holds in this warehouse altogether, other holds included. */
  total: number;
  /** How many storage locations it is spread over. */
  locations: number;
  /** Is any of it reserved for this document's own indent? */
  allocated: boolean;
  /** May this line be moved onto it — see `allowedBatchIds`. */
  allowed: boolean;
  /** The earliest-expiring batch that can still give — FEFO's first choice. */
  earliest?: boolean;
  /** Free coded units somewhere in this batch here (only meaningful when the item
   *  must leave with codes). */
  hasCodes: boolean;
  /** Allowed ONLY because of the coded-item exception — said on the option, so the
   *  storekeeper knows why a later batch is open. */
  codeException: boolean;
  /** Why not, said in full, because a disabled row with no reason is a dead end. */
  blocked: string | null;
}

/** One storage location a chosen batch of this item sits in. */
export interface LocationChoice {
  binId: number | null;
  binCode: string | null;
  binPath: string | null;
  drawable: number;
  total: number;
  ownReserved: number;
  /** Held by everybody else — the gap between what is there and what may be taken. */
  othersHold: number;
  allocated: boolean;
}

/** Oldest first, undated last: the order stock should leave in, which is the order a
 *  picker should be offered it in. Ties break on the batch number so the list is
 *  stable between renders. */
const byExpiry = (a: BatchChoice, b: BatchChoice): number => {
  if (a.expiry !== b.expiry) {
    if (!a.expiry) return 1;
    if (!b.expiry) return -1;
    return a.expiry < b.expiry ? -1 : 1;
  }
  return (a.batchNo ?? "").localeCompare(b.batchNo ?? "");
};

/**
 * Every batch of one item this point can serve, FEFO order.
 *
 * `allowedExpiries` is the FEFO rule, and it is a rule about DATES rather than about
 * batches. A line drafted from an approved allocation names the batch inventory
 * reserved, and that batch was picked earliest-expiry-first. The storekeeper standing
 * at the shelf may well find it behind a pallet, so the swap has to be possible — but
 * it must never quietly reach past an earlier-expiring batch, so it is allowed only
 * onto one expiring on the SAME DAY, which is the single swap FEFO cannot tell apart.
 * `null` means nothing was allocated (a manual issue) and every batch is open; the
 * order alone then carries the FEFO advice.
 */
export function batchChoices(
  sources: IssueStockSource[],
  allowedExpiries: Set<string> | null = null,
  codedSwap: Set<number> = new Set(),
): BatchChoice[] {
  const by = new Map<number, BatchChoice>();
  for (const row of sources) {
    const key = src(row.batch_id) ?? 0;
    let choice = by.get(key);
    if (!choice) {
      choice = {
        batchId: src(row.batch_id),
        batchNo: row.batch_no ?? null,
        expiry: row.expiry_date ?? null,
        mfg: row.mfg_date ?? null,
        drawable: 0,
        total: num(row.batch_total_qty),
        locations: 0,
        allocated: false,
        allowed: true,
        blocked: null,
        hasCodes: false,
        codeException: false,
      };
      by.set(key, choice);
    }
    choice.drawable = round(choice.drawable + num(row.drawable_qty));
    choice.locations += 1;
    if (num(row.own_reserved_qty) > 0) choice.allocated = true;
    if (row.has_unit_codes) choice.hasCodes = true;
  }
  const today = new Date().toISOString().slice(0, 10);
  const out = [...by.values()]
    .filter((choice) => !(choice.expiry && choice.expiry < today))
    .sort(byExpiry);
  const first = out.find((choice) => choice.drawable > 0 && choice.batchId);
  if (first) first.earliest = true;
  const codesRequired = sources.some((row) => row.codes_required);
  if (allowedExpiries) {
    for (const choice of out) {
      const sameDay = allowedExpiries.has(choice.expiry ?? "");
      choice.codeException = !sameDay && codedSwap.has(choice.batchId ?? 0);
      choice.allowed = sameDay || choice.codeException;
      choice.blocked = choice.allowed
        ? null
        : codesRequired && !choice.hasCodes
          ? "No codes on this batch — this item must leave with one code per unit."
          : codedSwap.size > 0
            ? "An older batch with codes comes first — stock leaves oldest first."
            : "Stock leaves oldest first, so an allocated batch may only be swapped for "
              + "one expiring on the same day.";
    }
  }
  return out;
}

/**
 * The one FEFO swap past the same-day rule — the same test as the server's
 * `_coded_swap_verdict`. An item that must leave with one serial / IMEI / code per
 * unit cannot be issued out of a batch carrying none, so when EVERY allocated batch
 * has no free coded unit here, the oldest batch(es) that do are unlocked. FEFO still
 * decides among the batches that can actually be issued: only the earliest expiry
 * among the coded ones opens up, never any later one.
 */
export function codedSwapBatches(
  allocated: IssueStockSource[],
  sources: IssueStockSource[],
): Set<number> {
  const signed = new Set(allocated.map((row) => src(row.batch_id)).filter(
    (id): id is number => !!id));
  if (!signed.size || !sources.some((row) => row.codes_required)) return new Set();
  if (sources.some((row) => signed.has(src(row.batch_id) ?? 0) && row.has_unit_codes)) {
    return new Set();
  }
  const coded = sources.filter(
    (row) => row.has_unit_codes && !signed.has(src(row.batch_id) ?? 0) && src(row.batch_id));
  if (!coded.length) return new Set();
  const earliest = (row: IssueStockSource) => row.expiry_date ?? "";
  const first = [...coded].sort((a, b) => {
    if (!a.expiry_date) return 1;
    if (!b.expiry_date) return -1;
    return a.expiry_date < b.expiry_date ? -1 : a.expiry_date > b.expiry_date ? 1 : 0;
  })[0];
  return new Set(coded.filter((row) => earliest(row) === earliest(first))
    .map((row) => src(row.batch_id) as number));
}

/** The expiry dates a pick may be moved onto, given where inventory allocated it.
 *  `null` — nothing allocated — is "no constraint", never "nothing allowed". */
/** Does expiry `a` come after `b`? An undated batch sorts after every dated one. */
export function expiresLater(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a) return !!b;
  if (!b) return false;
  return a > b;
}

/** One step of the FEFO plan: a tier of batches expiring the same day, and how much of
 *  the ask it covers. Same-day batches are interchangeable to FEFO, so they share one. */
export interface FefoStep {
  expiry: string | null;
  batches: BatchChoice[];
  /** What this tier can give the document. */
  drawable: number;
  /** How much of the ask this tier must cover — all of it, unless it is the last. */
  take: number;
}

/**
 * The batches the ask actually needs, earliest expiry first, and how much from each
 * (2026-10-12). Expired stock is never in it. Damaged or unusable stock is the stock
 * audit's business, not the issue's — so a later batch is offered only once every
 * earlier one is used up, and the batches beyond what the ask needs are not offered
 * at all. The server applies the same plan on save (`_assert_issue_sources`).
 */
export function fefoPlan(sources: IssueStockSource[], ask: number): FefoStep[] {
  const today = new Date().toISOString().slice(0, 10);
  const usable = batchChoices(sources).filter(
    (choice) => choice.batchId && choice.drawable > 0 && !(choice.expiry && choice.expiry < today));
  const tiers = new Map<string, BatchChoice[]>();
  for (const choice of usable) {
    const key = choice.expiry ?? "";
    tiers.set(key, [...(tiers.get(key) ?? []), choice]);
  }
  const ordered = [...tiers.entries()].sort(([a], [b]) => {
    if (!a) return 1;
    if (!b) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const plan: FefoStep[] = [];
  let left = round(ask);
  for (const [expiry, batches] of ordered) {
    if (left <= 0) break;
    const drawable = round(batches.reduce((sum, b) => sum + b.drawable, 0));
    const take = round(Math.min(drawable, left));
    plan.push({ expiry: expiry || null, batches, drawable, take });
    left = round(left - take);
  }
  return plan;
}

/** The first FEFO tier this item's picks leave short while a later tier is used —
 *  the same test the save applies. `null` when the picks follow the plan. */
export function fefoBreach(group: IssueGroup): { short: FefoStep; taken: number; later: FefoStep } | null {
  const takes = new Map<number, number>();
  for (const split of group.splits) {
    if (split.line.batch_id) {
      takes.set(split.line.batch_id, round((takes.get(split.line.batch_id) ?? 0) + split.issued));
    }
  }
  let remaining = round([...takes.values()].reduce((a, b) => a + b, 0));
  let short: { step: FefoStep; taken: number } | null = null;
  for (const step of group.plan) {
    if (remaining <= 0) break;
    const tierTake = round(step.batches.reduce((sum, b) => sum + (takes.get(b.batchId ?? 0) ?? 0), 0));
    const expect = round(Math.min(step.drawable, remaining));
    if (short && tierTake > 0) return { short: short.step, taken: short.taken, later: step };
    if (tierTake < expect && !short) short = { step, taken: tierTake };
    remaining = round(remaining - tierTake);
  }
  return null;
}

export function allowedExpiries(allocated: IssueStockSource[]): Set<string> | null {
  const rows = allocated.filter((row) => src(row.batch_id));
  if (rows.length === 0) return null;
  return new Set(rows.map((row) => row.expiry_date ?? ""));
}

/** Every location one batch of this item sits in, fullest first — the bay that can
 *  serve the whole ask in one walk is the one to offer first. */
export function locationChoices(
  sources: IssueStockSource[],
  batchId: number | null | undefined,
): LocationChoice[] {
  const today = new Date().toISOString().slice(0, 10);
  const wanted = sourceKey(batchId, null);
  return sources
    .filter((row) => sourceKey(row.batch_id, null) === wanted && !(row.expiry_date && row.expiry_date < today))
    .map((row) => ({
      binId: src(row.bin_id),
      binCode: row.bin_code ?? null,
      binPath: row.bin_path ?? null,
      drawable: num(row.drawable_qty),
      total: num(row.total_qty),
      ownReserved: num(row.own_reserved_qty),
      othersHold: Math.max(
        round(num(row.reserved_qty) - num(row.own_reserved_qty)), 0),
      allocated: num(row.own_reserved_qty) > 0,
    }))
    .sort((a, b) => b.drawable - a.drawable);
}

/**
 * Drop the identifiers a pick can no longer carry when its quantity comes down.
 *
 * Lowering an issue quantity below the number of units already scanned leaves a pick
 * naming more goods than it takes, which `_reserve_issue_serials` refuses outright —
 * so the storekeeper who corrects 10 to 6 was met with "10 asset tags for 6 units" and
 * had to go back into the picker to unpick four. The tail goes, because the codes were
 * scanned in the order they came off the shelf and the last ones scanned are the ones
 * still in his hand.
 */
export function trimUnits(line: IssueItemWrite, issued: number): string[] {
  const keep = Math.max(Math.trunc(issued), 0);
  const codes = line.serial_numbers ?? [];
  return codes.length > keep ? codes.slice(0, keep) : codes;
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
    unitsAt = (split) => split.unitsAvailable,
  }: {
    binManaged: boolean;
    /** Plural noun for one group's identifier, from the served catalogue. */
    unitLabel: (type: TrackingType, count: number) => string;
    /** False once the document is posted — nothing is left to fix. */
    requireUnits?: boolean;
    /** How many identified units a pick can name. Defaults to the answer saved on the
     *  line, which is the one for the bay it named when it was last SAVED — a screen
     *  holding a live probe passes that instead. */
    unitsAt?: (split: IssueSplit) => number | null;
  },
): SplitProblem[] {
  const problems: SplitProblem[] = [];
  for (const group of groups) {
    const label = group.itemCode || group.itemName || "This item";
    // Which expiry dates this item's picks may sit on, given where inventory
    // allocated them. `null` — nothing allocated — is no constraint at all.
    const allowed = allowedExpiries(group.allocated);
    // Strict FEFO: a batch outside the plan, or a later tier used before an earlier
    // one is exhausted. Same test as the save (`_assert_issue_sources`).
    for (const split of group.splits) {
      const batch = split.line.batch_id;
      if (batch && group.plan.length && !group.required.has(batch)) {
        problems.push({
          level: "error",
          groupKey: group.key,
          index: split.index,
          message: `${label}: ${split.batchNo ?? "this batch"} is not needed — the ask is covered by `
            + group.plan.flatMap((step) => step.batches.map((b) => b.batchNo ?? "unbatched")).join(", ")
            + ", earliest expiry first.",
        });
      }
    }
    const breach = fefoBreach(group);
    if (breach) {
      problems.push({
        level: "error",
        groupKey: group.key,
        message: `${label}: take ${breach.short.take} from `
          + breach.short.batches.map((b) => b.batchNo ?? "unbatched").join(", ")
          + ` (expires ${breach.short.expiry ?? "—"}) before using `
          + breach.later.batches.map((b) => b.batchNo ?? "unbatched").join(", ")
          + ` — only ${breach.taken} is taken there. Stock leaves earliest-expiry first.`,
      });
    }
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
      // FEFO, checked against the ALLOCATION rather than against the shelf. The batch
      // inventory reserved was picked earliest-expiry-first; swapping onto one that
      // expires later leaves the earlier batch behind to expire, so it is allowed only
      // onto a batch expiring on the same day — the one swap FEFO cannot tell apart.
      // `_assert_issue_sources` refuses exactly this at the save; stated here so it is
      // seen while it can still be corrected, and never only after a failed save.
      if (allowed && split.line.batch_id && split.batchTotal !== null
          && !allowed.has(split.batchExpiry ?? "")
          && !group.codedSwap.has(split.line.batch_id)) {
        problems.push({
          level: "error", groupKey: group.key, index: split.index,
          message: `${label}: ${split.batchNo ?? "this batch"} expires `
            + `${split.batchExpiry ?? "on no recorded date"}, and the batch allocated `
            + `for this indent expires `
            + `${[...allowed].map((date) => date || "on no recorded date").join(" or ")}`
            + `. Stock leaves oldest first, so an allocated batch may only be swapped `
            + `for one expiring on the same day — change the storage location instead.`,
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
      const nameable = unitsAt(split);
      if (group.pickable && group.trackingType !== "NONE"
          && nameable !== null && split.issued > 0
          && nameable < Math.trunc(split.issued)) {
        problems.push({
          level: "warn", groupKey: group.key, index: split.index,
          message: `${label}: the quantity is here, but only ${nameable} `
            + `${unitLabel(group.trackingType, nameable)} can be named `
            + `for ${Math.trunc(split.issued)} units. The rest have no identifier on `
            + `the shelf.`,
        });
      }
      if (requireUnits && group.pickable && group.trackingType !== "NONE") {
        const need = split.need;
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
