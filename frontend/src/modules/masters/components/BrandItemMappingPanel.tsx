import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Eye, RefreshCw, Save, Search, X } from "lucide-react";
import { Button, Can, Card, Input } from "@/shared/components";
import { mastersApi } from "../api";
import type { BrandItemMappingSources } from "../api";
import type { MasterBrandItemMapping } from "../types";

/**
 * Brand Item Mapping: categories + items on the left, brands on the right,
 * one Save for every combination.
 *
 * Below the two panels: a per-item table. Each row shows one item and all
 * brands currently mapped to it. "View" opens an inline detail list where
 * individual mappings can be removed.
 *
 * The backend for /api/brand-item-mapping/sources is expected to return the
 * same shape as VendorMappingSources (brands instead of vendors, no vendor_categories).
 */

type Brand = BrandItemMappingSources["brands"][number];
type Category = BrandItemMappingSources["categories"][number];
type Item = BrandItemMappingSources["items"][number];

const norm = (s: string) => s.trim().toLowerCase();

/** A checkbox that can also show "some of what is under me". */
function Tick({ state, onChange, disabled, label }: {
  state: "all" | "some" | "none";
  onChange: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button" role="checkbox" aria-label={label} disabled={disabled}
      aria-checked={state === "all" ? true : state === "some" ? "mixed" : false}
      onClick={onChange}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors ${
        disabled ? "cursor-not-allowed border-line opacity-40"
          : state === "none" ? "border-line bg-content1 hover:border-brand"
            : "border-brand bg-brand text-white"
      }`}
    >
      {state === "all" && <span className="text-xs leading-none">✓</span>}
      {state === "some" && <span className="block h-0.5 w-2.5 rounded bg-white" />}
    </button>
  );
}

function Row({ depth, open, onToggleOpen, children }: {
  depth: number;
  open?: boolean;
  onToggleOpen?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-11 items-center gap-2" style={{ paddingLeft: depth * 20 }}>
      {onToggleOpen ? (
        <button type="button" onClick={onToggleOpen} aria-label={open ? "Collapse" : "Expand"}
                className="flex h-6 w-6 items-center justify-center text-muted">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      ) : <span className="w-6" />}
      {children}
    </div>
  );
}

function SearchBox({ value, onChange, placeholder }: {
  value: string; onChange: (v: string) => void; placeholder: string;
}) {
  return (
    <div className="relative">
      <Input value={value} onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
             placeholder={placeholder} aria-label={placeholder} />
      <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
    </div>
  );
}

/** Inline detail: all brands mapped to one item with a Remove button on each. */
function ItemBrandDetail({ item, onClose }: { item: Item; onClose: () => void }) {
  const qc = useQueryClient();
  const mappings = useQuery({
    queryKey: ["masters", "brand-item-mapping", "for-item", item.id],
    queryFn: () => mastersApi.brandItemMapping.listForItem(item.id),
  });
  const remove = useMutation({
    mutationFn: (id: number) => mastersApi.brandItemMapping.deactivate(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["masters", "brand-item-mapping"] });
    },
  });

  return (
    <div className="rounded-xl border border-line bg-content1 p-4 shadow-md">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-ink">{item.name}</div>
          <div className="font-mono text-xs text-muted">{item.code}</div>
        </div>
        <button type="button" onClick={onClose}
                className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-default">
          <X className="h-4 w-4" />
        </button>
      </div>
      {mappings.isLoading && <p className="text-sm text-muted">Loading…</p>}
      {!mappings.isLoading && (mappings.data ?? []).length === 0 && (
        <p className="text-sm text-muted">No brands mapped yet.</p>
      )}
      <div className="space-y-2">
        {(mappings.data ?? []).map((m: MasterBrandItemMapping) => (
          <div key={m.id}
               className="flex items-center justify-between gap-3 rounded-lg border border-line bg-content2 px-3 py-2">
            <div>
              <div className="text-sm font-medium text-ink">
                <span className="font-mono text-muted">{m.brand_code}</span>
                {" — "}
                {m.brand_name}
              </div>
              {m.manufacturer_names && m.manufacturer_names.length > 0 && (
                <div className="text-xs text-muted">
                  Manufacturers: {m.manufacturer_names.join(", ")}
                </div>
              )}
            </div>
            <Can do="master.brand.manage">
              <button
                type="button"
                className="text-xs text-bad hover:underline disabled:opacity-50"
                disabled={remove.isPending}
                onClick={() => remove.mutate(m.id)}
              >
                Remove
              </button>
            </Can>
          </div>
        ))}
      </div>
    </div>
  );
}

export function BrandItemMappingPanel() {
  const qc = useQueryClient();
  const sources = useQuery({
    queryKey: ["masters", "brand-item-mapping-sources"],
    queryFn: mastersApi.brandItemMapping.sources,
  });
  const data = sources.data;

  const [brandQuery, setBrandQuery] = useState("");
  const [itemQuery, setItemQuery] = useState("");
  const [brands, setBrands] = useState<Set<number>>(new Set());
  const [items, setItems] = useState<Set<number>>(new Set());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [expandedItem, setExpandedItem] = useState<Item | null>(null);

  const toggleOpen = (key: string) => setClosed((c) => {
    const next = new Set(c);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  // ---- the category tree, with every item filed under its Level 3 category ----
  const tree = useMemo(() => {
    const cats = data?.categories ?? [];
    const children = new Map<number | null, Category[]>();
    for (const c of cats) {
      const list = children.get(c.parent_id ?? null) ?? [];
      list.push(c);
      children.set(c.parent_id ?? null, list);
    }
    const itemsOf = new Map<number, Item[]>();
    for (const i of data?.items ?? []) {
      const list = itemsOf.get(i.category_id) ?? [];
      list.push(i);
      itemsOf.set(i.category_id, list);
    }
    const under = new Map<number, number[]>();
    const collect = (c: Category): number[] => {
      if (under.has(c.id)) return under.get(c.id)!;
      const ids = [
        ...(itemsOf.get(c.id) ?? []).map((i) => i.id),
        ...(children.get(c.id) ?? []).flatMap(collect),
      ];
      under.set(c.id, ids);
      return ids;
    };
    cats.forEach(collect);
    return { children, itemsOf, under };
  }, [data]);

  /** How many brands are already mapped to each item. */
  const mappedBrandsByItem = useMemo(() => {
    const out = new Map<number, Set<number>>();
    for (const [b, i] of data?.mapped ?? []) {
      const s = out.get(i) ?? new Set();
      s.add(b);
      out.set(i, s);
    }
    return out;
  }, [data]);

  // ---- search ----
  const q = norm(itemQuery);
  const itemMatches = (i: Item) => !q || norm(`${i.code} ${i.name}`).includes(q);
  const catVisible = (c: Category): boolean =>
    !q || norm(`${c.code} ${c.name}`).includes(q)
    || (tree.itemsOf.get(c.id) ?? []).some(itemMatches)
    || (tree.children.get(c.id) ?? []).some(catVisible);
  const bq = norm(brandQuery);
  const brandVisible = (b: Brand) => !bq || norm(`${b.code} ${b.name}`).includes(bq);

  const stateOf = (ids: number[], chosen: Set<number>) => {
    const hit = ids.filter((id) => chosen.has(id)).length;
    return hit === 0 ? "none" : hit === ids.length ? "all" : "some";
  };
  const flip = (ids: number[], chosen: Set<number>, set: (s: Set<number>) => void) => {
    const next = new Set(chosen);
    const on = stateOf(ids, chosen) !== "all";
    ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
    set(next);
  };

  const visibleItemIds = () => {
    const ids: number[] = [];
    const walk = (c: Category) => {
      if (!catVisible(c)) return;
      (tree.itemsOf.get(c.id) ?? []).filter(itemMatches).forEach((i) => ids.push(i.id));
      (tree.children.get(c.id) ?? []).forEach(walk);
    };
    (tree.children.get(null) ?? []).forEach(walk);
    return ids;
  };
  const visibleBrandIds = () => (data?.brands ?? []).filter(brandVisible).map((b) => b.id);

  const save = useMutation({
    mutationFn: () => {
      const categoryIds: number[] = [];
      const covered = new Set<number>();
      const walk = (c: Category) => {
        const ids = tree.under.get(c.id) ?? [];
        if (ids.length && ids.every((id) => items.has(id))) {
          categoryIds.push(c.id);
          ids.forEach((id) => covered.add(id));
          return;
        }
        (tree.children.get(c.id) ?? []).forEach(walk);
      };
      (tree.children.get(null) ?? []).forEach(walk);
      return mastersApi.brandItemMapping.save({
        brand_ids: [...brands],
        item_ids: [...items].filter((id) => !covered.has(id)),
        category_ids: categoryIds,
      });
    },
    onSuccess: (r) => {
      setNotice({
        tone: "ok",
        text: `Saved ${r.brands} brand${r.brands === 1 ? "" : "s"} × ${r.items} item${r.items === 1 ? "" : "s"}: `
          + `${r.created} new mapping${r.created === 1 ? "" : "s"}, ${r.updated} updated.`,
      });
      setBrands(new Set()); setItems(new Set());
      void qc.invalidateQueries({ queryKey: ["masters", "brand-item-mapping-sources"] });
      void qc.invalidateQueries({ queryKey: ["masters", "brand-item-mapping"] });
    },
    onError: (e: Error) => setNotice({ tone: "bad", text: e.message }),
  });

  const combos = brands.size * items.size;
  const ready = brands.size > 0 && items.size > 0;

  const renderCategory = (c: Category, depth: number): React.ReactNode => {
    if (!catVisible(c)) return null;
    const key = `c${c.id}`;
    const open = q ? true : !closed.has(key);
    const ids = tree.under.get(c.id) ?? [];
    const kids = tree.children.get(c.id) ?? [];
    const own = (tree.itemsOf.get(c.id) ?? []).filter(itemMatches);
    return (
      <div key={key}>
        <Row depth={depth} open={open}
             onToggleOpen={kids.length || own.length ? () => toggleOpen(key) : undefined}>
          <Tick state={ids.length ? stateOf(ids, items) : "none"} disabled={!ids.length}
                label={`Select ${c.name}`} onChange={() => flip(ids, items, setItems)} />
          <span className="text-sm">
            <span className="mono text-muted">{c.code}</span> {c.name}
            {!ids.length && <span className="ml-2 text-xs text-muted">no items</span>}
          </span>
        </Row>
        {open && kids.map((k) => renderCategory(k, depth + 1))}
        {open && own.map((i) => {
          const count = mappedBrandsByItem.get(i.id)?.size ?? 0;
          return (
            <Row key={`i${i.id}`} depth={depth + 1}>
              <Tick state={items.has(i.id) ? "all" : "none"} label={`Select ${i.name}`}
                    onChange={() => flip([i.id], items, setItems)} />
              <span className="text-sm">
                <span className="mono">{i.code}</span>{" "}
                <span className="text-muted">{i.name}</span>
                {count > 0 && (
                  <span className="ml-2 text-xs text-muted">
                    · {count} brand{count === 1 ? "" : "s"}
                  </span>
                )}
              </span>
            </Row>
          );
        })}
      </div>
    );
  };

  // ---- Mapped items table (below the two panels) ----
  /** All items that have at least one brand mapped, for the bottom table. */
  const mappedItems = useMemo(() => {
    const allItems = data?.items ?? [];
    return allItems.filter((i) => (mappedBrandsByItem.get(i.id)?.size ?? 0) > 0);
  }, [data, mappedBrandsByItem]);

  return (
    <div className="mb-6 space-y-6">
      {/* ---- Header ---- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Brand Item Mapping</h2>
          <p className="text-sm text-muted">
            Map brands to item categories or specific items.
            Manufacturer is inherited from the brand's own configuration.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => { setNotice(null); void sources.refetch(); }}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
          <Can do="master.brand.manage">
            <Button onClick={() => save.mutate()} disabled={!ready || save.isPending}>
              <Save className="h-4 w-4" /> {save.isPending ? "Saving…" : "Save Mapping"}
            </Button>
          </Can>
        </div>
      </div>

      {notice && (
        <div className={`rounded-lg px-3 py-2 text-sm ${
          notice.tone === "ok" ? "bg-ok-bg text-ok" : "bg-bad-bg text-bad"}`}>
          {notice.text}
        </div>
      )}
      {sources.error && (
        <div className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">
          {(sources.error as Error).message}
        </div>
      )}

      {/* ---- Two-column mapping panel ---- */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---- Item Categories & Materials ---- */}
        <Card className="p-0">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h3 className="font-semibold">Item Categories &amp; Materials</h3>
            <Button variant="ghost" onClick={() => flip(visibleItemIds(), items, setItems)}>
              Select visible
            </Button>
          </div>
          <div className="space-y-2 p-4">
            <SearchBox value={itemQuery} onChange={setItemQuery}
                       placeholder="Search items or categories" />
            <div className="max-h-[32rem] overflow-auto">
              {(tree.children.get(null) ?? []).map((c) => renderCategory(c, 0))}
              {sources.isLoading && <p className="py-4 text-sm text-muted">Loading…</p>}
            </div>
          </div>
        </Card>

        {/* ---- Brands ---- */}
        <Card className="p-0">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h3 className="font-semibold">Brands</h3>
            <Button variant="ghost" onClick={() => flip(visibleBrandIds(), brands, setBrands)}>
              Select visible
            </Button>
          </div>
          <div className="space-y-2 p-4">
            <SearchBox value={brandQuery} onChange={setBrandQuery} placeholder="Search brands" />
            <div className="max-h-[32rem] overflow-auto space-y-0.5">
              {(data?.brands ?? []).filter(brandVisible).map((b) => (
                <Row key={b.id} depth={0}>
                  <Tick state={brands.has(b.id) ? "all" : "none"} label={`Select ${b.name}`}
                        onChange={() => flip([b.id], brands, setBrands)} />
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="mono">{b.code}</span>{" "}
                    <span className="text-muted">{b.name}</span>
                    {b.manufacturer_names.length > 0 && (
                      <span className="ml-2 text-xs text-muted">
                        · {b.manufacturer_names.join(", ")}
                      </span>
                    )}
                  </span>
                </Row>
              ))}
              {sources.isLoading && <p className="py-4 text-sm text-muted">Loading…</p>}
            </div>

            {/* Summary */}
            {(brands.size > 0 || items.size > 0) && (
              <div className="mt-3 border-t border-line pt-3">
                <div className="flex gap-6">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted">Brands</div>
                    <div className="text-2xl font-semibold">{brands.size}</div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted">Items</div>
                    <div className="text-2xl font-semibold">{items.size}</div>
                  </div>
                </div>
                <span className="mt-2 inline-block rounded-full bg-brand-050 px-3 py-1 text-xs font-semibold text-brand">
                  {combos.toLocaleString()} COMBINATION{combos === 1 ? "" : "S"}
                </span>
                <p className="mt-2 text-xs text-muted">
                  Ticking a category maps every item under it.
                </p>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* ---- Mapped items detail table ---- */}
      <div>
        <h3 className="mb-3 text-base font-semibold">Mapped Items</h3>
        {expandedItem && (
          <div className="mb-4">
            <ItemBrandDetail item={expandedItem} onClose={() => setExpandedItem(null)} />
          </div>
        )}
        {mappedItems.length === 0 && !sources.isLoading && (
          <p className="rounded-xl bg-content2 p-5 text-sm text-muted">
            No brand-item mappings yet. Use the panel above to create them.
          </p>
        )}
        {mappedItems.length > 0 && (
          <div className="overflow-hidden rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-content2">
                  <th className="px-4 py-3 text-left font-semibold text-muted">Item Code</th>
                  <th className="px-4 py-3 text-left font-semibold text-muted">Item Name</th>
                  <th className="px-4 py-3 text-left font-semibold text-muted">Mapped Brands</th>
                  <th className="px-4 py-3 text-right font-semibold text-muted">Actions</th>
                </tr>
              </thead>
              <tbody>
                {mappedItems.map((i, idx) => {
                  const brandIds = [...(mappedBrandsByItem.get(i.id) ?? [])];
                  const brandNames = brandIds
                    .map((bid) => data?.brands.find((b) => b.id === bid)?.name ?? `Brand #${bid}`)
                    .join(", ");
                  const isExpanded = expandedItem?.id === i.id;
                  return (
                    <tr
                      key={i.id}
                      className={`border-b border-line transition-colors last:border-0 ${
                        isExpanded ? "bg-brand-050" : idx % 2 === 0 ? "bg-content1" : "bg-content2"
                      }`}
                    >
                      <td className="px-4 py-3 font-mono text-xs font-semibold">{i.code}</td>
                      <td className="px-4 py-3 text-body">{i.name}</td>
                      <td className="max-w-xs px-4 py-3 text-muted">
                        <span className="line-clamp-2">{brandNames}</span>
                        <span className="ml-1 inline-block rounded-full bg-default px-1.5 py-0.5 text-[11px] font-semibold">
                          {brandIds.length}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => setExpandedItem(isExpanded ? null : i)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-content1 px-3 py-1.5 text-xs font-medium hover:bg-default"
                        >
                          <Eye className="h-3.5 w-3.5" />
                          {isExpanded ? "Close" : "View"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
