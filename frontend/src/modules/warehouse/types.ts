import type { CombinationValue } from "@/shared/combination";
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
import type { PackEntry, PackEntryIn, PackHierarchy, PackLevel } from "@/shared/packing";

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
  | "CANCELLED"
  // A parent broken into floor issues: SPLIT while any is open, CLOSED once all have
  // posted. Rolled up by the server — never posted, edited or cancelled itself.
  | "SPLIT" | "CLOSED";

// REJECTED was missing. The backend has always been able to set it (a release turned
// down on Approvals lands there), so the queue could hold a row this union said was
// impossible: the Status column fell to its grey fallback and the status filter had no
// such option. Any rung `DispatchStatus` gains needs a tone in
// `components/ConsignmentStatusPill` and a value in `pages/Consignments` STATUS_VALUES,
// or it renders grey and cannot be filtered on.
export type DispatchStatus =
  | "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "PACKED" | "DISPATCHED"
  | "IN_TRANSIT" | "DELIVERED" | "ACKNOWLEDGED" | "CANCELLED";

// Everything after SENT_TO_VENDOR is the vendor's decision and the journey the goods
// then make — out to the vendor, and the replacement back. `StatusPill` has no tone for
// them and falls back to grey on purpose: `shared/` is the lead's (rule 4) and the pill
// takes its WORDING from the served `status_label` instead, which is where every one of
// these is turned into a sentence.
//
// IN_TRANSIT is LEGACY. It meant "on the road back from the vendor" under the older flow
// and is kept because rows may carry it; STOCK_PICKED_UP and REPLACEMENT_DISPATCHED are
// what a new return uses, and between them they say which way the goods are moving.
export type ReturnStatus =
  | "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "DISPATCHED"
  | "SENT_TO_VENDOR"
  | "VENDOR_APPROVED" | "REPLACEMENT_AGREED"
  | "AWAITING_VENDOR_VEHICLE" | "VENDOR_TRANSPORT_ACCEPTED" | "VEHICLE_REQUESTED"
  | "STOCK_PICKED_UP" | "VENDOR_RECEIVED" | "REPLACEMENT_DISPATCHED"
  | "IN_TRANSIT" | "RECEIVED_AT_WAREHOUSE" | "REFUNDED"
  | "COMPLETED" | "CANCELLED";

/** Who moves an approved return's goods out to the vendor. */
export type ReturnVehicleArrangement = "VENDOR_ARRANGES" | "WAREHOUSE_REQUESTS";

/**
 * One leg of the twelve-leg purchase-return tracker, exactly as the server decided it.
 *
 * The last four are the replacement's way back onto the shelf — `warehouse_received`,
 * `grn`, `qc`, `putaway` — and every one of them is READ off a document the store
 * already works, never off a status on the return.
 */
export interface PurchaseReturnJourneyLeg {
  key: string;
  label: string;
  /**
   * A leg this particular return will never reach — a refund never travels — reads
   * `cancelled` with a caption saying why, rather than sitting at `pending` as though
   * somebody still owed it.
   */
  state: "completed" | "current" | "pending" | "rejected" | "cancelled";
  at?: string | null;
  actor_name?: string | null;
  detail?: string | null;
  reference_no?: string | null;
}

/* --------------------------------------------------------------- warehouse -- */

/** Stock a bin-managed warehouse holds with no location (`bin_id` 0), and the
 *  Unlocated location it is placed in — see backend `warehouse/unlocated.py`.
 *  `pending_*` still stands at no location; `held_*` is in the Unlocated location;
 *  `placed_*` is what the press just moved. */
export interface UnlocatedStockStatus {
  warehouse_id: number;
  is_bin_managed: boolean;
  location_id: number | null;
  location_code: string | null;
  pending_rows: number;
  pending_qty: number | string;
  held_rows: number;
  held_items: number;
  held_qty: number | string;
  placed_rows: number;
  placed_qty: number | string;
  placed_units: number;
  stranded_units?: number;
  stranded_items?: number;
  stale_lines?: number;
  stale_issue_ids?: number[];
  repointed_lines?: number;
  code_scope?: string | null;
}

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
  latitude?: number | null;
  longitude?: number | null;
  coordinate_source?: string | null;
  coordinate_label?: string | null;
  coordinate_confidence?: number | null;
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
  latitude?: number | null;
  longitude?: number | null;
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
  /** The kind's display name, off the storage-type master. */
  storage_type_name?: string | null;
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
  /** The kind, by code. `storage_type_id` is what the form actually sends — see
   *  `StorageType`; the code is kept for callers that only know one. */
  bin_type?: string | null;
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

/** `whs_warehouse_locations` — one storage point, and where it sits in the building.
 *
 *  `path`, `level`, `parent_*` and `storage_type_name` are derived by the server on the
 *  way out, never stored: a saved path goes stale the day somebody re-parents a rack
 *  and nothing tells you it has. The floor plan draws its tree from `parent_location_id`
 *  and reads the trail off `path_names`. */
