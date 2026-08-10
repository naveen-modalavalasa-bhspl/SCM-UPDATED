import { api } from "@/shared/api/client";
import type { Paginated } from "@/shared/types";
import type {
  MasterAttribute, MasterBin, MasterBom, MasterBomItem, MasterBrand,
  MasterCategory, MasterCategoryTag, MasterFeature, MasterItem,
  MasterHsnCode, MasterItemClass, MasterItemComponent, MasterItemGroup,
  MasterItemPackaging, MasterItemSpec, MasterPackaging, MasterSpec,
  MasterUom, MasterUomConversion, MasterVendor, MasterVendorItem, PackagingBreakdown,
  MasterWarehouse, Project, RefRow, UomClass, UomSuggestion,
  MasterBrandManufacturer, MasterGeneralName, MasterItemSubClass, NamedMaster,
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

export interface MasterUsage {
  id: number; total: number; used_by: { label: string; count: number }[];
}

/** The three bulk calls, as `BulkBar` consumes them. Named here rather than
 *  re-described at each use so the two sides cannot drift. */
export interface BulkApi {
  template: () => Promise<void>;
  export: (p?: ListParams) => Promise<void>;
  import: (file: File) => Promise<ImportResult>;
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
  };
}

export const mastersApi = {
  items: crud<MasterItem>("/api/items"),
  categories: crud<MasterCategory>("/api/item-categories"),
  vendors: crud<MasterVendor>("/api/vendors"),
  vendorItems: crud<MasterVendorItem>("/api/vendor-items"),
  warehouses: crud<MasterWarehouse>("/api/warehouses"),
  bins: crud<MasterBin>("/api/bins"),
  // HCM owns projects, so the backend registers only the list route (see
  // shared/masters/defs.py). There is nothing here to create or edit.
  projects: { list: (p: ListParams = {}) => page<Project>("/api/projects", p) },
  brands: crud<MasterBrand>("/api/brands"),
  manufacturers: crud<NamedMaster>("/api/manufacturers"),
  generalNames: crud<MasterGeneralName>("/api/general-names"),
  dosageForms: crud<NamedMaster>("/api/dosage-forms"),
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
  facilities: () => all<RefRow>("/api/facilities"),

  /** Read-only lookup of rbac_user_groups, so the item-group screen can name the
   *  group it is tagging to. Groups are created and edited in the RBAC module;
   *  reaching into that module's client would couple the two, so this is a plain
   *  fetch through the shared HTTP client instead. */
  userGroups: () =>
    api.get<Paginated<{ id: number; code: string; name: string }>>(
      "/api/rbac/groups", { params: { size: 300 } },
    ).then((r) => r.data.items),
};
