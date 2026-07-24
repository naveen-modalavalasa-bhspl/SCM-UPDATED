export interface IndentItem {
  id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  quantity: number;
  approved_quantity?: number | null;
  ordered_quantity: number;
  received_quantity: number;
  remarks?: string | null;
}

export interface Indent {
  id: number;
  indent_no: string;
  indent_date?: string | null;
  required_date?: string | null;
  requested_by_id?: number | null;
  requested_by_name?: string | null;
  department_id?: number | null;
  department_name?: string | null;
  facility_id?: number | null;
  facility_name?: string | null;
  status: string;
  priority: string;
  total_items: number;
  remarks?: string | null;
  current_approver_name?: string | null;
  approved_at?: string | null;
  created_at: string;
  items: IndentItem[];
}

export interface IndentListRow {
  id: number;
  indent_no: string;
  requested_by_name?: string | null;
  department_name?: string | null;
  status: string;
  priority: string;
  total_items: number;
  current_approver_name?: string | null;
  created_at: string;
}

export interface IndentStats {
  total: number;
  draft: number;
  awaiting_approval: number;
  approved_active: number;
  rejected: number;
  ordered: number;
  this_month: number;
  by_status: Record<string, number>;
}

export interface IndentCreate {
  required_date?: string | null;
  priority: string;
  facility_id?: number | null;
  remarks?: string | null;
  items: { item_id: number; quantity: number; remarks?: string }[];
}
