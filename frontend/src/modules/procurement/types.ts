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
  created_at: string;
  items: POItem[];
}

export interface POListRow {
  id: number;
  po_no: string;
  vendor_name?: string | null;
  indent_no?: string | null;
  status: string;
  total_amount: number;
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
}

export interface RFQListRow {
  id: number;
  rfq_no: string;
  title?: string | null;
  rfq_date?: string | null;
  due_date?: string | null;
  status: string;
  total_items: number;
  vendor_count: number;
  response_count: number;
  awarded_vendor_name?: string | null;
  current_approver_name?: string | null;
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

export interface QuoteSubmit {
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
}

export interface VendorPO {
  id: number;
  po_no: string;
  po_date?: string | null;
  expected_date?: string | null;
  status: string;
  total_amount: number;
  remarks?: string | null;
  lines: VendorPOLine[];
  despatch_notes: DespatchNote[];
}

export interface VendorPOListRow {
  id: number;
  po_no: string;
  po_date?: string | null;
  expected_date?: string | null;
  status: string;
  total_amount: number;
  despatch_note_count: number;
}
