export interface POItem {
  id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  quantity: number;
  rate: number;
  tax_percent: number;
  amount: number;
  /** Days the vendor quoted for THIS line, carried off the winning quotation. Null on
   *  a PO raised from an indent — nobody quoted, so nobody promised. */
  delivery_days?: number | null;
  received_quantity: number;
}

export interface PurchaseOrder {
  id: number;
  po_no: string;
  po_date?: string | null;
  expected_date?: string | null;
  indent_id?: number | null;
  indent_no?: string | null;
  // The buying chain behind this order. Present only when it was raised from an
  // awarded quotation; a PO raised straight off an indent carries none of them.
  requisition_id?: number | null;
  requisition_no?: string | null;
  rfq_id?: number | null;
  rfq_no?: string | null;
  quotation_id?: number | null;
  quotation_no?: string | null;
  vendor_id: number;
  vendor_name?: string | null;
  facility_id?: number | null;
  facility_name?: string | null;
  project_id?: number | null;
  project_name?: string | null;
  status: string;
  sub_total: number;
  discount_amount: number;
  tax_amount: number;
  freight_amount: number;
  total_amount: number;
  remarks?: string | null;
  payment_terms?: string | null;
  delivery_terms?: string | null;
  material_terms?: string | null;
  logistics_terms?: string | null;
  billing_address?: string | null;
  shipping_address?: string | null;
  current_approver_name?: string | null;
  /** Who the approval engine is waiting on RIGHT NOW, read live by the server.
   *  Prefer this over `current_approver_name`, which is a snapshot taken at submit
   *  and goes stale when a ladder is edited or a delegation is added. */
  pending_with?: string[];
  /** Can this login sign it right now — on the current stage's pending list AND
   *  wearing a position the ladder named. Served by the backend because a screen can
   *  only see the status and its own permissions, and neither answers "is it with me". */
  awaiting_me?: boolean;
  /** What the vendor said about the order we sent them. Null means never sent. */
  vendor_status?: string | null;
  vendor_responded_at?: string | null;
  vendor_response_note?: string | null;
  /** Server-calculated: accepted and not yet despatched. */
  amendment_allowed?: boolean;
  /** 0 is the original order; every amendment adds one. */
  revision_no: number;
  amended_at?: string | null;
  amendment_reason?: string | null;
  created_at: string;
  items: POItem[];
}

/** One version this order used to be, filed away before an amendment changed it. */
export interface PORevision {
  id: number;
  revision_no: number;
  reason?: string | null;
  status?: string | null;
  vendor_status?: string | null;
  snapshot?: Record<string, unknown> | null;
  changed_by_name?: string | null;
  created_at: string;
}

/** A revision of an order that has already gone out. `reason` is required, and
 *  sending `lines` replaces the whole line list. */
export interface POAmend extends POHeader {
  reason: string;
  expected_date?: string | null;
  lines?: {
    id?: number | null;
    item_id: number;
    quantity: number;
    rate: number;
    tax_percent?: number;
  }[] | null;
}

export interface POComment {
  id: number;
  po_id: number;
  author_id?: number | null;
  author_name?: string | null;
  message: string;
  created_at: string;
}

export interface POApprovalQtyLine {
  id: number;
  quantity: number;
}

export interface POListRow {
  id: number;
  po_no: string;
  vendor_name?: string | null;
  indent_no?: string | null;
  status: string;
  /** Two orders can both read SENT_TO_VENDOR while only one has been agreed. */
  vendor_status?: string | null;
  revision_no?: number;
  total_amount: number;
  /** Who the approval engine is waiting on RIGHT NOW, read live by the server.
   *  Prefer this over `current_approver_name`, which is a snapshot taken at submit
   *  and goes stale when a ladder is edited or a delegation is added. */
  pending_with?: string[];
  /** Can this login sign it right now — on the current stage's pending list AND
   *  wearing a position the ladder named. Served by the backend because a screen can
   *  only see the status and its own permissions, and neither answers "is it with me". */
  awaiting_me?: boolean;
  created_at: string;
}

/** The header a purchase order carries beyond its lines — the same on every way of
 *  raising one, so a term agreed with a vendor prints the same whichever route the
 *  order came in by. Discount and freight are document money, never per line. */
export interface POHeader {
  project_id?: number | null;
  remarks?: string | null;
  payment_terms?: string | null;
  delivery_terms?: string | null;
  material_terms?: string | null;
  logistics_terms?: string | null;
  billing_address?: string | null;
  shipping_address?: string | null;
  discount_amount?: number;
  freight_amount?: number;
}

export interface POCreate extends POHeader {
  vendor_id: number;
  expected_date?: string | null;
  lines: {
    item_id: number;
    indent_item_id?: number | null;
    quantity: number;
    rate: number;
    tax_percent?: number;
  }[];
}

/** Everything the awarded quotation does not already say. Vendor, lines, rates and
 *  tax all come from the offer being accepted, so none of them are sent. */
export interface POFromQuotation extends POHeader {
  expected_date?: string | null;
}

/* ------------------------------------------------------------------ Requisition */

export interface ReqItem {
  id: number;
  line_no: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  quantity: number;
  ordered_qty: number;
  estimated_rate: number;
  estimated_amount: number;
  required_date?: string | null;
  indent_id?: number | null;
  indent_no?: string | null;
}

export interface ReqListRow {
  id: number;
  req_no: string;
  req_date?: string | null;
  warehouse_name?: string | null;
  project_name?: string | null;
  status: string;
  priority?: string | null;
  total_items: number;
  estimated_value: number;
  current_approver_name?: string | null;
  /** Who the approval engine is waiting on RIGHT NOW, read live by the server.
   *  Prefer this over `current_approver_name`, which is a snapshot taken at submit
   *  and goes stale when a ladder is edited or a delegation is added. */
  pending_with?: string[];
  /** Can this login sign it right now — on the current stage's pending list AND
   *  wearing a position the ladder named. Served by the backend because a screen can
   *  only see the status and its own permissions, and neither answers "is it with me". */
  awaiting_me?: boolean;
  created_by_name?: string | null;
  created_at: string;
}

// --------------------------------------------------------------------------- //
//  Consolidated buying sheet
// --------------------------------------------------------------------------- //

