import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@heroui/react";
import { ChevronDown, ChevronRight, RefreshCw, Save, Search } from "lucide-react";
import { Button, Can, Card, Input } from "@/shared/components";
import { mastersApi } from "../api";
import type { VendorMappingSources } from "../api";

/**
 * Vendor Material Mapping: suppliers on the left, the category tree and its items
 * in the middle, the defaults on the right, and one Save for every combination.
 *
 * Replaces adding vendor rates one supplier x one item at a time. What it writes
 * are ordinary vendor-item rows, so RFQs and POs read them as before; the list
 * underneath this panel is still where a single mapping is edited or removed.
 *
 * Suppliers are grouped by Vendor Categories (Masters › Vendor Categories), with
 * the untagged ones under Uncategorized. A blocked vendor is shown but cannot be
 * ticked: the server refuses to map one, and a box that can be ticked and then
 * refused is a box nobody trusts twice.
 */

type Vendor = VendorMappingSources["vendors"][number];
type Category = VendorMappingSources["categories"][number];
type Item = VendorMappingSources["items"][number];


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
      <Input value={value} onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)} placeholder={placeholder}
             aria-label={placeholder} />
      <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
    </div>
  );
}

export function VendorMappingPanel() {
  const qc = useQueryClient();
  const sources = useQuery({
    queryKey: ["masters", "vendor-mapping-sources"],
    queryFn: mastersApi.vendorMapping.sources,
  });
  const data = sources.data;

  const [vendorQuery, setVendorQuery] = useState("");
  const [itemQuery, setItemQuery] = useState("");
  const [vendors, setVendors] = useState<Set<number>>(new Set());
  const [items, setItems] = useState<Set<number>>(new Set());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [lead, setLead] = useState("");
  const [moq, setMoq] = useState("");
  const [rate, setRate] = useState("");
  const [preferred, setPreferred] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const toggleOpen = (key: string) => setClosed((c) => {
    const next = new Set(c); if (next.has(key)) next.delete(key); else next.add(key); return next;
  });

  // ---- the category tree, with every item filed under its Level 3 category ----
  const tree = useMemo(() => {
    const cats = data?.categories ?? [];
    const children = new Map<number | null, Category[]>();
    for (const c of cats) {
      const list = children.get(c.parent_id ?? null) ?? [];
      list.push(c); children.set(c.parent_id ?? null, list);
    }
    const itemsOf = new Map<number, Item[]>();
    for (const i of data?.items ?? []) {
      const list = itemsOf.get(i.category_id) ?? [];
      list.push(i); itemsOf.set(i.category_id, list);
    }
    // Every item under a category, at any depth — what ticking the category means.
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

  // Suppliers grouped by vendor category; a vendor in two categories shows in both
  // and is still ONE supplier (selection is a set of vendor ids). Untagged vendors
  // fall into Uncategorized.
  const supplierGroups = useMemo(() => {
    const all = data?.vendors ?? [];
    const byId = new Map(all.map((v) => [v.id, v]));
    const tagged = new Set<number>();
    const groups = (data?.vendor_categories ?? []).map((c) => {
      const list = c.vendor_ids.map((id) => byId.get(id)).filter(Boolean) as Vendor[];
      list.forEach((v) => tagged.add(v.id));
      return { key: String(c.id), label: c.name, list };
    });
    const rest = all.filter((v) => !tagged.has(v.id));
    if (rest.length) groups.push({ key: "none", label: "Uncategorized", list: rest });
    return groups;
  }, [data]);

  const mappedCount = useMemo(() => {
    const out = new Map<number, Set<number>>();
    for (const [v, i] of data?.mapped ?? []) {
      const s = out.get(i) ?? new Set(); s.add(v); out.set(i, s);
    }
    return out;
  }, [data]);

  // ---- search: a node is shown when it, an ancestor or a descendant matches ----
  const q = norm(itemQuery);
  const itemMatches = (i: Item) => !q || norm(`${i.code} ${i.name}`).includes(q);
  const catVisible = (c: Category): boolean =>
    !q || norm(`${c.code} ${c.name}`).includes(q)
    || (tree.itemsOf.get(c.id) ?? []).some(itemMatches)
    || (tree.children.get(c.id) ?? []).some(catVisible);
  const vq = norm(vendorQuery);
  const vendorVisible = (v: Vendor) => !vq || norm(`${v.code} ${v.name}`).includes(vq);

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
  const visibleVendorIds = () => (data?.vendors ?? [])
    .filter((v) => v.status !== "BLOCKED" && vendorVisible(v)).map((v) => v.id);

  const save = useMutation({
    mutationFn: () => {
      // A category whose every item is ticked travels as the category, so a big
      // category is one id rather than hundreds.
      const categoryIds: number[] = [];
      const covered = new Set<number>();
      const walk = (c: Category) => {
        const ids = tree.under.get(c.id) ?? [];
        if (ids.length && ids.every((id) => items.has(id))) {
          categoryIds.push(c.id); ids.forEach((id) => covered.add(id)); return;
        }
        (tree.children.get(c.id) ?? []).forEach(walk);
      };
      (tree.children.get(null) ?? []).forEach(walk);
      return mastersApi.vendorMapping.save({
      vendor_ids: [...vendors],
      item_ids: [...items].filter((id) => !covered.has(id)),
      category_ids: categoryIds,
      lead_time_days: lead === "" ? null : Number(lead),
      min_order_qty: moq === "" ? null : Number(moq),
      last_rate: rate === "" ? null : Number(rate),
      is_preferred: preferred,
    });
    },
    onSuccess: (r) => {
      setNotice({ tone: "ok", text:
        `Saved ${r.suppliers} supplier${r.suppliers === 1 ? "" : "s"} × ${r.items} item${r.items === 1 ? "" : "s"}: `
        + `${r.created} new mapping${r.created === 1 ? "" : "s"}, ${r.updated} updated.` });
      setVendors(new Set()); setItems(new Set());
      void qc.invalidateQueries({ queryKey: ["masters", "vendor-mapping-sources"] });
      void qc.invalidateQueries({ queryKey: ["masters", "vendor-items"] });
    },
    onError: (e: Error) => setNotice({ tone: "bad", text: e.message }),
  });

  const combos = vendors.size * items.size;
  const ready = vendors.size > 0 && items.size > 0 && !(preferred && vendors.size !== 1);

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
          const count = mappedCount.get(i.id)?.size ?? 0;
          return (
            <Row key={`i${i.id}`} depth={depth + 1}>
              <Tick state={items.has(i.id) ? "all" : "none"} label={`Select ${i.name}`}
                    onChange={() => flip([i.id], items, setItems)} />
              <span className="text-sm">
                <span className="mono">{i.code}</span>{" "}
                <span className="text-muted">{i.name}</span>
                {count > 0 && (
                  <span className="ml-2 text-xs text-muted">
                    · {count} supplier{count === 1 ? "" : "s"}
                  </span>
                )}
              </span>
            </Row>
          );
        })}
      </div>
    );
  };

  return (
    <div className="mb-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Vendor Material Mapping</h2>
          <p className="text-sm text-muted">
            Map suppliers to item categories or specific materials.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => { setNotice(null); void sources.refetch(); }}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
          <Can do="master.vendor.manage">
            <Button onClick={() => save.mutate()} disabled={!ready || save.isPending}>
              <Save className="h-4 w-4" /> {save.isPending ? "Saving…" : "Save Mapping"}
            </Button>
          </Can>
        </div>
      </div>

      {notice && (
        <div className={`mb-3 rounded-lg px-3 py-2 text-sm ${
          notice.tone === "ok" ? "bg-ok-bg text-ok" : "bg-bad-bg text-bad"}`}>
          {notice.text}
        </div>
      )}
      {sources.error && (
        <div className="mb-3 rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">
          {(sources.error as Error).message}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_1.3fr_0.8fr]">
        {/* ---- Suppliers ---- */}
        <Card className="p-0">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h3 className="font-semibold">Suppliers</h3>
            <Button variant="ghost" onClick={() => flip(visibleVendorIds(), vendors, setVendors)}>
              Select visible
            </Button>
          </div>
          <div className="space-y-2 p-4">
            <SearchBox value={vendorQuery} onChange={setVendorQuery}
                       placeholder="Search suppliers" />
            <div className="max-h-[32rem] overflow-auto">
              {supplierGroups.map(({ key: groupKey, label, list }) => {
                const shown = list.filter(vendorVisible);
                const key = `v${groupKey}`;
                const open = vq ? true : !closed.has(key);
                const ids = shown.filter((v) => v.status !== "BLOCKED").map((v) => v.id);
                return (
                  <div key={groupKey}>
                    <Row depth={0} open={open}
                         onToggleOpen={shown.length ? () => toggleOpen(key) : undefined}>
                      <Tick state={ids.length ? stateOf(ids, vendors) : "none"}
                            disabled={!ids.length} label={`Select ${label}`}
                            onChange={() => flip(ids, vendors, setVendors)} />
                      <span className="text-sm">{label} ({list.length})</span>
                    </Row>
                    {open && shown.map((v) => {
                      const blocked = v.status === "BLOCKED";
                      return (
                        <Row key={`${groupKey}-${v.id}`} depth={1}>
                          <Tick state={vendors.has(v.id) ? "all" : "none"} disabled={blocked}
                                label={`Select ${v.name}`}
                                onChange={() => flip([v.id], vendors, setVendors)} />
                          <span className={`text-sm ${blocked ? "text-muted line-through" : ""}`}>
                            <span className="mono">{v.code}</span>{" "}
                            <span className="text-muted">{v.name}</span>
                            {blocked && <span className="ml-2 text-xs no-underline">blocked</span>}
                            {v.status === "PENDING" && (
                              <span className="ml-2 text-xs text-muted">not yet approved</span>
                            )}
                          </span>
                        </Row>
                      );
                    })}
                  </div>
                );
              })}
              {sources.isLoading && <p className="py-4 text-sm text-muted">Loading…</p>}
            </div>
          </div>
        </Card>

        {/* ---- Item categories & materials ---- */}
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

        {/* ---- Defaults ---- */}
        <Card className="p-0">
          <div className="border-b border-line px-4 py-3">
            <h3 className="font-semibold">Mapping Defaults</h3>
          </div>
          <div className="space-y-4 p-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Suppliers</div>
                <div className="text-2xl font-semibold">{vendors.size}</div>
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Items</div>
                <div className="text-2xl font-semibold">{items.size}</div>
              </div>
            </div>
            <span className="inline-block rounded-full bg-brand-050 px-3 py-1 text-xs font-semibold text-brand">
              {combos.toLocaleString()} COMBINATION{combos === 1 ? "" : "S"}
            </span>
            <label className="block text-sm">Lead time (days)
              <Input type="number" min={0} value={lead} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLead(e.target.value)}
                     placeholder="Leave blank to keep" />
            </label>
            <label className="block text-sm">Min order qty
              <Input type="number" min={0} value={moq} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMoq(e.target.value)}
                     placeholder="Leave blank to keep" />
            </label>
            <label className="block text-sm">Rate
              <Input type="number" min={0} value={rate} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRate(e.target.value)}
                     placeholder="Leave blank to keep" />
            </label>
            <div className="flex items-center justify-between">
              <span className="text-sm">Preferred</span>
              <Switch isSelected={preferred} onValueChange={setPreferred} aria-label="Preferred" />
            </div>
            {preferred && vendors.size !== 1 && (
              <p className="text-xs text-bad">
                Preferred needs exactly one supplier: an item has one preferred supplier.
              </p>
            )}
            <p className="text-xs text-muted">
              A blank figure leaves an existing mapping&apos;s value as it is. Ticking a
              category maps every item under it.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
