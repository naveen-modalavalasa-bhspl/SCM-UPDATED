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
  /** Readable UOM name. The code is the stored identity and cannot be renamed, and the
   *  six oldest masters carry the prefix inside it ("UOM-GMS"), so the name is what is
   *  printed. Falls back to the code when a lot's UOM has no master row. */
  uom_name?: string | null;
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
  bin_id?: number;
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
  /** Which rows the stock grid wants: "" / "available" (drawable now), "all",
   *  "zero" (nothing on hand), "reserved" (on hand, all of it committed). */
  stock_view?: string;
  below_reorder?: boolean;
  expiring_in_days?: number;
  expiry_status?: string;
  expiry_from?: string;
  expiry_to?: string;
  expired_in_last_days?: number;
  page?: number;
  size?: number;
}

/** GET /api/stock/summary — the tiles, counted over every matching row. */
export interface StockSummary {
  stock_lines: number;
  distinct_items: number;
  /** On hand including reserved — the figure Stocking Points shows on its card. */
  total_qty: number;
  total_value: number;
  expiring_30_days: number;
  below_reorder: number;
  /** False when no item has a reorder level set, which makes `below_reorder` an
   *  artefact rather than an answer — the tile and the filter hide themselves instead
   *  of reporting a reassuring 0. Absent on an older backend, hence the optional. */
  reorder_configured?: boolean;
}

/** GET /api/warehouse/serials/summary — per item + stocking point + bin + batch. */
export interface SerialSummaryRow {
  item_id: number;
  warehouse_id: number;
  /** Null until goods-in records which bin/batch the units went to. */
  bin_id: number | null;
  batch_id: number | null;
  /** How many units are tracked there. The arrays hold the first five of each. */
  count: number;
  serials: string[];
  imeis: string[];
  codes: string[];
  /** The same codes split by kind — a unit is an asset OR a consumable, never both —
   *  so the stock ledger can give each its own column. Optional: an older backend (or
   *  a test fixture) that only sends `codes` still renders, just without the split. */
  asset_codes?: string[];
  consumable_codes?: string[];
  asset_count?: number;
  consumable_count?: number;
}

/** One physical unit: GET /api/warehouse/serials (list) and .../serials/lookup (one). */
export interface UnitRow {
  id: number;
  item_id: number;
  item_code: string | null;
  item_name: string | null;
  is_asset: boolean;
  serial_number: string | null;
  imei: string | null;
  batch_id: number | null;
  batch_no: string | null;
  mfg_date?: string | null;
  expiry_date?: string | null;
  warehouse_id: number | null;
  warehouse_name: string | null;
  bin_id: number | null;
  bin_code: string | null;
  asset_code: string | null;
  consumable_code: string | null;
  status: string | null;
  remarks?: string | null;
  /** Only on a lookup: the text that found it. */
  matched?: string;
}

/** GET /api/stock/movements/summary. */
export interface LedgerSummary {
  movements: number;
  total_in: number;
  total_out: number;
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
  /** The lot the movement touched — needed to find its units in the serial
   *  summary, which files placed units under item:warehouse:bin:batch. */
  bin_id?: number | null;
  batch_id?: number | null;
  warehouse_name: string;
  uom_code: string;
  in_qty: number;
  out_qty: number;
  balance_qty: number;
  /** Null, not 0, when the movement was never costed — "not costed" is not "free". */
  unit_rate: number | null;
  total_value: number | null;
  /** Serial / IMEI on the line, and the code the same unit carries. */
  serial_number?: string;
  /** The units this MOVEMENT carried, exactly as `stk_ledger.serial_numbers` holds
   *  them. Load-bearing since 2026-08-22: a row that names its own units must never
   *  fall back to the units standing in that lot right now, which is a different
   *  question (and answered a movement of 2 with the 198 on the shelf behind it). */
  serial_numbers?: string[];
  asset_code?: string;
  consumable_code?: string;
  /** The unit codes this movement carried, when the item is not serial-tracked and
   *  the minted code IS the unit's identity. `serial_numbers` stays empty for those
   *  rows on purpose — the codes are not serials and must not surface as any. */
  unit_codes?: string[];
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
  /** stk_balance.serial_number is a JSON list — a lot holds many units. */
  serial_number?: string[] | null;
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
  /** Resolved from mst_uom against `uom_code`, which is a stored snapshot and is never
   *  renamed. The name is what the screens print. */
  uom_name?: string | null;
}

