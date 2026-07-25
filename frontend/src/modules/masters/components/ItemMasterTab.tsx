import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Switch,
} from "@heroui/react";
import { Plus, Search } from "lucide-react";

import {
  Button, Can, Field, Input, ResponsiveList, Select, type Column,
} from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { mastersApi } from "../api";
import type {
  MasterBrandManufacturer, MasterItem, NamedMaster,
} from "../types";

export const ITEM_SECTIONS = [
  "Basic", "Kit Components", "Attributes", "Specs", "Units", "Identification",
  "Tracking", "Stock Limits", "Pricing", "Tax Rates", "Additional",
] as const;
type ItemSection = (typeof ITEM_SECTIONS)[number];

const empty = {
  name: "", short_name: "", category_id: "", general_name_id: "", brand_id: "",
  manufacturer_id: "", item_class_id: "", item_sub_class_id: "", uom_id: "",
  description: "", has_components: false, hsn_code: "", barcode_type: "AUTO",
  barcode_value: "", is_batch_tracked: false, is_serial_tracked: false,
  has_expiry: false, requires_qi: false, shelf_life_days: 0, safety_stock: 0,
  reorder_level: 0, reorder_qty: 0, lead_time_days: 0, min_order_qty: 0,
  max_order_qty: 0, purchase_price: 0, selling_price: 0, mrp: 0,
  cgst_rate: 0, sgst_rate: 0, igst_rate: 0, dosage_form_id: "",
  valuation_method: "FIFO", requires_special_storage: false,
  storage_conditions: "", requires_special_transport: false,
  transport_conditions: "", is_active: true,
};

type Form = typeof empty;
const opt = (rows: { id: number; code?: string; name: string }[]) =>
  rows.map((row) => ({
    value: row.id, label: `${row.code ? `${row.code} — ` : ""}${row.name}`,
  }));

export function manufacturersForBrand(
  manufacturers: NamedMaster[],
  mappings: MasterBrandManufacturer[],
) {
  const allowed = new Set(
    mappings.filter((row) => row.is_active).map((row) => row.manufacturer_id),
  );
  return manufacturers.filter((row) => allowed.has(row.id));
}

export function itemCodePreview(
  categoryPath?: string | null,
  generalCode?: string | null,
  brandCode?: string | null,
  manufacturerCode?: string | null,
) {
  if (![categoryPath, generalCode, brandCode, manufacturerCode].every(Boolean)) return "";
  return [categoryPath, generalCode, brandCode, manufacturerCode]
    .join("-").toUpperCase();
}

