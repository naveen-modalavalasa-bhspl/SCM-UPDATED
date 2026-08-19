import { api } from "@/shared/api/client";
import type { Paginated } from "@/shared/types";
import type {
  ApprovalTrail,
  Comparison, Consolidation, ConsolidationCreate, ConsolidationListRow,
  ConsolidationSource, DespatchNote, DespatchNoteWrite, EvaluationMethodOption,
  MRCandidate, POAmend, POCreate, POFromQuotation, POHeader, POListRow, PORevision,
  PurchaseOrder, VendorPO,
  VendorPOListRow,
  Quotation, QuoteListRow, QuoteSubmit, ReqCreate, ReqFromMRs, ReqListRow, Requisition, RFQ,
  RFQCreate, RFQInvite, RFQListRow, RFQUpdate, VendorAccount, VendorProfile,
  VendorToken,
} from "./types";

export const poApi = {
  list: (params: { 
    search?: string;
    status?: string; 
    vendor_id?: number; 
    project_id?: number;
    date_from?: string;
    date_to?: string;
    page?: number; 
    size?: number 
  }) =>
    api.get<Paginated<POListRow>>("/api/pos", { params }).then((r) => r.data),
  /** The CSV comes back through axios so it carries the bearer token — a plain
   *  <a href> download hits the endpoint unauthenticated and 401s. */
  export: async (params: {
    search?: string;
    status?: string;
    vendor_id?: number;
    project_id?: number;
    date_from?: string;
    date_to?: string;
  }) => {
    const response = await api.get("/api/pos/export", {
      params, responseType: "blob",
    });
    const url = URL.createObjectURL(response.data as Blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "purchase_orders.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },
  openForGrn: (params: { page?: number; size?: number } = {}) =>
    api.get<Paginated<POListRow>>("/api/pos/open-for-grn", { params }).then((r) => r.data),
  get: (id: number) => api.get<PurchaseOrder>(`/api/pos/${id}`).then((r) => r.data),
  /** Raised by hand, with no indent or quotation behind it. */
  create: (data: POCreate) =>
    api.post<PurchaseOrder>("/api/pos", data).then((r) => r.data),
  createFromIndent: (indentId: number, data: POCreate) =>
    api.post<PurchaseOrder>(`/api/pos/from-indent/${indentId}`, data).then((r) => r.data),
  /** Accept the awarded offer. No vendor and no lines — both come from the quotation,
   *  so a PO can never disagree with the quote it says it is for. */
  createFromQuotation: (quotationId: number, data: POFromQuotation = {}) =>
    api.post<PurchaseOrder>(`/api/pos/from-quotation/${quotationId}`, data)
      .then((r) => r.data),
  /** The header a draft order was raised without — terms, addresses, project. DRAFT
   *  only, server-side; the screen only offers it on a draft for the same reason. */
  update: (id: number, data: POHeader & { expected_date?: string | null }) =>
    api.put<PurchaseOrder>(`/api/pos/${id}`, data).then((r) => r.data),
  /** Revise an order that has already gone out. Files the old version away, bumps the
   *  revision and sends it back through approval — and back to the vendor to accept. */
  amend: (id: number, data: POAmend) =>
    api.post<PurchaseOrder>(`/api/pos/${id}/amend`, data).then((r) => r.data),
  revisions: (id: number) =>
    api.get<PORevision[]>(`/api/pos/${id}/revisions`).then((r) => r.data),
  submit: (id: number) => api.post<PurchaseOrder>(`/api/pos/${id}/submit`).then((r) => r.data),
  approve: (id: number, comments = "") =>
    api.post<PurchaseOrder>(`/api/pos/${id}/approve`, { comments }).then((r) => r.data),
  reject: (id: number, comments = "") =>
    api.post<PurchaseOrder>(`/api/pos/${id}/reject`, { comments }).then((r) => r.data),
  sendToVendor: (id: number) =>
    api.post<PurchaseOrder>(`/api/pos/${id}/send-to-vendor`).then((r) => r.data),
};

export const requisitionApi = {
  list: (params: { status?: string; search?: string; page?: number; size?: number } = {}) =>
    api.get<Paginated<ReqListRow>>("/api/requisitions", { params }).then((r) => r.data),
  get: (id: number) =>
    api.get<Requisition>(`/api/requisitions/${id}`).then((r) => r.data),
  create: (data: ReqCreate) =>
    api.post<Requisition>("/api/requisitions", data).then((r) => r.data),
  /** Pick up an approved material request as a requisition, lines and all. The one
   *  join in the chain a buyer was making by hand — and the one place a quantity
   *  could change between two documents. */
  createFromMr: (mrId: number) =>
    api.post<Requisition>(`/api/requisitions/from-material-request/${mrId}`)
      .then((r) => r.data),
  /** Approved MRs no requisition has claimed yet — the consolidation picker's source. */
  mrCandidates: (params: { project_id?: number; page?: number; size?: number } = {}) =>
    api.get<Paginated<MRCandidate>>("/api/requisitions/mr-candidates", { params })
      .then((r) => r.data),
  /** Several approved MRs folded into ONE requisition, merged item-wise. */
  createFromMrs: (data: ReqFromMRs) =>
    api.post<Requisition>("/api/requisitions/from-material-requests", data)
      .then((r) => r.data),
  sources: (id: number) =>
    api.get<{ mr_id: number; mr_no: string; indent_no?: string | null; item_count: number }[]>(
      `/api/requisitions/${id}/sources`).then((r) => r.data),
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

export const consolidationApi = {
  /** Approved requisitions not already on a sheet — the picker's source. */
  candidates: (params: { project_id?: number; page?: number; size?: number } = {}) =>
    api.get<Paginated<ReqListRow>>("/api/consolidations/candidates", { params })
      .then((r) => r.data),
  list: (params: { status?: string; project_id?: number; page?: number; size?: number } = {}) =>
    api.get<Paginated<ConsolidationListRow>>("/api/consolidations", { params })
      .then((r) => r.data),
  get: (id: number) =>
    api.get<Consolidation>(`/api/consolidations/${id}`).then((r) => r.data),
  create: (data: ConsolidationCreate) =>
    api.post<Consolidation>("/api/consolidations", data).then((r) => r.data),
  /** Change which requisitions are on the sheet — the lines are re-aggregated. */
  rebuild: (id: number, data: ConsolidationCreate) =>
    api.put<Consolidation>(`/api/consolidations/${id}`, data).then((r) => r.data),
  setLines: (id: number, lines: { line_id: number; approved_qty: number; remarks?: string | null }[]) =>
    api.put<Consolidation>(`/api/consolidations/${id}/lines`, { lines })
      .then((r) => r.data),
  remove: (id: number) => api.delete(`/api/consolidations/${id}`).then((r) => r.data),
  sources: (id: number) =>
    api.get<ConsolidationSource[]>(`/api/consolidations/${id}/sources`)
      .then((r) => r.data),
  submit: (id: number) =>
    api.post<Consolidation>(`/api/consolidations/${id}/submit`).then((r) => r.data),
  approve: (id: number, comments = "") =>
    api.post<Consolidation>(`/api/consolidations/${id}/approve`, { comments })
      .then((r) => r.data),
  reject: (id: number, comments: string) =>
    api.post<Consolidation>(`/api/consolidations/${id}/reject`, { comments })
      .then((r) => r.data),
  cancel: (id: number, comments = "") =>
    api.post<Consolidation>(`/api/consolidations/${id}/cancel`, { comments })
      .then((r) => r.data),
};

export const rfqApi = {
  list: (params: { status?: string; search?: string; page?: number; size?: number } = {}) =>
    api.get<Paginated<RFQListRow>>("/api/rfqs", { params }).then((r) => r.data),
  get: (id: number) => api.get<RFQ>(`/api/rfqs/${id}`).then((r) => r.data),
  create: (data: RFQCreate) => api.post<RFQ>("/api/rfqs", data).then((r) => r.data),
  update: (id: number, data: RFQUpdate) =>
    api.put<RFQ>(`/api/rfqs/${id}`, data).then((r) => r.data),
  submit: (id: number) => api.post<RFQ>(`/api/rfqs/${id}/submit`).then((r) => r.data),
  /** The approver's own edit: how much, and nothing else. Gated on `rfq.approve`. */
  setQuantities: (id: number, lines: { id: number; quantity: number }[], comments = "") =>
    api.put<RFQ>(`/api/rfqs/${id}/quantities`, { lines, comments }).then((r) => r.data),
  approve: (id: number, comments = "") =>
    api.post<RFQ>(`/api/rfqs/${id}/approve`, { comments }).then((r) => r.data),
  reject: (id: number, comments = "") =>
    api.post<RFQ>(`/api/rfqs/${id}/reject`, { comments }).then((r) => r.data),
  close: (id: number) => api.post<RFQ>(`/api/rfqs/${id}/close`).then((r) => r.data),
  cancel: (id: number) => api.post<RFQ>(`/api/rfqs/${id}/cancel`).then((r) => r.data),
  invites: (id: number) =>
    api.get<RFQInvite[]>(`/api/rfqs/${id}/invites`).then((r) => r.data),
  /** `method` previews a different ranking without saving it to the RFQ. */
  comparison: (id: number, method?: string) =>
    api.get<Comparison>(`/api/rfqs/${id}/comparison`, { params: { method } })
      .then((r) => r.data),
  evaluationMethods: () =>
    api.get<EvaluationMethodOption[]>("/api/rfqs/evaluation-methods")
      .then((r) => r.data),
  award: (id: number, quotation_id: number, comments = "") =>
    api.post<RFQ>(`/api/rfqs/${id}/award`, { quotation_id, comments }).then((r) => r.data),
  quotations: (params: { rfq_id?: number; vendor_id?: number; search?: string; page?: number; size?: number } = {}) =>
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
  rfqs: (params: { search?: string; page?: number; size?: number } = {}) =>
    api.get<Paginated<RFQListRow>>("/api/supplier/rfqs", { params }).then((r) => r.data),
  rfq: (id: number) => api.get<RFQ>(`/api/supplier/rfqs/${id}`).then((r) => r.data),
  /* --- orders, and what the vendor says they have sent against them --- */
  pos: (params: { search?: string; page?: number; size?: number } = {}) =>
    api.get<Paginated<VendorPOListRow>>("/api/supplier/pos", { params }).then((r) => r.data),
  po: (id: number) => api.get<VendorPO>(`/api/supplier/pos/${id}`).then((r) => r.data),
  revisions: (poId: number) =>
    api.get<PORevision[]>(`/api/supplier/pos/${poId}/revisions`).then((r) => r.data),
  /** Accept the order, or decline it with a reason. Nothing may be despatched against
   *  an order that has not been accepted. */
  respondToPo: (id: number, accept: boolean, note = "") =>
    api.post<VendorPO>(`/api/supplier/pos/${id}/respond`, { accept, note })
      .then((r) => r.data),
  createDespatch: (poId: number, body: DespatchNoteWrite) =>
    api.post<DespatchNote>(`/api/supplier/pos/${poId}/despatch-notes`, body)
      .then((r) => r.data),
  updateDespatch: (poId: number, noteId: number, body: DespatchNoteWrite) =>
    api.put<DespatchNote>(`/api/supplier/pos/${poId}/despatch-notes/${noteId}`, body)
      .then((r) => r.data),
  despatch: (noteId: number) =>
    api.get<DespatchNote>(`/api/supplier/despatch-notes/${noteId}`).then((r) => r.data),
  submitDespatch: (noteId: number) =>
    api.post<DespatchNote>(`/api/supplier/despatch-notes/${noteId}/submit`)
      .then((r) => r.data),
  cancelDespatch: (noteId: number) =>
    api.post<DespatchNote>(`/api/supplier/despatch-notes/${noteId}/cancel`)
      .then((r) => r.data),
  quotation: (rfqId: number) =>
    api.get<Quotation>(`/api/supplier/rfqs/${rfqId}/quotation`).then((r) => r.data),
  submitQuotation: (rfqId: number, data: QuoteSubmit) =>
    api.post<Quotation>(`/api/supplier/rfqs/${rfqId}/quotation`, data).then((r) => r.data),
};


// --------------------------------------------------------------------------- //
//  Approval trail
//
//  One route per document, each guarded by that document's OWN view permission on
//  the server (`po.view`, `requisition.view`, `rfq.view`, `consolidation.view`) —
//  no new permission code, so nothing needs reseeding and no job profile changes.
//  Deliberately NOT `/api/approvals/history/...`: that one is scoped to people who
//  took part in the approval, so a buyer reading somebody else's order gets an
//  empty list from it.
// --------------------------------------------------------------------------- //

/** The base path each procurement document is served under. */
const TRAIL_PATH: Record<string, string> = {
  PO: "/api/pos",
  REQUISITION: "/api/requisitions",
  RFQ: "/api/rfqs",
  CONSOLIDATION: "/api/consolidations",
};

export type ProcurementDocType = keyof typeof TRAIL_PATH;

export const approvalTrailApi = {
  get: (docType: ProcurementDocType, docId: number) =>
    api.get<ApprovalTrail>(`${TRAIL_PATH[docType]}/${docId}/approvals`)
      .then((r) => r.data),
};

export const approvalTrailKey = (docType: string, docId: number) =>
  ["procurement", "approval-trail", docType, docId] as const;
