import { useEffect, useMemo, useState } from "react";
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
import { BulkBar } from "./BulkBar";
import type {
  MasterBrand, MasterBrandManufacturer, MasterCategoryTag, MasterGeneralName,
  MasterItem, MasterItemComponent,
  MasterItemPackaging, NamedMaster, PackagingBreakdown, UomClass,
} from "../types";

export const ITEM_SECTIONS = [
  "Basic", "Kit Components", "Attributes", "Specs", "Features", "Units",
  "Identification", "Tracking", "Packaging", "Additional",
] as const;
type ItemSection = (typeof ITEM_SECTIONS)[number];

type DraftComponent = {
  component_item_id: number;
  quantity: number;
  remarks: string;
};

/** Pricing, tax rates, stock limits and shelf life are deliberately absent: tax
 *  comes from the HSN row, reorder levels are a warehouse decision, and expiry is
 *  tracked per batch rather than as one number on the item. */
const empty = {
  name: "", short_name: "", category_id: "", general_name_id: "", brand_id: "",
  manufacturer_id: "", item_class_id: "", item_sub_class_id: "", uom_id: "",
  hsn_id: "", is_asset: false,
  description: "", has_components: false, barcode_type: "AUTO",
  barcode_value: "", is_batch_tracked: false, is_serial_tracked: false,
  is_imei_tracked: false, has_expiry: false, requires_qi: false,
  dosage_form_id: "", valuation_method: "FIFO", requires_special_storage: false,
  storage_conditions: "", requires_special_transport: false,
  transport_conditions: "", is_active: true,
};

type Form = typeof empty;
const opt = (rows: { id: number; code?: string | null; name: string }[]) =>
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

/** The rung above: which brands sell the chosen general name.
 *
 *  An unmapped general name falls back to every brand rather than to none. The
 *  mapping starts empty on the day it ships, and narrowing strictly would mean no
 *  item could be created until someone had mapped all of them first. Narrowing
 *  begins the moment a general name is given brands, one at a time. */
export function brandsForGeneralName(
  brands: MasterBrand[],
  general?: MasterGeneralName,
) {
  const allowed = general?.brand_ids ?? [];
  if (!general || allowed.length === 0) return brands;
  const ids = new Set(allowed);
  return brands.filter((row) => ids.has(row.id));
}

/** What the code will look like. The four-digit serial is allocated by the server
 *  at save, so a new item shows #### rather than a number that might be taken. */
export function itemCodePreview(
  categoryPath?: string | null,
  generalCode?: string | null,
  brandCode?: string | null,
  manufacturerCode?: string | null,
  serial?: number | null,
) {
  if (![categoryPath, generalCode, brandCode, manufacturerCode].every(Boolean)) return "";
  const tail = serial ? String(serial).padStart(4, "0") : "####";
  return [categoryPath, generalCode, brandCode, manufacturerCode]
    .join("-").toUpperCase() + `-${tail}`;
}

