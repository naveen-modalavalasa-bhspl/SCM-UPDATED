import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Tab, Tabs } from "@heroui/react";
import { PageHeader, type Column } from "@/shared/components";
import { mastersApi } from "../api";
import { MasterCrud, type Option } from "../components/MasterCrud";
import type {
  DocSeries, MasterBin, MasterCategory, MasterItem, MasterRole, MasterUom,
  MasterUomConversion, MasterVendor, MasterWarehouse, Project, RefRow,
} from "../types";

const Active = ({ on }: { on: boolean }) => (
  <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
    on ? "bg-ok-bg text-ok" : "bg-default text-muted"
  }`}>
    <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-ok" : "bg-muted"}`} />
    {on ? "Active" : "Inactive"}
  </span>
);

const Code = ({ children }: { children: React.ReactNode }) => (
  <span className="mono font-semibold text-ink">{children}</span>
);

const WAREHOUSE_TYPES: Option[] = ["MAIN", "TRANSIT", "QUARANTINE", "SCRAP"]
  .map((v) => ({ value: v, label: v }));
const BIN_TYPES: Option[] = ["ZONE", "RACK", "SHELF", "STORAGE", "STAGING"]
  .map((v) => ({ value: v, label: v }));
const RESET_POLICIES: Option[] = ["NEVER", "YEARLY", "MONTHLY"]
  .map((v) => ({ value: v, label: v }));

function ItemsTab({ uoms, cats }: { uoms: Option[]; cats: Option[] }) {
  const columns: Column<MasterItem>[] = [
    { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
    { key: "name", header: "Name", render: (r) => r.name },
    { key: "cat", header: "Category", render: (r) => r.category_name ?? "—", hideOnNarrow: true },
    { key: "uom", header: "UOM", render: (r) => r.uom_code ?? "—", hideOnNarrow: true },
    { key: "hsn", header: "HSN", render: (r) => r.hsn_code ?? "—", hideOnNarrow: true },
    { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
  ];
  return (
    <MasterCrud<MasterItem>
      title="Item" queryKey="items" searchable managePerm="master.item.manage"
      columns={columns}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Code>{r.code}</Code><Active on={r.is_active} />
          </div>
          <div className="text-sm text-body">{r.name}</div>
          <div className="text-xs text-muted">{r.category_name ?? "—"} · {r.uom_code ?? "—"}</div>
        </div>
      )}
      fetchList={(search) => mastersApi.items.list({ search, size: 100 }).then((p) => p.items)}
      fields={[
        { key: "code", label: "Code", required: true },
        { key: "name", label: "Name", required: true },
        { key: "short_name", label: "Short name" },
        { key: "category_id", label: "Category", type: "select", options: cats },
        { key: "uom_id", label: "Unit of measure", type: "select", options: uoms },
        { key: "item_type", label: "Item type" },
        { key: "hsn_code", label: "HSN code" },
        { key: "tax_percent", label: "Tax %", type: "number" },
        { key: "is_batch_tracked", label: "Batch tracked", type: "switch" },
        { key: "is_serial_tracked", label: "Serial tracked", type: "switch" },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ code: "", name: "", short_name: "", category_id: null, uom_id: null,
                   item_type: "", hsn_code: "", tax_percent: null,
                   is_batch_tracked: false, is_serial_tracked: false, is_active: true }}
      toForm={(r) => ({ code: r.code, name: r.name, short_name: r.short_name ?? "",
        category_id: r.category_id ?? null, uom_id: r.uom_id ?? null, item_type: r.item_type ?? "",
        hsn_code: r.hsn_code ?? "", tax_percent: r.tax_percent ?? null,
        is_batch_tracked: r.is_batch_tracked ?? false,
        is_serial_tracked: r.is_serial_tracked ?? false, is_active: r.is_active })}
      onCreate={(v) => mastersApi.items.create(v as Partial<MasterItem>)}
      onUpdate={(id, v) => mastersApi.items.update(id, v as Partial<MasterItem>)}
      onDeactivate={mastersApi.items.deactivate}
    />
  );
}

