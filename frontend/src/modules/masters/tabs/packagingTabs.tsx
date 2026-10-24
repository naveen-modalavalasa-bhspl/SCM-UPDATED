import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalHeader } from "@heroui/react";
import { Check, Layers, Package, Save } from "lucide-react";
import { Button, Can, Field, Select, useToast } from "@/shared/components";
import { api } from "@/shared/api/client";
import { useAuth } from "@/shared/auth/AuthContext";
import {
  HierarchyLadder, USAGES, USAGE_LABEL, usePackOptions, type ContainerUsage, type PackHierarchy,
} from "@/shared/packing";
import { mastersApi } from "../api";
import { ItemPackHierarchies } from "../components/ItemMasterTab";
import type { ContainerUsageRow } from "../types";

/* Masters › Packaging (2026-10-23): Container Types (attributeTabs.PackagingTab),
 * Item Packaging Variants and Container Usage. */

interface ItemRow { id: number; code: string; name: string; uom_code?: string | null }

/** The item both sub-tabs work on, kept in the URL (`?item=`) so the item form's
 *  links open on it and switching between the two sub-tabs keeps it. */
function useItemParam(): [number | "", (id: number | "") => void] {
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get("item"));
  const value: number | "" = Number.isFinite(raw) && raw > 0 ? raw : "";
  const set = (id: number | "") => {
    const next = new URLSearchParams(params);
    if (id === "") next.delete("item");
    else next.set("item", String(id));
    setParams(next, { replace: true });
  };
  return [value, set];
}

function useItems() {
  return useQuery({
    queryKey: ["masters", "items", "picker"],
    queryFn: () => api.get<{ items: ItemRow[] }>("/api/items", { params: { size: 500 } })
      .then((r) => r.data.items),
    staleTime: 60_000,
  });
}

