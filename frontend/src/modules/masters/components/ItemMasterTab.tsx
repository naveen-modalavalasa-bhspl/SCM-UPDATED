import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Switch,
} from "@heroui/react";
import { Image as ImageIcon, Plus, Search } from "lucide-react";

import {
  Button, Can, Field, Input, ResponsiveList, Select, type Column,
} from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { ladderCaption, usePackOptions } from "@/shared/packing";
import { mastersApi } from "../api";
import { BulkBar } from "./BulkBar";
import { MASTER_PAGE_SIZE } from "./MasterCrud";
import type {
  MasterBrand, MasterBrandItemMapping, MasterBrandManufacturer, MasterCategoryTag,
  MasterGeneralName, MasterItem, MasterItemComponent,
  MasterItemPackaging, MasterPackHierarchy, NamedMaster, PackagingBreakdown, UomClass,
} from "../types";

export const ITEM_SECTIONS = [
  "Basic", "Brands", "Kit Components", "Attributes", "Specifications", "Features",
  "Units", "Identification", "Tracking", "Packaging", "Additional", "Photos",
] as const;
type ItemSection = (typeof ITEM_SECTIONS)[number];

/** One row per product. Brand left the item for the Brand Item Mapping screen,
 *  so rows that differ only by brand are one product: they group under their
 *  general name, and the representative (an active row when there is one, else
 *  the oldest) stands in for the group's shared fields. Display-only — every
 *  variant keeps its own id, code, stock and documents. */
export interface ItemProductGroup {
  key: string;
  generalName: string | null;
  representative: MasterItem;
  variants: MasterItem[];
}

export function groupItemsByProduct(rows: MasterItem[]): ItemProductGroup[] {
  const byProduct = new Map<string, MasterItem[]>();
  for (const row of rows) {
    const key = row.general_name_id != null ? `g-${row.general_name_id}` : `i-${row.id}`;
    const list = byProduct.get(key) ?? [];
    list.push(row);
    byProduct.set(key, list);
  }
  return Array.from(byProduct.entries()).map(([key, variants]) => {
    const ordered = [...variants].sort((a, b) =>
      Number(b.is_active) - Number(a.is_active) || a.id - b.id);
    return {
      key,
      generalName: ordered[0].general_name ?? null,
      representative: ordered[0],
      variants,
    };
  });
}

/** Every brand the group's variants carry, deduplicated, in first-seen order. */
export function groupBrandNames(group: ItemProductGroup): string[] {
  const seen = new Set<string>();
  for (const variant of group.variants) {
    const name = (variant.brand_name ?? "").trim();
    if (name && !seen.has(name)) seen.add(name);
  }
  return Array.from(seen);
}

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
  owner_department_id: "", hsn_id: "", is_asset: false,
  description: "", has_components: false, barcode_type: "AUTO",
  barcode_value: "", is_batch_tracked: false, is_serial_tracked: false,
  is_imei_tracked: false, generate_unit_code: true, has_expiry: false,
  requires_qi: false,
  dosage_form_id: "", valuation_method: "FIFO", requires_special_storage: false,
  storage_conditions: "", requires_special_transport: false,
  transport_conditions: "",
  is_active: true,
};

type Form = typeof empty;
const opt = (rows: { id: number; code?: string | null; name: string }[]) =>
  rows.map((row) => ({
    value: row.id, label: `${row.code ? `${row.code} — ` : ""}${row.name}`,
  }));

/** Asset-ness is stored per item (`mst_items.is_asset`) but nobody types it: the
 *  item class the user picks already says it. Codes are master data, so match the
 *  asset-ish ones by code or name rather than hardcoding one id. */
export function isAssetClass(
  row?: { code?: string | null; name?: string | null },
): boolean {
  const text = `${row?.code ?? ""} ${row?.name ?? ""}`.toUpperCase();
  return /ASSET|CAPITAL/.test(text);
}

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

/** What the code will look like. Brand and manufacturer stay off it: one general
 *  name is sold by several brands, each a separate item row sharing this prefix
 *  and differing only in the serial. The serial is allocated by the server
 *  at save, so a new item shows #### rather than a number that might be taken. */
/** L1L2L3, a hyphen, a three-digit series: 101010-001. No generic name in it. */
export function itemCodePreview(categoryPath?: string | null, serial?: number | null) {
  if (!categoryPath) return "";
  return `${categoryPath}-${serial ? String(serial).padStart(3, "0") : "###"}`;
}

/** A 40px picture of the item at the start of its row. Fetched once per photo
 *  and kept for the session; an item with none shows a quiet placeholder. */
function ItemThumb({ item }: { item: MasterItem }) {
  const photo = useQuery({
    queryKey: ["masters", "item-photo-blob", item.photo_id],
    queryFn: () => mastersApi.itemPhotos.blobUrl(item.id, item.photo_id!),
    enabled: Boolean(item.photo_id),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
  });
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-content2">
      {photo.data
        ? <img src={photo.data} alt="" loading="lazy" className="h-full w-full object-cover" />
        : <ImageIcon className="h-4 w-4 text-muted" aria-hidden />}
    </div>
  );
}

