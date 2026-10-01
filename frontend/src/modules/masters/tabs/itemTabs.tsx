import { mastersApi } from "../api";
import { ItemMasterTab } from "../components/ItemMasterTab";
import { MasterCrud } from "../components/MasterCrud";
import type { Option } from "../components/MasterCrud";
import type { MasterBrand, MasterCategory, MasterGeneralName, MasterHsnCode, MasterItemClass, MasterItemSubClass } from "../types";
import type { Column } from "@/shared/components";
import { useQuery } from "@tanstack/react-query";
import { Active, Code } from "./common";
import { CODE_RULE, RATE_RULE } from "./constants";

export function ItemsTab() {
  return <ItemMasterTab />;
}

export function ItemSubClassesTab() {
  const classes=useQuery({queryKey:["masters", "item-classes", "all"],queryFn:()=>mastersApi.itemClasses.list({size:300}).then(r=>r.items)});
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
bulk={mastersApi.itemSubClasses} usage={mastersApi.itemSubClasses.usage}
    onCreate={v=>mastersApi.itemSubClasses.create(v as Partial<MasterItemSubClass>)}
    onUpdate={(id,v)=>mastersApi.itemSubClasses.update(id,v as Partial<MasterItemSubClass>)}
    onDeactivate={mastersApi.itemSubClasses.deactivate}
  />;
}

export function CategoriesTab({ cats: _cats }: { cats: Option[] }) {
  // Every category with its level, so the Parent list can offer only the rung
  // directly above the one being created: a Level 2 sits under a Level 1, a Level 3
  // under a Level 2. A Level 1 has no parent and is not asked for one.
  const all = useQuery({
    queryKey: ["masters", "categories", "levels"],
    queryFn: () => mastersApi.categories.list({ size: 300 }).then((p) => p.items),
  });
  const parentsAt = (level: number): Option[] => (all.data ?? [])
    .filter((c) => c.level === level - 1 && c.is_active)
    .map((c) => ({ value: c.id, label: `${c.name} · ${c.code}` }));
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
      newActions={[
        { label: "Level 1", preset: { level: 1, parent_id: null } },
        { label: "Level 2", preset: { level: 2, parent_id: null } },
        { label: "Level 3", preset: { level: 3, parent_id: null } },
      ]}
      formTitle={(v, editing) =>
        `${editing ? "Edit" : "New"} Level ${Number(v.level) || 1} category`}
      fields={(v) => {
        const level = Number(v.level) || 1;
        return [
          { key: "code", label: "Code", required: true, maxLength: 50,
            pattern: /^[A-Za-z0-9-]+$/,
            patternMessage: "Use letters, numbers or a hyphen" },
          { key: "name", label: "Name", required: true, maxLength: 200 },
          // A name may repeat under a different parent but never under the same one,
          // so the backend check is scoped to the parent chosen here.
          ...(level > 1 ? [{
            key: "parent_id", label: `Parent (Level ${level - 1})`, type: "select" as const,
            options: parentsAt(level), required: true,
            hint: parentsAt(level).length ? undefined
              : `No Level ${level - 1} category yet — add one first.`,
          }] : []),
          { key: "is_active", label: "Active", type: "switch" as const },
        ];
      }}
      emptyForm={{ code: "", name: "", parent_id: null, level: 1, is_active: true }}
      toForm={(r) => ({ code: r.code, name: r.name, parent_id: r.parent_id ?? null,
        level: r.level ?? 1, is_active: r.is_active })}
      bulk={mastersApi.categories} usage={mastersApi.categories.usage}
      // A Level 1 is created with no parent, whatever the form last held.
      onCreate={(v) => mastersApi.categories.create(
        { ...v, parent_id: v.parent_id ?? null } as Partial<MasterCategory>)
        .then((r) => { void all.refetch(); return r; })}
      onUpdate={(id, v) => mastersApi.categories.update(
        id, { ...v, parent_id: v.parent_id ?? null } as Partial<MasterCategory>)
        .then((r) => { void all.refetch(); return r; })}
      onDeactivate={mastersApi.categories.deactivate}
    />
  );
}

export function ItemClassesTab() {
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
      bulk={mastersApi.itemClasses} usage={mastersApi.itemClasses.usage}
      onCreate={(v) => mastersApi.itemClasses.create(v as Partial<MasterItemClass>)}
      onUpdate={(id, v) => mastersApi.itemClasses.update(id, v as Partial<MasterItemClass>)}
      onDeactivate={mastersApi.itemClasses.deactivate}
    />
  );
}

