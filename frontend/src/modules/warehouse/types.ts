/**
 * Warehouse module types.
 *
 * Field names mirror the backend response, which in turn mirrors the frozen tables
 * (`inb_*`, `out_*`, `whs_*`, `pro_returns`). Nothing is renamed on the way in — a
 * screen that reads `total_accepted_qty` reads the column of that name, so a wrong
 * number can be traced to a row without a translation layer in between.
 *
 * Transaction rows carry their snapshot columns (`item_code`, `item_name`,
 * `uom_code`, every `*_name`), so a list screen renders from one payload and never
 * fans out to fetch a vendor or an item.
 */

/** The paginated envelope every list endpoint returns. */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

export interface ListParams {
  page?: number;
  size?: number;
  search?: string;
  status?: string;
  warehouse_id?: number;
  date_from?: string;
  date_to?: string;
}

/* ---------------------------------------------------------------- statuses -- */

export type ReceiptStatus =
  | "DRAFT" | "GATE_ENTRY" | "SUBMITTED" | "PENDING_QC" | "QC_PASSED" | "QC_FAILED"
  | "PARTIALLY_RECEIVED" | "RECEIVED" | "COMPLETED" | "CANCELLED";

// PENDING_APPROVAL and REJECTED are outward QC only, and only where a QC_OUTWARD
// ladder is configured. An inbound inspection never reaches either.
export type InspectionStatus =
  | "DRAFT" | "IN_PROGRESS" | "PENDING_APPROVAL" | "COMPLETED" | "REJECTED" | "CANCELLED";
export type InspectionResult = "PENDING" | "PASSED" | "FAILED" | "PARTIAL";

export type PutawayStatus =
  | "draft" | "pending" | "in_progress" | "completed" | "cancelled" | "skipped";

export type PickingStatus =
  | "DRAFT" | "RELEASED" | "IN_PROGRESS" | "PICKED" | "COMPLETED" | "CANCELLED";

export type IssueStatus =
  | "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "ISSUED"
  | "DISPATCHED" | "ACKNOWLEDGED" | "PARTIALLY_RETURNED" | "RETURNED"
  | "CANCELLED";

// REJECTED was missing. The backend has always been able to set it (a release turned
// down on Approvals lands there), so the queue could hold a row this union said was
// impossible: the Status column fell to its grey fallback and the status filter had no
// such option. Any rung `DispatchStatus` gains needs a tone in
// `components/ConsignmentStatusPill` and a value in `pages/Consignments` STATUS_VALUES,
// or it renders grey and cannot be filtered on.
export type DispatchStatus =
  | "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "PACKED" | "DISPATCHED"
  | "IN_TRANSIT" | "DELIVERED" | "ACKNOWLEDGED" | "CANCELLED";

export type ReturnStatus =
  | "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "DISPATCHED"
  | "COMPLETED" | "CANCELLED";

/* --------------------------------------------------------------- warehouse -- */

/** `whs_warehouses`. */
export interface Warehouse {
  id: number;
  code: string;
  name: string;
  facility_id?: number | null;
  facility_name?: string | null;
  office_id?: number | null;
  office_name?: string | null;
  warehouse_type: string;
  address?: string | null;
  incharge_id?: number | null;
  incharge_name?: string | null;
  /** When false the warehouse stocks in bulk and every `bin_id` stays 0. */
  is_bin_managed: boolean;
  /** Does an arriving consignment go through Material Inward, GRN and QC before its
   *  stock counts? `null` follows the company default in Settings. */
  requires_inward?: boolean | null;
  is_active: boolean;
  created_at?: string;
}

export interface WarehouseWrite {
  code: string;
  name: string;
  facility_id?: number | null;
  office_id?: number | null;
  warehouse_type: string;
  address?: string | null;
  incharge_id?: number | null;
  is_bin_managed: boolean;
  requires_inward?: boolean | null;
  is_active: boolean;
}

/**
 * A row of `whs_warehouse_locations`. Block, lane, rack, shelf and bin are all this
 * one table at different depths — there is no separate bins table. Only `BIN` and
 * `COLD_STORAGE_BIN` rows hold stock, which is what `is_pickable` reports.
 */
export interface Bin {
  id: number;
  warehouse_id: number;
  code: string;
  name?: string | null;
  description?: string | null;
  parent_id?: number | null;
  bin_type?: string | null;
  storage_type_id?: number | null;
  barcode?: string | null;
  floor_level?: number | null;
  shelf_level?: number | null;
  /** Ancestry, e.g. `block A/flr-1/rack-1`. Derived by the tree endpoint. */
  path?: string | null;
  /** Depth in the tree, 1 at the root. Derived by the tree endpoint. */
  level?: number | null;
  capacity_qty?: number | null;
  /** The USABLE cube on a decorated row: stated (or worked out from the three sides
   *  below) and then derated by the void factor. A screen never re-derives it. */
  capacity_volume?: number | null;
  max_weight_capacity?: number | null;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  /** "This bay takes one euro-pallet, or four totes" — the gate no cube expresses. */
  max_handling_units?: number | null;
  /** Void factor, 1-100. Null means 100%: nobody has derated this location. */
  fill_efficiency_pct?: number | null;
  aisle_width_meters?: number | null;
  temperature_controlled?: boolean;
  humidity_percentage?: number | null;
  target_temperature_celsius?: number | null;
  min_temperature_celsius?: number | null;
  max_temperature_celsius?: number | null;
  is_pickable: boolean;
  is_active: boolean;
  /** Present only on the tree endpoint. */
  children?: Bin[];
  /** Filled by the tree endpoint so a zone can show how full it is. */
  occupied_qty?: number | null;
  /**
   * Volume, in cubic metres, filled by the suggested-bins endpoint. Read from the
   * handling units the stock in this bin comes to, never stored — so it is absent
   * (not zero) on the endpoints that do not work it out.
   */
  occupied_volume?: number | null;
  free_volume?: number | null;
  utilisation_pct?: number | null;
  capacity_status?: CapacityStatus | null;
  /** True when some of the stock here has no measured pack, so the figure is a floor. */
  is_partial?: boolean | null;
  /** The discrete and payload gates — a bay at its pallet limit is full whatever
   *  its cube says, which is why a chip shows these beside the bar. */
  capacity_units?: number | null;
  occupied_units?: number | null;
  capacity_weight_kg?: number | null;
  occupied_weight_kg?: number | null;
  /**
   * What this bin says about the LOAD IN HAND, as opposed to how full it is in
   * general. Set only on the suggested-bins endpoint, which is RANKED on it:
   * `capacity_status` describes the shelf, `fit_status` is the decision, and the two
   * differ exactly where it matters — a nine-tenths empty bay a pallet does not enter.
   */
  fit_status?: CapacityStatus | null;
  /** Does ONE unit of the chosen pack physically go in? Null when either is unmeasured. */
  fits_pack?: boolean | null;
  /** How many more of this pack it would still take — stated, or slotted from the sides. */
  slots_free?: number | null;
  slot_capacity?: number | null;
}