export interface FloorOption {
  id: number;
  warehouse_id: number;
  code: string;
  name?: string | null;
  bin_type?: string | null;
  parent_id?: number | null;
  is_active?: boolean;
}

export interface FloorAccess {
  id: number;
  position_id: number;
  warehouse_id: number;
  location_id: number;
  location_code?: string | null;
  location_name?: string | null;
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
  /** stk_ledger.rate / .value — null on rows written before they were mapped. */
  rate?: number | null;
  value?: number | null;
  /** JSON list — one movement can carry a whole putaway of serials. */
  serial_numbers?: string[] | null;
  /** The lot the movement touched. Needed to find its units in the serial summary,
   *  which files PLACED units under item:warehouse:bin:batch. */
  bin_id?: number | null;
  batch_id?: number | null;
  asset_code?: string | null;
  consumable_code?: string | null;
  ref_type?: string | null;
  ref_no?: string | null;
  created_by_name?: string | null;
  created_at: string;
}

/** What one physical unit carries, looked up by any identity the caller holds.
 *  Served by `POST /api/warehouse/serials/codes`. */
export interface UnitCodeRow {
  serial_number: string | null;
  imei: string | null;
  asset_code: string | null;
  consumable_code: string | null;
  item_id: number;
  warehouse_id: number | null;
  status: string | null;
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
  /** Whether this login, under the position it is currently wearing, is the rung this
   *  request is waiting on. One person often holds two rungs of the same ladder, so
   *  being named the approver is not the same as being able to sign right now. */
  can_act?: boolean;
  has_requisition?: boolean;
  created_at: string;
}

export interface MaterialRequest extends MaterialRequestListRow {
  /** The ladder rung it is waiting on, not the person: "Regional Manager". */
  current_stage_name?: string | null;
  project_name?: string | null;
  remarks?: string | null;
  approved_at?: string | null;
  items: MaterialRequestItem[];
}

/** Another open request wanting the same item. The MR answer to the allocation
 *  screen's "claimed by other indents": what else is already queued to be bought. */
export interface MRClaim {
  mr_id: number;
  mr_no: string;
  status: string;
  indent_id?: number | null;
  indent_no?: string | null;
  requested_by_name?: string | null;
  department_name?: string | null;
  project_name?: string | null;
  priority?: string | null;
  quantity: number;
  ordered_quantity: number;
  created_at?: string | null;
}

export interface MRClaims {
  item_id: number;
  item_code: string | null;
  item_name: string | null;
  uom_code: string | null;
  total_qty: number;
  available_qty: number;
  reserved_qty: number;
  claimed_total: number;
  indent_count: number;
  claims: MRClaim[];
}

/** One warehouse's share of what is on hand for an item. */
export interface AllocationWarehouseOption {
  warehouse_id: number;
  warehouse_name: string | null;
  /** `whs_warehouses.warehouse_type` — LIP and MDP are rungs on the distribution
   *  chain, everything else is the warehouse itself. */
  warehouse_type: string | null;
  available_qty: number;
}

/** A line on the allocation screen: what was asked for, what is actually there. */
export interface AllocationProposalLine {
  on_order_qty?: number;
  indent_item_id: number;
  item_id: number;
  item_code: string | null;
  item_name: string | null;
  uom_code: string | null;
  requested_qty: number;
  already_allocated: number;
  available_total: number;
  /** `available_total` less LIP and MDP. Zero while `available_total` is not means the
   *  stock exists but not in the warehouse — the case Raise MR is offered for. */
  main_available_qty: number;
  competing_demand: number;
  /** The INDENT's project, not the reader's. Sent back when Raise MR is pressed so the
   *  request is filed against the project that asked for the material. */
  project_id: number | null;
  warehouses: AllocationWarehouseOption[];
}

export interface AllocationProposal {
  indent_id: number;
  indent_no: string;
  department_name: string | null;
  requested_by_name: string | null;
  status: string;
  /** False = look, don't decide. The lines still read; the Submit is withheld. */
  allocatable: boolean;
  /** Why, in words, when `allocatable` is false. */
  blocked_reason: string | null;
  /** Everything already promising this indent something. */
  allocations: { id: number; allocation_no: string; status: string }[];
  lines: AllocationProposalLine[];
}

