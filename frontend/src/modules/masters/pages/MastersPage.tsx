import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Tab, Tabs } from "@heroui/react";
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

const TAB_LABELS: Record<(typeof TABS)[number], string> = {
  items: "Items", categories: "Categories", "item-classes": "Item Classes",
  "general-names": "General Names", "item-sub-classes": "Item Subclasses",
  brands: "Brands", manufacturers: "Manufacturers",
  "dosage-forms": "Dosage Forms", "hsn-codes": "HSN Codes",
  features: "Features", packaging: "Packages", "item-groups": "Item Groups",
  attributes: "Attributes", specs: "Specs", "category-tags": "Category Tagging",
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
  // The tab lives in the URL so refresh and Back keep your place, and so a link to
  // ?tab=vendors opens on Vendors rather than on Items.
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get("tab") ?? "";
  const tab = (TABS as readonly string[]).includes(fromUrl) ? fromUrl : "items";
  const setTab = (next: string) => {
    // replace, not push: clicking through six masters should not mean six Backs to
    // leave the screen.
    setParams(next === "items" ? {} : { tab: next }, { replace: true });
  };

  // Twenty-five tabs wrap to four rows, which pushes the chosen master's list below
  // the fold — picking a tab and then scrolling to find what you picked. Scroll the
  // content up instead. Skipped on first paint so landing on Masters does not jump.
  const contentRef = useRef<HTMLDivElement>(null);
  const landed = useRef(false);
  useEffect(() => {
    if (!landed.current) { landed.current = true; return; }
    contentRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [tab]);

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
      <PageHeader eyebrow="Masters" title="Master data" />
      <Tabs
        aria-label="Master type"
        variant="solid" color="primary" radius="full"
        selectedKey={tab} onSelectionChange={(k) => setTab(String(k))}
        classNames={{ base: "mb-5", tabList: "bg-content2 p-1 flex-wrap" }}
      >
        {TABS.map((key) => <Tab key={key} title={TAB_LABELS[key]} />)}
      </Tabs>

      <div ref={contentRef} className="scroll-mt-4">
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
    </>
  );
}