export interface WarehouseLocation {
  id: number;
  warehouse_id: number;
  parent_location_id?: number | null;
  storage_type?: string | null;
  storage_type_id?: number | null;
  storage_type_name?: string | null;
  parent_code?: string | null;
  parent_name?: string | null;
  path?: string | null;
  path_names?: string | null;
  level?: number | null;
  child_count?: number;
  is_pickable?: boolean;
  length_cm?: number | null;
  width_cm?: number | null;
  max_handling_units?: number | null;
  fill_efficiency_pct?: number | null;
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

/**
 * One KIND of storage location — floor, lane, rack, shelf, bin, cold room.
 *
 * These were an enum in the backend and a hardcoded array in this module until
 * 2026-09-05. They are a master now (`whs_warehouse_storage_types`), so a site that
 * racks its goods in carton bays adds the rung itself, and the location form reads
 * every one of its answers — which kinds exist, which may hold which, which want a
 * temperature band — off this rather than off a constant beside it.
 */
export interface StorageType {
  id: number;
  code?: string | null;
  name: string;
  description?: string | null;
  /** Depth of the rung in the building, so a list reads floor, lane, rack, shelf, bin. */
  sort_order: number;
  /** Is stock HELD here, or is this structure you walk past on the way to one? */
  is_pickable: boolean;
  /** A cold-chain kind: the location form asks for the temperature band. */
  is_temperature_controlled: boolean;
  /** May a location of this kind stand at the root of a warehouse? */
  allow_top_level: boolean;
  is_active: boolean;
  /** The kinds this one may sit inside. Ids drive the form; codes and names label it. */
  parent_type_ids: number[];
  parent_type_codes: string[];
  parent_type_names: string[];
  /** How many storage locations are of this kind — what switching it off would strand. */
  location_count: number;
}

export interface StorageTypeWrite {
  code?: string | null;
  name: string;
  description?: string | null;
  sort_order: number;
  is_pickable: boolean;
  is_temperature_controlled: boolean;
  allow_top_level: boolean;
  is_active: boolean;
  parent_type_ids: number[];
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

/** One GRN line and where it goes (`GET /receipts/{id}/routing`). */
export interface ReceiptRouteLine {
  receipt_item_id: number;
  line_no: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  received_qty: number;
  accepted_qty: number;
  rejected_qty: number;
  requires_qi: boolean;
  route: "QC" | "PUTAWAY" | "STOCK";
  qc_status?: string | null;
  putaway_id?: number | null;
  putaway_no?: string | null;
  putaway_status?: string | null;
}

/** Where a GRN's lines go: QC draft or straight to putaway. FORECAST before submit,
 *  ROUTED after, PARKED for a GRN the retired approval held with nothing raised. */
export interface ReceiptRouting {
  receipt_id: number;
  grn_no: string;
  status: string;
  stage: "FORECAST" | "PARKED" | "ROUTED";
  is_bin_managed: boolean;
  headline: string;
  inspection_id?: number | null;
  inspection_no?: string | null;
  inspection_status?: string | null;
  putaway_total: number;
  putaway_done: number;
  qc_lines: ReceiptRouteLine[];
  direct_lines: ReceiptRouteLine[];
}

/** `inb_receipt_items`. */
export interface ReceiptItem extends CombinationValue {
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
  /** The item master's "Requires QI": QC line on submit, else straight to putaway. */
  requires_qi?: boolean;
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
  /** Packing (2026-10-08). `declared_pack_breakdown` is the supplier's despatch
   *  note — fixed; `pack_breakdown` is what was counted, never over the declared. */
  despatch_note_item_id?: number | null;
  pack_hierarchy_id?: number | null;
  pack_hierarchy_name?: string | null;
  declared_pack_breakdown?: PackEntry[] | null;
  declared_pack_text?: string | null;
  pack_breakdown?: PackEntry[] | null;
  pack_text?: string | null;
}

export interface ReceiptItemWrite extends CombinationValue {
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
  /** Packing (2026-10-08). `declared_pack_breakdown` is the supplier's despatch
   *  note — fixed; `pack_breakdown` is what was counted, never over the declared. */
  despatch_note_item_id?: number | null;
  pack_hierarchy_id?: number | null;
  pack_hierarchy_name?: string | null;
  declared_pack_breakdown?: PackEntry[] | null;
  declared_pack_text?: string | null;
  pack_breakdown?: PackEntry[] | null;
  /** CLIENT ONLY (2026-10-27): the packs a line was checked against at the gate when
   *  no despatch note declared them — kept so re-opening "Check packages" still shows
   *  the cartons that never arrived. Never read by the API. */
  expected_pack_breakdown?: PackEntry[] | null;
  pack_text?: string | null;
  /** Display only: the buyer's answer when the supplier changed the packing. */
  pack_change_status?: string | null;
  ordered_pack_hierarchy_name?: string | null;
  pack_change_reason?: string | null;
  pack_change_note?: string | null;
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
  /** By QUANTITY, derived on read (SCM_0164 / 0165 / 0166) — see `qcSummary.ts`. */
  inspected_qty?: number | string | null;
  accepted_qty?: number | string | null;
  rejected_qty?: number | string | null;
  partial_items?: number | null;
  pending_items?: number | null;
  pass_rate?: number | null;
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
export interface InspectionItem extends CombinationValue {
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
  accepted_pack_breakdown?: PackEntry[] | null;
  rejected_pack_breakdown?: PackEntry[] | null;
}

export interface InspectionItemWrite extends CombinationValue {
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
  /** Issued in packages (2026-10-26): units rejected out of each KEPT package. */
  pack_rejections?: Record<string, number> | null;
  imei_numbers?: string[] | null;
  /** Inward QC by the PACK (2026-10-27): of the GRN's counted packs, the ones kept
   *  and the ones rejected. Both or neither; the server checks they add up. */
  accepted_pack_breakdown?: PackEntry[] | null;
  rejected_pack_breakdown?: PackEntry[] | null;
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
  /** By QUANTITY, derived on read (SCM_0165) — see `qcSummary.ts`. */
  inspected_qty?: number | string | null;
  accepted_qty?: number | string | null;
  rejected_qty?: number | string | null;
  partial_items?: number | null;
  pending_items?: number | null;
  pass_rate?: number | null;
  inspector_id?: number | null;
  inspector_name?: string | null;
  remarks?: string | null;
  created_at?: string;
  items?: OutboundInspectionItem[];
  current_approver_name?: string | null;
  approved_by_name?: string | null;
  approved_at?: string | null;
}

export interface OutboundInspectionItem extends CombinationValue {
  /** The packs this quantity travels in, read off the issue line (2026-10-22). */
  pack_breakdown?: PackEntry[] | null;
  pack_text?: string | null;
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

export interface OutboundInspectionItemWrite extends CombinationValue {
  /** Issued in packages (2026-10-26): units rejected out of each KEPT package. */
  pack_rejections?: Record<string, number> | null;
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
export interface Putaway extends CombinationValue {
  /** A Storage container is mapped for the item (2026-10-27); not: the screen warns. */
  storage_defined?: boolean;
  id: number;
  putaway_no: string;
  /** Packing (2026-10-08) — served on the single task only. */
  pack_hierarchy_id?: number | null;
  pack_hierarchy_name?: string | null;
  received_pack_breakdown?: PackEntry[] | null;
  /** Storage containers are mapped for the item (2026-10-23): putaway shelves in
   *  them, inside the received ladder, and the screen cannot change it. */
  packing_fixed?: boolean;
  storage_levels?: number[];
  received_pack_text?: string | null;
  pack_breakdown?: PackEntry[] | null;
  pack_text?: string | null;
  pack_levels?: PackLevel[];
  codes_per_pack?: boolean;
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
  /** How the goods are shelved, in the receipt's hierarchy (2026-10-08). */
  pack_breakdown?: PackEntryIn[] | null;
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
  /** "STR" when the issue serves a stock transfer request. */
  indent_type?: string | null;
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
  destination_warehouse_id?: number | null;
  destination_warehouse_name?: string | null;
  destination_warehouse_type?: string | null;
  /** The Stock Transfer Order this issue executes (2026-10-29). DIRECT = raised on
   *  its own; STR = produced by an STR's allocation. Its destination is frozen. */
  sto_id?: number | null;
  sto_no?: string | null;
  sto_status?: string | null;
  sto_kind?: "DIRECT" | "STR" | null;
  sto_str_no?: string | null;
  sto_from_warehouse_name?: string | null;
  sto_to_warehouse_id?: number | null;
  sto_to_warehouse_name?: string | null;
  direction: "OUT" | "IN";
  original_issue_id?: number | null;
  original_issue_no?: string | null;
  /** Set on a CHILD of a split; the generic parent carries neither, which is how a
   *  screen tells the two apart without asking a second question. */
  parent_issue_id?: number | null;
  parent_issue_no?: string | null;
  /** Status to show: a split parent closed after its floor issues posted reads ISSUED. */
  display_status?: string | null;
  floor_location_id?: number | null;
  floor_location_name?: string | null;
  /** Who holds that floor — the in-charge(s) a split piece was handed to. */
  floor_in_charge_names?: string[];
  status: IssueStatus;
  total_items: number;
  total_qty: number;
  total_value: number;
  is_stock_posted: boolean;
  posted_at?: string | null;
  /** Who the document is with right now — raiser, approver, or the issuer. */
  currently_with?: string | null;
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
  /** Only the person an approved issue is with (or someone they report to) may pick
   *  its serials and issue it from stock. The server enforces the same rule. */
  can_issue_from_stock?: boolean;
  /** May swap auto-assigned asset/consumable codes: the issuer, or anyone who approved it. */
  can_swap_codes?: boolean;
  /** Who submitted it for approval; shown until stock is posted. */
  submitted_by_name?: string | null;
  /**
   * False until the indent raiser has confirmed this issue's quantities in My
   * deliveries. Per ISSUE, not per indent: a 10-unit indent served by a 4-unit issue
   * unlocks once those 4 are confirmed. Gate the Acknowledge button on this.
   */
  can_acknowledge?: boolean;
  /** The split family: on a parent its floor issues (`-001`, `-002` …), on a floor
   *  issue its siblings, itself included. */
  child_issues?: {
    id: number;
    issue_no: string;
    status: IssueStatus;
    floor_location_id?: number | null;
    floor_location_name?: string | null;
    is_stock_posted: boolean;
    total_qty: number;
    total_items?: number;
    in_charge_names?: string[];
  }[];
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
export interface IssueItem extends CombinationValue {
  id: number;
  issue_id: number;
  line_no: number;
  indent_item_id?: number | null;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  /** How many decimal places this line's unit allows — 0 for a whole-unit UOM.
   *  Set by `get_issue`; `null` wherever the line was read without it. */
  qty_decimals?: number | null;
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
  /** How many identifiers the line must name, when it is not one per unit — an item
   *  issued in a container names one code per box (2026-10-24). */
  codes_needed?: number | null;
  /** Issued in a container (2026-10-26): the line names BOXES, one code per box. */
  issue_in_boxes?: boolean;
  /** Each box the line holds — what it takes of it, what the box holds, part or whole. */
  box_codes?: IssueBox[] | null;
  /** Set when the item's Issue container changed after its boxes were held. */
  container_note?: string | null;
  /** Whether the item has identified units in stock at all. */
  has_units?: boolean;
  /**
   * How many units THIS line's own batch and bin can still give it. Served, never
   * counted in the screen: after approval the batch is frozen, so a line the batch
   * cannot serve has to be visible while it is still editable.
   */
  units_available?: number | null;
  /** The item's `requires_qi`: this line goes on the outward QC sheet. A line that
   *  does not goes to logistics at its issued quantity. */
  requires_qc?: boolean;
  /** Packing (2026-10-08). */
  pack_hierarchy_id?: number | null;
  pack_hierarchy_name?: string | null;
  pack_breakdown?: PackEntry[] | null;
  pack_text?: string | null;
  break_bulk?: boolean;
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
export interface IssueStockSource extends CombinationValue {
  item_id: number;
  bin_id?: number | null;
  bin_code?: string | null;
  bin_name?: string | null;
  /** The whole walk down to it — `F1 / F1-A1 / F1-A1-R1 / F1-A1-R1-B2`. Served, not
   *  composed in a screen: only the backend holds the tree. */
  bin_path?: string | null;
  bin_steps?: LocationStep[];
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
  /** What THIS direct issue reserved for itself when saved. Drawable by it, but not an
   *  allocation — never read as one. */
  issue_hold_qty?: number;
  total_qty: number;
  /** `available_qty + own_reserved_qty` — what a line here may actually take. */
  drawable_qty: number;