export function ItemMasterTab() {
  const { can } = useAuth();
  const canManage = can("master.item.manage");
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<MasterItem | null | undefined>(undefined);
  const [form, setForm] = useState<Form>(empty);
  const [tab, setTab] = useState<ItemSection>("Basic");
  const [level1, setLevel1] = useState("");
  const [level2, setLevel2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof Form, value: Form[keyof Form]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const items = useQuery({
    queryKey: ["masters", "items", search],
    queryFn: () => mastersApi.items.list({ search, size: 100 }),
  });
  const categories = useQuery({
    queryKey: ["masters", "categories-all"],
    queryFn: () => mastersApi.categories.list({ size: 300 }).then((r) => r.items),
  });
  const uoms = useQuery({ queryKey: ["masters", "uom"], queryFn: mastersApi.uom.listAll });
  const general = useQuery({
    queryKey: ["masters", "general-names"],
    queryFn: () => mastersApi.generalNames.list({ size: 300 }).then((r) => r.items),
  });
  const brands = useQuery({
    queryKey: ["masters", "brands-all"],
    queryFn: () => mastersApi.brands.list({ size: 300 }).then((r) => r.items),
  });
  const manufacturers = useQuery({
    queryKey: ["masters", "manufacturers"],
    queryFn: () => mastersApi.manufacturers.list({ size: 300 }).then((r) => r.items),
  });
  const mappings = useQuery({
    queryKey: ["masters", "brand-manufacturers", form.brand_id],
    queryFn: () => mastersApi.brandManufacturers.list({
      brand_id: Number(form.brand_id), size: 300,
    }).then((r) => r.items),
    enabled: Boolean(form.brand_id),
  });
  const classes = useQuery({
    queryKey: ["masters", "item-classes-all"],
    queryFn: () => mastersApi.itemClasses.list({ size: 300 }).then((r) => r.items),
  });
  const subclasses = useQuery({
    queryKey: ["masters", "item-subclasses", form.item_class_id],
    queryFn: () => mastersApi.itemSubClasses.list({
      item_class_id: Number(form.item_class_id), size: 300,
    }).then((r) => r.items),
    enabled: Boolean(form.item_class_id),
  });
  const dosage = useQuery({
    queryKey: ["masters", "dosage-forms"],
    queryFn: () => mastersApi.dosageForms.list({ size: 300 }).then((r) => r.items),
  });

  const cats = categories.data ?? [];
  const l1 = cats.filter((row) => row.level === 1);
  const l2 = cats.filter((row) => row.level === 2 && row.parent_id === Number(level1));
  const l3 = cats.filter((row) => row.level === 3 && row.parent_id === Number(level2));
  const manufacturerRows = manufacturersForBrand(
    manufacturers.data ?? [], mappings.data ?? [],
  );
  const chosenCategory = cats.find((row) => row.id === Number(form.category_id));
  const chosenGeneral = general.data?.find((row) => row.id === Number(form.general_name_id));
  const chosenBrand = brands.data?.find((row) => row.id === Number(form.brand_id));
  const chosenManufacturer = manufacturerRows.find(
    (row) => row.id === Number(form.manufacturer_id),
  );
  const preview = itemCodePreview(
    chosenCategory?.path, chosenGeneral?.code, chosenBrand?.code,
    chosenManufacturer?.code,
  );

  const payload = useMemo(() => {
    const ids = ["category_id", "general_name_id", "brand_id", "manufacturer_id",
      "item_class_id", "uom_id", "item_sub_class_id", "dosage_form_id"] as const;
    const value: Record<string, unknown> = { ...form };
    for (const key of ids) value[key] = form[key] === "" ? null : Number(form[key]);
    return value;
  }, [form]);

  const save = useMutation({
    mutationFn: () => editing
      ? mastersApi.items.update(editing.id, payload)
      : mastersApi.items.create(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["masters", "items"] });
      setEditing(undefined);
    },
    onError: (reason: Error) => setError(reason.message),
  });
  const deactivate = useMutation({
    mutationFn: (id: number) => mastersApi.items.deactivate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["masters", "items"] }),
  });

  const openNew = () => {
    setForm(empty); setEditing(null); setTab("Basic"); setLevel1(""); setLevel2("");
    setError(null);
  };
  const openEdit = (row: MasterItem) => {
    const category = cats.find((cat) => cat.id === row.category_id);
    const parent2 = cats.find((cat) => cat.id === category?.parent_id);
    setLevel1(String(parent2?.parent_id ?? ""));
    setLevel2(String(parent2?.id ?? ""));
    setForm({ ...empty, ...row, category_id: row.category_id ?? "",
      general_name_id: row.general_name_id ?? "", brand_id: row.brand_id ?? "",
      manufacturer_id: row.manufacturer_id ?? "", item_class_id: row.item_class_id ?? "",
      item_sub_class_id: row.item_sub_class_id ?? "", uom_id: row.uom_id ?? "",
      dosage_form_id: row.dosage_form_id ?? "" } as Form);
    setEditing(row); setTab("Basic"); setError(null);
  };

  const columns: Column<MasterItem>[] = [
    { key: "code", header: "Item Code", render: (row) => <span className="mono font-semibold">{row.code}</span> },
    { key: "name", header: "Name", render: (row) => row.name },
    { key: "general", header: "General Name", render: (row) => row.general_name ?? "—" },
    { key: "brand", header: "Brand / Manufacturer",
      render: (row) => `${row.brand_name ?? "—"} / ${row.manufacturer_name ?? "—"}` },
    { key: "uom", header: "Primary UOM", render: (row) => row.uom_code ?? "—" },
    { key: "status", header: "Status", render: (row) => row.is_active ? "Active" : "Inactive" },
  ];

  return (
    <div>
      <div className="mb-4 flex gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-3.5 h-4 w-4 text-muted" />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
                 placeholder="Search name or code"
                 className="h-11 w-full rounded-xl border border-line bg-content1 pl-9 pr-3 text-sm" />
        </div>
        <div className="ml-auto">
          <Can do="master.item.manage">
            <Button onClick={openNew}><Plus className="h-4 w-4" /> Add Item</Button>
          </Can>
        </div>
      </div>
      <ResponsiveList data={items.data?.items ?? []} loading={items.isLoading}
        keyOf={(row) => row.id} columns={columns}
        onRowClick={canManage ? openEdit : undefined}
        empty="No items found." renderCard={(row) => <div><b>{row.code}</b><div>{row.name}</div></div>} />

      <Modal isOpen={editing !== undefined} onOpenChange={() => setEditing(undefined)}
             size="5xl" scrollBehavior="inside">
        <ModalContent>
          <ModalHeader>{editing ? "Edit Item" : "Create Item"}</ModalHeader>
          <ModalBody>
            <ItemSectionTabs selected={tab} onChange={setTab} />
            {error && <div className="rounded-lg bg-bad-bg p-3 text-sm text-bad">{error}</div>}

            {tab === "Basic" && <div className="grid gap-4 md:grid-cols-3">
              <Field label="Category Level 1"><Select value={level1} options={opt(l1)}
                onChange={(v) => { setLevel1(v); setLevel2(""); set("category_id", ""); }} /></Field>
              <Field label="Category Level 2"><Select value={level2} options={opt(l2)}
                onChange={(v) => { setLevel2(v); set("category_id", ""); }} /></Field>
              <Field label="Category Level 3"><Select value={form.category_id} options={opt(l3)}
                onChange={(v) => set("category_id", v)} /></Field>
              <Field label="General Name"><Select value={form.general_name_id}
                options={opt(general.data ?? [])} onChange={(v) => set("general_name_id", v)} /></Field>
              <Field label="Brand"><Select value={form.brand_id}
                options={opt(brands.data ?? [])} onChange={(v) => {
                  set("brand_id", v); set("manufacturer_id", "");
                }} /></Field>
              <Field label="Manufacturer"><Select value={form.manufacturer_id}
                options={opt(manufacturerRows)} onChange={(v) => set("manufacturer_id", v)}
                isDisabled={!form.brand_id} placeholder="Select brand first" /></Field>
              <Field label="Item Class"><Select value={form.item_class_id}
                options={opt(classes.data ?? [])} onChange={(v) => {
                  set("item_class_id", v); set("item_sub_class_id", "");
                }} /></Field>
              <Field label="Item Subclass"><Select value={form.item_sub_class_id}
                options={opt(subclasses.data ?? [])}
                onChange={(v) => set("item_sub_class_id", v)} /></Field>
              <label className="flex items-center gap-2 pt-7 text-sm"><Switch size="sm"
                isSelected={form.has_components}
                onValueChange={(v) => set("has_components", v)} /> Has Components / Kit</label>
              <Field label="Generated Item Code"><Input value={preview} disabled /></Field>
              <Field label="Item Name"><Input value={form.name}
                onChange={(e) => set("name", e.target.value)} /></Field>
              <Field label="Short Name"><Input value={form.short_name}
                onChange={(e) => set("short_name", e.target.value)} /></Field>
              <div className="md:col-span-3"><Field label="Description"><Input value={form.description}
                onChange={(e) => set("description", e.target.value)} /></Field></div>
            </div>}

            {(tab === "Kit Components" || tab === "Attributes" || tab === "Specs") &&
              <div className="rounded-xl bg-content2 p-5 text-sm text-body">
                {tab === "Kit Components" && "Save the item, then configure its component items in the BOM master."}
                {tab === "Attributes" && "Attributes are supplied by the selected category and item-class mappings."}
                {tab === "Specs" && "Specification values are maintained in Item Specifications after the item is saved."}
              </div>}
            {tab === "Units" && <div className="grid gap-4 md:grid-cols-2">
              <Field label="UOM Category"><Input value={(uoms.data ?? []).find((u) => u.id === Number(form.uom_id))?.uom_class ?? ""} disabled /></Field>
              <Field label="Primary UOM"><Select value={form.uom_id} options={opt(uoms.data ?? [])}
                onChange={(v) => set("uom_id", v)} /></Field>
            </div>}
            {tab === "Identification" && <div className="grid gap-4 md:grid-cols-2">
              <Field label="HSN Code"><Input value={form.hsn_code} onChange={(e) => set("hsn_code", e.target.value)} /></Field>
              <Field label="Barcode Type"><Select value={form.barcode_type}
                options={[{value:"AUTO",label:"Auto Generate"},{value:"MANUAL",label:"Manual"}]}
                onChange={(v) => set("barcode_type", v)} /></Field>
              <Field label="Barcode Value"><Input value={form.barcode_value}
                onChange={(e) => set("barcode_value", e.target.value)} /></Field>
            </div>}
            {tab === "Tracking" && <ToggleGrid form={form} set={set} />}
            {tab === "Stock Limits" && <NumberGrid form={form} set={set}
              keys={["safety_stock","reorder_level","reorder_qty","lead_time_days","min_order_qty","max_order_qty"]} />}
            {tab === "Pricing" && <NumberGrid form={form} set={set}
              keys={["purchase_price","selling_price","mrp"]} />}
            {tab === "Tax Rates" && <NumberGrid form={form} set={set}
              keys={["cgst_rate","sgst_rate","igst_rate"]} />}
            {tab === "Additional" && <div className="grid gap-4 md:grid-cols-2">
              <Field label="Dosage Form"><Select value={form.dosage_form_id}
                options={opt(dosage.data ?? [])} onChange={(v) => set("dosage_form_id", v)} /></Field>
              <Field label="Valuation Method"><Select value={form.valuation_method}
                options={["FIFO","LIFO","WEIGHTED_AVERAGE"].map((v)=>({value:v,label:v.replace(/_/g," ")}))}
                onChange={(v) => set("valuation_method", v)} /></Field>
              <Toggle label="Requires Special Storage" value={form.requires_special_storage}
                onChange={(v) => set("requires_special_storage", v)} />
              <Field label="Storage Conditions"><Input value={form.storage_conditions}
                onChange={(e) => set("storage_conditions", e.target.value)} /></Field>
              <Toggle label="Requires Special Transport" value={form.requires_special_transport}
                onChange={(v) => set("requires_special_transport", v)} />
              <Field label="Transport Conditions"><Input value={form.transport_conditions}
                onChange={(e) => set("transport_conditions", e.target.value)} /></Field>
            </div>}
          </ModalBody>
          <ModalFooter>
            {editing && <Button variant="ghost" className="mr-auto text-bad"
              onClick={() => { deactivate.mutate(editing.id); setEditing(undefined); }}>Deactivate</Button>}
            <Button variant="ghost" onClick={() => setEditing(undefined)}>Cancel</Button>
            <Button disabled={save.isPending || !preview} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save Item"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}

export function ItemSectionTabs({
  selected, onChange,
}: {
  selected: ItemSection;
  onChange: (section: ItemSection) => void;
}) {
  return (
    <div
      aria-label="Item form sections"
      className="flex flex-wrap gap-2 border-b border-line pb-3"
    >
      {ITEM_SECTIONS.map((name) => (
        <button
          key={name}
          type="button"
          aria-pressed={selected === name}
          onClick={() => onChange(name)}
          className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
            selected === name
              ? "bg-brand text-white shadow-sm"
              : "bg-content2 text-body hover:bg-default"
          }`}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v:boolean)=>void }) {
  return <label className="flex items-center justify-between rounded-xl border border-line p-3 text-sm">
    {label}<Switch size="sm" isSelected={value} onValueChange={onChange} />
  </label>;
}
function ToggleGrid({ form, set }: { form: Form; set: (k:keyof Form,v:Form[keyof Form])=>void }) {
  return <div className="grid gap-4 md:grid-cols-4">
    <Toggle label="Has Batch" value={form.is_batch_tracked} onChange={(v)=>set("is_batch_tracked",v)} />
    <Toggle label="Has Serial" value={form.is_serial_tracked} onChange={(v)=>set("is_serial_tracked",v)} />
    <Toggle label="Has Expiry" value={form.has_expiry} onChange={(v)=>set("has_expiry",v)} />
    <Toggle label="Requires QI" value={form.requires_qi} onChange={(v)=>set("requires_qi",v)} />
    <Field label="Shelf Life (Days)"><Input type="number" value={String(form.shelf_life_days)}
      onChange={(e)=>set("shelf_life_days",Number(e.target.value))} /></Field>
  </div>;
}
function NumberGrid({ form, set, keys }: { form: Form; set:(k:keyof Form,v:Form[keyof Form])=>void; keys:(keyof Form)[] }) {
  return <div className="grid gap-4 md:grid-cols-3">{keys.map((key)=>
    <Field key={key} label={String(key).replace(/_/g," ").replace(/\b\w/g,(c: string)=>c.toUpperCase())}>
      <Input type="number" min={0} value={String(form[key])}
        onChange={(e)=>set(key,Number(e.target.value))} />
    </Field>)}</div>;
}
