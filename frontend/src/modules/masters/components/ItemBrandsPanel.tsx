import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@heroui/react";
import { ChevronRight, Layers, Plus, Tag, Trash2, X } from "lucide-react";
import { Button, Can, ErrorBanner, Select } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { mastersApi } from "../api";
import type { MasterItemCombination } from "../types";

/**
 * An item's brands and the combinations they make (2026-10-23).
 *
 * Brands are mapped here — on a new item too, held until its first save. The item's
 * COMBINATIONS are exactly what is picked (2026-10-26): a brand alone, a brand and a
 * variant, or a brand, a variant and a model — a brand's other variants and models are
 * never added on their own. Each can be switched off or removed for this item; never
 * while any of it is in stock. A document offers only the combinations that are on.
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
  const [variantPick, setVariantPick] = useState("");
  const [modelPick, setModelPick] = useState("");
  const [error, setError] = useState<unknown>(null);

  const brands = useQuery({
    queryKey: ["masters", "brands", "all"],
    queryFn: () => mastersApi.brands.list({ size: 500 }).then((r) => r.items.filter((b) => b.is_active)),
  });
  const variants = useQuery({
    queryKey: ["masters", "brand-variants", "all"],
    queryFn: () => mastersApi.brandVariants.list({ size: 500 }).then((r) => r.items.filter((v) => v.is_active)),
    enabled: !!itemId,
  });
  const models = useQuery({
    queryKey: ["masters", "brand-models", "all"],
    queryFn: () => mastersApi.brandModels.list({ size: 500 }).then((r) => r.items.filter((m) => m.is_active)),
    enabled: !!itemId,
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
  const reset = () => { setPick(""); setVariantPick(""); setModelPick(""); };
  // Exactly what was picked — brand, brand + variant, or brand + variant + model.
  const map = useMutation({
    mutationFn: () => mastersApi.itemCombinations.add(itemId!, {
      brand_id: Number(pick),
      variant_id: variantPick ? Number(variantPick) : null,
      model_id: modelPick ? Number(modelPick) : null,
    }),
    onSuccess: (rows) => { set(rows); reset(); },
    onError: setError,
  });
  const removeRow = useMutation({
    mutationFn: (id: number) => mastersApi.itemCombinations.remove(itemId!, id),
    onSuccess: set,
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
  // A saved item may take more of a brand it already has (a variant, a model); a new
  // item's draft holds brands only, so a mapped brand is not offered twice there.
  const options = (brands.data ?? [])
    .filter((b) => itemId || !mapped.some((m) => m.id === b.id))
    .map((b) => ({ value: b.id, label: b.code ? `${b.name} · ${b.code}` : b.name }));
  const variantOptions = (variants.data ?? [])
    .filter((v) => pick && v.brand_id === Number(pick))
    .map((v) => ({ value: v.id, label: v.name }));
  const modelOptions = (models.data ?? [])
    .filter((m) => variantPick && m.variant_id === Number(variantPick))
    .map((m) => ({ value: m.id, label: m.name }));
  const pickedLabel = [
    brands.data?.find((b) => b.id === Number(pick))?.name,
    variants.data?.find((v) => v.id === Number(variantPick))?.name,
    models.data?.find((m) => m.id === Number(modelPick))?.name,
  ].filter(Boolean).join(" · ");
  const already = (combos.data ?? []).some((r) => r.brand_id === Number(pick)
    && (r.variant_id ?? 0) === Number(variantPick || 0) && (r.model_id ?? 0) === Number(modelPick || 0));
  const add = () => {
    const id = Number(pick);
    if (!id) return;
    if (itemId) map.mutate();
    else { onDraft([...draft, id]); reset(); }
  };
  const rows = combos.data ?? [];
  const on = rows.filter((r) => r.is_active).length;
  const busy = map.isPending || unmap.isPending || toggle.isPending || removeRow.isPending;

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
          <div className="space-y-2">
            {/* Brand, then — only if wanted — its variant, then that variant's model.
                What is picked is exactly what is mapped (2026-10-26). */}
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1.2fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto] sm:items-center">
              <Select value={pick} ariaLabel="Brand" placeholder="Pick a brand"
                      options={options}
                      onChange={(v) => { setPick(String(v ?? "")); setVariantPick(""); setModelPick(""); }} />
              <ChevronRight className="hidden h-4 w-4 text-muted sm:block" aria-hidden />
              <Select value={variantPick} ariaLabel="Variant (optional)"
                      placeholder={!itemId ? "Variant — after saving" : !pick ? "Variant" : variantOptions.length ? "Variant (optional)" : "No variants"}
                      options={variantOptions} isDisabled={!itemId || !pick || !variantOptions.length}
                      onChange={(v) => { setVariantPick(String(v ?? "")); setModelPick(""); }} />
              <ChevronRight className="hidden h-4 w-4 text-muted sm:block" aria-hidden />
              <Select value={modelPick} ariaLabel="Model (optional)"
                      placeholder={!variantPick ? "Model" : modelOptions.length ? "Model (optional)" : "No models"}
                      options={modelOptions} isDisabled={!itemId || !variantPick || !modelOptions.length}
                      onChange={(v) => setModelPick(String(v ?? ""))} />
              <Button variant="soft" onClick={add} disabled={!pick || busy || already}>
                <Plus className="h-4 w-4" /> Add
              </Button>
            </div>
            {pick && (
              <p className={`text-xs ${already ? "text-warn" : "text-muted"}`}>
                {already ? `${pickedLabel} is already on this item.`
                  : <>Maps <b className="text-ink">{pickedLabel}</b>{!variantPick ? " — the brand alone" : !modelPick ? " — the brand and this variant" : ""}.</>}
              </p>
            )}
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
                  {canManage && <th className="w-12 px-2 py-2" aria-label="Remove" />}
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
                      {canManage && (
                        <td className="px-2 py-2.5 text-right">
                          <button type="button" disabled={busy || r.stock_qty > 0}
                                  onClick={() => removeRow.mutate(r.id)}
                                  title={r.stock_qty > 0 ? "In stock — cannot be removed" : `Remove ${r.label}`}
                                  aria-label={`Remove ${r.label}`}
                                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-bad/10 hover:text-bad disabled:cursor-not-allowed disabled:opacity-40">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      )}
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