export interface ConsolidationItem {
  id: number;
  line_no: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  /** What the requisitions asked for, summed. */
  quantity: number;
  /** What the buyer decided to tender. Between 0 and `max_allowed_qty`. */
  approved_qty: number;
  estimated_rate: number;
  estimated_amount: number;
  required_date?: string | null;
  /** "REQ/2026-27/00012 x 40; REQ/2026-27/00019 x 25" */
  sources?: string | null;
  source_count: number;
  remarks?: string | null;
  /** Buying ceiling served by the backend: requested + replenishment top-up
   *  (max − available) at the shipment warehouses that asked for the line.
   *  Equals `quantity` where no replenishment rule exists — increase blocked. */
  max_allowed_qty?: number | null;
  /** The top-up above `quantity` included in the ceiling. 0 = decrease-only. */
  replenishment_qty?: number | null;
  /** Shipment point(s) the top-up was read at. */
  replenishment_at?: string | null;
}

export interface ConsolidationSource {
  id: number;
  requisition_id: number;
  requisition_no?: string | null;
  project_name?: string | null;
  item_count: number;
  estimated_value: number;
}

export interface ConsolidationListRow {
  id: number;
  cons_no: string;
  cons_date?: string | null;
  title?: string | null;
  period_label?: string | null;
  project_name?: string | null;
  status: string;
  total_items: number;
  source_count: number;
  estimated_value: number;
  current_approver_name?: string | null;
  /** Who the approval engine is waiting on RIGHT NOW, read live by the server.
   *  On a consolidation this is the ONLY working source: `current_approver_name` is
   *  never written on this document, only cleared, so the column read blank forever. */
  pending_with?: string[];
  /** Can this login sign it right now — on the current stage's pending list AND
   *  wearing a position the ladder named. Served by the backend because a screen can
   *  only see the status and its own permissions, and neither answers "is it with me". */
  awaiting_me?: boolean;
  created_by_name?: string | null;
  created_at: string;
}

export interface Consolidation extends ConsolidationListRow {
  project_id?: number | null;
  warehouse_id?: number | null;
  warehouse_name?: string | null;
  approved_by_name?: string | null;
  approved_at?: string | null;
  remarks?: string | null;
  has_rfq?: boolean;
  items: ConsolidationItem[];
}

export interface ConsolidationCreate {
  requisition_ids: number[];
  title?: string | null;
  period_label?: string | null;
  cons_date?: string | null;
  project_id?: number | null;
  warehouse_id?: number | null;
  remarks?: string | null;
}

export interface EvaluationMethodOption {
  value: string;
  label: string;
  help: string;
  is_default: boolean;
}

export interface Requisition extends ReqListRow {
  warehouse_id?: number | null;
  project_id?: number | null;
  remarks?: string | null;
  approved_by_name?: string | null;
  approved_at?: string | null;
  source_mr_id?: number | null;
  source_mr_no?: string | null;
  has_consolidation?: boolean;
  has_rfq?: boolean;
  /** Read at request time off HCM (the raiser's department) and settings (the
   *  company). Neither is a column on `pro_requisitions` and neither is editable. */
  department_id?: number | null;
  department_name?: string | null;
  company_name?: string | null;
  /** One "needed by" for the whole document. A line may still carry its own. */
  required_date?: string | null;
  /** The indents behind the lines, deduplicated — empty on a cold requisition. */
  source_indent_nos?: string[];
  /** Every material request folded in, not just the first. */
  source_mr_nos?: string[];
  items: ReqItem[];
}

/** An approved material request no requisition has claimed yet. */
export interface MRCandidate {
  id: number;
  mr_no: string;
  indent_id?: number | null;
  indent_no?: string | null;
  project_id?: number | null;
  project_name?: string | null;
  status: string;
  created_at: string;
}

export interface ReqFromMRs {
  mr_ids: number[];
  warehouse_id?: number | null;
  project_id?: number | null;
  department_id?: number | null;
  company_name?: string | null;
  required_date?: string | null;
  priority?: string | null;
  remarks?: string | null;
}

export interface ReqCreate {
  warehouse_id?: number | null;
  project_id?: number | null;
  department_id?: number | null;
  company_name?: string | null;
  required_date?: string | null;
  priority?: string | null;
  remarks?: string | null;
  lines: {
    item_id: number;
    quantity: number;
    uom_code?: string | null;
    estimated_rate?: number;
    required_date?: string | null;
    indent_id?: number | null;
    indent_item_id?: number | null;
  }[];
}

/* -------------------------------------------------------------------------- RFQ */

export interface RFQItem {
  id: number;
  line_no: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  description?: string | null;
  uom_code?: string | null;
  quantity: number;
  required_date?: string | null;
}

/** No `access_token`: it is a bearer credential and never leaves the invites call. */
export interface RFQVendor {
  id: number;
  vendor_id: number;
  vendor_name?: string | null;
  vendor_email?: string | null;
  status?: string | null;
  sent_at?: string | null;
  responded_at?: string | null;
  mapped_item_ids?: number[] | null;
  item_quantities?: Record<string, number> | null;
  /** What this supplier won, item id -> quantity. Null on a whole-quote award. */
  awarded_quantities?: Record<string, number> | null;
  /** Quantity currently covered by this supplier's live PO lines. This is derived
   * server-side, so rejected/cancelled orders disappear from the allocation. */
  live_allocated_quantities?: Record<string, number> | null;
}

export interface RFQListRow {
  id: number;
  rfq_no: string;
  title: string | null;
  rfq_date: string | null;
  due_date: string | null;
  status: string;
  vendor_status?: string | null;
  total_items: number;
  vendor_count: number;
  response_count: number;
  awarded_vendor_name?: string | null;
  current_approver_name?: string | null;
  /** Who the approval engine is waiting on RIGHT NOW, read live by the server.
   *  Prefer this over `current_approver_name`, which is a snapshot taken at submit
   *  and goes stale when a ladder is edited or a delegation is added. */
  pending_with?: string[];
  /** Can this login sign it right now — on the current stage's pending list AND
   *  wearing a position the ladder named. Served by the backend because a screen can
   *  only see the status and its own permissions, and neither answers "is it with me". */
  awaiting_me?: boolean;
  /** Freeze Prices (2026-09-26): the tender is closed to pricing. Suppliers can no
   *  longer quote or change prices; POs can be raised against its quotations. */
  is_price_frozen?: boolean;
  /** True when the buyer has sent a change request on this supplier's quotation that is awaiting answer. */
  has_pending_change_request?: boolean;
  created_at: string;
}

