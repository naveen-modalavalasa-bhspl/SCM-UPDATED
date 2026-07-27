import { api } from "@/shared/api/client";
import type { Paginated } from "@/shared/types";
import type {
  MasterAttribute, MasterAttributeMapping, MasterBin, MasterBom,
  MasterBomItem, MasterBrand, MasterCategory, MasterFeature, MasterItem,
  MasterItemClass, MasterItemSpec, MasterPackaging, MasterPriceList,
  MasterPriceListItem, MasterUom, MasterUomConversion, MasterVendor,
  MasterWarehouse, Project, RefRow,
  MasterBrandManufacturer, MasterItemSubClass, NamedMaster,
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
function crud<T>(path: string) {
  return {
    list: (p: ListParams = {}) => page<T>(path, p),
    create: (body: Partial<T>) => api.post<T>(path, body).then((r) => r.data),
    update: (id: number, body: Partial<T>) =>
      api.put<T>(`${path}/${id}`, body).then((r) => r.data),
    deactivate: (id: number) => api.delete(`${path}/${id}`).then((r) => r.data),
  };
}

export const mastersApi = {
  items: crud<MasterItem>("/api/items"),
  categories: crud<MasterCategory>("/api/item-categories"),
  vendors: crud<MasterVendor>("/api/vendors"),
  warehouses: crud<MasterWarehouse>("/api/warehouses"),
  bins: crud<MasterBin>("/api/bins"),
  projects: crud<Project>("/api/projects"),
  brands: crud<MasterBrand>("/api/brands"),
  manufacturers: crud<NamedMaster>("/api/manufacturers"),
  generalNames: crud<NamedMaster>("/api/general-names"),
  dosageForms: crud<NamedMaster>("/api/dosage-forms"),
  brandManufacturers: crud<MasterBrandManufacturer>("/api/brand-manufacturers"),
  itemClasses: crud<MasterItemClass>("/api/item-classes"),
  itemSubClasses: crud<MasterItemSubClass>("/api/item-sub-classes"),
  packaging: crud<MasterPackaging>("/api/packaging"),
  features: crud<MasterFeature>("/api/features"),
  attributes: crud<MasterAttribute>("/api/attributes"),
  attributeMappings: crud<MasterAttributeMapping>("/api/attribute-mappings"),
  priceLists: crud<MasterPriceList>("/api/price-lists"),
  priceListItems: crud<MasterPriceListItem>("/api/price-list-items"),
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
  },
  uomConversions: {
    ...crud<MasterUomConversion>("/api/uom-conversions"),
    listAll: () => all<MasterUomConversion>("/api/uom-conversions"),
  },

  departments: () => all<RefRow>("/api/departments"),
  facilities: () => all<RefRow>("/api/facilities"),
};
