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
  /** stk_balance.serial_number — one serial per lot row, null until goods-in records it. */
  serial_number?: string;
  barcode_value?: string;
  transit_qty?: number;
  project_name?: string;
  bin_code?: string;
  batch_id?: number;
  last_movement_at?: string;
}

/** Mirrors the query params GET /api/stock actually accepts. */
export interface StockBalanceFilter {
  warehouse_id?: number | string;
  item_id?: number | string;
  category_id?: number | string;
  search?: string;
  batch_no?: string;
  include_zero?: boolean;
  below_reorder?: boolean;
  expiring_in_days?: number;
  expiry_status?: string;
  expiry_from?: string;
  expiry_to?: string;
  expired_in_last_days?: number;
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

/** Mirrors the query params GET /api/stock/movements actually accepts. */
export interface StockLedgerFilter {
  item_id?: number | string;
  warehouse_id?: number | string;
  direction?: string;
  ref_type?: string;
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
  status: "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "DISPATCHED" | "IN_TRANSIT" | "RECEIVED" | "CANCELLED" | "REJECTED";
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
  serial_number?: string | null;
  asset_code?: string | null;
  consumable_code?: string | null;
  available_qty: number;
  reserved_qty: number;
  transit_qty?: number;
  total_qty: number;
  valuation_rate?: number;
  stock_value?: number;
  last_movement_at?: string | null;
  updated_at?: string | null;
  // filled from mst_items by the backend, not stk_balance columns
  category_name?: string | null;
  reorder_level?: number;
  barcode_value?: string | null;
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

export interface AllocationItem {
  id: number;
  indent_item_id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  requested_qty: number;
  quantity: number;
  warehouse_id?: number | null;
  warehouse_name?: string | null;
  remarks?: string | null;
}

export interface Allocation extends AllocationListRow {
  remarks?: string | null;
  items: AllocationItem[];
}

export interface WorkflowPending {
  instance_id: number;
  doc_type: string;
  doc_id: number;
  doc_no?: string | null;
  summary?: string | null;
  requested_by_name?: string | null;
  created_at?: string | null;
}

export interface StockOverviewKPIs {
  total_stock_value: number | null;
  items_below_reorder: number;
  near_expiry_30_days: number;
  near_expiry_60_days: number;
  near_expiry_90_days: number;
  total_reserved_qty: number;
  total_available_qty: number;
  dead_stock_count: number;
}

/** One lot inside a warehouse: its batch, its expiry, and the walk down to its bin. */
export interface StockLot {
  id: number;
  bin_id: number;
  bin_code?: string | null;
  batch_id: number;
  batch_no?: string | null;
  expiry_date?: string | null;
  days_to_expiry?: number | null;
  available_qty: number;
  reserved_qty: number;
  total_qty: number;
  project_name?: string | null;
  serial_number?: string | null;
  asset_code?: string | null;
  location_path: string[];
}

export interface StockDetail {
  id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  warehouse_id: number;
  warehouse_name?: string | null;
  location_path: string[];
  total_available: number;
  total_reserved: number;
  total_on_hand: number;
  lots: StockLot[];
}

export interface ReplenishmentRule {
  warehouse_id: number;
  item_id: number;
  min_qty: number;
  max_qty: number;
  reorder_qty: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  warehouse_name?: string | null;
  available_qty?: number;
  is_breached?: boolean;
}

export interface ReservationRow {
  id: number;
  stock_id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  warehouse_id: number;
  warehouse_name?: string | null;
  bin_id: number;
  batch_id: number;
  project_id: number;
  quantity: number;
  ref_type: string;
  ref_id: number;
  ref_no?: string | null;
  ref_line_id?: number | null;
  status: string;
  created_by_name?: string | null;
  created_at: string;
  released_at?: string | null;
}

export interface BatchAvailabilityRow {
  stock_id: number;
  warehouse_id: number;
  warehouse_name?: string | null;
  bin_id: number;
  bin_code?: string | null;
  batch_id: number;
  batch_no?: string | null;
  expiry_date?: string | null;
  project_id: number;
  available_qty: number;
  reserved_qty: number;
}

export interface ItemAvailabilityOut {
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  total_available_qty: number;
  total_reserved_qty: number;
  total_transit_qty: number;
  pick_strategy: string;
  batches: BatchAvailabilityRow[];
}

export interface AgeingRow {
  stock_id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  warehouse_id: number;
  warehouse_name?: string | null;
  batch_no?: string | null;
  expiry_date?: string | null;
  quantity: number;
  days_in_stock: number;
  age_bucket: string;
  days_to_expiry?: number | null;
  expiry_bucket?: string | null;
}

export interface AgeingSummaryOut {
  items: AgeingRow[];
  bucket_0_30_qty: number;
  bucket_31_60_qty: number;
  bucket_61_90_qty: number;
  bucket_90_plus_qty: number;
}

export interface ValuationRow {
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  warehouse_id: number;
  warehouse_name?: string | null;
  total_qty: number;
  moving_avg_cost: number;
  total_stock_value: number;
}

export interface ValuationSummaryOut {
  items: ValuationRow[];
  total_portfolio_value: number;
}

export interface NearExpiryAlertRow {
  stock_id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  warehouse_id: number;
  warehouse_name?: string | null;
  batch_no?: string | null;
  expiry_date: string;
  days_to_expiry: number;
  quantity: number;
}

export interface STOItemIn {
  item_id: number;
  requested_qty: number;
  remarks?: string;
}

export interface STOIn {
  from_warehouse_id: number;
  to_warehouse_id: number;
  from_project_id?: number;
  to_project_id?: number;
  remarks?: string;
  items: STOItemIn[];
}

export interface STOItemOut {
  id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  requested_qty: number;
  dispatched_qty: number;
  received_qty: number;
  remarks?: string | null;
}

export interface STOListRow {
  id: number;
  sto_no: string;
  from_warehouse_id: number;
  from_warehouse_name?: string | null;
  to_warehouse_id: number;
  to_warehouse_name?: string | null;
  status: string;
  requested_by_name?: string | null;
  approved_by_name?: string | null;
  created_at: string;
}

export interface STOOut extends STOListRow {
  remarks?: string | null;
  approved_at?: string | null;
  dispatched_at?: string | null;
  received_at?: string | null;
  items: STOItemOut[];
}

export interface CycleCountIn {
  warehouse_id: number;
  count_date: string;
  remarks?: string;
  item_ids?: number[];
}

export interface CycleCountItemUpdateIn {
  id: number;
  counted_qty: number;
  remarks?: string;
}

export interface CycleCountUpdateIn {
  remarks?: string;
  items: CycleCountItemUpdateIn[];
}

export interface CycleCountItemOut {
  id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  bin_id: number;
  batch_id: number;
  snapshot_qty: number;
  counted_qty?: number | null;
  variance_qty?: number | null;
  remarks?: string | null;
}

export interface CycleCountListRow {
  id: number;
  count_no: string;
  warehouse_id: number;
  warehouse_name?: string | null;
  count_date: string;
  status: string;
  planned_by_name?: string | null;
  posted_by_name?: string | null;
  created_at: string;
}

export interface CycleCountOut extends CycleCountListRow {
  remarks?: string | null;
  posted_at?: string | null;
  items: CycleCountItemOut[];
}


/** One recorded decision on an allocation's approval chain. */
export interface AllocationHistoryRow {
  stage_sequence: number;
  stage_name?: string | null;
  actor_name?: string | null;
  /** Which hat they signed under — the point of a post-based ladder. */
  actor_position?: string | null;
  action: string;
  comments?: string | null;
  acted_at?: string | null;
}

/** A stocking point's rung on the distribution chain. Derived from the warehouse
 *  type on the server, never stored twice — see backend inventory/locations.py. */
export type LocationTier = 1 | 2 | 3;   // 1 WAREHOUSE, 2 MDP, 3 LIP

export interface PositionLocationTag {
  id: number;
  position_id: number;
  position_name?: string | null;
  warehouse_id: number;
  warehouse_code?: string | null;
  warehouse_name?: string | null;
  warehouse_type?: string | null;
  tier: LocationTier;
  tier_label: string;
  project_id: number;
  project_name?: string | null;
  is_primary: boolean;
}

export interface PositionLocationWrite {
  position_id: number;
  warehouse_id: number;
  project_id?: number;
  project_name?: string | null;
  is_primary?: boolean;
}

/** What a move between two points would be. Read-only: the user picks from/to and a
 *  reason, never the kind — see the note on the backend schema. */
export interface MovementClassification {
  from_warehouse_id?: number | null;
  to_warehouse_id?: number | null;
  from_tier: LocationTier;
  to_tier: LocationTier;
  movement_kind: "MOVEMENT" | "TRANSFER" | "ISSUE" | "RETURN";
  doc_type: string;
  needs_inventory_manager: boolean;
  explanation: string;
}

export interface MyStockingPoints {
  primary_warehouse_id?: number | null;
  warehouse_ids: number[];
  tags: PositionLocationTag[];
}

/** A position the tagging screen can offer, found by person, code or post name. */
export interface PositionSearchHit {
  position_id: number;
  position_name: string;
  office_id?: number | null;
  employee_code?: string | null;
  employee_name?: string | null;
  /** Warehouse code it is already tagged to, if any — so the screen can say so. */
  tagged_to?: string | null;
}