export interface RFQ extends RFQListRow {
  requisition_id?: number | null;
  requisition_no?: string | null;
  /** Set when the RFQ is buying against a consolidated sheet rather than one
   * requisition. Backward pointer, like every other link in the chain. */
  consolidation_id?: number | null;
  consolidation_no?: string | null;
  /** How the quotes are ranked. Null means the backend default. */
  evaluation_method?: string | null;
  warehouse_id?: number | null;
  warehouse_name?: string | null;
  project_id?: number | null;
  project_name?: string | null;
  terms?: string | null;
  awarded_vendor_id?: number | null;
  created_by_name?: string | null;
  /** The purchase order this award already became. Read off the PO's backward
   *  pointer, so it is never stale — and it is what tells the screen to stop
   *  offering "Create purchase order" for an order that exists. */
  po_id?: number | null;
  po_no?: string | null;
  po_status?: string | null;
  purchase_orders?: {
    id: number;
    po_no: string;
    status: string;
    quotation_id?: number | null;
    vendor_id?: number | null;
    vendor_name?: string | null;
    /** Saved quantities on this particular earlier PO, keyed by RFQ item id. */
    item_quantities?: Record<string, number>;
  }[];
  /** Carried across from the requisition behind it, so a tender reads on its own. */
  department_id?: number | null;
  department_name?: string | null;
  company_name?: string | null;
  priority?: string | null;
  requisition_status?: string | null;
  source_indent_nos?: string[];
  /** Freeze Prices detail: when the door was closed, by whom, and how many
   *  quotations were in at the time. All null on an open tender. */
  frozen_at?: string | null;
  frozen_by_name?: string | null;
  frozen_at_revision?: number | null;
  items: RFQItem[];
  vendors: RFQVendor[];
}

export interface RFQCreate {
  title?: string | null;
  requisition_id?: number | null;
  consolidation_id?: number | null;
  evaluation_method?: string | null;
  warehouse_id?: number | null;
  project_id?: number | null;
  /** Typed only on an RFQ raised cold — a requisition's own values win otherwise. */
  department_id?: number | null;
  company_name?: string | null;
  due_date?: string | null;
  terms?: string | null;
  vendor_ids: number[];
  vendor_allocations?: {
    item_id: number;
    vendor_id: number;
    quantity: number;
  }[];
  lines: {
    item_id: number;
    quantity: number;
    uom_code?: string | null;
    description?: string | null;
    required_date?: string | null;
  }[];
}

export type RFQUpdate = Partial<Omit<RFQCreate, "requisition_id" | "vendor_ids" | "lines">> & {
  vendor_ids?: number[];
  vendor_allocations?: RFQCreate["vendor_allocations"];
  lines?: RFQCreate["lines"];
};

export interface RFQInvite {
  vendor_id: number;
  vendor_name?: string | null;
  vendor_email?: string | null;
  invite_path: string;
}

/* -------------------------------------------------------------------- Quotation */

export interface QuoteItem {
  id: number;
  line_no: number;
  rfq_item_id?: number | null;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  quantity: number;
  rate: number;
  discount_percent: number;
  /** The one GST rate the vendor quoted. Which half of it applies is decided by the
   *  two GSTINs, so the offer states a single figure. */
  tax_percent: number;
  amount: number;
  delivery_days?: number | null;
  /** The item's HSN and the rate it notifies — the ceiling this line may quote up to.
   *  Null means the item has no HSN, so no ceiling applies. */
  hsn_code?: string | null;
  max_gst_rate?: number | null;
  /** What the RFQ line asked for, and when it is wanted. `quantity` above is the
   *  vendor's ANSWER and may be short of it. */
  requested_quantity?: number | null;
  required_date?: string | null;
}

export interface QuoteListRow {
  id: number;
  quotation_no: string;
  rfq_id: number;
  rfq_no?: string | null;
  vendor_id: number;
  vendor_name?: string | null;
  status: string;
  grand_total: number;
  rank_position?: number | null;
  /** Higher is better under every method, so a reader never has to know which one
   * produced the ranking. Null on a quote the scorer could not place. */
  evaluation_score?: number | null;
  revision_count: number;
  /** The negotiation overlay: amber "Under negotiation" badge while the buyer's
   *  change request sits with the supplier. */
  under_negotiation?: boolean;
  /** How many change requests the supplier has ACCEPTED — "v2 pricing" as a
   *  number, not archaeology. */
  accepted_revision?: number;
  submitted_at?: string | null;
  created_at: string;
}

export interface Quotation extends QuoteListRow {
  vendor_ref_no?: string | null;
  quotation_date?: string | null;
  valid_till?: string | null;
  expected_delivery_date?: string | null;
  currency?: string | null;
  sub_total: number;
  discount_amount: number;
  tax_amount: number;
  freight_amount: number;
  payment_terms?: string | null;
  delivery_days?: number | null;
  remarks?: string | null;
  /** "INTRA" (CGST+SGST) or "INTER" (IGST), decided by the two GSTINs' state codes. */
  tax_region?: string | null;
  company_gstin?: string | null;
  vendor_gstin?: string | null;
  items: QuoteItem[];
}

/** One line of the buyer's change request, WITH the "before" figures read off the
 *  snapshot — the diff is served, never recomputed in the screen. */
export interface QuoteChangeLine {
  quotation_item_id: number;
  item_id?: number | null;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  current_quantity: number;
  current_rate: number;
  current_discount_percent: number;
  current_amount?: number;
  proposed_quantity: number;
  proposed_rate: number;
  proposed_discount_percent: number;
  note?: string | null;
}

/** A Change Request: the buyer's ask on a supplier's quotation. Status words the
 *  desk reads: Awaiting supplier / Accepted / Declined / Withdrawn / Superseded. */
export interface QuoteChangeRequest {
  id: number;
  quotation_id: number;
  rfq_id: number;
  cr_no: string;
  status: "AWAITING_SUPPLIER" | "ACCEPTED" | "DECLINED" | "WITHDRAWN" | "SUPERSEDED" | string;
  reason: string;
  proposed_by_name?: string | null;
  supplier_decision_note?: string | null;
  supplier_decided_at?: string | null;
  created_at: string;
  lines: QuoteChangeLine[];
  supplier_counter_lines?: Record<string, unknown>[] | null;
}

/** One version of a quotation, off the Price Trail. `source` says how this
 *  version came to be; totals are null except on the newest version. */
export interface PriceTrailVersion {
  version: number;
  source: "ORIGINAL" | "REQUOTE" | "CHANGE_REQUEST" | string;
  effective_at: string | null;
  changed_by?: string | null;
  totals: {
    sub_total: number | null;
    tax_amount: number | null;
    freight_amount: number | null;
    discount_amount: number | null;
    grand_total: number | null;
  };
  lines: Record<string, unknown>[];
  buyer_requested_lines?: Record<string, unknown>[];
  buyer_requested_totals?: {
    sub_total: number | null;
    tax_amount: number | null;
    freight_amount: number | null;
    discount_amount: number | null;
    grand_total: number | null;
  };
  cr_no?: string | null;
  reason?: string | null;
  note?: string | null;
}