  /* --- the two OUTER quantities this location sits inside. Served, not summed in
   * the screen: a location another document has entirely reserved is not in this
   * list at all, so adding the rows up would report a stocked shelf as empty. Both
   * are repeated on every row of the same item. */

  /** Everything of this item in this BATCH, across every location in the warehouse. */
  batch_total_qty: number;
  /** The free part of it. */
  batch_available_qty: number;
  /** Everything of this item in the warehouse, every batch and location. */
  item_total_qty: number;
  /** The free part of it. */
  item_available_qty: number;
  /** Must this item leave with one serial / IMEI / asset or consumable code per unit? */
  codes_required?: boolean;
  /** Does this (batch, location) hold at least one free coded unit? Drives the one
   *  FEFO swap past the same-day rule: an allocated batch with no codes may give way
   *  to the oldest batch that has them. */
  has_unit_codes?: boolean;
  /** Set aside for other indents here — tradeable on save. */
  other_indent_qty?: number | string;
}

/**
 * How many identified units one (item, batch, storage location) can name right now.
 *
 * A different question from `IssueStockSource.drawable_qty` and off a different table:
 * that is a quantity on `stk_balance`, this is how many physical units at the spot
 * carry a serial, IMEI or code the line could put on the document. Stock put away
 * before the item was coded has the first and not the second, so a pick can be sound
 * on quantity and impossible to post.
 */
export interface UnitSupply {
  item_id: number;
  batch_id?: number | null;
  bin_id?: number | null;
  need: number;
  /** Whether the item has any identified units at this warehouse at all. */
  has_units: boolean;
  /** Counted only as far as `need + 1`, so a figure equal to that means "at least
   *  that many". `null` is "no answer" — never draw it as a shortfall. */
  available: number | null;
  /** Same batch anywhere at this point — "same batch, other bay". */
  batch_available?: number | null;
  /** Any batch at this point — "whole point". */
  point_available?: number | null;
}

/** Bay vs batch vs point code counts behind the picker's scope switch. */
export interface SerialScopeCounts {
  item_id: number;
  exact: number | null;
  batch: number | null;
  point: number | null;
  has_units: boolean;
}

export type CodeScopeLevel = "exact" | "batch" | "point";

export interface IssueItemWrite extends CombinationValue {
  id?: number;
  indent_item_id?: number | null;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  /** How many decimal places this item's unit allows — 0 for a whole-unit UOM
   *  (Nos, Box…). Carried so the quantity inputs can refuse a typed fraction
   *  before save (SCM_0080); stripped before the write. */
  qty_decimals?: number | null;
  is_serial_tracked?: boolean;
  unit_mode?: UnitMode | null;
  tracking_type?: TrackingType | null;
  unit_keys?: string[] | null;
  has_units?: boolean;
  units_available?: number | null;
  /** How many identifiers the line must name, when it is not one per unit — an item
   *  issued in a container names one code per box (2026-10-24). */
  codes_needed?: number | null;
  /** Issued in a container (2026-10-26): the line names BOXES, one code per box. */
  issue_in_boxes?: boolean;
  /** Each box the line holds — what it takes of it, what the box holds, part or whole. */
  box_codes?: IssueBox[] | null;
  /** Set when the item's Issue container changed after its boxes were held. */
  container_note?: string | null;
  /** The issued quantity `codes_needed` was served for; a changed quantity drops it. */
  codes_needed_at?: number | null;
  // Carried on the line so the form knows whether to ask for a batch. Set from the
  // chosen item, alongside is_serial_tracked, when the item is picked.
  is_batch_tracked?: boolean;
  is_imei_tracked?: boolean;
  bin_id?: number | null;
  /** Snapshot labels, carried so a saved pick still reads as a place and a batch
   *  while the stock sources are still in flight. Stripped before the write. */
  bin_code?: string | null;
  bin_path?: string | null;
  batch_no?: string | null;
  batch_id?: number | null;
  requested_qty: number;
  issued_qty?: number;
  rate?: number | null;
  remarks?: string | null;
  serial_numbers?: string[] | null;
  imei_numbers?: string[] | null;
  /** Issue in packs (2026-10-08): the packs set the issue qty. */
  pack_hierarchy_id?: number | null;
  pack_breakdown?: PackEntry[] | null;
  /** Open a coded pack to give part of it — needs `issue.break_bulk`. */
  break_bulk?: boolean;
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
  /** The stocking point chosen as the destination; wins over the derived one. */
  destination_warehouse_id?: number | null;
  direction?: "OUT" | "IN";
  original_issue_id?: number | null;
  remarks?: string | null;
  items: IssueItemWrite[];
}

/** A point a direct issue can go to (`/options/issue-destinations`). */
/** What a consignment, dispatch and handover inherit from the issue behind them
 *  (`/issues/{id}/transfer-context`, `/consignments/{id}/transfer-context`). */
export interface TransferContext {
  issue_id: number;
  issue_no: string;
  kind: "STR" | "STO" | "INDENT" | "DIRECT";
  reference_no?: string | null;
  str_no?: string | null;
  sto_no?: string | null;
  indent_no?: string | null;
  from_warehouse_name?: string | null;
  destination_warehouse_id?: number | null;
  destination_warehouse_name?: string | null;
  destination_office_name?: string | null;
  sac?: string | null;
  department_name?: string | null;
  project_name?: string | null;
  issued_to_id?: number | null;
  issued_to_name?: string | null;
  issued_to_code?: string | null;
  issued_to_phone?: string | null;
  vehicle_number?: string | null;
}

/** An approved STO leaving a point, with the issue that executes it
 *  (`/options/stos`). Picking one opens that issue — it is never drafted twice. */
export interface StoIssueOption {
  id: number;
  sto_no: string;
  kind: "DIRECT" | "STR";
  str_no?: string | null;
  from_warehouse_id: number;
  from_warehouse_name?: string | null;
  to_warehouse_id: number;
  to_warehouse_name?: string | null;
  issue_id?: number | null;
  issue_no?: string | null;
  issue_status?: string | null;
  item_count: number;
  requested_qty: number;
}

export interface IssueDestinationOption {
  warehouse_id: number;
  code?: string | null;
  name: string;
  warehouse_type?: string | null;
  office_id?: number | null;
  office_name?: string | null;
  sac?: string | null;
  vehicle_number?: string | null;
}

/** A person a direct issue can be issued to (`/options/issue-employees`). */
export interface IssueEmployeeOption {
  id: number;
  code?: string | null;
  name: string;
  /** HCM position codes held, primary post first. */
  position_codes?: string[];
  position_name?: string | null;
  office_id?: number | null;
  office_name?: string | null;
  department_name?: string | null;
  project_name?: string | null;
}

/** `out_dispatches`. */
export interface Dispatch {
  id: number;
  dispatch_no: string;
  dispatch_type: string;
  dispatch_date: string;
  warehouse_id: number;
  warehouse_name?: string | null;
  /** Snapshotted off the warehouse at the moment this consignment was raised
   *  (SCM_0053) — carried into a transport leg's own from_warehouse_address. */
  warehouse_address?: string | null;
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
  /** Signed read-only capability used only by the printed QR. */
  public_scan_token?: string | null;
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
  sources?: DispatchSource[];
  /** See Issue.can_approve — whose turn it is, not who holds the permission. */
  can_approve?: boolean;
  /** Each issue line's packs, once per line — rows are one per unit (2026-10-22). */
  line_packs?: DispatchLinePacks[];
  /** Carton › box for each package code it carries (2026-10-28). */
  box_paths?: Record<string, PackPathRef[]>;
}

export interface DispatchLinePacks {
  issue_item_id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  batch_no?: string | null;
  quantity: number;
  delivered_qty: number;
  pack_breakdown?: PackEntry[] | null;
  pack_text?: string | null;
  delivered_pack_breakdown?: PackEntry[] | null;
  delivered_pack_text?: string | null;
}

/** `out_dispatch_items`. */
export interface DispatchItem extends CombinationValue {
  /** The package (box / strip) this row carries (2026-10-26). */
  box_code?: string | null;
  id: number;
  dispatch_id: number;
  line_no: number;
  package_id?: number | null;
  issue_id?: number | null;
  issue_no?: string | null;
  /** The issue LINE — one batch drawn from two bays is two lines, and two rows. */
  issue_item_id?: number | null;
  /** Where that line drew it from. */
  bin_code?: string | null;
  mr_id?: number | null;
  mr_no?: string | null;
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
  public_scan_token?: string | null;
  /** The packs this carton holds, per issue line (2026-10-22). */
  item_packs?: Array<{
    issue_item_id?: number | null; item_id: number; batch_id?: number | null;
    quantity: string | number; pack_hierarchy_id?: number | null;
    pack_breakdown?: PackEntry[] | null; pack_text?: string | null;
  }> | null;
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

export interface DispatchItemWrite extends CombinationValue {
  id?: number;
  package_id?: number | null;
  issue_id?: number | null;
  issue_no?: string | null;
  /** The issue LINE — one batch drawn from two bays is two lines, and two rows. */
  issue_item_id?: number | null;
  /** Where that line drew it from. */
  bin_code?: string | null;
  mr_id?: number | null;
  mr_no?: string | null;
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
  issue_id?: number | null;
  issue_no?: string | null;
  /** The issue LINE — one batch drawn from two bays is two lines, and two rows. */
  issue_item_id?: number | null;
  /** Where that line drew it from. */
  bin_code?: string | null;
  mr_id?: number | null;
  mr_no?: string | null;
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
  /** How THIS carton holds the line (2026-10-22): its own share in packs, worked out
   *  for its quantity and changeable with "Change packing". */
  pack_hierarchy_id?: number | null;
  pack_breakdown?: PackEntry[] | null;
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
  issue_ids?: number[];
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
  /** Issued in PACKAGES (2026-10-26): each package the line sends on and what it
   *  carries after outward QC. A carton names which of them it holds. */
  box_codes?: { code: string; quantity: number; name?: string | null; path?: PackPathRef[] | null }[];
  /** The packs this quantity travels in, read off the issue line (2026-10-22). */
  pack_breakdown?: PackEntry[] | null;
  pack_text?: string | null;
  indent_no?: string | null;
  issue_id?: number | null;
  issue_no?: string | null;
  mr_id?: number | null;
  mr_no?: string | null;
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
  /** What the codes on this row are — serial, IMEI, asset tag or consumable code. */
  tracking_type?: TrackingType | null;
  /** Went through outward QC (true) or out without needing it (false). */
  requires_qc?: boolean;
  serial_numbers?: string[];
  /** serial -> IMEI, so a handset's number shows beside the unit it belongs to. */
  imei_by_serial?: Record<string, string>;
}

export interface IssueDispatchSource {
  issue_id: number;
  issue_ids?: number[];
  issue_no: string;
  issue_nos?: string[];
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

export interface DispatchSource {
  id: number;
  dispatch_id: number;
  source_type: string;
  source_id: number;
  source_no?: string | null;
  issue_id?: number | null;
  issue_no?: string | null;
  mr_id?: number | null;
  mr_no?: string | null;
  indent_id?: number | null;
  indent_no?: string | null;
  destination_warehouse_id?: number | null;
  destination_warehouse_name?: string | null;
  quantity: number;
}

/** One issue inside a suggested grouped consignment. */
export interface RecommendedIssue {
  issue_id: number;
  issue_no: string;
  issue_date?: string | null;
  indent_no?: string | null;
  mr_nos: string[];
  item_lines: number;
  total_qty: number;
}

/** Issues that can travel together — same point out, same LIP/MDP in. `headline`
 *  and `reason` are served, so every screen words a suggestion the same way. */
export interface ConsignmentRecommendation {
  key: string;
  label: string;
  headline: string;
  reason: string;
  issue_ids: number[];
  issue_nos: string[];
  issues: RecommendedIssue[];
  oldest_issue_date?: string | null;
  warehouse_id: number;
  warehouse_name?: string | null;
  destination_warehouse_id?: number | null;
  destination_warehouse_name?: string | null;
  destination_office_name?: string | null;
  total_qty: number;
  item_lines: number;
  mr_nos: string[];
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

/** `pro_returns`. Enriched with auto-fetched vendor snapshot — never typed. */
export interface PurchaseReturn {
  id: number;
  return_no: string;
  return_date: string;
  po_id?: number | null;
  po_no?: string | null;
  grn_id?: number | null;
  grn_no?: string | null;
  /** Off the GRN itself — the purchase reference the return is argued against. */
  grn_date?: string | null;
  invoice_no?: string | null;
  invoice_date?: string | null;
  vendor_id?: number | null;
  vendor_name?: string | null;
  vendor_code?: string | null;
  vendor_contact_person?: string | null;
  vendor_phone?: string | null;
  vendor_email?: string | null;
  vendor_address?: string | null;
  vendor_city?: string | null;
  vendor_state?: string | null;
  vendor_gstin?: string | null;
  vendor_pincode?: string | null;
  warehouse_id?: number | null;
  warehouse_name?: string | null;
  indent_id?: number | null;
  indent_no?: string | null;
  material_receipt_id?: number | null;
  /**
   * THE QC THAT CONDEMNED THE GOODS — the evidence the vendor is asked to accept, and
   * the one reference this document could not carry before 2026-09-12. Stored columns,
   * resolved on read off the return's own GRN while blank and bound when it is sent, so
   * the number survives the whole journey. Null where the return names no goods receipt,
   * or where nobody inspected the one it names.
   */
  inspection_id?: number | null;
  inspection_no?: string | null;
  reason?: string | null;
  reason_label?: string | null;
  /**
   * The served reason code, where the stored reason is one. Null on a return the
   * returns module raised automatically (its reason is prose from the field) — the
   * signal that Send to Vendor has to ask for a reason rather than reuse this one.
   */
  reason_code?: string | null;
  remarks?: string | null;
  status: ReturnStatus;
  /**
   * The stored status re-worded once the SUPPLIER has answered — "Replacement to
   * warehouse" rather than "SENT_TO_VENDOR". Served, never mapped in a screen, so the
   * register and the document cannot word one return two ways. Null while unanswered
   * and null once the return is closed: write `status_label ?? status` and every row
   * raised before the portal could be answered reads exactly as it did.
   */
  status_label?: string | null;
  sent_at?: string | null;
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
  can_send_to_vendor?: boolean;
  dispatch_id?: number | null;
  dispatch_no?: string | null;
  /**
   * The chain READ behind a return raised without one — a return the returns module
   * raises off a branch consignment stores no GRN, PO or vendor. Kept separate from the
   * stored fields above on purpose: traced is evidence, not a binding. Sending posts
   * these back, which is what binds them.
   */
  chain_traced?: boolean;
  chain_note?: string | null;
  traced_grn_id?: number | null;
  traced_grn_no?: string | null;
  traced_po_id?: number | null;
  traced_po_no?: string | null;
  traced_vendor_id?: number | null;
  traced_vendor_name?: string | null;
  /**
   * Where the material came from and what raised this document. Written by the returns
   * module when a branch consignment lands at the warehouse and the purchase return
   * against it is raised automatically — which is why a DRAFT can exist that nobody in
   * the warehouse remembers typing.
   */
  source_category?: string | null;
  source_category_label?: string | null;
  source_return_id?: number | null;
  source_return_no?: string | null;
  /**
   * The vendor and lines on this document were typed, not read off a purchase. The
   * `vendor_*` fields above are then served from the typed values rather than from
   * the vendor master, so the shape a reader gets is identical either way.
   */
  is_manual?: boolean;
  /** The document number typed for reference on a manual return. */
  source_ref_no?: string | null;
  /**
   * What the SUPPLIER said about the goods, and what their answer raised. Written by
   * the supplier portal and read-only here. All null until they answer — which is the
   * permanent state of every return sent before the portal could answer — so read "not
   * yet" from null and never from a missing field.
   */
  vendor_response?: string | null;
  /** Already worded by the server. Never map this in a screen. */
  vendor_response_label?: string | null;
  vendor_response_at?: string | null;
  /** Why, in the supplier's own words. */
  vendor_response_note?: string | null;
  /** What they are crediting, on a refund only. */
  vendor_refund_amount?: number | null;
  /**
   * The DRAFT inbound receipt the answer raised — the document the replacement (or the
   * refused consignment) will actually be received against. Null for a refund, which
   * raises none, and null on a legacy ACCEPTED row.
   */
  vendor_followup_receipt_id?: number | null;
  vendor_followup_receipt_no?: string | null;

