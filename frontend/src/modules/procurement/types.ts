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
