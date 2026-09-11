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
  /** What the buyer decided to tender. Never more than `quantity`. */
  approved_qty: number;
  estimated_rate: number;
  estimated_amount: number;
  required_date?: string | null;
  /** "REQ/2026-27/00012 x 40; REQ/2026-27/00019 x 25" */
  sources?: string | null;
  source_count: number;
  remarks?: string | null;
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
  pos?: { po_id: number; po_no: string; po_status: string; vendor_id: number; quotation_id?: number | null }[];
  /** Carried across from the requisition behind it, so a tender reads on its own. */
  department_id?: number | null;
  department_name?: string | null;
  company_name?: string | null;
  priority?: string | null;
  requisition_status?: string | null;
  source_indent_nos?: string[];
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
  tax_percent: number;
  cgst_rate?: number | null;
  sgst_rate?: number | null;
  igst_rate?: number | null;
  amount: number;
  delivery_days?: number | null;
  /** The item's HSN and the rates it notifies — the ceiling this line may quote up to.
   *  Null means the item has no HSN, so no ceiling applies. */
  hsn_code?: string | null;
  max_cgst_rate?: number | null;
  max_sgst_rate?: number | null;
  max_igst_rate?: number | null;
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
    tax_percent?: number;
    cgst_rate?: number | null;
    sgst_rate?: number | null;
    igst_rate?: number | null;
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
  cgst_rate?: number | null;
  cgst_amount?: number | null;
  sgst_rate?: number | null;
  sgst_amount?: number | null;
  igst_rate?: number | null;
  igst_amount?: number | null;
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
