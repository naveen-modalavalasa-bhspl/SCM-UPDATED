import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight, Layers, Package, PackageOpen, Tag } from "lucide-react";
import { ErrorBanner, Textarea, useToast } from "@/shared/components";
import {
  PackBreakdownEditor, PackChips, baseOf, entriesFrom, fmtQty, partEntry, toPayload,
  type PackEntry,
} from "@/shared/packing";
import { lotPacks, repackLot } from "../api";
import type { LotPacks, ShelfPack } from "../types";
import { ModalCancel, ModalConfirm, PackBalance, PackModal, PackSection } from "./PackModal";

type LotHierarchy = LotPacks["hierarchies"][number];

/**
 * Repack one stock row on the shelf: twelve boxes into a carton, a carton back into
 * its boxes, loose strips boxed (2026-10-08).
 *
 * One lot may hold packs of SEVERAL hierarchies at once — "1 cartoon (Box of 20) +
 * 20 box (Box of 15)" (2026-10-22). Every one of them is shown, and any one can be
 * repacked; the others stay exactly as they are. A repack works inside the chosen
 * hierarchy, over its packs plus whatever is loose, and never changes the quantity.
 *
 * Codes belong to the units inside, never to a pack, so nothing here is locked: any
 * pack can be opened and any level chosen.
 */
