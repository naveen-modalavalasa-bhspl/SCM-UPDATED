import { useMemo, useState } from "react";
import {
  AlertTriangle, Check, ChevronDown, Layers, Lock, Minus, Package, Plus, Trash2, Wand2,
} from "lucide-react";
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from "@heroui/react";
import {
  type PackEntry, type PackHierarchy, LOOSE, baseOf, describe, entriesFrom, fmtQty,
  fullCountsOf, greedy, greedyWithPart, heldOf, hierarchyOf, isPartial, matchState, num,
  packWarnings, partEntry,
} from "./packing";
import { usePackOptions } from "./api";

/* ---------------------------------------------------------------------------
 * Pack hierarchies on screen (2026-10-08). The pieces every module uses:
 *
 *   PackChips            how a quantity is packed, read-only: "1 Carton · 10 Box"
 *   PackQty              a quantity cell: the packs, the base quantity under them,
 *                        and a button that opens the whole hierarchy (2026-10-11)
 *   HierarchyLadder      one hierarchy, every level with its size and minimum
 *   PackHierarchyPicker  which family: "Strip of 10" or "Strip of 15"
 *   PackBreakdownEditor  how many of each level, adding up live to the quantity —
 *                        full packs as tiles, PART packs ("1 Carton (500 of 600)")
 *                        listed underneath with what each one holds
 *
 * One vocabulary everywhere: a PACK HIERARCHY is the family, a PACK LEVEL is a rung
 * of it, LOOSE is base units outside any pack, a PART pack holds less than its
 * level's size. The sentence under every editor is the same one the server writes.
 * ------------------------------------------------------------------------- */

// whitespace-nowrap: a part pack ("1 Carton (400/600)") is one chip, and in a narrow
// column it wrapped INSIDE itself into "1 / Carton (400/600)".
const chip =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold tabular";

/** "Strip of 10 · 1 Carton · 10 Box · 20 Strip = 2,400 TAB" as chips. A part pack
 *  reads "1 Carton (500/600)", amber when it is under its level's minimum. */
export function PackChips({ entries, uom, showHierarchy = true, showTotal = true,
                            muted = false, className = "" }: {
  entries?: PackEntry[] | null;
  uom?: string | null;
  showHierarchy?: boolean;
  showTotal?: boolean;
  /** Declared / reference packing, drawn quieter than a live count. */
  muted?: boolean;
  className?: string;
}) {
  const rows = [...(entries ?? [])].filter((e) => num(e.qty) > 0)
    .sort((a, b) => b.level - a.level || heldOf(b) - heldOf(a));
  if (!rows.length) return <span className="text-xs text-muted">Not packed</span>;
  const hierarchy = hierarchyOf(rows);
  const tone = muted
    ? "bg-neutral-bg text-ink-700 ring-1 ring-line"
    : "bg-brand-050 text-brand-600 ring-1 ring-brand/30";
  return (
    <span className={`inline-flex flex-wrap items-center gap-1 ${className}`}
          title={describe(rows, uom)}>
      {showHierarchy && hierarchy && (
        <span className="inline-flex items-center gap-1 pr-0.5 text-[11px] font-medium text-muted">
          <Layers size={12} aria-hidden /> {hierarchy}
        </span>
      )}
      {rows.map((e, index) => {
        const part = isPartial(e);
        const low = part && !!e.below_min;
        return (
          <span key={`${e.level}-${e.name}-${e.fill ?? "full"}-${index}`}
                title={low ? `Below the ${fmtQty(e.min_fill)} minimum — repack it` : undefined}
                className={`${chip} ${e.level === 0
                  ? "border border-dashed border-line bg-transparent text-ink-700"
                  : low ? "bg-warn-bg text-warn ring-1 ring-warn/40"
                    : part ? "border border-dashed border-brand/50 bg-content1 text-brand-600"
                      : tone}`}>
            {low ? <AlertTriangle size={11} aria-hidden />
              : e.level !== 0 && <Package size={11} aria-hidden />}
            {fmtQty(e.qty)} {e.level === 0 ? `loose ${uom ?? "units"}` : e.name}
            {part && <span className="font-medium">({fmtQty(e.fill)}/{fmtQty(e.size)})</span>}
          </span>
        );
      })}
      {showTotal && rows.some((e) => e.level !== 0) && (
        <span className="text-xs font-semibold text-ink tabular">
          = {fmtQty(baseOf(rows))} {uom ?? "units"}
        </span>
      )}
    </span>
  );
}

