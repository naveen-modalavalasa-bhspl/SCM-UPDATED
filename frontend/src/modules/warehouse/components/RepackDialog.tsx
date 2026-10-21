import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight, Lock, Package, Tag } from "lucide-react";
import { ConfirmModal, Field, Textarea, useToast } from "@/shared/components";
import {
  PackBreakdownEditor, PackChips, PackHierarchyPicker, baseOf, entriesFrom, fmtQty,
  partEntry, toPayload, type PackEntry,
} from "@/shared/packing";
import { lotPacks, repackLot } from "../api";
import type { LotPacks, ShelfPack } from "../types";

/**
 * Repack one stock row on the shelf (2026-10-08): twelve boxes into a carton, a carton
 * back into its boxes, loose strips boxed.
 *
 * Three things never change, and the dialog says so before the press rather than
 * after: the QUANTITY (the target must hold exactly what the row holds), the
 * HIERARCHY (a pack never changes family), and the CODED FLOOR — a pack coded at
 * putaway can be wrapped in a bigger one, but never split below its own level here.
 * That only happens at the issue desk, as a break bulk, under its own permission.
 *
 * PART packs (2026-10-11) — a carton an issue left holding 350 of 500 — are listed
 * with what they hold, amber when under their level's minimum. The target starts as
 * the shelf is, so a part pack stays exactly as it is unless the storekeeper removes
 * it from the list (it then opens: its contents go to smaller packs or loose).
 */
export function RepackDialog({ stockId, onClose, onDone }: {
  stockId: number; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const lot = useQuery({ queryKey: ["wh-lot-packs", stockId], queryFn: () => lotPacks(stockId) });
  const [hierarchyId, setHierarchyId] = useState<number | null>(null);
  const [target, setTarget] = useState<PackEntry[] | null>(null);
  const [reason, setReason] = useState("");

  const hierarchies = lot.data?.hierarchies ?? [];
  const current = hierarchies.find((h) => h.hierarchy_id === hierarchyId)
    ?? hierarchies.find((h) => h.in_use) ?? hierarchies[0];

  // What this hierarchy's packs plus every loose unit add up to — the target must
  // hold exactly that (packs of another hierarchy stay as they are).
  const pool = useMemo(() => {
    if (!current || !lot.data) return 0;
    const packed = current.levels.reduce(
      (sum, lv) => sum + (current.top_counts[String(lv.level)] ?? 0) * lv.size, 0);
    const parts = (current.top_parts ?? []).reduce((sum, p) => sum + p.fill, 0);
    return packed + parts + lot.data.loose_qty;
  }, [current, lot.data]);

  useEffect(() => {
    if (!current || !lot.data) return;
    // Part packs grouped by (level, fill), so two cartons of 350 read "2 Carton (350)".
    const parts = new Map<string, PackEntry>();
    for (const p of current.top_parts ?? []) {
      const key = `${p.level}:${p.fill}`;
      const seen = parts.get(key);
      if (seen) seen.qty = Number(seen.qty) + 1;
      else parts.set(key, partEntry(current, p.level, p.fill));
    }
    setTarget([
      ...entriesFrom(current, {
        ...Object.fromEntries(Object.entries(current.top_counts).map(([k, v]) => [Number(k), v])),
        0: lot.data.loose_qty,
      }),
      ...parts.values(),
    ]);
  }, [current?.hierarchy_id, lot.data]);  // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: () => repackLot(stockId, {
      pack_hierarchy_id: current!.hierarchy_id!, target: toPayload(target),
      reason: reason.trim() || null,
    }),
    onSuccess: (after: LotPacks) => {
      toast.success(`Repacked — now ${after.pack_text ?? "loose"}.`);
      onDone();
    },
  });

  const unit = lot.data?.uom_code ?? "units";
  const floor = current?.coded_floor ?? 0;
  const floorName = current?.levels.find((lv) => lv.level === floor)?.name;
  const totalOk = target ? Math.abs(baseOf(target) - pool) < 1e-6 : false;
  const lowCount = (current?.top_parts ?? []).filter((p) => p.below_min).length;

  return (
    <ConfirmModal
      isOpen
      title={lot.data ? `Repack ${lot.data.item_code ?? ""} ${lot.data.item_name ?? ""}`.trim() : "Repack"}
      message={lot.data
        ? `${lot.data.bin_code ?? "Bulk"}${lot.data.batch_no ? ` · batch ${lot.data.batch_no}` : ""} — ${fmtQty(lot.data.total_qty)} ${unit} on hand. The quantity never changes.`
        : "Loading…"}
      confirmLabel="Repack"
      busy={save.isPending}
      confirmDisabled={!current?.hierarchy_id || !target || !totalOk}
      error={save.error ?? lot.error}
      onConfirm={() => save.mutate()}
      onClose={onClose}
    >
      {lot.data && !current && (
        <p className="text-sm text-muted">
          This item has no pack levels. Add a pack hierarchy on the item master first.
        </p>
      )}
      {lot.data && current && (
        <div className="space-y-4">
          {hierarchies.length > 1 && (
            <PackHierarchyPicker hierarchies={hierarchies} value={current.hierarchy_id}
                                 uom={unit} onChange={setHierarchyId}
                                 locked={hierarchies.some((h) => h.in_use)} />
          )}

          {lowCount > 0 && (
            <p className="flex items-start gap-1.5 rounded-lg bg-warn-bg px-3 py-2 text-xs font-medium text-warn">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {lowCount} pack{lowCount === 1 ? " is" : "s are"} under the level's minimum. Remove
              {lowCount === 1 ? " it" : " them"} from "Part packs" below to open
              {lowCount === 1 ? " it" : " them"} into smaller packs or loose, or top up to the minimum.
            </p>
          )}

          <div>
            <div className="mb-1.5 text-xs font-bold uppercase tracking-wider text-ink-700">
              On the shelf now
            </div>
            {current.packs.length === 0 && lot.data.loose_qty === 0 ? (
              <p className="text-sm text-muted">Nothing packed in {current.name}.</p>
            ) : (
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-line p-2">
                {current.packs.map((pack) => <PackRow key={pack.id} pack={pack} unit={unit} />)}
                {lot.data.loose_qty > 0 && (
                  <div className="flex items-center gap-2 rounded-lg border border-dashed border-line px-2 py-1.5 text-sm text-ink-700">
                    {fmtQty(lot.data.loose_qty)} loose {unit}
                  </div>
                )}
              </div>
            )}
          </div>

          <div>
            <div className="mb-1.5 text-xs font-bold uppercase tracking-wider text-ink-700">
              Repack into
            </div>
            <PackBreakdownEditor
              hierarchy={current}
              value={target}
              target={pool}
              uom={unit}
              minLevel={floor}
              minLevelReason={floor > 0 ? `Coded as ${floorName} — a code can't be split` : undefined}
              onChange={setTarget}
            />
            {floor > 0 && (
              <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-info-bg px-3 py-2 text-xs text-info">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                These {floorName} packs carry their own codes. They can go into bigger
                packs (which get codes of their own) and come back out of them — never
                into anything smaller than a {floorName}.
              </p>
            )}
          </div>

          <Field label="Why (optional)">
            <Textarea value={reason} minRows={2} onChange={(e) => setReason(e.target.value)}
                      placeholder="e.g. Cartons consolidated for the monthly dispatch" />
          </Field>
          {target && <div className="text-xs text-muted">After: <PackChips entries={target} uom={unit} /></div>}
        </div>
      )}
    </ConfirmModal>
  );
}

