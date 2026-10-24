import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@heroui/react";
import { Layers, Plus, Tag, X } from "lucide-react";
import { Button, Can, ErrorBanner, Select } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { mastersApi } from "../api";
import type { MasterItemCombination } from "../types";

/**
 * An item's brands and the combinations they make (2026-10-23).
 *
 * Brands are mapped here — on a new item too, held until its first save. Every
 * brand's variants and models then make the item's COMBINATIONS, one row each, and
 * each can be switched off for this item; never while any of it is in stock. A
 * document offers only the combinations that are on.
 */
export function ItemBrandsPanel({ itemId, draft, onDraft }: {
  /** The saved item; absent while a new item is being written. */
  itemId?: number;
  /** A new item's chosen brands, saved with it. */
  draft: number[];
  onDraft: (brandIds: number[]) => void;
}) {
  const qc = useQueryClient();
  const canManage = useAuth().can("master.item.manage");
  const [pick, setPick] = useState("");
  const [error, setError] = useState<unknown>(null);

  const brands = useQuery({
    queryKey: ["masters", "brands", "all"],
    queryFn: () => mastersApi.brands.list({ size: 500 }).then((r) => r.items.filter((b) => b.is_active)),
  });
  const combos = useQuery({
    queryKey: ["masters", "item-combinations", itemId],
    queryFn: () => mastersApi.itemCombinations.list(itemId!),
    enabled: !!itemId,
  });
  const set = (rows: MasterItemCombination[]) => {
    qc.setQueryData(["masters", "item-combinations", itemId], rows);
    qc.invalidateQueries({ queryKey: ["masters", "items"] });
    setError(null);
  };
  const map = useMutation({
    mutationFn: (brandId: number) => mastersApi.itemCombinations.mapBrands(itemId!, [brandId]),
    onSuccess: (rows) => { set(rows); setPick(""); },
    onError: setError,
  });
  const unmap = useMutation({
    mutationFn: (brandId: number) => mastersApi.itemCombinations.unmapBrand(itemId!, brandId),
    onSuccess: set,
    onError: setError,
  });
  const toggle = useMutation({
    mutationFn: ({ id, on }: { id: number; on: boolean }) =>
      mastersApi.itemCombinations.switch(itemId!, id, on),
    onSuccess: (row) => set((combos.data ?? []).map((r) => (r.id === row.id ? row : r))),
    onError: setError,
  });

  // The brands on the item: the saved item's from its combinations, a new one's draft.
  const mapped = useMemo(() => {
    if (!itemId) {
      return draft.map((id) => ({ id, name: brands.data?.find((b) => b.id === id)?.name ?? `Brand ${id}` }));
    }
    const seen = new Map<number, string>();
    for (const row of combos.data ?? []) seen.set(row.brand_id, row.brand_name ?? `Brand ${row.brand_id}`);
    return [...seen].map(([id, name]) => ({ id, name }));
  }, [itemId, draft, combos.data, brands.data]);
  const stockOf = (brandId: number) => (combos.data ?? [])
    .filter((r) => r.brand_id === brandId).reduce((sum, r) => sum + r.stock_qty, 0);
  const options = (brands.data ?? [])
    .filter((b) => !mapped.some((m) => m.id === b.id))
    .map((b) => ({ value: b.id, label: b.code ? `${b.name} · ${b.code}` : b.name }));
  const add = () => {
    const id = Number(pick);
    if (!id) return;
    if (itemId) map.mutate(id);
    else { onDraft([...draft, id]); setPick(""); }
  };
  const rows = combos.data ?? [];
  const on = rows.filter((r) => r.is_active).length;
  const busy = map.isPending || unmap.isPending || toggle.isPending;

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} />

      <section className="space-y-3 rounded-2xl border border-line/80 bg-content2/30 p-4">
        <h4 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-ink-700">
          <Tag className="h-4 w-4 text-brand" /> Brands
        </h4>
        <div className="flex flex-wrap gap-2">
          {mapped.length === 0 && <span className="text-sm text-muted">No brands yet.</span>}
          {mapped.map((b) => {
            const held = itemId ? stockOf(b.id) : 0;
            return (
              <span key={b.id}
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-brand/25 bg-brand-050 pl-3 pr-1 text-sm font-semibold text-brand">
                {b.name}
                <Can do="master.item.manage">
                  <button type="button" aria-label={`Remove ${b.name}`} disabled={busy || held > 0}
                          title={held > 0 ? `${held} in stock — cannot be removed` : `Remove ${b.name}`}
                          onClick={() => (itemId ? unmap.mutate(b.id) : onDraft(draft.filter((d) => d !== b.id)))}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-full text-brand/70 transition-colors hover:bg-white hover:text-bad disabled:cursor-not-allowed disabled:opacity-40">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </Can>
              </span>
            );
          })}
        </div>
        <Can do="master.item.manage">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[16rem] flex-1">
              <Select value={pick} ariaLabel="Brand to add" placeholder="Pick a brand"
                      options={options} onChange={setPick} />
            </div>
            <Button variant="soft" onClick={add} disabled={!pick || busy}>
              <Plus className="h-4 w-4" /> Add brand
            </Button>
          </div>
        </Can>
      </section>

      <section className="overflow-hidden rounded-2xl border border-line/80">
        <div className="flex items-center justify-between gap-2 border-b border-line/70 bg-content2/40 px-4 py-3">
          <h4 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-ink-700">
            <Layers className="h-4 w-4 text-brand" /> Combinations
          </h4>
          {itemId && rows.length > 0 && (
            <span className="rounded-full bg-content1 px-2.5 py-0.5 text-[11px] font-semibold text-muted ring-1 ring-line">
              {on} of {rows.length} on
            </span>
          )}
        </div>
        {!itemId ? (
          <p className="px-4 py-6 text-center text-sm text-muted">Shown once the item is saved.</p>
        ) : combos.isLoading ? (
          <p className="px-4 py-6 text-center text-sm text-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted">Add a brand to see its combinations.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-content2/25 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-4 py-2">Brand</th>
                  <th className="px-4 py-2">Variant</th>
                  <th className="px-4 py-2">Model</th>
                  <th className="px-4 py-2 text-right">In stock</th>
                  <th className="px-4 py-2 text-right">Active</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const locked = r.is_active && r.stock_qty > 0;
                  return (
                    <tr key={r.id} className={`border-t border-line/60 ${r.is_active ? "" : "bg-content2/30 text-muted"}`}>
                      <td className="px-4 py-2.5 font-semibold text-ink">{r.brand_name}</td>
                      <td className="px-4 py-2.5">{r.variant_name}</td>
                      <td className="px-4 py-2.5">{r.model_name}</td>
                      <td className="px-4 py-2.5 text-right tabular">
                        {r.stock_qty > 0 ? r.stock_qty.toLocaleString("en-IN") : ""}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex justify-end" title={locked ? "In stock — cannot be switched off" : undefined}>
                          {canManage ? (
                            <Switch size="sm" isSelected={r.is_active} isDisabled={locked || busy}
                                    aria-label={`${r.label} active`}
                                    onValueChange={(v) => toggle.mutate({ id: r.id, on: v })} />
                          ) : (
                            <span className="text-xs">{r.is_active ? "On" : "Off"}</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