/**
 * What a location can be told about itself. Served by the backend
 * (`modules/warehouse/capacity.py`) along with the words to say — a screen picks a
 * colour from this and never writes the sentence.
 */
export type CapacityStatus =
  | "OK"
  | "TIGHT"
  | "FULL"
  | "OVER"
  /** The bounding box says no: the pack does not physically enter the location,
   *  however much cube is left in it. */
  | "WONT_FIT"
  | "NO_CAPACITY"
  | "UNMEASURED";

/** Which of the four checks a gate is. */
export type CapacityGateKey = "VOLUME" | "WEIGHT" | "FOOTPRINT" | "UNITS";

/**
 * One of the four independent checks a location is put through.
 *
 * Every gate carries the same shape whether it measures a cube, a payload, a count, or
 * answers a plain yes/no, so one component renders all four and adds no arithmetic of
 * its own. FOOTPRINT is a verdict rather than a fraction — a pallet either enters the
 * bay or it does not — so its numeric fields are null and only `status` and `detail`
 * say anything.
 */
export interface CapacityGate {
  key: CapacityGateKey;
  label: string;
  unit?: string | null;
  status: CapacityStatus;
  capacity?: number | null;
  occupied?: number | null;
  projected?: number | null;
  free?: number | null;
  over_by?: number | null;
  pct?: number | null;
  detail: string;
  /** The caveat under the bar — a derated capacity, an unweighed line, a container
   *  that may not be turned. Null when there is nothing to add. */
  note?: string | null;
}

/**
 * One packaging unit an item can move in — a rung of its ladder, resolved.
 *
 * Served by the backend so the volume on the picker is the volume the bin check will
 * use. `dims_from` says whether the box was measured on this rung or inherited from
 * the container type, because a storekeeper comparing two items deserves to know.
 */
export interface HandlingUnit {
  item_packaging_id?: number | null;
  item_id?: number | null;
  level: number;
  package_id?: number | null;
  package_name?: string | null;
  /** How many base units ONE of these holds — the conversion factor, multiplied up
   *  through every rung below it. */
  base_qty?: number | null;
  uom_code?: string | null;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  volume_cbm?: number | null;
  gross_weight_kg?: number | null;
  tare_weight_kg?: number | null;
  max_stack_tiers?: number | null;
  is_rotatable?: boolean | null;
  fill_efficiency_pct?: number | null;
  is_default: boolean;
  is_measured: boolean;
  dims_from?: "RUNG" | "PACKAGE" | null;
}

/**
 * One proposed movement, resolved into the handling units it actually is.
 *
 * `qty` is in the item's own UOM; `handling_units` is what that comes to in whole
 * packs, because half a case still occupies a case's footprint.
 */
export interface OccupancyLine {
  item_id?: number | null;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  qty?: number | null;
  direction: "IN" | "OUT";
  item_packaging_id?: number | null;
  pack_name?: string | null;
  pack_level?: number | null;
  pack_base_qty?: number | null;
  pack_volume_cbm?: number | null;
  pack_gross_weight_kg?: number | null;
  handling_units?: number | null;
  /** Null when the pack has never been measured — listed anyway, so it can be named. */
  volume?: number | null;
  weight?: number | null;
}

/**
 * How full one storage location is, and what a proposed move would do to it.
 *
 * Space is measured in HANDLING UNITS, never in loose per-unit volume: a quantity is
 * converted to whole packs and each pack carries its own outer box and gross weight.
 * So `gates` is four answers, not one — the cube, the payload, whether a unit
 * physically enters the location, and the discrete limit on how many it takes.
 *
 * `capacity_volume` is the usable cube and is null when the location has none
 * configured — not zero, which would read as "no room at all". `headline` and `detail`
 * are sentences from the server; the screen renders them rather than composing its
 * own, so putaway and material issue say the same thing about the same state.
 */
export interface LocationOccupancy {
  location_id: number;
  location_code: string;
  location_name?: string | null;
  bin_type?: string | null;
  is_pickable: boolean;
  /** How many locations the figure sums over — 1 for a bin, more for a rack. */
  counts_locations: number;

  capacity_volume?: number | null;
  /** Before the void factor, so a screen can show what was derated from. */
  stated_volume?: number | null;
  fill_efficiency_pct?: number | null;
  occupied_volume: number;
  free_volume?: number | null;
  utilisation_pct?: number | null;
  projected_volume?: number | null;
  projected_free_volume?: number | null;
  projected_pct?: number | null;
  over_by?: number | null;

  /** The whole verdict, gate by gate, ordered as the storekeeper should read them. */
  gates: CapacityGate[];
  capacity_weight_kg?: number | null;
  occupied_weight_kg?: number | null;
  projected_weight_kg?: number | null;
  capacity_units?: number | null;
  occupied_units?: number | null;
  projected_units?: number | null;
  location_length_cm?: number | null;
  location_width_cm?: number | null;
  location_height_cm?: number | null;

  /** Stock here whose item has no measured pack, so the bar is a floor, not a total. */
  unmeasured_items: number;
  unmeasured_qty?: number | null;
  measured_items: number;
  unmeasured_lines: number;
  is_partial: boolean;

  item_id?: number | null;
  item_name?: string | null;
  qty?: number | null;
  item_packaging_id?: number | null;
  pack_name?: string | null;
  pack_base_qty?: number | null;
  pack_volume_cbm?: number | null;
  /** The pack's own sides, so the fit diagram is drawn from data rather than guessed. */
  pack_length_cm?: number | null;
  pack_width_cm?: number | null;
  pack_height_cm?: number | null;
  pack_gross_weight_kg?: number | null;
  direction: "IN" | "OUT";
  move_volume?: number | null;
  move_weight?: number | null;
  move_units?: number | null;
  lines: OccupancyLine[];

  status: CapacityStatus;
  headline: string;
  detail: string;
}

/** One line of a draft, as the screen has it so far. */
export interface OccupancyMove {
  location_id: number;
  item_id: number;
  qty: number;
  direction: "IN" | "OUT";
  /** Which rung of the item's ladder this quantity moves in. Omitted falls back to the
   *  item's default putaway unit, which is what an issue or a transfer wants: the goods
   *  are already packed the way they are packed. */
  item_packaging_id?: number | null;
}