/** Fields required by the category, with nothing filled in yet. */
export function missingRequiredTags(
  tags: MasterCategoryTag[],
  values: Record<string, string>,
) {
  return tags
    .filter((tag) => tag.is_required && tag.is_active)
    .filter((tag) => {
      const value = values[tag.tag_code ?? String(tag.tag_id)] ?? "";
      return tag.tag_type === "FEATURE"
        ? !["true", "yes", "1"].includes(String(value).toLowerCase())
        : !String(value).trim();
    });
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
  const [uomClass, setUomClass] = useState<UomClass | "">("");
  const [hsnCode, setHsnCode] = useState("");
  const [draftComponents, setDraftComponents] = useState<DraftComponent[]>([]);
  // Answers to whatever the category asks for, keyed by tag code. Saved into
  // mst_item_specs.specifications once the item itself exists.
  const [tagValues, setTagValues] = useState<Record<string, string>>({});
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
  const hsn = useQuery({
    queryKey: ["masters", "hsn-codes-all"],
    queryFn: () => mastersApi.hsnCodes.list({ size: 500 }).then((r) => r.items),
  });
  const dosage = useQuery({
    queryKey: ["masters", "dosage-forms"],
    queryFn: () => mastersApi.dosageForms.list({ size: 300 }).then((r) => r.items),
  });
  // Tags on a parent category apply to every child. The Level 3 category may
  // override a repeated tag by defining it closer to the item.
  const categoryTags = useQuery({
    queryKey: [
      "masters", "category-tags-for-item", level1, level2, form.category_id,
    ],
    queryFn: async () => {
      const categoryIds = [level1, level2, String(form.category_id)]
        .filter(Boolean);
      const pages = await Promise.all(categoryIds.map((categoryId) =>
        mastersApi.categoryTags.list({
          category_id: Number(categoryId), size: 200,
        }).then((r) => r.items)));
      const inherited = new Map<string, MasterCategoryTag>();
      for (const page of pages) {
        for (const tag of page) inherited.set(`${tag.tag_type}:${tag.tag_id}`, tag);
      }
      return Array.from(inherited.values());
    },
    enabled: Boolean(form.category_id),
  });
  const savedSpec = useQuery({
    queryKey: ["masters", "item-spec", editing?.id],
    queryFn: () => mastersApi.itemSpecs.get(editing!.id),
    enabled: Boolean(editing?.id),
  });

  // Pre-fill the answers from whatever was saved last time this item was edited.
  useEffect(() => {
    if (savedSpec.data) {
      setTagValues(
        Object.fromEntries(Object.entries(savedSpec.data.specifications ?? {})
          .map(([key, value]) => [
            key,
            value == null || value === false ? "" : String(value),
          ])),
      );
    }
  }, [savedSpec.data]);

  useEffect(() => {
    if (!/^\d{8}$/.test(hsnCode)) return;
    const match = hsn.data?.find((row) => row.code === hsnCode);
    if (match) {
      setForm((current) => String(current.hsn_id) === String(match.id)
        ? current : { ...current, hsn_id: String(match.id) });
    }
  }, [hsn.data, hsnCode]);

  const cats = categories.data ?? [];
  useEffect(() => {
    if (!editing || !form.category_id || cats.length === 0) return;
    const category = cats.find((row) => row.id === Number(form.category_id));
    const parent2 = cats.find((row) => row.id === category?.parent_id);
    setLevel1(String(parent2?.parent_id ?? ""));
    setLevel2(String(parent2?.id ?? ""));
  }, [categories.data, editing?.id, form.category_id]);
  const l1 = cats.filter((row) => row.level === 1);
  const l2 = cats.filter((row) => row.level === 2 && row.parent_id === Number(level1));
  const l3 = cats.filter((row) => row.level === 3 && row.parent_id === Number(level2));
  const manufacturerRows = manufacturersForBrand(
    manufacturers.data ?? [], mappings.data ?? [],
  );
  const chosenCategory = cats.find((row) => row.id === Number(form.category_id));
  const chosenGeneral = general.data?.find((row) => row.id === Number(form.general_name_id));
  const brandRows = brandsForGeneralName(brands.data ?? [], chosenGeneral);
  const chosenBrand = brands.data?.find((row) => row.id === Number(form.brand_id));
  const chosenManufacturer = manufacturerRows.find(
    (row) => row.id === Number(form.manufacturer_id),
  );
  const preview = itemCodePreview(
    chosenCategory?.path, chosenGeneral?.code, chosenBrand?.code,
    chosenManufacturer?.code, editing?.serial_no,
  );

  const tags = categoryTags.data ?? [];
  const attributeTags = tags.filter((t) => t.tag_type === "ATTRIBUTE" && t.is_active);
  const specTags = tags.filter((t) => t.tag_type === "SPEC" && t.is_active);
  const featureTags = tags.filter((t) => t.tag_type === "FEATURE" && t.is_active);
  const unanswered = missingRequiredTags(tags, tagValues);
  const matchedHsn = (hsn.data ?? []).find((row) => row.code === hsnCode);
  const hsnFormatError = hsnCode.length > 0 && !/^\d{8}$/.test(hsnCode)
    ? "Enter exactly 8 digits, for example 10063010"
    : null;

  // Units are offered by class, so a temperature item is never given kilograms.
  const uomRows = uoms.data ?? [];
  const classesInUse = Array.from(new Set(uomRows.map((u) => u.uom_class)));
  const unitsForClass = uomClass
    ? uomRows.filter((u) => u.uom_class === uomClass) : uomRows;

  const payload = useMemo(() => {
    const ids = ["category_id", "general_name_id", "brand_id", "manufacturer_id",
      "item_class_id", "uom_id", "item_sub_class_id", "dosage_form_id",
      "hsn_id"] as const;
    const value: Record<string, unknown> = { ...form };
    for (const key of ids) value[key] = form[key] === "" ? null : Number(form[key]);
    return value;
  }, [form]);

  const save = useMutation({
    mutationFn: async () => {
      const resolvedHsn = matchedHsn ?? await mastersApi.hsnCodes.resolve(hsnCode);
      const itemPayload = { ...payload, hsn_id: resolvedHsn.id };
      const saved = editing
        ? await mastersApi.items.update(editing.id, itemPayload)
        : await mastersApi.items.create(itemPayload);
      let addedComponents = 0;
      try {
        // Saving even an empty object is intentional: changing category or
        // deselecting every feature must clear values that no longer apply.
        await mastersApi.itemSpecs.save(saved.id, { specifications: tagValues });
        if (form.has_components && draftComponents.length) {
          const existing = await mastersApi.itemComponents.list({
            item_id: saved.id, size: 200, include_inactive: true,
          }).then((r) => r.items);
          const firstLine = Math.max(0, ...existing.map((line) => line.line_no)) + 1;
          for (const [index, component] of draftComponents.entries()) {
            await mastersApi.itemComponents.create({
              item_id: saved.id,
              component_item_id: component.component_item_id,
              line_no: firstLine + index,
              quantity: component.quantity,
              remarks: component.remarks || null,
            });
            addedComponents += 1;
          }
        }
      } catch (reason) {
        // The item now exists even if a dependent row failed. Keep the modal in
        // edit mode so retrying cannot create a duplicate item.
        setDraftComponents((current) => current.slice(addedComponents));
        setEditing(saved);
        throw reason;
      }
      return saved;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["masters", "items"] });
      qc.invalidateQueries({ queryKey: ["masters", "hsn-codes-all"] });
      setDraftComponents([]);
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
    setUomClass(""); setHsnCode(""); setTagValues({}); setDraftComponents([]);
    setError(null);
  };
  const openEdit = (row: MasterItem) => {
    const category = cats.find((cat) => cat.id === row.category_id);
    const parent2 = cats.find((cat) => cat.id === category?.parent_id);
    setLevel1(String(parent2?.parent_id ?? ""));
    setLevel2(String(parent2?.id ?? ""));
    setUomClass(uomRows.find((u) => u.id === row.uom_id)?.uom_class ?? "");
    setForm({ ...empty, ...row, category_id: row.category_id ?? "",
      general_name_id: row.general_name_id ?? "", brand_id: row.brand_id ?? "",
      manufacturer_id: row.manufacturer_id ?? "", item_class_id: row.item_class_id ?? "",
      item_sub_class_id: row.item_sub_class_id ?? "", uom_id: row.uom_id ?? "",
      hsn_id: row.hsn_id ?? "",
      dosage_form_id: row.dosage_form_id ?? "" } as Form);
    setHsnCode(row.hsn_code ?? "");
    setTagValues({}); setDraftComponents([]); setEditing(row); setTab("Basic");
    setError(null);
  };

  // The Save button stays honest about why it is disabled rather than silently
  // refusing: identity, a unit, an HSN, and every field the category insists on.
  const blocker = !form.category_id ? "Category is required"
    : !form.general_name_id ? "General name is required"
    : !form.brand_id ? "Brand is required"
    : !form.manufacturer_id ? "Manufacturer is required"
    : !preview ? "Complete the category, general name, brand and manufacturer"
    : !form.name.trim() ? "Give the item a name"
    : !form.uom_id ? "Pick a primary unit on the Units tab"
    : !hsnCode ? "Enter an HSN code on the Identification tab"
    : hsnFormatError ? hsnFormatError
    : unanswered.length ? `Answer ${unanswered.map((t) => t.tag_name).join(", ")}`
    : null;

  const columns: Column<MasterItem>[] = [
    { key: "code", header: "Item Code", render: (row) => <span className="mono font-semibold">{row.code}</span> },
    { key: "name", header: "Name", render: (row) => row.name },
    { key: "general", header: "General Name", render: (row) => row.general_name ?? "—" },
    { key: "brand", header: "Brand / Manufacturer",
      render: (row) => `${row.brand_name ?? "—"} / ${row.manufacturer_name ?? "—"}` },
    { key: "hsn", header: "HSN", render: (row) => row.hsn_code ?? "—" },
    { key: "kind", header: "Kind", render: (row) => (row.is_asset ? "Asset" : "Consumable") },
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
      {/* The item master has its own tab component rather than MasterCrud, so the
          bulk bar is placed by hand here instead of coming with the factory. */}
      <BulkBar api={mastersApi.items} managePerm="master.item.manage"
               queryKey="items" label="Items" />
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
              <Field label="Category Level 1 *"><Select value={level1} options={opt(l1)}
                onChange={(v) => {
                  setLevel1(v); setLevel2(""); set("category_id", "");
                  setTagValues({});
                }} /></Field>
              <Field label="Category Level 2 *"><Select value={level2} options={opt(l2)}
                onChange={(v) => {
                  setLevel2(v); set("category_id", ""); setTagValues({});
                }}
                isDisabled={!level1} placeholder="Pick Level 1 first" /></Field>
              <Field label="Category Level 3 *"><Select value={form.category_id} options={opt(l3)}
                onChange={(v) => {
                  set("category_id", v); setTagValues({});
                }}
                isDisabled={!level2} placeholder="Pick Level 2 first" /></Field>
              {/* The six-digit path is what the item code is built from, so it is
                  worth showing before the code itself exists. */}
              <Field label="Category Path"><Input value={chosenCategory?.path ?? ""} disabled /></Field>
              <Field label="General Name *"><Select value={form.general_name_id}
                options={opt(general.data ?? [])} onChange={(v) => {
                  // Same clear-the-rung-below rule the brand already follows: the
                  // brand list is about to change, so a stale pick must not survive.
                  set("general_name_id", v); set("brand_id", ""); set("manufacturer_id", "");
                }} /></Field>
              <Field label="Brand *"><Select value={form.brand_id}
                options={opt(brandRows)} onChange={(v) => {
                  set("brand_id", v); set("manufacturer_id", "");
                }}
                isDisabled={!form.general_name_id}
                placeholder="Select general name first" /></Field>
              <Field label="Manufacturer *"><Select value={form.manufacturer_id}
                options={opt(manufacturerRows)} onChange={(v) => set("manufacturer_id", v)}
                isDisabled={!form.brand_id} placeholder="Select brand first" /></Field>
              <Field label="Item Class"><Select value={form.item_class_id}
                options={opt(classes.data ?? [])} onChange={(v) => {
                  set("item_class_id", v); set("item_sub_class_id", "");
                }} /></Field>
              <Field label="Item Subclass"><Select value={form.item_sub_class_id}
                options={opt(subclasses.data ?? [])}
                onChange={(v) => set("item_sub_class_id", v)}
                isDisabled={!form.item_class_id} placeholder="Select class first" /></Field>
              <label className="flex items-center gap-2 pt-7 text-sm"><Switch size="sm"
                isSelected={form.has_components}
                onValueChange={(v) => {
                  set("has_components", v);
                  if (!v) setDraftComponents([]);
                }} /> Has Components / Kit</label>
              <Field label="Generated Item Code"
                     hint={editing ? "Fixed at creation — never renumbered" : "The 4-digit serial is assigned on save"}>
                <Input value={preview} disabled /></Field>
              <Field label="Item Name"><Input value={form.name}
                onChange={(e) => set("name", e.target.value)} /></Field>
              <Field label="Short Name"><Input value={form.short_name}
                onChange={(e) => set("short_name", e.target.value)} /></Field>
              <div className="md:col-span-3"><Field label="Description"><Input value={form.description}
                onChange={(e) => set("description", e.target.value)} /></Field></div>
            </div>}

            {tab === "Kit Components" && (
              !form.has_components
                ? <Empty>Turn on <b>Has Components / Kit</b> on the Basic tab to list what is inside this kit.</Empty>
                : !editing || !editing.has_components || draftComponents.length > 0
                  ? <DraftKitComponents itemId={editing?.id}
                      values={draftComponents} onChange={setDraftComponents} />
                  : <KitComponents itemId={editing.id} />
            )}

            {tab === "Attributes" && (
              !form.category_id
                ? <Empty>Pick a Level 3 category on the Basic tab. Its attributes appear here.</Empty>
                : categoryTags.isLoading
                  ? <Empty>Loading category attributes…</Empty>
                  : categoryTags.error
                    ? <Empty>Category attributes could not be loaded.</Empty>
                : attributeTags.length === 0
                  ? <Empty>This category asks for no attributes. Add some under Category Tagging.</Empty>
                  : <TagFields tags={attributeTags} values={tagValues} onChange={setTagValues} />
            )}

            {tab === "Specs" && (
              !form.category_id
                ? <Empty>Pick a Level 3 category on the Basic tab. Its specs appear here.</Empty>
                : categoryTags.isLoading
                  ? <Empty>Loading category specs…</Empty>
                  : categoryTags.error
                    ? <Empty>Category specs could not be loaded.</Empty>
                : specTags.length === 0
                  ? <Empty>This category asks for no specs. Add some under Category Tagging.</Empty>
                  : <TagFields tags={specTags} values={tagValues} onChange={setTagValues} />
            )}

            {tab === "Features" && (
              !form.category_id
                ? <Empty>Pick a Level 3 category on the Basic tab. Its features appear here.</Empty>
                : categoryTags.isLoading
                  ? <Empty>Loading category features…</Empty>
                  : categoryTags.error
                    ? <Empty>Category features could not be loaded.</Empty>
                : featureTags.length === 0
                  ? <Empty>This category has no tagged features.</Empty>
                  : <FeatureFields tags={featureTags} values={tagValues}
                      onChange={setTagValues} />
            )}

            {tab === "Units" && <div className="grid gap-4 md:grid-cols-2">
              {/* Class first, then only the units of that class — litres never
                  appear as an option for something measured in degrees. */}
              <Field label="What it measures"><Select value={uomClass}
                options={classesInUse.map((c) => ({ value: c, label: c }))}
                onChange={(v) => { setUomClass(v as UomClass); set("uom_id", ""); }} /></Field>
              <Field label="Primary UOM"
                     hint={uomClass ? undefined : "Pick a measurement class to narrow this list"}>
                <Select value={form.uom_id} options={opt(unitsForClass)}
                        onChange={(v) => set("uom_id", v)} /></Field>
            </div>}

            {tab === "Identification" && <div className="grid gap-4 md:grid-cols-2">
              {/* Mandatory. Tax is read from this row at PO and GRN time rather
                  than copied onto the item, so a rate change needs no item edit. */}
              <Field label="HSN Code"
                     hint={matchedHsn
                       ? matchedHsn.description || "Found in the HSN master"
                       : /^\d{8}$/.test(hsnCode)
                         ? "New code: it will be added to the HSN master with zero GST rates"
                         : "Required. Enter exactly 8 digits."}>
                <Input value={hsnCode} inputMode="numeric" maxLength={8}
                       isInvalid={Boolean(hsnFormatError)}
                       errorMessage={hsnFormatError ?? undefined}
                       placeholder="10063010"
                       onChange={(e) => {
                         const value = e.target.value;
                         setHsnCode(value);
                         const match = (hsn.data ?? []).find((row) => row.code === value);
                         set("hsn_id", match ? String(match.id) : "");
                       }} /></Field>
              <Field label="Barcode Type"><Select value={form.barcode_type}
                options={[{value:"AUTO",label:"Auto Generate"},{value:"MANUAL",label:"Manual"}]}
                onChange={(v) => set("barcode_type", v)} /></Field>
              <Field label="Barcode Value"><Input value={form.barcode_value}
                onChange={(e) => set("barcode_value", e.target.value)} /></Field>
            </div>}

            {tab === "Tracking" && <ToggleGrid form={form} set={set} />}

            {tab === "Packaging" && (
              !editing
                ? <Empty>Save the item first — the packing ladder is built against it.</Empty>
                : <ItemPackagingLadder itemId={editing.id}
                    itemName={editing.name} baseUom={editing.uom_code} />
            )}

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
          <ModalFooter className="items-center">
            {editing && <Button variant="ghost" className="mr-auto text-bad"
              onClick={() => { deactivate.mutate(editing.id); setEditing(undefined); }}>Deactivate</Button>}
            {blocker && <span className="mr-3 text-xs text-muted">{blocker}</span>}
            <Button variant="ghost" onClick={() => setEditing(undefined)}>Cancel</Button>
            <Button disabled={save.isPending || Boolean(blocker)} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save Item"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl bg-content2 p-5 text-sm text-body">{children}</div>;
}

