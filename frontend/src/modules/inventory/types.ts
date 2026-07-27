export interface InventoryOverview {
  module: string;
  status: string;
  database_ready: boolean;
}

export interface WarehouseOption {
  id: number;
  code: string;
  name: string;
  location?: string;
}

export interface CatalogItemOption {
  id: number;
  code: string;
  name: string;
  category: string;
  uom: string;
  uom_code?: string;
  unit_rate: number;
  default_unit_rate?: number;
  available_qty?: number;
  is_batch_tracked?: boolean;
}

export interface VendorOption {
  id: number;
  code: string;
  name: string;
}

export interface StockBalanceItem {
  id: number;
  item_id: number;
  item_code: string;
  item_name: string;
  category_name: string;
  warehouse_id: number;
  warehouse_name: string;
  uom_code: string;
  physical_qty: number;
  reserved_qty: number;
  in_transit_qty?: number;
  available_qty: number;
  reorder_level: number;
  min_stock_level?: number;
  max_stock_level?: number;
  valuation_rate: number;
  total_value: number;
  batch_number?: string;
  expiry_date?: string;
  storage_location?: string;
  last_received_date?: string;
  last_issued_date?: string;
  is_batch_tracked?: boolean;
  asset_code?: string;
  consumable_code?: string;
  serial_numbers?: string[];
}

export interface StockBalanceFilter {
  warehouse_id?: number | string;
  item_id?: number | string;
  category?: string;
  search?: string;
  show_zero_stock?: boolean;
  low_stock_only?: boolean;
  expiring_soon?: boolean;
  group_by?: string;
  page?: number;
  size?: number;
}

export interface StockAdjustmentInput {
  item_id: number;
  warehouse_id: number;
  adjustment_type: "Stock In" | "Stock Out" | "Scrap / Write-off" | "Revaluation";
  quantity: number;
  unit_rate?: number;
  reason_code: "Initial Setup" | "Audit Discrepancy" | "Damaged Goods" | "Expired Stock" | "Found Stock" | "Other";
  remarks?: string;
  batch_number?: string;
  expiry_date?: string;
}

export interface StockLedgerItem {
  id: number;
  transaction_date: string;
  transaction_no: string;
  transaction_type: string;
  item_id: number;
  item_code: string;
  item_name: string;
  warehouse_id: number;
  warehouse_name: string;
  uom_code: string;
  in_qty: number;
  out_qty: number;
  balance_qty: number;
  unit_rate: number;
  total_value: number;
  reference_no?: string;
  performed_by?: string;
  remarks?: string;
  posting_time?: string;
  batch_number?: string;
  created_by?: string;
}

export interface StockLedgerFilter {
  item_id?: number | string;
  warehouse_id?: number | string;
  transaction_type?: string;
  date_from?: string;
  date_to?: string;
  search?: string;
  page?: number;
  size?: number;
}

export interface ReplenishmentItem {
  id: number;
  item_id: number;
  item_code: string;
  item_name: string;
  category_name: string;
  warehouse_id: number;
  warehouse_name: string;
  uom_code: string;
  current_available: number;
  reorder_level: number;
  min_stock_level: number;
  target_stock_level: number;
  suggested_reorder_qty: number;
  preferred_vendor_id?: number;
  preferred_vendor_name?: string;
  estimated_unit_cost: number;
  est_unit_rate: number;
  lead_time_days?: number;
  status: "CRITICAL" | "WARNING" | "NORMAL";
}

export interface ReplenishmentPOItem {
  item_id: number;
  suggested_qty: number;
  vendor_id?: number;
}

export interface StockTransferLineItem {
  item_id: number;
  item_code: string;
  item_name: string;
  available_qty: number;
  transfer_qty: number;
  uom_code: string;
  batch_number?: string;
  expiry_date?: string;
  unit_rate?: number;
  total_value?: number;
  is_batch_tracked?: boolean;
}

export interface StockTransferCreate {
  transfer_no?: string;
  transfer_date: string;
  source_warehouse_id: number;
  destination_warehouse_id: number;
  carrier?: string;
  vehicle_number?: string;
  driver_name_contact?: string;
  remarks?: string;
  lines: StockTransferLineItem[];
}

export interface StockTransferRow {
  id: number;
  transfer_no: string;
  transfer_date: string;
  source_warehouse_id: number;
  source_warehouse_name: string;
  destination_warehouse_id: number;
  destination_warehouse_name: string;
  status: "DRAFT" | "PENDING_APPROVAL" | "IN_TRANSIT" | "RECEIVED" | "CANCELLED" | "REJECTED";
  total_items: number;
  total_qty: number;
  total_value: number;
  carrier?: string;
  vehicle_number?: string;
  created_by?: string;
  remarks?: string;
  lines?: StockTransferLineItem[];
}

/** The backend's list envelope: every list endpoint returns this shape. */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

/** Exactly what GET /api/stock returns -- the live stk_balance columns. */
export interface StockRow {
  id: number;
  warehouse_id: number;
  warehouse_name?: string | null;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  bin_id: number;
  bin_code?: string | null;
  batch_id: number;
  batch_no?: string | null;
  expiry_date?: string | null;
  project_id: number;
  project_name?: string | null;
  available_qty: number;
  reserved_qty: number;
  total_qty: number;
  updated_at?: string | null;
}

/** Exactly what GET /api/stock/movements returns -- the live stk_ledger columns. */
export interface MovementRow {
  id: number;
  warehouse_id: number;
  warehouse_name?: string | null;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  batch_no?: string | null;
  direction: "IN" | "OUT";
  quantity: number;
  balance_after: number;
  ref_type?: string | null;
  ref_no?: string | null;
  created_by_name?: string | null;
  created_at: string;
}

export interface MaterialRequestItem {
  id: number;
  line_no: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  quantity: number;
  ordered_quantity: number;
  indent_item_id?: number | null;
  remarks?: string | null;
}

export interface MaterialRequestListRow {
  id: number;
  mr_no: string;
  mr_date?: string | null;
  indent_id?: number | null;
  indent_no?: string | null;
  requested_by_name?: string | null;
  department_name?: string | null;
  status: string;
  priority: string;
  required_by?: string | null;
  current_approver_name?: string | null;
  created_at: string;
}

export interface MaterialRequest extends MaterialRequestListRow {
  project_name?: string | null;
  remarks?: string | null;
  approved_at?: string | null;
  items: MaterialRequestItem[];
}

/** One warehouse's share of what is on hand for an item. */
export interface AllocationWarehouseOption {
  warehouse_id: number;
  warehouse_name: string | null;
  available_qty: number;
}

/** A line on the allocation screen: what was asked for, what is actually there. */
export interface AllocationProposalLine {
  indent_item_id: number;
  item_id: number;
  item_code: string | null;
  item_name: string | null;
  uom_code: string | null;
  requested_qty: number;
  already_allocated: number;
  available_total: number;
  competing_demand: number;
  warehouses: AllocationWarehouseOption[];
}

export interface AllocationProposal {
  indent_id: number;
  indent_no: string;
  department_name: string | null;
  requested_by_name: string | null;
  status: string;
  lines: AllocationProposalLine[];
}

export interface AllocationDecision {
  indent_item_id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  requested_qty: number;
  quantity: number;
  warehouse_id: number | null;
  project_id?: number;
}

export interface AllocationListRow {
  id: number;
  allocation_no: string;
  indent_id: number;
  indent_no: string | null;
  status: string;
  allocated_by_name: string | null;
  current_approver_name: string | null;
  approved_at: string | null;
  created_at: string;
}