/** The item's pictures. Fetched as blobs, because an <img src> cannot carry the
 *  sign-in token; added and removed only with master.item.manage. */
function ItemPhotos({ itemId }: { itemId: number }) {
  const qc = useQueryClient();
  const photos = useQuery({
    queryKey: ["masters", "item-photos", itemId],
    queryFn: () => mastersApi.itemPhotos.list(itemId),
  });
  const [urls, setUrls] = useState<Record<number, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const made: string[] = [];
    for (const p of photos.data ?? []) {
      if (urls[p.id]) continue;
      void mastersApi.itemPhotos.blobUrl(itemId, p.id).then((url) => {
        made.push(url);
        if (live) setUrls((u) => ({ ...u, [p.id]: url }));
      }).catch(() => undefined);
    }
    return () => { live = false; };
  }, [photos.data, itemId]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ["masters", "item-photos", itemId] }),
    qc.invalidateQueries({ queryKey: ["masters", "items"] }),
  ]);
  const add = useMutation({
    mutationFn: (file: File) => mastersApi.itemPhotos.add(itemId, file),
    onSuccess: () => { setProblem(null); void refresh(); },
    onError: (e: Error) => setProblem(e.message),
  });
  const remove = useMutation({
    mutationFn: (photoId: number) => mastersApi.itemPhotos.remove(itemId, photoId),
    onSuccess: () => void refresh(),
    onError: (e: Error) => setProblem(e.message),
  });
  return (
    <div className="space-y-3">
      {problem && <div className="rounded-lg bg-bad-bg p-3 text-sm text-bad">{problem}</div>}
      <div className="flex flex-wrap gap-3">
        {(photos.data ?? []).map((p) => (
          <figure key={p.id} className="w-36">
            <div className="flex h-36 w-36 items-center justify-center overflow-hidden rounded-xl border border-line bg-content2">
              {urls[p.id]
                ? <img src={urls[p.id]} alt={p.file_name} className="h-full w-full object-cover" />
                : <span className="text-xs text-muted">Loading…</span>}
            </div>
            <figcaption className="mt-1 flex items-center justify-between gap-1 text-xs text-muted">
              <span className="truncate" title={p.file_name}>{p.file_name}</span>
              <Can do="master.item.manage">
                <button type="button" className="min-h-11 px-2 text-bad"
                        onClick={() => remove.mutate(p.id)} disabled={remove.isPending}>
                  Remove
                </button>
              </Can>
            </figcaption>
          </figure>
        ))}
        {photos.data?.length === 0 && (
          <p className="text-sm text-muted">No photos yet.</p>
        )}
      </div>
      <Can do="master.item.manage">
        <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-line px-4 text-sm font-medium">
          {add.isPending ? "Uploading…" : "Add photo"}
          <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment"
                 className="hidden" disabled={add.isPending}
                 onChange={(e) => {
                   const file = e.target.files?.[0];
                   if (file) add.mutate(file);
                   e.target.value = "";
                 }} />
        </label>
        <p className="mt-1 text-xs text-muted">JPG, PNG or WEBP, up to 20 MB.</p>
      </Can>
    </div>
  );
}

/** Where one tag's answer is stored in `mst_item_specs.specifications`.
 *  Attributes, specs and features are three separate tables whose codes and ids are
 *  only unique within themselves — "LENGTH" is both an attribute and a spec — so the
 *  type has to be part of the key or the two share one value. */
export function tagKey(tag: MasterCategoryTag) {
  return `${tag.tag_type}:${tag.tag_code ?? tag.tag_id}`;
}