function PackRow({ pack, unit, depth = 0 }: { pack: ShelfPack; unit: string; depth?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginLeft: depth * 16 }}>
      <button type="button" onClick={() => setOpen(!open)} disabled={!pack.contents.length}
              className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-content2 disabled:hover:bg-transparent">
        {pack.contents.length
          ? <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
          : <span className="w-3.5" />}
        {pack.below_min
          ? <AlertTriangle className="h-3.5 w-3.5 text-warn" aria-label="Below minimum" />
          : <Package className="h-3.5 w-3.5 text-brand" aria-hidden />}
        <span className="font-semibold text-ink">{pack.pack_name}</span>
        <span className={`text-xs tabular ${pack.below_min ? "font-semibold text-warn" : "text-muted"}`}>
          {pack.is_part
            ? `${fmtQty(pack.content_qty)} of ${fmtQty(pack.pack_size)} ${unit}`
            : `${fmtQty(pack.pack_size)} ${unit}`}
          {pack.below_min && pack.min_fill != null && ` · min ${fmtQty(pack.min_fill)}`}
        </span>
        <span className="ml-auto inline-flex items-center gap-1 font-mono text-[11px] text-ink-700">
          {pack.is_atom ? <Lock className="h-3 w-3" aria-label="Coded — cannot be split" />
            : <Tag className="h-3 w-3" aria-hidden />}
          {pack.hu_code}
        </span>
      </button>
      {open && pack.contents.map((kid) => (
        <PackRow key={kid.id} pack={kid} unit={unit} depth={depth + 1} />
      ))}
    </div>
  );
}