/** One live claim on an item, raised by an allocation against a different indent. */
export interface ItemClaim {
  allocation_id: number;
  allocation_no: string;
  status: string;
  indent_id: number;
  indent_no: string | null;
  requested_by_name: string | null;
  office_name: string | null;
  priority: string | null;
  allocated_by_name: string | null;
  /** What the claim holds off the shelf. */
  claimed_qty: number;
  /** What it actually promises to give. */
  giving_qty: number;
  warehouse_id: number | null;
  warehouse_name: string | null;
  created_at: string | null;
}

/** The breakdown behind "N claimed by other indents" on an allocation line. */
export interface ItemClaims {
  item_id: number;
  item_code: string | null;
  item_name: string | null;
  uom_code: string | null;
  total_qty: number;
  available_qty: number;
  reserved_qty: number;
  claimed_total: number;
  indent_count: number;
  claims: ItemClaim[];
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

/** Outcome of allocating a whole cycle at once. `failed` names the indents that moved
 *  on since the screen loaded, so the storekeeper can see why a count is short. */
export interface AllocationBatchResult {
  created_count: number;
  created_indent_ids: number[];
  failed: { indent_id: number; indent_no?: string | null; reason: string }[];
}

/** One monthly cycle's worth of allocations waiting on this approver. */
export interface AllocationApprovalBatch {
  /** The consolidation document's key — the same `C41` the Fulfilment Queue uses. */
  cycle: string;
  consolidation_no?: string | null;
  consolidation_status?: string | null;
  month_label: string;
  allocation_ids: number[];
  allocation_count: number;
  /** The subset this login can sign under the position it is currently working as.
   *  One person is often both the level-1 and level-2 approver, so "pending" and
   *  "mine to sign right now" are different questions. */
  actionable_ids: number[];
  actionable_count: number;
  /** Split of the cycle by allocation status, so a finished cycle reads as finished
   *  rather than simply vanishing from the list. */
  pending_count: number;
  approved_count: number;
  /** Members of the consolidation — deliberately NOT "indents I hold allocations
   *  for", so this matches the Fulfilment Queue's figure for the same cycle. */
  indent_count: number;
  /** How many of those members this inbox is actually holding allocations for. */
  allocated_indent_count?: number;
  item_count: number;
  line_count?: number;
  /** Mixed units added together — kept for old callers, never shown to a user. */
  total_qty: number;
  totals_by_uom?: UomTotal[];
  allocations: {
    id: number;
    /** PENDING_APPROVAL or APPROVED — the cycle screen loads both, so a row has to
     *  say which it is. */
    status?: string;
    /** Whether this login's ACTIVE position is the rung this one is waiting on. */
    can_act?: boolean;
    /** Who it IS waiting on, by name. Empty once nothing is pending on it. */
    pending_with?: string[];
    allocation_no: string;
    indent_id: number;
    indent_no: string | null;
    requested_by_name?: string | null;
    office_name?: string | null;
    priority?: string | null;
    lines: {
      item_id: number; item_code?: string | null; item_name?: string | null;
      uom_code?: string | null; quantity: number;
      warehouse_id?: number | null; warehouse_name?: string | null;
    }[];
  }[];
}

export interface AllocBatchResult {
  done_count: number;
  done_ids: number[];
  failed: { allocation_id: number; allocation_no?: string | null; reason: string }[];
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
  /** Line totals, added by the server so a queue screen never has to open every row
   *  just to add them up. */
  total_qty?: number;
  requested_total?: number;
}

/** What one allocation line could actually be given right now: the shelf at its point,
 *  less what other un-approved allocations have already promised out of it. */
export interface AllocationLineAvailability {
  id: number;
  item_id: number;
  item_code: string | null;
  item_name: string | null;
  uom_code: string | null;
  warehouse_id: number | null;
  warehouse_name: string | null;
  requested_qty: number;
  quantity: number;
  on_shelf: number;
  pledged_elsewhere: number;
  free: number;
  /** Never above what was requested — an approver revises down, or back up to the ask. */
  max_allowed: number;
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
  location_id?: number | null;
  section_name?: string | null;
  is_primary: boolean;
  /** Who stands in the post. A position carries several assignment rows, so this is a
   *  list — and it is what lets the screen be searched by employee code. */
  holders?: { employee_code?: string | null; employee_name?: string | null }[];
  /** On-hand at this point: distinct items, and the total available quantity. */
  stock_items?: number;
  stock_qty?: number;
}

export interface PositionLocationWrite {
  position_id: number;
  warehouse_id: number;
  project_id?: number;
  project_name?: string | null;
  is_primary?: boolean;
}

/** What the Stocking Points list can be narrowed by. Every field is applied on the
 *  server, on top of the caller's own scope — never instead of it. */
export interface StockingPointQuery {
  /** Free text over position, point name, point code and project. */
  search?: string;
  /** 1 warehouse · 2 MDP · 3 LIP. */
  tier?: LocationTier;
  project_id?: number;
  position_id?: number;
  page?: number;
  size?: number;
}

export interface StockingPointTagPage {
  items: PositionLocationTag[];
  total: number;
  page: number;
  size: number;
  /** Tier -> how many tags in the WHOLE filtered set, so the cards above the list
   *  keep counting the network rather than the page. */
  tier_counts: Record<string, number>;
  /** On-hand across the whole filtered set, not the page — so searching one employee
   *  code answers "what has this person got in total". */
  stock_points: number;
  stock_items: number;
  stock_qty: number;
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

/** One indent's claim on an item inside the consolidated view. */
export interface BatchDemandLine {
  indent_id: number;
  indent_no: string;
  indent_item_id: number;
  requested_by_name?: string | null;
  office_name?: string | null;
  project_name?: string | null;
  priority?: string | null;
  pending_qty: number;
  raised_at?: string | null;
}

/** One ITEM across every indent still waiting for it. `shortfall` is what has to be
 *  bought: demand the shelf cannot cover. */
export interface BatchDemandItem {
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  /** Decimal places this unit may carry: 0 for anything counted in whole numbers, 3
   *  for anything measured. The proposed split moves in steps of this, so a countable
   *  item is never offered as 5.7. Optional — an older API build does not send it. */
  uom_decimals?: number;
  indent_count: number;
  urgent_count: number;
  total_demand: number;
  available_total: number;
  /** What the WAREHOUSE tier can serve — `available_total` less anything sitting at a
   *  LIP or an MDP. THE number the shortfall is worked out from (2026-08-22): a LIP is
   *  where stock ends up, not a shelf an indent is filled from, so 5 units parked at
   *  one LIP must not quietly keep 5 units off the material request. Optional because
   *  an older API build does not send it; the screen falls back to `available_total`,
   *  which is the behaviour it had before. */
  main_available_qty?: number;
  shortfall: number;
  /** Where the stock actually sits, fullest first — "give 50" is only half the
   *  decision; the other half is which shelf it leaves. `warehouse_type` says which
   *  tier the point is on, so the picker can put the warehouses above the LIP/MDP
   *  points instead of offering whichever one the stock query happened to return
   *  first. The backend has always sent it; nothing read it. */
  warehouses: {
    warehouse_id: number;
    warehouse_name: string;
    available_qty: number;
    warehouse_type?: string | null;
  }[];
  demand: BatchDemandLine[];
}

/** One monthly cycle waiting to be fulfilled, as the queue lists it. */
/** A cycle total in one unit. Quantities only add up within a unit — a cycle asking
 *  for boxes, pieces and millilitres has three totals, not one. */
export interface UomTotal {
  uom_code: string;
  quantity: number;
}

export interface FulfilmentBatch {
  /** Opaque, URL-safe key for the consolidation document (`C41`). Not the month:
   *  one month can hold several consolidations once a batch has been sealed. */
  cycle: string;
  /** `CON/2026-27/00001` — the document number, shown beside the month so two
   *  cycles in the same month are told apart at a glance. */
  consolidation_no?: string | null;
  /** OPEN accepts new indents; SEALED means the membership below is final. */
  consolidation_status?: string | null;
  month_label: string;
  /** Members of the document — frozen once it is sealed, and the same number every
   *  other screen reports for this cycle. */
  indent_count: number;
  /** How many of those members still owe stock. This is what the queue is for. */
  owed_indent_count?: number;
  /** Members whose allocation is already raised and awaiting approval. Not
   *  allocatable (a second proposal is refused) and not done. */
  in_approval_indent_count?: number;
  item_count: number;
  /** Items/lines that still owe something — what the cycle screen actually lists.
   *  `item_count` above is the document's total and will be larger. */
  owed_item_count?: number;
  owed_line_count?: number;
  line_count?: number;
  requester_count: number;
  urgent_count: number;
  /** Mixed units added together — kept for old callers, never shown to a user. */
  total_qty: number;
  totals_by_uom?: UomTotal[];
  oldest_raised_at?: string | null;
}

export interface BatchDemand {
  items: BatchDemandItem[];
  total: number;
}