export function HsnCodesTab() {
  return (
    <MasterCrud<MasterHsnCode>
      title="HSN code" queryKey="hsn-codes" searchable managePerm="master.hsn.manage"
      columns={[
        { key: "code", header: "HSN", render: (r) => <Code>{r.code}</Code> },
        { key: "desc", header: "Description", render: (r) => r.description ?? "—" },
        { key: "gst", header: "GST %", render: (r) => `${r.gst_rate}%` },
        { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
      ]}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Code>{r.code}</Code><Active on={r.is_active} />
          </div>
          <div className="text-sm text-body">{r.description ?? "—"}</div>
          <div className="text-xs text-muted">GST {r.gst_rate}%</div>
        </div>
      )}
      fetchList={(search) => mastersApi.hsnCodes.list({ search, size: 300 }).then((p) => p.items)}
      fields={[
        { key: "code", label: "HSN / SAC code", required: true, maxLength: 8,
          pattern: /^\d{8}$/,
          patternMessage: "Enter exactly 8 digits, for example 10063010" },
        { key: "description", label: "Description", maxLength: 300 },
        // One rate. The within-state CGST + SGST and the across-state IGST are the
        // same number, so there is no second figure to keep consistent.
        { key: "gst_rate", label: "GST %", ...RATE_RULE },
        { key: "effective_from", label: "Effective from (YYYY-MM-DD)",
          pattern: /^\d{4}-\d{2}-\d{2}$/,
          patternMessage: "Use the format 2026-04-01" },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ code: "", description: "", gst_rate: 0,
                   effective_from: "", is_active: true }}
      toForm={(r) => ({ code: r.code, description: r.description ?? "",
        gst_rate: r.gst_rate, effective_from: r.effective_from ?? "",
        is_active: r.is_active })}
      bulk={mastersApi.hsnCodes} usage={mastersApi.hsnCodes.usage}
      onCreate={(v) => mastersApi.hsnCodes.create(v as Partial<MasterHsnCode>)}
      onUpdate={(id, v) => mastersApi.hsnCodes.update(id, v as Partial<MasterHsnCode>)}
      onDeactivate={mastersApi.hsnCodes.deactivate}
    />
  );
}

/** The rung above BrandsTab: which brands sell this general name. Kept here rather
 *  than on a mapping screen for the same reason brands carry their manufacturers —
 *  a mapping you have to remember to go and make somewhere else does not get made. */
export function GeneralNamesTab() {
  const brands = useQuery({
    queryKey: ["masters", "brands", "all"],
    queryFn: () => mastersApi.brands.list({ size: 300 }).then((r) => r.items),
  });
  const brandOpts: Option[] = (brands.data ?? [])
    .map((r) => ({ value: r.id, label: `${r.code} — ${r.name}` }));
  return (
    <MasterCrud<MasterGeneralName>
      title="Generic name" queryKey="general-names" searchable
      managePerm="master.item.manage"
      columns={[
        { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
        { key: "name", header: "Name", render: (r) => r.name },
        { key: "brands", header: "Brands", hideOnNarrow: true,
          render: (r) => r.brand_names?.length ? r.brand_names.join(", ") : "—" },
        { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
      ]}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Code>{r.code}</Code><Active on={r.is_active} />
          </div>
          <div className="text-sm text-body">{r.name}</div>
          <div className="text-xs text-muted">
            {r.brand_names?.length ? r.brand_names.join(", ") : "No brand mapped yet"}
          </div>
        </div>
      )}
      fetchList={(search) => mastersApi.generalNames.list({ search, size: 200 })
        .then((p) => p.items)}
      fields={[
        { key: "code", label: "Code", required: true, ...CODE_RULE },
        { key: "name", label: "Name", required: true, maxLength: 200 },
        { key: "brand_ids", label: "Brands", type: "multiselect", options: brandOpts,
          hint: "Leave empty to allow every brand on the item form" },
        { key: "description", label: "Description", maxLength: 300 },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ code: "", name: "", brand_ids: [], description: "",
                   is_active: true }}
      toForm={(r) => ({ code: r.code, name: r.name, brand_ids: r.brand_ids ?? [],
        description: r.description ?? "", is_active: r.is_active })}
      bulk={mastersApi.generalNames} usage={mastersApi.generalNames.usage}
      onCreate={(v) => mastersApi.generalNames.create(v as unknown as Partial<MasterGeneralName>)}
      onUpdate={(id, v) => mastersApi.generalNames.update(id, v as unknown as Partial<MasterGeneralName>)}
      onDeactivate={mastersApi.generalNames.deactivate}
    />
  );
}

export function BrandsTab() {
  const manufacturers = useQuery({
    queryKey: ["masters", "manufacturers", "all"],
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
      bulk={mastersApi.brands} usage={mastersApi.brands.usage}
      onCreate={(v) => mastersApi.brands.create(v as unknown as Partial<MasterBrand>)}
      onUpdate={(id, v) => mastersApi.brands.update(id, v as unknown as Partial<MasterBrand>)}
      onDeactivate={mastersApi.brands.deactivate}
    />
  );
}