/** The quotation chat. One thread per quotation — which is one supplier on one
 *  RFQ — so two suppliers' negotiations can never mix. */
export interface QuoteComment {
  id: number;
  quotation_id: number;
  author_id?: number | null;
  author_name?: string | null;
  /** "BUYER" or "SUPPLIER" — written at post time, so the bubble tint is never guessed. */
  author_side: string;
  message: string;
  created_at: string;
}

/** What the vendor's screen learns when a code is sent: which address it went to,
 *  masked, and how long it lives. Never the digits. */
export interface QuoteOtpSent {
  sent_to: string;
  expires_in_seconds: number;
}

export interface QuoteSubmit {
  /** The six digits emailed to the vendor. The server refuses the submission without
   *  a live, unused, matching one — the field is optional here only so the refusal is
   *  a sentence the vendor can read rather than a 422 about a missing field. */
  otp_code?: string | null;
  vendor_ref_no?: string | null;
  valid_till?: string | null;
  expected_delivery_date?: string | null;
  payment_terms?: string | null;
  delivery_days?: number | null;
  freight_amount?: number;
  discount_amount?: number;
  remarks?: string | null;
  lines: {
    rfq_item_id: number;
    /** What the vendor can supply. Omit to accept the quantity asked for; never more. */
    quantity?: number | null;
    rate: number;
    discount_percent?: number;
    /** The vendor's whole GST rate. */
    tax_percent?: number;
    delivery_days?: number | null;
  }[];
}

/** One vendor's offer on one RFQ line, split the way a buyer reads it. The backend
 *  computes it from the same lines the ranking read — never re-derive it here. */
export interface ComparisonCell {
  quotation_id: number;
  vendor_id: number;
  vendor_name?: string | null;
  quantity: number;
  rate: number;
  discount_percent: number;
  discount_amount: number;
  taxable_amount: number;
  tax_percent: number;
  tax_amount: number;
  line_total: number;
  delivery_days?: number | null;
  /** Cheapest landed total on this row. A label, not a rule. */
  is_best: boolean;
}

export interface ComparisonRow {
  rfq_item_id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  quantity: number;
  required_date?: string | null;
  best_quotation_id?: number | null;
  cells: ComparisonCell[];
}

/** A column footer: what this vendor's whole offer comes to. */
export interface ComparisonTotal {
  quotation_id: number;
  quotation_no: string;
  vendor_id: number;
  vendor_name?: string | null;
  status: string;
  rank_position?: number | null;
  evaluation_score?: number | null;
  sub_total: number;
  discount_amount: number;
  tax_amount: number;
  freight_amount: number;
  grand_total: number;
  expected_delivery_date?: string | null;
  delivery_days?: number | null;
  payment_terms?: string | null;
  valid_till?: string | null;
  submitted_at?: string | null;
  revision_count: number;
  /** How many lines this vendor is cheapest on — not always the cheapest overall. */
  best_line_count: number;
  /** Top of the ranking under the method in force. A suggestion; any column may win. */
  is_recommended: boolean;
}

export interface Comparison {
  rfq: RFQ;
  /** Already ordered by rank under `evaluation_method` — never re-sort in the screen,
   * or the winner shown stops matching the one the award check accepts. */
  quotations: QuoteListRow[];
  /** The sheet: one row per RFQ line, one cell per vendor who quoted it. */
  items: ComparisonRow[];
  /** The column footers, in the same order as `quotations`. */
  totals: ComparisonTotal[];
  evaluation_method: string;
  responded: number;
  recommended_quotation_id?: number | null;
  /** Three quotes is the standard (doc B8). False is a warning, not a block. */
  meets_three_quote_norm: boolean;
}

/* -------------------------------------------------------------- Supplier portal */

export interface VendorAccount {
  vendor_id: number;
  username: string;
  is_active: boolean;
  must_change_password: boolean;
  last_login_at?: string | null;
}

export interface VendorToken {
  access_token: string;
  token_type: string;
  vendor_id: number;
  vendor_name?: string | null;
  must_change_password: boolean;
}

export interface VendorProfile {
  id: number;
  code?: string | null;
  name: string;
  contact_person?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  state?: string | null;
  gstin?: string | null;
}

/* ------------------------------------------------------- Vendor despatch note */

/** One line the vendor says is on the vehicle. Keyed to the ORDER line, never to a
 *  free item choice — a despatch note answers a purchase order. */
export interface DespatchItem {
  id: number;
  line_no: number;
  po_item_id?: number | null;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  despatched_qty: number;
  batch_no?: string | null;
  mfg_date?: string | null;
  expiry_date?: string | null;
  remarks?: string | null;
}

export interface DespatchNote {
  id: number;
  dn_no: string;
  dn_date?: string | null;
  po_id: number;
  po_no?: string | null;
  vendor_id: number;
  vendor_name?: string | null;
  invoice_no?: string | null;
  invoice_date?: string | null;
  invoice_amount?: number | null;
  eway_bill_no?: string | null;
  vehicle_no?: string | null;
  transporter_name?: string | null;
  lr_no?: string | null;
  expected_date?: string | null;
  status: string;
  remarks?: string | null;
  submitted_at?: string | null;
  created_at: string;
  items: DespatchItem[];
}

export interface DespatchLineWrite {
  po_item_id: number;
  despatched_qty: number;
  batch_no?: string | null;
  mfg_date?: string | null;
  expiry_date?: string | null;
  remarks?: string | null;
}

export interface DespatchNoteWrite {
  dn_date?: string | null;
  invoice_no?: string | null;
  invoice_date?: string | null;
  invoice_amount?: number | null;
  eway_bill_no?: string | null;
  vehicle_no?: string | null;
  transporter_name?: string | null;
  lr_no?: string | null;
  expected_date?: string | null;
  remarks?: string | null;
  lines: DespatchLineWrite[];
}

/** A PO line as the vendor sees it. `pending_qty` is what is still owed, so a second
 *  delivery opens with the remainder rather than the whole order. */
export interface VendorPOLine {
  po_item_id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  ordered_qty: number;
  despatched_qty: number;
  pending_qty: number;
  rate?: number | null;
  amount?: number | null;
}

export interface VendorPO {
  id: number;
  po_no: string;
  po_date?: string | null;
  expected_date?: string | null;
  status: string;
  total_amount: number;
  remarks?: string | null;
  /** PENDING until the vendor answers, then ACCEPTED or REJECTED. Nothing may be
   *  despatched against an order still waiting for an answer. */
  vendor_status?: string | null;
  vendor_responded_at?: string | null;
  vendor_response_note?: string | null;
  revision_no?: number;
  amendment_reason?: string | null;
  /** The order was issued to this vendor once and has since been amended, so it
   *  is back with the buyer being re-approved. Read-only to them until it is
   *  re-issued — see `_vendor_visible` in procurement/service.py. */
  under_revision?: boolean;
  payment_terms?: string | null;
  delivery_terms?: string | null;
  material_terms?: string | null;
  logistics_terms?: string | null;
  billing_address?: string | null;
  shipping_address?: string | null;
  lines: VendorPOLine[];
  despatch_notes: DespatchNote[];
}