/** Renders whatever the category asked for. A LIST attribute becomes a dropdown of
 *  its own options; a spec shows the unit it is measured in. */
export function TagFields({ tags, values, onChange }: {
  tags: MasterCategoryTag[];
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const attributes = useQuery({
    queryKey: ["masters", "attributes-all"],
    queryFn: () => mastersApi.attributes.list({ size: 300 }).then((r) => r.items),
  });
  const set = (code: string, value: string) =>
    onChange({ ...values, [code]: value });

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {tags.map((tag) => {
        const code = tag.tag_code ?? String(tag.tag_id);
        const definition = attributes.data?.find((a) => a.id === tag.tag_id);
        const label = `${tag.tag_name}${tag.tag_uom_code ? ` (${tag.tag_uom_code})` : ""}` +
          (tag.is_required ? " *" : "");
        if (tag.tag_type === "ATTRIBUTE" && definition?.data_type === "LIST") {
          return (
            <Field key={tag.id} label={label}>
              <Select value={values[code] ?? ""}
                      options={(definition.allowed_values ?? [])
                        .map((v) => ({ value: v, label: v }))}
                      onChange={(v) => set(code, v)} />
            </Field>
          );
        }
        if (tag.tag_type === "ATTRIBUTE" && definition?.data_type === "BOOLEAN") {
          return (
            <Field key={tag.id} label={label}>
              <Select value={values[code] ?? ""}
                      options={[{ value: "Yes", label: "Yes" },
                                { value: "No", label: "No" }]}
                      onChange={(v) => set(code, v)} />
            </Field>
          );
        }
        const numeric = tag.tag_type === "SPEC" || definition?.data_type === "NUMBER";
        return (
          <Field key={tag.id} label={label}>
            <Input type={numeric ? "number" : "text"} value={values[code] ?? ""}
                   onChange={(e) => set(code, e.target.value)} />
          </Field>
        );
      })}
    </div>
  );
}

