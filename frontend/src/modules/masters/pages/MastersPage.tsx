import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Select, SelectItem } from "@heroui/react";
import { PageHeader } from "@/shared/components";
import { mastersApi } from "../api";
import { type Option } from "../components/MasterCrud";
import type { RefRow } from "../types";
import { Code, NamedLookupTab, ReadOnlyTab } from "../tabs/common";
import {
  BrandsTab, CategoriesTab, GeneralNamesTab, HsnCodesTab, ItemClassesTab,
  ItemSubClassesTab, ItemsTab,
} from "../tabs/itemTabs";
import { ProjectsTab, WarehousesTab } from "../tabs/locationTabs";
import { VendorItemsTab, VendorsTab } from "../tabs/vendorTabs";
import { ConversionsTab, UomTab } from "../tabs/uomTabs";
import {
  AttributesTab, CategoryTaggingTab, FeaturesTab, PackagingTab, SpecsTab,
} from "../tabs/attributeTabs";
import { BomGroupsTab, BomsTab, ItemGroupsTab } from "../tabs/bomTabs";
import { ItemEligibilityTab } from "../tabs/eligibilityTabs";
const TABS = [
  "items", "categories", "general-names", "item-classes", "item-sub-classes",
  "brands", "manufacturers", "dosage-forms", "hsn-codes",
  "features", "packaging", "item-groups",
  "attributes", "specs", "category-tags",
  "uom", "conversions", "warehouses",
  "projects", "vendors", "vendor-items", "boms", "bom-groups",
  "departments", "facilities", "item-eligibility",
] as const;

/** The masters, grouped the way somebody looking for one thinks about them.
 *
 *  Twenty-six equal pills in one wrapping row was the old design, and the wrap is
 *  what broke it: HeroUI's `radius="full"` draws the tab LIST as one pill, so four
 *  wrapped rows became a giant curved blob, and the chosen master's table started
 *  below it — which is why picking a tab then scrolled the page. Grouping is the fix,
 *  not styling: nobody scans twenty-six siblings, they look for "the vendor one".
 *
 *  Order and membership only. Every tab still renders the same component with the
 *  same props and the same permission checks as before. */
export type MasterTab = (typeof TABS)[number];
export type MasterGroup = { label: string; tabs: MasterTab[] };

const GROUPS: MasterGroup[] = [
  { label: "Items", tabs: ["items", "categories", "general-names", "item-classes", "item-sub-classes", "item-groups", "item-eligibility"] },
  { label: "Classification", tabs: ["brands", "manufacturers", "dosage-forms", "hsn-codes"] },
  { label: "Attributes", tabs: ["attributes", "specs", "features", "category-tags", "packaging"] },
  { label: "Units", tabs: ["uom", "conversions"] },
  { label: "Vendors", tabs: ["vendors", "vendor-items"] },
  { label: "BOM", tabs: ["boms", "bom-groups"] },
  { label: "Locations", tabs: ["warehouses", "facilities", "projects", "departments"] },
];

/** The same masters, split by the module that OWNS them, for the per-module Masters
 *  screens (`/inventory/masters`, `/procurement/masters`, `/indents/masters`,
 *  `/admin/org-masters`).
 *
 *  Membership only — every entry below renders exactly the tab component the
 *  all-in-one `/masters` screen renders, with the same `<Can>` gating inside it, so
 *  putting a master on a module's screen widens no permission. What gates the SCREEN
 *  is its own `page.<code>.view`, catalogued in `platform/rbac/permissions.py` and
 *  inheriting from `page.masters.view` so whoever can open Masters today can open
 *  these on the day they deploy.
 *
 *  `/masters` is deliberately still here and still whole: these are a second door on
 *  the same data, not a migration off it.
 *
 *  Warehouses and Bins are absent on purpose — the warehouse module has owned its own
 *  masters screen (`/warehouse/masters`) since the storage-type work, and a second
 *  editor for the same rows is how two screens come to disagree. */