export interface VendorPOListRow {
  id: number;
  po_no: string;
  vendor_status?: string | null;
  revision_no?: number;
  po_date?: string | null;
  expected_date?: string | null;
  status: string;
  total_amount: number;
  despatch_note_count: number;
  under_revision?: boolean;
}

/** One purchase return, as the SUPPLIER sees it — goods on their way back.
 *
 * Served from `/api/supplier/returns`, which lives in the WAREHOUSE module rather
 * than beside the rest of the portal: it reads `pro_returns`, and procurement may
 * not import a later module (rule 5). The portal path is what matters here — it is
 * what makes the browser send the vendor token.
 *
 * The logistics fields are all null on a return that was entered by hand, because
 * that raises no consignment at all. The screen must not read them as "not yet
 * despatched". */
export interface VendorReturnListRow {
  id: number;
  return_no: string;
  return_date?: string | null;
  po_no?: string | null;
  grn_no?: string | null;
  reason_code?: string | null;
  reason_label?: string | null;
  remarks?: string | null;
  total_items: number;
  total_qty: number;
  total_value: number;
  status: string;
  sent_at?: string | null;
  dispatch_no?: string | null;
  transport_mode?: string | null;
  transport_mode_label?: string | null;
  carrier_name?: string | null;
  vehicle_number?: string | null;
  driver_name?: string | null;
  lr_no?: string | null;
  eway_bill_no?: string | null;
  total_packages?: number | null;
  expected_delivery?: string | null;
  acknowledged_by_name?: string | null;
  acknowledged_at?: string | null;

  /** The supplier's own two acts, added 2026-09-11. Both are null until they answer,
   *  which is the state every return raised before then is permanently in — so a screen
   *  must read "not yet" from null and never from a missing field. */
  vendor_receipt_confirmed_at?: string | null;
  vendor_receipt_by_name?: string | null;
  vendor_receipt_vehicle_no?: string | null;
  vendor_receipt_remarks?: string | null;
  /** REFUNDED | REPLACED | RETURNED, or legacy ACCEPTED. Null while unanswered. */
  vendor_response?: VendorReturnResponse | null;
  /** Already worded by the server — never map this in the screen, for the same reason
   *  `reason_label` and `transport_mode_label` are served. */
  vendor_response_label?: string | null;
  vendor_response_at?: string | null;
  vendor_response_note?: string | null;
  /** What the supplier is crediting, on a REFUNDED answer only. Null on every other
   *  answer — including legacy ACCEPTED, where no figure was ever captured — so read
   *  "is there an amount" from this and never "is this settled in money". */
  vendor_refund_amount?: number | null;
  /** The refund set beside the value returned, worded by the server because a short
   *  credit is the normal case and the document has to say so rather than leaving the
   *  reader to subtract. Null when there is no refund. */
  vendor_refund_label?: string | null;
  /** The inbound receipt the answer raised. Null for a refund, which raises none. */
  vendor_followup_receipt_no?: string | null;
}

/** The supplier's possible answers.
 *
 * RETURNED means the SUPPLIER is sending our goods back to us — the opposite direction
 * to what "return" means everywhere else in this codebase, which is why the labels the
 * server serves spell the direction out.
 *
 * Two questions in one value: does the supplier keep the goods, and if so what do we get
 * instead. RETURNED is the refusal; REFUNDED and REPLACED are the two ways of keeping
 * them. ACCEPTED is LEGACY (pre 2026-09-11) and is never sent by this portal any more —
 * it said the goods were kept without saying what came back for them. It stays in the
 * union because rows carry it and the screen must still render those. */
export type VendorReturnResponse =
  | "REFUNDED"
  | "REPLACED"
  | "RETURNED"
  | "ACCEPTED";

/** One line of a return, as the supplier sees it. Narrower than our own read: the
 *  source line ids and the returnable-quantity arithmetic behind them are internal. */
export interface VendorReturnItemRow {
  line_no: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  batch_no?: string | null;
  quantity: number;
  rate?: number | null;
  amount?: number | null;
  /** Already worded by the server, and falls back to the document's reason where the
   *  line carries none — never compose this in the screen. */
  reason_label?: string | null;

  /** WHAT A REPLACEMENT OF THIS LINE HAS TO STATE, off the item master — the same two
   *  rules the store's receiving desk will enforce when it submits the GRN. Served so
   *  the form marks exactly the boxes that matter, instead of showing three on every
   *  line and letting the supplier discover from a refusal which one counted. */
  needs_batch?: boolean;
  needs_expiry?: boolean;
  /** What to call that date: "Expiry" on a consumable, "Warranty end" on an asset. One
   *  column, and the item master picks the word. */
  life_label?: string;

  /** WHAT WE ORIGINALLY RECEIVED on this line, read off the GRN it came in on.
   *
   *  Reference and one-press fill, never a silent prefill: the replacement is different
   *  physical stock and usually carries a different batch and a later expiry, so a box
   *  filled in for the supplier is a box confirmed without reading. Null on a manual
   *  return, which has no purchase behind it. */
  original_batch_no?: string | null;
  original_mfg_date?: string | null;
  original_expiry_date?: string | null;
}

/** One return OPENED, from `/api/supplier/returns/{id}`.
 *
 * The list row plus what a row cannot carry: the lines, and the delivery point. The
 * delivery fields come off the same consignment the logistics fields do, so they are
 * null on a return entered by hand for exactly the same reason. */
export interface VendorReturnDetail extends VendorReturnListRow, VendorReturnRungs {
  items: VendorReturnItemRow[];
  delivery_address?: string | null;
  contact_person?: string | null;
  contact_phone?: string | null;
  total_weight_kg?: number | null;

  /** THE TWO PARTIES, for the acknowledgement receipt — a receipt that names only one
   *  side is not a receipt. `warehouse_name` is ours (handing over); the `vendor_*`
   *  fields are the supplier's own, shown back to them. Detail-only: a list row would
   *  repeat the same supplier on every line. */
  warehouse_name?: string | null;
  vendor_name?: string | null;
  vendor_code?: string | null;
  vendor_gstin?: string | null;
  vendor_address?: string | null;
  vendor_contact_person?: string | null;
  vendor_phone?: string | null;