  /* --- the decision on a SENT return, and the leg that brings the material back --- */

  /**
   * APPROVED | REJECTED, answered once after the return reached the vendor. Null is
   * "nobody has answered yet", which is what puts the two buttons on the screen —
   * read it from null, never from a missing field.
   */
  vendor_decision?: string | null;
  vendor_decision_at?: string | null;
  vendor_decision_by_name?: string | null;
  vendor_decision_note?: string | null;

  /** Who provides the vehicle. Null until the approval has been answered with one. */
  vehicle_arrangement?: ReturnVehicleArrangement | null;
  /** Already worded by the server. Never map this in a screen. */
  vehicle_arrangement_label?: string | null;
  vehicle_arrangement_at?: string | null;
  vehicle_arrangement_by_name?: string | null;

  /**
   * THE VEHICLE BRINGING IT BACK — one shape over both arrangements. Typed by the desk
   * where the vendor arranges it, read live off the Logistics transport request where
   * we asked for one. The screen never asks which: that is the server's job and the
   * whole reason these are not two sets of fields.
   */
  inbound_vehicle_no?: string | null;
  inbound_driver_name?: string | null;
  inbound_driver_phone?: string | null;
  inbound_transporter_name?: string | null;
  inbound_lr_no?: string | null;
  inbound_expected_date?: string | null;
  inbound_dispatched_at?: string | null;
  /** The Logistics leg, on a warehouse-requested vehicle. */
  inbound_tr_id?: number | null;
  inbound_tr_no?: string | null;
  /** Where that leg has got to, read off it rather than mirrored. */
  inbound_tr_status?: string | null;
  inbound_pickup_address?: string | null;
  inbound_ready_date?: string | null;

