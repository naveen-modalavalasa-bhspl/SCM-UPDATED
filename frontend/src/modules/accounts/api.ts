import { api } from "@/shared/api/client";
import type {
  CarrierInvoiceRow, FiledDocument, Page, PayableRow, PaymentInput, PoPayments,
  VendorPayment,
} from "./types";

/** Save a protected file through the authenticated client. A plain link cannot carry
 *  the bearer token, so the bytes come down as a blob and are handed to the browser. */
export async function downloadFile(url: string, fileName: string): Promise<void> {
  const res = await api.get(url, { responseType: "blob" });
  const href = URL.createObjectURL(res.data as Blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

export const accountsApi = {
  meta: () => api.get<{ stages: { value: string; label: string; trigger: string }[];
    modes: string[] }>("/api/accounts/meta").then((r) => r.data),
  payables: (params: { page?: number; size?: number; tab?: string; search?: string }) =>
    api.get<Page<PayableRow>>("/api/accounts/payables", { params }).then((r) => r.data),
  po: (poId: number) =>
    api.get<PoPayments>(`/api/accounts/pos/${poId}`).then((r) => r.data),
  /** The same answer for the PO desk, behind po.view. */
  poForBuyer: (poId: number) =>
    api.get<PoPayments>(`/api/pos/${poId}/payments`).then((r) => r.data),
  payments: (params: { page?: number; size?: number; status?: string; search?: string }) =>
    api.get<Page<VendorPayment>>("/api/accounts/payments", { params }).then((r) => r.data),
  payment: (id: number) =>
    api.get<VendorPayment>(`/api/accounts/payments/${id}`).then((r) => r.data),
  record: (body: PaymentInput) =>
    api.post<VendorPayment>("/api/accounts/payments", body).then((r) => r.data),
  addProof: (id: number, file: File) => {
    const body = new FormData();
    body.append("file", file);
    return api.post<VendorPayment>(`/api/accounts/payments/${id}/proofs`, body)
      .then((r) => r.data);
  },
  act: (id: number, action: "APPROVE" | "REJECT", remarks?: string) =>
    api.post<VendorPayment>(`/api/accounts/payments/${id}/act`, { action, remarks })
      .then((r) => r.data),
  carrierInvoices: (params: { page?: number; size?: number; search?: string }) =>
    api.get<Page<CarrierInvoiceRow>>("/api/accounts/carrier-invoices", { params })
      .then((r) => r.data),
};

/** Where a filed document is listed, uploaded, removed and downloaded — one shape for
 *  the supplier's PO documents, the carrier's shipment invoices and the read-only
 *  views of both inside the company. */
export interface DocumentEndpoints {
  list: () => Promise<FiledDocument[]>;
  upload?: (category: string, file: File) => Promise<FiledDocument[]>;
  remove?: (id: number) => Promise<FiledDocument[]>;
  downloadUrl: (id: number) => string;
}

const form = (category: string | null, file: File) => {
  const body = new FormData();
  if (category) body.append("doc_category", category);
  body.append("file", file);
  return body;
};

/** The supplier portal: invoices and DCs against one of their POs. */
export const supplierPoDocs = (poId: number): DocumentEndpoints => ({
  list: () => api.get<FiledDocument[]>(`/api/supplier/pos/${poId}/documents`).then((r) => r.data),
  upload: (category, file) => api.post<FiledDocument[]>(
    `/api/supplier/pos/${poId}/documents`, form(category, file)).then((r) => r.data),
  remove: (id) => api.delete<FiledDocument[]>(`/api/supplier/pos/${poId}/documents/${id}`)
    .then((r) => r.data),
  downloadUrl: (id) => `/api/supplier/pos/${poId}/documents/${id}/download`,
});

/** The carrier portal: freight invoices against a shipment they won. */
export const carrierInvoiceDocs = (trId: number): DocumentEndpoints => ({
  list: () => api.get<FiledDocument[]>(`/api/supplier/transport/${trId}/invoices`)
    .then((r) => r.data),
  upload: (_category, file) => api.post<FiledDocument[]>(
    `/api/supplier/transport/${trId}/invoices`, form(null, file)).then((r) => r.data),
  remove: (id) => api.delete<FiledDocument[]>(`/api/supplier/transport/${trId}/invoices/${id}`)
    .then((r) => r.data),
  downloadUrl: (id) => `/api/supplier/transport/${trId}/invoices/${id}/download`,
});