  /** HOW THE REPLACEMENT IS TRAVELLING, read back off the draft inbound receipt the
   *  answer raised rather than stored on the return — so this page and the store's
   *  receiving screen can never disagree about one lorry. Detail-only: a second query.
   *
   *  Null unless the answer was REPLACED. A RETURNED consignment raises a receipt too,
   *  but that lorry is OURS and its facts are on the logistics leg, not here.
   *
   *  `replacement_mode` is the field to branch on. The two dates are each meaningful on
   *  one leg only: `expected_date` is an arrival at OUR gate (delivery), `ready_date` is
   *  goods ready on THEIR dock (collection) and must never be shown as an arrival. */
  replacement_mode?: InboundTransportMode | null;
  replacement_expected_date?: string | null;
  replacement_ready_date?: string | null;
  replacement_pickup_address?: string | null;

  /** The loading image and the invoice, whichever are on file so far. The dispatch waits
   *  only for the ones whose served type says `required` — today the image — and the
   *  server checks these same rows, so the screen can disable its press off this list
   *  without the two rules being able to drift apart. */
  replacement_documents?: ReplacementDocumentRow[];
  /** The whole leg as one sentence, worded by the server so every screen says it the
   *  same way — an arrival with its carrier, or a collection with its ready date and
   *  address. */
  replacement_label?: string | null;
}

/** THE RUNGS THE SUPPLIER THEMSELVES ANSWER, served on their own copy of the return.
 *
 *  Added 2026-09-12, when Approve/Reject and Refund/Replacement stopped being the buyer
 *  desk's presses and became the supplier's. Their portal has to be able to say which
 *  rung the document is standing on and what they already answered — a screen that could
 *  only see `vendor_response` could not tell "not yet approved" from "approved, awaiting
 *  a settlement". */
export interface VendorReturnRungs {
  /** The stored status as a sentence. A supplier reading "REPLACEMENT_AGREED" is reading
   *  the buyer's database. */
  status_label?: string | null;
  /** THE QC that condemned the goods — the evidence being claimed against, which the
   *  supplier is expected to verify the return by. */
  inspection_no?: string | null;
  vendor_decision?: "APPROVED" | "REJECTED" | null;
  vendor_decision_at?: string | null;
  vendor_decision_note?: string | null;
  /** Who moves the goods. VENDOR_ARRANGES means this supplier owes a vehicle. */
  vehicle_arrangement?: string | null;
  vehicle_arrangement_label?: string | null;
  vendor_transport_accepted_at?: string | null;
  replacement_dispatched_at?: string | null;
  replacement_dispatch_no?: string | null;
  replacement_dispatch_date?: string | null;
  replacement_expected_date?: string | null;
  replacement_transporter_name?: string | null;
  replacement_vehicle_no?: string | null;
  replacement_lr_no?: string | null;
}

/** What the supplier signs when the consignment is physically handed over. The moment
 *  is never sent — the server stamps it, because a receipt whose time the signing party
 *  chooses is not evidence. */
export interface VendorReturnReceiptInput {
  received_by_name: string;
  vehicle_number?: string | null;
  remarks?: string | null;
}

/** THE decision on a return, and the supplier's alone since 2026-09-12. Nothing has been
 *  shipped when this is answered, so a rejection costs a conversation rather than a
 *  wasted lorry. `remarks` is REQUIRED on a rejection — the storekeeper who raised the
 *  return has to argue it, and an unexplained refusal is useless to them. */
export interface VendorReturnDecisionInput {
  action: "APPROVED" | "REJECTED";
  remarks?: string | null;
}

/** Refund or replacement, once the supplier has approved. Two outcomes and no third:
 *  refusing is the earlier press, not a settlement wearing its costume. */
export interface VendorReturnSettlementInput {
  settlement: "REFUNDED" | "REPLACED";
  /** REQUIRED on a refund and REFUSED on a replacement. Capped server-side at the value
   *  of the goods — a supplier cannot credit more than they received. */
  refund_amount?: number | null;
  remarks?: string | null;
}

/** The vehicle the supplier is sending to collect, named when they accept the job and
 *  correctable when it actually turns up. Every field optional: a supplier accepts on
 *  Monday and frequently does not know the truck until Thursday. */
export interface VendorTransportInput {
  vehicle_no?: string | null;
  driver_name?: string | null;
  driver_phone?: string | null;
  transporter_name?: string | null;
  lr_no?: string | null;
  expected_date?: string | null;
  remarks?: string | null;
}

/** THE REPLACEMENT DISPATCH NOTE. The item, the quantity, the purchase return number and
 *  the GRN/PO references are already on the return and print from it; what only the
 *  supplier can state is here.
 *
 *  `lines` carries the batch and life dates of the goods ACTUALLY being sent — never the
 *  return's own batch, which belongs to the faulty stock travelling the other way. The
 *  server refuses a batch-tracked line with no batch and an expiry-tracked one with no
 *  date, which are the same two rules that would otherwise stop the store's GRN days
 *  later, with nobody able to answer them. */
export interface ReplacementDispatchInput {
  /** The supplier's own note number. Never resolved — it is their reference. */
  dispatch_no?: string | null;
  dispatch_date?: string | null;
  /** When it should reach the buyer's warehouse. What their receiving queue sorts by. */
  expected_date?: string | null;
  transporter_name?: string | null;
  vehicle_no?: string | null;
  lr_no?: string | null;
  remarks?: string | null;
  lines: VendorReplacementLineInput[];
}

/** One of the files a replacement dispatch carries, as the form should draw it — and
 *  `required` says whether the dispatch waits for it. SERVED
 *  (`GET /api/supplier/returns/replacement-documents`), never a constant here: `accept`
 *  and `required` are the same rules the upload and the dispatch guard enforce, and a
 *  second copy in the screen would be free to offer something the server refuses. */
export interface ReplacementDocumentType {
  /** REPLACEMENT_PHOTO | REPLACEMENT_INVOICE. */
  value: string;
  /** The field caption — an instruction, e.g. "Upload image". */
  label: string;
  /** What a SENTENCE calls it, e.g. "image of the replacement goods". Used in the
   *  "attach the …" message, where the caption would read as nonsense. The server's own
   *  refusal uses this same value. */
  noun: string;
  hint: string;
  /** Straight into the input's `accept`. The photo slot takes images only. */
  accept: string;
  /** Put `capture` on the input, which opens the camera on a phone rather than the
   *  file browser. Ignored on desktop, where it falls back to a normal file picker. */
  capture: boolean;
  required: boolean;
}

/** A file already on the return. `file_path` is deliberately not served — the bytes are
 *  reachable only through the download route. */