  /** THE OUTWARD LEG — our warehouse to the vendor, on a WAREHOUSE_REQUESTS arrangement. */
  outbound_tr_id?: number | null;
  outbound_tr_no?: string | null;

  /** The vendor accepting the collection job, on a VENDOR_ARRANGES leg. */
  vendor_transport_accepted_at?: string | null;
  vendor_transport_accepted_by_name?: string | null;

  /** The vendor signing for the returned goods at their own dock. */
  vendor_receipt_confirmed_at?: string | null;
  vendor_receipt_by_name?: string | null;
  vendor_receipt_vehicle_no?: string | null;
  vendor_receipt_remarks?: string | null;

  /**
   * THE REPLACEMENT DISPATCH NOTE. The per-line half — the batch, manufacturing date and
   * expiry of the goods actually being sent — rides on the ITEM rows, because two items
   * have two batches and one pair of fields here would be right only for a one-line
   * return.
   */
  replacement_dispatched_at?: string | null;
  replacement_dispatch_no?: string | null;
  replacement_dispatch_date?: string | null;
  replacement_expected_date?: string | null;
  replacement_transporter_name?: string | null;
  replacement_vehicle_no?: string | null;
  replacement_lr_no?: string | null;
  replacement_remarks?: string | null;

  received_at?: string | null;
  received_by_name?: string | null;
  received_remarks?: string | null;

  /**
   * The internal refund's own stamp. The AMOUNT is `vendor_refund_amount` (one
   * credit column whichever desk recorded it); these three say this desk did.
   */
  refunded_at?: string | null;
  refunded_by_name?: string | null;
  refund_remarks?: string | null;

  /**
   * WHICH PRESS THIS DOCUMENT IS STANDING AT. Served, never worked out here: the rungs
   * are the service's own guards, and re-deriving them from the status string would be
   * a second copy of the ladder drifting from the first. They say where the DOCUMENT
   * stands and nothing about this user — keep the `<Can>` gate as well.
   *
   * ONE of them puts a button in front of an employee. Approve/Reject and
   * Refund/Replacement are the VENDOR's answers on their own portal since 2026-09-12,
   * so `can_decide`, `can_resolve_refund` and `can_record_vehicle` are gone with the
   * presses they gated.
   */
  can_arrange_transport?: boolean;
  can_confirm_receipt?: boolean;

  /**
   * WHAT THE VENDOR STILL OWES US. Read-only: these draw the "waiting on them" panel so
   * a storekeeper chasing a return can tell "nobody has done anything" from "we are
   * waiting on them", without offering to answer on their behalf.
   */
  awaiting_vendor_decision?: boolean;
  awaiting_vendor_settlement?: boolean;
  awaiting_vendor_transport?: boolean;
  awaiting_vendor_receipt?: boolean;
  awaiting_replacement_dispatch?: boolean;

  /** RETAINED SPELLING of `can_arrange_transport`, served with the same value. */
  can_arrange_vehicle?: boolean;

