import { api } from "@/shared/api/client";
import type { Paginated } from "@/shared/types";
import type {
  ApprovalTrail,
  Comparison, Consolidation, ConsolidationCreate, ConsolidationListRow,
  ConsolidationSource, DespatchNote, DespatchNoteWrite, EvaluationMethodOption,
  MRCandidate, POAmend, POCreate, POFromQuotation, POHeader, POListRow, PORevision,
  PurchaseOrder, VendorPO,
  VendorPOListRow, VendorReturnDetail, VendorReturnListRow,
  VendorReturnReceiptInput,
  VendorReturnDecisionInput, VendorReturnSettlementInput,
  VendorTransportInput, ReplacementDispatchInput,
  ReplacementDocumentType,
  Quotation, QuoteListRow, QuoteOtpSent, QuoteSubmit, QuoteChangeRequest,
  QuoteComment, PriceTrailVersion, ReqCreate, ReqFromMRs, ReqListRow, Requisition, RFQ,
  RFQCreate, RFQInvite, RFQListRow, RFQUpdate, VendorAccount, VendorProfile,
  ProcurementLedgerFilters, ProcurementLedgerRow,
  VendorNotification, VendorToken,
  Supplier, SupplierInput, SupplierSummary, SupplierType,
  ConsolidationStats, DemandPoolRow, LedgerStats, POStats, QuoteStats, ReqStats,
  RFQStats,
} from "./types";

