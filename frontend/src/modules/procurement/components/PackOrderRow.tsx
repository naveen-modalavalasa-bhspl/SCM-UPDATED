import { Package, X } from "lucide-react";
import { Field, Select } from "@/shared/components";
import {
  type PackEntry, type PackHierarchy, PackChips, PackHierarchyPicker, fmtQty,
  greedyWithPart, greedyWithPartFor, laddersForUsage, levelsFor, num,
} from "@/shared/packing";

/** The levels a PO may be packed in: the item's Purchase containers (2026-10-23), or
 *  every pack level when none are mapped. */
export function purchaseLevels(h: PackHierarchy): number[] {
  const all = h.levels.filter((lv) => lv.level > 0).map((lv) => lv.level);
  if (h.unmapped_usages?.includes("PURCHASE")) return all;
  const mapped = levelsFor(h, "PURCHASE").map((lv) => lv.level).filter((lv) => lv > 0);
  return mapped.length ? mapped : all;
}

/** The level a new PO line opens on: the biggest purchase container. */
const openingLevel = (h: PackHierarchy) => Math.max(...purchaseLevels(h), 0) || h.levels.length - 1;

/** The packing of `qty` base units in level `level` of `h`: whole packs of that level
 *  and the remainder as ONE part pack of it (2026-10-11) — "1,000 NOS in Carton of
 *  600 = 1 Carton + 1 Carton (400 of 600)". The quantity is never changed by it. */
export function packFor(h: PackHierarchy, level: number, qty: number): PackEntry[] {
  if (!(qty > 0)) return [];
  // A level that is not one of the item's Purchase containers is never packed in
  // (2026-10-27): the line is said in those containers instead.
  return purchaseLevels(h).includes(level)
    ? greedyWithPart(h, qty, level) : greedyWithPartFor(h, qty, "PURCHASE");
}

/** The level a breakdown is described in: its biggest pack. */
export function levelOf(h: PackHierarchy | undefined, breakdown?: PackEntry[] | null): number {
  const top = Math.max(0, ...(breakdown ?? []).filter((e) => e.level > 0).map((e) => e.level));
  return top || (h ? openingLevel(h) : 1);
}

/**
 * How a PO line is to be PACKED (2026-10-08, reworked 2026-10-11): the hierarchy
 * ("Strip of 10") and the level the supplier should send ("Box · 10 Strip (100 TAB)").
 *
 * The QUANTITY is the line's, typed in its own box — choosing a hierarchy or a level
 * only describes it, and never changes it. The row says how many packs that quantity
 * needs: whole packs of the level, and what is left over as one part pack of it
 * ("1 Carton (400 of 600)"). The supplier sees this on the portal and despatches in it.
 *
 * Off ("Order loose") the line is a plain quantity, and the server still describes it
 * in the item's default hierarchy so the supplier is told something sensible.
 */
export function PackOrderRow({ hierarchies: allHierarchies, hierarchyId, breakdown, quantity, uom, disabled,
                               onChange }: {
  hierarchies: PackHierarchy[];
  hierarchyId?: number | null;
  breakdown?: PackEntry[] | null;
  /** The line's quantity in base units — what the packs describe. */
  quantity: string | number;
  uom?: string | null;
  disabled?: boolean;
  onChange: (patch: { pack_hierarchy_id: number | null;
                      pack_breakdown: PackEntry[] | null }) => void;
}) {
  // A ladder with none of the item's Purchase containers is no way to buy it
  // (2026-10-27); the one the line already names always stays.
  const hierarchies = laddersForUsage(allHierarchies, "PURCHASE", hierarchyId);
  const hierarchy = hierarchies.find((h) => h.hierarchy_id === hierarchyId);
  const qty = num(quantity);
  const levelNo = levelOf(hierarchy, breakdown);
  const level = hierarchy?.levels.find((lv) => lv.level === levelNo)
    ?? hierarchy?.levels[hierarchy.levels.length - 1];

  const choose = (h: PackHierarchy, nextLevel: number) => {
    const lv = h.levels.find((row) => row.level === nextLevel) ?? h.levels[h.levels.length - 1];
    onChange({ pack_hierarchy_id: h.hierarchy_id, pack_breakdown: packFor(h, lv.level, qty) });
  };

  if (!hierarchy) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-line px-3 py-2">
        <Package size={14} className="text-muted" aria-hidden />
        <span className="text-sm text-muted">Ordered loose, in {uom ?? "units"}.</span>
        {!disabled && hierarchies.map((h) => (
          <button key={h.hierarchy_id} type="button"
                  onClick={() => choose(h, openingLevel(h))}
                  className="min-h-9 rounded-lg border border-line px-2.5 text-xs font-semibold text-brand hover:bg-brand-050">
            Order in {h.name}
          </button>
        ))}
      </div>
    );
  }

  const size = num(level?.size);
  const needed = size > 0 ? Math.ceil(qty / size) : 0;
  return (
    <div className="space-y-2 rounded-lg border border-brand/30 bg-brand-050/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-bold uppercase tracking-wider text-ink-700">
          Packing the supplier should send
        </span>
        {!disabled && (
          <button type="button"
                  onClick={() => onChange({ pack_hierarchy_id: null, pack_breakdown: null })}
                  className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-xs font-semibold text-muted hover:text-bad">
            <X size={12} aria-hidden /> Order loose instead
          </button>
        )}
      </div>
      <PackHierarchyPicker hierarchies={hierarchies} value={hierarchy.hierarchy_id} uom={uom}
                           locked={disabled}
                           onChange={(id) => {
                             const next = hierarchies.find((h) => h.hierarchy_id === id);
                             if (next) choose(next, purchaseLevels(next).includes(levelNo)
                               ? levelNo : openingLevel(next));
                           }} />
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:items-end">
        <Field label="Pack level">
          <Select
            value={level?.level ?? ""}
            isDisabled={disabled}
            ariaLabel="Pack level"
            options={hierarchy.levels
              .filter((lv) => purchaseLevels(hierarchy).includes(lv.level) || lv.level === levelNo)
              .map((lv) => ({ value: lv.level, label: lv.label }))}
            onChange={(value) => choose(hierarchy, Number(value))}
          />
        </Field>
        <div className="space-y-1 pb-1 text-sm" role="status" aria-live="polite">
          {qty > 0 ? (
            <>
              <div className="flex flex-wrap items-center gap-1.5 font-semibold text-ink tabular">
                {fmtQty(qty)} {uom ?? "units"} =
                <PackChips entries={breakdown} uom={uom} showHierarchy={false} showTotal={false} />
              </div>
              <div className="text-xs text-muted tabular">
                {fmtQty(needed)} × {level?.name ?? "pack"} ({fmtQty(size)} {uom ?? "units"} each)
              </div>
            </>
          ) : (
            <div className="text-xs text-muted">Type the quantity — the packs needed show here.</div>
          )}
        </div>
      </div>
    </div>
  );
}