export interface BinWrite {
  warehouse_id: number;
  code: string;
  name?: string | null;
  description?: string | null;
  parent_id?: number | null;
  bin_type: string;
  capacity_qty?: number | null;
  storage_type_id?: number | null;
  barcode?: string | null;
  floor_level?: number | null;
  shelf_level?: number | null;
  /** Leave blank and the cube is worked out from the three sides below, so a location
   *  measured once needs nothing typed twice. */
  capacity_volume?: number | null;
  max_weight_capacity?: number | null;
  /** The location's own inner box. A pallet whose cube fits a bay it is too wide to
   *  enter does not fit, and only these three can say so. */
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  /** "This bay takes one euro-pallet, or four totes" — the gate no cube expresses. */
  max_handling_units?: number | null;
  /** Void factor, 1-100. Blank means 100%: nobody has derated this location. */
  fill_efficiency_pct?: number | null;
  aisle_width_meters?: number | null;
  temperature_controlled?: boolean;
  humidity_percentage?: number | null;
  target_temperature_celsius?: number | null;
  min_temperature_celsius?: number | null;
  max_temperature_celsius?: number | null;
  is_active: boolean;
}

/** `whs_locations` — the physical/3D layer, separate from the logical bin tree. */
export interface WarehouseLocation {
  id: number;
  warehouse_id: number;
  parent_location_id?: number | null;
  storage_type?: string | null;
  storage_type_id?: number | null;
  code: string;
  name?: string | null;
  description?: string | null;
  barcode?: string | null;
  floor_level?: number | null;
  shelf_level?: number | null;
  capacity_weight?: number | null;
  capacity_volume?: number | null;
  max_weight_capacity?: number | null;
  height_cm?: number | null;
  aisle_width_meters?: number | null;
  temperature_controlled: boolean;
  humidity_percentage?: number | null;
  target_temperature_celsius?: number | null;
  min_temperature_celsius?: number | null;
  max_temperature_celsius?: number | null;
  is_active: boolean;
}

export interface StorageType {
  id: number;
  code?: string | null;
  name: string;
  description?: string | null;
  is_active: boolean;
}

export interface StorageTypeWrite {
  code?: string | null;
  name: string;
  description?: string | null;
  is_active: boolean;
}

/* ------------------------------------------------------------------ inward -- */

/** `inb_receipts`. `receipt_type` separates a gate entry from a purchase GRN. */
export interface Receipt {
  id: number;
  grn_no: string;
  receipt_type: string;
  grn_date: string;
  po_id?: number | null;
  po_no?: string | null;
  /** The vendor's despatch note this delivery arrived on, when they filed one. */
  despatch_note_id?: number | null;
  despatch_note_no?: string | null;
  transfer_id?: number | null;
  transfer_no?: string | null;
  vendor_id?: number | null;
  vendor_name?: string | null;
  vendor_gstin?: string | null;
  warehouse_id: number;
  warehouse_name?: string | null;
  project_id?: number | null;
  project_name?: string | null;
  invoice_no?: string | null;
  invoice_date?: string | null;
  invoice_amount?: number | null;
  eway_bill_no?: string | null;
  vehicle_no?: string | null;
  transporter_name?: string | null;
  lr_no?: string | null;
  gate_entry_no?: string | null;
  gate_entry_at?: string | null;
  status: ReceiptStatus;
  total_items: number;
  total_received_qty: number;
  total_accepted_qty: number;
  total_rejected_qty: number;
  total_value: number;
  is_stock_posted: boolean;
  posted_at?: string | null;
  received_by_id?: number | null;
  received_by_name?: string | null;
  remarks?: string | null;
  created_by_id?: number | null;
  created_by_name?: string | null;
  created_at?: string;
  updated_at?: string;
  /** Detail responses only. */
  items?: ReceiptItem[];
}

/** `inb_receipt_items`. */
export interface ReceiptItem {
  id: number;
  receipt_id: number;
  line_no: number;
  po_item_id?: number | null;
  indent_id?: number | null;
  indent_no?: string | null;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  is_asset?: boolean;
  is_serial_tracked?: boolean;
  is_imei_tracked?: boolean;
  ordered_qty: number;
  received_qty: number;
  accepted_qty: number;
  rejected_qty: number;
  short_qty: number;
  rate?: number | null;
  amount?: number | null;
  batch_id: number;
  batch_no?: string | null;
  mfg_date?: string | null;
  expiry_date?: string | null;
  bin_id: number;
  bin_code?: string | null;
  qc_status: string;
  rejection_reason?: string | null;
  remarks?: string | null;
  serial_numbers?: string[] | null;
  imei_numbers?: string[] | null;
}

export interface ReceiptItemWrite {
  id?: number;
  po_item_id?: number | null;
  indent_id?: number | null;
  item_id: number;
  /** Labels only, so a line pulled from a PO can name its item before it is saved.
   *  The service snapshots both from the item master and ignores what is sent. */
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  is_asset?: boolean;
  is_serial_tracked?: boolean;
  is_imei_tracked?: boolean;
  ordered_qty?: number;
  received_qty: number;
  accepted_qty?: number;
  rejected_qty?: number;
  rate?: number | null;
  batch_no?: string | null;
  mfg_date?: string | null;
  expiry_date?: string | null;
  bin_id?: number | null;
  rejection_reason?: string | null;
  remarks?: string | null;
  serial_numbers?: string[] | null;
  imei_numbers?: string[] | null;
}

export interface ReceiptWrite {
  receipt_type: string;
  grn_date: string;
  po_id?: number | null;
  /** Typed on a gate entry, straight off the driver's paperwork. Ignored when
   *  `po_id` is set — a PO-backed receipt takes the order's own number. */
  po_no?: string | null;
  /** The vendor's despatch note this delivery arrived on. The server copies its
   *  paperwork and per-line batch/expiry; only the id is sent. */
  despatch_note_id?: number | null;
  /** The incoming consignment an MDP / LIP / warehouse is inwarding, on a
   *  `DISPATCH` receipt. */
  dispatch_id?: number | null;
  vendor_id?: number | null;
  warehouse_id: number;
  project_id?: number | null;
  invoice_no?: string | null;
  invoice_date?: string | null;
  invoice_amount?: number | null;
  eway_bill_no?: string | null;
  vehicle_no?: string | null;
  transporter_name?: string | null;
  lr_no?: string | null;
  gate_entry_no?: string | null;
  remarks?: string | null;
  items: ReceiptItemWrite[];
}

/** `inb_inspections`. */
export interface Inspection {
  id: number;
  inspection_no: string;
  inspection_date: string;
  receipt_id?: number | null;
  grn_no?: string | null;
  warehouse_id?: number | null;
  warehouse_name?: string | null;
  vendor_id?: number | null;
  vendor_name?: string | null;
  inspection_type: string;
  status: InspectionStatus;
  total_items: number;
  passed_items: number;
  failed_items: number;
  inspector_id?: number | null;
  inspector_name?: string | null;
  remarks?: string | null;
  created_at?: string;
  items?: InspectionItem[];
}

/** A single measured parameter on an inspection line, stored in the `parameters` JSON. */
export interface InspectionParameter {
  name: string;
  expected?: string | null;
  observed?: string | null;
  result?: "PASS" | "FAIL" | null;
}