/** The ladder of one hierarchy in one line: "Strip 10 › Box 100 › Carton 1,200". */
export function ladderCaption(h: PackHierarchy, uom?: string | null): string {
  return h.levels.filter((lv) => lv.level > 0)
    .map((lv) => `${lv.name} ${fmtQty(lv.size)}`).join(" › ") + ` ${uom ?? h.base_uom ?? ""}`;
}

/** One hierarchy, level by level, biggest first: what each holds, what it is made of
 *  and its minimum fill. What the hierarchy button on every quantity opens. */
export function HierarchyLadder({ hierarchy, uom, entries, current = false }: {
  hierarchy: PackHierarchy;
  uom?: string | null;
  /** This line's packing, said once under the ladder. */
  entries?: PackEntry[] | null;
  /** Mark it as the one the line uses. */
  current?: boolean;
}) {
  const unit = uom ?? hierarchy.base_uom ?? "units";
  const levels = [...hierarchy.levels].filter((lv) => lv.level > 0)
    .sort((a, b) => b.level - a.level);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-ink">
        <Layers size={14} className="text-brand" aria-hidden /> {hierarchy.name}
        {current && (
          <span className="rounded-full bg-brand-050 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-brand-600">
            This line
          </span>
        )}
        {hierarchy.is_default && (
          <span className="rounded-full bg-ok-bg px-1.5 text-[10px] font-semibold uppercase tracking-wide text-ok">
            Default
          </span>
        )}
      </div>
      <ol className="space-y-1">
        {levels.map((lv) => {
          const below = hierarchy.levels[lv.level - 1];
          return (
            <li key={lv.level}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-lg border border-line bg-content1 px-2.5 py-1.5 text-xs">
              <span className="font-semibold text-ink">
                <span className="mr-1 text-[10px] font-medium text-muted">L{lv.level}</span>
                1 {lv.name}
                {lv.level > 1 && below && (
                  <span className="font-normal text-muted"> = {fmtQty(lv.ratio)} {below.name}</span>
                )}
              </span>
              <span className="tabular text-ink-700">
                = <b>{fmtQty(lv.size)}</b> {unit}
                {num(lv.min_fill) > 0 && (
                  <span className="ml-1.5 text-muted">· min {fmtQty(lv.min_fill)}</span>
                )}
              </span>
            </li>
          );
        })}
        <li className="px-2.5 text-[11px] text-muted">Counted in {unit} (the item's base unit).</li>
      </ol>
      {!!entries?.length && (
        <div className="rounded-lg bg-neutral-bg px-2.5 py-1.5 text-xs text-ink-700">
          This line: <b>{describe(entries, unit)}</b>
        </div>
      )}
    </div>
  );
}

/** A quantity cell that says how it is packed (2026-10-11).
 *
 *    1 Carton                ← the packs
 *    1,000 NOS               ← the quantity in the item's own base unit
 *    [Hierarchy ▾]           ← opens the full ladder of this line's hierarchy
 *
 *  `qty` is the quantity the line carries; without packs the cell is just that.
 *  The hierarchy is passed in when the screen already has it, else fetched for
 *  `itemId` only once the button is pressed. */