export const poApi = {
  list: (params: { 
    search?: string;
    status?: string; 
    vendor_id?: number; 
    project_id?: number;
    date_from?: string;
    date_to?: string;
    /** Only what is waiting on THIS login's signature, straight off the workflow
     *  engine. It can only NARROW what `po.view` already returns, so it needs no
     *  permission of its own. */
    pending_for_me?: boolean;
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
  /** Discussion thread — approver asks, raiser replies — flat per PO, append-only. */
  comments: (id: number) =>
    api.get<import("./types").POComment[]>(`/api/pos/${id}/comments`).then((r) => r.data),
  postComment: (id: number, message: string) =>
    api.post<import("./types").POComment>(`/api/pos/${id}/comments`, { message }).then((r) => r.data),
  /** Approver trims quantities — decrease only — while awaiting approval. */
  updateApprovalQuantities: (id: number, lines: { id: number; quantity: number }[]) =>
    api.put<PurchaseOrder>(`/api/pos/${id}/approval-quantities`, { lines }).then((r) => r.data),
};

export const requisitionApi = {
  list: (params: {
    status?: string; search?: string; pending_for_me?: boolean;
    page?: number; size?: number;
  } = {}) =>
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
  /** Every candidate id, for "select all". The list pages twenty at a time, so a
   *  select-all built from the loaded rows would only ever tick the visible twenty. */
  mrCandidateIds: (params: { project_id?: number } = {}) =>
    api.get<number[]>("/api/requisitions/mr-candidates/ids", { params })
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
  /** Every candidate id, for "select all" — see `mrCandidateIds`. */
  candidateIds: (params: { project_id?: number } = {}) =>
    api.get<number[]>("/api/consolidations/candidates/ids", { params })
      .then((r) => r.data),
  list: (params: {
    status?: string; project_id?: number; pending_for_me?: boolean;
    page?: number; size?: number;
  } = {}) =>
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
  list: (params: {
    status?: string; search?: string; pending_for_me?: boolean;
    /** A tender that is open or closed, has replies, and has no winner. Not a
     *  status, so it cannot ride on `status` — and it is the same predicate
     *  `stats.rfq_stats` counts, so the tile opens exactly the rows it counted. */
    ready_to_award?: boolean;
    page?: number; size?: number;
  } = {}) =>
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
  award: (id: number, quotation_ids: number[], comments = "", generate_pos = true) =>
    api.post<RFQ>(`/api/rfqs/${id}/award`, { quotation_ids, comments, generate_pos }).then((r) => r.data),
  awardSplit: (
    id: number,
    allocations: { item_id: number; vendor_id: number; quantity: number }[],
    comments = "",
    generate_pos = true,
  ) => api.post<RFQ>(`/api/rfqs/${id}/award`, { allocations, comments, generate_pos }).then((r) => r.data),
  quotations: (params: {
    rfq_id?: number; vendor_id?: number; search?: string;
    /** One status or a comma-separated set, so a KPI tile counting a bucket
     *  ("to compare" = submitted + revised) opens exactly the rows it counted. */
    status?: string;
    page?: number; size?: number;
  } = {}) =>
    api.get<Paginated<QuoteListRow>>("/api/rfqs/quotations", { params }).then((r) => r.data),
  quotation: (id: number) =>
    api.get<Quotation>(`/api/rfqs/quotations/${id}`).then((r) => r.data),

  // ── Freeze Prices (2026-09-26) ───────────────────────────────────────
  /** Close the tender to pricing. Suppliers can no longer quote or re-price;
   *  award and POs unlock. */
  freeze: (id: number) =>
    api.post<RFQ>(`/api/rfqs/${id}/freeze`).then((r) => r.data),
  /** Reopen bidding. The reason is required and audited. */
  unfreeze: (id: number, reason: string) =>
    api.post<RFQ>(`/api/rfqs/${id}/unfreeze`, { reason }).then((r) => r.data),

  // ── Change Requests, Price Trail, quotation chat ─────────────────────
  changeRequests: (quoteId: number) =>
    api.get<QuoteChangeRequest[]>(`/api/rfqs/quotations/${quoteId}/change-requests`)
      .then((r) => r.data),
  proposeChange: (quoteId: number, body: {
    reason: string;
    lines: {
      quotation_item_id: number; proposed_quantity: number;
      proposed_rate: number; proposed_discount_percent: number; note?: string;
    }[];
  }) =>
    api.post<QuoteChangeRequest>(`/api/rfqs/quotations/${quoteId}/change-requests`, body)
      .then((r) => r.data),
  withdrawChange: (quoteId: number, crId: number) =>
    api.post<QuoteChangeRequest>(
      `/api/rfqs/quotations/${quoteId}/change-requests/${crId}/withdraw`)
      .then((r) => r.data),
  priceTrail: (quoteId: number) =>
    api.get<PriceTrailVersion[]>(`/api/rfqs/quotations/${quoteId}/price-trail`)
      .then((r) => r.data),
  quoteComments: (quoteId: number) =>
    api.get<QuoteComment[]>(`/api/rfqs/quotations/${quoteId}/comments`)
      .then((r) => r.data),
  postQuoteComment: (quoteId: number, message: string) =>
    api.post<QuoteComment>(`/api/rfqs/quotations/${quoteId}/comments`, { message })
      .then((r) => r.data),
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
  /* --- the vendor's own bell (2026-08-21) --- */
  /** Scoped server-side on the vendor id in the token; there is no id to pass. */
  notifications: (params: { unread_only?: boolean; page?: number; size?: number } = {}) =>
    api.get<Paginated<VendorNotification>>("/api/supplier/notifications", { params })
      .then((r) => r.data),
  readNotification: (id: number) =>
    api.post(`/api/supplier/notifications/${id}/read`),
  changePassword: (current_password: string, new_password: string) =>
    api.post("/api/supplier/change-password", { current_password, new_password }),
  rfqs: (params: { search?: string; status?: string; page?: number; size?: number } = {}) =>
    api.get<Paginated<RFQListRow>>("/api/supplier/rfqs", { params }).then((r) => r.data),
  rfq: (id: number) => api.get<RFQ>(`/api/supplier/rfqs/${id}`).then((r) => r.data),
  /* --- orders, and what the vendor says they have sent against them --- */
  pos: (params: { search?: string; status?: string; page?: number; size?: number } = {}) =>
    api.get<Paginated<VendorPOListRow>>("/api/supplier/pos", { params }).then((r) => r.data),
  /** Goods sent BACK to this supplier. Served by the warehouse module on the portal's
   *  own prefix — see `VendorReturnListRow` for why it is not beside the orders. */
  returns: (params: { search?: string; status?: string; page?: number; size?: number } = {}) =>
    api.get<Paginated<VendorReturnListRow>>("/api/supplier/returns", { params })
      .then((r) => r.data),
  /** One return opened — its lines and where it is being delivered. Scoped on the
   *  vendor in the token, so somebody else's return id is a 404 rather than a leak. */
  return: (id: number) =>
    api.get<VendorReturnDetail>(`/api/supplier/returns/${id}`).then((r) => r.data),
  /* --- the six presses a supplier makes on a return, in the order they make them ---
   *
   * The buyer's desk used to make the first four of these on the supplier's behalf, from
   * a phone call, on goods that had already been shipped. They are the supplier's now
   * (2026-09-12) and the goods do not move until the supplier has approved the return and
   * the warehouse has arranged a vehicle. Every one is answered ONCE and scoped to the
   * vendor in the token — somebody else's return id is a 404, not a leak. */

  /** Approve or reject a return. A rejection must say why; nothing has travelled yet. */
  decideReturn: (id: number, body: VendorReturnDecisionInput) =>
    api.post<VendorReturnDetail>(`/api/supplier/returns/${id}/decide`, body)
      .then((r) => r.data),
  /** Refund or replacement — what the buyer gets back, once the return is approved. */
  settleReturn: (id: number, body: VendorReturnSettlementInput) =>
    api.post<VendorReturnDetail>(`/api/supplier/returns/${id}/settle`, body)
      .then((r) => r.data),
  /** Accept the collection job and name the vehicle. Vendor-arranged transport only. */
  acceptReturnTransport: (id: number, body: VendorTransportInput) =>
    api.post<VendorReturnDetail>(`/api/supplier/returns/${id}/accept-transport`, body)
      .then((r) => r.data),
  /** The vehicle has loaded at the buyer's warehouse and left with the goods. */
  recordReturnPickup: (id: number, body: VendorTransportInput) =>
    api.post<VendorReturnDetail>(`/api/supplier/returns/${id}/pickup`, body)
      .then((r) => r.data),
  /** Sign for the returned goods at the supplier's own dock. Signed once. */
  confirmReturnReceipt: (id: number, body: VendorReturnReceiptInput) =>
    api.post<VendorReturnDetail>(`/api/supplier/returns/${id}/confirm-receipt`, body)
      .then((r) => r.data),
  /** The files a replacement dispatch carries, and what each field asks for — including
   *  which of them are mandatory. Served rather than written into the screen, so the
   *  fields drawn and the rule the save enforces come from one place. */
  replacementDocumentTypes: () =>
    api.get<ReplacementDocumentType[]>("/api/supplier/returns/replacement-documents")
      .then((r) => r.data),
  /** Attach the loading photo or the invoice. One file per slot — a second upload of
   *  the same category REPLACES the first, so a wrong pick can be corrected. Answers
   *  with the whole return, so both slots re-render off one response. */
  uploadReplacementDocument: async (id: number, doc_category: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    form.append("doc_category", doc_category);
    return (await api.post<VendorReturnDetail>(
      `/api/supplier/returns/${id}/replacement-documents`, form)).data;
  },
  deleteReplacementDocument: (id: number, attachmentId: number) =>
    api.delete<VendorReturnDetail>(
      `/api/supplier/returns/${id}/replacement-documents/${attachmentId}`)
      .then((r) => r.data),
  /** Fetched through axios rather than linked to, so the supplier token goes with it —
   *  a bare href carries no Authorization header and would answer 401. */
  replacementDocumentBlob: (id: number, attachmentId: number) =>
    api.get<Blob>(
      `/api/supplier/returns/${id}/replacement-documents/${attachmentId}/download`,
      { responseType: "blob" }).then((r) => r.data),
  /** The replacement dispatch note. Raises the receipt the store books it in against.
   *  REFUSED while a REQUIRED file above is missing — the server checks, not just the
   *  screen. */
  dispatchReplacement: (id: number, body: ReplacementDispatchInput) =>
    api.post<VendorReturnDetail>(`/api/supplier/returns/${id}/dispatch-replacement`, body)
      .then((r) => r.data),
  po: (id: number) => api.get<VendorPO>(`/api/supplier/pos/${id}`).then((r) => r.data),
  revisions: (poId: number) =>
    api.get<PORevision[]>(`/api/supplier/pos/${poId}/revisions`).then((r) => r.data),
  /** Accept the order, or decline it with a reason. Nothing may be despatched against
   *  an order that has not been accepted, and an acceptance carries NO PRICES - see
   *  `POVendorResponseIn` on the server for why a counter-offer is not an answer. */
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
  /** Email this vendor the code they need to submit. Answers with the MASKED address
   *  and the window — never the digits, or the mail would be decorative and anyone
   *  holding the portal link could read the code out of the network tab. */
  requestQuoteOtp: (rfqId: number) =>
    api.post<QuoteOtpSent>(`/api/supplier/rfqs/${rfqId}/quotation/request-otp`)
      .then((r) => r.data),

  priceTrail: (rfqId: number) =>
    api.get<PriceTrailVersion[]>(`/api/supplier/rfqs/${rfqId}/quotation/price-trail`)
      .then((r) => r.data),
  changeRequests: (rfqId: number) =>
    api.get<QuoteChangeRequest[]>(`/api/supplier/rfqs/${rfqId}/quotation/change-requests`)
      .then((r) => r.data),
  acceptChange: (rfqId: number, crId: number, note = "", counterLines?: Record<string, unknown>[], otpCode?: string) =>
    api.post<Quotation>(
      `/api/supplier/rfqs/${rfqId}/quotation/change-requests/${crId}/accept`, { note, counter_lines: counterLines, otp_code: otpCode })
      .then((r) => r.data),
  declineChange: (rfqId: number, crId: number, note = "") =>
    api.post<Quotation>(
      `/api/supplier/rfqs/${rfqId}/quotation/change-requests/${crId}/decline`, { note })
      .then((r) => r.data),
  quoteComments: (rfqId: number) =>
    api.get<QuoteComment[]>(`/api/supplier/rfqs/${rfqId}/quotation/comments`)
      .then((r) => r.data),
  postQuoteComment: (rfqId: number, message: string) =>
    api.post<QuoteComment>(`/api/supplier/rfqs/${rfqId}/quotation/comments`, { message })
      .then((r) => r.data),
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

/* --- the buying trail (2026-08-21) --------------------------------------- */

/** Every procurement document in one register. Scoped and filtered server-side; the
 *  screen sends what the user picked and renders what comes back. */
export const ledgerApi = {
  rows: (params: {
    doc_kind?: string; status?: string; project?: string; vendor?: string;
    date_from?: string; date_to?: string; search?: string;
    page?: number; size?: number;
  } = {}) =>
    api.get<Paginated<ProcurementLedgerRow>>("/api/procurement/ledger", { params })
      .then((r) => r.data),
  /** Filter options come from the DATA, never a hand-written list that drifts. */
  filters: () =>
    api.get<ProcurementLedgerFilters>("/api/procurement/ledger/filters")
      .then((r) => r.data),
  /** One count per document kind, under the same filters the register is showing —
   *  so the four tiles always add up to the total beside the search box. */
  stats: (params: {
    status?: string; project?: string; vendor?: string;
    date_from?: string; date_to?: string; search?: string;
  } = {}, signal?: AbortSignal) =>
    api.get<LedgerStats>("/api/procurement/ledger/stats", { params, signal })
      .then((r) => r.data),
};


/* --- KPI strips (2026-08-23) ---------------------------------------------- *
 *
 * FIVE endpoints, not one. Each is gated on the server on the view code of the
 * documents it counts (`requisition.view`, `consolidation.view`, `rfq.view`,
 * `rfq.compare`, `po.view`) and applies the same data rung as that document's
 * register, so a tile can never count a row the list under it would hide.
 *
 * A composite `/overview` could only carry ONE permission, and would then either fail
 * closed for a buyer holding the others or serve numbers off documents they may not
 * read. The Overview screen asks only for the strips its login holds — see
 * `procurementStatsKeys`, whose queries are `enabled` on `can(...)`.
 * ------------------------------------------------------------------------- */

export const procurementStatsApi = {
  requisitions: (signal?: AbortSignal) =>
    api.get<ReqStats>("/api/requisitions/stats", { signal }).then((r) => r.data),
  consolidations: (signal?: AbortSignal) =>
    api.get<ConsolidationStats>("/api/consolidations/stats", { signal })
      .then((r) => r.data),
  rfqs: (signal?: AbortSignal) =>
    api.get<RFQStats>("/api/rfqs/stats", { signal }).then((r) => r.data),
  quotations: (signal?: AbortSignal) =>
    api.get<QuoteStats>("/api/rfqs/quotations/stats", { signal }).then((r) => r.data),
  pos: (signal?: AbortSignal) =>
    api.get<POStats>("/api/pos/stats", { signal }).then((r) => r.data),
  /** How much of each item is sanctioned and not yet ordered — the question a
   *  consolidated buying sheet exists to answer. Gated on `requisition.view`. */
  demandPool: (params: {
    project_id?: number; search?: string; page?: number; size?: number;
  } = {}, signal?: AbortSignal) =>
    api.get<Paginated<DemandPoolRow>>("/api/requisitions/demand-pool",
                                      { params, signal }).then((r) => r.data),
};

/** Query keys, in one place so a KPI strip and the Overview share one cached answer
 *  instead of each fetching the same numbers. */
export const procurementStatsKeys = {
  requisitions: () => ["procurement", "stats", "requisitions"] as const,
  consolidations: () => ["procurement", "stats", "consolidations"] as const,
  rfqs: () => ["procurement", "stats", "rfqs"] as const,
  quotations: () => ["procurement", "stats", "quotations"] as const,
  pos: () => ["procurement", "stats", "pos"] as const,
  demandPool: (params: Record<string, unknown> = {}) =>
    ["procurement", "stats", "demand-pool", params] as const,
};

/** KPIs are a summary, not a document: a few seconds of staleness is invisible, and
 *  refetching five endpoints on every tab focus is not. */
export const STATS_STALE_TIME = 30_000;

// --------------------------------------------------------------------------- //
//  The supplier register
// --------------------------------------------------------------------------- //
const SUPPLIERS = "/api/suppliers";

/** The material mirror of `logisticsVendorApi` — the INTERNAL desk that maintains the
 *  supplier register and their logins. Named `supplierRegisterApi` because
 *  `supplierApi` above is the vendor's OWN browser calling the portal with a supplier
 *  token; these two speak to opposite ends of the same account. */
export const supplierRegisterApi = {
  /** Served, not a constant here — the register filters on the same list. */
  types: () => api.get<SupplierType[]>(`${SUPPLIERS}/types`).then((r) => r.data),
  summary: () =>
    api.get<SupplierSummary>(`${SUPPLIERS}/summary`).then((r) => r.data),
  list: (params: {
    search?: string; vendor_type?: string; active_only?: boolean;
    page?: number; size?: number;
  } = {}) =>
    api.get<Paginated<Supplier>>(SUPPLIERS, { params }).then((r) => r.data),
  create: (data: SupplierInput) =>
    api.post<Supplier>(SUPPLIERS, data).then((r) => r.data),
  update: (id: number, data: Partial<SupplierInput> & {
    is_active?: boolean; is_blacklisted?: boolean;
  }) => api.put<Supplier>(`${SUPPLIERS}/${id}`, data).then((r) => r.data),
  deactivate: (id: number) =>
    api.delete<Supplier>(`${SUPPLIERS}/${id}`).then((r) => r.data),

  /** Their way in. The same `pro_vendor_users` account, the same default password and
   *  the same /supplier portal a carrier uses — there is one kind of vendor login. */
  issueLogin: (id: number, username?: string) =>
    api.post<Supplier>(`${SUPPLIERS}/${id}/login`,
      { username: username || null }).then((r) => r.data),
  resetLogin: (id: number) =>
    api.post<Supplier>(`${SUPPLIERS}/${id}/login/reset`).then((r) => r.data),
  setLoginActive: (id: number, active: boolean) =>
    api.post<Supplier>(
      `${SUPPLIERS}/${id}/login/${active ? "enable" : "disable"}`).then((r) => r.data),
};


// --------------------------------------------------------------------------- //
//  Procurement Demand Pool  (2026-09-25)
// --------------------------------------------------------------------------- //

import type { DemandPoolResponse, DemandPoolStage } from './types';

/** Stage metadata served by the backend � stage codes, labels, tones, deep links.
 *  Never hardcoded in the screen: the backend is the single source of truth. */
export const procurementDemandPoolApi = {
  stages: (signal?: AbortSignal) =>
    api.get<DemandPoolStage[]>('/api/procurement/demand-pool/stages', { signal })
      .then((r) => r.data),

  pool: (params: {
    search?: string;
    item_id?: number;
    warehouse_id?: number;
    project_id?: number;
    stage?: string;
    page?: number;
    size?: number;
  } = {}, signal?: AbortSignal) =>
    api.get<DemandPoolResponse>('/api/procurement/demand-pool', { params, signal })
      .then((r) => r.data),
};

export const procurementDemandPoolKeys = {
  stages: () => ['procurement', 'demand-pool', 'stages'] as const,
  pool: (params: Record<string, unknown> = {}) =>
    ['procurement', 'demand-pool', params] as const,
};