/** Features are independent yes/no choices. Every tagged feature is available, and
 *  several can be selected at the same time. */
export function FeatureFields({ tags, values, onChange }: {
  tags: MasterCategoryTag[];
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {tags.map((tag) => {
        const code = tag.tag_code ?? String(tag.tag_id);
        const selected = ["true", "yes", "1"]
          .includes(String(values[code] ?? "").toLowerCase());
        return (
          <label key={tag.id}
                 className="flex min-h-14 items-center justify-between gap-4 rounded-lg border border-line px-3 py-2 text-sm text-body">
            <span>
              {tag.tag_name}
              {tag.is_required && <span className="text-bad"> *</span>}
            </span>
            <Switch size="sm" isSelected={selected}
                    onValueChange={(value) =>
                      onChange({ ...values, [code]: value ? "true" : "" })} />
          </label>
        );
      })}
    </div>
  );
}

/** Components entered before the item exists. They are persisted immediately after
 *  the item save, so turning on the kit flag is useful during initial creation. */
function DraftKitComponents({ itemId, values, onChange }: {
  itemId?: number;
  values: DraftComponent[];
  onChange: (next: DraftComponent[]) => void;
}) {
  const [componentId, setComponentId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [remarks, setRemarks] = useState("");
  const items = useQuery({
    queryKey: ["masters", "items-all"],
    queryFn: () => mastersApi.items.list({ size: 300 }).then((r) => r.items),
  });
  const selectedIds = new Set(values.map((line) => line.component_item_id));
  const itemRows = items.data ?? [];
  const add = () => {
    const id = Number(componentId);
    if (!id || Number(quantity) <= 0 || selectedIds.has(id)) return;
    onChange([...values, {
      component_item_id: id,
      quantity: Number(quantity),
      remarks,
    }]);
    setComponentId("");
    setQuantity("1");
    setRemarks("");
  };
  const columns: Column<DraftComponent>[] = [
    { key: "name", header: "Component", render: (row) =>
        itemRows.find((item) => item.id === row.component_item_id)?.name ?? "—" },
    { key: "qty", header: "Quantity", render: (row) => row.quantity },
    { key: "uom", header: "UOM", render: (row) =>
        itemRows.find((item) => item.id === row.component_item_id)?.uom_code ?? "—" },
    { key: "remarks", header: "Remarks", render: (row) => row.remarks || "—" },
    { key: "act", header: "", render: (row) => (
        <Button variant="ghost" className="text-bad"
                onClick={() => onChange(values.filter(
                  (line) => line.component_item_id !== row.component_item_id,
                ))}>
          Remove
        </Button>
      ) },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-[2fr_1fr_2fr_auto] md:items-end">
        <Field label="Component item">
          <Select value={componentId}
                  options={itemRows
                    .filter((item) => item.id !== itemId && !selectedIds.has(item.id))
                    .map((item) => ({
                      value: item.id, label: `${item.code} — ${item.name}`,
                    }))}
                  onChange={setComponentId} />
        </Field>
        <Field label="Quantity">
          <Input type="number" min={0} value={quantity}
                 onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        <Field label="Remarks">
          <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </Field>
        <Button onClick={add}
                disabled={!componentId || Number(quantity) <= 0}>
          Add
        </Button>
      </div>
      <ResponsiveList data={values} loading={items.isLoading}
        keyOf={(row) => row.component_item_id} columns={columns}
        empty="No components selected."
        renderCard={(row) => {
          const item = itemRows.find((candidate) =>
            candidate.id === row.component_item_id);
          return (
            <div>
              <div className="text-sm text-body">{item?.name ?? "—"}</div>
              <div className="text-xs text-muted">
                {row.quantity} {item?.uom_code ?? ""}
              </div>
            </div>
          );
        }} />
    </div>
  );
}

/** The kit's contents. Real items, so they can be issued and stock-checked. */
function KitComponents({ itemId }: { itemId: number }) {
  const qc = useQueryClient();
  const [componentId, setComponentId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [remarks, setRemarks] = useState("");
  const [error, setError] = useState<string | null>(null);

  const lines = useQuery({
    queryKey: ["masters", "item-components", itemId],
    queryFn: () => mastersApi.itemComponents
      .list({ item_id: itemId, size: 200 }).then((r) => r.items),
  });
  const items = useQuery({
    queryKey: ["masters", "items-all"],
    queryFn: () => mastersApi.items.list({ size: 300 }).then((r) => r.items),
  });
  const add = useMutation({
    mutationFn: () => mastersApi.itemComponents.create({
      item_id: itemId, component_item_id: Number(componentId),
      line_no: Math.max(0, ...(lines.data ?? []).map((line) => line.line_no)) + 1,
      quantity: Number(quantity), remarks: remarks || null,
    }),
    onSuccess: () => {
      setComponentId(""); setQuantity("1"); setRemarks(""); setError(null);
      qc.invalidateQueries({ queryKey: ["masters", "item-components", itemId] });
    },
    onError: (reason: Error) => setError(reason.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => mastersApi.itemComponents.deactivate(id),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ["masters", "item-components", itemId] });
    },
    onError: (reason: Error) => setError(reason.message),
  });
  const existingComponentIds = new Set(
    (lines.data ?? []).map((line) => line.component_item_id),
  );

  const columns: Column<MasterItemComponent>[] = [
    { key: "line", header: "#", render: (r) => r.line_no },
    { key: "name", header: "Component", render: (r) => r.component_name ?? "—" },
    { key: "qty", header: "Quantity", render: (r) => r.quantity },
    { key: "uom", header: "UOM", render: (r) => r.uom_code ?? "—" },
    { key: "remarks", header: "Remarks", render: (r) => r.remarks ?? "—" },
    { key: "act", header: "", render: (r) => (
        <Button variant="ghost" className="text-bad"
                onClick={() => remove.mutate(r.id)}>Remove</Button>) },
  ];

  return (
    <div className="space-y-4">
      {error && <div className="rounded-lg bg-bad-bg p-3 text-sm text-bad">{error}</div>}
      <div className="grid gap-3 md:grid-cols-[2fr_1fr_2fr_auto] md:items-end">
        <Field label="Component item">
          <Select value={componentId}
                  options={(items.data ?? [])
                    .filter((i) =>
                      i.id !== itemId && !existingComponentIds.has(i.id))
                    .map((i) => ({ value: i.id, label: `${i.code} — ${i.name}` }))}
                  onChange={setComponentId} /></Field>
        <Field label="Quantity">
          <Input type="number" min={0} value={quantity}
                 onChange={(e) => setQuantity(e.target.value)} /></Field>
        <Field label="Remarks">
          <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
        <Button onClick={() => add.mutate()}
                disabled={!componentId || Number(quantity) <= 0 || add.isPending}>
          Add
        </Button>
      </div>
      {/* The UOM is not asked for: it follows the component's own stocking unit. */}
      <ResponsiveList data={lines.data ?? []} loading={lines.isLoading}
        keyOf={(r) => r.id} columns={columns}
        empty="No components yet."
        renderCard={(r) => (
          <div>
            <div className="text-sm text-body">{r.component_name}</div>
            <div className="text-xs text-muted">{r.quantity} {r.uom_code}</div>
          </div>
        )} />
    </div>
  );
}