/** `inb_inspection_items`. */
export interface InspectionItem {
  id: number;
  inspection_id: number;
  receipt_item_id?: number | null;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  batch_no?: string | null;
  inspected_qty: number;
  accepted_qty: number;
  rejected_qty: number;
  parameters?: InspectionParameter[] | null;
  result: InspectionResult;
  defect_type?: string | null;
  rejection_reason?: string | null;
  remarks?: string | null;
  serial_numbers?: string[] | null;
  imei_numbers?: string[] | null;
}

export interface InspectionItemWrite {
  id?: number;
  receipt_item_id?: number | null;
  item_id: number;
  /* Carried off the GRN line purely so a NEW inspection can name its items. The
   * saved document has its own snapshot columns; before the first save there is no
   * saved line, and the form fell back to "Item 1" for a row the GRN plainly called
   * "Dolo 650 Tablet". Ignored by the API. */
  item_code?: string | null;
  item_name?: string | null;
  batch_no?: string | null;
  inspected_qty: number;
  accepted_qty: number;
  rejected_qty: number;
  parameters?: InspectionParameter[] | null;
  result: InspectionResult;
  defect_type?: string | null;
  rejection_reason?: string | null;
  remarks?: string | null;
  serial_numbers?: string[] | null;
  imei_numbers?: string[] | null;
}

export interface InspectionWrite {
  inspection_date: string;
  receipt_id?: number | null;
  warehouse_id?: number | null;
  inspection_type: string;
  inspector_id?: number | null;
  remarks?: string | null;
  items: InspectionItemWrite[];
}

export interface OutboundInspection {
  id: number;
  inspection_no: string;
  inspection_date: string;
  issue_id: number;
  issue_no?: string | null;
  warehouse_id?: number | null;
  warehouse_name?: string | null;
  status: InspectionStatus;
  total_items: number;
  passed_items: number;
  failed_items: number;
  inspector_id?: number | null;
  inspector_name?: string | null;
  remarks?: string | null;
  created_at?: string;
  items?: OutboundInspectionItem[];
  current_approver_name?: string | null;
  approved_by_name?: string | null;
  approved_at?: string | null;
}

export interface OutboundInspectionItem {
  id: number;
  inspection_id: number;
  issue_item_id?: number | null;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  batch_no?: string | null;
  inspected_qty: number;
  accepted_qty: number;
  rejected_qty: number;
  parameters?: InspectionParameter[] | null;
  result: InspectionResult;
  defect_type?: string | null;
  rejection_reason?: string | null;
  remarks?: string | null;
  serial_numbers?: string[] | null;
}

export interface OutboundInspectionItemWrite {
  id?: number;
  issue_item_id?: number | null;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  batch_no?: string | null;
  inspected_qty: number;
  accepted_qty: number;
  rejected_qty: number;
  parameters?: InspectionParameter[] | null;
  result: InspectionResult;
  defect_type?: string | null;
  rejection_reason?: string | null;
  remarks?: string | null;
  serial_numbers?: string[] | null;
}

export interface OutboundInspectionWrite {
  inspection_date: string;
  issue_id: number;
  warehouse_id?: number | null;
  inspector_id?: number | null;
  remarks?: string | null;
  items: OutboundInspectionItemWrite[];
}

/** `whs_warehouse_items` — one putaway task per received line. */
export interface Putaway {
  id: number;
  putaway_no: string;
  grn_id?: number | null;
  grn_no?: string | null;
  grn_item_id?: number | null;
  warehouse_id: number;
  warehouse_name?: string | null;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_id?: number | null;
  uom_code?: string | null;
  batch_id?: number | null;
  batch_no?: string | null;
  expiry_date?: string | null;
  qty: number;
  suggested_bin_id?: number | null;
  suggested_bin_code?: string | null;
  actual_bin_id?: number | null;
  actual_bin_code?: string | null;
  /** The full storage path, e.g. `block A / flr-1 / lane -1 / rack-1 / shf-1 / bin A1`. */
  actual_bin_path?: string | null;
  /** `LOT/WH10/A-F1-L1-R1-S1-A1/2026-27/00001`. Stamped at confirm, empty before. */
  lot_no?: string | null;
  putaway_type: "system_directed" | "manual";
  status: PutawayStatus;
  assigned_to?: number | null;
  assigned_to_name?: string | null;
  scanned_by?: number | null;
  scanned_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  remarks?: string | null;
  serial_numbers?: string[] | null;
  imei_numbers?: string[] | null;
  /** Serials are optional upstream but mandatory here — the screen asks when this is set. */
  is_serial_tracked?: boolean;
  is_imei_tracked?: boolean;
  is_asset?: boolean;
  /** WHICH pack this task is in. "3 cases" and "1500 eaches" are the same `qty` and
   *  need entirely different shelf space, so the task carries the rung. */
  item_packaging_id?: number | null;
  package_id?: number | null;
  package_name?: string | null;
  pack_base_qty?: number | null;
  pack_volume_cbm?: number | null;
  pack_gross_weight_kg?: number | null;
  /** `ceil(qty / pack_base_qty)` — whole packs, because half a case still occupies a
   *  case's footprint. Null when the item has no measured packaging unit. */
  handling_units?: number | null;
  line_volume_cbm?: number | null;
  line_weight_kg?: number | null;
  /** Every rung this item could be put away in, so the picker needs no second call. */
  packs?: HandlingUnit[];
  /**
   * Only on the response to `confirm`: the shelf as it was at the moment of the press,
   * overflow included. A full bin never stops a putaway, so this is how the screen
   * gets to announce one that has already happened.
   */
  capacity?: LocationOccupancy | null;
  created_at?: string;
}

/** One printable identity minted by a putaway. */
export interface PutawayUnitCode {
  id: number;
  /** What the QR carries and what is printed under it. */
  code: string;
  code_type: "ASSET" | "CONSUMABLE" | "SERIAL";
  /** UNIT is one physical thing; LOT is the whole balance row, which is all a
   *  measured item can carry — 30 grams is one lot, not 30 things to label. */
  scope: "UNIT" | "LOT";
  serial_number?: string | null;
  imei?: string | null;
  status?: string | null;
}

/**
 * `GET /warehouse/putaways/{id}/codes` — the label sheet's HEADER: what this putaway
 * minted, how many, and the item, batch and location they name.
 *
 * It carries no codes, only `total_codes`: opening the panel must not depend on how big
 * the lorry was. The codes come a page at a time from `/codes/units`.
 */
