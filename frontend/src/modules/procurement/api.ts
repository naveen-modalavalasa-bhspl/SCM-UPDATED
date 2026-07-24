import { api } from "@/shared/api/client";
import type { Paginated } from "@/shared/types";
import type { POCreate, POListRow, PurchaseOrder } from "./types";

export const poApi = {
  list: (params: { status?: string; vendor_id?: number; page?: number; size?: number }) =>
    api.get<Paginated<POListRow>>("/api/pos", { params }).then((r) => r.data),
  openForGrn: (params: { page?: number; size?: number } = {}) =>
    api.get<Paginated<POListRow>>("/api/pos/open-for-grn", { params }).then((r) => r.data),
  get: (id: number) => api.get<PurchaseOrder>(`/api/pos/${id}`).then((r) => r.data),
  createFromIndent: (indentId: number, data: POCreate) =>
    api.post<PurchaseOrder>(`/api/pos/from-indent/${indentId}`, data).then((r) => r.data),
  submit: (id: number) => api.post<PurchaseOrder>(`/api/pos/${id}/submit`).then((r) => r.data),
  approve: (id: number, comments = "") =>
    api.post<PurchaseOrder>(`/api/pos/${id}/approve`, { comments }).then((r) => r.data),
  reject: (id: number, comments = "") =>
    api.post<PurchaseOrder>(`/api/pos/${id}/reject`, { comments }).then((r) => r.data),
  sendToVendor: (id: number) =>
    api.post<PurchaseOrder>(`/api/pos/${id}/send-to-vendor`).then((r) => r.data),
};
