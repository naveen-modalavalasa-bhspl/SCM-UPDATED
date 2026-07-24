import { api } from "@/shared/api/client";
import type { Paginated } from "@/shared/types";
import type { GRN, GRNCreate, GRNListRow, Issue, MovementRow, StockRow } from "./types";

export const grnApi = {
  list: (params: { status?: string; po_id?: number; page?: number; size?: number }) =>
    api.get<Paginated<GRNListRow>>("/api/grn", { params }).then((r) => r.data),
  get: (id: number) => api.get<GRN>(`/api/grn/${id}`).then((r) => r.data),
  createFromPo: (poId: number, data: GRNCreate) =>
    api.post<GRN>(`/api/grn/from-po/${poId}`, data).then((r) => r.data),
  qcPass: (id: number) => api.post<GRN>(`/api/grn/${id}/qc-pass`).then((r) => r.data),
  qcFail: (id: number) => api.post<GRN>(`/api/grn/${id}/qc-fail`).then((r) => r.data),
};

export const stockApi = {
  list: (params: { item_id?: number; facility_id?: number; page?: number; size?: number } = {}) =>
    api.get<Paginated<StockRow>>("/api/stock", { params }).then((r) => r.data),
  movements: (params: { item_id?: number; page?: number; size?: number } = {}) =>
    api.get<Paginated<MovementRow>>("/api/stock/movements", { params }).then((r) => r.data),
};

export const issueApi = {
  list: (params: { page?: number; size?: number } = {}) =>
    api.get<Paginated<Issue>>("/api/issues", { params }).then((r) => r.data),
  issue: (id: number) => api.post<Issue>(`/api/issues/${id}/issue`).then((r) => r.data),
};