export interface PutawayCodes {
  putaway_id: number;
  putaway_no?: string | null;
  status: string;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  batch_id?: number | null;
  batch_no?: string | null;
  /** Warranty end for an asset, expiry for anything else — labelled off `is_asset`. */
  expiry_date?: string | null;
  is_asset?: boolean;
  warehouse_id?: number | null;
  warehouse_name?: string | null;
  bin_id?: number | null;
  bin_code?: string | null;
  bin_path?: string | null;
  lot_no?: string | null;
  qty?: number | null;
  completed_at?: string | null;
  is_code_tracked?: boolean;
  code_type?: "ASSET" | "CONSUMABLE" | null;
  /** How many codes this putaway minted. A count, so the panel can say "500 codes"
   *  and size its pager without pulling five hundred rows to find out. */
  total_codes: number;
  /** Why the sheet is empty. Served, never composed in the screen. */
  reason?: string | null;
}

export interface PutawayConfirm {
  actual_bin_id: number;
  qty?: number;
  /** The rung being put away. Omitted falls back to the task's own, then to the item's
   *  default putaway unit — so an untouched screen still measures the load. */
  item_packaging_id?: number | null;
  remarks?: string | null;
  serial_numbers?: string[] | null;
  imei_numbers?: string[] | null;
}

/** A GRN line offered to the manual putaway picker. */
export interface PutawayCandidate {
  grn_item_id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  batch_no?: string | null;
  accepted_qty: number;
  qc_status?: string | null;
  existing_putaway_no?: string | null;
  eligible: boolean;
  /** Why not, when `eligible` is false. Shown beside the greyed-out line. */
  reason?: string | null;
}

/** Empty `grn_item_ids` means every eligible line on the GRN. */
export interface PutawayCreate {
  grn_id: number;
  grn_item_ids: number[];
}

/* ----------------------------------------------------------------- outward -- */

/** `out_picking`. */
export interface Picking {
  id: number;
  pick_no: string;
  pick_date: string;
  warehouse_id: number;
  warehouse_name?: string | null;
  ref_type?: string | null;
  ref_id?: number | null;
  ref_no?: string | null;
  strategy?: string | null;
  status: PickingStatus;
  total_lines: number;
  picked_lines: number;
  assigned_to_id?: number | null;
  assigned_to_name?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at?: string;
  items?: PickingItem[];
}

/** `out_picking_items`. */
export interface PickingItem {
  id: number;
  picking_id: number;
  line_no: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  is_serial_tracked?: boolean;
  is_imei_tracked?: boolean;
  bin_id?: number | null;
  bin_code?: string | null;
  batch_id?: number | null;
  batch_no?: string | null;
  required_qty: number;
  picked_qty: number;
  status: string;
  picked_by_id?: number | null;
  picked_at?: string | null;
}

export interface PickingWrite {
  pick_date: string;
  warehouse_id: number;
  ref_type?: string | null;
  ref_id?: number | null;
  strategy?: string | null;
  assigned_to_id?: number | null;
  items: { item_id: number; bin_id?: number | null; batch_id?: number | null; required_qty: number }[];
}

/** `out_issues`. `direction` is `OUT` for an issue and `IN` for a return against one. */
export interface Issue {
  id: number;
  issue_no: string;
  issue_type: string;
  issue_date: string;
  indent_id?: number | null;
  indent_no?: string | null;
  picking_id?: number | null;
  pick_no?: string | null;
  warehouse_id: number;
  warehouse_name?: string | null;
  department_id?: number | null;
  department_name?: string | null;
  project_id?: number | null;
  project_name?: string | null;
  vehicle_id?: number | null;
  vehicle_number?: string | null;
  issued_to_id?: number | null;
  issued_to_name?: string | null;
  destination_office_id?: number | null;
  destination_office_name?: string | null;
  /** Service area code of the destination office, resolved from HCM when the issue is
   *  served. Null for offices HCM holds no SAC for. */
  destination_office_sac?: string | null;
  direction: "OUT" | "IN";
  original_issue_id?: number | null;
  original_issue_no?: string | null;
  status: IssueStatus;
  total_items: number;
  total_qty: number;
  total_value: number;
  is_stock_posted: boolean;
  posted_at?: string | null;
  current_approver_name?: string | null;
  approved_by_name?: string | null;
  approved_at?: string | null;
  acknowledged_by_name?: string | null;
  acknowledged_at?: string | null;
  issued_by_id?: number | null;
  issued_by_name?: string | null;
  remarks?: string | null;
  created_by_id?: number | null;
  created_by_name?: string | null;
  created_at?: string;
  updated_at?: string;
  qc_status?: string | null;
  items?: IssueItem[];
  /**
   * Is this document waiting on ME right now? Served only by the detail endpoint.
   *
   * Not the same question as `<Can do="issue.issue">`: every warehouse post shares one
   * HCM rank, so all eleven holders have that permission on every issue, but only the
   * one named in the approval chain may act. Gate the Approve button on this.
   */
  can_approve?: boolean;
  /**
   * False until the indent raiser has confirmed this issue's quantities in My
   * deliveries. Per ISSUE, not per indent: a 10-unit indent served by a 4-unit issue
   * unlocks once those 4 are confirmed. Gate the Acknowledge button on this.
   */
  can_acknowledge?: boolean;
}

/**
 * One `wf_actions` row, as served by `/api/workflow/history/{doc_type}/{doc_id}`.
 *
 * A document's own columns only carry the FINAL approval (`approved_at` is written
 * when the whole ladder completes), so a two-rung ladder's first approval exists
 * nowhere on the document. The engine records every rung here; a progress panel that
 * wants to show them has to read this.
 */
export interface ApprovalEvent {
  stage_sequence: number;
  stage_name?: string | null;
  actor_id?: number | null;
  actor_name?: string | null;
  actor_position?: string | null;
  action: string;
  comments?: string | null;
  acted_at?: string | null;
}

/** `out_issue_items`. */
export interface IssueItem {
  id: number;
  issue_id: number;
  line_no: number;
  indent_item_id?: number | null;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  is_serial_tracked?: boolean;
  is_imei_tracked?: boolean;
  bin_id?: number | null;
  bin_code?: string | null;
  batch_id?: number | null;
  batch_no?: string | null;
  expiry_date?: string | null;
  requested_qty: number;
  issued_qty: number;
  returned_qty: number;
  rate?: number | null;
  amount?: number | null;
  remarks?: string | null;
  serial_numbers?: string[] | null;
  imei_numbers?: string[] | null;
  /** Which identifier names one unit of this item: SERIAL -> IMEI -> CODE. */
  unit_mode?: UnitMode | null;
  /** What KIND of identifier that is, for the badge. Wider than `unit_mode`: an
   *  asset tag and a consumable lot code are the same column to the matcher and
   *  two different labels on the goods. */
  tracking_type?: TrackingType | null;
  /** The reserved units, stated in that same currency. */
  unit_keys?: string[] | null;
  /** Whether the item has identified units in stock at all. */
  has_units?: boolean;
  /**
   * How many units THIS line's own batch and bin can still give it. Served, never
   * counted in the screen: after approval the batch is frozen, so a line the batch
   * cannot serve has to be visible while it is still editable.
   */
  units_available?: number | null;
}

