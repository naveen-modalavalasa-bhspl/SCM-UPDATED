import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Boxes, Check, X } from "lucide-react";
import { Can, ErrorBanner, useToast } from "@/shared/components";
import {
  PackBreakdownEditor, PackChips, PackHierarchyPicker, baseOf, fmtQty, greedy, packable,
  toPayload, usePackOptions, type PackEntry, type PackHierarchy,
} from "@/shared/packing";
import { Button } from "./ActionButton";
import { poApi } from "../api";
import type { POItem } from "../types";

/** Where an order's packing can no longer move: goods are in, or it is over. */
const CLOSED = new Set(["PARTIALLY_RECEIVED", "RECEIVED", "CLOSED", "CANCELLED", "REJECTED"]);

/**
 * A PO line's packing, with the means to change it (2026-10-08): the hierarchy, the
 * levels and how many of each.
 *
 * Packing DESCRIBES the ordered quantity and never changes it — at any status, draft
 * included. Picking another hierarchy re-packs the same quantity, and the screen says
 * how many packs of each level that quantity needs. Changing what is bought is the
 * quantity field (or an amendment), never this. The server holds the same rule
 * (`repack_po_line`); this only says it before the press.
 */
export function POLinePacking({ poId, poStatus, line, showChips = true }: {
  poId: number; poStatus: string; line: POItem;
  /** Off where the quantity cell already shows the packs (`PackQty`). */
  showChips?: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const options = usePackOptions([line.item_id]);
  const hierarchies = packable(options.data?.[line.item_id]);
  const [open, setOpen] = useState(false);
  const [hierarchyId, setHierarchyId] = useState<number | null>(null);
  const [packs, setPacks] = useState<PackEntry[] | null>(null);

  const hierarchy = hierarchies.find((h) => h.hierarchy_id === hierarchyId) ?? hierarchies[0];
  const save = useMutation({
    mutationFn: () => poApi.repackLine(poId, line.id, {
      pack_hierarchy_id: hierarchy!.hierarchy_id!, pack_breakdown: toPayload(packs),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-order", poId] });
      toast.success("Packing changed.");
      setOpen(false);
    },
  });

  const start = () => {
    const current = hierarchies.find((h) => h.hierarchy_id === line.pack_hierarchy_id)
      ?? hierarchies[0];
    setHierarchyId(current?.hierarchy_id ?? null);
    setPacks(line.pack_breakdown?.length && current?.hierarchy_id === line.pack_hierarchy_id
      ? line.pack_breakdown : current ? greedy(current, Number(line.quantity)) : null);
    setOpen(true);
  };

  const chips = !showChips ? null : line.pack_breakdown?.length
    ? <PackChips entries={line.pack_breakdown} uom={line.uom_code} />
    : <span className="text-xs text-muted">Not packed</span>;
  if (!hierarchies.length || CLOSED.has(poStatus)) {
    return line.pack_breakdown?.length && chips ? <div className="mt-1">{chips}</div> : null;
  }

  const ordered = Number(line.quantity);
  const matches = baseOf(packs) === ordered;
  return (
    <div className="mt-1 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {chips}
        {!open && (
          <Can do="po.edit">
            <button type="button" onClick={start}
                    className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-xs font-semibold text-brand hover:bg-brand-050">
              <Boxes className="h-3.5 w-3.5" aria-hidden /> Change packing
            </button>
          </Can>
        )}
      </div>
      {open && hierarchy && (
        <div className="space-y-2 rounded-xl border border-brand/30 bg-brand-050/40 p-3">
          <PackHierarchyPicker
            hierarchies={hierarchies} value={hierarchy.hierarchy_id} uom={line.uom_code}
            onChange={(id) => {
              const next = hierarchies.find((h) => h.hierarchy_id === id);
              if (!next) return;
              setHierarchyId(id);
              setPacks(greedy(next, ordered));
            }}
          />
          <PackBreakdownEditor
            hierarchy={hierarchy} value={packs} uom={line.uom_code}
            target={ordered} enforceMin
            onChange={setPacks}
          />
          <PacksNeeded hierarchy={hierarchy} qty={ordered} uom={line.uom_code} />
          <p className="text-xs text-muted">
            {`The ordered quantity stays ${fmtQty(ordered)} ${line.uom_code ?? ""} — packing only says how it is packed. To buy more or less, change the quantity${poStatus === "DRAFT" ? " on the order" : " by amending the order"}.`}
          </p>
          <ErrorBanner error={save.error} />
          <div className="flex flex-wrap gap-2">
            <Button disabled={!matches || save.isPending} onClick={() => save.mutate()}>
              <Check className="h-4 w-4" /> Save packing
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              <X className="h-4 w-4" /> Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * How many of each pack the ordered quantity needs in this hierarchy, rounded UP to
 * whole packs — "500 NOS needs 2 Pack (450 each) · 1 Carton (6,750 each)".
 */
function PacksNeeded({ hierarchy, qty, uom }: {
  hierarchy: PackHierarchy; qty: number; uom?: string | null;
}) {
  const levels = hierarchy.levels.filter((lv) => lv.level > 0 && Number(lv.size) > 0)
    .sort((a, b) => a.level - b.level);
  if (!levels.length || qty <= 0) return null;
  const unit = uom ?? hierarchy.base_uom ?? "units";
  return (
    <div className="rounded-lg border border-line bg-content1 px-3 py-2 text-xs text-ink-700">
      <span className="font-semibold">{fmtQty(qty)} {unit} needs</span>{" "}
      {levels.map((lv, i) => (
        <span key={lv.level} className="tabular">
          {i > 0 && " · "}
          <b>{fmtQty(Math.ceil(qty / Number(lv.size)))} {lv.name}</b>{" "}
          ({fmtQty(lv.size)} {unit} each)
        </span>
      ))}
    </div>
  );
}