export const INVENTORY_MASTER_GROUPS: MasterGroup[] = [
  { label: "Items", tabs: ["items", "categories", "general-names", "item-classes", "item-sub-classes", "item-groups"] },
  { label: "Classification", tabs: ["brands", "manufacturers", "dosage-forms"] },
  { label: "Attributes", tabs: ["attributes", "specs", "features", "category-tags", "packaging"] },
  { label: "Units", tabs: ["uom", "conversions"] },
];

/** Tax lives on the HSN code and is read at PO/GRN time, never copied onto an item —
 *  so it is the buyer's master, not the catalogue's. */
export const PROCUREMENT_MASTER_GROUPS: MasterGroup[] = [
  { label: "Vendors", tabs: ["vendors", "vendor-items"] },
  { label: "Tax", tabs: ["hsn-codes"] },
];

/** Both of these are rules about RAISING a request: a BOM is what an indent is built
 *  from, and eligibility is which items a role or region may ask for at all
 *  (`modules/indents/eligibility.py` on the backend). */
export const INDENT_MASTER_GROUPS: MasterGroup[] = [
  { label: "BOM", tabs: ["boms", "bom-groups"] },
  { label: "Eligibility", tabs: ["item-eligibility"] },
];

/** HCM mirrors. Read-only here because HCM owns them (rule 10) — the write routes are
 *  not even registered — which is why they sit under Settings rather than in a module
 *  that would imply somebody here can change them. */
export const ORG_MASTER_GROUPS: MasterGroup[] = [
  { label: "Organisation", tabs: ["projects", "facilities", "departments"] },
];

const TAB_LABELS: Record<(typeof TABS)[number], string> = {
  items: "Items", categories: "Categories", "item-classes": "Item Classes",
  "general-names": "General Names", "item-sub-classes": "Item Subclasses",
  brands: "Brands", manufacturers: "Manufacturers",
  "dosage-forms": "Dosage Forms", "hsn-codes": "HSN Codes",
  features: "Features", packaging: "Packages", "item-groups": "Item Groups",
  attributes: "Attributes", specs: "Specifications", "category-tags": "Category Tagging",
  uom: "UOM", conversions: "Conversions", warehouses: "Warehouses",
  projects: "Projects", vendors: "Vendors", "vendor-items": "Vendor Rates",
  boms: "BOM", "bom-groups": "BOM Groups",
  departments: "Departments", facilities: "Facilities",
  "item-eligibility": "Item Eligibility",
};

/** Which tabs actually need each shared dropdown source. Without this the screen
 *  fetched every UOM, category, warehouse, bin, facility, project and 300 items on
 *  mount no matter which tab you were on — seven requests to render a list of
 *  manufacturers. Each source is now fetched by the tabs that read it. */
const NEEDS: Record<string, readonly string[]> = {
  uom: ["items", "conversions", "attributes", "specs", "packaging"],
  categories: ["items", "categories", "category-tags"],
  facilities: ["warehouses", "facilities"],
  projects: ["boms", "projects"],
  items: ["item-groups", "vendor-items", "boms", "item-eligibility"],
};

export function MastersPage() {
  return <MastersShell groups={GROUPS} />;
}

/** The masters screen over a SUBSET of the masters.
 *
 *  One component, so a module's Masters screen cannot drift from `/masters`: the
 *  index, the search, the per-tab dropdown sources and every tab component are the
 *  same code. A module page supplies only which groups it shows and what the header
 *  says. */