export type UnitMode = "SERIAL" | "IMEI" | "CODE";

/** What a storekeeper is being asked to read off the goods. Served — see
 *  `trackingTypes()` and the backend's `enums.TRACKING_META`. */
export type TrackingType = "SERIAL" | "IMEI" | "ASSET" | "CONSUMABLE" | "NONE";

export interface TrackingTypeMeta {
  code: TrackingType;
  /** Names the badge. */
  label: string;
  /** Names one of them in a sentence: "3 of 5 asset tags". */
  unit: string;
  /** What to read off the goods. */
  hint: string;
}

/** One (batch, bin) an issue line can draw from, and what it holds. The unit of a
 *  split: a quantity larger than any single source becomes several of these. */
export interface IssueStockSource {
  item_id: number;
  bin_id?: number | null;
  bin_code?: string | null;
  bin_name?: string | null;
  batch_id?: number | null;
  batch_no?: string | null;
  expiry_date?: string | null;
  mfg_date?: string | null;
  /** Free to anybody. NOT what this document may draw — see `drawable_qty`. */
  available_qty: number;
  /** Held by every document, this one included. */
  reserved_qty: number;
  /** The part of that hold belonging to THIS issue's own indent. An approved
   *  allocation reserves the stock it is about to issue, so a document issuing
   *  exactly what was reserved for it sees `available_qty` at zero over goods that
   *  are on the shelf and spoken for by itself. */
  own_reserved_qty: number;
  total_qty: number;
  /** `available_qty + own_reserved_qty` — what a line here may actually take. */
  drawable_qty: number;
}

export interface IssueItemWrite {
  id?: number;
  indent_item_id?: number | null;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  is_serial_tracked?: boolean;
  unit_mode?: UnitMode | null;
  tracking_type?: TrackingType | null;
  unit_keys?: string[] | null;
  has_units?: boolean;
  units_available?: number | null;
  // Carried on the line so the form knows whether to ask for a batch. Set from the
  // chosen item, alongside is_serial_tracked, when the item is picked.
  is_batch_tracked?: boolean;
  is_imei_tracked?: boolean;
  bin_id?: number | null;
  batch_id?: number | null;
  requested_qty: number;
  issued_qty?: number;
  rate?: number | null;
  remarks?: string | null;
  serial_numbers?: string[] | null;
  imei_numbers?: string[] | null;
}

export interface StockMovement {
  movement_no: string;
  movement_type: string;
  warehouse_id: number;
  warehouse_name?: string | null;
  source_bin_id: number;
  source_bin_code?: string | null;
  destination_bin_id: number;
  destination_bin_code?: string | null;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  batch_id?: number | null;
  batch_no?: string | null;
  quantity: number;
  serial_numbers: string[];
  status: string;
  moved_by_name?: string | null;
  moved_at?: string | null;
  remarks?: string | null;
}

export interface StockMovementWrite {
  movement_type: string;
  warehouse_id: number;
  source_bin_id: number;
  destination_bin_id: number;
  item_id: number;
  batch_id?: number | null;
  quantity: number;
  serial_numbers?: string[];
  remarks?: string | null;
}

export interface StockAvailability {
  available_qty: number;
  serial_numbers: string[];
}

export interface IssueWrite {
  issue_type: string;
  issue_date: string;
  indent_id?: number | null;
  picking_id?: number | null;
  warehouse_id: number;
  department_id?: number | null;
  project_id?: number | null;
  vehicle_id?: number | null;
  vehicle_number?: string | null;
  issued_to_id?: number | null;
  direction?: "OUT" | "IN";
  original_issue_id?: number | null;
  remarks?: string | null;
  items: IssueItemWrite[];
}

/** `out_dispatches`. */
export interface Dispatch {
  id: number;
  dispatch_no: string;
  dispatch_type: string;
  dispatch_date: string;
  warehouse_id: number;
  warehouse_name?: string | null;
  to_warehouse_id?: number | null;
  to_warehouse_name?: string | null;
  customer_id?: number | null;
  customer_name?: string | null;
  vendor_id?: number | null;
  vendor_name?: string | null;
  project_id?: number | null;
  project_name?: string | null;
  destination_office_id?: number | null;
  destination_office_name?: string | null;
  /** Service area code of the destination office. Same value the source issue shows. */
  destination_office_sac?: string | null;
  /** Detail read only. True when this consignment landed at a relay point that put it
   *  straight on the shelf — there is no GRN here, so the way on is the consignment. */
  can_forward?: boolean;
  delivery_address?: string | null;
  contact_person?: string | null;
  contact_phone?: string | null;
  ref_type?: string | null;
  ref_id?: number | null;
  ref_no?: string | null;
  transport_mode?: string | null;
  carrier_id?: number | null;
  carrier_name?: string | null;
  vehicle_id?: number | null;
  vehicle_number?: string | null;
  driver_name?: string | null;
  driver_phone?: string | null;
  lr_no?: string | null;
  eway_bill_no?: string | null;
  freight_amount?: number | null;
  gate_pass_no?: string | null;
  gate_out_at?: string | null;
  security_by_name?: string | null;
  status: DispatchStatus;
  total_items: number;
  total_qty: number;
  total_packages: number;
  total_weight_kg: number;
  total_value: number;
  expected_delivery?: string | null;
  delivered_at?: string | null;
  acknowledged_by_name?: string | null;
  acknowledged_at?: string | null;
  pod_url?: string | null;
  current_approver_name?: string | null;
  approved_by_name?: string | null;
  approved_at?: string | null;
  remarks?: string | null;
  created_by_id?: number | null;
  created_by_name?: string | null;
  created_at?: string;
  updated_at?: string;
  items?: DispatchItem[];
  packages?: DispatchPackage[];
  events?: DispatchEvent[];
  /** See Issue.can_approve — whose turn it is, not who holds the permission. */
  can_approve?: boolean;
}

/** `out_dispatch_items`. */
export interface DispatchItem {
  id: number;
  dispatch_id: number;
  line_no: number;
  package_id?: number | null;
  indent_id?: number | null;
  indent_no?: string | null;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  batch_id?: number | null;
  batch_no?: string | null;
  /** Snapshotted on the line, so the receiving GRN reads what was sent instead of
   *  rebuilding it from `stk_batches` — which only works while `batch_id` survives. */
  mfg_date?: string | null;
  expiry_date?: string | null;
  serial_no?: string | null;
  imei_no?: string | null;
  quantity: number;
  delivered_qty: number;
  rate?: number | null;
  amount?: number | null;
  remarks?: string | null;
}

/** `out_dispatch_packages` — the labelling unit. */
export interface DispatchPackage {
  id: number;
  dispatch_id: number;
  package_no: string;
  package_type?: string | null;
  barcode?: string | null;
  weight_kg?: number | null;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  is_fragile: boolean;
  is_temp_controlled: boolean;
  status: string;
  packed_by_name?: string | null;
  packed_at?: string | null;
}

