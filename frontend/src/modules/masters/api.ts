import { api } from "@/shared/api/client";
import type { Paginated } from "@/shared/types";
import type {
  MasterVendorCategory, MasterPaymentTerm,
  MasterItemEligibility,
  ItemEligibilityScopes,
  JobProfileOption,
  MasterAttribute, MasterBin, MasterBom, MasterBomGroup, MasterBomItem, MasterBrand,
  MasterCategory, MasterCategoryTag, MasterFeature, MasterItem,
  MasterHsnCode, MasterItemClass, MasterItemComponent, MasterItemGroup,
  MasterItemPackaging, MasterItemSpec, MasterPackaging, MasterSpec,
  MasterUom, MasterUomConversion, MasterVendor, MasterVendorItem, PackagingBreakdown,
  MasterWarehouse, Project, RefRow, UomClass, UomSuggestion,
  MasterBrandManufacturer, MasterGeneralName, MasterItemSubClass, MasterUomClass, NamedMaster,
  MasterBrandItemMapping, BrandItemMappingSources,
} from "./types";

type ListParams = {
  search?: string; page?: number; size?: number; include_inactive?: boolean;
  // Child masters accept a parent filter, e.g. bom-items?bom_id=1.
  [filter: string]: string | number | boolean | undefined;
};

const page = <T>(url: string, params: ListParams) =>
  api.get<Paginated<T>>(url, { params }).then((r) => r.data);
const all = <T>(url: string) => api.get<{ items: T[] }>(url).then((r) => r.data.items);

/**
 * Every mst_ master is served by the same backend factory, so the client for one is
 * the same four calls with a different path. `crud` builds them once instead of
 * repeating the block per master.
 */
/** Saves a downloaded workbook. The browser cannot be sent straight to the URL: the
 *  endpoint needs the Authorization header, so the bytes come back through axios and
 *  are handed to a throwaway object URL. */
