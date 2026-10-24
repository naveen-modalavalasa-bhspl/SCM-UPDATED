import { useEffect, useState } from "react";
import { Boxes, Layers, Package } from "lucide-react";
import {
  PackBreakdownEditor, PackHierarchyPicker, PackQty, baseOf, canRepackAtIssue, greedy,
  greedyIn, num, usageLevels, type PackEntry, type PackHierarchy,
} from "@/shared/packing";

/** A quantity in the ladder's Issue containers, else biggest packs (2026-10-23). */
const issuePacks = (h: PackHierarchy, qty: number): PackEntry[] => {
  const levels = usageLevels(h, "ISSUE");
  return levels ? greedyIn(h, qty, levels) : greedy(h, qty);
};
import type { IssueItemWrite } from "../types";
import { ModalCancel, ModalConfirm, PackBalance, PackModal, PackSection } from "./PackModal";

/**
 * The packs a pick leaves in (2026-10-22).
 *
 * The ISSUE QUANTITY is in the item's base unit and is the only number that decides
 * anything: stock, codes (one per base unit) and every check. The packs DESCRIBE it —
 * "15 NOS = 1 Box + 5 loose" — and travel with the pick onto the consignment, outward
 * QC, the dispatch and the acknowledgement, so every desk downstream sees the same
 * cartons. They follow the quantity, never the other way round: "Change packing"
 * changes the mix, not the total.
 *
 * Codes belong to units, so there is no coded pack and no break bulk.
 */
export function IssuePickPacking({ line, hierarchies, locked, uom, onChange, splitting = false }: {
  line: IssueItemWrite;
  hierarchies: PackHierarchy[];
  locked: boolean;
  uom?: string | null;
  onChange: (patch: Partial<IssueItemWrite>) => void;
  /** The consignment: packs may always be split into smaller ones of the same
   *  ladder there, whatever the item's usages (2026-10-23). */
  splitting?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hierarchy = hierarchies.find((h) => h.hierarchy_id === line.pack_hierarchy_id)
    ?? hierarchies[0];
  const qty = num(line.issued_qty);
  const packs = line.pack_breakdown ?? null;
  const inStep = !!packs?.length && Math.abs(baseOf(packs) - qty) < 1e-6;

  // Keep the packs saying what the quantity says, in the line's own hierarchy.
  useEffect(() => {
    if (locked || !hierarchy) return;
    if (qty <= 0) {
      if (packs?.length) onChange({ pack_breakdown: null });
      return;
    }
    if (!inStep) {
      onChange({ pack_hierarchy_id: hierarchy.hierarchy_id, pack_breakdown: issuePacks(hierarchy, qty) });
    }
  }, [qty, hierarchy?.hierarchy_id, inStep, locked]);  // eslint-disable-line react-hooks/exhaustive-deps

  if (!hierarchy) return null;
  const unit = uom ?? hierarchy.base_uom ?? "units";

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 border-t border-line/50 pt-1.5 text-xs">
      <span className="font-semibold uppercase tracking-wider text-ink-700">Packs</span>
      {qty > 0 && packs?.length
        ? <PackQty entries={packs} qty={qty} uom={unit} hierarchies={hierarchies} />
        : <span className="text-muted">—</span>}
      {!locked && qty > 0 && (splitting || canRepackAtIssue(hierarchy)) && (
        <button type="button" onClick={() => setOpen(true)}
                className="group inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-brand/25 bg-brand-050/60 px-2.5 py-1 font-semibold text-brand transition-all hover:border-brand hover:bg-brand hover:text-white active:scale-95">
          <Boxes className="h-3.5 w-3.5 transition-transform group-hover:scale-110" aria-hidden />
          Change packing
        </button>
      )}
      {open && (
        <ChangePacking hierarchies={hierarchies} hierarchy={hierarchy} packs={packs} qty={qty}
                       splitting={splitting}
                       unit={unit} itemLabel={line.item_name ?? line.item_code ?? "Item"}
                       batch={line.batch_no} onClose={() => setOpen(false)}
                       onApply={(hid, next) => {
                         onChange({ pack_hierarchy_id: hid, pack_breakdown: next });
                         setOpen(false);
                       }} />
      )}
    </div>
  );
}

function ChangePacking({ hierarchies, hierarchy, packs, qty, unit, itemLabel, batch, onClose, onApply,
                         splitting = false }: {
  splitting?: boolean;
  hierarchies: PackHierarchy[];
  hierarchy: PackHierarchy;
  packs: PackEntry[] | null;
  qty: number;
  unit: string;
  itemLabel: string;
  batch?: string | null;
  onClose: () => void;
  onApply: (hierarchyId: number, packs: PackEntry[]) => void;
}) {
  const [hid, setHid] = useState(hierarchy.hierarchy_id);
  const [draft, setDraft] = useState<PackEntry[] | null>(packs ?? issuePacks(hierarchy, qty));
  // Issue containers mapped: the ladder is the stock's, and only its levels change.
  const ladderFixed = !!usageLevels(hierarchy, "ISSUE");
  const current = hierarchies.find((h) => h.hierarchy_id === hid) ?? hierarchy;
  const packed = baseOf(draft);
  return (
    <PackModal
      title="Change packing"
      subtitle={<><span className="font-semibold text-ink">{itemLabel}</span>{batch ? ` · Batch ${batch}` : ""}</>}
      badge={
        <span className="shrink-0 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-700 ring-1 ring-emerald-200">
          {qty.toLocaleString("en-IN")} {unit}
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <ModalCancel onClick={onClose} />
          <ModalConfirm onClick={() => draft && onApply(current.hierarchy_id!, draft)}
                        disabled={!draft || Math.abs(packed - qty) > 1e-6}>
            Apply
          </ModalConfirm>
        </>
      }
    >
      {hierarchies.length > 1 && !ladderFixed && (
        <PackSection n={1} title="Hierarchy" icon={<Layers className="h-4 w-4 text-brand" />}>
          <PackHierarchyPicker hierarchies={hierarchies} value={current.hierarchy_id} uom={unit}
                               onChange={(id) => {
                                 const next = hierarchies.find((h) => h.hierarchy_id === id);
                                 if (!next) return;
                                 setHid(id);
                                 setDraft(issuePacks(next, qty));
                               }} />
        </PackSection>
      )}
      <PackSection n={hierarchies.length > 1 && !ladderFixed ? 2 : 1} title="Packs"
                   icon={<Package className="h-4 w-4 text-brand" />}>
        <PackBreakdownEditor usage={splitting ? undefined : "ISSUE"} hierarchy={current}
                             value={draft} target={qty} uom={unit}
                             onChange={setDraft} />
      </PackSection>
      <PackBalance packed={packed} target={qty} uom={unit} />
    </PackModal>
  );
}
