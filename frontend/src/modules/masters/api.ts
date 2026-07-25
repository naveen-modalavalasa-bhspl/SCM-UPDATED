import { api } from "@/shared/api/client";
import type { Paginated } from "@/shared/types";
import type {
  DocSeries, MasterCategory, MasterItem, MasterBin, MasterRole, MasterUom, MasterUomConversion,
  MasterVendor, MasterWarehouse, Project, RefRow,
} from "./types";

type ListParams = { search?: string; page?: number; size?: number; include_inactive?: boolean };

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

  // UOM and its conversions are unpaginated: both are short lookup lists.
  uom: {
    ...crud<MasterUom>("/api/uom"),
    listAll: () => all<MasterUom>("/api/uom"),
  },
  uomConversions: {
    ...crud<MasterUomConversion>("/api/uom-conversions"),
    listAll: () => all<MasterUomConversion>("/api/uom-conversions"),
  },

  roles: () => all<MasterRole>("/api/admin/roles"),
  docSeries: {
    listAll: () => all<DocSeries>("/api/admin/doc-series"),
    create: (body: Partial<DocSeries>) =>
      api.post<DocSeries>("/api/admin/doc-series", body).then((r) => r.data),
    update: (id: number, body: Partial<DocSeries>) =>
      api.put<DocSeries>(`/api/admin/doc-series/${id}`, body).then((r) => r.data),
    deactivate: (id: number) =>
      api.delete(`/api/admin/doc-series/${id}`).then((r) => r.data),
  },

  departments: () => all<RefRow>("/api/departments"),
  facilities: () => all<RefRow>("/api/facilities"),
};