/** `out_dispatch_events` — the custody/cold-chain trail. */
export interface DispatchEvent {
  id: number;
  dispatch_id: number;
  event_type: string;
  event_at: string;
  location_name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  temperature_c?: number | null;
  humidity_percent?: number | null;
  is_breach: boolean;
  notes?: string | null;
  recorded_by_id?: number | null;
  recorded_by_name?: string | null;
}

export interface DispatchItemWrite {
  id?: number;
  package_id?: number | null;
  indent_id?: number | null;
  item_id: number;
  batch_id?: number | null;
  serial_no?: string | null;
  quantity: number;
  rate?: number | null;
  remarks?: string | null;
}

export interface DispatchWrite {
  dispatch_type: string;
  dispatch_date: string;
  warehouse_id: number;
  to_warehouse_id?: number | null;
  customer_id?: number | null;
  vendor_id?: number | null;
  project_id?: number | null;
  delivery_address?: string | null;
  contact_person?: string | null;
  contact_phone?: string | null;
  ref_type?: string | null;
  ref_id?: number | null;
  transport_mode?: string | null;
  carrier_id?: number | null;
  vehicle_id?: number | null;
  driver_name?: string | null;
  driver_phone?: string | null;
  lr_no?: string | null;
  eway_bill_no?: string | null;
  freight_amount?: number | null;
  expected_delivery?: string | null;
  remarks?: string | null;
  items: DispatchItemWrite[];
}

export interface PackageWrite {
  package_no?: string | null;
  package_type?: string | null;
  barcode?: string | null;
  weight_kg?: number | null;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  is_fragile?: boolean;
  is_temp_controlled?: boolean;
  item_ids?: number[];
}

export interface ConsignmentPackageItemWrite {
  indent_id?: number | null;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  batch_id?: number | null;
  batch_no?: string | null;
  mfg_date?: string | null;
  expiry_date?: string | null;
  serial_no?: string | null;
  imei_no?: string | null;
  serial_numbers?: string[];
  imei_numbers?: string[];
  is_serial_tracked?: boolean;
  is_imei_tracked?: boolean;
  quantity: number;
  rate?: number | null;
  remarks?: string | null;
}

export interface ConsignmentPackageWrite {
  package_no?: string | null;
  package_type?: string | null;
  barcode?: string | null;
  weight_kg?: number | null;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  is_fragile?: boolean;
  is_temp_controlled?: boolean;
  items: ConsignmentPackageItemWrite[];
}

export interface ConsignmentWrite {
  issue_id: number;
  dispatch_type: string;
  dispatch_date: string;
  to_warehouse_id?: number | null;
  customer_id?: number | null;
  vendor_id?: number | null;
  project_id?: number | null;
  delivery_address?: string | null;
  contact_person?: string | null;
  contact_phone?: string | null;
  transport_mode?: string | null;
  carrier_id?: number | null;
  vehicle_id?: number | null;
  driver_name?: string | null;
  driver_phone?: string | null;
  lr_no?: string | null;
  eway_bill_no?: string | null;
  freight_amount?: number | null;
  expected_delivery?: string | null;
  remarks?: string | null;
  packages: ConsignmentPackageWrite[];
}

export interface IssueDispatchSourceItem extends DispatchItemWrite {
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  batch_no?: string | null;
  /** Snapshotted on the issue line, so the packer sees what is in the carton
   *  rather than a blank the receiving point has to guess at. */
  mfg_date?: string | null;
  expiry_date?: string | null;
  is_serial_tracked?: boolean;
  is_imei_tracked?: boolean;
  serial_numbers?: string[];
  /** serial -> IMEI, so a handset's number shows beside the unit it belongs to. */
  imei_by_serial?: Record<string, string>;
}

export interface IssueDispatchSource {
  issue_id: number;
  issue_no: string;
  warehouse_id: number;
  project_id?: number | null;
  destination_office_id?: number | null;
  destination_office_name?: string | null;
  destination_office_sac?: string | null;
  /** The vehicle the goods go out on, derived by the server from the issue or from
   *  the destination office's own name. Read-only on the form. */
  vehicle_number?: string | null;
  /** The stocking point serving the requesting office — what "To warehouse"
   *  defaults to. Null when that point is the origin (`destination_is_origin`). */
  destination_warehouse_id?: number | null;
  destination_warehouse_name?: string | null;
  destination_is_origin?: boolean;
  items: IssueDispatchSourceItem[];
}

export interface DispatchEventWrite {
  event_type: string;
  location_name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  temperature_c?: number | null;
  humidity_percent?: number | null;
  notes?: string | null;
}

export interface AcknowledgeWrite {
  acknowledged_by_name?: string | null;
  pod_url?: string | null;
  remarks?: string | null;
  lines?: { id: number; delivered_qty: number }[];
}

/* ------------------------------------------------------- purchase returns -- */

/** `pro_returns`. */
export interface PurchaseReturn {
  id: number;
  return_no: string;
  return_date: string;
  po_id?: number | null;
  po_no?: string | null;
  grn_id?: number | null;
  grn_no?: string | null;
  vendor_id?: number | null;
  vendor_name?: string | null;
  warehouse_id?: number | null;
  warehouse_name?: string | null;
  reason?: string | null;
  status: ReturnStatus;
  total_items: number;
  total_qty: number;
  total_value: number;
  credit_note_no?: string | null;
  created_by_id?: number | null;
  created_by_name?: string | null;
  created_at?: string;
  items?: PurchaseReturnItem[];
  /** See Issue.can_approve — whose turn it is, not who holds the permission. */
  can_approve?: boolean;
}

/** `pro_return_items`. */
export interface PurchaseReturnItem {
  id: number;
  return_id: number;
  line_no: number;
  po_item_id?: number | null;
  grn_item_id?: number | null;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  batch_id?: number | null;
  batch_no?: string | null;
  quantity: number;
  rate?: number | null;
  amount?: number | null;
  reason?: string | null;
}

export interface PurchaseReturnItemWrite {
  id?: number;
  po_item_id?: number | null;
  grn_item_id?: number | null;
  item_id: number;
  batch_id?: number | null;
  quantity: number;
  rate?: number | null;
  reason?: string | null;
}

export interface PurchaseReturnWrite {
  return_date: string;
  po_id?: number | null;
  grn_id?: number | null;
  vendor_id?: number | null;
  warehouse_id?: number | null;
  reason?: string | null;
  items: PurchaseReturnItemWrite[];
}

/* ------------------------------------------------------- serials & batches -- */

