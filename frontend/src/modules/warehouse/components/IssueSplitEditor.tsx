import { useState } from "react";
import {
  AlertTriangle, Check, MessageSquare, Plus, ScanLine, Trash2, Undo2,
} from "lucide-react";
import { Button } from "@/shared/components";
import { Lookup } from "./Lookup";
import { QtyInput, TextInput } from "./LinesEditor";
import { TrackingBadge } from "./TrackingBadge";
import { LocationTrail } from "./LocationTrail";
import { batchOptions, binOptions } from "../api";
import { fmtQty, num } from "../format";
import { redistribute, replaceGroup, round } from "../issueSplits";
import type { IssueGroup, IssueSplit } from "../issueSplits";
import type {
  IssueItemWrite, IssueStockSource, TrackingType, TrackingTypeMeta,
} from "../types";

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

/** A pick's own label for its cell, drawn only while the column headings are not.
 *  One component so a cell and its heading can never say two different things. */
function CellLabel({ children }: { children: React.ReactNode }) {
  return <div className={`${HEAD} mb-0.5 lg:hidden`}>{children}</div>;
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
  /** Opens the identifier picker for one pick, by its flat index. */
  onPickUnits: (index: number) => void;
  meta: (code?: TrackingType | null) => TrackingTypeMeta | null;
  /** Flat indices that carry a problem, so the row can show it where it happened. */
  problemAt: Map<number, { level: "error" | "warn"; message: string }>;
  /** Adds a whole new item row, on an issue not drawn from an indent. */
  onAddItem?: () => void;
  /** Renders the item picker for a group that has not chosen one yet. */
  renderItemPicker: (split: IssueSplit) => React.ReactNode;
  onRemoveGroup?: (group: IssueGroup) => void;
  /** Per-pick rate editor — unchanged from the flat grid, kept on the pick. */
  renderRate?: (split: IssueSplit) => React.ReactNode;
}

