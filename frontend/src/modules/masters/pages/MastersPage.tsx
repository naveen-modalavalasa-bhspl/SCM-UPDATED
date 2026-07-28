import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Tab, Tabs } from "@heroui/react";
import {
  Button, Can, Card, Field, PageHeader, Select, type Column,
} from "@/shared/components";
import { mastersApi } from "../api";
import { MasterCrud, type Option } from "../components/MasterCrud";
import { ItemMasterTab } from "../components/ItemMasterTab";
import type {
  MasterAttribute, MasterBin, MasterBom, MasterBomItem,
  MasterBrand, MasterCategory, MasterCategoryTag, CategoryTagType,
  MasterFeature, MasterHsnCode, MasterItemClass, MasterItemGroup,
  MasterPackaging, MasterSpec, MasterUom, MasterUomConversion, UomClass,
  MasterVendor, MasterWarehouse, Project, RefRow, NamedMaster,
  MasterItemSubClass,
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

/** A short code, letters and digits only — it becomes part of every item code. */
const CODE_RULE = {
  maxLength: 10,
  pattern: /^[A-Za-z0-9]+$/,
  patternMessage: "Use letters and numbers only, no spaces or symbols",
} as const;

const WAREHOUSE_TYPES: Option[] = ["MAIN", "LIP", "MDP", "TRANSIT", "QUARANTINE", "SCRAP"]
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
    fields={[{key:"code",label:"Code",required:true,...CODE_RULE},
      {key:"name",label:"Name",required:true,maxLength:200},
      {key:"description",label:"Description",maxLength:300},
      {key:"is_active",label:"Active",type:"switch"}]}
    emptyForm={{code:"",name:"",description:"",is_active:true}}
    toForm={(r)=>({code:r.code,name:r.name,description:r.description??"",is_active:r.is_active})}
    onCreate={(v)=>api.create(v as Partial<NamedMaster>)}
    onUpdate={(id,v)=>api.update(id,v as Partial<NamedMaster>)}
    onDeactivate={api.deactivate}
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
      {key:"code",label:"Code",required:true,...CODE_RULE},
      {key:"name",label:"Name",required:true,maxLength:200},
      {key:"description",label:"Description",maxLength:300},
      {key:"is_active",label:"Active",type:"switch"}]}
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
        { key: "code", label: "Code", required: true, maxLength: 50,
          pattern: /^[A-Za-z0-9-]+$/,
          patternMessage: "Use letters, numbers or a hyphen" },
        { key: "name", label: "Name", required: true, maxLength: 200 },
        // A name may repeat under a different parent but never under the same one,
        // so the backend check is scoped to the parent chosen here.
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
        { key: "code", label: "Code", required: true, maxLength: 50,
          pattern: /^[A-Za-z0-9-]+$/,
          patternMessage: "Use letters, numbers or a hyphen" },
        { key: "name", label: "Name", required: true, maxLength: 200 },
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
        { key: "capacity_qty", label: "Capacity", type: "number", min: 0 },
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

/** HCM owns projects and its sync writes them, so there is nothing to edit here.
 *  The backend registers no write routes either — hiding the button is not the
 *  control (rule 6), the missing endpoint is. */
