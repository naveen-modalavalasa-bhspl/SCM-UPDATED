import { useState } from "react";
import { Boxes, PackageOpen } from "lucide-react";
import { Can } from "@/shared/components";
import {
  PackBreakdownEditor, PackHierarchyPicker, PackQty, baseOf, greedy, num,
  type PackEntry, type PackHierarchy,
} from "@/shared/packing";
import type { IssueItemWrite } from "../types";

/**
 * Issue in packs (2026-10-08): "2 Box + 5 Strip" instead of "25".
 *
 * The packs ARE the quantity — choosing them sets the pick's issue qty, exactly as
 * typing it would, and trims surplus identifiers the same way. For a serial / IMEI item
 * the identifiers are then picked against that many units, as before.
 *
 * A code-tracked item's packs carry ONE code each, so a pick that leaves part of a
 * coded pack behind is refused at save unless it says BREAK BULK — which opens the
 * pack, retires its code and gives what stays behind new codes. That needs its own
 * permission, so the switch is only drawn for people who hold it.
 */
export function IssuePickPacking({ line, hierarchies, codesPerPack, locked, uom, onChange }: {
  line: IssueItemWrite;
  hierarchies: PackHierarchy[];
  /** Asset / consumable codes: packs are coded, so a part pack is a break bulk. */
  codesPerPack: boolean;
  locked: boolean;
  uom?: string | null;
  onChange: (patch: Partial<IssueItemWrite>, qty?: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const hierarchy = hierarchies.find((h) => h.hierarchy_id === line.pack_hierarchy_id)
    ?? hierarchies[0];
  if (!hierarchy) return null;
  const packed = !!line.pack_breakdown?.length;

  const set = (packs: PackEntry[] | null, hierarchyId = hierarchy.hierarchy_id) => {
    onChange({ pack_hierarchy_id: packs ? hierarchyId : null, pack_breakdown: packs },
             packs ? baseOf(packs) : undefined);
  };

  return (
    <div className="mt-1.5 border-t border-line/50 pt-1.5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold uppercase tracking-wider text-ink-700">Issue as</span>
        {packed
          // The packs, the quantity in the item's own unit under them and the whole
          // hierarchy one press away (2026-10-11). A part carton picked here reads
          // "1 Carton (350/500)".
          ? <PackQty entries={line.pack_breakdown} qty={line.issued_qty} uom={uom}
                     hierarchies={hierarchies} />
          : <span className="text-muted">{num(line.issued_qty)} loose {uom ?? "units"}</span>}
        {!locked && (
          <button type="button" onClick={() => {
                    if (!open && !packed) set(greedy(hierarchy, num(line.issued_qty)));
                    setOpen(!open);
                  }}
                  className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 font-semibold text-brand hover:bg-brand-050">
            <Boxes className="h-3.5 w-3.5" aria-hidden />
            {open ? "Done" : packed ? "Change packs" : "Issue in packs"}
          </button>
        )}
        {!locked && packed && (
          <button type="button" onClick={() => { set(null); setOpen(false); }}
                  className="min-h-8 rounded-md px-2 text-muted hover:text-bad">
            Issue loose
          </button>
        )}
        {codesPerPack && (
          <Can do="issue.break_bulk">
            <label className={`ml-auto inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 ${
              line.break_bulk ? "bg-warn-bg text-warn" : "text-muted"}`}
                   title="Open a coded pack to issue part of it. Its code retires; what stays behind gets new codes.">
              <input type="checkbox" checked={!!line.break_bulk} disabled={locked}
                     onChange={(e) => onChange({ break_bulk: e.target.checked })} />
              <PackageOpen className="h-3.5 w-3.5" aria-hidden /> Break bulk
            </label>
          </Can>
        )}
      </div>
      {line.break_bulk && (
        <p className="mt-1 text-[11px] text-warn">
          A coded pack this pick takes part of will be opened: its code retires and the
          units left behind are packed again under new codes.
        </p>
      )}
      {open && !locked && (
        <div className="mt-2 space-y-2">
          {hierarchies.length > 1 && (
            <PackHierarchyPicker hierarchies={hierarchies} value={hierarchy.hierarchy_id}
                                 uom={uom}
                                 onChange={(id) => {
                                   const next = hierarchies.find((h) => h.hierarchy_id === id);
                                   if (next) set(greedy(next, num(line.issued_qty)), id);
                                 }} />
          )}
          <PackBreakdownEditor hierarchy={hierarchy} value={line.pack_breakdown} uom={uom}
                               onChange={(packs) => set(packs)} />
        </div>
      )}
    </div>
  );
}
