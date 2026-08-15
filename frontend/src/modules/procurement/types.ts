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
  vendor_id: number;
  vendor_name?: string | null;
  facility_id?: number | null;
  facility_name?: string | null;
  status: string;
  sub_total: number;
  tax_amount: number;
  total_amount: number;
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

export interface POCreate {
  vendor_id: number;
  expected_date?: string | null;
  remarks?: string | null;
  lines: {
    item_id: number;
    indent_item_id?: number | null;
    quantity: number;
    rate: number;
    tax_percent?: number;
  }[];
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

export interface Requisition extends ReqListRow {
  warehouse_id?: number | null;
  project_id?: number | null;
  remarks?: string | null;
  approved_by_name?: string | null;
  approved_at?: string | null;
  items: ReqItem[];
}

export interface ReqCreate {
  warehouse_id?: number | null;
  project_id?: number | null;
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
  warehouse_id?: number | null;
  warehouse_name?: string | null;
  project_id?: number | null;
  project_name?: string | null;
  terms?: string | null;
  awarded_vendor_id?: number | null;
  created_by_name?: string | null;
  items: RFQItem[];
  vendors: RFQVendor[];
}

export interface RFQCreate {
  title?: string | null;
  requisition_id?: number | null;
  warehouse_id?: number | null;
  project_id?: number | null;
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

export interface Comparison {
  rfq: RFQ;
  quotations: QuoteListRow[];
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
