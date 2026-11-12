import { useState } from "react";
import { baseOf, packable, type PackHierarchy } from "@/shared/packing";
import { IssuePickPacking } from "./IssuePickPacking";
import { ItemStockCard } from "./ItemStockCard";
import {
  AlertTriangle, Barcode, Check, MessageSquare, PackageX, Plus, ScanLine, Trash2, Undo2,
} from "lucide-react";
import { Button } from "@/shared/components";
import { QtyInput, TextInput } from "./LinesEditor";
import { TrackingBadge } from "./TrackingBadge";
import { LocationTrail } from "./LocationTrail";
import { BatchPicker, LocationPicker, expiryLabel } from "./SourcePicker";
import { fmtQty, num } from "../format";
import {
  allowedExpiries, batchChoices, locationChoices, redistribute, replaceGroup, round,
  sourceKey, trimUnits,
} from "../issueSplits";
import type { BatchChoice, IssueGroup, IssueSplit } from "../issueSplits";
import { sourcesFor } from "../issueSplits";
import { heldMix } from "../packPick";
import type {
  IssueItemWrite, IssueStockSource, TrackingType, TrackingTypeMeta, UnitSupply,
} from "../types";
import { CombinationPicker, CombinationTag, inStockOptions, type CombinationValue } from "@/shared/combination";

/**
 * The Lines grid of a material issue: **one row per item, however many batches and
 * storage locations that item is picked from.**
 *
 * The flat grid this replaced could say "15 monitors, batch AUG-26, bin F1-A1-R1-B1"
 * and nothing else, so an ask the shelf serves out of two bays had to be written as
 * though it came out of one. The unit picker, correctly scoped to the line's own
 * batch and bin, then offered 5 codes against a line claiming 15 — and that mismatch,
 * not the document, is what everybody noticed.
 *
 * The first fix for that put the picks on child rows under a parent row, which said
 * the right thing and read as two documents stacked on each other: a header per item,
 * a table header per item, and the ask separated from the picks that serve it. This
 * is the same data in one row — the item and what it is owed on the left, every pick
 * that serves it stacked on the right, under ONE set of column headings for the whole
 * document. Nothing is nested and nothing is collapsed by default, because a pick
 * nobody can see is a pick nobody checks.
 *
 * A pick is an ordinary sibling LINE — see `issueSplits.ts` for why that is the whole
 * of the data model change.
 *
 * **There is no automatic split.** The storekeeper is the one standing at the shelf;
 * which bay he draws from is his call, and the screen's job is to tell him what is
 * there, what his own allocation already holds, and what moving off it will do.
 */

/**
 * The sub-columns one pick renders in. Declared once and used by the header and by
 * every pick on every item, so a number in the Issue qty column is under the words
 * "Issue qty" all the way down a fifty-line document.
 *
 * Columns only from `lg` up. Below that the seven of them would be 40px each, so a
 * pick becomes a two-column card carrying its own labels — the storekeeper working
 * the floor is on a phone, and rule 12 is not a suggestion.
 */
const PICK_COLS =
  "grid items-start gap-x-2 gap-y-2 grid-cols-2 sm:grid-cols-3 " +
  "lg:gap-y-1 lg:grid-cols-[1.25rem_minmax(7rem,10rem)_minmax(10rem,1.5fr)_5.5rem_6rem_7rem_2rem]";

const HEAD = "text-[10px] font-semibold uppercase tracking-wider text-muted";

/** How a pick addresses its own answer in the live unit-supply map. The probe is
 *  asked per (item, batch, location) and answers in the same currency — 0 is "names
 *  none", exactly as the warehouse writes NO_BIN / NO_BATCH. */
export const unitSupplyKey = (
  itemId: number, batchId?: number | null, binId?: number | null,
): string => `${itemId}:${batchId || 0}:${binId || 0}`;

/** A pick's own label for its cell, drawn only while the column headings are not.
 *  One component so a cell and its heading can never say two different things. */
function CellLabel({ children }: { children: React.ReactNode }) {
  return <div className={`${HEAD} mb-0.5 lg:hidden`}>{children}</div>;
}

/**
 * How much of this item is HERE, where "here" is whatever the cell is about.
 *
 * The grid states the same shelf at three widths — the warehouse, then one batch of
 * it, then one location inside that batch — and each of those numbers is meaningless
 * without the word that says which one it is. So the scope is part of the chip and
 * cannot be separated from the figure: "40 in this batch" under the batch picker, "10
 * at this location" under the location picker. A bare number beside a dropdown is the
 * thing that gets read as the wrong quantity.
 *
 * `null` is "not read yet" and draws nothing. Zero is an answer and is drawn, in warn,
 * because an empty batch is exactly what a storekeeper needs told.
 */
function StockChip({
  qty, scope, after = null, title, className = "",
}: {
  qty: number | null;
  scope: string;
  /** What is left once this document has taken what it says it will. Drawn only when
   *  it differs from `qty` — an arrow to the same number is noise. */
  after?: number | null;
  title?: string;
  className?: string;
}) {
  if (qty === null) return null;
  const empty = qty <= 0;
  const shows = after !== null && round(after) !== round(qty);
  return (
    <div
      title={title}
      className={`mt-1 inline-flex max-w-full items-baseline gap-1 rounded-md border px-1.5 py-0.5 text-[10px] leading-tight ${
        empty
          ? "border-warn/30 bg-warn-bg/30 text-warn"
          : "border-line/60 bg-content2/60 text-muted"
      } ${className}`}
    >
      <span className={`tabular font-semibold ${empty ? "" : "text-ink"}`}>
        {fmtQty(qty)}
      </span>
      <span className="truncate">{scope}</span>
      {shows && (
        <span className={`tabular whitespace-nowrap ${
          after <= 0 ? "text-warn" : "text-muted"
        }`}>
          → {fmtQty(after)} left
        </span>
      )}
    </div>
  );
}