export function PackQty({ entries, qty, uom, hierarchy, hierarchies, itemId, align = "left",
                          className = "" }: {
  entries?: PackEntry[] | null;
  qty?: number | string | null;
  uom?: string | null;
  hierarchy?: PackHierarchy | null;
  /** Every hierarchy of the item, when the screen already holds them. */
  hierarchies?: PackHierarchy[] | null;
  itemId?: number | null;
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rows = (entries ?? []).filter((e) => num(e.qty) > 0);
  const packed = rows.some((e) => e.level > 0);
  const given = hierarchy ? [hierarchy] : hierarchies?.length ? hierarchies : null;
  const mine = given?.find((h) => h.name === hierarchyOf(rows)) ?? hierarchy ?? null;
  const base = qty != null && qty !== "" ? num(qty) : baseOf(rows);
  const canOpen = !!(given || itemId);
  const warnings = packWarnings(rows, mine, uom);
  const right = align === "right";
  return (
    <div className={`${right ? "text-right" : ""} ${className}`}>
      {packed ? (
        <div className={`flex ${right ? "justify-end" : ""}`}>
          <PackChips entries={rows} uom={uom} showHierarchy={false} showTotal={false} />
        </div>
      ) : null}
      <div className={packed ? "mt-0.5 text-xs text-muted tabular"
                             : "font-semibold text-ink tabular"}>
        {fmtQty(base)} <span className="text-xs font-normal text-muted">{uom ?? "units"}</span>
      </div>
      {warnings.length > 0 && (
        <div className={`mt-0.5 flex max-w-[16rem] items-start gap-1 whitespace-normal text-[11px] text-warn ${
          right ? "ml-auto text-left" : ""}`}>
          <AlertTriangle size={11} className="mt-0.5 shrink-0" aria-hidden />
          <span>{warnings[0]}</span>
        </div>
      )}
      {canOpen && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={open}
          className="mt-1 inline-flex min-h-7 items-center gap-1.5 rounded-lg border border-brand/20 bg-brand-050/60 px-2 py-0.5 text-[11px] font-semibold text-brand shadow-2xs transition-all hover:border-brand/40 hover:bg-brand-050 hover:shadow-xs"
        >
          <Layers size={12} className="text-brand" aria-hidden />
          <span>Hierarchy</span>
        </button>
      )}

      {open && (
        <Modal
          isOpen={open}
          onClose={() => setOpen(false)}
          size="lg"
          backdrop="blur"
          scrollBehavior="inside"
          classNames={{
            base: "rounded-3xl border border-line/80 shadow-2xl bg-content1 overflow-hidden",
            backdrop: "bg-black/50 backdrop-blur-sm",
          }}
        >
          <ModalContent>
            <div className="h-1.5 w-full bg-gradient-to-r from-brand via-violet-500 to-indigo-600" />
            <ModalHeader className="flex items-start justify-between gap-3 px-6 pb-2 pt-5">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-brand-050 text-brand ring-1 ring-brand/20">
                  <Layers className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-ink">
                    Packaging Hierarchy & Conversion Ladder
                  </h3>
                  <p className="text-xs text-muted">
                    Unit container definitions and multi-level packaging ratios
                  </p>
                </div>
              </div>
            </ModalHeader>
            <ModalBody className="px-6 py-4">
              <div className="space-y-3">
                {given
                  ? <Ladders list={given} rows={rows} uom={uom} packed={packed} />
                  : <FetchedLadders itemId={itemId!} rows={rows} uom={uom} packed={packed} />}
              </div>
            </ModalBody>
            <ModalFooter className="border-t border-line/70 px-6 py-3 bg-content2/30">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex min-h-9 items-center justify-center rounded-xl border border-line bg-content1 px-4 py-1.5 text-xs font-semibold text-ink shadow-xs transition hover:bg-content2"
              >
                Close
              </button>
            </ModalFooter>
          </ModalContent>
        </Modal>
      )}
    </div>
  );
}

/** The item's hierarchies, fetched only once somebody opens the panel — so a cell
 *  that is never opened costs nothing and needs no query client. */
function FetchedLadders({ itemId, rows, uom, packed }: {
  itemId: number; rows: PackEntry[]; uom?: string | null; packed: boolean;
}) {
  const fetched = usePackOptions([itemId]);
  if (fetched.isLoading) return <div className="text-xs text-muted">Loading the hierarchy…</div>;
  return <Ladders list={fetched.data?.[itemId] ?? []} rows={rows} uom={uom} packed={packed} />;
}