export interface ReplacementDocumentRow {
  id: number;
  doc_category: string;
  label?: string | null;
  file_name: string;
  file_size?: number | null;
  mime_type?: string | null;
  uploaded_by_name?: string | null;
  created_at?: string | null;
}

/** The supplier's decision. `remarks` is REQUIRED for RETURNED and REPLACED — the
 *  warehouse about to receive an unexpected consignment has nothing else to go on —
 *  and the server enforces that, so the screen only mirrors it. */
export interface VendorReturnResponseInput {
  response: VendorReturnResponse;
  remarks?: string | null;
  /** REQUIRED when `response` is REFUNDED and REFUSED on every other answer — the
   *  server rejects both mistakes rather than correcting them, because an amount stored
   *  against an answer that pays nothing would show on screen as a credit nobody
   *  agreed to. Capped at the return's own `total_value`. */
  refund_amount?: number | null;

  /** HOW THE REPLACEMENT TRAVELS. Only on a REPLACED answer, and refused on any other
   *  for the same reason `refund_amount` is. These are written onto the draft inbound
   *  receipt the answer raises — the document the store's receiving screen reads — so
   *  the warehouse learns what is coming, when, and whether it has to go and fetch it.
   *
   *  TWO LEGS, picked by `replacement_mode`, and the server refuses each leg the other's
   *  fields rather than storing them: a collection carrying an arrival date would have
   *  the store waiting at the gate for a lorry nobody sent, and a delivery carrying a
   *  pickup address would send a vehicle to fetch something already on its way. */
  replacement_mode?: InboundTransportMode | null;

  /** SUPPLIER_DELIVERS only. The date is REQUIRED and must not be in the past; the other
   *  three are optional, because a supplier promising a replacement can promise a date
   *  but frequently has not booked the lorry yet. ISO `yyyy-mm-dd`. */
  replacement_expected_date?: string | null;
  replacement_transporter_name?: string | null;
  replacement_vehicle_no?: string | null;
  replacement_lr_no?: string | null;

  /** WE_COLLECT only, and BOTH required — "come and collect it" with no address is not
   *  an instruction anybody can act on, and no ready date sends a vehicle before the
   *  goods are packed. The ready date is when it is ready on THEIR dock, never an
   *  arrival at ours. */
  replacement_pickup_address?: string | null;
  replacement_ready_date?: string | null;

  /** WHAT IS IN THE CARTON, per line of the return. Belongs to neither leg: the batch
   *  and expiry are the same facts whether the supplier drives them here or we collect.
   *
   *  Written straight onto the draft inbound receipt's lines. Without them that receipt
   *  is raised blank and the store CANNOT finish it — an expiry-tracked line with no
   *  expiry is refused when the GRN is submitted, and the storekeeper cannot read a date
   *  off a carton standing in the supplier's warehouse. The server refuses a batch-
   *  tracked line with no batch and an expiry-tracked line with no date, so send one
   *  entry for every line that needs one; `line_no` is the number shown on this page. */
  replacement_lines?: VendorReplacementLineInput[];
}

/** Batch and life dates for one line of the replacement. Every field optional on the
 *  wire — what a line actually needs is a fact of the item master, which the server
 *  holds and enforces (`needs_batch` / `needs_expiry` on `VendorReturnItemRow` say which
 *  in advance). Dates are ISO `yyyy-mm-dd`; an expiry already in the past is refused,
 *  and so is one before the manufacturing date. */
export interface VendorReplacementLineInput {
  line_no: number;
  batch_no?: string | null;
  mfg_date?: string | null;
  expiry_date?: string | null;
}

/** WHO MOVES GOODS COMING TOWARDS US.
 *
 * A different axis from the logistics module's `TransportMode` (DIRECT / COURIER /
 * OWN_VEHICLE / THIRD_PARTY), which answers "how does it travel and who is paid" for a
 * leg WE are sending. On an inbound leg the prior question is whether anything is coming
 * at all or whether it is sitting on the supplier's dock waiting for our vehicle — and
 * `OWN_VEHICLE` cannot answer it, because "own vehicle" is ambiguous between the
 * supplier's truck and ours once the goods are heading our way. */
export type InboundTransportMode = "SUPPLIER_DELIVERS" | "WE_COLLECT";


// --------------------------------------------------------------------------- //
//  Approval trail — the same shape for every procurement document
// --------------------------------------------------------------------------- //

export interface ApprovalPendingRow {
  id: number;
  name: string;
}

export interface ApprovalEventRow {
  stage_sequence?: number | null;
  /** Whatever the ladder calls this rung. Rendered verbatim: the rungs are configured
   *  per project on Settings > Approvals Config, so any map in the frontend would go
   *  stale the moment somebody renames one. */
  stage_name?: string | null;
  actor_id?: number | null;
  actor_name?: string | null;
  actor_position?: string | null;
  action: string;
  comments?: string | null;
  acted_at?: string | null;
}

export interface ApprovalTrail {
  doc_type: string;
  doc_id: number;
  /** Null when the document has never been submitted. */
  instance_status?: string | null;
  stage_name?: string | null;
  pending_with: ApprovalPendingRow[];
  history: ApprovalEventRow[];
}

/** One order line as it stood in a filed revision, read back out of the snapshot. */
export interface PORevisionLine {
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  quantity?: number;
  rate?: number;
  tax_percent?: number;
  /** Line value as it stood. Filed by `_po_snapshot`, which is the only writer of
   *  this shape — every key here exists because that function emits it. */
  amount?: number;
  received_quantity?: number;
}

/** The lines of a filed revision. Empty when there is no revision to compare against,
 *  which is every order still on its original version. */
export const revisionLines = (revision?: PORevision | null): PORevisionLine[] =>
  (revision?.snapshot?.items as PORevisionLine[] | undefined) ?? [];

/** One message on the vendor's bell. `deep_link` is always a PORTAL path — a vendor
 *  can never be handed a link to an internal screen. */
export interface VendorNotification {
  id: number;
  title: string;
  body?: string | null;
  entity_type?: string | null;
  entity_id?: number | null;
  deep_link?: string | null;
  is_read: boolean;
  created_at?: string | null;
}

/** One document on the buying trail. `ref_no` is what it was raised FROM, which is
 *  what makes the register read as a chain rather than four unrelated lists. */
export interface ProcurementLedgerRow {
  doc_kind: string;
  doc_id: number;
  doc_no: string;
  doc_date?: string | null;
  party?: string | null;
  project_name?: string | null;
  title?: string | null;
  status?: string | null;
  value?: number | string | null;
  ref_no?: string | null;
  with_whom?: string | null;
}