interface Props {
  groups: IssueGroup[];
  lines: IssueItemWrite[];
  onChange: (lines: IssueItemWrite[]) => void;
  sourcesByItem: Record<number, IssueStockSource[]>;
  warehouseId: number;
  indentId?: number | null;
  binManaged: boolean;
  /** The document is past DRAFT: quantities, batches and locations are the approver's. */
  locked: boolean;
  /** Even the units are settled — posted, cancelled, or somebody else's to name. */
  unitsLocked: boolean;
  /** Asset/consumable codes only — swappable by the issuer or an approver. Falls back
   *  to `locked && unitsLocked` when not given. */
  codesLocked?: boolean;
  /** Identifiers are not picked yet at all — drafts and documents in approval. The
   *  units are chosen at the shelf by whoever issues it, once it is approved. */
  unitsHidden?: boolean;
  /** Opens the identifier picker for one pick, by its flat index. */
  onPickUnits: (index: number) => void;
  /** A pick has just been given its batch AND location (or batch, where the point
   *  keeps none) — the form fills asset / consumable codes for it there and then. */
  onSourcePicked?: (index: number, line: IssueItemWrite) => void;
  meta: (code?: TrackingType | null) => TrackingTypeMeta | null;
  /** Flat indices that carry a problem, so the row can show it where it happened. */
  problemAt: Map<number, { level: "error" | "warn"; message: string }>;
  /** How many identified units each pick could name, live, keyed by
   *  `item:batch:location` — see `unitSupplyKey`. A pick the storekeeper has just
   *  repointed has no saved answer, and the stale one belonged to the bay he left. */
  unitSupply?: Record<string, UnitSupply>;
  /** Has the shelf ANSWERED for these items? An empty source list means two
   *  different things — "still loading" and "this point holds none of it" — and
   *  drawing the second before the first has settled accuses a stocked warehouse of
   *  being empty. */
  sourcesReady?: boolean;
  /** Adds a whole new item row, on an issue not drawn from an indent. */
  onAddItem?: () => void;
  /** Renders the item picker for a group that has not chosen one yet. */
  renderItemPicker: (split: IssueSplit) => React.ReactNode;
  onRemoveGroup?: (group: IssueGroup) => void;
  /** Per-pick rate editor — unchanged from the flat grid, kept on the pick. */
  renderRate?: (split: IssueSplit) => React.ReactNode;
  /** Each item's pack hierarchies, so a pick can be issued in packs (2026-10-08). */
  packOptionsByItem?: Record<number, PackHierarchy[]>;
}