/** Fields required by the category, with nothing filled in yet. */
export function missingRequiredTags(
  tags: MasterCategoryTag[],
  values: Record<string, string>,
) {
  return tags
    .filter((tag) => tag.is_required && tag.is_active)
    .filter((tag) => {
      const value = values[tagKey(tag)] ?? "";
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
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [search]);
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
    queryKey: ["masters", "items", search, page],
    queryFn: () => mastersApi.items.list({ search, page, size: MASTER_PAGE_SIZE }),
  });
  const categories = useQuery({
    queryKey: ["masters", "categories", "all"],
    queryFn: () => mastersApi.categories.list({ size: 300 }).then((r) => r.items),
  });
  const uoms = useQuery({ queryKey: ["masters", "uom"], queryFn: mastersApi.uom.listAll });
  const general = useQuery({
    queryKey: ["masters", "general-names"],
    queryFn: () => mastersApi.generalNames.list({ size: 300 }).then((r) => r.items),
  });
  // Brands and manufacturers left the item form — they are mapped centrally
  // on the Brand Item Mapping screen. The form keeps their ids in state only
  // so an edit of an older branded item still saves what it was created with.
  const classes = useQuery({
    queryKey: ["masters", "item-classes", "all"],
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
    queryKey: ["masters", "hsn-codes", "all"],
    queryFn: () => mastersApi.hsnCodes.list({ size: 500 }).then((r) => r.items),
  });
  const dosage = useQuery({
    queryKey: ["masters", "dosage-forms"],
    queryFn: () => mastersApi.dosageForms.list({ size: 300 }).then((r) => r.items),
  });
  const departments = useQuery({
    queryKey: ["masters", "departments", "ownership-options"],
    queryFn: mastersApi.ownershipDepartments,
  });
  // Tags on a parent category apply to every child. The Level 3 category may
  // override a repeated tag by defining it closer to the item.
  const categoryTags = useQuery({
    // Keyed under "category-tags" so saving a tag on the Category Tagging tab
    // invalidates this too — the CRUD there invalidates ["masters", "category-tags"].
    queryKey: [
      "masters", "category-tags", "for-item", level1, level2, form.category_id,
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
  const chosenCategory = cats.find((row) => row.id === Number(form.category_id));
  // The serial a new item is about to get, read live: the save mints it under
  // lock, so the form asks what it would be rather than guessing. `####` only
  // shows while that answer is in flight or when the pair is not picked yet.
  const nextCode = useQuery({
    queryKey: ["masters", "items", "next-code", form.category_id, form.general_name_id],
    queryFn: () => mastersApi.nextItemCode(
      Number(form.category_id), Number(form.general_name_id) || 0),
    enabled: editing === null && Boolean(form.category_id),
    staleTime: 10_000,
  });
  // An existing item shows the code it was created with — never re-derived.
  const preview = editing
    ? editing.code
    : (nextCode.data?.preview ?? itemCodePreview(chosenCategory?.path));

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
      "owner_department_id", "hsn_id"] as const;
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
      qc.invalidateQueries({ queryKey: ["masters", "items", "next-code"] });
      qc.invalidateQueries({ queryKey: ["masters", "hsn-codes", "all"] });
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
      owner_department_id: row.owner_department_id ?? "",
      hsn_id: row.hsn_id ?? "",
      dosage_form_id: row.dosage_form_id ?? "" } as Form);
    setHsnCode(row.hsn_code ?? "");
    setTagValues({}); setDraftComponents([]); setEditing(row); setTab("Basic");
    setError(null);
    // Not a column on the item, so it does not ride along on `row`: the flag lives in
    // settings, keyed by item code, and is asked for when the form opens. Failing to
    // read it leaves the toggle at its default rather than blocking the edit.
    mastersApi.unitCodeTracking(row.id)
      .then((on) => setForm((current) => ({ ...current, generate_unit_code: on })))
      .catch(() => undefined);
  };

  // The Save button stays honest about why it is disabled rather than silently
  // refusing: identity, a unit, an HSN, and every field the category insists on.
  const blocker = !form.category_id ? "Category is required"
    : !form.general_name_id ? "Generic name is required"
    : !preview ? "Pick the Level 3 category"
    : !form.name.trim() ? "Give the item a name"
    : !form.uom_id ? "Pick a primary unit on the Units tab"
    : !form.owner_department_id ? "Pick an ownership department"
    : !hsnCode ? "Enter an HSN code on the Identification tab"
    : hsnFormatError ? hsnFormatError
    : unanswered.length ? `Answer ${unanswered.map((t) => t.tag_name).join(", ")}`
    : null;

  // One row per product: variants that differ only by brand collapse under
  // their general name (see groupItemsByProduct). Page-local: the grouping
  // covers the rows this page fetched, and search still narrows server-side.
  const productGroups = useMemo(
    () => groupItemsByProduct(items.data?.items ?? []),
    [items.data],
  );
  const columns: Column<ItemProductGroup>[] = [
    {
      key: "sno",
      header: "S.No",
      render: (row) => {
        const idx = productGroups.indexOf(row);
        return (
          <span className="tabular-nums text-muted font-medium text-xs">
            {(page - 1) * MASTER_PAGE_SIZE + (idx >= 0 ? idx : 0) + 1}
          </span>
        );
      },
      className: "w-12 text-center",
    },
    { key: "photo", header: "", render: (row) => <ItemThumb item={row.representative} /> },
    { key: "code", header: "Item Code", render: (row) => (
      <span>
        <span className="mono font-semibold">{row.representative.code}</span>
        {row.variants.length > 1 && (
          <span className="ml-2 rounded-full bg-content2 px-2 py-0.5 text-xs text-muted">
            {row.variants.length} variants
          </span>
        )}
      </span>
    ) },
    { key: "name", header: "Name",
      render: (row) => row.generalName ?? row.representative.name },
    { key: "brand", header: "Brands", render: (row) => {
      const names = groupBrandNames(row);
      return names.length > 0 ? names.join(", ") : "—";
    } },
    { key: "hsn", header: "HSN", render: (row) => row.representative.hsn_code ?? "—" },
    { key: "kind", header: "Kind",
      render: (row) => (row.representative.is_asset ? "Asset" : "Consumable") },
    { key: "uom", header: "Primary UOM", render: (row) => row.representative.uom_code ?? "—" },
    { key: "owner", header: "Ownership",
      render: (row) => row.representative.owner_department_name ?? "—" },
    { key: "status", header: "Status",
      render: (row) => row.representative.is_active ? "Active" : "Inactive" },
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
      <ResponsiveList data={productGroups} loading={items.isLoading}
        page={page} onPageChange={setPage}
        totalPages={Math.ceil((items.data?.total ?? 0) / MASTER_PAGE_SIZE)}
        keyOf={(row) => row.key} columns={columns}
        onRowClick={canManage ? (group) => openEdit(group.representative) : undefined}
        empty="No items found." renderCard={(group) => (
          <div>
            <b>{group.representative.code}</b>
            <div>{group.generalName ?? group.representative.name}</div>
            {group.variants.length > 1 && (
              <div className="text-xs text-muted">
                {group.variants.length} variants · {groupBrandNames(group).join(", ") || "no brands"}
              </div>
            )}
          </div>
        )} />

      {/* The dialog keeps ONE height across all ten tabs. Sized to its content it
          collapsed to a two-line box on Kit Components and jumped back to full height
          on Basic, so the tab strip, the Save button and the validation message all
          moved under the cursor between one tab and the next. `scrollBehavior="inside"`
          already scrolls the body; the fixed base is what stops the frame moving. */}
      <Modal isOpen={editing !== undefined} onOpenChange={() => setEditing(undefined)}
             size="5xl" scrollBehavior="inside"
             classNames={{ base: "h-[85vh] max-h-[85vh]" }}>
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
              <Field label="Generic Name *"><Select value={form.general_name_id}
                options={opt(general.data ?? [])} onChange={(v) => {
                  // Clearing brand/manufacturer when general name changes keeps stale
                  // picks from riding along on save. Both fields are now managed via
                  // Brand Item Mapping, but the form still accepts them if pre-filled.
                  set("general_name_id", v); set("brand_id", ""); set("manufacturer_id", "");
                }} /></Field>
              <Field label="Item Class"><Select value={form.item_class_id}
                options={opt(classes.data ?? [])} onChange={(v) => {
                  set("item_class_id", v); set("item_sub_class_id", "");
                  // Tracking's unit-code label names asset or consumable; the class
                  // just picked is what decides it, so carry it over now instead of
                  // waiting for a save-and-reopen to reveal the wrong word.
                  set("is_asset", isAssetClass(
                    (classes.data ?? []).find((row) => String(row.id) === String(v))));
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
                     hint={editing ? "Fixed at creation — never renumbered"
                       : nextCode.isPending ? "Fetching the next serial…"
                       : "Live next serial — confirmed on save"}>
                <Input value={preview} disabled /></Field>
              <Field label="Item Name"><Input value={form.name}
                onChange={(e) => set("name", e.target.value)} /></Field>
              <Field label="Short Name"><Input value={form.short_name}
                onChange={(e) => set("short_name", e.target.value)} /></Field>
              <Field label="Ownership Department *"
                     hint="HCM department responsible for tickets and other item-related work">
                <Select value={form.owner_department_id}
                  options={opt(departments.data ?? [])}
                  onChange={(v) => set("owner_department_id", v)}
                  placeholder="Select responsible department" />
              </Field>
              <div className="md:col-span-3"><Field label="Description"><Input value={form.description}
                onChange={(e) => set("description", e.target.value)} /></Field></div>
            </div>}

            {tab === "Brands" && (!editing
              ? <Empty>Save the item first — brands are mapped to it afterwards.</Empty>
              : <ItemBrands itemId={editing.id} />)}

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

            {tab === "Specifications" && (
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
                : <ItemPackHierarchies itemId={editing.id}
                    itemName={editing.name} baseUom={editing.uom_code} />
            )}

            {tab === "Photos" && (editing
              ? <ItemPhotos itemId={editing.id} />
              : <p className="text-sm text-muted">Save the item first, then add its photos here.</p>)}

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

/** The brands mapped to one item, read-only. Mapping itself happens on
 *  Masters › Classification › Brand Item Mapping — this tab only shows what
 *  that screen recorded, with each brand's manufacturers beside it. */
function ItemBrands({ itemId }: { itemId: number }) {
  const mapped = useQuery({
    queryKey: ["masters", "brand-item-mapping", "for-item", itemId],
    queryFn: () => mastersApi.brandItemMapping.listForItem(itemId),
  });
  if (mapped.isLoading) return <Empty>Loading mapped brands…</Empty>;
  if (mapped.error) return <Empty>Brands could not be loaded.</Empty>;
  const rows: MasterBrandItemMapping[] = mapped.data ?? [];
  if (rows.length === 0) {
    return <Empty>No brands mapped yet — map them on Masters › Classification › Brand Item Mapping.</Empty>;
  }
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {rows.map((row) => (
        <li key={row.id} className="rounded-xl border border-line p-4">
          <div className="text-sm font-semibold">
            {row.brand_code ? <span className="mono mr-2">{row.brand_code}</span> : null}
            {row.brand_name ?? "—"}
          </div>
          <div className="mt-1 text-xs text-muted">
            {(row.manufacturer_names ?? []).length > 0
              ? `Manufacturers: ${(row.manufacturer_names ?? []).join(", ")}`
              : "No manufacturers linked"}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Renders whatever the category asked for. A LIST attribute becomes a dropdown of
 *  its own options; a spec shows the unit it is measured in. */
export function TagFields({ tags, values, onChange }: {
  tags: MasterCategoryTag[];
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const attributes = useQuery({
    queryKey: ["masters", "attributes", "all"],
    queryFn: () => mastersApi.attributes.list({ size: 300 }).then((r) => r.items),
  });
  const set = (code: string, value: string) =>
    onChange({ ...values, [code]: value });

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {tags.map((tag) => {
        const code = tagKey(tag);
        // Only an ATTRIBUTE's id points into mst_attributes; a spec id would match
        // an unrelated attribute row.
        const definition = tag.tag_type === "ATTRIBUTE"
          ? attributes.data?.find((a) => a.id === tag.tag_id)
          : undefined;
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
        const code = tagKey(tag);
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
    queryKey: ["masters", "items", "all"],
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
    queryKey: ["masters", "items", "all"],
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

/** An item's pack hierarchies (2026-10-08): the named families it is packed in —
 *  "Strip of 10" and "Strip of 15" at the same time — each with its own ladder of
 *  levels. A container type is used at most once per hierarchy; across hierarchies it
 *  is fine (both families go into a Box). The default hierarchy is the one a new PO
 *  offers first. */
export function ItemPackHierarchies({ itemId, itemName, baseUom }: {
  itemId: number; itemName: string; baseUom?: string | null;
}) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const hierarchies = useQuery({
    queryKey: ["masters", "pack-hierarchies", itemId],
    queryFn: () => mastersApi.packHierarchies
      .list({ item_id: itemId, size: 50 })
      .then((r) => r.items.filter((h) => h.is_active)),
  });
  const ladders = usePackOptions([itemId]);
  const list = hierarchies.data ?? [];
  const current = list.find((h) => h.id === selected)
    ?? list.find((h) => h.is_default) ?? list[0];
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["masters", "pack-hierarchies", itemId] });
    qc.invalidateQueries({ queryKey: ["pack-options"] });
  };
  const create = useMutation({
    mutationFn: () => mastersApi.packHierarchies.create({
      item_id: itemId, name: newName.trim(), is_active: true,
      is_default: list.length === 0,
    }),
    onSuccess: (row) => { setNewName(""); setError(null); setSelected(row.id); refresh(); },
    onError: (reason: Error) => setError(reason.message),
  });
  const makeDefault = useMutation({
    mutationFn: (row: MasterPackHierarchy) => mastersApi.packHierarchies.update(row.id, {
      item_id: row.item_id, name: row.name, description: row.description ?? null,
      is_default: true, is_active: true,
    }),
    onSuccess: () => { setError(null); refresh(); },
    onError: (reason: Error) => setError(reason.message),
  });
  const retire = useMutation({
    mutationFn: (row: MasterPackHierarchy) => mastersApi.packHierarchies.deactivate(row.id),
    onSuccess: () => { setError(null); setSelected(null); refresh(); },
    onError: (reason: Error) => setError(reason.message),
  });
  const caption = (id: number) => {
    const h = (ladders.data?.[itemId] ?? []).find((row) => row.hierarchy_id === id);
    return h && h.levels.length > 1 ? ladderCaption(h, baseUom) : "No levels yet";
  };

  return (
    <div className="space-y-4">
      {error && <div className="rounded-lg bg-bad-bg p-3 text-sm text-bad">{error}</div>}
      <div className="rounded-xl border border-line bg-content2/40 p-3">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm font-semibold text-ink">Pack hierarchies</span>
          <span className="text-xs text-muted">
            One item can be packed several ways at once — each way is a hierarchy.
          </span>
        </div>
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <Field label="Pack hierarchy">
            <Select
              value={current?.id ?? ""}
              ariaLabel="Pack hierarchy"
              placeholder={list.length ? "Choose a pack hierarchy" : "No pack hierarchy yet"}
              isDisabled={!list.length}
              options={list.map((h) => ({
                value: h.id,
                label: `${h.name}${h.is_default ? " (default)" : ""} — ${caption(h.id)}`,
              }))}
              onChange={(value) => setSelected(value ? Number(value) : null)}
            />
          </Field>
          <Can do="master.packaging.manage">
            <div className="flex min-h-11 items-center gap-2 rounded-xl border border-dashed border-line bg-content1 px-2">
              <input value={newName} onChange={(e) => setNewName(e.target.value)}
                     placeholder='New, e.g. "Strip of 15"' aria-label="New pack hierarchy name"
                     maxLength={100}
                     onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) create.mutate(); }}
                     className="h-9 w-44 bg-transparent text-sm outline-none" />
              <Button variant="soft" onClick={() => create.mutate()}
                      disabled={!newName.trim() || create.isPending}>
                <Plus size={14} /> Add
              </Button>
            </div>
          </Can>
        </div>
        {current && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            {current.is_default && (
              <span className="rounded-full bg-ok-bg px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ok">
                Default
              </span>
            )}
            {!current.is_default && (
              <Can do="master.packaging.manage">
                <Button variant="ghost" className="text-xs"
                        onClick={() => makeDefault.mutate(current)}
                        disabled={makeDefault.isPending}>Make default</Button>
              </Can>
            )}
            <Can do="master.packaging.manage">
              <Button variant="ghost" className="text-xs text-bad"
                      onClick={() => retire.mutate(current)} disabled={retire.isPending}>
                Retire hierarchy
              </Button>
            </Can>
          </div>
        )}
      </div>
      {hierarchies.isLoading
        ? <p className="text-sm text-muted">Loading…</p>
        : current
          ? <ItemPackagingLadder key={current.id} itemId={itemId} hierarchyId={current.id}
              hierarchyName={current.name} itemName={itemName} baseUom={baseUom} />
          : <Empty>Add a pack hierarchy above — for a tablet, "Strip of 10" — then build its levels.</Empty>}
    </div>
  );
}

/** One hierarchy's ladder. Level 1 holds the item's UOM directly; each level above
 *  contains a whole number of the package immediately below it. */
function ItemPackagingLadder({ itemId, hierarchyId, hierarchyName, itemName, baseUom }: {
  itemId: number; hierarchyId: number; hierarchyName: string; itemName: string;
  baseUom?: string | null;
}) {
  const qc = useQueryClient();
  const [packageId, setPackageId] = useState("");
  const [quantity, setQuantity] = useState("");
  // What ONE of these weighs full, and the sides where this item packs differently
  // from the container type. Both optional: blank sides inherit the container's, which
  // is the ordinary case and keeps a ladder cheap to configure.
  const [grossWeight, setGrossWeight] = useState("");
  const [override, setOverride] = useState({ length_cm: "", width_cm: "", height_cm: "" });
  // The least one pack of the new level may be made with (2026-10-11). Blank: none.
  const [minFill, setMinFill] = useState("");
  const [error, setError] = useState<string | null>(null);

  const rungs = useQuery({
    queryKey: ["masters", "item-packaging", itemId, hierarchyId],
    queryFn: () => mastersApi.itemPackaging
      .list({ item_id: itemId, hierarchy_id: hierarchyId, size: 50, include_inactive: true })
      .then((r) => r.items),
  });
  const breakdown = useQuery({
    queryKey: ["masters", "packaging-breakdown", itemId, hierarchyId],
    queryFn: () => mastersApi.itemPackaging.breakdown(itemId, hierarchyId),
  });
  const packages = useQuery({
    queryKey: ["masters", "packaging", "all"],
    queryFn: () => mastersApi.packaging.list({ size: 200 }).then((r) => r.items),
  });

  const activeRungs = (rungs.data ?? []).filter((rung) => rung.is_active);
  // A container is used at most once per hierarchy — the server refuses it too.
  const usedPackages = new Set(activeRungs.map((rung) => rung.package_id));
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
      const sides = ["length_cm", "width_cm", "height_cm"] as const;
      const measured = sides.every((key) => Number(override[key]) > 0);
      const payload = {
        item_id: itemId, hierarchy_id: hierarchyId, level: nextLevel,
        package_id: Number(packageId),
        quantity: enteredQuantity,
        gross_weight_kg: grossWeight === "" ? null : Number(grossWeight),
        min_fill_qty: minFill === "" ? null : Number(minFill),
        // All three or none — the server refuses a half-measured box, because two
        // sides describe nothing a slotting check can use.
        ...(measured
          ? Object.fromEntries(sides.map((key) => [key, Number(override[key])]))
          : { length_cm: null, width_cm: null, height_cm: null }),
        is_active: true,
      };
      return inactiveAtNextLevel
        ? mastersApi.itemPackaging.update(inactiveAtNextLevel.id, payload)
        : mastersApi.itemPackaging.create(payload);
    },
    onSuccess: () => {
      setPackageId(""); setQuantity(""); setGrossWeight(""); setMinFill(""); setError(null);
      setOverride({ length_cm: "", width_cm: "", height_cm: "" });
      qc.invalidateQueries({ queryKey: ["masters", "item-packaging", itemId] });
      qc.invalidateQueries({ queryKey: ["masters", "packaging-breakdown", itemId] });
      qc.invalidateQueries({ queryKey: ["pack-options"] });
    },
    onError: (reason: Error) => setError(reason.message),
  });
  // Which rung putaway and bin occupancy work in. Sent as a plain update of the rung;
  // the server clears the flag on every other rung of the same item, because "at most
  // one TRUE per item" is not something a unique index can express.
  const setDefault = useMutation({
    mutationFn: (rung: MasterItemPackaging) =>
      mastersApi.itemPackaging.update(rung.id, {
        item_id: rung.item_id, hierarchy_id: hierarchyId, level: rung.level,
        package_id: rung.package_id,
        quantity: rung.quantity, length_cm: rung.length_cm ?? null,
        width_cm: rung.width_cm ?? null, height_cm: rung.height_cm ?? null,
        gross_weight_kg: rung.gross_weight_kg ?? null,
        max_stack_tiers: rung.max_stack_tiers ?? null,
        // Carried through: the update replaces the whole rung, and leaving it out
        // would quietly clear the floor.
        min_fill_qty: rung.min_fill_qty ?? null,
        is_default_putaway_unit: true, is_active: true,
      }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ["masters", "item-packaging", itemId] });
      qc.invalidateQueries({ queryKey: ["masters", "packaging-breakdown", itemId] });
      qc.invalidateQueries({ queryKey: ["pack-options"] });
    },
    onError: (reason: Error) => setError(reason.message),
  });
  // The floor of one level, edited in place (2026-10-11).
  const setFloor = useMutation({
    mutationFn: ({ rung, value }: { rung: MasterItemPackaging; value: number | null }) =>
      mastersApi.itemPackaging.update(rung.id, {
        item_id: rung.item_id, hierarchy_id: hierarchyId, level: rung.level,
        package_id: rung.package_id,
        quantity: rung.quantity, length_cm: rung.length_cm ?? null,
        width_cm: rung.width_cm ?? null, height_cm: rung.height_cm ?? null,
        gross_weight_kg: rung.gross_weight_kg ?? null,
        max_stack_tiers: rung.max_stack_tiers ?? null,
        is_default_putaway_unit: !!rung.is_default_putaway_unit,
        min_fill_qty: value, is_active: true,
      }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ["masters", "item-packaging", itemId] });
      qc.invalidateQueries({ queryKey: ["masters", "packaging-breakdown", itemId] });
      qc.invalidateQueries({ queryKey: ["pack-options"] });
    },
    onError: (reason: Error) => setError(reason.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => mastersApi.itemPackaging.deactivate(id),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ["masters", "item-packaging", itemId] });
      qc.invalidateQueries({ queryKey: ["masters", "packaging-breakdown", itemId] });
      qc.invalidateQueries({ queryKey: ["pack-options"] });
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
    // The half the warehouse reads. A rung with no box is a rung no bin can check, and
    // the ladder is the only screen where that is fixable — so it says so here rather
    // than leaving a storekeeper to discover it at the putaway.
    { key: "space", header: "Shelf space", render: (r) => {
        const row = breakdown.data?.find((b) => b.level === r.level);
        if (!row) return "—";
        if (row.volume_cbm == null) {
          return (
            <span className="text-xs text-warn">
              Not measured — no bin can check it
            </span>
          );
        }
        return (
          <span className="text-xs">
            <span className="tabular font-semibold text-ink">
              {row.volume_cbm.toPrecision(3)} m³
            </span>
            <span className="text-muted">
              {" "}· {amount(Number(row.length_cm))} × {amount(Number(row.width_cm))} ×{" "}
              {amount(Number(row.height_cm))} cm
              {row.dims_from === "PACKAGE" ? " (container type)" : ""}
              {row.gross_weight_kg != null ? ` · ${amount(row.gross_weight_kg)} kg` : ""}
            </span>
          </span>
        );
      } },
    // The size is the most one pack holds; this is the least one may be MADE with. A
    // pack that falls under it later (stock issued out of it) is flagged for a repack.
    { key: "min", header: "Minimum fill", render: (r) => {
        const row = breakdown.data?.find((b) => b.level === r.level);
        return (
          <MinFillCell value={r.min_fill_qty ?? null} max={row?.base_quantity}
                       uom={baseUom} busy={setFloor.isPending}
                       onSave={(value) => setFloor.mutate({ rung: r, value })} />
        );
      } },
    { key: "default", header: "Putaway unit", render: (r) => (
        r.is_default_putaway_unit ? (
          <span className="rounded-full bg-ok-bg px-2 py-0.5 text-[11px] font-semibold text-ok">
            Default
          </span>
        ) : (
          <Button
            variant="ghost"
            className="text-xs"
            onClick={() => setDefault.mutate(r)}
            disabled={setDefault.isPending}
          >
            Make default
          </Button>
        )
      ) },
    { key: "act", header: "", render: (r) => (
        r.level === highestLevel
          ? <Button variant="ghost" className="text-bad"
                    onClick={() => remove.mutate(r.id)}>Remove</Button>
          : null) },
  ];

  return (
    <div className="space-y-4">
      {error && <div className="rounded-lg bg-bad-bg p-3 text-sm text-bad">{error}</div>}
      <div className="grid gap-3 md:grid-cols-[2fr_1fr_auto] md:items-end">
        <Field label={`Level ${nextLevel} container type`}
               hint={usedPackages.size
                 ? `Containers already in "${hierarchyName}" are not offered again.`
                 : undefined}>
          <Select value={packageId}
                  options={(packages.data ?? [])
                    .filter((p) => p.is_active && !usedPackages.has(p.id))
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

      <div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr] md:items-start mt-2">
        <Field
          label="Gross weight of one, loaded (kg)"
          hint="Container plus contents. Optional — without it a rack's weight limit cannot be checked against this pack."
        >
          <Input type="number" min={0} step="0.001" value={grossWeight}
                 onChange={(e) => setGrossWeight(e.target.value)} />
        </Field>
        <Field
          label={`Minimum fill (${baseUom ?? "item UOM"})`}
          hint={projectedBaseQuantity > 0 && quantityValid
            ? `One holds ${amount(projectedBaseQuantity)}. The least one may be made with — blank for no minimum.`
            : "The least one pack of this level may be made with. Blank for no minimum."}
        >
          <Input type="number" min={0} step="0.001" value={minFill}
                 onChange={(e) => setMinFill(e.target.value)} />
        </Field>
        <div>
          <span className="mb-1.5 block text-sm font-medium text-body">
            Dimensions (cm)
          </span>
          <div className="grid gap-3 sm:grid-cols-3">
            {([
              ["length_cm", "Length"],
              ["width_cm", "Width"],
              ["height_cm", "Height"],
            ] as const).map(([key, label]) => (
              <Input key={key} type="number" min={0} step="0.1" value={override[key]}
                     placeholder={label}
                     aria-label={label}
                     onChange={(e) => setOverride({ ...override, [key]: e.target.value })} />
            ))}
          </div>
          <span className="mt-1 block text-xs text-muted">
            Only where this item genuinely packs differently from the container type.
          </span>
        </div>
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

/** One level's minimum fill, read and edited in place. The server refuses a floor
 *  above what one pack holds; this only says so before the press. */
function MinFillCell({ value, max, uom, busy, onSave }: {
  value: number | null; max?: number; uom?: string | null; busy: boolean;
  onSave: (value: number | null) => void;
}) {
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (!editing) {
    if (!can("master.packaging.manage")) {
      return <span className="text-xs text-muted">{value != null ? `${amount(value)} ${uom ?? ""}` : "None"}</span>;
    }
    return (
      <button type="button" onClick={() => { setDraft(value != null ? String(value) : ""); setEditing(true); }}
              className="min-h-9 rounded-md px-2 text-xs font-semibold text-brand hover:bg-brand-050">
        {value != null ? `${amount(value)} ${uom ?? ""}` : "Set minimum"}
      </button>
    );
  }
  const n = Number(draft);
  const invalid = draft !== "" && (!(n > 0) || (max != null && n > max));
  return (
    <div className="flex items-center gap-1">
      <Input type="number" min={0} step="0.001" value={draft} aria-label="Minimum fill"
             onChange={(e) => setDraft(e.target.value)} className="w-24" />
      <Button variant="ghost" className="text-xs" disabled={busy || invalid}
              title={invalid && max != null ? `At most ${amount(max)} — what one pack holds` : undefined}
              onClick={() => { onSave(draft === "" ? null : n); setEditing(false); }}>Save</Button>
      <Button variant="ghost" className="text-xs" onClick={() => setEditing(false)}>Cancel</Button>
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
      /* Sticky, because the strip lives inside the body that scrolls: on a long tab
         it slid out of view and the only way back to another section was scrolling
         up. The opaque background is what keeps the fields from showing through. */
      className="sticky top-0 z-10 -mt-1 flex flex-wrap gap-2 border-b border-line bg-content1 pb-3 pt-1"
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
    {/* The fifth tracking flag. WHICH code is minted is not a choice — an asset gets
        an asset code, anything else a consumable code — so the toggle only says
        whether the dock codes this item's units at all. Its label names the one that
        will actually be generated, so nobody has to remember the rule. */}
    <Toggle
      label={`Generate ${form.is_asset ? "Asset" : "Consumable"} Code`}
      value={form.generate_unit_code}
      onChange={(v)=>set("generate_unit_code",v)}
    />
    {/* One flag, two words for it: a consumable expires, an asset's warranty ends.
        The warehouse already labels the same date "Expiry / Warranty" on the GRN
        line, so the master says it the same way. */}
    <Toggle label="Has Expiry / Warranty" value={form.has_expiry} onChange={(v)=>set("has_expiry",v)} />
    <Toggle label="Requires QI" value={form.requires_qi} onChange={(v)=>set("requires_qi",v)} />
  </div>;
}