export interface ProcurementLedgerFilters {
  doc_kinds: { value: string; label: string }[];
  columns: { key: string; label: string; kind: string; narrow?: boolean }[];
  statuses: string[];
  projects: string[];
  vendors: string[];
}


/* --- KPI strips (2026-08-23) ---------------------------------------------- *
 *
 * One shape per document family, matching `backend/app/modules/procurement/stats.py`.
 * Deliberately NOT one combined shape: each is served by its own endpoint gated on
 * the view code of the documents it counts, so a login that holds three of the five
 * gets three strips and no error.
 *
 * `awaiting_me` is never "how many are pending approval" — it is how many are pending
 * on THIS login, straight off the workflow engine.
 * ------------------------------------------------------------------------- */

export interface ReqStats {
  awaiting_me: number;
  pending_approval: number;
  approved: number;
  draft: number;
  rejected: number;
  total: number;
  this_month: number;
  open_value: number;
  total_lines: number;
  by_status: Record<string, number>;
  /** What each tile OPENS, keyed by the bucket it sits on — SERVED, so the number a
   *  tile shows and the rows its press brings back cannot drift apart. The screen
   *  passes these straight into the URL and never builds a filter of its own. */
  filters: Record<string, Record<string, string>>;
}

export interface ConsolidationStats {
  awaiting_me: number;
  pending_approval: number;
  approved: number;
  draft: number;
  total: number;
  this_month: number;
  requisitions_rolled: number;
  total_items: number;
  estimated_value: number;
  by_status: Record<string, number>;
  /** What each tile OPENS, keyed by the bucket it sits on — SERVED, so the number a
   *  tile shows and the rows its press brings back cannot drift apart. The screen
   *  passes these straight into the URL and never builds a filter of its own. */
  filters: Record<string, Record<string, string>>;
}

export interface RFQStats {
  awaiting_me: number;
  pending_approval: number;
  out_to_vendors: number;
  ready_to_award: number;
  draft: number;
  awarded: number;
  total: number;
  closing_soon: number;
  vendors_invited: number;
  quotes_received: number;
  by_status: Record<string, number>;
  /** What each tile OPENS, keyed by the bucket it sits on — SERVED, so the number a
   *  tile shows and the rows its press brings back cannot drift apart. The screen
   *  passes these straight into the URL and never builds a filter of its own. */
  filters: Record<string, Record<string, string>>;
}

export interface QuoteStats {
  to_compare: number;
  revised: number;
  accepted: number;
  not_selected: number;
  draft: number;
  total: number;
  this_month: number;
  rfqs_covered: number;
  vendors_quoting: number;
  quoted_value: number;
  by_status: Record<string, number>;
  /** What each tile OPENS, keyed by the bucket it sits on — SERVED, so the number a
   *  tile shows and the rows its press brings back cannot drift apart. The screen
   *  passes these straight into the URL and never builds a filter of its own. */
  filters: Record<string, Record<string, string>>;
}

export interface POStats {
  awaiting_me: number;
  pending_approval: number;
  to_send: number;
  at_vendor: number;
  awaiting_vendor: number;
  draft: number;
  received: number;
  total: number;
  this_month: number;
  month_value: number;
  open_commitment: number;
  by_status: Record<string, number>;
  /** What each tile OPENS, keyed by the bucket it sits on — SERVED, so the number a
   *  tile shows and the rows its press brings back cannot drift apart. The screen
   *  passes these straight into the URL and never builds a filter of its own. */
  filters: Record<string, Record<string, string>>;
}

/** One item's sanctioned, unbought demand. `open_qty` is the remainder across every
 *  requisition line the caller may read, so buying in rounds shrinks it by itself. */
export interface DemandPoolRow {
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  open_qty: number;
  estimated_value: number;
  requisition_count: number;
  project_count: number;
  earliest_required?: string | null;
}

/** The buying trail's own strip — one count per document kind, under the same filters
 *  the register is showing. `filters` is served for the same reason it is on the five
 *  document strips: the count and the press must be decided by the same code. */
export interface LedgerStats {
  by_kind: Record<string, number>;
  total: number;
  filters: Record<string, Record<string, string>>;
}

// --------------------------------------------------------------------------- //
//  The supplier register — /api/suppliers
// --------------------------------------------------------------------------- //
// A supplier IS a `mst_vendors` row; these types describe that row with its portal
// account flattened onto it, exactly as `LogisticsVendor` does for a carrier. The two
// registers are deliberately symmetrical — one vendor master, two desks.

export interface Supplier {
  id: number;
  code?: string | null;
  name: string;
  vendor_type: string;
  contact_person?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  state?: string | null;
  gstin?: string | null;
  payment_terms_days?: number | null;
  is_active: boolean;
  is_approved: boolean;
  is_blacklisted: boolean;
  has_login: boolean;
  username?: string | null;
  login_is_active?: boolean | null;
  must_change_password?: boolean | null;
  last_login_at?: string | null;
  /** Whether an RFQ can actually be sent to them: active, approved, not blacklisted. */
  quotable: boolean;
}

export interface SupplierInput {
  name: string;
  code?: string | null;
  vendor_type: string;
  contact_person?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  gstin?: string | null;
  pan?: string | null;
  payment_terms_days?: number | null;
  issue_login?: boolean;
  username?: string | null;
}

export interface SupplierSummary {
  total: number;
  quotable: number;
  with_login: number;
  without_login: number;
}

export interface SupplierType {
  value: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Procurement Demand Pool
// ---------------------------------------------------------------------------

export interface DemandPoolStage {
  stage: string;
  label: string;
  tone: string;
  hint: string;
  deep_link: string;
}

export interface DemandPoolDoc {
  kind: string;
  id: number;
  no: string | null;
  status: string;
  qty: number;
  stage?: string;
}

export interface DemandPoolSource {
  indent_id: number;
  indent_no: string;
  indent_item_id: number;
  item_id: number;
  item_code: string | null;
  item_name: string | null;
  uom_code: string | null;
  requested_qty: number;
  owed_qty: number;
  stage: string;
  stages: Record<string, number>;
  required_date: string | null;
  priority: string | null;
  requested_by_name: string | null;
  department_name: string | null;
  project_name: string | null;
  docs: DemandPoolDoc[];
}

export interface DemandPoolGroup {
  item_id: number;
  item_code: string | null;
  item_name: string | null;
  uom_code: string | null;
  total_qty: number;
  indent_count: number;
  stage_summary: Record<string, number>;
  earliest_required: string | null;
  sources: DemandPoolSource[];
}

export interface DemandPoolResponse {
  groups: DemandPoolGroup[];
  group_count: number;
  indent_count: number;
  stage_totals: Record<string, number>;
  page: number;
  size: number;
  total: number;
}