/** This line's hierarchy first (marked), then the item's others. */
function Ladders({ list, rows, uom, packed }: {
  list: PackHierarchy[]; rows: PackEntry[]; uom?: string | null; packed: boolean;
}) {
  const shown = list.filter((h) => h.levels.length > 1);
  if (!shown.length) return <div className="text-xs text-muted">This item has no pack levels.</div>;
  const mine = shown.find((h) => h.name === hierarchyOf(rows)) ?? null;
  return (
    <>
      {(mine ? [mine, ...shown.filter((h) => h !== mine)] : shown).map((h) => (
        <HierarchyLadder key={h.hierarchy_id ?? h.name} hierarchy={h} uom={uom}
                         current={h === mine && packed}
                         entries={h === mine ? rows : undefined} />
      ))}
    </>
  );
}

/** Pick one of an item's pack hierarchies via a premium dropdown (2026-10-21).
 *  Selecting a new hierarchy immediately fires `onChange`; the selected
 *  hierarchy's level-ladder is shown beneath the control as an animated detail
 *  card.  A locked picker shows the hierarchy in force, read-only. */
export function PackHierarchyPicker({ hierarchies, value, onChange, uom, orderedId,
                                      locked = false, label = "Pack hierarchy" }: {
  hierarchies: PackHierarchy[];
  value?: number | null;
  onChange?: (id: number) => void;
  uom?: string | null;
  /** The hierarchy the order asked for — badged "As ordered". */
  orderedId?: number | null;
  locked?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const list = locked ? hierarchies.filter((h) => h.hierarchy_id === value) : hierarchies;
  if (!list.length) return null;

  const selected = list.find((h) => h.hierarchy_id === value) ?? list[0];
  const isOrdered = orderedId != null && selected?.hierarchy_id === orderedId;
  const isDefault = selected?.is_default;

  const handleSelect = (h: PackHierarchy) => {
    setOpen(false);
    if (h.hierarchy_id && h.hierarchy_id !== value) onChange?.(h.hierarchy_id);
  };

  return (
    <div className="space-y-2">
      {/* ── Accessible radio options (for tests & keyboard/screen-readers) ── */}
      <div role="radiogroup" aria-label={label} className="sr-only">
        {list.map((h) => (
          <label key={h.hierarchy_id ?? h.name}>
            <input
              type="radio"
              role="radio"
              name="pack_hierarchy_picker_choice"
              aria-label={h.name}
              value={h.hierarchy_id ?? ""}
              checked={h.hierarchy_id === (selected?.hierarchy_id ?? value)}
              onChange={() => handleSelect(h)}
            />
            {h.name}
          </label>
        ))}
      </div>

      {/* ── Dropdown trigger ───────────────────────────────────────────── */}
      <div className="relative">
        <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-ink-700">
          {label}
        </label>

        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={label}
          disabled={locked}
          onClick={() => setOpen((v) => !v)}
          className={`group relative flex w-full min-h-11 items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left transition-all duration-150 ${
            locked
              ? "cursor-default border-line bg-neutral-bg"
              : open
              ? "border-brand bg-brand-050/60 ring-2 ring-brand/20 shadow-sm"
              : "border-line bg-content1 hover:border-brand/50 hover:bg-brand-050/30 hover:shadow-sm"
          }`}
        >
          {/* Left: icon + name + badges */}
          <span className="flex min-w-0 items-center gap-2">
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
              locked ? "bg-neutral-bg text-muted" : "bg-brand-050 text-brand"
            }`}>
              {locked ? <Lock size={13} aria-hidden /> : <Layers size={13} aria-hidden />}
            </span>
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="truncate text-sm font-semibold text-ink">
                  {selected?.name ?? "Select a hierarchy"}
                </span>
                {isOrdered && (
                  <span className="shrink-0 rounded-full bg-ok-bg px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-ok">
                    As ordered
                  </span>
                )}
                {isDefault && !isOrdered && (
                  <span className="shrink-0 rounded-full bg-brand-050 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-brand-600">
                    Default
                  </span>
                )}
              </span>
              {selected && (
                <span className="block truncate text-[11px] text-muted tabular">
                  {ladderCaption(selected, uom)}
                </span>
              )}
            </span>
          </span>

          {/* Right: chevron */}
          {!locked && (
            <ChevronDown
              size={15}
              aria-hidden
              className={`shrink-0 text-muted transition-transform duration-200 ${open ? "rotate-180 text-brand" : ""}`}
            />
          )}
        </button>

        {/* ── Dropdown panel ──────────────────────────────────────────────── */}
        {open && !locked && (
          <>
            {/* Backdrop — click-away */}
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />

            <ul
              role="listbox"
              aria-label={label}
              className="absolute left-0 right-0 z-20 mt-1.5 max-h-72 overflow-y-auto rounded-2xl border border-brand/20 bg-content1 py-1.5 shadow-xl ring-1 ring-black/5 animate-in fade-in slide-in-from-top-1 duration-150"
            >
              {list.map((h) => {
                const sel = h.hierarchy_id === value;
                const ord = orderedId != null && h.hierarchy_id === orderedId;
                return (
                  <li key={h.hierarchy_id ?? h.name} role="option" aria-selected={sel}>
                    <button
                      type="button"
                      onClick={() => handleSelect(h)}
                      className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-100 ${
                        sel
                          ? "bg-brand-050 text-brand"
                          : "text-ink hover:bg-brand-050/50"
                      }`}
                    >
                      {/* Check / layer icon */}
                      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
                        sel ? "bg-brand text-white" : "bg-neutral-bg text-muted"
                      }`}>
                        {sel ? <Check size={12} aria-hidden /> : <Layers size={12} aria-hidden />}
                      </span>

                      {/* Name + caption + badges */}
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className={`truncate text-sm font-semibold ${sel ? "text-brand" : "text-ink"}`}>
                            {h.name}
                          </span>
                          {ord && (
                            <span className="shrink-0 rounded-full bg-ok-bg px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-ok">
                              As ordered
                            </span>
                          )}
                          {h.is_default && !ord && (
                            <span className="shrink-0 rounded-full bg-brand-050 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-brand-600">
                              Default
                            </span>
                          )}
                        </span>
                        <span className="block truncate text-[11px] text-muted tabular">
                          {ladderCaption(h, uom)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {/* ── Selected hierarchy level-ladder preview ─────────────────────── */}
      {selected && (
        <div className="rounded-xl border border-brand/20 bg-brand-050/30 px-3 py-2.5 space-y-1.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-brand-600">
            Hierarchy levels
          </span>
          <ol className="flex flex-wrap items-center gap-1.5 text-[11px]">
            {[...selected.levels]
              .filter((lv) => lv.level > 0)
              .sort((a, b) => a.level - b.level)
              .map((lv, i, arr) => (
                <li key={lv.level} className="flex items-center gap-1.5">
                  <span className="inline-flex items-center gap-1 rounded-lg border border-brand/20 bg-content1 px-2 py-0.5 font-semibold text-ink shadow-sm">
                    <Layers size={10} className="text-brand" aria-hidden />
                    {lv.name}
                    <span className="text-muted font-normal">
                      ({fmtQty(lv.size)} {uom ?? selected.base_uom ?? "units"})
                    </span>
                  </span>
                  {i < arr.length - 1 && (
                    <ChevronDown size={11} className="shrink-0 -rotate-90 text-muted" aria-hidden />
                  )}
                </li>
              ))}
          </ol>
        </div>
      )}
    </div>
  );
}

interface EditorProps {
  hierarchy: PackHierarchy;
  value: PackEntry[] | null | undefined;
  onChange?: (entries: PackEntry[]) => void;
  /** The base quantity the packs must make. Omitted: the packs ARE the quantity. */
  target?: number | null;
  /** The most of each level allowed (what a supplier declared). */
  limits?: Record<number, number> | null;
  /** Below this level nothing can be chosen — a code cannot be split. */
  minLevel?: number;
  /** Why levels below `minLevel` are locked, for the tile. */
  minLevelReason?: string;
  allowLoose?: boolean;
  readOnly?: boolean;
  uom?: string | null;
  /** Offer "Fill with whole packs" when a target is set. */
  allowAutoFill?: boolean;
  /** Only these levels (a declared packing limits the gate to what was sent). */
  onlyLevels?: number[];
  /** Offer part packs ("1 Carton (500 of 600)"). On by default. */
  allowPartial?: boolean;
  /** Refuse a part pack under its level's minimum here (where packs are MADE). The
   *  server refuses it too; this only says so before the press. */
  enforceMin?: boolean;
}

/** How many of each level — one tile per level for FULL packs, biggest first, and
 *  any PART packs listed underneath with what each holds, all adding up live. */
export function PackBreakdownEditor({
  hierarchy, value, onChange, target, limits, minLevel = 0, minLevelReason,
  allowLoose = true, readOnly = false, uom, allowAutoFill = true, onlyLevels,
  allowPartial = true, enforceMin = false,
}: EditorProps) {
  const counts = useMemo(() => fullCountsOf(value), [value]);
  const parts = useMemo(() => (value ?? []).filter(isPartial), [value]);
  const unit = uom ?? hierarchy.base_uom ?? "units";
  const levels = [...hierarchy.levels]
    .filter((lv) => (lv.level > 0 || allowLoose)
      && (!onlyLevels || onlyLevels.includes(lv.level)))
    .sort((a, b) => b.level - a.level);
  const packLevels = levels.filter((lv) => lv.level > 0 && lv.level >= minLevel);
  const total = baseOf(value);
  const state = matchState(value, target);
  const warnings = packWarnings(value, hierarchy, unit);
  const partsAt = (level: number) =>
    parts.filter((e) => e.level === level).reduce((sum, e) => sum + num(e.qty), 0);

  const emit = (full: Record<number, number>, partList: PackEntry[]) => {
    if (!onChange) return;
    onChange([...entriesFrom(hierarchy, full), ...partList.filter((e) => num(e.qty) > 0)]
      .sort((a, b) => b.level - a.level || heldOf(b) - heldOf(a)));
  };
  const set = (level: number, qty: number) => {
    const cap = limits?.[level];
    let next = Math.max(0, level === 0 ? Math.round(qty * 1000) / 1000 : Math.floor(qty));
    if (cap !== undefined && cap !== null) next = Math.min(next, Math.max(0, cap - partsAt(level)));
    emit({ ...counts, [level]: next }, parts);
  };
  const setPart = (index: number, patch: Partial<PackEntry>) => {
    const next = parts.map((e, i) => {
      if (i !== index) return e;
      const merged = { ...e, ...patch };
      const lv = hierarchy.levels[merged.level];
      return { ...merged, name: lv?.name, size: lv?.size, item_packaging_id: lv?.item_packaging_id,
               fill: Math.max(0, Math.min(num(merged.fill), num(lv?.size))) };
    });
    emit(counts, next);
  };
  const addPart = () => {
    const level = packLevels[0]?.level;
    if (level == null) return;
    const size = hierarchy.levels[level].size;
    const short = target != null ? Math.max(0, num(target) - total) : 0;
    const fill = short > 0 && short < size ? short : Math.max(1, Math.floor(size / 2));
    emit(counts, [...parts, partEntry(hierarchy, level, fill)]);
  };
  const removePart = (index: number) => emit(counts, parts.filter((_, i) => i !== index));

  return (
    <div className="space-y-2">
      <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
        {levels.map((lv) => {
          const qty = num(counts[lv.level]);
          const lockedOut = lv.level < minLevel;
          const cap = limits?.[lv.level];
          const disabled = readOnly || lockedOut;
          return (
            <div key={lv.level}
                 className={`rounded-xl border p-2.5 ${qty > 0
                   ? "border-brand/50 bg-brand-050/60" : "border-line bg-content1"} ${
                   lockedOut ? "opacity-60" : ""}`}>
              <div className="flex items-center justify-between gap-1">
                <span className="text-[11px] font-bold uppercase tracking-wider text-ink-700">
                  {lv.level === 0 ? `${LOOSE} ${unit}` : lv.name}
                </span>
                {lockedOut && <Lock size={12} className="text-muted" aria-label="Locked" />}
              </div>
              <div className="mb-2 text-[11px] text-muted tabular">
                {lv.level === 0 ? "outside any pack" : `1 = ${fmtQty(lv.size)} ${unit}`}
                {lv.level > 0 && num(lv.min_fill) > 0 && ` · min ${fmtQty(lv.min_fill)}`}
              </div>
              {readOnly ? (
                <div className="text-lg font-bold text-ink tabular">{fmtQty(qty)}</div>
              ) : (
                <div className="flex items-center gap-1">
                  <StepButton label={`One fewer ${lv.name}`} disabled={disabled || qty <= 0}
                              onClick={() => set(lv.level, qty - 1)}>
                    <Minus size={14} />
                  </StepButton>
                  <input
                    type="number" inputMode={lv.level === 0 ? "decimal" : "numeric"}
                    min={0} step={lv.level === 0 ? "any" : 1}
                    aria-label={`${lv.level === 0 ? "Loose" : lv.name} count`}
                    disabled={disabled}
                    value={qty === 0 ? "" : qty}
                    placeholder="0"
                    onChange={(e) => set(lv.level, num(e.target.value))}
                    className="h-11 w-full min-w-0 rounded-lg border border-line bg-content1 px-1 text-center text-base font-semibold text-ink tabular outline-none focus:border-brand focus:ring-2 focus:ring-brand/30 disabled:bg-neutral-bg"
                  />
                  <StepButton label={`One more ${lv.name}`}
                              disabled={disabled || (cap != null && qty + partsAt(lv.level) >= cap)}
                              onClick={() => set(lv.level, qty + 1)}>
                    <Plus size={14} />
                  </StepButton>
                </div>
              )}
              {cap != null && (
                // The tile counts FULL packs; part packs of the level are listed below,
                // so "of 3 sent" over 1 full + 2 part cartons read as three full ones.
                <div className="mt-1 text-[11px] text-muted tabular">
                  of {fmtQty(Math.max(0, cap - partsAt(lv.level)))} sent
                  {partsAt(lv.level) > 0 && ` · +${fmtQty(partsAt(lv.level))} part`}
                </div>
              )}
              {lockedOut && minLevelReason && (
                <div className="mt-1 text-[11px] text-muted">{minLevelReason}</div>
              )}
            </div>
          );
        })}
      </div>

      {allowPartial && packLevels.length > 0 && (parts.length > 0 || !readOnly) && (
        <div className="space-y-1.5 rounded-xl border border-dashed border-line p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-ink-700">
              Part packs <span className="font-medium normal-case tracking-normal text-muted">— a pack holding less than its size</span>
            </span>
            {!readOnly && onChange && (
              <button type="button" onClick={addPart}
                      className="inline-flex min-h-9 items-center gap-1 rounded-md border border-line px-2 text-xs font-semibold text-brand hover:border-brand">
                <Plus size={12} aria-hidden /> Add part pack
              </button>
            )}
          </div>
          {parts.length === 0 && (
            <div className="text-[11px] text-muted">
              None. A carton of {fmtQty(packLevels[0]?.size)} holding less goes here — e.g. 1 {packLevels[0]?.name} holding 500.
            </div>
          )}
          {parts.map((e, index) => {
            const lv = hierarchy.levels[e.level];
            const floor = num(lv?.min_fill);
            const low = floor > 0 && heldOf(e) < floor;
            return (
              <div key={index}
                   className={`flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                     low ? "bg-warn-bg/60" : "bg-content2/40"}`}>
                {readOnly ? (
                  <span className="font-semibold text-ink tabular">
                    {fmtQty(e.qty)} {e.name} holding {fmtQty(e.fill)} of {fmtQty(e.size)} {unit}
                  </span>
                ) : (
                  <>
                    <input type="number" min={1} step={1} aria-label="How many part packs"
                           value={num(e.qty) || ""}
                           onChange={(ev) => setPart(index, { qty: Math.max(0, Math.floor(num(ev.target.value))) })}
                           className="h-10 w-16 rounded-lg border border-line bg-content1 px-1 text-center font-semibold tabular" />
                    <select aria-label="Part pack level" value={e.level}
                            onChange={(ev) => setPart(index, { level: Number(ev.target.value) })}
                            className="h-10 rounded-lg border border-line bg-content1 px-2 text-sm">
                      {packLevels.map((p) => <option key={p.level} value={p.level}>{p.name}</option>)}
                    </select>
                    <span className="text-xs text-muted">holding</span>
                    <input type="number" min={0} step="any" aria-label="Each holds"
                           value={num(e.fill) || ""}
                           onChange={(ev) => setPart(index, { fill: num(ev.target.value) })}
                           className="h-10 w-24 rounded-lg border border-line bg-content1 px-1 text-center font-semibold tabular" />
                    <span className="text-xs text-muted tabular">of {fmtQty(lv?.size)} {unit}</span>
                    <button type="button" aria-label="Remove part pack" onClick={() => removePart(index)}
                            className="ml-auto flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:text-bad">
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
                {low && (
                  <span className="w-full text-[11px] text-warn">
                    Below the {fmtQty(floor)} {unit} minimum{enforceMin ? " — a new pack cannot be made this small." : " — allowed, but flagged until it is repacked."}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className={`flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm ${
        state.state === "match" ? "bg-ok-bg text-ok"
          : state.state === "free" ? "bg-neutral-bg text-ink-700"
            : state.state === "short" ? "bg-warn-bg text-warn" : "bg-bad-bg text-bad"}`}
           role="status" aria-live="polite">
        <span className="font-medium tabular">
          {total > 0 ? describe(value, unit) : `Nothing packed yet`}
        </span>
        <span className="flex flex-wrap items-center gap-2 font-semibold tabular">
          {state.state === "match" && <><Check size={14} aria-hidden /> Adds up to {fmtQty(target)} {unit}</>}
          {state.state === "short" && <>Short by {fmtQty(state.gap)} {unit}</>}
          {state.state === "over" && <>Over by {fmtQty(state.gap)} {unit}</>}
          {state.state === "free" && <>Total {fmtQty(total)} {unit}</>}
          {allowAutoFill && !readOnly && onChange && target != null && state.state !== "match"
            && !limits && (
            <>
              <button type="button"
                      onClick={() => onChange(greedy(hierarchy, num(target)))}
                      className="inline-flex min-h-9 items-center gap-1 rounded-md border border-current px-2 text-xs font-semibold">
                <Wand2 size={12} aria-hidden /> Fill with whole packs
              </button>
              {allowPartial && (
                <button type="button"
                        onClick={() => onChange(greedyWithPart(hierarchy, num(target)))}
                        className="inline-flex min-h-9 items-center gap-1 rounded-md border border-current px-2 text-xs font-semibold">
                  <Package size={12} aria-hidden /> Remainder as a part pack
                </button>
              )}
            </>
          )}
        </span>
      </div>
      {warnings.length > 0 && (
        <ul className="space-y-0.5 text-[11px] text-warn">
          {warnings.map((w) => (
            <li key={w} className="flex items-start gap-1">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" aria-hidden /> {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StepButton({ children, label, onClick, disabled }: {
  children: React.ReactNode; label: string; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button type="button" aria-label={label} onClick={onClick} disabled={disabled}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-line bg-content1 text-ink-700 transition hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-40">
      {children}
    </button>
  );
}