/** `whs_serial_numbers`. The asset/consumable code is generated during putaway. */
export interface SerialNumber {
  id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  is_asset?: boolean;
  serial_number: string;
  imei?: string | null;
  batch_id?: number | null;
  batch_no?: string | null;
  mfg_date?: string | null;
  expiry_date?: string | null;
  warehouse_id?: number | null;
  warehouse_name?: string | null;
  bin_id?: number | null;
  bin_code?: string | null;
  bin_floor_level?: number | null;
  asset_code?: string | null;
  consumable_code?: string | null;
  status: "available" | "issued" | "consumed" | "returned" | "maintenance" | "scrapped";
  remarks?: string | null;
  is_active: boolean;
}

/** `stk_batches`. */
export interface Batch {
  id: number;
  batch_no: string;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  is_asset?: boolean;
  vendor_id?: number | null;
  vendor_name?: string | null;
  mfg_date?: string | null;
  expiry_date?: string | null;
  received_date?: string | null;
  grn_id?: number | null;
  grn_no?: string | null;
  initial_qty: number;
  rate?: number | null;
  status: string;
  recall_reason?: string | null;
}

export interface ItemLocationBatch {
  stock_id: number;
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
}

export interface ItemLocation {
  bin_id: number;
  bin_code: string;
  location_path: string[];
  total_available: number;
  total_reserved: number;
  total_on_hand: number;
  batches: ItemLocationBatch[];
}

export interface ItemLocationsOut {
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  warehouse_id: number;
  warehouse_name?: string | null;
  total_available: number;
  total_reserved: number;
  total_on_hand: number;
  locations: ItemLocation[];
}


/* ------------------------------------------------------------- supporting -- */

/** `sys_attachments`. */
export interface Attachment {
  id: number;
  entity_type: string;
  entity_id: number;
  file_name: string;
  file_path: string;
  file_size?: number | null;
  mime_type?: string | null;
  doc_category?: string | null;
  uploaded_by_id?: number | null;
  uploaded_by_name?: string | null;
  created_at?: string;
}

/** `sys_notifications`. */
export interface Notification {
  id: number;
  employee_id: number;
  title: string;
  body?: string | null;
  entity_type?: string | null;
  entity_id?: number | null;
  deep_link?: string | null;
  is_read: boolean;
  created_at?: string;
}

/** The dashboard payload — computed server side so the screen makes one call. */
export interface WarehouseDashboard {
  pending_gate_entries: number;
  pending_grn: number;
  pending_inspections: number;
  pending_putaways: number;
  open_picklists: number;
  pending_issues: number;
  in_transit_dispatches: number;
  open_returns: number;
  stock_value: number;
  bin_utilisation_percent: number;
  recent: { id: number; doc_no: string; doc_type: string; status: string; created_at?: string | null }[];
  inward_trend: { date: string; received: number; accepted: number; rejected: number }[];
}

/** Lookup rows the forms need. Read-only, served by the module's `/options` routes. */
export interface Option {
  id: number;
  code?: string | null;
  name: string;
}

/** A stocking point in a picker. `is_bin_managed` decides whether the screen asks
 *  where the goods were put — an MDP or LIP with no bins configured is not. */
export interface WarehouseOption extends Option {
  is_bin_managed?: boolean;
  /** MAIN / CENTRAL / TRANSIT ... versus MDP or LIP. Decides how much of the GRN
   *  form is on show — the bottom of the chain receives consignments, not purchases. */
  warehouse_type?: string | null;
}

/** An incoming consignment, expanded so the inward form fills itself from it. */
export interface DispatchReceiptSource {
  dispatch_id: number;
  dispatch_no: string;
  warehouse_id: number;
  warehouse_name?: string | null;
  is_bin_managed: boolean;
  from_warehouse_id?: number | null;
  from_warehouse_name?: string | null;
  project_id?: number | null;
  dispatch_date?: string | null;
  lr_no?: string | null;
  vehicle_number?: string | null;
  indent_id?: number | null;
  indent_no?: string | null;
  items: ReceiptItemWrite[];
}

export interface ItemOption extends Option {
  uom_code?: string | null;
  is_batch_tracked?: boolean;
  is_serial_tracked?: boolean;
  is_imei_tracked?: boolean;
  is_asset?: boolean;
  requires_qi?: boolean;
}

/** An open PO line the GRN screen pulls in when a PO is chosen. */
/** One line of what the vendor says they sent, ready to become a receipt line. */
export interface DespatchPrefillLine {
  po_item_id?: number | null;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  ordered_qty: number;
  despatched_qty: number;
  rate?: number | null;
  batch_no?: string | null;
  mfg_date?: string | null;
  expiry_date?: string | null;
}

/** A vendor's despatch note in the shape the receipt form needs — the paperwork the
 *  gate would otherwise retype, plus the batch and expiry it cannot know. */
export interface DespatchPrefill {
  despatch_note_id: number;
  despatch_note_no: string;
  po_id?: number | null;
  po_no?: string | null;
  vendor_id?: number | null;
  vendor_name?: string | null;
  invoice_no?: string | null;
  invoice_date?: string | null;
  invoice_amount?: number | null;
  eway_bill_no?: string | null;
  vehicle_no?: string | null;
  transporter_name?: string | null;
  lr_no?: string | null;
  lines: DespatchPrefillLine[];
}

export interface PoLineOption {
  po_item_id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  ordered_qty: number;
  received_qty: number;
  pending_qty: number;
  rate?: number | null;
  indent_id?: number | null;
  indent_no?: string | null;
}

export interface PoPrefill {
  vendor_id?: number;
  vendor_name?: string;
  vendor_gstin?: string;
  project_id?: number;
  project_name?: string;
  lines: PoLineOption[];
}

export interface StockMovementOrderItem {
  id: number;
  order_id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  source_bin_id: number;
  source_bin_code?: string | null;
  destination_bin_id: number;
  destination_bin_code?: string | null;
  quantity: number;
  batch_id?: number | null;
  serial_numbers?: string[] | null;
}

export interface StockAvailability {
  available_qty: number;
  is_serial_tracked: boolean;
  serial_numbers: string[];
}

export interface StockMovementOrder {
  /** 0 when no approval ladder is configured and the movement completed on the press —
   *  that path writes no document row, exactly as it always did. Non-zero means there
   *  is a record to approve (2026-08-21). */
  id: number;
  order_no: string;
  warehouse_id: number;
  warehouse_name?: string | null;
  status: string;
  /** Who it is waiting on, and on which rung — "Mahendra Kumar (Warehouse Manager)". */
  current_approver_name?: string | null;
  reason?: string | null;
  created_by_name?: string | null;
  created_at?: string | null;
  items: StockMovementOrderItem[];
}

export interface StockMovementOrderItemWrite {
  item_id: number;
  source_bin_id: number;
  destination_bin_id: number;
  quantity: number;
  batch_id?: number | null;
  serial_numbers?: string[] | null;
}

export interface StockMovementOrderWrite {
  warehouse_id: number;
  reason?: string | null;
  items: StockMovementOrderItemWrite[];
}