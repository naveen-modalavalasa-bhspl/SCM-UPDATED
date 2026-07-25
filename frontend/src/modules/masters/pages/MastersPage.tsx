import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Tab, Tabs } from "@heroui/react";
import { PageHeader, type Column } from "@/shared/components";
import { mastersApi } from "../api";
import { MasterCrud, type Option } from "../components/MasterCrud";
import type {
  MasterCategory, MasterItem, MasterUom, MasterVendor, RefRow,
} from "../types";

const Active = ({ on }: { on: boolean }) => (
  <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
    on ? "bg-ok-bg text-ok" : "bg-default text-muted"
  }`}>
    <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-ok" : "bg-muted"}`} />
    {on ? "Active" : "Inactive"}
  </span>
);

function ItemsTab({ uoms, cats }: { uoms: Option[]; cats: Option[] }) {
  const columns: Column<MasterItem>[] = [
    { key: "code", header: "Code", render: (r) => <span className="mono font-semibold text-ink">{r.code}</span> },
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
            <span className="mono font-semibold text-ink">{r.code}</span><Active on={r.is_active} />
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
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ code: "", name: "", short_name: "", category_id: null, uom_id: null,
                   item_type: "", hsn_code: "", tax_percent: null, is_active: true }}
      toForm={(r) => ({ code: r.code, name: r.name, short_name: r.short_name ?? "",
        category_id: r.category_id ?? null, uom_id: r.uom_id ?? null, item_type: r.item_type ?? "",
        hsn_code: r.hsn_code ?? "", tax_percent: r.tax_percent ?? null, is_active: r.is_active })}
      onCreate={(v) => mastersApi.items.create(v as Partial<MasterItem>)}
      onUpdate={(id, v) => mastersApi.items.update(id, v as Partial<MasterItem>)}
    />
  );
}

function CategoriesTab({ cats }: { cats: Option[] }) {
  const columns: Column<MasterCategory>[] = [
    { key: "code", header: "Code", render: (r) => <span className="mono font-semibold text-ink">{r.code}</span> },
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
          <div><span className="mono font-semibold text-ink">{r.code}</span>
            <div className="text-sm text-body">{r.name}</div></div>
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
    />
  );
}

function VendorsTab() {
  const columns: Column<MasterVendor>[] = [
    { key: "code", header: "Code", render: (r) => <span className="mono font-semibold text-ink">{r.code}</span> },
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
            <span className="mono font-semibold text-ink">{r.code}</span><Active on={r.is_active} />
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
    />
  );
}

function UomTab() {
  const columns: Column<MasterUom>[] = [
    { key: "code", header: "Code", render: (r) => <span className="mono font-semibold text-ink">{r.code}</span> },
    { key: "name", header: "Name", render: (r) => r.name },
    { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
  ];
  return (
    <MasterCrud<MasterUom>
      title="UOM" queryKey="uom" managePerm="master.uom.manage"
      columns={columns}
      renderCard={(r) => (
        <div className="flex items-center justify-between">
          <div><span className="mono font-semibold text-ink">{r.code}</span>
            <span className="ml-2 text-sm text-body">{r.name}</span></div>
          <Active on={r.is_active} />
        </div>
      )}
      fetchList={() => mastersApi.uom.list()}
      fields={[
        { key: "code", label: "Code", required: true },
        { key: "name", label: "Name", required: true },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ code: "", name: "", is_active: true }}
      toForm={(r) => ({ code: r.code, name: r.name, is_active: r.is_active })}
      onCreate={(v) => mastersApi.uom.create(v as Partial<MasterUom>)}
      onUpdate={(id, v) => mastersApi.uom.update(id, v as Partial<MasterUom>)}
    />
  );
}

function RefTab({ title, fetchList }: { title: string; fetchList: () => Promise<RefRow[]> }) {
  const columns: Column<RefRow>[] = [
    { key: "name", header: "Name", render: (r) => r.name },
    { key: "extra", header: "", render: (r) =>
        r.is_stock_location
          ? <span className="rounded-full bg-brand-050 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-brand">Stock location</span>
          : (r.code ?? "—") },
  ];
  return (
    <MasterCrud<RefRow>
      title={title} queryKey={title.toLowerCase()} readOnly managePerm=""
      columns={columns}
      renderCard={(r) => <div className="text-sm text-body">{r.name}</div>}
      fetchList={fetchList}
      fields={[]} emptyForm={{}} toForm={() => ({})}
      onCreate={async () => undefined} onUpdate={async () => undefined}
    />
  );
}

export function MastersPage() {
  const [tab, setTab] = useState("items");
  // Dropdown sources for item/category forms.
  const uom = useQuery({ queryKey: ["masters", "uom"], queryFn: mastersApi.uom.list });
  const cats = useQuery({
    queryKey: ["masters", "categories-all"],
    queryFn: () => mastersApi.categories.list({ size: 200 }).then((p) => p.items),
  });
  const uomOpts: Option[] = (uom.data ?? []).map((u) => ({ value: u.id, label: `${u.code} — ${u.name}` }));
  const catOpts: Option[] = (cats.data ?? []).map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` }));

  return (
    <>
      <PageHeader eyebrow="Admin" title="Master data" />
      <Tabs
        aria-label="Master type"
        variant="solid" color="primary" radius="full"
        selectedKey={tab} onSelectionChange={(k) => setTab(String(k))}
        classNames={{ base: "mb-5", tabList: "bg-content2 p-1 flex-wrap" }}
      >
        <Tab key="items" title="Items" />
        <Tab key="categories" title="Categories" />
        <Tab key="vendors" title="Vendors" />
        <Tab key="uom" title="UOM" />
        <Tab key="departments" title="Departments" />
        <Tab key="facilities" title="Facilities" />
      </Tabs>

      {tab === "items" && <ItemsTab uoms={uomOpts} cats={catOpts} />}
      {tab === "categories" && <CategoriesTab cats={catOpts} />}
      {tab === "vendors" && <VendorsTab />}
      {tab === "uom" && <UomTab />}
      {tab === "departments" && <RefTab title="Departments" fetchList={mastersApi.departments} />}
      {tab === "facilities" && <RefTab title="Facilities" fetchList={mastersApi.facilities} />}
    </>
  );
}