function amount(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

export function packagingBreakupText(
  row: PackagingBreakdown, baseUom?: string | null, itemName?: string,
) {
  const packages = row.package_breakup
    .map((part) => `${amount(part.quantity)} ${part.package_name ?? "package"}`);
  const product = `${amount(row.base_quantity)} ${row.base_uom_code ?? baseUom ?? "units"}`;
  return `${packages.join(" = ")} = ${product}${itemName ? ` of ${itemName}` : ""}`;
}

/** An item's container ladder. Level 1 holds the item's UOM directly; each level
 *  above contains a whole number of the package immediately below it. */
function ItemPackagingLadder({ itemId, itemName, baseUom }: {
  itemId: number; itemName: string; baseUom?: string | null;
}) {
  const qc = useQueryClient();
  const [packageId, setPackageId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [error, setError] = useState<string | null>(null);

  const rungs = useQuery({
    queryKey: ["masters", "item-packaging", itemId],
    queryFn: () => mastersApi.itemPackaging
      .list({ item_id: itemId, size: 50, include_inactive: true })
      .then((r) => r.items),
  });
  const breakdown = useQuery({
    queryKey: ["masters", "packaging-breakdown", itemId],
    queryFn: () => mastersApi.itemPackaging.breakdown(itemId),
  });
  const packages = useQuery({
    queryKey: ["masters", "packaging-all"],
    queryFn: () => mastersApi.packaging.list({ size: 200 }).then((r) => r.items),
  });

  const activeRungs = (rungs.data ?? []).filter((rung) => rung.is_active);
  const nextLevel = Math.max(0, ...activeRungs.map((rung) => rung.level)) + 1;
  const below = breakdown.data?.find((row) => row.level === nextLevel - 1);
  const inactiveAtNextLevel = (rungs.data ?? [])
    .find((rung) => rung.level === nextLevel && !rung.is_active);
  const selectedPackage = (packages.data ?? [])
    .find((row) => row.id === Number(packageId));
  const enteredQuantity = Number(quantity);
  const quantityValid = enteredQuantity > 0
    && (nextLevel === 1 || Number.isInteger(enteredQuantity));
  const projectedBreakup = selectedPackage && quantityValid
    ? [
        { package_id: selectedPackage.id, package_name: selectedPackage.name,
          quantity: 1 },
        ...(below?.package_breakup ?? []).map((part) => ({
          ...part, quantity: part.quantity * enteredQuantity,
        })),
      ]
    : [];
  const projectedBaseQuantity = enteredQuantity * (below?.base_quantity ?? 1);
  const add = useMutation({
    mutationFn: () => {
      const payload = {
        item_id: itemId, level: nextLevel, package_id: Number(packageId),
        quantity: enteredQuantity, is_active: true,
      };
      return inactiveAtNextLevel
        ? mastersApi.itemPackaging.update(inactiveAtNextLevel.id, payload)
        : mastersApi.itemPackaging.create(payload);
    },
    onSuccess: () => {
      setPackageId(""); setQuantity(""); setError(null);
      qc.invalidateQueries({ queryKey: ["masters", "item-packaging", itemId] });
      qc.invalidateQueries({ queryKey: ["masters", "packaging-breakdown", itemId] });
    },
    onError: (reason: Error) => setError(reason.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => mastersApi.itemPackaging.deactivate(id),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ["masters", "item-packaging", itemId] });
      qc.invalidateQueries({ queryKey: ["masters", "packaging-breakdown", itemId] });
    },
    onError: (reason: Error) => setError(reason.message),
  });
  const highestLevel = Math.max(0, ...activeRungs.map((rung) => rung.level));

  const columns: Column<MasterItemPackaging>[] = [
    { key: "level", header: "Level", render: (r) => r.level },
    { key: "breakup", header: "Packaging breakup", render: (r) => {
        const row = breakdown.data?.find((b) => b.level === r.level);
        return row ? packagingBreakupText(row, baseUom, itemName) : "Calculating…";
      } },
    { key: "end", header: "End product", hideOnNarrow: true, render: (r) => {
        const row = breakdown.data?.find((b) => b.level === r.level);
        return row
          ? `${amount(row.base_quantity)} ${row.base_uom_code ?? baseUom ?? "units"}`
          : "—";
      } },
    { key: "act", header: "", render: (r) => (
        r.level === highestLevel
          ? <Button variant="ghost" className="text-bad"
                    onClick={() => remove.mutate(r.id)}>Remove</Button>
          : null) },
  ];

  return (
    <div className="space-y-4">
      {error && <div className="rounded-lg bg-bad-bg p-3 text-sm text-bad">{error}</div>}
      <p className="text-sm text-muted">
        Level 1 contains the product directly in {baseUom ?? "the item's UOM"}.
        Each higher level contains a whole number of the container immediately below.
      </p>
      <div className="grid gap-3 md:grid-cols-[2fr_1fr_auto] md:items-end">
        <Field label={`Level ${nextLevel} container type`}>
          <Select value={packageId}
                  options={(packages.data ?? [])
                    .filter((p) => p.is_active)
                    .map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` }))}
                  onChange={setPackageId} /></Field>
        <Field label={nextLevel === 1
          ? `End product quantity (${baseUom ?? "item UOM"})`
          : `${below?.package_name ?? "Lower containers"} inside one`}>
          <Input type="number" min={0} step={nextLevel === 1 ? "0.001" : "1"}
                 value={quantity}
                 onChange={(e) => setQuantity(e.target.value)} /></Field>
        <Button onClick={() => add.mutate()}
                disabled={!packageId || !quantityValid || add.isPending}>
          Add level {nextLevel}
        </Button>
      </div>
      {quantity && nextLevel > 1 && !Number.isInteger(enteredQuantity) && (
        <div className="text-sm text-bad">
          Enter a whole number of {below?.package_name ?? "lower containers"}.
        </div>
      )}
      {projectedBreakup.length > 0 && (
        <div className="rounded-lg bg-content2 px-3 py-2 text-sm text-body">
          Preview: {packagingBreakupText({
            level: nextLevel,
            package_id: selectedPackage!.id,
            package_name: selectedPackage!.name,
            quantity: enteredQuantity,
            package_breakup: projectedBreakup,
            base_quantity: projectedBaseQuantity,
            base_uom_code: baseUom,
          }, baseUom, itemName)}
        </div>
      )}
      <ResponsiveList data={activeRungs} loading={rungs.isLoading}
        keyOf={(r) => r.id} columns={columns}
        empty="No packaging levels yet."
        renderCard={(r) => (
          <div>
            <div className="text-sm text-body">Level {r.level} · {r.package_name}</div>
            <div className="text-xs text-muted">
              {(() => {
                const row = breakdown.data?.find((b) => b.level === r.level);
                return row ? packagingBreakupText(row, baseUom, itemName) : "Calculating…";
              })()}
            </div>
          </div>
        )} />
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

/** No shelf life: expiry is a property of a batch, so one number on the item only
 *  ever disagreed with the stock actually held. */
function ToggleGrid({ form, set }: { form: Form; set: (k:keyof Form,v:Form[keyof Form])=>void }) {
  return <div className="grid gap-4 md:grid-cols-3">
    <Toggle label="Has Batch" value={form.is_batch_tracked} onChange={(v)=>set("is_batch_tracked",v)} />
    <Toggle label="Has Serial" value={form.is_serial_tracked} onChange={(v)=>set("is_serial_tracked",v)} />
    <Toggle label="Has IMEI" value={form.is_imei_tracked} onChange={(v)=>set("is_imei_tracked",v)} />
    {/* One flag, two words for it: a consumable expires, an asset's warranty ends.
        The warehouse already labels the same date "Expiry / Warranty" on the GRN
        line, so the master says it the same way. */}
    <Toggle label="Has Expiry / Warranty" value={form.has_expiry} onChange={(v)=>set("has_expiry",v)} />
    <Toggle label="Requires QI" value={form.requires_qi} onChange={(v)=>set("requires_qi",v)} />
  </div>;
}
