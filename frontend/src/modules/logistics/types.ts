export interface GRNItem {
  id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  ordered_quantity: number;
  received_quantity: number;
  accepted_quantity: number;
  rejected_quantity: number;
  batch_no?: string | null;
}

export interface GRN {
  id: number;
  grn_no: string;
  grn_date?: string | null;
  po_id?: number | null;
  po_no?: string | null;
  vendor_name?: string | null;
  facility_id?: number | null;
  facility_name?: string | null;
  invoice_no?: string | null;
  vehicle_no?: string | null;
  status: string;
  total_items: number;
  created_at: string;
  items: GRNItem[];
}

export interface GRNListRow {
  id: number;
  grn_no: string;
  po_no?: string | null;
  vendor_name?: string | null;
  status: string;
  created_at: string;
}

export interface GRNCreate {
  invoice_no?: string | null;
  vehicle_no?: string | null;
  lines: {
    po_item_id?: number | null;
    item_id: number;
    received_quantity: number;
    accepted_quantity: number;
    rejected_quantity?: number;
    batch_no?: string | null;
  }[];
}

export interface StockRow {
  id: number;
  facility_id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  quantity: number;
  reserved_quantity: number;
  updated_at: string;
}

export interface MovementRow {
  id: number;
  facility_id: number;
  item_id: number;
  direction: string;
  quantity: number;
  balance_after: number;
  ref_type?: string | null;
  ref_no?: string | null;
  created_by_name?: string | null;
  created_at: string;
}

export interface Issue {
  id: number;
  issue_no: string;
  facility_id?: number | null;
  department_id?: number | null;
  status: string;
  created_at: string;
}