function saveBlob(data: Blob, filename: string) {
  const url = URL.createObjectURL(data);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export interface ImportResult {
  success: boolean; created: number; updated: number; total: number;
  /** Rows identical to what /export wrote, so they asked for no change. */
  unchanged: number;
}

/** One cell the server could not turn into a row of the master it points at, and
 *  what it might have meant. `field` is null for a plain validation failure — a
 *  missing required value has no candidates to offer, only a message. */
export interface ImportProblem {
  row: number;
  field: string | null;
  label: string | null;
  raw: string | null;
  message: string;
  candidates: { id: number; label: string; code: string }[];
}

export interface ImportColumn {
  field: string;
  label: string;
  /** What the column is for and the rule it follows, in plain words. */
  hint?: string;
  required: boolean;
  lookup: boolean;
  choices: string[];
  type: "lookup" | "boolean" | "text";
}

export interface ImportRow {
  row: number;
  values: Record<string, unknown>;
  problems: ImportProblem[];
}

/** What `/import/preview` answers: the sheet as the server read it, with nothing
 *  written. The screen fixes the unmatched cells against `options` and posts the
 *  rows back to `/import/commit`. */
export interface ImportPreview {
  success: boolean;
  columns: ImportColumn[];
  rows: ImportRow[];
  options: Record<string, { id: number; label: string; code: string }[]>;
  file_errors: string[];
  summary: { total: number; ready: number; blocked: number };
}

export interface VendorMappingSources {
  vendor_categories: { id: number; code: string; name: string; vendor_ids: number[] }[];
  vendors: { id: number; code: string; name: string;
             status: "APPROVED" | "PENDING" | "BLOCKED" }[];
  categories: { id: number; code: string; name: string; level: number | null;
                parent_id: number | null; path: string | null }[];
  items: { id: number; code: string; name: string; category_id: number }[];
  mapped: [number, number][];
}

export interface VendorMappingSave {
  vendor_ids: number[]; item_ids: number[]; category_ids: number[];
  lead_time_days: number | null; min_order_qty: number | null;
  last_rate: number | null; is_preferred: boolean;
}

export type { BrandItemMappingSources };

export interface BrandItemMappingSave {
  brand_ids: number[];
  item_ids: number[];
  category_ids: number[];
}

export interface ItemPhoto {
  id: number; file_name: string; uploaded_at: string | null; uploaded_by: string | null;
}

export interface MasterUsage {
  id: number; total: number; used_by: { label: string; count: number }[];
}

/** The three bulk calls, as `BulkBar` consumes them. Named here rather than
 *  re-described at each use so the two sides cannot drift. */
export interface BulkApi {
  template: () => Promise<void>;
  export: (p?: ListParams) => Promise<void>;
  import: (file: File) => Promise<ImportResult>;
  preview: (file: File) => Promise<ImportPreview>;
  commit: (rows: ImportRow[]) => Promise<ImportResult>;
  /** The review in progress, kept server-side per person per master. */
  draft: {
    get: () => Promise<{ draft: ImportDraft | null; saved_at?: string }>;
    put: (draft: ImportDraft) => Promise<{ saved_at: string }>;
    clear: () => Promise<unknown>;
  };
}

/** Everything the review screen needs to resume exactly where it stopped. */
export interface ImportDraft {
  preview: ImportPreview;
  picked: Record<string, number>;
  edits: Record<string, unknown>;
  savedAt: string;
}

function crud<T>(path: string) {
  const slug = path.replace("/api/", "");
  return {
    list: (p: ListParams = {}) => page<T>(path, p),
    create: (body: Partial<T>) => api.post<T>(path, body).then((r) => r.data),
    update: (id: number, body: Partial<T>) =>
      api.put<T>(`${path}/${id}`, body).then((r) => r.data),
    deactivate: (id: number) => api.delete(`${path}/${id}`).then((r) => r.data),
    /** Who points at this row, read before offering to deactivate it. */
    usage: (id: number) =>
      api.get<MasterUsage>(`${path}/${id}/usage`).then((r) => r.data),
    template: () => api.get(`${path}/template`, { responseType: "blob" })
      .then((r) => saveBlob(r.data as Blob, `${slug}-template.xlsx`)),
    export: (p: ListParams = {}) =>
      api.get(`${path}/export`, { params: p, responseType: "blob" })
        .then((r) => saveBlob(r.data as Blob, `${slug}-export.xlsx`)),
    import: (file: File) => {
      const body = new FormData();
      body.append("file", file);
      return api.post<ImportResult>(`${path}/import`, body).then((r) => r.data);
    },
    /** Parse and resolve without writing, so the unmatched cells can be fixed on
     *  screen instead of back in Excel. */
    preview: (file: File) => {
      const body = new FormData();
      body.append("file", file);
      return api.post<ImportPreview>(`${path}/import/preview`, body)
        .then((r) => r.data);
    },
    /** The reviewed rows. Validated again server-side — the screen is a convenience,
     *  never the check. */
    commit: (rows: ImportRow[]) =>
      api.post<ImportResult>(`${path}/import/commit`, { rows: rows.map((r) => ({
        ...r.values, __row__: r.row,
      })) }).then((r) => r.data),
    draft: {
      get: () => api.get<{ draft: ImportDraft | null; saved_at?: string }>(
        `${path}/import/draft`).then((r) => r.data),
      put: (draft: ImportDraft) =>
        api.put<{ saved_at: string }>(`${path}/import/draft`, draft).then((r) => r.data),
      clear: () => api.delete(`${path}/import/draft`).then((r) => r.data),
    },
  };
}

/** Roles and regions for the item-eligibility form. One call, because the two live in
 *  unrelated tables (`rbac_roles` and `hcm_offices`) and neither has a masters CRUD of
 *  its own. Gated on `master.item.manage`, the same permission as the tagging. */
export const itemEligibilityScopes = () =>
  api.get<ItemEligibilityScopes>("/api/item-eligibility-scopes").then((r) => r.data);

/** What one role or region may currently request. */
export const itemEligibilityAssignments = (scopeType: string, scopeId: number) =>
  api.get<{ scope_type: string; scope_id: number; item_ids: number[] }>(
    "/api/item-eligibility-assignments",
    { params: { scope_type: scopeType, scope_id: scopeId } },
  ).then((r) => r.data);

/** Replace the WHOLE set for one scope in one call — a replace, not a merge, so
 *  unticking a box means something. A role serves hundreds of items; saving them one
 *  pair at a time is not a screen anybody would use twice. */
export const setItemEligibilityAssignments = (body: {
  scope_type: string; scope_id: number; item_ids: number[];
}) =>
  api.put<{ scope_type: string; scope_id: number; scope_name: string; total: number;
            added: number; restored: number; removed: number }>(
    "/api/item-eligibility-assignments", body,
  ).then((r) => r.data);

export const mastersApi = {
  items: crud<MasterItem>("/api/items"),
  categories: crud<MasterCategory>("/api/item-categories"),
  vendors: crud<MasterVendor>("/api/vendors"),
  vendorItems: crud<MasterVendorItem>("/api/vendor-items"),
  /** Which items a role or a region may raise an indent for. Empty by default: an
   *  untagged item stays requestable by everyone, so this screen only ever narrows. */
  itemEligibility: crud<MasterItemEligibility>("/api/item-eligibility"),
  warehouses: crud<MasterWarehouse>("/api/warehouses"),
  bins: crud<MasterBin>("/api/bins"),
  // HCM owns projects, so the backend registers only the list route (see
  // shared/masters/defs.py). There is nothing here to create or edit.
  projects: { list: (p: ListParams = {}) => page<Project>("/api/projects", p) },
  brands: crud<MasterBrand>("/api/brands"),
  manufacturers: crud<NamedMaster>("/api/manufacturers"),
  generalNames: crud<MasterGeneralName>("/api/general-names"),
  dosageForms: crud<NamedMaster>("/api/dosage-forms"),
  /** What a unit measures (Count, Weight ...). A master since 2026-10-01. */
  uomClasses: crud<MasterUomClass>("/api/uom-classes"),
  /** How suppliers are grouped (Glassware, Reagents ...). */
  vendorCategories: crud<MasterVendorCategory>("/api/vendor-categories"),
  paymentTerms: crud<MasterPaymentTerm>("/api/payment-terms"),
  vendorMapping: {
    sources: () => api.get<VendorMappingSources>("/api/vendor-items/mapping-sources")
      .then((r) => r.data),
    save: (body: VendorMappingSave) => api.post<{
      created: number; updated: number; suppliers: number; items: number;
    }>("/api/vendor-items/mapping", body).then((r) => r.data),
  },
  brandItemMapping: {
    /** All brands, categories and items needed to drive the mapping panel. */
    sources: () => api.get<BrandItemMappingSources>("/api/brand-item-mapping/sources")
      .then((r) => r.data),
    /** Bulk-create/restore brand ↔ item pairings. */
    save: (body: { brand_ids: number[]; item_ids: number[]; category_ids: number[] }) =>
      api.post<{ created: number; updated: number; brands: number; items: number }>(
        "/api/brand-item-mapping", body,
      ).then((r) => r.data),
    /** All mappings for a single item, for the detail view row. */
    listForItem: (itemId: number) =>
      api.get<MasterBrandItemMapping[]>(`/api/brand-item-mapping?item_id=${itemId}`)
        .then((r) => r.data),
    deactivate: (id: number) =>
      api.delete(`/api/brand-item-mapping/${id}`).then((r) => r.data),
  },
  itemPhotos: {
    list: (itemId: number) =>
      api.get<ItemPhoto[]>(`/api/items/${itemId}/photos`).then((r) => r.data),
    add: (itemId: number, file: File) => {
      const body = new FormData();
      body.append("file", file);
      return api.post<ItemPhoto>(`/api/items/${itemId}/photos`, body).then((r) => r.data);
    },
    /** Fetched as a blob: an <img src> cannot carry the sign-in token. */
    blobUrl: (itemId: number, photoId: number) =>
      api.get(`/api/items/${itemId}/photos/${photoId}/file`, { responseType: "blob" })
        .then((r) => URL.createObjectURL(r.data as Blob)),
    remove: (itemId: number, photoId: number) =>
      api.delete(`/api/items/${itemId}/photos/${photoId}`).then((r) => r.data),
  },
  brandManufacturers: crud<MasterBrandManufacturer>("/api/brand-manufacturers"),
  itemClasses: crud<MasterItemClass>("/api/item-classes"),
  itemSubClasses: crud<MasterItemSubClass>("/api/item-sub-classes"),
  packaging: crud<MasterPackaging>("/api/packaging"),
  features: crud<MasterFeature>("/api/features"),
  attributes: crud<MasterAttribute>("/api/attributes"),
  specs: crud<MasterSpec>("/api/specs"),
  // One screen for attributes, specs and features: all three answer the same two
  // questions of a category, so they share a table rather than needing three.
  categoryTags: crud<MasterCategoryTag>("/api/category-tags"),
  itemGroups: crud<MasterItemGroup>("/api/item-groups"),
  itemComponents: crud<MasterItemComponent>("/api/item-components"),
  hsnCodes: {
    ...crud<MasterHsnCode>("/api/hsn-codes"),
    resolve: (code: string) =>
      api.post<MasterHsnCode>("/api/hsn-codes/resolve", { code })
        .then((r) => r.data),
  },
  boms: crud<MasterBom>("/api/boms"),
  bomItems: crud<MasterBomItem>("/api/bom-items"),
  bomGroups: {
    ...crud<MasterBomGroup>("/api/bom-groups"),
    /** The job profiles a BOM can be given to. Derived from the HCM mirror by RBAC
     *  (there is no job-profile table), and served under the BOM permission so a
     *  master-data maintainer can fill the dropdown without holding RBAC's keys. */
    profiles: () => all<JobProfileOption>("/api/bom-groups/job-profiles"),
  },

  // Specs hang off an item rather than having their own id, so they are read and
  // saved per item and there is nothing to create or deactivate.
  itemSpecs: {
    get: (itemId: number) =>
      api.get<MasterItemSpec>(`/api/item-specs/${itemId}`).then((r) => r.data),
    save: (itemId: number, body: Partial<MasterItemSpec>) =>
      api.put<MasterItemSpec>(`/api/item-specs/${itemId}`, body).then((r) => r.data),
  },

  // UOM and its conversions are unpaginated: both are short lookup lists.
  uom: {
    ...crud<MasterUom>("/api/uom"),
    listAll: () => all<MasterUom>("/api/uom"),
    /** The standard units for a class, each flagged with whether it exists yet.
     *  Ticking a name is what stops "Litre", "litre" and "Ltr" becoming three rows. */
    suggestions: (uomClass: UomClass) =>
      all<UomSuggestion>(`/api/uom/suggestions?uom_class=${uomClass}`),
    createSuggested: (uomClass: UomClass, codes: string[]) =>
      api.post<{ created: string[]; skipped: string[] }>(
        "/api/uom/suggestions", { uom_class: uomClass, codes },
      ).then((r) => r.data),
  },
  uomConversions: {
    ...crud<MasterUomConversion>("/api/uom-conversions"),
    listAll: () => all<MasterUomConversion>("/api/uom-conversions"),
  },

  itemPackaging: {
    ...crud<MasterItemPackaging>("/api/item-packaging"),
    /** The ladder with its running totals. Multiplied up on the server on every
     *  read, so the totals cannot drift from the rungs they come from. */
    breakdown: (itemId: number) =>
      all<PackagingBreakdown>(`/api/items/${itemId}/packaging-breakdown`),
  },

  departments: () => all<RefRow>("/api/departments"),
  ownershipDepartments: () => all<RefRow>("/api/departments/ownership-options"),
  facilities: () => all<RefRow>("/api/facilities"),

  /** Whether the dock mints an asset / consumable code for this item's units.
   *
   * It is not a column on mst_items — the live schema is frozen — so it cannot ride
   * on the item read the way Has Batch and Has Serial do. It is written back through
   * the ordinary item save, as `generate_unit_code`. */
  unitCodeTracking: (itemId: number) =>
    api.get<{ generate_unit_code: boolean }>(`/api/items/${itemId}/unit-code-tracking`)
      .then((r) => r.data.generate_unit_code),

  /** The code a new item is about to get. Lock-free peek for the form's
   *  preview — the save re-derives the serial under lock, so this can be off
   *  by one if two people save into the same prefix together. */
  nextItemCode: (categoryId: number, generalNameId: number) =>
    api.get<{ prefix: string; next_serial: number; preview: string }>(
      "/api/items/next-code",
      { params: { category_id: categoryId, general_name_id: generalNameId } },
    ).then((r) => r.data),

  /** Read-only lookup of rbac_user_groups, so the item-group screen can name the
   *  group it is tagging to. Groups are created and edited in the RBAC module;
   *  reaching into that module's client would couple the two, so this is a plain
   *  fetch through the shared HTTP client instead. */
  userGroups: () =>
    api.get<Paginated<{ id: number; code: string; name: string }>>(
      "/api/rbac/groups", { params: { size: 300 } },
    ).then((r) => r.data.items),
};