  /**
   * THE REPLACEMENT'S INTAKE — the goods receipt the dispatch note raised, its QC and its
   * putaway. Read on the server off `inb_receipts`, `inb_inspections` and
   * `whs_warehouse_items` on every load; nothing is mirrored onto the return, so the
   * three rungs the tracker draws and the documents the store actually works are the
   * same three rungs.
   *
   * All null / zero / false on a return with no replacement coming — a refund, a
   * refusal, and every return raised before this flow existed.
   */
  replacement_grn_no?: string | null;
  /** DRAFT | PENDING_QC | QC_PASSED | QC_FAILED | PARTIALLY_RECEIVED | COMPLETED. */
  replacement_grn_status?: string | null;
  replacement_inspection_no?: string | null;
  replacement_putaway_total?: number;
  replacement_putaway_done?: number;
  /** Booked in, passed and placed. This is the fact that closes the return. */
  replacement_intake_complete?: boolean;
  /**
   * What the store still owes, in ONE sentence, composed on the server. Never assembled
   * here: the band on this screen and the journey tracker beside it must not word one
   * document two ways. Null where there is no replacement, and once the return is closed.
   */
  replacement_intake_stage?: string | null;
}

/** One of the two cards offered after a sent return is approved. Served, never typed. */
export interface VehicleArrangementOption {
  value: ReturnVehicleArrangement;
  label: string;
  help: string;
  /** This option hands the leg to Logistics — a vehicle request appears on their board. */
  raises_vehicle_request: boolean;
}

/** `POST /returns/{id}/vehicle-arrangement`. */
export interface ReturnVehicleArrangementPayload {
  arrangement: ReturnVehicleArrangement;
  /** Only read on a warehouse-requested vehicle. */
  pickup_address?: string | null;
  ready_date?: string | null;
  remarks?: string | null;
}

/**
 * `POST /returns/{id}/vehicle` — the vehicle the VENDOR named. Every field optional so
 * a desk can record a number now and the driver when the vendor rings back; an omitted
 * field means "nothing to say about this", never "erase what is there".
 */
export interface ReturnInboundVehiclePayload {
  vehicle_no?: string | null;
  driver_name?: string | null;
  driver_phone?: string | null;
  transporter_name?: string | null;
  lr_no?: string | null;
  expected_date?: string | null;
  /** The vehicle has left the vendor. A vendor leg has no logistics document to say so. */
  dispatched?: boolean;
  remarks?: string | null;
}

/** `POST /returns/{id}/receive`. */
export interface ReturnReceivedPayload {
  received_by_name?: string | null;
  remarks?: string | null;
}

/** `POST /returns/{id}/resolve-refund` — settle an approved return in money. */
export interface ResolveRefundPayload {
  refund_amount: number;
  refund_remarks?: string | null;
}

/**
 * One document on the trail behind a purchase return. Every kind carries the same
 * keys, so the screen renders one row shape and never branches per type — `facts` is
 * an ordered list of [label, value] pairs the SERVER chose.
 */
export interface PurchaseReturnTrailDoc {
  doc_type: string;
  doc_label: string;
  doc_id?: number | null;
  doc_no?: string | null;
  status?: string | null;
  doc_date?: string | null;
  party?: string | null;
  facts: [string, string][];
  /** PURCHASE (how it was bought) | RETURN (how it came back) | DOCUMENT (this one). */
  leg: string;
  /** Read off the trail rather than named by the document — evidence, not a binding. */
  traced: boolean;
  /** Where it lives in the app. Null where no detail screen exists for that kind. */
  route?: string | null;
}

/** One thing that happened, on one document, to one person's name. */
export interface PurchaseReturnTimelineEvent {
  at?: string | null;
  entity: string;
  doc_no?: string | null;
  action: string;
  title: string;
  detail?: string | null;
  actor_name?: string | null;
  status_to?: string | null;
}

/** `GET /returns/{id}/dossier` — the whole trail and history in one call. */
export interface PurchaseReturnDossier {
  return_id: number;
  return_no: string;
  documents: PurchaseReturnTrailDoc[];
  timeline: PurchaseReturnTimelineEvent[];
  trail_note?: string | null;
  /**
   * The twelve-leg tracker. On THIS call rather than an endpoint of its own: the detail
   * screen already fetches the dossier, and two round trips for facts drawn off one row
   * is two chances for them to disagree about where the document is.
   */
  journey?: PurchaseReturnJourneyLeg[];
  /** Which leg it is standing on (1-based), and the sentence that says so. */
  current_sequence?: number;
  current_stage_message?: string | null;
}

/** `pro_return_items`. */
export interface PurchaseReturnItem extends CombinationValue {
  id: number;
  return_id: number;
  line_no: number;
  po_item_id?: number | null;
  grn_item_id?: number | null;
  /** Null on a manually typed line — the item need not exist in `mst_items`. */
  item_id?: number | null;
  /** This line was typed rather than read off a source document. */
  is_manual?: boolean;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  batch_id?: number | null;
  batch_no?: string | null;
  quantity: number;
  rate?: number | null;
  amount?: number | null;
  reason?: string | null;
  original_qty?: number | null;
  previously_returned?: number | null;
  returnable_qty?: number | null;
}

export interface PurchaseReturnItemWrite {
  id?: number;
  po_item_id?: number | null;
  grn_item_id?: number | null;
  /** Optional only on a MANUAL line — a typed item need not exist in `mst_items`. */
  item_id?: number | null;
  batch_id?: number | null;
  quantity: number;
  rate?: number | null;
  reason?: string | null;
  /** This line was typed rather than read off a source document. */
  is_manual?: boolean;
  item_name?: string | null;
  item_code?: string | null;
  uom_code?: string | null;
  /** Purchased / already returned / available, as typed. Stored verbatim. */
  original_qty?: number | null;
  previously_returned?: number | null;
  returnable_qty?: number | null;
}

export interface PurchaseReturnWrite {
  return_date: string;
  po_id?: number | null;
  grn_id?: number | null;
  vendor_id?: number | null;
  warehouse_id?: number | null;
  reason?: string | null;
  remarks?: string | null;
  items: PurchaseReturnItemWrite[];
  /**
   * A return whose vendor and lines are TYPED rather than read off a purchase — for
   * goods whose paperwork never reached this system. The sourced path is unchanged
   * and remains the default; `is_manual` false means every existing rule applies,
   * including the vendor lock.
   */
  is_manual?: boolean;
  /** The document number typed for reference. Never resolved, never linked. */
  source_ref_no?: string | null;
  vendor_name?: string | null;
  vendor_code?: string | null;
  vendor_contact_person?: string | null;
  vendor_phone?: string | null;
  vendor_email?: string | null;
  vendor_address?: string | null;
  vendor_city?: string | null;
  vendor_state?: string | null;
  vendor_pincode?: string | null;
  vendor_gstin?: string | null;
}

/** Return reasons — served, never hard-coded. */
export interface PurchaseReturnReason {
  value: string;
  label: string;
}

/** One eligible source transaction for the searchable dropdown. */
export interface PurchaseReturnSourceOption {
  source_type: string;
  source_id: number;
  source_no: string;
  source_date?: string | null;
  vendor_id?: number | null;
  vendor_name?: string | null;
  vendor_code?: string | null;
  item_id?: number | null;
  item_code?: string | null;
  item_name?: string | null;
  warehouse_id?: number | null;
  warehouse_name?: string | null;
  indent_id?: number | null;
  indent_no?: string | null;
  po_id?: number | null;
  po_no?: string | null;
  grn_id?: number | null;
  grn_no?: string | null;
}

export interface VendorDetail {
  vendor_id?: number | null;
  vendor_code?: string | null;
  vendor_name?: string | null;
  contact_person?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  gstin?: string | null;
}

export interface ItemDetail extends CombinationValue {
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  description?: string | null;
  uom_code?: string | null;
  batch_no?: string | null;
  batch_id?: number | null;
  serial_no?: string | null;
  grn_item_id?: number | null;
  po_item_id?: number | null;
  original_qty: number;
  previously_returned: number;
  returnable_qty: number;
  unit_price?: number | null;
  amount?: number | null;
  warehouse_id?: number | null;
  warehouse_name?: string | null;
}

export interface PurchaseDetails {
  po_id?: number | null;
  po_no?: string | null;
  grn_id?: number | null;
  grn_no?: string | null;
  indent_id?: number | null;
  indent_no?: string | null;
  receipt_id?: number | null;
  receipt_no?: string | null;
  order_date?: string | null;
  receipt_date?: string | null;
  invoice_no?: string | null;
  invoice_date?: string | null;
}

/**
 * `GET /returns/source-lookup` — the answer to a document number typed by hand.
 *
 * `found: false` is a 200, not an error: this is asked on every keystroke and a
 * half-typed number is the field's ordinary state. `message` is the server's sentence
 * for why a number did not resolve, or why a resolved one cannot be returned against.
 */
export interface PurchaseReturnSourceLookup {
  found: boolean;
  option?: PurchaseReturnSourceOption | null;
  can_return: boolean;
  message?: string | null;
}

export interface PurchaseReturnSourceDetail {
  source_type: string;
  source_id: number;
  source_no: string;
  vendor: VendorDetail;
  items: ItemDetail[];
  purchase: PurchaseDetails;
  warehouse_id?: number | null;
  warehouse_name?: string | null;
  total_original_qty: number;
  total_previously_returned: number;
  total_returnable_qty: number;
}

/** One card on the Send to Vendor wizard's Logistics step.
 *
 * Served from `/warehouse/returns/logistics-modes` and never hard-coded here: which
 * modes exist, how they read and which extra fields each one asks for are business
 * rules, and the `needs_*` flags are what the wizard branches on rather than testing
 * the mode code in three separate places. */
export interface LogisticsModeOption {
  value: string;
  label: string;
  help: string;
  needs_carrier: boolean;
  needs_vehicle: boolean;
  needs_bearer: boolean;
  /** This mode hands the load to Logistics instead of finishing it at the gate, so the
   *  trip still has to be arranged and the supplier cannot have signed for it yet — the
   *  wizard therefore does not ask for an acknowledgement on it. Optional so a server
   *  that predates the flag still deserialises; absent reads as false, which is the old
   *  behaviour. */
  raises_shipment?: boolean;
}

/** How the goods travel back, who signed for them, and everything in between.
 *
 * Every field lands on the `out_dispatches` row the send already raises. Optional on
 * the endpoint — a send posted without it behaves exactly as it did before the
 * wizard existed — but the wizard always sends a complete one. */
export interface PurchaseReturnLogisticsPayload {
  mode: string;
  hand_carried_by?: string | null;
  vehicle_number?: string | null;
  driver_name?: string | null;
  driver_phone?: string | null;
  carrier_name?: string | null;
  lr_no?: string | null;
  freight_amount?: number | null;
  delivery_address?: string | null;
  contact_person?: string | null;
  contact_phone?: string | null;
  total_packages?: number | null;
  total_weight_kg?: number | null;
  eway_bill_no?: string | null;
  expected_delivery?: string | null;
  gate_pass_no?: string | null;
  dispatch_remarks?: string | null;
  acknowledged_by_name?: string | null;
  acknowledged_at?: string | null;
  pod_url?: string | null;
}

export interface PurchaseReturnSendToVendorPayload {
  return_reason: string;
  remarks?: string | null;
  items: PurchaseReturnItemWrite[];
  grn_id?: number | null;
  po_id?: number | null;
  indent_id?: number | null;
  vendor_id?: number | null;
  warehouse_id?: number | null;
  logistics?: PurchaseReturnLogisticsPayload | null;
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

/* ------------------------------------------- stock by location, as a file -- */

/**
 * One of the two downloads offered for a storage location, already counted.
 *
 * Every string here is composed by `warehouse/stock_report.py` — the title, the
 * sentence and the hint — so the button and the file it produces can never describe
 * the same scope differently. The screen renders them; it words nothing itself.
 */
export interface StockReportScopeOption {
  key: "LOCATION" | "HIERARCHY";
  title: string;
  sentence: string;
  hint: string;
  /** Locations the scope covers, whether or not they hold anything. */
  locations_in_scope: number;
  /** Of those, how many actually hold stock. */
  locations: number;
  items: number;
  rows: number;
  total_qty: number;
  is_empty: boolean;
  /** This location has nothing inside it, so both scopes are the same file. */
  same_as_other: boolean;
  recommended: boolean;
}

/** `GET /stock-segregation/report/scopes` — what each download would contain, asked
 *  before either is pulled. */
export interface StockReportScopes {
  warehouse_id: number;
  warehouse_name?: string | null;
  location_id?: number | null;
  location_code?: string | null;
  location_name?: string | null;
  location_label: string;
  location_kind?: string | null;
  location_path: string[];
  depth: number;
  child_count: number;
  descendant_count: number;
  item_filter?: number | null;
  floor_restricted: boolean;
  row_cap: number;
  options: StockReportScopeOption[];
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

/** One location sitting directly inside another, and the cube it claims. */
export interface VolumeBudgetChild {
  id: number;
  code: string;
  name?: string | null;
  bin_type?: string | null;
  /** `null` means nobody measured it — NOT zero, which reads as "takes no space". */
  volume?: number | null;
  is_active?: boolean;
}

/**
 * How much of a storage location's cube the locations inside it already claim.
 *
 * Served, never worked out in the form: the sentence the screen shows and the rule the
 * save enforces have to be the same arithmetic, or a form will happily accept a number
 * the server then refuses.
 */
export interface VolumeBudget {
  location_id: number;
  code: string;
  name?: string | null;
  bin_type?: string | null;
  /** The location's own physical cube — stated, else worked out from its three sides. */
  gross_volume?: number | null;
  /** "stated" | "derived" | null — which number to send somebody to correct. */
  volume_source?: string | null;
  children_volume: number;
  free_volume?: number | null;
  child_count: number;
  unmeasured_children: number;
  headline: string;
  detail: string;
  children: VolumeBudgetChild[];
}

/** One rung of the walk down to a storage location. */
export interface LocationStep {
  id: number;
  code: string;
  name?: string | null;
  bin_type?: string | null;
}

/**
 * A storage location offered by a picker, WITH the route to it.
 *
 * `F1-A1-R1-B2` and `F1-A1-R2-B2` are one character apart and thirty metres apart, so
 * a dropdown of bare codes is a memory test. Every location option carries its
 * ancestry — the backend owns the tree, the screen only draws it.
 */
export interface LocationOption extends Option {
  bin_type?: string | null;
  is_pickable?: boolean;
  path?: string | null;
  path_names?: string | null;
  steps?: LocationStep[];
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
  /** How many decimal places this item's unit allows — 0 for a whole-unit UOM
   *  (Nos, Box…). Lets the issue form refuse a typed fraction before save. */
  qty_decimals?: number | null;
  is_batch_tracked?: boolean;
  is_serial_tracked?: boolean;
  is_imei_tracked?: boolean;
  is_asset?: boolean;
  requires_qi?: boolean;
  /** What the named stocking point can give of this item. `null`/undefined means no
   *  point was named — "nobody asked", which must never be drawn as "none here". */
  on_hand?: number | null;
  batch_count?: number | null;
  location_count?: number | null;
}

/** An open PO line the GRN screen pulls in when a PO is chosen. */
/** One line of what the vendor says they sent, ready to become a receipt line. */
export interface DespatchPrefillLine extends CombinationValue {
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
  /** Off the item master: what the unit needs at the gate (2026-10-21). */
  is_asset?: boolean;
  is_serial_tracked?: boolean;
  is_imei_tracked?: boolean;
  /** The supplier's packing, declared and fixed, and the count to start from. */
  despatch_note_item_id?: number | null;
  pack_hierarchy_id?: number | null;
  pack_hierarchy_name?: string | null;
  pack_breakdown?: PackEntry[] | null;
  pack_text?: string | null;
  counted_pack_breakdown?: PackEntry[] | null;
  pack_change_status?: string | null;
  ordered_pack_hierarchy_name?: string | null;
  pack_change_reason?: string | null;
  pack_change_note?: string | null;
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

export interface PoLineOption extends CombinationValue {
  po_item_id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  ordered_qty: number;
  received_qty: number;
  pending_qty: number;
  rate?: number | null;
  /** Off the item master: what the unit needs at the gate (2026-10-21). */
  is_asset?: boolean;
  is_serial_tracked?: boolean;
  is_imei_tracked?: boolean;
  indent_id?: number | null;
  indent_no?: string | null;
  /** What is still owed, in whole packs of the order's hierarchy. */
  pack_hierarchy_id?: number | null;
  pack_hierarchy_name?: string | null;
  pack_breakdown?: PackEntry[] | null;
  pack_text?: string | null;
}

export interface PoPrefill {
  vendor_id?: number;
  vendor_name?: string;
  vendor_gstin?: string;
  project_id?: number;
  project_name?: string;
  total_amount?: number;
  /** Only the lines with something still outstanding. A fully received line is not
   *  one to receive again — offering it prefilled with the whole ordered quantity is
   *  how one order came to be received twice. */
  lines: PoLineOption[];
  /** The lines with nothing left, so a line added by hand can be named as already
   *  received before Save. */
  settled_lines?: PoLineOption[];
  /** How many lines the order has altogether, so an empty `lines` can be told apart
   *  from an empty order. */
  total_lines?: number;
  /** The receipts already standing against this order. */
  received_by?: string[];
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
  /** The batch number printed on the goods — never show `batch_id` in its place. */
  batch_no?: string | null;
  serial_numbers?: string[] | null;
}

export interface StockAvailability {
  available_qty: number;
  is_serial_tracked: boolean;
  /** No longer filled — the units are paged through `/serials`. */
  serial_numbers: string[];
  /** Read off the item master: must this line name one identifier per unit? */
  units_required?: boolean;
  unit_mode?: UnitMode | null;
  tracking_type?: TrackingType | null;
  /** Unclaimed units at this location and batch, counted only to a ceiling. */
  units_available?: number | null;
  /** True when `units_available` is "at least" rather than exact. */
  units_capped?: boolean;
  bin_code?: string | null;
  bin_path?: string | null;
  batch_no?: string | null;
}

export interface StockMovementOrder {
  /** 0 only for movements completed before orders were stored — those have ledger
   *  rows and no document row. Every order raised since carries a non-zero id and
   *  moves DRAFT → PENDING_APPROVAL → APPROVED → COMPLETED. */
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

// ---------------------------------------------------------------------------
// Warehouse Demand Pool
// ---------------------------------------------------------------------------

export interface WDemandPoolStage {
  stage: string;
  label: string;
  tone: string;
  hint: string;
  deep_link: string;
}

export interface WDemandPoolDoc {
  kind: string;
  id: number;
  no: string | null;
  status: string;
  qty: number;
  stage?: string;
}

export interface WDemandPoolSource {
  indent_id: number;
  indent_no: string;
  indent_item_id: number;
  item_id: number;
  item_code: string | null;
  item_name: string | null;
  uom_code: string | null;
  requested_qty: number;
  owed_qty: number;
  stage: string;
  stages: Record<string, number>;
  required_date: string | null;
  priority: string | null;
  requested_by_name: string | null;
  department_name: string | null;
  project_name: string | null;
  docs: WDemandPoolDoc[];
}

export interface WDemandPoolGroup {
  item_id: number;
  item_code: string | null;
  item_name: string | null;
  uom_code: string | null;
  total_qty: number;
  indent_count: number;
  stage_summary: Record<string, number>;
  earliest_required: string | null;
  sources: WDemandPoolSource[];
}

export interface WDemandPoolResponse {
  groups: WDemandPoolGroup[];
  group_count: number;
  indent_count: number;
  stage_totals: Record<string, number>;
  page: number;
  size: number;
  total: number;
}

// --- Project lots (Stock Segregation > Project Lots) -------------------------

export interface ProjectLotHold {
  id: number;
  hold_no: string;
  project_id: number;
  project_name?: string | null;
  quantity: number;
  serial_count: number;
}

export interface ProjectLot {
  stock_id: number;
  /** Put-away lot numbers that landed on this row — usually one, sometimes several. */
  lot_nos: string[];
  /** Warehouse / floor / lane / rack / bin. */
  location_path?: string | null;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  warehouse_id: number;
  warehouse_name?: string | null;
  bin_id?: number | null;
  bin_code?: string | null;
  batch_id?: number | null;
  batch_no?: string | null;
  expiry_date?: string | null;
  received_for_project?: string | null;
  total_qty: number;
  available_qty: number;
  reserved_qty: number;
  held_qty: number;
  holds: ProjectLotHold[];
  is_unit_tracked: boolean;
  /** Packing (2026-10-08): the row's project (part of its key) and how it is bagged. */
  project_id?: number | null;
  pack_text?: string | null;
  packs?: PackEntry[];
  loose_qty?: number | null;
  pack_unreconciled?: boolean;
  /** Packs here under their level's minimum, and part packs (2026-10-11). */
  pack_below_min?: number;
  pack_part_packs?: number;
}

/** One physical pack on the shelf, with whatever stands inside it. */
export interface ShelfPack {
  id: number;
  hu_code: string;
  code_kind: string;
  level: number;
  pack_name?: string | null;
  pack_size: number;
  /** What it really holds (2026-10-11) — less than `pack_size` for a part pack. */
  content_qty?: number;
  is_part?: boolean;
  /** Under its level's minimum: allowed, flagged until it is repacked. */
  below_min?: boolean;
  min_fill?: number | null;
  /** Coded at its own level: may be wrapped, never split (except by break bulk). */
  is_atom: boolean;
  status: string;
  source_no?: string | null;
  contents: ShelfPack[];
}

/** One stock row pack by pack — what the repack screen draws. */
export interface LotPacks {
  stock_id: number;
  item_id: number;
  warehouse_id: number;
  bin_id: number;
  batch_id: number;
  project_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  bin_code?: string | null;
  batch_no?: string | null;
  total_qty: number;
  available_qty: number;
  reserved_qty: number;
  loose_qty: number;
  pack_text?: string | null;
  /** Packs here under their minimum, and part packs (2026-10-11). */
  below_min?: number;
  part_packs?: number;
  codes_per_pack: boolean;
  serialised: boolean;
  hierarchies: (PackHierarchy & {
    in_use: boolean;
    /** The smallest level a repack may choose: a code cannot be split. */
    coded_floor: number;
    /** FULL outermost packs per level. */
    top_counts: Record<string, number>;
    /** The outermost PART packs, one per pack. A repack keeps one only where the
     *  target names a pack of that level holding exactly that. */
    top_parts?: { level: number; fill: number; below_min?: boolean }[];
    packs: ShelfPack[];
  })[];
}

export interface PackSummaryRow {
  stock_id: number;
  packs: PackEntry[];
  loose_qty: number;
  pack_text?: string | null;
  unreconciled: boolean;
}

export interface ProjectHold {
  id: number;
  hold_no: string;
  stock_id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  warehouse_id: number;
  warehouse_name?: string | null;
  bin_id?: number | null;
  bin_code?: string | null;
  batch_id?: number | null;
  batch_no?: string | null;
  project_id: number;
  project_name?: string | null;
  held_qty: number;
  quantity: number;
  serial_numbers?: string[] | null;
  reason?: string | null;
  status: "ACTIVE" | "RELEASED" | "USED";
  created_by_name?: string | null;
  created_at?: string | null;
  released_by_name?: string | null;
  released_at?: string | null;
  release_reason?: string | null;
  released_for_project_name?: string | null;
  /** A release in flight — the Stock Movement Order moving it off the lot. */
  release_order_no?: string | null;
  release_qty?: number | null;
  release_destination?: string | null;
  pending_lend_project_name?: string | null;
  is_unit_tracked?: boolean;
}

export interface ProjectHoldReleaseResult {
  hold: ProjectHold;
  order_no?: string | null;
  order_status?: string | null;
}

export interface ProjectHoldCreate {
  stock_id: number;
  project_id: number;
  quantity: number;
  serial_numbers: string[];
  reason: string;
}

export interface ProjectHoldRelease {
  quantity?: number | null;
  serial_numbers?: string[];
  reason: string;
  for_project_id?: number | null;
  /** Where the released stock is moved to: a release is a Stock Movement Order. */
  destination_bin_id: number;
}


/** A pack around another one, outermost first (2026-10-28). */
export interface PackPathRef { code: string; name?: string | null; level?: number | null }

/** A pack directly inside another (2026-10-28) — a strip in a box. */
export interface PackInner { code: string; name?: string | null; level?: number | null; carries: number; part?: boolean }

/** One box an issue line holds (2026-10-26). */
export interface IssueBox {
  code: string;
  pack_name?: string | null;
  take: number;
  holds: number;
  size: number;
  part: boolean;
  /** Its own name, the packs around it, and the packs inside it (2026-10-28). */
  name?: string | null;
  path?: PackPathRef[] | null;
  inner?: PackInner[] | null;
}

/** One box an issue line could name — `GET /issues/box-sources` (2026-10-26). */
export interface BoxSource {
  id: number;
  code: string;
  pack_name?: string | null;
  holds: number;
  size: number;
  part: boolean;
  batch_no?: string | null;
  bin_code?: string | null;
  held_by_this_issue: boolean;
  held_by?: string | null;
  /** The pack it sits in — the carton the picker groups it under (2026-10-27). */
  level?: number | null;
  parent_id?: number | null;
  parent_code?: string | null;
  parent_pack_name?: string | null;
  parent_holds?: number | null;
  parent_size?: number | null;
  /** With `with_units`: the serials / IMEIs / codes inside, in order. */
  units?: string[] | null;
  /** Every pack around it, outermost first (2026-10-28). */
  path?: PackPathRef[] | null;
}

/** One sticker for a posted issue or an acknowledged receipt (2026-10-28). */
export interface DocLabelRow {
  key: string;
  kind: "PACK" | "UNIT";
  code: string;
  /** A serial / IMEI tracked unit's own numbers (2026-11-02). */
  serial_number?: string | null;
  imei?: string | null;
  line_id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  pack_name?: string | null;
  qty: number;
  pack_size: number;
  part: boolean;
  batch_no?: string | null;
  expiry_date?: string | null;
  brand_name?: string | null;
  variant_name?: string | null;
  model_name?: string | null;
  depth: number;
  parent_code?: string | null;
  packs_inside?: string | null;
  qr_token?: string | null;
  /** The Box-label queue row still waiting for this pack. */
  label_id?: number | null;
  /** A part pack cut by this issue at posting. */
  new_here: boolean;
  /** The packs around it, outermost first (2026-10-28). */
  path?: PackPathRef[] | null;
  /** A parent label printed on top for context, not a pack that left. */
  context?: boolean;
  /** A pack the line itself issued (not one inside it, not a parent). */
  issued?: boolean;
}

export interface DocLabelLine {
  line_id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  qty: number;
  brand_name?: string | null;
  variant_name?: string | null;
  model_name?: string | null;
  batch_no?: string | null;
  packs: number;
  inner_packs: number;
  units: number;
}

export interface DocLabels {
  document_type: "ISSUE" | "RECEIPT";
  document_id: number;
  document_no: string;
  document_date?: string | null;
  from_name?: string | null;
  to_name?: string | null;
  lines: DocLabelLine[];
  labels: DocLabelRow[];
}

export type BoxLabelReason = "PUTAWAY" | "CONVERTED" | "RECODED" | "PART_BOX";

/** A queued (or printed) label for one box code (2026-10-26). */
export interface BoxLabel {
  id: number;
  handling_unit_id: number;
  hu_code: string;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  warehouse_id: number;
  warehouse_name?: string | null;
  bin_code?: string | null;
  batch_no?: string | null;
  pack_name?: string | null;
  content_qty: number | string;
  pack_size: number | string;
  uom_code?: string | null;
  reason: BoxLabelReason;
  source_no?: string | null;
  status: "QUEUED" | "PRINTED";
  printed_at?: string | null;
  printed_by_name?: string | null;
  created_at?: string | null;
}