export function IssueSplitEditor({
  groups, lines, onChange, sourcesByItem, warehouseId, indentId, binManaged,
  locked, unitsLocked, codesLocked, unitsHidden = false, onPickUnits, onSourcePicked, meta, problemAt, unitSupply,
  sourcesReady, onAddItem, renderItemPicker, onRemoveGroup, renderRate, packOptionsByItem,
}: Props) {
  const patch = (index: number, change: Partial<IssueItemWrite>,
                 event?: { batchPicked?: boolean; locationPicked?: boolean }) => {
    const next = lines.map((line, i) => (i === index ? { ...line, ...change } : line));
    onChange(next);
    const line = next[index];
    // Batch and location both named (or the batch, where nothing is binned): the
    // source is decided, so the codes for it can be filled straight away.
    const picked = event?.locationPicked ? !!line.bin_id
      : event?.batchPicked ? !!line.batch_id && !binManaged : false;
    if (picked && onSourcePicked) onSourcePicked(index, line);
  };

  /** A direct issue picks which brand / variant / model it gives, off what the point
   *  holds (2026-10-23). The picks then stand on another shelf, so their batch,
   *  location and codes are cleared to be picked again. */
  const setCombination = (group: IssueGroup, combo: CombinationValue) => {
    const at = new Set(group.splits.map((s) => s.index));
    onChange(lines.map((line, i) => (at.has(i) ? {
      ...line, ...combo, batch_id: null, batch_no: null, bin_id: null, bin_code: null,
      serial_numbers: null,
    } : line)));
  };

  /**
   * Take a pick off an item, and give what it was requesting back to the item.
   *
   * `redistribute` with the ask measured BEFORE the removal is what does that. Left
   * to itself the item's requested quantity is a sum over its picks, so dropping one
   * would quietly shrink the indent's ask along with it — fifteen monitors becoming
   * ten because one bay turned out to be empty.
   */
  const removePick = (group: IssueGroup, index: number) => {
    const ask = group.requested;
    const kept = group.splits.filter((s) => s.index !== index).map((s) => s.line);
    onChange(replaceGroup(lines, group, redistribute(kept, ask)));
  };

  /**
   * Add one more pick, prefilled with the oldest source this item is not already
   * drawing on and with whatever is still owed, capped at what that source holds.
   * A pick that arrives already wrong is worse than a blank one.
   *
   * The ask does not change: it is measured first and put back over the new set of
   * picks, so splitting a quantity never invents any of it.
   */
  const addPick = (group: IssueGroup) => {
    const template = group.splits[group.splits.length - 1]?.line;
    if (!template) return;
    // Blank, never pre-picked (2026-10-12): which batch and which bay are the
    // storekeeper's choice, offered earliest-expiry first in the dropdowns.
    const take = round(Math.max(group.remaining, 0));
    const fresh: IssueItemWrite = {
      ...template,
      id: undefined,
      batch_id: null,
      batch_no: null,
      bin_id: null,
      bin_code: null,
      bin_path: null,
      requested_qty: take,
      issued_qty: take,
      serial_numbers: [],
      remarks: null,
      units_available: undefined,
    };
    onChange(replaceGroup(
      lines, group,
      redistribute([...group.splits.map((s) => s.line), fresh], group.requested),
    ));
  };

  /**
   * Put every pick back where inventory allocated it.
   *
   * The counterpart to being allowed to move off the allocation at all: one press
   * undoes the whole rearrangement, so a storekeeper who changed a location and then
   * found the goods where he was originally sent is not left reconstructing the
   * allocation by hand out of a dropdown.
   */
  const restoreAllocation = (group: IssueGroup) => {
    const template = group.splits[0]?.line;
    if (!template || group.allocated.length === 0) return;
    let left = group.requested;
    const rebuilt: IssueItemWrite[] = [];
    for (const row of group.allocated) {
      if (left <= 0) break;
      const take = round(Math.min(left, num(row.own_reserved_qty)));
      if (take <= 0) continue;
      rebuilt.push({
        ...template,
        id: undefined,
        batch_id: row.batch_id ?? null,
        batch_no: row.batch_no ?? null,
        bin_id: binManaged ? row.bin_id ?? null : null,
        bin_code: row.bin_code ?? null,
        bin_path: row.bin_path ?? null,
        requested_qty: take,
        issued_qty: take,
        // The identifiers named belonged to the locations being left behind. A unit
        // that is not in the bin the pick now claims is refused at save anyway.
        serial_numbers: [],
        units_available: undefined,
      });
      left = round(left - take);
    }
    if (rebuilt.length === 0) return;
    onChange(replaceGroup(lines, group, redistribute(rebuilt, group.requested)));
  };

  /**
   * Set what an item is asking for, on an issue not drawn from an indent.
   *
   * There is nowhere else for it to go. An indent-linked item inherits the ask from
   * the indent line and it is not the storekeeper's to change; a hand-built issue has
   * no indent, and the flat grid this replaced disabled its Requested box outright —
   * so every hand-added line went to the server requesting nothing and was refused by
   * `_apply_issue_lines` before it could be saved at all.
   */
  const setAsk = (group: IssueGroup, ask: number) =>
    onChange(replaceGroup(
      lines, group,
      redistribute(group.splits.map((s) => s.line), Math.max(round(num(ask)), 0)),
    ));

  return (
    <div className="space-y-2">
      {groups.length === 0 && (
        <div className="rounded-2xl border border-dashed border-line bg-content1 py-12 text-center text-sm text-muted">
          Add the items leaving the store.
        </div>
      )}

      {/* One header for the whole document. The old grid repeated a full table head
        * under every item, which turned a ten-line issue into ten tables. */}
      {groups.length > 0 && (
        <div className="hidden rounded-t-xl border border-line/70 bg-content2/60 px-3 py-2 lg:grid lg:grid-cols-[minmax(15rem,19rem)_minmax(0,1fr)] lg:gap-4">
          <div className={HEAD}>Item &amp; what it is owed</div>
          <div className={PICK_COLS}>
            <div />
            <div className={HEAD}>Batch</div>
            <div className={HEAD}>Storage location</div>
            {/* "here" is the whole point: the batch and location cells now state
              * what the batch and the warehouse hold, and this column is the one
              * number that is only about the bay the pick names. */}
            <div className={`${HEAD} text-right`}>Can give here</div>
            <div className={`${HEAD} text-right`}>Issue qty</div>
            <div className={HEAD}>Identifiers</div>
            <div />
          </div>
        </div>
      )}

      {groups.map((group) => (
        <ItemRow
          key={group.key}
          group={group}
          lines={lines}
          sources={sourcesFor(sourcesByItem, group.itemId, group.combo)}
          allSources={sourcesByItem[group.itemId] ?? []}
          onSetCombination={(combo) => setCombination(group, combo)}
          binManaged={binManaged}
          warehouseId={warehouseId}
          indentId={indentId}
          locked={locked}
          unitsLocked={unitsLocked}
          codesLocked={codesLocked}
          unitsHidden={unitsHidden}
          unitMeta={meta(group.trackingType)}
          problemAt={problemAt}
          unitSupply={unitSupply}
          sourcesReady={sourcesReady}
          onPatch={patch}
          onAddPick={() => addPick(group)}
          onRemovePick={(index) => removePick(group, index)}
          onRestore={() => restoreAllocation(group)}
          onSetAsk={(value) => setAsk(group, value)}
          onPickUnits={onPickUnits}
          onRemoveGroup={onRemoveGroup}
          renderItemPicker={renderItemPicker}
          renderRate={renderRate}
          packOptions={packable(packOptionsByItem?.[group.itemId])}
          hasSources={sourcesFor(sourcesByItem, group.itemId, group.combo).length > 0}
        />
      ))}

      {onAddItem && (
        <Button
          variant="soft"
          onClick={onAddItem}
          // Two unnamed lines share the group key `item:0` and would draw as one row
          // with two picks under a single item box. Name this one first.
          disabled={groups.some((group) => !group.itemId)}
          title={groups.some((group) => !group.itemId)
            ? "Choose the item on the row above first"
            : undefined}
        >
          <Plus className="h-4 w-4" /> Add item
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ one item -- */

interface ItemProps {
  group: IssueGroup;
  lines: IssueItemWrite[];
  /** Every (batch, location) this item can be drawn from here — the one list both
   *  pickers are built from and the server validates against. */
  sources: IssueStockSource[];
  binManaged: boolean;
  warehouseId: number;
  indentId?: number | null;
  locked: boolean;
  unitsLocked: boolean;
  codesLocked?: boolean;
  unitsHidden: boolean;
  unitMeta: TrackingTypeMeta | null;
  problemAt: Map<number, { level: "error" | "warn"; message: string }>;
  unitSupply?: Record<string, UnitSupply>;
  sourcesReady?: boolean;
  onPatch: (index: number, change: Partial<IssueItemWrite>,
            event?: { batchPicked?: boolean; locationPicked?: boolean }) => void;
  onAddPick: () => void;
  onRemovePick: (index: number) => void;
  onRestore: () => void;
  onSetAsk: (value: number) => void;
  onPickUnits: (index: number) => void;
  onRemoveGroup?: (group: IssueGroup) => void;
  renderItemPicker: (split: IssueSplit) => React.ReactNode;
  renderRate?: (split: IssueSplit) => React.ReactNode;
  packOptions: PackHierarchy[];
  hasSources: boolean;
  /** Every source of the item, whatever its combination — the in-stock dropdown. */
  allSources: IssueStockSource[];
  onSetCombination: (combo: CombinationValue) => void;
}

function ItemRow(props: ItemProps) {
  const {
    group, sources, locked, unitMeta, sourcesReady, onAddPick, onRestore, onSetAsk,
    onRemoveGroup, renderItemPicker, hasSources, allSources, onSetCombination,
  } = props;
  // The brand / variant / model: an indent's is carried and fixed (it is what was
  // reserved); a direct issue picks one off what this point holds.
  const firstLine = group.splits[0]?.line;
  const comboChoices = group.direct && group.itemId
    ? inStockOptions(group.itemId,
                     allSources.map((row) => ({ ...row, qty: num(row.drawable_qty) })))
    : [];

  // The shelf has answered and it holds none of this item — at this point, in any
  // batch, in any bay. Said once, in a sentence, instead of leaving the batch picker
  // reading "nothing on the shelf" over a location picker reading "pick the batch
  // first": that is the same fact told twice in the language of two controls that
  // cannot be used, three decisions after the one that actually went wrong.
  const barren = !!group.itemId && !!sourcesReady && sources.length === 0;

  /* Which batches this item may be moved onto, and in what order.
   *
   * FEFO is a rule about DATES, not about batches: a line drafted from an approved
   * allocation may be swapped onto a batch expiring on the SAME DAY — the one swap
   * FEFO cannot tell apart — and never onto a later one, which would leave the
   * earlier batch on the shelf to expire. `_assert_issue_sources` refuses exactly the
   * same thing at the save, off the same rows. Nothing allocated (a manual issue) and
   * every batch is open; the oldest-first ordering then carries the advice by itself.
   */
  const allowed = allowedExpiries(group.allocated);
  // Strict FEFO (2026-10-12): only the batches the ask needs, earliest expiry first.
  // The batch already on a line stays listed so a saved pick never renders empty; if
  // the plan no longer names it, the row says so (`splitProblems`).
  // A direct issue answers no indent, so no plan limits it: every batch is offered,
  // oldest first, and the hint below carries the FEFO advice (CLAUDE.md: a manual
  // issue is not held to the same-day rule).
  const batches = batchChoices(sources, allowed, group.codedSwap).filter(
    (choice) => group.direct || group.required.has(choice.batchId ?? 0)
      || group.splits.some((s) => (s.line.batch_id ?? 0) === (choice.batchId ?? 0) && choice.batchId));
  // The oldest batch that still has stock, when this item is not taking from it.
  // Advice on a manual line, never a refusal: the storekeeper can see which pallet is
  // reachable and the screen cannot.
  const oldest = batches.find((row) => row.drawable > 0) ?? null;
  const usingBatches = new Set(group.splits.map((split) => split.line.batch_id ?? 0));
  const fefoHint = !allowed && oldest && !usingBatches.has(oldest.batchId ?? 0)
    ? `${oldest.batchNo ?? "An older batch"} expires ${expiryLabel(oldest.expiry)}`
      + ` and still has ${fmtQty(oldest.drawable)} here. Stock should leave oldest`
      + ` first.`
    : null;

  const tracked = group.pickable && group.trackingType !== "NONE";
  const short = round(group.requested - group.issued);
  const over = short < 0;
  const codesDone = !tracked || group.codes === group.need;
  const settled = !over && short === 0 && codesDone && group.issued > 0;
  // Positive: still to scan. Negative: more named than the picks now take — lowering
  // a quantity after scanning leaves too MANY, and "-2 to assign" is not a sentence.
  const unassigned = group.need - group.codes;
  const askEditable = !locked && !!group.itemId && !group.splits[0]?.line.indent_item_id;
  const spareQty = group.spare.reduce((sum, row) => sum + num(row.drawable_qty), 0);
  // The next place worth walking to: earliest expiry, but never an expired lot.
  const todayIso = new Date().toISOString().slice(0, 10);
  const nextSpare = group.spare.find(
    (row) => !(row.expiry_date && row.expiry_date < todayIso)) ?? null;
  // The whole reason this screen has to say anything about reservations at all: a
  // pick moved off the location inventory allocated is a hold that MOVES when this
  // document is saved. Announced before the press, never after.
  const moving = group.releasing.length > 0 && group.allocated.length > 0;

  return (
    <div
      className={`overflow-hidden rounded-xl border bg-content1 transition-colors ${
        over
          ? "border-bad/50"
          : settled || !group.itemId
          ? "border-line/70"
          : "border-warn/40"
      }`}
    >
      <div className="grid gap-4 px-3 py-3 lg:grid-cols-[minmax(15rem,19rem)_minmax(0,1fr)]">
        {/* ---- the item, and what it is owed ------------------------------- */}
        <div className="min-w-0 border-line/70 lg:border-r lg:pr-4">
          {group.itemId ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="break-all font-mono text-xs font-semibold text-ink">
                  {group.itemCode ?? `Item ${group.itemId}`}
                </span>
                <TrackingBadge type={group.trackingType} meta={unitMeta} />
              </div>
              <div className="mt-0.5 break-words text-xs leading-5 text-muted">
                {group.itemName ?? "—"}
              </div>
              {comboChoices.length > 0 && !locked ? (
                <div className="mt-2">
                  <CombinationPicker
                    options={comboChoices}
                    value={firstLine}
                    ariaLabel={`Brand, variant and model for ${group.itemCode ?? "this item"}`}
                    onChange={onSetCombination}
                  />
                </div>
              ) : (
                <CombinationTag value={firstLine} className="mt-1.5" />
              )}
            </>
          ) : (
            <div className="max-w-md">{renderItemPicker(group.splits[0])}</div>
          )}

          <dl className="mt-2.5 flex flex-wrap items-end gap-x-5 gap-y-2">
            {!group.direct && <div>
              {/* SCM_0068: "Requested" implies a request behind the line, which is
                  true for an indent line and false for one raised with no indent —
                  the storekeeper is deciding the quantity, nobody asked for it. A
                  wholly direct item hides it (2026-10-21); a hand-added line on an
                  indent issue still shows it, under this name. */}
              <dt className={HEAD}>{askEditable ? "Quantity to issue" : "Requested"}</dt>
              <dd className="tabular text-sm font-semibold text-ink">
                {askEditable ? (
                  <span className="block w-24">
                    <QtyInput
                      ariaLabel={`Quantity to issue for ${group.itemCode ?? "this item"}`}
                      value={group.requested}
                      decimals={group.qtyDecimals}
                      onChange={(value) => onSetAsk(num(value))}
                    />
                  </span>
                ) : (
                  fmtQty(group.requested)
                )}
              </dd>
            </div>}
            <div>
              <dt className={HEAD}>Issuing</dt>
              <dd className={`tabular text-sm font-semibold ${
                over ? "text-bad" : settled ? "text-ok" : "text-ink"
              }`}>
                {fmtQty(group.issued)}
                {!group.direct && (
                  <span className="font-normal text-muted"> / {fmtQty(group.requested)}</span>
                )}
              </dd>
            </div>
            {tracked && (
              <div>
                <dt className={HEAD}>{unitMeta?.label ?? group.trackingType}</dt>
                <dd className={`tabular text-sm font-semibold ${
                  codesDone ? "text-ok" : "text-warn"
                }`}>
                  {group.codes}
                  <span className="font-normal text-muted"> / {Math.trunc(group.issued)}</span>
                </dd>
              </div>
            )}
          </dl>

          {/* One sentence, and it is the one that decides whether this item is
            * finished. Never a status word on its own — "Partial" tells nobody what
            * to do next. */}
          {!group.itemId ? (
            <div className="mt-2 text-xs text-muted">
              Select an item to issue
            </div>
          ) : group.requested <= 0 && group.issued <= 0 ? (
            <div className="mt-2 text-xs text-muted">
              {group.direct
                ? "Pick a batch and location, then enter the quantity to issue"
                : "Enter requested quantity to issue"}
            </div>
          ) : (
            <div className="mt-2 text-xs font-semibold">
              {over ? (
                <span className="inline-flex items-center gap-1 text-bad">
                  <AlertTriangle className="h-3.5 w-3.5" /> Over by {fmtQty(-short)}
                </span>
              ) : settled ? (
                <span className="inline-flex items-center gap-1 text-ok">
                  <Check className="h-3.5 w-3.5" />
                  {group.direct ? "Ready to issue" : "Fully allocated"}
                  {group.splits.length > 1 && (
                    <span className="font-normal text-muted">
                      ({group.splits.length} locations)
                    </span>
                  )}
                </span>
              ) : short > 0 ? (
                <span className="text-warn">{fmtQty(short)} still to place</span>
              ) : unassigned !== 0 ? (
                <span className={unassigned > 0 ? "text-warn" : "text-bad"}>
                  {Math.abs(unassigned)} {unitMeta?.unit ?? "identifier"}
                  {Math.abs(unassigned) === 1 ? "" : "s"}{" "}
                  {unassigned > 0 ? "to assign" : "too many"}
                </span>
              ) : null}
            </div>
          )}

          {/* The shelf for this item, split the way the decision needs it: free to
            * anybody, held for this document, reserved by other documents — then what
            * this issue can take and what is left once it goes (2026-11-03). Replaces
            * the separate "Stock on the shelf" panel that sat above the grid. */}
          {group.warehouseTotal !== null && (
            <ItemStockCard
              total={group.warehouseTotal}
              free={group.warehouseFree ?? 0}
              mine={group.heldForThis ?? 0}
              others={group.heldByOthers ?? 0}
              drawable={group.warehouseDrawable}
              issued={group.issued}
              asked={group.requested}
              direct={group.direct}
              rows={group.stockRows}
            />
          )}

          {onRemoveGroup && !locked && (group.itemId > 0 || !group.splits[0]?.line.indent_item_id) && (
            <button
              type="button"
              onClick={() => onRemoveGroup(group)}
              className="mt-2 inline-flex items-center gap-1 rounded-md text-[11px] font-semibold text-muted transition-colors hover:text-bad"
            >
              <Trash2 className="h-3.5 w-3.5" /> Remove item
            </button>
          )}
        </div>

        {/* ---- every batch and storage location it is picked from ---------- */}
        <div className="min-w-0">
          {barren && (
            <div className="mb-2 flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-bg/40 px-2.5 py-2 text-[11px] leading-5 text-ink">
              <PackageX className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
              <div className="min-w-0 flex-1">
                <span className="font-semibold">
                  This point holds none of this item.
                </span>{" "}
                Not in another batch, not in another bay — there is no stock of{" "}
                <span className="font-mono">{group.itemCode ?? "it"}</span> here at
                all, so there is nothing to pick a batch or a location from.
                {group.splits[0]?.line.indent_item_id
                  ? " The indent line stays short until stock arrives."
                  : " Choose an item the shelf actually has, or remove this row."}
              </div>
            </div>
          )}
          {/* The FEFO plan: only the batches this ask needs, earliest expiry first, and
            * how much from each. An earlier step must be used up before a later one —
            * the same plan the save checks. Nothing is picked for the storekeeper. */}
          {group.plan.length > 0 && !locked && (
            <FefoPlanStrip group={group} />
          )}
          <div className="space-y-1.5">
            {group.splits.map((split, position) => (
              <PickRow
                key={split.index}
                {...props}
                split={split}
                position={position}
                batches={batches}
                fefoHint={fefoHint}
                onRemove={() => props.onRemovePick(split.index)}
                problem={props.problemAt.get(split.index)}
              />
            ))}
          </div>

          {!locked && group.itemId > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line/60 pt-2">
              <Button variant="soft" onClick={onAddPick} disabled={!hasSources}>
                <Plus className="h-4 w-4" />
                Add batch / storage location
              </Button>
              {group.spare.length > 0 ? (
                <span className="text-[11px] text-muted">
                  {fmtQty(spareQty)} more available in {group.spare.length} other
                  {" "}location{group.spare.length === 1 ? "" : "s"}
                  {nextSpare && (
                    <> — earliest good is{" "}
                      <span className="font-mono text-ink">
                        {nextSpare.bin_code ?? "unbinned"}
                      </span>
                      {nextSpare.batch_no ? ` · ${nextSpare.batch_no}` : ""}
                    </>
                  )}
                </span>
              ) : (
                short > 0 && (
                  <span className="text-[11px] text-warn">
                    Nothing else on the shelf here — {fmtQty(short)} stays short.
                  </span>
                )
              )}
            </div>
          )}

          {/* The one FEFO swap past the same-day rule, explained where it applies.
            * Without it a later batch simply turned selectable and the storekeeper
            * could not tell an exception from a mistake. */}
          {group.codedSwap.size > 0 && !locked && (() => {
            const allocatedNos = Array.from(new Set(group.allocated
              .map((row) => row.batch_no).filter(Boolean)));
            const unlocked = batches.filter((row) => row.codeException);
            return (
              <div className="mt-2 flex items-start gap-2 rounded-lg border border-info/30 bg-info-bg px-2.5 py-2 text-[11px] leading-5 text-ink">
                <Barcode className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
                <span>
                  <span className="font-semibold">
                    {allocatedNos.join(", ") || "The allocated batch"} carries no codes
                  </span>
                  {" "}— this item must leave with one code per unit, so it cannot be
                  issued from there. Unlocked instead:{" "}
                  {unlocked.map((row, i) => (
                    <span key={row.batchId ?? 0}>
                      {i > 0 && ", "}
                      <span className="font-mono font-semibold">{row.batchNo}</span>
                      {" "}({expiryLabel(row.expiry)})
                    </span>
                  ))}
                  , the oldest batch here that has them. Saving moves the reservation
                  onto it and frees the allocated batch.
                </span>
              </div>
            );
          })()}

          {/* What changing a location actually DOES. The hold inventory placed does
            * not follow a document by itself: saying so here is the difference
            * between a deliberate correction and a storekeeper discovering later
            * that a bay he emptied was still reserved. */}
          {moving && (
            <div className="mt-2 flex flex-wrap items-start gap-x-3 gap-y-1 rounded-lg border border-brand/25 bg-brand/[0.05] px-2.5 py-2">
              <div className="min-w-0 flex-1 text-[11px] leading-5 text-ink">
                <span className="font-semibold">Moving off what inventory allocated.</span>{" "}
                Saving frees{" "}
                {group.releasing.map((row, position) => (
                  <span key={`${row.bin_id}-${row.batch_id}`}>
                    {position > 0 && ", "}
                    <span className="font-mono font-semibold">
                      {row.bin_code ?? "unbinned"}
                    </span>
                    {row.batch_no ? ` · ${row.batch_no}` : ""}
                    {" "}({fmtQty(row.own_reserved_qty)})
                  </span>
                ))}{" "}
                back to free stock and takes the same quantity where the picks now
                point.
              </div>
              {!locked && (
                <Button variant="ghost" onClick={onRestore}>
                  <Undo2 className="h-4 w-4" /> Put it back
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ one pick -- */

interface PickProps extends ItemProps {
  split: IssueSplit;
  position: number;
  /** Built once per item, not per pick: every pick of one item chooses from the same
   *  shelf, and rebuilding the list per row made a fifty-pick document do it fifty
   *  times a keystroke. */
  batches: BatchChoice[];
  fefoHint: string | null;
  onRemove: () => void;
  problem?: { level: "error" | "warn"; message: string };
}

/** The batches an item's ask needs, in the order stock must leave. */
function FefoPlanStrip({ group }: { group: IssueGroup }) {
  const taken = new Map<number, number>();
  for (const split of group.splits) {
    if (split.line.batch_id) {
      taken.set(split.line.batch_id, round((taken.get(split.line.batch_id) ?? 0) + split.issued));
    }
  }
  const total = round(group.plan.reduce((sum, step) => sum + step.take, 0));
  const short = round(Math.max(group.requested, group.issued) - total);
  return (
    <div className="mb-2 rounded-xl border border-brand/20 bg-brand/[0.035] px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-brand">
          FEFO plan · take in this order
        </span>
        {short > 0 && (
          <span className="text-[10px] font-semibold text-warn">
            {fmtQty(short)} short — no other unexpired stock here
          </span>
        )}
      </div>
      <ol className="flex flex-wrap items-stretch gap-1.5">
        {group.plan.map((step, i) => {
          const got = round(step.batches.reduce((sum, b) => sum + (taken.get(b.batchId ?? 0) ?? 0), 0));
          const done = got >= step.take && step.take > 0;
          return (
            <li key={`${step.expiry}-${i}`}
                className={`flex min-w-[9.5rem] items-center gap-2 rounded-lg border px-2.5 py-1.5 transition ${
                  done ? "border-ok/40 bg-ok/[0.07]" : "border-line bg-content1"}`}>
              <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                done ? "bg-ok text-white" : "bg-brand/10 text-brand"}`}>
                {done ? <Check className="h-3 w-3" /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className="block truncate font-mono text-xs font-semibold text-ink">
                  {step.batches.map((b) => b.batchNo ?? "unbatched").join(" / ")}
                </span>
                <span className="block text-[10px] leading-tight text-muted">
                  {step.expiry ? `exp ${expiryLabel(step.expiry)}` : "no expiry"} · take{" "}
                  <b className="tabular text-ink">{fmtQty(step.take)}</b>
                  {got > 0 && !done && <> · {fmtQty(got)} picked</>}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function PickRow(props: PickProps) {
  const {
    group, split, position, sources, batches, fefoHint, binManaged, locked,
    unitsLocked, codesLocked, unitsHidden, unitMeta, unitSupply, onPatch, onPickUnits, onRemove, problem,
    renderRate, packOptions,
  } = props;

  const line = split.line;
  const todayIso = new Date().toISOString().slice(0, 10);
  const isBatchExpired = !!(split.batchExpiry && split.batchExpiry < todayIso);
  // Only the locations holding THIS batch of this item. Changing the bay within a
  // batch is one physical batch sitting in two places, which FEFO cannot tell apart
  // and which is the storekeeper's call — so this list is deliberately wide open
  // where the batch list is not.
  const locations = locationChoices(sources, line.batch_id);
  // What the WHOLE document takes out of this pick's batch — every pick of this item
  // on it, not just this one. A batch served out of two bays would otherwise report
  // each bay's take as the batch's, and the "left after this issue" figure beside it
  // would be wrong by exactly the other bay.
  const batchTaken = round(group.splits
    .filter((other) => sourceKey(other.line.batch_id, null)
      === sourceKey(line.batch_id, null))
    .reduce((sum, other) => sum + other.issued, 0));
  const need = split.need;
  // A pick issued in PACKAGES (2026-10-26): the package size off the boxes it holds,
  // and how many it holds — or, before a save, how many the quantity comes to.
  const boxes = line.issue_in_boxes ? line.box_codes ?? [] : [];
  // Counted in packages only while every package is the same one. Boxes AND the strips
  // out of a box (two Issue levels) are not one unit: counting 45 strips as "45 boxes"
  // and multiplying an edit by the box size is how the count went wrong, so a mixed
  // pick is edited in base units and its mix is said under it.
  const uniformPacks = boxes.length > 0 && boxes.every((b) =>
    num(b.size) === num(boxes[0].size) && (b.pack_name ?? "") === (boxes[0].pack_name ?? ""));
  const packSize = uniformPacks ? Math.max(...boxes.map((b) => num(b.size))) : 0;
  const boxesMix = boxes.length ? heldMix(boxes) : "";
  const packsHeld = boxes.length && Math.abs(boxes.reduce((s, b) => s + num(b.take), 0)
    - num(line.issued_qty)) < 1e-6
    ? boxes.length : packSize ? Math.ceil(num(line.issued_qty) / packSize) : 0;
  const packWord = (n: number) => {
    const name = (boxes[0]?.pack_name ?? "package").toLowerCase();
    return `${n} ${n === 1 ? name : /(x|s|ch|sh)$/.test(name) ? `${name}es` : `${name}s`}`;
  };
  const tracked = group.pickable && group.trackingType !== "NONE";
  // Asset and consumable codes are the system's own labels: the server assigns them,
  // oldest first from THIS pick's batch and location, on every save — so they are on
  // the document from the draft onwards and survive submit and approval. A serial or
  // an IMEI is read off the goods at the shelf, and stays "picked after approval".
  const autoCodes = group.trackingType === "ASSET" || group.trackingType === "CONSUMABLE";
  const hidden = unitsHidden && !autoCodes;
  // Editable on a draft and, once approved, by whoever issues it or approved it; only viewable in
  // between. Serial/IMEI picks keep the document-wide rule.
  const pickLocked = autoCodes ? codesLocked ?? (locked && unitsLocked) : unitsLocked;
  // Everybody else's reservation on this balance row. Worth naming: an unexplained
  // gap between what is on the shelf and what the pick may take reads as a bug.
  const othersHold = split.reserved !== null && split.ownReserved !== null
    ? Math.max(round(split.reserved - split.ownReserved), 0)
    : 0;
  // The picker is scoped to this pick's own batch and location, so it cannot be
  // opened until they are chosen — an unscoped list is the cross-bin picking error
  // this screen exists to close.
  const needsBatch = group.isBatchTracked && !line.batch_id;
  const needsLocation = binManaged && !line.bin_id;
  const needsSource = !locked && (needsBatch || needsLocation);
  const removable = !locked && group.splits.length > 1;
  const overDrawn = split.drawable !== null && round(split.issued - split.drawable) > 0;
  // How many identified units this exact (batch, location) can name, probed live —
  // the saved answer on the line belonged to the bay the storekeeper has just moved
  // off, and a stale number here reads as a shortage that is not there. Falls back to
  // the saved one while the probe is in flight. See `issue_unit_supply`.
  const supply = unitSupply?.[
    unitSupplyKey(line.item_id, line.batch_id, binManaged ? line.bin_id : null)
  ];
  const unitsHere = supply ? supply.available : split.unitsAvailable;

  // Remarks and rate are real, and they are not what anybody is reading this row for.
  // Hidden behind one press unless they already carry something to say.
  const [noting, setNoting] = useState(false);
  const showNote = noting || !!line.remarks;

  return (
    <div
      className={`rounded-lg border px-2 py-1.5 transition-colors ${
        problem?.level === "error"
          ? "border-bad/40 bg-bad-bg/25"
          : problem?.level === "warn"
            ? "border-warn/30 bg-warn-bg/20"
            : "border-line/50 bg-content2/25 hover:border-line hover:bg-content2/40"
      }`}
    >
      <div className={PICK_COLS}>
        {/* The pick's number. On a phone it is the card's own heading, so it says
          * what it is instead of being a bare digit in a 20px column. */}
        <div className="col-span-2 text-[11px] tabular text-muted sm:col-span-3 lg:col-span-1 lg:pt-2">
          <span className="lg:hidden font-semibold uppercase tracking-wider">
            Pick {position + 1}
          </span>
          <span className="hidden h-5 w-5 items-center justify-center rounded-full bg-content2 text-[10px] font-semibold text-muted lg:inline-flex">
            {position + 1}
          </span>
        </div>

        {/* --- batch ---
          *
          * Every batch on the shelf here, oldest first, each carrying its expiry and
          * what it can give. The plain code list this replaced made the one decision
          * that matters — which batch expires first — invisible at the moment it was
          * being taken. See `SourcePicker`. */}
        <div className="min-w-0">
          <CellLabel>Batch</CellLabel>
          <BatchPicker
            choices={batches}
            value={line.batch_id}
            isDisabled={locked || !line.item_id}
            isBatchTracked={group.isBatchTracked}
            fallbackNo={split.batchNo ?? line.batch_no}
            fefoHint={fefoHint}
            isExpired={isBatchExpired}
            onChange={(choice) =>
              onPatch(split.index, {
                batch_id: choice?.batchId ?? null,
                batch_no: choice?.batchNo ?? null,
                // The location belonged to the OLD batch, and so did every identifier
                // named on this pick — `set_issue_serials` refuses a unit that is not
                // in the batch the line claims, so keeping either would only fail at
                // the save.
                bin_id: null,
                bin_code: null,
                bin_path: null,
                serial_numbers: [],
              }, { batchPicked: true })
            }
          />

          {/* This batch across the WHOLE warehouse — the middle of the three widths.
            * The pick takes from one bay of it; knowing whether the batch has forty
            * more elsewhere or nothing at all is what decides whether the shortfall
            * is worth walking for. */}
          <StockChip
            // Bulk stock carries no batch, and every source row of it matches the
            // "no batch" key — so the figure would be right and the words would be
            // a lie. Nothing is said where there is no batch to say it about.
            qty={group.isBatchTracked || line.batch_id ? split.batchTotal : null}
            scope="in this batch"
            after={split.batchTotal === null ? null : round(split.batchTotal - batchTaken)}
            title={
              split.batchDrawable === null
                ? undefined
                : `${fmtQty(split.batchTotal)} of this item in batch `
                  + `${split.batchNo ?? line.batch_no ?? "—"}, across every location in `
                  + `this warehouse. ${fmtQty(split.batchDrawable)} of it is available `
                  + `to this issue, and this document takes ${fmtQty(batchTaken)}.`
            }
          />
        </div>

        {/* --- storage location, with the whole walk down to it --- */}
        <div className="col-span-2 min-w-0 sm:col-span-2 lg:col-span-1">
          <CellLabel>Storage location</CellLabel>
          {binManaged ? (
            <>
              <LocationPicker
                choices={locations}
                value={line.bin_id}
                isDisabled={locked || !line.item_id}
                needsBatch={group.isBatchTracked && !line.batch_id}
                fallbackCode={split.binCode ?? line.bin_code}
                fallbackPath={split.binPath ?? line.bin_path}
                isExpired={isBatchExpired}
                onChange={(choice) =>
                  onPatch(split.index, {
                    bin_id: choice?.binId ?? null,
                    bin_code: choice?.binCode ?? null,
                    bin_path: choice?.binPath ?? null,
                    // Named at the bay being left. A unit that is not in the bin the
                    // pick now claims is refused at save either way.
                    serial_numbers: [],
                  }, { locationPicked: true })
                }
              />
              {/* Floor › lane › rack › shelf › bin. The dropdown label carries it too,
                * but the trail is what a picker actually reads on the way there. */}
              <LocationTrail
                className="mt-1"
                steps={null}
                path={split.binPath ?? line.bin_path}
                code={split.binCode ?? line.bin_code}
              />
              {/* The innermost of the three: this item, this batch, this location.
                * Not the same number as Can give — that one is what the pick may
                * TAKE, this one is what is standing there, and the gap between them
                * belongs to somebody else's document. */}
              <StockChip
                qty={split.total}
                scope="at this location"
                after={split.total === null ? null : round(split.total - split.issued)}
                title={
                  split.drawable === null
                    ? undefined
                    : `${fmtQty(split.total)} of this item, in this batch, at `
                      + `${split.binCode ?? line.bin_code ?? "this location"}. `
                      + `${fmtQty(split.drawable)} of it can be taken by this issue, `
                      + `and this pick takes ${fmtQty(split.issued)}.`
                }
              />
            </>
          ) : (
            <span className="inline-block pt-2.5 text-xs text-muted">
              Stocked in bulk — no locations here
            </span>
          )}
        </div>

        {/* --- what this location can give ---
          *
          * An approved allocation RESERVES the stock it is about to issue, so a
          * correct document routinely sees its own balance row at `available 0` — the
          * goods are on the shelf, held by this very document. Printing that 0 on its
          * own told a storekeeper his document was impossible. The headline is what
          * the pick may draw; the lines beneath say where it comes from, and name
          * somebody else's hold as somebody else's rather than as a silent gap.
          *
          * What is physically STANDING at this location is a different fact and is
          * said once, on the location cell — never twice, in two places, at two
          * widths. */}
        <div className="leading-tight lg:pt-2 lg:text-right">
          <CellLabel>Can give here</CellLabel>
          {split.drawable === null ? (
            <span className="text-xs text-muted">…</span>
          ) : (
            <>
              <div className={`tabular text-sm font-semibold ${
                overDrawn ? "text-bad" : "text-ink"
              }`}>
                {fmtQty(split.drawable)}
              </div>
              {(split.ownReserved ?? 0) > 0 && (
                <div
                  className="text-[10px] text-ok"
                  title="Reserved for this indent by the approved allocation"
                >
                  {fmtQty(split.ownReserved)} allocated here
                </div>
              )}
              {othersHold > 0 && (
                <div className="text-[10px] text-muted" title="Reserved by another document">
                  {fmtQty(othersHold)} held elsewhere
                </div>
              )}
            </>
          )}
        </div>

        {/* --- how much comes off it ---
          *
          * Lowering it takes the surplus identifiers with it. A pick naming ten units
          * and issuing six is refused outright by `_reserve_issue_serials`, so the
          * storekeeper correcting a quantity used to be sent back into the picker to
          * unpick four codes by hand before he could save. */}
        <div>
          {packSize > 0 ? (
            <>
              {/* Issued in PACKAGES (2026-10-26): the count is in packages, the base
                * under it. The last package may be a part one — the ask is honoured
                * exactly, never rounded up to a whole package. */}
              <CellLabel>Issue qty ({packWord(2).split(" ")[1]})</CellLabel>
              <QtyInput
                decimals={0}
                ariaLabel={`Packages to issue from pick ${position + 1}`}
                value={packsHeld}
                disabled={locked}
                invalid={overDrawn}
                onChange={(value) => {
                  const want = Math.max(0, Math.floor(num(value)));
                  const ask = num(line.requested_qty);
                  const base = ask > 0 ? Math.min(want * packSize, ask) : want * packSize;
                  onPatch(split.index, {
                    issued_qty: base,
                    serial_numbers: [],
                    ...(line.pack_breakdown?.length && baseOf(line.pack_breakdown) !== base
                      ? { pack_breakdown: null } : {}),
                  });
                }}
              />
              <div className="mt-0.5 text-[11px] text-muted">
                {fmtQty(num(line.issued_qty))} base
              </div>
            </>
          ) : (
            <>
          <CellLabel>Issue qty</CellLabel>
          <QtyInput
            ariaLabel={`Issue quantity from pick ${position + 1}`}
            value={line.issued_qty ?? 0}
            max={split.drawable ?? undefined}
            disabled={locked}
            invalid={overDrawn}
            decimals={group.qtyDecimals}
            onChange={(value) => onPatch(split.index, {
              issued_qty: value,
              serial_numbers: trimUnits(line, num(value)),
              // The packs follow the quantity: dropped here, worked out again in the
              // same hierarchy by `IssuePickPacking` (2026-10-22).
              ...(line.pack_breakdown?.length && baseOf(line.pack_breakdown) !== num(value)
                ? { pack_breakdown: null } : {}),
            })}
          />
            </>
          )}
        </div>

        {/* --- identifiers ---
          *
          * Two DIFFERENT numbers, side by side and never merged: how many coded units
          * this exact location could name (off `whs_serial_numbers`) and how many the
          * storekeeper has actually named. A quantity is not an identity — stock put
          * away before the item was coded has the first and not the second. */}
        <div className="min-w-0">
          <CellLabel>{line.issue_in_boxes ? "Package codes" : unitMeta?.label ?? "Identifiers"}</CellLabel>
          {!tracked ? (
            <span className="inline-block text-[11px] text-muted lg:pt-2.5">Not tracked</span>
          ) : hidden ? (
            <span className="inline-block text-[11px] text-muted lg:pt-2.5">
              Picked after approval
            </span>
          ) : (
            <>
              <Button
                variant={split.codes === need && need > 0 ? "soft" : "ghost"}
                onClick={() => onPickUnits(split.index)}
                disabled={needsSource || need <= 0 || (pickLocked && split.codes === 0)}
                title={
                  needsSource
                    ? "Pick the batch and storage location first"
                    : autoCodes
                      ? pickLocked
                        ? "View the codes assigned to this pick"
                        : "Assigned automatically, oldest first. Open to swap any of them."
                      : unitMeta?.hint ?? "Assign identifiers"
                }
              >
                <ScanLine className="h-4 w-4" />
                <span className={split.codes === need ? "text-ok" : "text-warn"}>
                  {split.codes}
                </span>
                <span className="text-muted">/ {need}</span>
              </Button>
              {/* Two facts, and they are not the same fact. What this exact location
                * could name comes off `whs_serial_numbers`; what is still to be
                * scanned is the storekeeper's own progress. Stock put away before the
                * item was coded has quantity and no identity, so a pick can be sound
                * on the first and impossible on the second. */}
              {/* Issued in a container (2026-10-26): the line names its boxes. */}
              {line.issue_in_boxes && !needsSource && (line.serial_numbers?.length ?? 0) > 0 && (
                <div className="mt-1 flex max-w-[15rem] flex-wrap gap-1">
                  {(line.serial_numbers ?? []).slice(0, 2).map((code) => (
                    <span key={code} title={code}
                          className="mono max-w-[13rem] truncate rounded-md bg-brand/[0.07] px-1.5 py-0.5 text-[10px] font-semibold text-brand">
                      {code}
                    </span>
                  ))}
                  {(line.serial_numbers?.length ?? 0) > 2 && (
                    <span className="rounded-md bg-content2 px-1.5 py-0.5 text-[10px] font-semibold text-muted">
                      +{(line.serial_numbers?.length ?? 0) - 2}
                    </span>
                  )}
                </div>
              )}
              {line.container_note && (
                <div className="mt-1 max-w-[15rem] rounded-md bg-warn-bg px-2 py-1 text-[10px] font-medium leading-snug text-warn">
                  {line.container_note}
                </div>
              )}
              <div className="mt-0.5 text-[10px] leading-tight text-muted">
                {line.issue_in_boxes && !needsSource ? (
                  boxesMix ? `${boxesMix} for this pick`
                    : need > 0 ? `${need} ${need === 1 ? "package" : "packages"} for this pick` : null
                ) : needsSource ? (
                  "Name the source first"
                ) : unitsHere === null || unitsHere === undefined ? (
                  "…"
                ) : (
                  <span className={unitsHere < need ? "text-warn" : undefined}>
                    {unitsHere > need ? `${need}+` : unitsHere}{" "}
                    {unitMeta?.unit ?? "unit"}
                    {unitsHere === 1 ? "" : "s"} here
                  </span>
                )}
              </div>
              {autoCodes && need > 0 && !needsSource && (
                <div className={`text-[10px] font-semibold leading-tight ${
                  split.codes === need ? "text-ok" : "text-muted"
                }`}>
                  {split.codes === need
                    ? "Auto-assigned"
                    : split.codes < need && !pickLocked
                      ? `${need - split.codes} more auto-assigned ${locked ? "when issued" : "on save"}`
                      : null}
                </div>
              )}
              {need > 0 && split.codes !== need && !needsSource
                && !(autoCodes && split.codes < need && !pickLocked) && (
                <div className={`text-[10px] leading-tight ${
                  need - split.codes > 0 ? "text-warn" : "text-bad"
                }`}>
                  {need - split.codes > 0
                    ? `${need - split.codes} more to assign`
                    : `${split.codes - need} too many`}
                </div>
              )}
            </>
          )}
        </div>

        {/* --- remove, and the note toggle --- */}
        <div className="col-span-2 flex flex-row items-center justify-end gap-0.5 sm:col-span-3 lg:col-span-1 lg:flex-col lg:items-center lg:justify-start lg:pt-1">
          {removable && (
            <button
              type="button"
              onClick={onRemove}
              aria-label={`Remove pick ${position + 1}`}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-bad-bg hover:text-bad"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          {!locked && (
            <button
              type="button"
              onClick={() => setNoting((open) => !open)}
              aria-label={`Note on pick ${position + 1}`}
              aria-pressed={showNote}
              title="Remarks and rate"
              className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-content2 ${
                line.remarks ? "text-brand" : "text-muted"
              }`}
            >
              <MessageSquare className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {showNote && (
        <div className="mt-1.5 flex flex-wrap items-end gap-3 border-t border-line/50 pt-1.5">
          <div className="min-w-[12rem] flex-1">
            <div className={`${HEAD} mb-1`}>Remarks</div>
            <TextInput
              ariaLabel={`Remarks on pick ${position + 1}`}
              value={line.remarks}
              disabled={locked}
              onChange={(value) => onPatch(split.index, { remarks: value })}
            />
          </div>
          {renderRate && (
            <div className="w-32">
              <div className={`${HEAD} mb-1`}>Rate</div>
              {renderRate(split)}
            </div>
          )}
        </div>
      )}

      {packOptions.length > 0 && !!line.item_id && (
        <IssuePickPacking
          line={line}
          hierarchies={packOptions}
          locked={locked}
          uom={packOptions[0]?.base_uom}
          onChange={(change) => onPatch(split.index, change)}
        />
      )}

      {problem && (
        <p className={`mt-1 text-[11px] ${
          problem.level === "error" ? "text-bad" : "text-warn"
        }`}>
          {problem.message}
        </p>
      )}
    </div>
  );
}