export function MastersShell({
  groups: source, eyebrow = "Masters", title = "Master data",
}: { groups: MasterGroup[]; eyebrow?: string; title?: string }) {
  // The tab lives in the URL so refresh and Back keep your place, and so a link to
  // ?tab=vendors opens on Vendors rather than on Items.
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get("tab") ?? "";
  // The subset's own tabs, not TABS: a `?tab=` naming a master this screen does not
  // carry must fall back to this screen's home rather than render a tab with no entry
  // in the index beside it.
  const shown = useMemo(() => source.flatMap((g) => g.tabs), [source]);
  const home = shown[0] ?? "items";
  const tab = shown.includes(fromUrl as MasterTab) ? fromUrl : home;
  const setTab = (next: string) => {
    // replace, not push: clicking through six masters should not mean six Backs to
    // leave the screen.
    setParams(next === home ? {} : { tab: next }, { replace: true });
  };

  // No scroll-into-view any more. It existed because the tab strip pushed the table
  // below the fold, so choosing a master had to be followed by a jump; the list sits
  // beside the content now and the content never moves.
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return source;
    return source
      .map((g) => ({ ...g, tabs: g.tabs.filter((t) => TAB_LABELS[t].toLowerCase().includes(needle)) }))
      .filter((g) => g.tabs.length);
  }, [q, source]);

  const wanted = (source: string) => NEEDS[source].includes(tab);

  const uom = useQuery({
    queryKey: ["masters", "uom"], queryFn: mastersApi.uom.listAll,
    enabled: wanted("uom"),
  });
  const cats = useQuery({
    queryKey: ["masters", "categories", "all"],
    queryFn: () => mastersApi.categories.list({ size: 200 }).then((p) => p.items),
    enabled: wanted("categories"),
  });
  const facilities = useQuery({
    queryKey: ["masters", "facilities"], queryFn: mastersApi.facilities,
    enabled: wanted("facilities"),
  });
  const projects = useQuery({
    queryKey: ["masters", "projects", "all"],
    queryFn: () => mastersApi.projects.list({ size: 300 }).then((p) => p.items),
    enabled: wanted("projects"),
  });
  const items = useQuery({
    queryKey: ["masters", "items", "all"],
    queryFn: () => mastersApi.items.list({ size: 300 }).then((p) => p.items),
    enabled: wanted("items"),
  });

  const uomOpts: Option[] = (uom.data ?? []).map((u) => ({ value: u.id, label: `${u.code} — ${u.name}` }));
  const catOpts: Option[] = (cats.data ?? []).map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` }));
  const facOpts: Option[] = (facilities.data ?? []).map((f) => ({ value: f.id, label: f.name }));
  const projectOpts: Option[] = (projects.data ?? []).map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` }));
  const itemOpts: Option[] = (items.data ?? []).map((i) => ({ value: i.id, label: `${i.code} — ${i.name}` }));

  return (
    <>
      <PageHeader eyebrow={eyebrow} title={title} />

      <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
        {/* Phone and tablet: one control, because a 26-row list above the table is
            the same "scroll past the menu to reach what you picked" problem in a
            different shape. */}
        <div className="lg:hidden">
          <Select
            aria-label="Master type"
            label="Master"
            size="sm"
            variant="bordered"
            selectedKeys={[tab]}
            onSelectionChange={(keys) => {
              const next = Array.from(keys)[0];
              if (next) setTab(String(next));
            }}
          >
            {shown.map((key) => <SelectItem key={key}>{TAB_LABELS[key]}</SelectItem>)}
          </Select>
        </div>

        {/* Desktop: a grouped index that stays put. `sticky` so working through a long
            master's table never means scrolling back up to change master. */}
        <nav
          aria-label="Master type"
          className="hidden w-[212px] shrink-0 lg:sticky lg:top-[84px] lg:block"
        >
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a master"
            aria-label="Find a master"
            className="mb-3 h-9 w-full rounded-lg border border-line bg-content1 px-3 text-sm text-ink outline-none placeholder:text-muted focus:border-brand"
          />
          <div className="max-h-[calc(100vh-190px)] space-y-5 overflow-y-auto pr-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {groups.map((group) => (
              <div key={group.label}>
                {/* A heading, not a caption. It was muted 10px in the same grey as
                    the rows under it, so the groups read as one flat list with faint
                    labels in it. Ink weight carries the hierarchy; the gradient tick
                    and the rule to the edge close the band off, so the eye can find a
                    group without reading any of its entries. */}
                <div className="mb-1.5 flex items-center gap-2 px-2">
                  <span
                    aria-hidden
                    className="h-3 w-[3px] shrink-0 rounded-full [background-image:var(--brand-gradient)]"
                  />
                  <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink">
                    {group.label}
                  </span>
                  {/* 2px and carrying the sweep out of the tick, not a hairline in
                      --color-line: that token is for dividers BETWEEN peers, and at
                      1px of pale grey the rule read as a rendering artefact rather
                      than part of the heading. It fades to nothing at the right so it
                      still ends the band instead of boxing it in. */}
                  <span
                    aria-hidden
                    className="h-[2px] flex-1 rounded-full [background-image:linear-gradient(90deg,var(--grad-3),var(--grad-4)_35%,transparent)] opacity-70"
                  />
                </div>
                {group.tabs.map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setTab(key)}
                    aria-current={tab === key ? "page" : undefined}
                    className={`flex min-h-9 w-full items-center rounded-lg px-2 text-left text-sm transition-colors ${
                      tab === key
                        ? "bg-brand-050 font-semibold text-brand"
                        : "text-body hover:bg-default hover:text-ink"
                    }`}
                  >
                    {TAB_LABELS[key]}
                  </button>
                ))}
              </div>
            ))}
            {!groups.length && (
              <p className="px-2 text-sm text-muted">No master matches “{q}”.</p>
            )}
          </div>
        </nav>

      <div className="min-w-0 flex-1">
      {tab === "items" && <ItemsTab />}
      {tab === "categories" && <CategoriesTab cats={catOpts} />}
      {tab === "general-names" && <GeneralNamesTab />}
      {tab === "item-classes" && <ItemClassesTab />}
      {tab === "hsn-codes" && <HsnCodesTab />}
      {tab === "item-sub-classes" && <ItemSubClassesTab />}
      {tab === "brands" && <BrandsTab />}
      {tab === "manufacturers" && <NamedLookupTab title="Manufacturer" queryKey="manufacturers" api={mastersApi.manufacturers} managePerm="master.brand.manage" />}
      {tab === "dosage-forms" && <NamedLookupTab title="Dosage form" queryKey="dosage-forms" api={mastersApi.dosageForms} />}
      {tab === "features" && <FeaturesTab />}
      {tab === "packaging" && <PackagingTab />}
      {tab === "item-groups" && <ItemGroupsTab items={itemOpts} />}
      {tab === "attributes" && <AttributesTab uoms={uomOpts} />}
      {tab === "specs" && <SpecsTab uoms={uomOpts} />}
      {tab === "category-tags" && <CategoryTaggingTab categories={catOpts} />}
      {tab === "boms" && <BomsTab projects={projectOpts} />}
      {/* Its two dropdowns (BOMs, job profiles) are read by this tab alone, so it
          fetches them itself rather than joining the shared NEEDS sources above. */}
      {tab === "bom-groups" && <BomGroupsTab />}
      {tab === "uom" && <UomTab />}
      {tab === "conversions" && <ConversionsTab uoms={uomOpts} />}
      {tab === "warehouses" && <WarehousesTab facilities={facOpts} />}
      {tab === "projects" && <ProjectsTab />}
      {tab === "vendors" && <VendorsTab />}
      {tab === "vendor-items" && <VendorItemsTab items={itemOpts} />}
      {/* Which items a role or a region may raise an indent for. Untagged
          items stay open to everyone, so this screen only ever narrows. */}
      {tab === "item-eligibility" && <ItemEligibilityTab items={itemOpts} />}
      {tab === "departments" && (
        <ReadOnlyTab<RefRow>
          title="Departments" fetchList={mastersApi.departments}
          columns={[
            { key: "code", header: "Code", render: (r) => <Code>{r.code ?? "—"}</Code> },
            { key: "name", header: "Name", render: (r) => r.name },
          ]}
          renderCard={(r) => <div className="text-sm text-body">{r.name}</div>}
        />
      )}
      {tab === "facilities" && (
        <ReadOnlyTab<RefRow>
          title="Facilities" fetchList={mastersApi.facilities}
          columns={[
            { key: "name", header: "Name", render: (r) => r.name },
            { key: "stock", header: "", render: (r) => r.is_stock_location
                ? <span className="rounded-full bg-brand-050 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-brand">Stock location</span>
                : (r.code ?? "—") },
          ]}
          renderCard={(r) => <div className="text-sm text-body">{r.name}</div>}
        />
      )}
      </div>
      </div>
    </>
  );
}