export function IssueSplitEditor({
  groups, lines, onChange, sourcesByItem, warehouseId, indentId, binManaged,
  locked, unitsLocked, onPickUnits, meta, problemAt, onAddItem, renderItemPicker,
  onRemoveGroup, renderRate,
}: Props) {
  const patch = (index: number, change: Partial<IssueItemWrite>) =>
    onChange(lines.map((line, i) => (i === index ? { ...line, ...change } : line)));

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
    const next = group.spare[0];
    const take = next
      ? round(Math.min(group.remaining, num(next.drawable_qty)))
      : 0;
    const fresh: IssueItemWrite = {
      ...template,
      id: undefined,
      batch_id: next?.batch_id ?? null,
      batch_no: next?.batch_no ?? null,
      bin_id: binManaged ? next?.bin_id ?? null : null,
      bin_code: next?.bin_code ?? null,
      bin_path: next?.bin_path ?? null,
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
            <div className={`${HEAD} text-right`}>Can give</div>
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
          binManaged={binManaged}
          warehouseId={warehouseId}
          indentId={indentId}
          locked={locked}
          unitsLocked={unitsLocked}
          unitMeta={meta(group.trackingType)}
          problemAt={problemAt}
          onPatch={patch}
          onAddPick={() => addPick(group)}
          onRemovePick={(index) => removePick(group, index)}
          onRestore={() => restoreAllocation(group)}
          onSetAsk={(value) => setAsk(group, value)}
          onPickUnits={onPickUnits}
          onRemoveGroup={onRemoveGroup}
          renderItemPicker={renderItemPicker}
          renderRate={renderRate}
          hasSources={(sourcesByItem[group.itemId] ?? []).length > 0}
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
  binManaged: boolean;
  warehouseId: number;
  indentId?: number | null;
  locked: boolean;
  unitsLocked: boolean;
  unitMeta: TrackingTypeMeta | null;
  problemAt: Map<number, { level: "error" | "warn"; message: string }>;
  onPatch: (index: number, change: Partial<IssueItemWrite>) => void;
  onAddPick: () => void;
  onRemovePick: (index: number) => void;
  onRestore: () => void;
  onSetAsk: (value: number) => void;
  onPickUnits: (index: number) => void;
  onRemoveGroup?: (group: IssueGroup) => void;
  renderItemPicker: (split: IssueSplit) => React.ReactNode;
  renderRate?: (split: IssueSplit) => React.ReactNode;
  hasSources: boolean;
}

function ItemRow(props: ItemProps) {
  const {
    group, locked, unitMeta, onAddPick, onRestore, onSetAsk,
    onRemoveGroup, renderItemPicker, hasSources,
  } = props;

  const tracked = group.pickable && group.trackingType !== "NONE";
  const short = round(group.requested - group.issued);
  const over = short < 0;
  const codesDone = !tracked || group.codes === Math.trunc(group.issued);
  const settled = !over && short === 0 && codesDone && group.issued > 0;
  // Positive: still to scan. Negative: more named than the picks now take — lowering
  // a quantity after scanning leaves too MANY, and "-2 to assign" is not a sentence.
  const unassigned = Math.trunc(group.issued) - group.codes;
  const askEditable = !locked && !!group.itemId && !group.splits[0]?.line.indent_item_id;
  const spareQty = group.spare.reduce((sum, row) => sum + num(row.drawable_qty), 0);
  // The whole reason this screen has to say anything about reservations at all: a
  // pick moved off the location inventory allocated is a hold that MOVES when this
  // document is saved. Announced before the press, never after.
  const moving = group.releasing.length > 0 && group.allocated.length > 0;

  return (
    <div
      className={`overflow-hidden rounded-xl border bg-content1 transition-colors ${
        over ? "border-bad/50" : settled ? "border-line/70" : "border-warn/40"
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
            </>
          ) : (
            <div className="max-w-md">{renderItemPicker(group.splits[0])}</div>
          )}

          <dl className="mt-2.5 flex flex-wrap items-end gap-x-5 gap-y-2">
            <div>
              <dt className={HEAD}>Requested</dt>
              <dd className="tabular text-sm font-semibold text-ink">
                {askEditable ? (
                  <span className="block w-24">
                    <QtyInput
                      ariaLabel={`Requested quantity for ${group.itemCode ?? "this item"}`}
                      value={group.requested}
                      onChange={(value) => onSetAsk(num(value))}
                    />
                  </span>
                ) : (
                  fmtQty(group.requested)
                )}
              </dd>
            </div>
            <div>
              <dt className={HEAD}>Issuing</dt>
              <dd className={`tabular text-sm font-semibold ${
                over ? "text-bad" : settled ? "text-ok" : "text-ink"
              }`}>
                {fmtQty(group.issued)}
                <span className="font-normal text-muted"> / {fmtQty(group.requested)}</span>
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
          <div className="mt-2 text-xs font-semibold">
            {over ? (
              <span className="inline-flex items-center gap-1 text-bad">
                <AlertTriangle className="h-3.5 w-3.5" /> Over by {fmtQty(-short)}
              </span>
            ) : settled ? (
              <span className="inline-flex items-center gap-1 text-ok">
                <Check className="h-3.5 w-3.5" />
                Fully allocated
                {group.splits.length > 1 && (
                  <span className="font-normal text-muted">
                    ({group.splits.length} locations)
                  </span>
                )}
              </span>
            ) : short > 0 ? (
              <span className="text-warn">{fmtQty(short)} still to place</span>
            ) : (
              <span className={unassigned > 0 ? "text-warn" : "text-bad"}>
                {Math.abs(unassigned)} {unitMeta?.unit ?? "identifier"}
                {Math.abs(unassigned) === 1 ? "" : "s"}{" "}
                {unassigned > 0 ? "to assign" : "too many"}
              </span>
            )}
          </div>

          {onRemoveGroup && !locked && group.itemId > 0 && (
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
          <div className="space-y-1.5">
            {group.splits.map((split, position) => (
              <PickRow
                key={split.index}
                {...props}
                split={split}
                position={position}
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
                  {group.spare[0] && (
                    <> — next is{" "}
                      <span className="font-mono text-ink">
                        {group.spare[0].bin_code ?? "unbinned"}
                      </span>
                      {group.spare[0].batch_no ? ` · ${group.spare[0].batch_no}` : ""}
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
  onRemove: () => void;
  problem?: { level: "error" | "warn"; message: string };
}

function PickRow(props: PickProps) {
  const {
    group, split, position, binManaged, warehouseId, indentId, locked, unitsLocked,
    unitMeta, onPatch, onPickUnits, onRemove, problem, renderRate,
  } = props;

  const line = split.line;
  const need = Math.trunc(split.issued);
  const tracked = group.pickable && group.trackingType !== "NONE";
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

  // Remarks and rate are real, and they are not what anybody is reading this row for.
  // Hidden behind one press unless they already carry something to say.
  const [noting, setNoting] = useState(false);
  const showNote = noting || !!line.remarks;

  return (
    <div
      className={`rounded-lg border px-2 py-1.5 ${
        problem?.level === "error"
          ? "border-bad/40 bg-bad-bg/25"
          : problem?.level === "warn"
            ? "border-warn/30 bg-warn-bg/20"
            : "border-line/50 bg-content2/25"
      }`}
    >
      <div className={PICK_COLS}>
        {/* The pick's number. On a phone it is the card's own heading, so it says
          * what it is instead of being a bare digit in a 20px column. */}
        <div className="col-span-2 text-[11px] tabular text-muted sm:col-span-3 lg:col-span-1 lg:pt-2.5">
          <span className="lg:hidden font-semibold uppercase tracking-wider">
            Pick {position + 1}
          </span>
          <span className="hidden lg:inline">{position + 1}</span>
        </div>

        {/* --- batch --- */}
        <div className="min-w-0">
          <CellLabel>Batch</CellLabel>
          <Lookup
            name={`issue-batches-${line.item_id}-${warehouseId}-${indentId ?? 0}`}
            load={() => batchOptions(line.item_id, warehouseId, null, indentId)}
            value={line.batch_id ?? ""}
            isDisabled={locked || !line.item_id || !warehouseId}
            onChange={(value, option) =>
              onPatch(split.index, {
                batch_id: value === "" ? null : value,
                batch_no: option?.code ?? null,
                bin_id: null,
                bin_code: null,
                bin_path: null,
                // The identifiers named here belonged to the OLD batch. Keeping them
                // would hand the shelf a unit that is not in the batch the line now
                // claims, and `set_issue_serials` refuses exactly that at save.
                serial_numbers: [],
              })
            }
            placeholder={group.isBatchTracked ? "Pick a batch" : "No batch"}
          />
        </div>

        {/* --- storage location, with the whole walk down to it --- */}
        <div className="col-span-2 min-w-0 sm:col-span-2 lg:col-span-1">
          <CellLabel>Storage location</CellLabel>
          {binManaged ? (
            <>
              <Lookup
                name={`bins-${warehouseId}-${line.batch_id ?? 0}-${indentId ?? 0}`}
                load={(s) => binOptions(warehouseId, s, line.item_id, line.batch_id,
                                        undefined, undefined, undefined, indentId)}
                value={line.bin_id ?? ""}
                isDisabled={locked || !warehouseId || (group.isBatchTracked && !line.batch_id)}
                onChange={(v, option) =>
                  onPatch(split.index, {
                    bin_id: v === "" ? null : v,
                    bin_code: option?.code ?? null,
                    bin_path: (option as { path?: string | null } | undefined)?.path ?? null,
                    serial_numbers: [],
                  })
                }
                placeholder={
                  group.isBatchTracked && !line.batch_id ? "Pick batch first" : "Pick a location"
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
          * somebody else's hold as somebody else's rather than as a silent gap. */}
        <div className="leading-tight lg:pt-2 lg:text-right">
          <CellLabel>Can give</CellLabel>
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
              {(split.total ?? 0) > 0
                && round((split.total ?? 0) - (split.drawable ?? 0)) !== othersHold && (
                <div className="text-[10px] text-muted">
                  {fmtQty(split.total)} on the shelf
                </div>
              )}
            </>
          )}
        </div>

        {/* --- how much comes off it --- */}
        <div>
          <CellLabel>Issue qty</CellLabel>
          <QtyInput
            ariaLabel={`Issue quantity from pick ${position + 1}`}
            value={line.issued_qty ?? 0}
            max={split.drawable ?? undefined}
            disabled={locked}
            invalid={overDrawn}
            onChange={(value) => onPatch(split.index, { issued_qty: value })}
          />
        </div>

        {/* --- identifiers ---
          *
          * Two DIFFERENT numbers, side by side and never merged: how many coded units
          * this exact location could name (off `whs_serial_numbers`) and how many the
          * storekeeper has actually named. A quantity is not an identity — stock put
          * away before the item was coded has the first and not the second. */}
        <div className="min-w-0">
          <CellLabel>{unitMeta?.label ?? "Identifiers"}</CellLabel>
          {!tracked ? (
            <span className="inline-block text-[11px] text-muted lg:pt-2.5">Not tracked</span>
          ) : (
            <>
              <Button
                variant={split.codes === need && need > 0 ? "soft" : "ghost"}
                onClick={() => onPickUnits(split.index)}
                disabled={unitsLocked || needsSource || need <= 0}
                title={
                  needsSource
                    ? "Pick the batch and storage location first"
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
              <div className="mt-0.5 text-[10px] leading-tight text-muted">
                {needsSource ? (
                  "Name the source first"
                ) : split.unitsAvailable === null ? (
                  "…"
                ) : (
                  <span className={split.unitsAvailable < need ? "text-warn" : undefined}>
                    {split.unitsAvailable > need ? `${need}+` : split.unitsAvailable}{" "}
                    {unitMeta?.unit ?? "unit"}
                    {split.unitsAvailable === 1 ? "" : "s"} here
                  </span>
                )}
              </div>
              {need > 0 && split.codes !== need && !needsSource && (
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
