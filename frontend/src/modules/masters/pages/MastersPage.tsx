import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Tab, Tabs } from "@heroui/react";
import { PageHeader, type Column } from "@/shared/components";
import { mastersApi } from "../api";
import { MasterCrud, type Option } from "../components/MasterCrud";
import { ItemMasterTab } from "../components/ItemMasterTab";
import type {
  MasterAttribute, MasterAttributeMapping, MasterBin, MasterBom,
  MasterBrand, MasterCategory, MasterFeature, MasterItemClass,
  MasterPackaging, MasterPriceList, MasterUom, MasterUomConversion,
  MasterVendor, MasterWarehouse, Project, RefRow, NamedMaster,
  MasterBrandManufacturer, MasterItemSubClass,
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
function ItemsTab() {
  return <ItemMasterTab />;
}

function NamedLookupTab({
  title, queryKey, api, managePerm = "master.item.manage",
}: {
  title: string;
  queryKey: string;
  managePerm?: string;
  api: {
    list: (p?: {
      search?: string; page?: number; size?: number; include_inactive?: boolean;
      [filter: string]: string | number | boolean | undefined;
    }) => Promise<{ items: NamedMaster[] }>;
    create: (v: Partial<NamedMaster>) => Promise<NamedMaster>;
    update: (id: number, v: Partial<NamedMaster>) => Promise<NamedMaster>;
    deactivate: (id: number) => Promise<unknown>;
  };
}) {
  return <MasterCrud<NamedMaster>
    title={title} queryKey={queryKey} searchable managePerm={managePerm}
    columns={[
      { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
      { key: "name", header: "Name", render: (r) => r.name },
      { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
    ]}
    renderCard={(r) => <div><Code>{r.code}</Code><div>{r.name}</div></div>}
    fetchList={(search) => api.list({ search, size: 300 }).then((r) => r.items)}
    fields={[{key:"code",label:"Code",required:true},{key:"name",label:"Name",required:true},
      {key:"description",label:"Description"},{key:"is_active",label:"Active",type:"switch"}]}
    emptyForm={{code:"",name:"",description:"",is_active:true}}
    toForm={(r)=>({code:r.code,name:r.name,description:r.description??"",is_active:r.is_active})}
    onCreate={(v)=>api.create(v as Partial<NamedMaster>)}
    onUpdate={(id,v)=>api.update(id,v as Partial<NamedMaster>)}
    onDeactivate={api.deactivate}
  />;
}

function BrandManufacturersTab() {
  const brands = useQuery({queryKey:["masters","brands-map"],queryFn:()=>mastersApi.brands.list({size:300}).then(r=>r.items)});
  const manufacturers = useQuery({queryKey:["masters","manufacturers-map"],queryFn:()=>mastersApi.manufacturers.list({size:300}).then(r=>r.items)});
  const brandOpts = (brands.data??[]).map(r=>({value:r.id,label:`${r.code} — ${r.name}`}));
  const manufacturerOpts = (manufacturers.data??[]).map(r=>({value:r.id,label:`${r.code} — ${r.name}`}));
  return <MasterCrud<MasterBrandManufacturer>
    title="Brand / Manufacturer mapping" queryKey="brand-manufacturers"
    managePerm="master.brand.manage"
    columns={[
      {key:"brand",header:"Brand",render:r=>r.brand_name??"—"},
      {key:"manufacturer",header:"Manufacturer",render:r=>r.manufacturer_name??"—"},
      {key:"active",header:"Status",render:r=><Active on={r.is_active}/>}
    ]}
    renderCard={r=><div>{r.brand_name} — {r.manufacturer_name}</div>}
    fetchList={()=>mastersApi.brandManufacturers.list({size:500}).then(r=>r.items)}
    fields={[
      {key:"brand_id",label:"Brand",type:"select",options:brandOpts,required:true},
      {key:"manufacturer_id",label:"Manufacturer",type:"select",options:manufacturerOpts,required:true},
      {key:"is_active",label:"Active",type:"switch"}]}
    emptyForm={{brand_id:null,manufacturer_id:null,is_active:true}}
    toForm={r=>({brand_id:r.brand_id,manufacturer_id:r.manufacturer_id,is_active:r.is_active})}
    onCreate={v=>mastersApi.brandManufacturers.create(v as Partial<MasterBrandManufacturer>)}
    onUpdate={(id,v)=>mastersApi.brandManufacturers.update(id,v as Partial<MasterBrandManufacturer>)}
    onDeactivate={mastersApi.brandManufacturers.deactivate}
  />;
}

function ItemSubClassesTab() {
  const classes=useQuery({queryKey:["masters","classes-sub"],queryFn:()=>mastersApi.itemClasses.list({size:300}).then(r=>r.items)});
  const classOpts=(classes.data??[]).map(r=>({value:r.id,label:`${r.code} — ${r.name}`}));
  return <MasterCrud<MasterItemSubClass>
    title="Item subclass" queryKey="item-subclasses" searchable managePerm="master.class.manage"
    columns={[{key:"code",header:"Code",render:r=><Code>{r.code}</Code>},
      {key:"name",header:"Name",render:r=>r.name},
      {key:"class",header:"Item Class",render:r=>r.item_class_name??"—"}]}
    renderCard={r=><div><Code>{r.code}</Code><div>{r.name}</div></div>}
    fetchList={search=>mastersApi.itemSubClasses.list({search,size:300}).then(r=>r.items)}
    fields={[{key:"item_class_id",label:"Item Class",type:"select",options:classOpts,required:true},
      {key:"code",label:"Code",required:true},{key:"name",label:"Name",required:true},
      {key:"description",label:"Description"},{key:"is_active",label:"Active",type:"switch"}]}
    emptyForm={{item_class_id:null,code:"",name:"",description:"",is_active:true}}
    toForm={r=>({item_class_id:r.item_class_id,code:r.code,name:r.name,description:r.description??"",is_active:r.is_active})}
    onCreate={v=>mastersApi.itemSubClasses.create(v as Partial<MasterItemSubClass>)}
    onUpdate={(id,v)=>mastersApi.itemSubClasses.update(id,v as Partial<MasterItemSubClass>)}
    onDeactivate={mastersApi.itemSubClasses.deactivate}
  />;
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

function BrandsTab() {
  return (
    <MasterCrud<MasterBrand>
      title="Brand" queryKey="brands" searchable managePerm="master.brand.manage"
      columns={[
        { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
        { key: "name", header: "Name", render: (r) => r.name },
        { key: "mfr", header: "Manufacturer", hideOnNarrow: true,
          render: (r) => r.manufacturer ?? "—" },
        { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
      ]}
      renderCard={(r) => (
        <div className="flex items-center justify-between">
          <div><Code>{r.code}</Code><div className="text-sm text-body">{r.name}</div></div>
          <Active on={r.is_active} />
        </div>
      )}
      fetchList={(search) => mastersApi.brands.list({ search, size: 200 }).then((p) => p.items)}
      fields={[
        { key: "code", label: "Code", required: true },
        { key: "name", label: "Name", required: true },
        { key: "manufacturer", label: "Manufacturer" },
        { key: "description", label: "Description" },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ code: "", name: "", manufacturer: "", description: "", is_active: true }}
      toForm={(r) => ({ code: r.code, name: r.name, manufacturer: r.manufacturer ?? "",
        description: r.description ?? "", is_active: r.is_active })}
      onCreate={(v) => mastersApi.brands.create(v as Partial<MasterBrand>)}
      onUpdate={(id, v) => mastersApi.brands.update(id, v as Partial<MasterBrand>)}
      onDeactivate={mastersApi.brands.deactivate}
    />
  );
}

function ItemClassesTab() {
  return (
    <MasterCrud<MasterItemClass>
      title="Item class" queryKey="item-classes" searchable
      managePerm="master.class.manage"
      columns={[
        { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
        { key: "name", header: "Name", render: (r) => r.name },
        // Capitalised classes are assets: they are not consumed when issued.
        { key: "cap", header: "Asset", hideOnNarrow: true,
          render: (r) => (r.is_capitalised ? "Capitalised" : "—") },
        { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
      ]}
      renderCard={(r) => (
        <div className="flex items-center justify-between">
          <div><Code>{r.code}</Code><div className="text-sm text-body">{r.name}</div></div>
          <Active on={r.is_active} />
        </div>
      )}
      fetchList={(search) => mastersApi.itemClasses.list({ search, size: 200 }).then((p) => p.items)}
      fields={[
        { key: "code", label: "Code", required: true },
        { key: "name", label: "Name", required: true },
        { key: "description", label: "Description" },
        { key: "is_capitalised", label: "Capitalised (an asset)", type: "switch" },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ code: "", name: "", description: "", is_capitalised: false, is_active: true }}
      toForm={(r) => ({ code: r.code, name: r.name, description: r.description ?? "",
        is_capitalised: r.is_capitalised, is_active: r.is_active })}
      onCreate={(v) => mastersApi.itemClasses.create(v as Partial<MasterItemClass>)}
      onUpdate={(id, v) => mastersApi.itemClasses.update(id, v as Partial<MasterItemClass>)}
      onDeactivate={mastersApi.itemClasses.deactivate}
    />
  );
}

function FeaturesTab() {
  return (
    <MasterCrud<MasterFeature>
      title="Feature" queryKey="features" searchable managePerm="master.feature.manage"
      columns={[
        { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
        { key: "name", header: "Name", render: (r) => r.name },
        { key: "handling", header: "Handling", hideOnNarrow: true,
          render: (r) => r.affects_handling
            ? <span className="rounded-full bg-warn-bg px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-warn">Affects handling</span>
            : "—" },
        { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
      ]}
      renderCard={(r) => (
        <div className="flex items-center justify-between">
          <div><Code>{r.code}</Code><div className="text-sm text-body">{r.name}</div></div>
          <Active on={r.is_active} />
        </div>
      )}
      fetchList={(search) => mastersApi.features.list({ search, size: 200 }).then((p) => p.items)}
      fields={[
        { key: "code", label: "Code", required: true },
        { key: "name", label: "Name", required: true },
        { key: "description", label: "Description" },
        { key: "affects_handling", label: "Affects handling", type: "switch" },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ code: "", name: "", description: "", affects_handling: false, is_active: true }}
      toForm={(r) => ({ code: r.code, name: r.name, description: r.description ?? "",
        affects_handling: r.affects_handling, is_active: r.is_active })}
      onCreate={(v) => mastersApi.features.create(v as Partial<MasterFeature>)}
      onUpdate={(id, v) => mastersApi.features.update(id, v as Partial<MasterFeature>)}
      onDeactivate={mastersApi.features.deactivate}
    />
  );
}

function PackagingTab({ uoms }: { uoms: Option[] }) {
  return (
    <MasterCrud<MasterPackaging>
      title="Packaging" queryKey="packaging" searchable
      managePerm="master.packaging.manage"
      columns={[
        { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
        { key: "name", header: "Name", render: (r) => r.name },
        { key: "qty", header: "Holds", render: (r) =>
            r.qty_per_pack ? `${r.qty_per_pack} ${r.uom_code ?? ""}`.trim() : "—" },
        { key: "ret", header: "Returnable", hideOnNarrow: true,
          render: (r) => (r.is_returnable ? "Yes" : "No") },
        { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
      ]}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Code>{r.code}</Code><Active on={r.is_active} />
          </div>
          <div className="text-sm text-body">{r.name}</div>
          <div className="text-xs text-muted">
            {r.qty_per_pack ? `Holds ${r.qty_per_pack} ${r.uom_code ?? ""}` : "—"}
          </div>
        </div>
      )}
      fetchList={(search) => mastersApi.packaging.list({ search, size: 200 }).then((p) => p.items)}
      fields={[
        { key: "code", label: "Code", required: true },
        { key: "name", label: "Name", required: true },
        { key: "uom_id", label: "Unit inside the pack", type: "select", options: uoms },
        { key: "qty_per_pack", label: "How many per pack", type: "number" },
        { key: "length_cm", label: "Length (cm)", type: "number" },
        { key: "width_cm", label: "Width (cm)", type: "number" },
        { key: "height_cm", label: "Height (cm)", type: "number" },
        { key: "weight_kg", label: "Weight (kg)", type: "number" },
        { key: "is_returnable", label: "Returnable", type: "switch" },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ code: "", name: "", uom_id: null, qty_per_pack: null, length_cm: null,
                   width_cm: null, height_cm: null, weight_kg: null,
                   is_returnable: false, is_active: true }}
      toForm={(r) => ({ code: r.code, name: r.name, uom_id: r.uom_id ?? null,
        qty_per_pack: r.qty_per_pack ?? null, length_cm: r.length_cm ?? null,
        width_cm: r.width_cm ?? null, height_cm: r.height_cm ?? null,
        weight_kg: r.weight_kg ?? null, is_returnable: r.is_returnable,
        is_active: r.is_active })}
      onCreate={(v) => mastersApi.packaging.create(v as Partial<MasterPackaging>)}
      onUpdate={(id, v) => mastersApi.packaging.update(id, v as Partial<MasterPackaging>)}
      onDeactivate={mastersApi.packaging.deactivate}
    />
  );
}

const DATA_TYPES: Option[] = ["TEXT", "NUMBER", "BOOLEAN", "DATE", "LIST"]
  .map((v) => ({ value: v, label: v }));

function AttributesTab() {
  return (
    <MasterCrud<MasterAttribute>
      title="Attribute" queryKey="attributes" searchable
      managePerm="master.attribute.manage"
      columns={[
        { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
        { key: "name", header: "Name", render: (r) => r.name },
        { key: "type", header: "Type", render: (r) => r.data_type },
        { key: "unit", header: "Unit", hideOnNarrow: true, render: (r) => r.unit ?? "—" },
        { key: "opts", header: "Options", hideOnNarrow: true,
          render: (r) => r.allowed_values?.length ? r.allowed_values.join(", ") : "—" },
        { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
      ]}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Code>{r.code}</Code><Active on={r.is_active} />
          </div>
          <div className="text-sm text-body">{r.name}</div>
          <div className="text-xs text-muted">{r.data_type}{r.unit ? ` · ${r.unit}` : ""}</div>
        </div>
      )}
      fetchList={(search) => mastersApi.attributes.list({ search, size: 200 }).then((p) => p.items)}
      fields={[
        { key: "code", label: "Code", required: true },
        { key: "name", label: "Name", required: true },
        { key: "data_type", label: "Type", type: "select", options: DATA_TYPES },
        { key: "unit", label: "Unit (volts, mm, kg)" },
        { key: "allowed_values_text", label: "Options for LIST, comma separated" },
        { key: "description", label: "Description" },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ code: "", name: "", data_type: "TEXT", unit: "",
                   allowed_values_text: "", description: "", is_active: true }}
      toForm={(r) => ({ code: r.code, name: r.name, data_type: r.data_type,
        unit: r.unit ?? "", allowed_values_text: (r.allowed_values ?? []).join(", "),
        description: r.description ?? "", is_active: r.is_active })}
      // The form takes a comma-separated string; the API wants a list.
      onCreate={(v) => mastersApi.attributes.create(toAttributePayload(v))}
      onUpdate={(id, v) => mastersApi.attributes.update(id, toAttributePayload(v))}
      onDeactivate={mastersApi.attributes.deactivate}
    />
  );
}

function toAttributePayload(v: Record<string, unknown>): Partial<MasterAttribute> {
  const raw = String(v.allowed_values_text ?? "").trim();
  return {
    code: String(v.code ?? ""),
    name: String(v.name ?? ""),
    data_type: v.data_type as MasterAttribute["data_type"],
    unit: (v.unit as string) || null,
    allowed_values: raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [],
    description: (v.description as string) || null,
    is_active: Boolean(v.is_active),
  };
}

function AttributeMappingsTab({ attributes, categories, classes }:
  { attributes: Option[]; categories: Option[]; classes: Option[] }) {
  const [target, setTarget] = useState<"CATEGORY" | "ITEM_CLASS">("CATEGORY");
  return (
    <>
      <div className="mb-3 rounded-xl bg-content2 px-4 py-3 text-sm text-muted">
        This says <strong className="text-body">which attributes</strong> an item of a
        kind should have. The actual values are filled in per item, on the item's
        specification.
      </div>
      <MasterCrud<MasterAttributeMapping>
        title="Attribute mapping" queryKey="attribute-mappings" searchable
        managePerm="master.attribute.manage"
        columns={[
          { key: "attr", header: "Attribute",
            render: (r) => <Code>{r.attribute_code ?? r.attribute_id}</Code> },
          { key: "attrname", header: "", render: (r) => r.attribute_name ?? "—" },
          { key: "target", header: "Applies to",
            render: (r) => `${r.target_type === "CATEGORY" ? "Category" : "Class"}: ${r.target_name ?? r.target_id}` },
          { key: "req", header: "Required",
            render: (r) => (r.is_required ? "Yes" : "No") },
          { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
        ]}
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Code>{r.attribute_code}</Code><Active on={r.is_active} />
            </div>
            <div className="text-sm text-body">{r.attribute_name}</div>
            <div className="text-xs text-muted">{r.target_name} · {r.is_required ? "required" : "optional"}</div>
          </div>
        )}
        fetchList={(search) =>
          mastersApi.attributeMappings.list({ search, size: 300 }).then((p) => p.items)}
        fields={[
          { key: "attribute_id", label: "Attribute", type: "select", options: attributes, required: true },
          { key: "target_type", label: "Applies to", type: "select",
            options: [{ value: "CATEGORY", label: "A category" },
                      { value: "ITEM_CLASS", label: "An item class" }] },
          { key: "target_id", label: target === "CATEGORY" ? "Category" : "Item class",
            type: "select", options: target === "CATEGORY" ? categories : classes,
            required: true },
          { key: "is_required", label: "Required on the item", type: "switch" },
          { key: "sort_order", label: "Order", type: "number" },
          { key: "is_active", label: "Active", type: "switch" },
        ]}
        emptyForm={{ attribute_id: null, target_type: "CATEGORY", target_id: null,
                     is_required: false, sort_order: 0, is_active: true }}
        toForm={(r) => {
          setTarget(r.target_type);
          return { attribute_id: r.attribute_id, target_type: r.target_type,
                   target_id: r.target_id, is_required: r.is_required,
                   sort_order: r.sort_order, is_active: r.is_active };
        }}
        onCreate={(v) => mastersApi.attributeMappings.create(v as Partial<MasterAttributeMapping>)}
        onUpdate={(id, v) => mastersApi.attributeMappings.update(id, v as Partial<MasterAttributeMapping>)}
        onDeactivate={mastersApi.attributeMappings.deactivate}
      />
    </>
  );
}

const PRICE_TYPES: Option[] = ["PURCHASE", "SALE", "TRANSFER"]
  .map((v) => ({ value: v, label: v }));

function PriceListsTab({ vendors, projects }: { vendors: Option[]; projects: Option[] }) {
  return (
    <MasterCrud<MasterPriceList>
      title="Price list" queryKey="price-lists" searchable
      managePerm="master.price.manage"
      columns={[
        { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
        { key: "name", header: "Name", render: (r) => r.name },
        { key: "type", header: "Type", render: (r) => r.price_type },
        { key: "vendor", header: "Vendor", hideOnNarrow: true,
          render: (r) => r.vendor_name ?? "Any" },
        { key: "valid", header: "Valid", hideOnNarrow: true,
          render: (r) => `${r.valid_from ?? "—"} → ${r.valid_to ?? "—"}` },
        { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
      ]}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Code>{r.code}</Code><Active on={r.is_active} />
          </div>
          <div className="text-sm text-body">{r.name}</div>
          <div className="text-xs text-muted">{r.price_type} · {r.currency}</div>
        </div>
      )}
      fetchList={(search) => mastersApi.priceLists.list({ search, size: 200 }).then((p) => p.items)}
      fields={[
        { key: "code", label: "Code", required: true },
        { key: "name", label: "Name", required: true },
        { key: "price_type", label: "Type", type: "select", options: PRICE_TYPES },
        { key: "currency", label: "Currency" },
        { key: "vendor_id", label: "Vendor (optional)", type: "select", options: vendors },
        { key: "project_id", label: "Project (optional)", type: "select", options: projects },
        { key: "valid_from", label: "Valid from (YYYY-MM-DD)" },
        { key: "valid_to", label: "Valid to (YYYY-MM-DD)" },
        { key: "description", label: "Description" },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ code: "", name: "", price_type: "PURCHASE", currency: "INR",
                   vendor_id: null, project_id: null, valid_from: "", valid_to: "",
                   description: "", is_active: true }}
      toForm={(r) => ({ code: r.code, name: r.name, price_type: r.price_type,
        currency: r.currency, vendor_id: r.vendor_id ?? null,
        project_id: r.project_id ?? null, valid_from: r.valid_from ?? "",
        valid_to: r.valid_to ?? "", description: r.description ?? "",
        is_active: r.is_active })}
      onCreate={(v) => mastersApi.priceLists.create(v as Partial<MasterPriceList>)}
      onUpdate={(id, v) => mastersApi.priceLists.update(id, v as Partial<MasterPriceList>)}
      onDeactivate={mastersApi.priceLists.deactivate}
    />
  );
}

const BOM_TYPES: Option[] = ["GENERAL", "KIT", "ASSEMBLY", "VEHICLE"]
  .map((v) => ({ value: v, label: v }));

function BomsTab({ items, projects }: { items: Option[]; projects: Option[] }) {
  return (
    <MasterCrud<MasterBom>
      title="BOM" queryKey="boms" searchable managePerm="master.bom.manage"
      columns={[
        { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
        { key: "name", header: "Name", render: (r) => r.name },
        { key: "type", header: "Type", render: (r) => r.bom_type },
        { key: "parent", header: "Makes", hideOnNarrow: true,
          render: (r) => r.parent_item_name ?? "—" },
        { key: "lines", header: "Lines", hideOnNarrow: true, render: (r) => r.total_items },
        { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
      ]}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Code>{r.code}</Code><Active on={r.is_active} />
          </div>
          <div className="text-sm text-body">{r.name}</div>
          <div className="text-xs text-muted">{r.bom_type} · makes {r.output_qty}</div>
        </div>
      )}
      fetchList={(search) => mastersApi.boms.list({ search, size: 200 }).then((p) => p.items)}
      fields={[
        { key: "code", label: "Code", required: true },
        { key: "name", label: "Name", required: true },
        { key: "bom_type", label: "Type", type: "select", options: BOM_TYPES },
        { key: "parent_item_id", label: "Item it makes", type: "select", options: items },
        { key: "output_qty", label: "Quantity it makes", type: "number" },
        { key: "project_id", label: "Project", type: "select", options: projects },
        { key: "description", label: "Description" },
        { key: "is_default", label: "Default BOM for that item", type: "switch" },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ code: "", name: "", bom_type: "GENERAL", parent_item_id: null,
                   output_qty: 1, project_id: null, description: "",
                   is_default: false, is_active: true }}
      toForm={(r) => ({ code: r.code, name: r.name, bom_type: r.bom_type,
        parent_item_id: r.parent_item_id ?? null, output_qty: r.output_qty,
        project_id: r.project_id ?? null, description: r.description ?? "",
        is_default: r.is_default, is_active: r.is_active })}
      onCreate={(v) => mastersApi.boms.create(v as Partial<MasterBom>)}
      onUpdate={(id, v) => mastersApi.boms.update(id, v as Partial<MasterBom>)}
      onDeactivate={mastersApi.boms.deactivate}
    />
  );
}

/** Read-only HCM mirrors (rule 10 — sync owns those tables). */
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
  "items", "categories", "general-names", "item-classes", "item-sub-classes",
  "brands", "manufacturers", "brand-manufacturers", "dosage-forms",
  "features", "packaging",
  "attributes", "attribute-mappings", "uom", "conversions", "warehouses", "bins",
  "projects", "vendors", "price-lists", "boms",
  "departments", "facilities",
] as const;

const TAB_LABELS: Record<(typeof TABS)[number], string> = {
  items: "Items", categories: "Categories", "item-classes": "Item Classes",
  "general-names": "General Names", "item-sub-classes": "Item Subclasses",
  brands: "Brands", manufacturers: "Manufacturers",
  "brand-manufacturers": "Brand Manufacturers", "dosage-forms": "Dosage Forms",
  features: "Features", packaging: "Packaging",
  attributes: "Attributes", "attribute-mappings": "Attribute Mapping",
  uom: "UOM", conversions: "Conversions", warehouses: "Warehouses", bins: "Bins",
  projects: "Projects", vendors: "Vendors", "price-lists": "Price Lists",
  boms: "BOM",
  departments: "Departments", facilities: "Facilities",
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
  const itemClasses = useQuery({
    queryKey: ["masters", "item-classes-all"],
    queryFn: () => mastersApi.itemClasses.list({ size: 200 }).then((p) => p.items),
  });
  const attributes = useQuery({
    queryKey: ["masters", "attributes-all"],
    queryFn: () => mastersApi.attributes.list({ size: 300 }).then((p) => p.items),
  });
  const vendors = useQuery({
    queryKey: ["masters", "vendors-all"],
    queryFn: () => mastersApi.vendors.list({ size: 300 }).then((p) => p.items),
  });
  const projects = useQuery({
    queryKey: ["masters", "projects-all"],
    queryFn: () => mastersApi.projects.list({ size: 300 }).then((p) => p.items),
  });
  const items = useQuery({
    queryKey: ["masters", "items-all"],
    queryFn: () => mastersApi.items.list({ size: 300 }).then((p) => p.items),
  });

  const uomOpts: Option[] = (uom.data ?? []).map((u) => ({ value: u.id, label: `${u.code} — ${u.name}` }));
  const catOpts: Option[] = (cats.data ?? []).map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` }));
  const whOpts: Option[] = (warehouses.data ?? []).map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` }));
  const binOpts: Option[] = (bins.data ?? []).map((b) => ({ value: b.id, label: b.path ?? b.code }));
  const facOpts: Option[] = (facilities.data ?? []).map((f) => ({ value: f.id, label: f.name }));
  const classOpts: Option[] = (itemClasses.data ?? []).map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` }));
  const attrOpts: Option[] = (attributes.data ?? []).map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }));
  const vendorOpts: Option[] = (vendors.data ?? []).map((v) => ({ value: v.id, label: `${v.code} — ${v.name}` }));
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

      {tab === "items" && <ItemsTab />}
      {tab === "categories" && <CategoriesTab cats={catOpts} />}
      {tab === "general-names" && <NamedLookupTab title="General name" queryKey="general-names" api={mastersApi.generalNames} />}
      {tab === "item-classes" && <ItemClassesTab />}
      {tab === "item-sub-classes" && <ItemSubClassesTab />}
      {tab === "brands" && <BrandsTab />}
      {tab === "manufacturers" && <NamedLookupTab title="Manufacturer" queryKey="manufacturers" api={mastersApi.manufacturers} managePerm="master.brand.manage" />}
      {tab === "brand-manufacturers" && <BrandManufacturersTab />}
      {tab === "dosage-forms" && <NamedLookupTab title="Dosage form" queryKey="dosage-forms" api={mastersApi.dosageForms} />}
      {tab === "features" && <FeaturesTab />}
      {tab === "packaging" && <PackagingTab uoms={uomOpts} />}
      {tab === "attributes" && <AttributesTab />}
      {tab === "attribute-mappings" && (
        <AttributeMappingsTab attributes={attrOpts} categories={catOpts}
                              classes={classOpts} />
      )}
      {tab === "price-lists" && <PriceListsTab vendors={vendorOpts} projects={projectOpts} />}
      {tab === "boms" && <BomsTab items={itemOpts} projects={projectOpts} />}
      {tab === "uom" && <UomTab />}
      {tab === "conversions" && <ConversionsTab uoms={uomOpts} />}
      {tab === "warehouses" && <WarehousesTab facilities={facOpts} />}
      {tab === "bins" && <BinsTab warehouses={whOpts} bins={binOpts} />}
      {tab === "projects" && <ProjectsTab />}
      {tab === "vendors" && <VendorsTab />}
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