function ProjectsTab() {
  return (
    <>
      <div className="mb-3 rounded-xl bg-content2 px-4 py-3 text-sm text-muted">
        Projects come from <strong className="text-body">HCM</strong> and refresh on
        each sync. To add or change one, do it in HCM.
      </div>
      <ReadOnlyTab<Project>
        title="Projects"
        fetchList={() => mastersApi.projects.list({ size: 300 }).then((p) => p.items)}
        columns={[
          { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
          { key: "name", header: "Name", render: (r) => r.name },
          { key: "office", header: "Office", hideOnNarrow: true,
            render: (r) => r.office_name ?? "—" },
          { key: "dates", header: "Dates", hideOnNarrow: true,
            render: (r) => `${r.start_date ?? "—"} → ${r.end_date ?? "—"}` },
          { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
        ]}
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Code>{r.code}</Code><Active on={r.is_active} />
            </div>
            <div className="text-sm text-body">{r.name}</div>
          </div>
        )}
      />
    </>
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
        { key: "contact_person", label: "Contact person", maxLength: 150 },
        { key: "phone", label: "Phone", maxLength: 30,
          pattern: /^[0-9+\-() ]{6,}$/,
          patternMessage: "Digits, spaces and + - ( ) only, at least 6" },
        { key: "email", label: "Email", maxLength: 200,
          pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
          patternMessage: "That does not look like an email address" },
        { key: "city", label: "City", maxLength: 100 },
        { key: "state", label: "State", maxLength: 100 },
        // 2-digit state code, 10-char PAN, entity digit, Z, checksum.
        { key: "gstin", label: "GSTIN", maxLength: 15,
          pattern: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/,
          patternMessage: "A GSTIN is 15 characters, e.g. 27AAPFU0939F1ZV" },
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

const UOM_CLASSES: UomClass[] = ["COUNT", "LENGTH", "AREA", "VOLUME", "WEIGHT",
  "TEMPERATURE", "TIME", "PRESSURE", "ENERGY", "PACKAGING"];
const UOM_CLASS_OPTS: Option[] = UOM_CLASSES.map((v) => ({
  value: v, label: v.charAt(0) + v.slice(1).toLowerCase(),
}));

/** Pick a class, tick the standard units, create them in one call.
 *
 *  Typing units by hand is how "Litre", "litre" and "Ltr" end up as three rows that
 *  no conversion can reconcile. Offering the known names removes the chance. */
function UomSuggestions() {
  const qc = useQueryClient();
  const [uomClass, setUomClass] = useState<UomClass>("TEMPERATURE");
  const [picked, setPicked] = useState<string[]>([]);

  const suggestions = useQuery({
    queryKey: ["masters", "uom-suggestions", uomClass],
    queryFn: () => mastersApi.uom.suggestions(uomClass),
  });
  const create = useMutation({
    mutationFn: () => mastersApi.uom.createSuggested(uomClass, picked),
    onSuccess: () => {
      setPicked([]);
      qc.invalidateQueries({ queryKey: ["masters", "uom"] });
      qc.invalidateQueries({ queryKey: ["masters", "uom-suggestions"] });
    },
  });

  const missing = (suggestions.data ?? []).filter((s) => !s.exists);
  return (
    <Card className="mb-4 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-56">
          <Field label="Measurement class">
            <Select value={uomClass} options={UOM_CLASS_OPTS}
                    onChange={(v) => { setUomClass(v as UomClass); setPicked([]); }} />
          </Field>
        </div>
        <Can do="master.uom.manage">
          <Button onClick={() => create.mutate()}
                  disabled={picked.length === 0 || create.isPending}>
            {create.isPending ? "Adding…" : `Add ${picked.length || ""} unit${picked.length === 1 ? "" : "s"}`.trim()}
          </Button>
        </Can>
      </div>

      {missing.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          Every standard {uomClass.toLowerCase()} unit already exists.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {missing.map((s) => {
            const on = picked.includes(s.code);
            return (
              <button key={s.code} type="button" aria-pressed={on}
                      onClick={() => setPicked((current) => on
                        ? current.filter((c) => c !== s.code)
                        : [...current, s.code])}
                      className={`min-h-11 rounded-xl border px-3 text-sm font-medium transition-colors ${
                        on ? "border-brand bg-brand-050 text-brand"
                           : "border-line bg-content1 text-body hover:bg-content2"
                      }`}>
                {s.name} <span className="mono text-xs text-muted">{s.code}</span>
              </button>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function UomTab() {
  const columns: Column<MasterUom>[] = [
    { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
    { key: "name", header: "Name", render: (r) => r.name },
    { key: "class", header: "Measures", render: (r) => r.uom_class },
    { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
  ];
  return (
    <>
      <UomSuggestions />
      <MasterCrud<MasterUom>
        title="UOM" queryKey="uom" managePerm="master.uom.manage"
        columns={columns}
        renderCard={(r) => (
          <div className="flex items-center justify-between">
            <div>
              <Code>{r.code}</Code>
              <span className="ml-2 text-sm text-body">{r.name}</span>
              <div className="text-xs text-muted">{r.uom_class}</div>
            </div>
            <Active on={r.is_active} />
          </div>
        )}
        fetchList={() => mastersApi.uom.listAll()}
        fields={[
          { key: "uom_class", label: "What it measures", type: "select",
            options: UOM_CLASS_OPTS, required: true },
          { key: "code", label: "Code", required: true, maxLength: 20,
            pattern: /^[A-Za-z0-9/]+$/,
            patternMessage: "Use letters, numbers or a slash" },
          { key: "name", label: "Name", required: true, maxLength: 100 },
          { key: "is_active", label: "Active", type: "switch" },
        ]}
        emptyForm={{ uom_class: "COUNT", code: "", name: "", is_active: true }}
        toForm={(r) => ({ uom_class: r.uom_class, code: r.code, name: r.name,
          is_active: r.is_active })}
        onCreate={(v) => mastersApi.uom.create(v as Partial<MasterUom>)}
        onUpdate={(id, v) => mastersApi.uom.update(id, v as Partial<MasterUom>)}
        onDeactivate={mastersApi.uom.deactivate}
      />
    </>
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
  const manufacturers = useQuery({
    queryKey: ["masters", "manufacturers-all"],
    queryFn: () => mastersApi.manufacturers.list({ size: 300 }).then((r) => r.items),
  });
  const manufacturerOpts: Option[] = (manufacturers.data ?? [])
    .map((r) => ({ value: r.id, label: `${r.code} — ${r.name}` }));
  return (
    <MasterCrud<MasterBrand>
      title="Brand" queryKey="brands" searchable managePerm="master.brand.manage"
      columns={[
        { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
        { key: "name", header: "Name", render: (r) => r.name },
        // One brand is routinely made by several plants, so the list shows them all.
        { key: "mfr", header: "Manufacturers", hideOnNarrow: true,
          render: (r) => r.manufacturer_names?.length
            ? r.manufacturer_names.join(", ") : "—" },
        { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
      ]}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Code>{r.code}</Code><Active on={r.is_active} />
          </div>
          <div className="text-sm text-body">{r.name}</div>
          <div className="text-xs text-muted">
            {r.manufacturer_names?.length ? r.manufacturer_names.join(", ") : "No manufacturer yet"}
          </div>
        </div>
      )}
      fetchList={(search) => mastersApi.brands.list({ search, size: 200 }).then((p) => p.items)}
      fields={[
        { key: "code", label: "Code", required: true, ...CODE_RULE },
        { key: "name", label: "Name", required: true, maxLength: 200 },
        { key: "manufacturer_ids", label: "Manufacturers", type: "multiselect",
          options: manufacturerOpts },
        { key: "description", label: "Description", maxLength: 300 },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ code: "", name: "", manufacturer_ids: [], description: "",
                   is_active: true }}
      toForm={(r) => ({ code: r.code, name: r.name,
        manufacturer_ids: r.manufacturer_ids ?? [],
        description: r.description ?? "", is_active: r.is_active })}
      onCreate={(v) => mastersApi.brands.create(v as unknown as Partial<MasterBrand>)}
      onUpdate={(id, v) => mastersApi.brands.update(id, v as unknown as Partial<MasterBrand>)}
      onDeactivate={mastersApi.brands.deactivate}
    />
  );
}

function ItemClassesTab() {
  return (
    <MasterCrud<MasterItemClass>
      title="Item class" queryKey="item-classes" searchable
      managePerm="master.class.manage"
      // No asset column: whether an item is capitalised is now a per-item choice,
      // because one class holds both a laptop and the mouse next to it.
      columns={[
        { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
        { key: "name", header: "Name", render: (r) => r.name },
        { key: "desc", header: "Description", hideOnNarrow: true,
          render: (r) => r.description ?? "—" },
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
        { key: "code", label: "Code", required: true, ...CODE_RULE },
        { key: "name", label: "Name", required: true, maxLength: 200 },
        { key: "description", label: "Description", maxLength: 300 },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ code: "", name: "", description: "", is_active: true }}
      toForm={(r) => ({ code: r.code, name: r.name, description: r.description ?? "",
        is_active: r.is_active })}
      onCreate={(v) => mastersApi.itemClasses.create(v as Partial<MasterItemClass>)}
      onUpdate={(id, v) => mastersApi.itemClasses.update(id, v as Partial<MasterItemClass>)}
      onDeactivate={mastersApi.itemClasses.deactivate}
    />
  );
}

const RATE_RULE = { type: "number", min: 0, max: 100 } as const;

function HsnCodesTab() {
  return (
    <MasterCrud<MasterHsnCode>
      title="HSN code" queryKey="hsn-codes" searchable managePerm="master.hsn.manage"
      columns={[
        { key: "code", header: "HSN", render: (r) => <Code>{r.code}</Code> },
        { key: "desc", header: "Description", render: (r) => r.description ?? "—" },
        { key: "gst", header: "CGST + SGST", render: (r) =>
            `${r.cgst_rate}% + ${r.sgst_rate}%` },
        { key: "igst", header: "IGST", render: (r) => `${r.igst_rate}%` },
        { key: "cess", header: "Cess", hideOnNarrow: true, render: (r) => `${r.cess_rate}%` },
        { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
      ]}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Code>{r.code}</Code><Active on={r.is_active} />
          </div>
          <div className="text-sm text-body">{r.description ?? "—"}</div>
          <div className="text-xs text-muted">
            {r.cgst_rate}% + {r.sgst_rate}% · IGST {r.igst_rate}%
          </div>
        </div>
      )}
      fetchList={(search) => mastersApi.hsnCodes.list({ search, size: 300 }).then((p) => p.items)}
      fields={[
        { key: "code", label: "HSN / SAC code", required: true, maxLength: 8,
          pattern: /^\d{4,8}$/,
          patternMessage: "An HSN code is 4 to 8 digits" },
        { key: "description", label: "Description", maxLength: 300 },
        { key: "cgst_rate", label: "CGST %", ...RATE_RULE },
        { key: "sgst_rate", label: "SGST %", ...RATE_RULE },
        // CGST + SGST is the within-state route and IGST the across-state one. They
        // must total the same, or the same sale is taxed differently by destination.
        { key: "igst_rate", label: "IGST %", ...RATE_RULE,
          validate: (value, all) => {
            const split = Number(all.cgst_rate ?? 0) + Number(all.sgst_rate ?? 0);
            const igst = Number(value ?? 0);
            return igst && Math.abs(split - igst) > 0.001
              ? `CGST + SGST is ${split}%, which must equal IGST` : null;
          } },
        { key: "cess_rate", label: "Cess %", ...RATE_RULE },
        { key: "effective_from", label: "Effective from (YYYY-MM-DD)",
          pattern: /^\d{4}-\d{2}-\d{2}$/,
          patternMessage: "Use the format 2026-04-01" },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ code: "", description: "", cgst_rate: 0, sgst_rate: 0,
                   igst_rate: 0, cess_rate: 0, effective_from: "", is_active: true }}
      toForm={(r) => ({ code: r.code, description: r.description ?? "",
        cgst_rate: r.cgst_rate, sgst_rate: r.sgst_rate, igst_rate: r.igst_rate,
        cess_rate: r.cess_rate, effective_from: r.effective_from ?? "",
        is_active: r.is_active })}
      onCreate={(v) => mastersApi.hsnCodes.create(v as Partial<MasterHsnCode>)}
      onUpdate={(id, v) => mastersApi.hsnCodes.update(id, v as Partial<MasterHsnCode>)}
      onDeactivate={mastersApi.hsnCodes.deactivate}
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

function PackagingTab() {
  return (
    <>
      <div className="mb-3 rounded-xl bg-content2 px-4 py-3 text-sm text-muted">
        A package is a <strong className="text-body">kind of container</strong> — a
        tray, a box, a shipping container. How much of an item one holds is set per
        item, on that item's Packaging tab: a tray of milk and a tray of vials hold
        very different amounts.
      </div>
      <MasterCrud<MasterPackaging>
        title="Package" queryKey="packaging" searchable
        managePerm="master.packaging.manage"
        columns={[
          { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
          { key: "name", header: "Name", render: (r) => r.name },
          { key: "size", header: "Size (cm)", hideOnNarrow: true, render: (r) =>
              r.length_cm ? [r.length_cm, r.width_cm ?? "—", r.height_cm ?? "—"].join(" × ") : "—" },
          { key: "kg", header: "Weight (kg)", hideOnNarrow: true,
            render: (r) => r.weight_kg ?? "—" },
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
              {r.is_returnable ? "Returnable" : "One-way"}
            </div>
          </div>
        )}
        fetchList={(search) => mastersApi.packaging.list({ search, size: 200 }).then((p) => p.items)}
        fields={[
          { key: "code", label: "Code", required: true, maxLength: 50,
            pattern: /^[A-Za-z0-9-]+$/,
            patternMessage: "Use letters, numbers or a hyphen" },
          { key: "name", label: "Name", required: true, maxLength: 200 },
          { key: "length_cm", label: "Length (cm)", type: "number", min: 0 },
          { key: "width_cm", label: "Width (cm)", type: "number", min: 0 },
          { key: "height_cm", label: "Height (cm)", type: "number", min: 0 },
          { key: "weight_kg", label: "Empty weight (kg)", type: "number", min: 0 },
          { key: "is_returnable", label: "Returnable", type: "switch" },
          { key: "is_active", label: "Active", type: "switch" },
        ]}
        emptyForm={{ code: "", name: "", length_cm: null, width_cm: null,
                     height_cm: null, weight_kg: null, is_returnable: false,
                     is_active: true }}
        toForm={(r) => ({ code: r.code, name: r.name, length_cm: r.length_cm ?? null,
          width_cm: r.width_cm ?? null, height_cm: r.height_cm ?? null,
          weight_kg: r.weight_kg ?? null, is_returnable: r.is_returnable,
          is_active: r.is_active })}
        onCreate={(v) => mastersApi.packaging.create(v as Partial<MasterPackaging>)}
        onUpdate={(id, v) => mastersApi.packaging.update(id, v as Partial<MasterPackaging>)}
        onDeactivate={mastersApi.packaging.deactivate}
      />
    </>
  );
}

const DATA_TYPES: Option[] = ["TEXT", "NUMBER", "BOOLEAN", "DATE", "LIST"]
  .map((v) => ({ value: v, label: v }));

function AttributesTab({ uoms }: { uoms: Option[] }) {
  return (
    <>
      <div className="mb-3 rounded-xl bg-content2 px-4 py-3 text-sm text-muted">
        An attribute is a <strong className="text-body">selectable trait</strong> —
        colour, material, grade. Something you measure, with a unit, is a
        <strong className="text-body"> Spec</strong>. Both are attached to categories
        on the Category Tagging tab.
      </div>
      <MasterCrud<MasterAttribute>
        title="Attribute" queryKey="attributes" searchable
        managePerm="master.attribute.manage"
        columns={[
          { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
          { key: "name", header: "Name", render: (r) => r.name },
          { key: "type", header: "Type", render: (r) => r.data_type },
          { key: "uom", header: "Unit", hideOnNarrow: true, render: (r) => r.uom_code ?? "—" },
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
            <div className="text-xs text-muted">
              {r.data_type}{r.uom_code ? " \u00b7 " + r.uom_code : ""}
            </div>
          </div>
        )}
        fetchList={(search) => mastersApi.attributes.list({ search, size: 200 }).then((p) => p.items)}
        fields={[
          { key: "code", label: "Code", required: true, maxLength: 50,
            pattern: /^[A-Za-z0-9_]+$/,
            patternMessage: "Use letters, numbers or an underscore" },
          { key: "name", label: "Name", required: true, maxLength: 200 },
          { key: "data_type", label: "Type", type: "select", options: DATA_TYPES },
          // A real UOM row, not free text: "kg", "Kg" and "kilogram" used to be
          // three different units nothing could reconcile.
          { key: "uom_id", label: "Unit", type: "select", options: uoms },
          { key: "allowed_values_text", label: "Options for LIST, comma separated",
            validate: (value, all) => all.data_type === "LIST" && !String(value ?? "").trim()
              ? "A LIST attribute needs at least one option" : null },
          { key: "description", label: "Description", maxLength: 300 },
          { key: "is_active", label: "Active", type: "switch" },
        ]}
        emptyForm={{ code: "", name: "", data_type: "TEXT", uom_id: null,
                     allowed_values_text: "", description: "", is_active: true }}
        toForm={(r) => ({ code: r.code, name: r.name, data_type: r.data_type,
          uom_id: r.uom_id ?? null,
          allowed_values_text: (r.allowed_values ?? []).join(", "),
          description: r.description ?? "", is_active: r.is_active })}
        // The form takes a comma-separated string; the API wants a list.
        onCreate={(v) => mastersApi.attributes.create(toAttributePayload(v))}
        onUpdate={(id, v) => mastersApi.attributes.update(id, toAttributePayload(v))}
        onDeactivate={mastersApi.attributes.deactivate}
      />
    </>
  );
}

function toAttributePayload(v: Record<string, unknown>): Partial<MasterAttribute> {
  const raw = String(v.allowed_values_text ?? "").trim();
  return {
    code: String(v.code ?? ""),
    name: String(v.name ?? ""),
    data_type: v.data_type as MasterAttribute["data_type"],
    uom_id: v.uom_id == null ? null : Number(v.uom_id),
    allowed_values: raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [],
    description: (v.description as string) || null,
    is_active: Boolean(v.is_active),
  };
}

function SpecsTab({ uoms }: { uoms: Option[] }) {
  return (
    <>
      <div className="mb-3 rounded-xl bg-content2 px-4 py-3 text-sm text-muted">
        A spec is something you <strong className="text-body">measure</strong> —
        operating voltage in volts, capacity in litres. It always carries a unit.
        Attach it to a category, and mark it required, on Category Tagging.
      </div>
      <MasterCrud<MasterSpec>
        title="Spec" queryKey="specs" searchable managePerm="master.spec.manage"
        columns={[
          { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
          { key: "name", header: "Name", render: (r) => r.name },
          { key: "uom", header: "Measured in", render: (r) => r.uom_code ?? "—" },
          { key: "desc", header: "Description", hideOnNarrow: true,
            render: (r) => r.description ?? "—" },
          { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
        ]}
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Code>{r.code}</Code><Active on={r.is_active} />
            </div>
            <div className="text-sm text-body">{r.name}</div>
            <div className="text-xs text-muted">{r.uom_code ?? "no unit"}</div>
          </div>
        )}
        fetchList={(search) => mastersApi.specs.list({ search, size: 200 }).then((p) => p.items)}
        fields={[
          { key: "code", label: "Code", required: true, maxLength: 50,
            pattern: /^[A-Za-z0-9_]+$/,
            patternMessage: "Use letters, numbers or an underscore" },
          { key: "name", label: "Name", required: true, maxLength: 200 },
          { key: "uom_id", label: "Measured in", type: "select", options: uoms,
            required: true },
          { key: "description", label: "Description", maxLength: 300 },
          { key: "is_active", label: "Active", type: "switch" },
        ]}
        emptyForm={{ code: "", name: "", uom_id: null, description: "", is_active: true }}
        toForm={(r) => ({ code: r.code, name: r.name, uom_id: r.uom_id ?? null,
          description: r.description ?? "", is_active: r.is_active })}
        onCreate={(v) => mastersApi.specs.create(v as Partial<MasterSpec>)}
        onUpdate={(id, v) => mastersApi.specs.update(id, v as Partial<MasterSpec>)}
        onDeactivate={mastersApi.specs.deactivate}
      />
    </>
  );
}

/** One screen for the three things a category expects of its items. Attributes,
 *  specs and features answer the same two questions — which one, and is it
 *  required — so they were three tabs doing one job. */
function CategoryTaggingTab({ categories }: { categories: Option[] }) {
  const [tagType, setTagType] = useState<CategoryTagType>("ATTRIBUTE");

  const attributes = useQuery({
    queryKey: ["masters", "attributes-all"],
    queryFn: () => mastersApi.attributes.list({ size: 300 }).then((p) => p.items),
  });
  const specs = useQuery({
    queryKey: ["masters", "specs-all"],
    queryFn: () => mastersApi.specs.list({ size: 300 }).then((p) => p.items),
  });
  const features = useQuery({
    queryKey: ["masters", "features-all"],
    queryFn: () => mastersApi.features.list({ size: 300 }).then((p) => p.items),
  });

  const source = { ATTRIBUTE: attributes.data, SPEC: specs.data,
                   FEATURE: features.data }[tagType] ?? [];
  const tagOpts: Option[] = source.map((r) => ({
    value: r.id, label: r.code + " — " + r.name,
  }));

  return (
    <>
      <div className="mb-3 rounded-xl bg-content2 px-4 py-3 text-sm text-muted">
        This says <strong className="text-body">what a category expects</strong> of its
        items. When someone creates an item in that category, these fields appear on
        the item form, and the required ones must be answered.
      </div>
      <MasterCrud<MasterCategoryTag>
        title="Category tag" queryKey="category-tags" searchable
        managePerm="master.attribute.manage"
        columns={[
          { key: "category", header: "Category",
            render: (r) => r.category_name ?? r.category_id },
          { key: "kind", header: "Kind", render: (r) => r.tag_type },
          { key: "tag", header: "Field", render: (r) => r.tag_name ?? r.tag_code },
          { key: "unit", header: "Unit", hideOnNarrow: true,
            render: (r) => r.tag_uom_code ?? "—" },
          { key: "req", header: "Required",
            render: (r) => (r.is_required ? "Yes" : "No") },
          { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
        ]}
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-ink">{r.tag_name}</span>
              <Active on={r.is_active} />
            </div>
            <div className="text-xs text-muted">
              {r.category_name} · {r.tag_type.toLowerCase()}
              {r.tag_uom_code ? " · " + r.tag_uom_code : ""}
              {r.is_required ? " · required" : ""}
            </div>
          </div>
        )}
        fetchList={(search) =>
          mastersApi.categoryTags.list({ search, size: 500 }).then((p) => p.items)}
        fields={[
          { key: "category_id", label: "Category", type: "select",
            options: categories, required: true },
          { key: "tag_type", label: "Kind of field", type: "select",
            options: [
              { value: "ATTRIBUTE", label: "Attribute — a selectable trait" },
              { value: "SPEC", label: "Spec — a measurement with a unit" },
              { value: "FEATURE", label: "Feature — a yes/no trait" },
            ] },
          { key: "tag_id", label: "Which one", type: "select", options: tagOpts,
            required: true },
          { key: "is_required", label: "Required on the item", type: "switch" },
          { key: "is_active", label: "Active", type: "switch" },
        ]}
        emptyForm={{ category_id: null, tag_type: "ATTRIBUTE", tag_id: null,
                     is_required: false, is_active: true }}
        toForm={(r) => {
          // Keeps the "which one" dropdown showing the right master when an
          // existing row is opened for editing.
          setTagType(r.tag_type);
          return { category_id: r.category_id, tag_type: r.tag_type,
                   tag_id: r.tag_id, is_required: r.is_required,
                   is_active: r.is_active };
        }}
        onCreate={(v) => mastersApi.categoryTags.create(v as Partial<MasterCategoryTag>)}
        onUpdate={(id, v) =>
          mastersApi.categoryTags.update(id, v as Partial<MasterCategoryTag>)}
        onDeactivate={mastersApi.categoryTags.deactivate}
      />
      <div className="mt-3 text-xs text-muted">
        Showing {tagType.toLowerCase()}s in the “Which one” list. Change “Kind of
        field” in the form to switch.
      </div>
    </>
  );
}

/** Which items a user group may request. A group is defined by role or position in
 *  the RBAC module; this only decides its catalogue. */
function ItemGroupsTab({ items }: { items: Option[] }) {
  const groups = useQuery({
    queryKey: ["masters", "user-groups"], queryFn: mastersApi.userGroups,
  });
  const groupOpts: Option[] = (groups.data ?? [])
    .map((g) => ({ value: g.id, label: g.code + " — " + g.name }));

  return (
    <>
      <div className="mb-3 rounded-xl bg-content2 px-4 py-3 text-sm text-muted">
        Tagging items to a group limits what its members can pick when raising a
        request. A group with <strong className="text-body">no items tagged</strong>{" "}
        sees the whole catalogue — nobody is ever left with an empty picker.
      </div>
      <MasterCrud<MasterItemGroup>
        title="Item group" queryKey="item-groups" searchable
        managePerm="master.item.manage"
        columns={[
          { key: "group", header: "Group", render: (r) => r.group_name ?? r.group_id },
          { key: "item", header: "Item", render: (r) => r.item_name ?? "—" },
          { key: "code", header: "Item code", hideOnNarrow: true,
            render: (r) => <Code>{r.item_code}</Code> },
          { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
        ]}
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-ink">{r.group_name}</span>
              <Active on={r.is_active} />
            </div>
            <div className="text-xs text-muted">{r.item_name}</div>
          </div>
        )}
        fetchList={(search) =>
          mastersApi.itemGroups.list({ search, size: 500 }).then((p) => p.items)}
        fields={[
          { key: "group_id", label: "User group", type: "select", options: groupOpts,
            required: true },
          { key: "item_id", label: "Item", type: "select", options: items,
            required: true },
          { key: "is_active", label: "Active", type: "switch" },
        ]}
        emptyForm={{ group_id: null, item_id: null, is_active: true }}
        toForm={(r) => ({ group_id: r.group_id, item_id: r.item_id,
          is_active: r.is_active })}
        onCreate={(v) => mastersApi.itemGroups.create(v as Partial<MasterItemGroup>)}
        onUpdate={(id, v) =>
          mastersApi.itemGroups.update(id, v as Partial<MasterItemGroup>)}
        onDeactivate={mastersApi.itemGroups.deactivate}
      />
    </>
  );
}

function BomsTab({ projects }: { projects: Option[] }) {
  return (
    <>
      <div className="mb-3 rounded-xl bg-content2 px-4 py-3 text-sm text-muted">
        A BOM is a <strong className="text-body">predefined set of items</strong> for a
        project — the standard kit a requester picks instead of typing the same lines
        every time.
      </div>
      <MasterCrud<MasterBom>
        title="BOM" queryKey="boms" searchable managePerm="master.bom.manage"
        columns={[
          { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
          { key: "name", header: "Name", render: (r) => r.name },
          { key: "project", header: "Project", hideOnNarrow: true,
            render: (r) => r.project_name ?? "Any project" },
          { key: "lines", header: "Items", hideOnNarrow: true, render: (r) => r.total_items },
          { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
        ]}
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Code>{r.code}</Code><Active on={r.is_active} />
            </div>
            <div className="text-sm text-body">{r.name}</div>
            <div className="text-xs text-muted">
              {r.project_name ?? "Any project"}
            </div>
          </div>
        )}
        fetchList={(search) => mastersApi.boms.list({ search, size: 200 }).then((p) => p.items)}
        fields={[
          { key: "code", label: "Code", required: true, maxLength: 50,
            pattern: /^[A-Za-z0-9-]+$/,
            patternMessage: "Use letters, numbers or a hyphen" },
          { key: "name", label: "Name", required: true, maxLength: 200 },
          { key: "project_id", label: "Project", type: "select", options: projects },
          { key: "description", label: "Description", maxLength: 500 },
          { key: "is_active", label: "Active", type: "switch" },
        ]}
        emptyForm={{ code: "", name: "", project_id: null, description: "",
                     is_active: true }}
        toForm={(r) => ({ code: r.code, name: r.name,
          project_id: r.project_id ?? null, description: r.description ?? "",
          is_active: r.is_active })}
        onCreate={(v) => mastersApi.boms.create(v as Partial<MasterBom>)}
        onUpdate={(id, v) => mastersApi.boms.update(id, v as Partial<MasterBom>)}
        onDeactivate={mastersApi.boms.deactivate}
      />
      <BomLines />
    </>
  );
}

/** The lines of one chosen BOM. Kept beside the header list rather than behind a
 *  row click, because building a kit means adding a dozen lines in a row. */
function BomLines() {
  const [bomId, setBomId] = useState<string>("");
  const boms = useQuery({
    queryKey: ["masters", "boms-all"],
    queryFn: () => mastersApi.boms.list({ size: 300 }).then((p) => p.items),
  });
  const items = useQuery({
    queryKey: ["masters", "items-all"],
    queryFn: () => mastersApi.items.list({ size: 300 }).then((p) => p.items),
  });
  const bomOpts: Option[] = (boms.data ?? [])
    .map((b) => ({ value: b.id, label: b.code + " — " + b.name }));
  const itemOpts: Option[] = (items.data ?? [])
    .map((i) => ({ value: i.id, label: i.code + " — " + i.name }));

  return (
    <div className="mt-8 border-t border-line pt-6">
      <div className="mb-4 max-w-sm">
        <Field label="Show the items in">
          <Select value={bomId} options={bomOpts} placeholder="Pick a BOM…"
                  onChange={setBomId} />
        </Field>
      </div>
      {!bomId ? (
        <p className="text-sm text-muted">Pick a BOM to see and edit its items.</p>
      ) : (
        <MasterCrud<MasterBomItem>
          key={bomId}
          title="BOM item" queryKey={"bom-items-" + bomId}
          managePerm="master.bom.manage"
          columns={[
            { key: "line", header: "#", render: (r) => r.line_no },
            { key: "item", header: "Item", render: (r) => r.item_name ?? "—" },
            { key: "code", header: "Code", hideOnNarrow: true,
              render: (r) => <Code>{r.item_code}</Code> },
            { key: "qty", header: "Quantity",
              render: (r) => [r.quantity, r.uom_code ?? ""].join(" ").trim() },
            { key: "remarks", header: "Remarks", hideOnNarrow: true,
              render: (r) => r.remarks ?? "—" },
          ]}
          renderCard={(r) => (
            <div>
              <div className="text-sm text-body">{r.item_name}</div>
              <div className="text-xs text-muted">{r.quantity} {r.uom_code}</div>
            </div>
          )}
          fetchList={() => mastersApi.bomItems
            .list({ bom_id: Number(bomId), size: 300 }).then((p) => p.items)}
          fields={[
            { key: "item_id", label: "Item", type: "select", options: itemOpts,
              required: true },
            { key: "line_no", label: "Line number", type: "number", min: 1 },
            { key: "quantity", label: "Quantity", type: "number", min: 0,
              required: true },
            { key: "remarks", label: "Remarks", maxLength: 500 },
          ]}
          emptyForm={{ item_id: null, line_no: 1, quantity: 1, remarks: "" }}
          toForm={(r) => ({ item_id: r.item_id, line_no: r.line_no,
            quantity: r.quantity, remarks: r.remarks ?? "" })}
          onCreate={(v) => mastersApi.bomItems.create({
            ...(v as Partial<MasterBomItem>), bom_id: Number(bomId) })}
          onUpdate={(id, v) => mastersApi.bomItems.update(id, {
            ...(v as Partial<MasterBomItem>), bom_id: Number(bomId) })}
        />
      )}
    </div>
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
  "brands", "manufacturers", "dosage-forms", "hsn-codes",
  "features", "packaging", "item-groups",
  "attributes", "specs", "category-tags",
  "uom", "conversions", "warehouses", "bins",
  "projects", "vendors", "boms",
  "departments", "facilities",
] as const;

const TAB_LABELS: Record<(typeof TABS)[number], string> = {
  items: "Items", categories: "Categories", "item-classes": "Item Classes",
  "general-names": "General Names", "item-sub-classes": "Item Subclasses",
  brands: "Brands", manufacturers: "Manufacturers",
  "dosage-forms": "Dosage Forms", "hsn-codes": "HSN Codes",
  features: "Features", packaging: "Packages", "item-groups": "Item Groups",
  attributes: "Attributes", specs: "Specs", "category-tags": "Category Tagging",
  uom: "UOM", conversions: "Conversions", warehouses: "Warehouses", bins: "Bins",
  projects: "Projects", vendors: "Vendors", boms: "BOM",
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