function CategoriesTab({ cats }: { cats: Option[] }) {
  const columns: Column<MasterCategory>[] = [
    { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
    { key: "name", header: "Name", render: (r) => r.name },
    { key: "level", header: "Level", render: (r) => r.level ?? "—", hideOnNarrow: true },
    { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
  ];
  return (
    <MasterCrud<MasterCategory>
      title="Category" queryKey="categories" searchable managePerm="master.category.manage"
      columns={columns}
      renderCard={(r) => (
        <div className="flex items-center justify-between">
          <div><Code>{r.code}</Code><div className="text-sm text-body">{r.name}</div></div>
          <Active on={r.is_active} />
        </div>
      )}
      fetchList={(search) => mastersApi.categories.list({ search, size: 200 }).then((p) => p.items)}
      fields={[
        { key: "code", label: "Code", required: true },
        { key: "name", label: "Name", required: true },
        { key: "parent_id", label: "Parent category", type: "select", options: cats },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ code: "", name: "", parent_id: null, is_active: true }}
      toForm={(r) => ({ code: r.code, name: r.name, parent_id: r.parent_id ?? null, is_active: r.is_active })}
      onCreate={(v) => mastersApi.categories.create(v as Partial<MasterCategory>)}
      onUpdate={(id, v) => mastersApi.categories.update(id, v as Partial<MasterCategory>)}
      onDeactivate={mastersApi.categories.deactivate}
    />
  );
}

function WarehousesTab({ facilities }: { facilities: Option[] }) {
  const columns: Column<MasterWarehouse>[] = [
    { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
    { key: "name", header: "Name", render: (r) => r.name },
    { key: "type", header: "Type", render: (r) => r.warehouse_type, hideOnNarrow: true },
    { key: "facility", header: "Facility", render: (r) => r.facility_name ?? "—", hideOnNarrow: true },
    { key: "bins", header: "Bins", hideOnNarrow: true,
      render: (r) => r.is_bin_managed ? "Bin-managed" : "Bulk" },
    { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
  ];
  return (
    <MasterCrud<MasterWarehouse>
      title="Warehouse" queryKey="warehouses" searchable managePerm="master.location.manage"
      columns={columns}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Code>{r.code}</Code><Active on={r.is_active} />
          </div>
          <div className="text-sm text-body">{r.name}</div>
          <div className="text-xs text-muted">
            {r.warehouse_type} · {r.is_bin_managed ? "Bin-managed" : "Bulk"}
          </div>
        </div>
      )}
      fetchList={(search) => mastersApi.warehouses.list({ search, size: 100 }).then((p) => p.items)}
      fields={[
        { key: "code", label: "Code", required: true },
        { key: "name", label: "Name", required: true },
        { key: "warehouse_type", label: "Type", type: "select", options: WAREHOUSE_TYPES },
        { key: "facility_id", label: "Facility", type: "select", options: facilities },
        { key: "address", label: "Address" },
        { key: "is_bin_managed", label: "Bin managed", type: "switch" },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ code: "", name: "", warehouse_type: "MAIN", facility_id: null,
                   address: "", is_bin_managed: false, is_active: true }}
      toForm={(r) => ({ code: r.code, name: r.name, warehouse_type: r.warehouse_type,
        facility_id: r.facility_id ?? null, address: r.address ?? "",
        is_bin_managed: r.is_bin_managed, is_active: r.is_active })}
      onCreate={(v) => mastersApi.warehouses.create(v as Partial<MasterWarehouse>)}
      onUpdate={(id, v) => mastersApi.warehouses.update(id, v as Partial<MasterWarehouse>)}
      onDeactivate={mastersApi.warehouses.deactivate}
    />
  );
}

function BinsTab({ warehouses, bins }: { warehouses: Option[]; bins: Option[] }) {
  const columns: Column<MasterBin>[] = [
    // `path` shows the ancestry, which is why the tree needs no expand/collapse.
    { key: "path", header: "Path", render: (r) => <Code>{r.path ?? r.code}</Code> },
    { key: "name", header: "Name", render: (r) => r.name ?? "—" },
    { key: "type", header: "Type", render: (r) => r.bin_type, hideOnNarrow: true },
    { key: "level", header: "Level", render: (r) => r.level, hideOnNarrow: true },
    { key: "pick", header: "Pickable", hideOnNarrow: true,
      render: (r) => (r.is_pickable ? "Yes" : "No") },
    { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
  ];
  return (
    <MasterCrud<MasterBin>
      title="Bin" queryKey="bins" searchable managePerm="master.location.manage"
      columns={columns}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Code>{r.path ?? r.code}</Code><Active on={r.is_active} />
          </div>
          <div className="text-sm text-body">{r.name ?? "—"}</div>
          <div className="text-xs text-muted">{r.bin_type} · level {r.level}</div>
        </div>
      )}
      fetchList={(search) => mastersApi.bins.list({ search, size: 200 }).then((p) => p.items)}
      fields={[
        { key: "warehouse_id", label: "Warehouse", type: "select", options: warehouses, required: true },
        { key: "code", label: "Code", required: true },
        { key: "name", label: "Name" },
        { key: "bin_type", label: "Type", type: "select", options: BIN_TYPES },
        { key: "parent_id", label: "Parent bin", type: "select", options: bins },
        { key: "capacity_qty", label: "Capacity", type: "number" },
        { key: "is_pickable", label: "Pickable", type: "switch" },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ warehouse_id: null, code: "", name: "", bin_type: "STORAGE",
                   parent_id: null, capacity_qty: null, is_pickable: true, is_active: true }}
      toForm={(r) => ({ warehouse_id: r.warehouse_id, code: r.code, name: r.name ?? "",
        bin_type: r.bin_type, parent_id: r.parent_id ?? null,
        capacity_qty: r.capacity_qty ?? null, is_pickable: r.is_pickable,
        is_active: r.is_active })}
      onCreate={(v) => mastersApi.bins.create(v as Partial<MasterBin>)}
      onUpdate={(id, v) => mastersApi.bins.update(id, v as Partial<MasterBin>)}
      onDeactivate={mastersApi.bins.deactivate}
    />
  );
}

function ProjectsTab() {
  const columns: Column<Project>[] = [
    { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
    { key: "name", header: "Name", render: (r) => r.name },
    { key: "office", header: "Office", render: (r) => r.office_name ?? "—", hideOnNarrow: true },
    { key: "dates", header: "Dates", hideOnNarrow: true,
      render: (r) => `${r.start_date ?? "—"} → ${r.end_date ?? "—"}` },
    { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
  ];
  return (
    <MasterCrud<Project>
      title="Project" queryKey="projects" searchable managePerm="master.project.manage"
      columns={columns}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Code>{r.code}</Code><Active on={r.is_active} />
          </div>
          <div className="text-sm text-body">{r.name}</div>
        </div>
      )}
      fetchList={(search) => mastersApi.projects.list({ search, size: 100 }).then((p) => p.items)}
      fields={[
        { key: "code", label: "Code", required: true },
        { key: "name", label: "Name", required: true },
        { key: "start_date", label: "Start date (YYYY-MM-DD)" },
        { key: "end_date", label: "End date (YYYY-MM-DD)" },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ code: "", name: "", start_date: "", end_date: "", is_active: true }}
      toForm={(r) => ({ code: r.code, name: r.name, start_date: r.start_date ?? "",
        end_date: r.end_date ?? "", is_active: r.is_active })}
      onCreate={(v) => mastersApi.projects.create(v as Partial<Project>)}
      onUpdate={(id, v) => mastersApi.projects.update(id, v as Partial<Project>)}
      onDeactivate={mastersApi.projects.deactivate}
    />
  );
}

function VendorsTab() {
  const columns: Column<MasterVendor>[] = [
    { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
    { key: "name", header: "Name", render: (r) => r.name },
    { key: "contact", header: "Contact", render: (r) => r.contact_person ?? "—", hideOnNarrow: true },
    { key: "phone", header: "Phone", render: (r) => r.phone ?? "—", hideOnNarrow: true },
    { key: "gstin", header: "GSTIN", render: (r) => r.gstin ?? "—", hideOnNarrow: true },
    { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
  ];
  return (
    <MasterCrud<MasterVendor>
      title="Vendor" queryKey="vendors" searchable managePerm="master.vendor.manage"
      columns={columns}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Code>{r.code}</Code><Active on={r.is_active} />
          </div>
          <div className="text-sm text-body">{r.name}</div>
          <div className="text-xs text-muted">{r.contact_person ?? "—"} · {r.phone ?? "—"}</div>
        </div>
      )}
      fetchList={(search) => mastersApi.vendors.list({ search, size: 100 }).then((p) => p.items)}
      fields={[
        { key: "code", label: "Code", required: true },
        { key: "name", label: "Name", required: true },
        { key: "contact_person", label: "Contact person" },
        { key: "phone", label: "Phone" },
        { key: "email", label: "Email" },
        { key: "city", label: "City" },
        { key: "state", label: "State" },
        { key: "gstin", label: "GSTIN" },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ code: "", name: "", contact_person: "", phone: "", email: "", city: "",
                   state: "", gstin: "", is_active: true }}
      toForm={(r) => ({ code: r.code, name: r.name, contact_person: r.contact_person ?? "",
        phone: r.phone ?? "", email: r.email ?? "", city: r.city ?? "", state: r.state ?? "",
        gstin: r.gstin ?? "", is_active: r.is_active })}
      onCreate={(v) => mastersApi.vendors.create(v as Partial<MasterVendor>)}
      onUpdate={(id, v) => mastersApi.vendors.update(id, v as Partial<MasterVendor>)}
      onDeactivate={mastersApi.vendors.deactivate}
    />
  );
}

function UomTab() {
  const columns: Column<MasterUom>[] = [
    { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
    { key: "name", header: "Name", render: (r) => r.name },
    { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
  ];
  return (
    <MasterCrud<MasterUom>
      title="UOM" queryKey="uom" managePerm="master.uom.manage"
      columns={columns}
      renderCard={(r) => (
        <div className="flex items-center justify-between">
          <div><Code>{r.code}</Code><span className="ml-2 text-sm text-body">{r.name}</span></div>
          <Active on={r.is_active} />
        </div>
      )}
      fetchList={() => mastersApi.uom.listAll()}
      fields={[
        { key: "code", label: "Code", required: true },
        { key: "name", label: "Name", required: true },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ code: "", name: "", is_active: true }}
      toForm={(r) => ({ code: r.code, name: r.name, is_active: r.is_active })}
      onCreate={(v) => mastersApi.uom.create(v as Partial<MasterUom>)}
      onUpdate={(id, v) => mastersApi.uom.update(id, v as Partial<MasterUom>)}
      onDeactivate={mastersApi.uom.deactivate}
    />
  );
}

function ConversionsTab({ uoms }: { uoms: Option[] }) {
  const label = (id: number) => uoms.find((u) => u.value === id)?.label ?? `#${id}`;
  const columns: Column<MasterUomConversion>[] = [
    { key: "from", header: "From", render: (r) => label(r.from_uom_id) },
    { key: "to", header: "To", render: (r) => label(r.to_uom_id) },
    { key: "factor", header: "Factor", render: (r) => <Code>{r.factor}</Code> },
  ];
  return (
    <MasterCrud<MasterUomConversion>
      title="UOM conversion" queryKey="uom-conversions" managePerm="master.uom.manage"
      columns={columns}
      renderCard={(r) => (
        <div className="text-sm text-body">
          1 {label(r.from_uom_id)} = <Code>{r.factor}</Code> {label(r.to_uom_id)}
        </div>
      )}
      fetchList={() => mastersApi.uomConversions.listAll()}
      fields={[
        { key: "from_uom_id", label: "From UOM", type: "select", options: uoms, required: true },
        { key: "to_uom_id", label: "To UOM", type: "select", options: uoms, required: true },
        { key: "factor", label: "How many of 'to' in one 'from'", type: "number", required: true },
      ]}
      emptyForm={{ from_uom_id: null, to_uom_id: null, factor: null }}
      toForm={(r) => ({ from_uom_id: r.from_uom_id, to_uom_id: r.to_uom_id, factor: r.factor })}
      onCreate={(v) => mastersApi.uomConversions.create(v as Partial<MasterUomConversion>)}
      onUpdate={(id, v) => mastersApi.uomConversions.update(id, v as Partial<MasterUomConversion>)}
      /* mst_uom_conversions has no is_active column, so there is nothing to deactivate. */
    />
  );
}

function NumberingTab() {
  const columns: Column<DocSeries>[] = [
    { key: "doc", header: "Document", render: (r) => <Code>{r.doc_type}</Code> },
    { key: "fy", header: "Fiscal year", render: (r) => r.fiscal_year },
    { key: "pattern", header: "Pattern", render: (r) => <Code>{r.pattern}</Code>, hideOnNarrow: true },
    // The server renders the preview, so what is shown is what will be issued.
    { key: "preview", header: "Next number", render: (r) => <Code>{r.preview}</Code> },
    { key: "reset", header: "Resets", render: (r) => r.reset_policy, hideOnNarrow: true },
    { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
  ];
  return (
    <MasterCrud<DocSeries>
      title="Numbering series" queryKey="doc-series" managePerm="admin.numbering.manage"
      columns={columns}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Code>{r.doc_type}</Code><Active on={r.is_active} />
          </div>
          <div className="text-sm text-body">Next: <Code>{r.preview}</Code></div>
          <div className="text-xs text-muted">{r.fiscal_year} · resets {r.reset_policy}</div>
        </div>
      )}
      fetchList={() => mastersApi.docSeries.listAll()}
      fields={[
        { key: "doc_type", label: "Document type (INDENT/PO/GRN/ISSUE)", required: true },
        { key: "fiscal_year", label: "Fiscal year", required: true },
        { key: "prefix", label: "Prefix", required: true },
        { key: "pattern", label: "Pattern", placeholder: "{PREFIX}/{FY}/{SEQ:5}" },
        { key: "reset_policy", label: "Reset", type: "select", options: RESET_POLICIES },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      /* last_number is deliberately absent: rewinding it would reissue a number
         that a live document already carries. */
      emptyForm={{ doc_type: "", fiscal_year: "", prefix: "",
                   pattern: "{PREFIX}/{FY}/{SEQ:5}", reset_policy: "NEVER", is_active: true }}
      toForm={(r) => ({ doc_type: r.doc_type, fiscal_year: r.fiscal_year, prefix: r.prefix,
        pattern: r.pattern, reset_policy: r.reset_policy, is_active: r.is_active })}
      onCreate={(v) => mastersApi.docSeries.create(v as Partial<DocSeries>)}
      onUpdate={(id, v) => mastersApi.docSeries.update(id, v as Partial<DocSeries>)}
      onDeactivate={mastersApi.docSeries.deactivate}
    />
  );
}

/** Read-only lists: roles, and the HCM mirrors (rule 10 — sync owns those tables). */
function ReadOnlyTab<T extends { id: number }>(
  { title, fetchList, columns, renderCard }: {
    title: string;
    fetchList: () => Promise<T[]>;
    columns: Column<T>[];
    renderCard: (r: T) => React.ReactNode;
  },
) {
  return (
    <MasterCrud<T>
      title={title} queryKey={title.toLowerCase().replace(/\s+/g, "-")}
      readOnly managePerm="" columns={columns} renderCard={renderCard}
      fetchList={fetchList} fields={[]} emptyForm={{}} toForm={() => ({})}
      onCreate={async () => undefined} onUpdate={async () => undefined}
    />
  );
}

const TABS = [
  "items", "categories", "uom", "conversions", "warehouses", "bins",
  "projects", "vendors", "roles", "numbering", "departments", "facilities",
] as const;

const TAB_LABELS: Record<(typeof TABS)[number], string> = {
  items: "Items", categories: "Categories", uom: "UOM", conversions: "Conversions",
  warehouses: "Warehouses", bins: "Bins", projects: "Projects", vendors: "Vendors",
  roles: "Roles", numbering: "Numbering", departments: "Departments",
  facilities: "Facilities",
};

export function MastersPage() {
  const [tab, setTab] = useState<string>("items");

  // Dropdown sources, fetched once for the whole screen rather than per tab.
  const uom = useQuery({ queryKey: ["masters", "uom"], queryFn: mastersApi.uom.listAll });
  const cats = useQuery({
    queryKey: ["masters", "categories-all"],
    queryFn: () => mastersApi.categories.list({ size: 200 }).then((p) => p.items),
  });
  const warehouses = useQuery({
    queryKey: ["masters", "warehouses-all"],
    queryFn: () => mastersApi.warehouses.list({ size: 200 }).then((p) => p.items),
  });
  const bins = useQuery({
    queryKey: ["masters", "bins-all"],
    queryFn: () => mastersApi.bins.list({ size: 500 }).then((p) => p.items),
  });
  const facilities = useQuery({
    queryKey: ["masters", "facilities"], queryFn: mastersApi.facilities,
  });

  const uomOpts: Option[] = (uom.data ?? []).map((u) => ({ value: u.id, label: `${u.code} — ${u.name}` }));
  const catOpts: Option[] = (cats.data ?? []).map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` }));
  const whOpts: Option[] = (warehouses.data ?? []).map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` }));
  const binOpts: Option[] = (bins.data ?? []).map((b) => ({ value: b.id, label: b.path ?? b.code }));
  const facOpts: Option[] = (facilities.data ?? []).map((f) => ({ value: f.id, label: f.name }));

  return (
    <>
      <PageHeader eyebrow="Admin" title="Master data" />
      <Tabs
        aria-label="Master type"
        variant="solid" color="primary" radius="full"
        selectedKey={tab} onSelectionChange={(k) => setTab(String(k))}
        classNames={{ base: "mb-5", tabList: "bg-content2 p-1 flex-wrap" }}
      >
        {TABS.map((key) => <Tab key={key} title={TAB_LABELS[key]} />)}
      </Tabs>

      {tab === "items" && <ItemsTab uoms={uomOpts} cats={catOpts} />}
      {tab === "categories" && <CategoriesTab cats={catOpts} />}
      {tab === "uom" && <UomTab />}
      {tab === "conversions" && <ConversionsTab uoms={uomOpts} />}
      {tab === "warehouses" && <WarehousesTab facilities={facOpts} />}
      {tab === "bins" && <BinsTab warehouses={whOpts} bins={binOpts} />}
      {tab === "projects" && <ProjectsTab />}
      {tab === "vendors" && <VendorsTab />}
      {tab === "numbering" && <NumberingTab />}
      {tab === "roles" && (
        <ReadOnlyTab<MasterRole>
          title="Roles" fetchList={mastersApi.roles}
          columns={[
            { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
            { key: "name", header: "Name", render: (r) => r.name },
            { key: "desc", header: "Description", render: (r) => r.description ?? "—", hideOnNarrow: true },
            { key: "sys", header: "", render: (r) => (r.is_system ? "System" : ""), hideOnNarrow: true },
            { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
          ]}
          renderCard={(r) => (
            <div className="flex items-center justify-between">
              <div><Code>{r.code}</Code><div className="text-sm text-body">{r.name}</div></div>
              <Active on={r.is_active} />
            </div>
          )}
        />
      )}
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
    </>
  );
}