function ItemChoice({ items, value, onChange }: {
  items: ItemRow[]; value: number | ""; onChange: (id: number | "") => void;
}) {
  return (
    <Field label="Item">
      <Select
        value={value}
        searchable
        ariaLabel="Item"
        placeholder="Pick an item"
        options={items.map((i) => ({ value: i.id, label: `${i.code} — ${i.name}` }))}
        onChange={(v) => onChange(v ? Number(v) : "")}
      />
    </Field>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 text-lg font-semibold text-ink">{children}</h2>;
}

function EmptyState({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid place-items-center rounded-xl border border-dashed border-line bg-content2/50 px-4 py-10 text-center">
      <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-050 text-brand">{icon}</span>
      <p className="mt-3 text-sm font-medium text-body">{children}</p>
    </div>
  );
}

/* ------------------------------------------------ Item Packaging Variants --- */

export function ItemPackagingVariantsTab() {
  const [itemId, setItemId] = useItemParam();
  const items = useItems();
  const item = (items.data ?? []).find((i) => i.id === itemId);
  const combos = useQuery({
    queryKey: ["masters", "item-combinations", itemId],
    queryFn: () => mastersApi.itemCombinations.list(Number(itemId)),
    enabled: itemId !== "",
  });
  // One entry per brand the item carries; "All brands" first for ladders shared by all.
  const brands = useMemo(() => {
    const seen = new Map<number, string>();
    for (const c of combos.data ?? []) {
      if (c.brand_id && !seen.has(c.brand_id)) seen.set(c.brand_id, c.brand_name ?? `Brand ${c.brand_id}`);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [combos.data]);
  const [brand, setBrand] = useState<string>("all");
  useEffect(() => {
    setBrand(brands.length ? String(brands[0].id) : "all");
  }, [itemId, brands.length]);
  const brandId = brand === "all" ? null : Number(brand);
  const brandName = brands.find((b) => b.id === brandId)?.name ?? null;

  return (
    <div>
      <Heading>Item Packaging Variants</Heading>
      <div className="mb-4 grid gap-3 rounded-xl border border-line bg-content1 p-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <ItemChoice items={items.data ?? []} value={itemId} onChange={setItemId} />
        <Field label="Brand">
          <Select
            value={brand}
            ariaLabel="Brand"
            isDisabled={itemId === ""}
            options={[{ value: "all", label: "All brands" },
                      ...brands.map((b) => ({ value: String(b.id), label: b.name }))]}
            onChange={(v) => setBrand(String(v || "all"))}
          />
        </Field>
      </div>
      {item ? (
        <ItemPackHierarchies key={`${item.id}-${brand}`} itemId={item.id} itemName={item.name}
                             baseUom={item.uom_code} brandId={brandId} brandName={brandName} />
      ) : (
        <EmptyState icon={<Layers className="h-5 w-5" />}>Pick an item to see its pack hierarchies.</EmptyState>
      )}
    </div>
  );
}

/* --------------------------------------------------------- Container Usage --- */

export function ContainerUsageTab() {
  const [itemId, setItemId] = useItemParam();
  const items = useItems();
  const qc = useQueryClient();
  const toast = useToast();
  const canEdit = useAuth().can("master.packaging.manage");
  const view = useQuery({
    queryKey: ["masters", "container-usage", itemId],
    queryFn: () => mastersApi.containerUsage.get(Number(itemId)),
    enabled: itemId !== "",
  });
  const ladders = usePackOptions(itemId === "" ? [] : [Number(itemId)]);
  const [draft, setDraft] = useState<Record<number, ContainerUsage[]>>({});
  const [ladder, setLadder] = useState<PackHierarchy | null>(null);
  useEffect(() => {
    setDraft(Object.fromEntries((view.data?.containers ?? [])
      .map((c) => [c.package_id, [...c.usages]])));
  }, [view.data]);

  const dirty = (view.data?.containers ?? []).some((c) =>
    [...c.usages].sort().join() !== [...(draft[c.package_id] ?? [])].sort().join());
  const unmapped = USAGES.filter((u) => !Object.values(draft).some((list) => list.includes(u)));

  const save = useMutation({
    mutationFn: () => mastersApi.containerUsage.save(Number(itemId),
      Object.entries(draft).map(([package_id, usages]) => ({ package_id: Number(package_id), usages }))),
    onSuccess: (out) => {
      qc.setQueryData(["masters", "container-usage", itemId], out);
      void qc.invalidateQueries({ queryKey: ["pack-options"] });
      const r = out.recoded;
      toast.success(r && (r.lots || r.held_lots)
        ? `Saved · re-coded ${r.lots} lot${r.lots === 1 ? "" : "s"}`
          + (r.held_lots ? ` · ${r.held_lots} held by a document left as it was` : "")
        : "Container usage saved");
    },
    onError: (reason: Error) => toast.error(reason.message),
  });

  const toggle = (row: ContainerUsageRow, usage: ContainerUsage) =>
    setDraft((current) => {
      const list = current[row.package_id] ?? [];
      return { ...current, [row.package_id]: list.includes(usage)
        ? list.filter((u) => u !== usage) : [...list, usage] };
    });

  const openLadder = (hierarchyId: number | null) => {
    const found = (ladders.data?.[Number(itemId)] ?? []).find((h) => h.hierarchy_id === hierarchyId);
    if (found) setLadder(found);
  };

  return (
    <div>
      <Heading>Container Usage</Heading>
      <div className="mb-4 rounded-xl border border-line bg-content1 p-4">
        <ItemChoice items={items.data ?? []} value={itemId} onChange={setItemId} />
      </div>

      {itemId === "" ? (
        <EmptyState icon={<Package className="h-5 w-5" />}>Pick an item to map its containers.</EmptyState>
      ) : view.isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-content1">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-content2/60 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2.5">Container</th>
                  <th className="px-3 py-2.5">Used in</th>
                  {USAGES.map((u) => <th key={u} className="px-2 py-2.5 text-center">{USAGE_LABEL[u]}</th>)}
                </tr>
              </thead>
              <tbody>
                {(view.data?.containers ?? []).map((row) => (
                  <tr key={row.package_id} className="border-t border-line/70 align-top">
                    <td className="px-3 py-3">
                      <div className="font-semibold text-ink">{row.name}</div>
                      {row.code && <div className="mono text-[11px] text-muted">{row.code}</div>}
                    </td>
                    <td className="px-3 py-3">
                      {row.is_loose ? (
                        <span className="text-xs text-muted">Base unit</span>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {row.used_in.map((use) => (
                            <button key={`${use.hierarchy_id}-${use.level}`} type="button"
                                    onClick={() => openLadder(use.hierarchy_id)}
                                    className="inline-flex min-h-8 items-center gap-1 rounded-full border border-line bg-content2/60 px-2.5 text-xs text-ink-700 hover:border-brand hover:text-brand">
                              <Layers size={12} aria-hidden />
                              {use.hierarchy}
                              <span className="text-muted">· {use.size} {view.data?.base_uom ?? ""}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                    {USAGES.map((u) => {
                      const on = (draft[row.package_id] ?? []).includes(u);
                      return (
                        <td key={u} className="px-2 py-3 text-center">
                          {canEdit ? (
                            <button type="button" role="checkbox" aria-checked={on}
                                    aria-label={`${row.name}: ${USAGE_LABEL[u]}`}
                                    onClick={() => toggle(row, u)}
                                    className={`mx-auto grid h-9 w-9 place-items-center rounded-lg border transition-colors ${
                                      on ? "border-brand bg-brand text-white"
                                        : "border-line bg-content1 hover:border-brand"}`}>
                              {on && <Check className="h-4 w-4" />}
                            </button>
                          ) : on ? <Check className="mx-auto h-4 w-4 text-ok" aria-label="Yes" /> : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-content2/40 px-3 py-3">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              {unmapped.length ? (
                <>
                  <span className="font-semibold text-warn">Loose units for</span>
                  {unmapped.map((u) => (
                    <span key={u} className="rounded-full bg-warn-bg px-2 py-0.5 font-medium text-warn">
                      {USAGE_LABEL[u]}
                    </span>
                  ))}
                </>
              ) : (
                <span className="font-medium text-ok">Every usage has a container</span>
              )}
            </div>
            <Can do="master.packaging.manage">
              <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
                <Save size={14} /> {save.isPending ? "Saving…" : "Save"}
              </Button>
            </Can>
          </div>
        </div>
      )}

      <Modal isOpen={!!ladder} onOpenChange={() => setLadder(null)} size="md">
        <ModalContent>
          <ModalHeader>Pack hierarchy</ModalHeader>
          <ModalBody className="pb-6">
            {ladder && <HierarchyLadder hierarchy={ladder} uom={view.data?.base_uom} />}
          </ModalBody>
        </ModalContent>
      </Modal>
    </div>
  );
}
