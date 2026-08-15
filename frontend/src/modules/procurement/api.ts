import { api } from "@/shared/api/client";
import type { Paginated } from "@/shared/types";
import type {
  Comparison, POCreate, POListRow, PurchaseOrder, Quotation, QuoteListRow,
  QuoteSubmit, ReqCreate, ReqListRow, Requisition, RFQ, RFQCreate, RFQInvite,
  RFQListRow, RFQUpdate, VendorAccount, VendorProfile, VendorToken,
} from "./types";

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

export const requisitionApi = {
  list: (params: { status?: string; page?: number; size?: number } = {}) =>
    api.get<Paginated<ReqListRow>>("/api/requisitions", { params }).then((r) => r.data),
  get: (id: number) =>
    api.get<Requisition>(`/api/requisitions/${id}`).then((r) => r.data),
  create: (data: ReqCreate) =>
    api.post<Requisition>("/api/requisitions", data).then((r) => r.data),
  update: (id: number, data: ReqCreate) =>
    api.put<Requisition>(`/api/requisitions/${id}`, data).then((r) => r.data),
  submit: (id: number) =>
    api.post<Requisition>(`/api/requisitions/${id}/submit`).then((r) => r.data),
  approve: (id: number, comments = "") =>
    api.post<Requisition>(`/api/requisitions/${id}/approve`, { comments }).then((r) => r.data),
  reject: (id: number, comments = "") =>
    api.post<Requisition>(`/api/requisitions/${id}/reject`, { comments }).then((r) => r.data),
  cancel: (id: number) =>
    api.post<Requisition>(`/api/requisitions/${id}/cancel`).then((r) => r.data),
};

export const rfqApi = {
  list: (params: { status?: string; page?: number; size?: number } = {}) =>
    api.get<Paginated<RFQListRow>>("/api/rfqs", { params }).then((r) => r.data),
  get: (id: number) => api.get<RFQ>(`/api/rfqs/${id}`).then((r) => r.data),
  create: (data: RFQCreate) => api.post<RFQ>("/api/rfqs", data).then((r) => r.data),
  update: (id: number, data: RFQUpdate) =>
    api.put<RFQ>(`/api/rfqs/${id}`, data).then((r) => r.data),
  submit: (id: number) => api.post<RFQ>(`/api/rfqs/${id}/submit`).then((r) => r.data),
  approve: (id: number, comments = "") =>
    api.post<RFQ>(`/api/rfqs/${id}/approve`, { comments }).then((r) => r.data),
  reject: (id: number, comments = "") =>
    api.post<RFQ>(`/api/rfqs/${id}/reject`, { comments }).then((r) => r.data),
  close: (id: number) => api.post<RFQ>(`/api/rfqs/${id}/close`).then((r) => r.data),
  cancel: (id: number) => api.post<RFQ>(`/api/rfqs/${id}/cancel`).then((r) => r.data),
  invites: (id: number) =>
    api.get<RFQInvite[]>(`/api/rfqs/${id}/invites`).then((r) => r.data),
  comparison: (id: number) =>
    api.get<Comparison>(`/api/rfqs/${id}/comparison`).then((r) => r.data),
  award: (id: number, quotation_id: number, comments = "") =>
    api.post<RFQ>(`/api/rfqs/${id}/award`, { quotation_id, comments }).then((r) => r.data),
  quotations: (params: { rfq_id?: number; vendor_id?: number; page?: number; size?: number } = {}) =>
    api.get<Paginated<QuoteListRow>>("/api/rfqs/quotations", { params }).then((r) => r.data),
  quotation: (id: number) =>
    api.get<Quotation>(`/api/rfqs/quotations/${id}`).then((r) => r.data),
};

/** The internal side of the portal: who outside the company may sign in. */
export const supplierAccountApi = {
  list: (params: { page?: number; size?: number } = {}) =>
    api.get<Paginated<VendorAccount>>("/api/supplier-accounts", { params }).then((r) => r.data),
  create: (vendor_id: number, username?: string) =>
    api.post<VendorAccount>("/api/supplier-accounts", { vendor_id, username }).then((r) => r.data),
  reset: (vendorId: number) =>
    api.post<VendorAccount>(`/api/supplier-accounts/${vendorId}/reset`).then((r) => r.data),
  disable: (vendorId: number) =>
    api.post<VendorAccount>(`/api/supplier-accounts/${vendorId}/disable`).then((r) => r.data),
  enable: (vendorId: number) =>
    api.post<VendorAccount>(`/api/supplier-accounts/${vendorId}/enable`).then((r) => r.data),
};

/** What the vendor's own browser calls. Uses the supplier token, not the employee
 *  one — the client picks by URL prefix (`shared/api/client.ts`). */
export const supplierApi = {
  login: (username: string, password: string) =>
    api.post<VendorToken>("/api/supplier/login", { username, password }).then((r) => r.data),
  me: () => api.get<VendorProfile>("/api/supplier/me").then((r) => r.data),
  changePassword: (current_password: string, new_password: string) =>
    api.post("/api/supplier/change-password", { current_password, new_password }),
  rfqs: (params: { page?: number; size?: number } = {}) =>
    api.get<Paginated<RFQListRow>>("/api/supplier/rfqs", { params }).then((r) => r.data),
  rfq: (id: number) => api.get<RFQ>(`/api/supplier/rfqs/${id}`).then((r) => r.data),
  quotation: (rfqId: number) =>
    api.get<Quotation>(`/api/supplier/rfqs/${rfqId}/quotation`).then((r) => r.data),
  submitQuotation: (rfqId: number, data: QuoteSubmit) =>
    api.post<Quotation>(`/api/supplier/rfqs/${rfqId}/quotation`, data).then((r) => r.data),
};