export function RepackDialog({ stockId, onClose, onDone }: {
  stockId: number; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const lot = useQuery({ queryKey: ["wh-lot-packs", stockId], queryFn: () => lotPacks(stockId) });
  const [hierarchyId, setHierarchyId] = useState<number | null>(null);
  const [target, setTarget] = useState<PackEntry[] | null>(null);
  const [reason, setReason] = useState("");

  // The hierarchies with packs on this shelf first, then the rest of the item's.
  const hierarchies = useMemo(
    () => [...(lot.data?.hierarchies ?? [])].sort((a, b) => Number(b.in_use) - Number(a.in_use)),
    [lot.data]);
  const inUse = hierarchies.filter((h) => h.in_use);
  const current = hierarchies.find((h) => h.hierarchy_id === hierarchyId) ?? hierarchies[0];
  const loose = lot.data?.loose_qty ?? 0;

  // This hierarchy's packs plus everything loose — what the new packing must hold.
  const pool = useMemo(() => (current ? heldBy(current) + loose : 0), [current, loose]);

  // Start from the shelf as it is, so an untouched popup changes nothing.
  useEffect(() => {
    if (!current || !lot.data) return;
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
  const packed = baseOf(target);
  const totalOk = !!target && Math.abs(packed - pool) < 1e-6;
  const lowCount = (current?.top_parts ?? []).filter((p) => p.below_min).length;

  return (
    <PackModal
      title={lot.data ? `Repack ${lot.data.item_code ?? ""}`.trim() : "Repack"}
      subtitle={lot.data && (
        <>
          <span className="font-semibold text-ink">{lot.data.item_name}</span>
          {` · ${lot.data.bin_code ?? "Bulk"}`}
          {lot.data.batch_no ? ` · Batch ${lot.data.batch_no}` : ""}
        </>
      )}
      badge={lot.data && (
        <span className="shrink-0 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-700 ring-1 ring-emerald-200">
          {fmtQty(lot.data.total_qty)} {unit}
        </span>
      )}
      onClose={onClose}
      footer={
        <>
          <ModalCancel onClick={onClose} />
          <ModalConfirm onClick={() => save.mutate()} busy={save.isPending}
                        disabled={!current?.hierarchy_id || !target || !totalOk}>
            Repack
          </ModalConfirm>
        </>
      }
    >
      <ErrorBanner error={save.error ?? lot.error} />
      {lot.isLoading && <p className="text-sm text-muted">Loading…</p>}
      {lot.data && !current && (
        <p className="text-sm text-muted">This item has no pack levels.</p>
      )}
      {lot.data && current && (
        <>
          <PackSection n={1} title="On the shelf" icon={<Package className="h-4 w-4 text-brand" />}>
            <div className="space-y-2">
              {inUse.length === 0 && loose === 0 && (
                <p className="text-sm text-muted">Nothing packed.</p>
              )}
              {inUse.map((h) => <ShelfGroup key={h.hierarchy_id} hierarchy={h} unit={unit} />)}
              {loose > 0 && (
                <div className="flex items-center gap-2 rounded-xl border border-dashed border-line bg-content1 px-3 py-2 text-sm">
                  <PackageOpen className="h-4 w-4 text-muted" aria-hidden />
                  <span className="font-semibold text-ink tabular">{fmtQty(loose)}</span>
                  <span className="text-muted">loose {unit}</span>
                </div>
              )}
            </div>
          </PackSection>

          {hierarchies.length > 1 && (
            <PackSection n={2} title="Hierarchy" icon={<Layers className="h-4 w-4 text-brand" />}>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Hierarchy to repack">
                {hierarchies.map((h) => {
                  const on = h.hierarchy_id === current.hierarchy_id;
                  return (
                    <button key={h.hierarchy_id} type="button" role="radio" aria-checked={on}
                            onClick={() => setHierarchyId(h.hierarchy_id)}
                            className={`flex min-h-11 items-center gap-2 rounded-xl border px-3 py-1.5 text-left text-sm transition-all ${
                              on ? "border-brand bg-brand-050 font-semibold text-brand shadow-sm ring-1 ring-brand/30"
                                 : "border-line bg-content1 text-ink-700 hover:border-brand/40"}`}>
                      <Layers className="h-3.5 w-3.5" aria-hidden />
                      {h.name}
                      {h.in_use && (
                        <span className={`rounded-full px-1.5 py-px text-[10px] font-bold ${
                          on ? "bg-brand text-white" : "bg-content2 text-muted"}`}>
                          {fmtQty(heldBy(h))} {unit}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </PackSection>
          )}

          <PackSection n={hierarchies.length > 1 ? 3 : 2} title="New packing"
                       icon={<Package className="h-4 w-4 text-brand" />}>
            {lowCount > 0 && (
              <p className="flex items-center gap-1.5 rounded-lg bg-warn-bg px-3 py-2 text-xs font-medium text-warn">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {lowCount} under minimum
              </p>
            )}
            <PackBreakdownEditor
              hierarchy={current}
              value={target}
              target={pool}
              uom={unit}
              onChange={setTarget}
            />
          </PackSection>

          <PackBalance packed={packed} target={pool} uom={unit} />

          <PackSection title="Reason">
            <Textarea value={reason} minRows={2} aria-label="Reason"
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="e.g. Cartons consolidated for dispatch" />
          </PackSection>

          {target && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-bold uppercase tracking-wider text-ink-700">After</span>
              <PackChips entries={target} uom={unit} />
            </div>
          )}
        </>
      )}
    </PackModal>
  );
}

/** What one hierarchy's outermost packs hold. */
function heldBy(h: LotHierarchy): number {
  const full = h.levels.reduce(
    (sum, lv) => sum + (h.top_counts[String(lv.level)] ?? 0) * lv.size, 0);
  return full + (h.top_parts ?? []).reduce((sum, p) => sum + p.fill, 0);
}

/** One hierarchy's packs on the shelf, as a card that opens to the packs themselves. */
function ShelfGroup({ hierarchy, unit }: { hierarchy: LotHierarchy; unit: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-content1">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
              className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left hover:bg-content2/50">
        <ChevronRight className={`h-4 w-4 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="inline-flex items-center gap-1 text-sm font-semibold text-ink">
          <Layers className="h-3.5 w-3.5 text-brand" aria-hidden /> {hierarchy.name}
        </span>
        <span className="ml-auto text-xs font-semibold tabular text-muted">
          {hierarchy.packs.length} pack{hierarchy.packs.length === 1 ? "" : "s"} · {fmtQty(heldBy(hierarchy))} {unit}
        </span>
      </button>
      {open && (
        <div className="max-h-56 space-y-0.5 overflow-y-auto border-t border-line/60 p-1.5">
          {hierarchy.packs.map((pack) => <PackRow key={pack.id} pack={pack} unit={unit} />)}
        </div>
      )}
    </div>
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
        </span>
        <span className="ml-auto inline-flex items-center gap-1 font-mono text-[11px] text-ink-700">
          <Tag className="h-3 w-3" aria-hidden />
          {pack.hu_code}
        </span>
      </button>
      {open && pack.contents.map((kid) => (
        <PackRow key={kid.id} pack={kid} unit={unit} depth={depth + 1} />
      ))}
    </div>
  );
}
