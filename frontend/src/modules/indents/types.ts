import type { CombinationValue } from "@/shared/combination";
import type { PackEntry } from "@/shared/packing";
export interface IndentItem {
  /** Brand / variant / model, or Any (2026-10-23). 0 / absent when none. */
  brand_id?: number;
  variant_id?: number;
  model_id?: number;
  brand_name?: string | null;
  variant_name?: string | null;
  model_name?: string | null;
  combination_any?: boolean;
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

/**
 * REGULAR is what every indent raised before the field was exposed carries, so it
 * stays part of the union — list and detail screens must render it, not fall through
 * to a blank. It's also the ad-hoc request type; MONTHLY is the recurring one.
 */
/** STR = a Stock Transfer Request, raised from Inventory > Stock Transfer. */
export type IndentType = "REGULAR" | "MONTHLY" | "STR";

export interface Indent {
  id: number;
  indent_no: string;
  /**
   * Optional for the same reason ActivityRow carries its compatibility aliases: a
   * deployed backend that predates the field omits it, and the screens must render
   * rather than break. A current backend always sends it — it defaults to REGULAR.
   */
  indent_type?: IndentType | string;
  indent_date?: string | null;
  required_date?: string | null;
  vehicle_id?: number | null;
  vehicle_number?: string | null;
  requested_by_id?: number | null;
  requested_by_name?: string | null;
  position_id?: number | null;
  position_name?: string | null;
  department_id?: number | null;
  department_name?: string | null;
  office_id?: number | null;
  office_name?: string | null;
  /** Service area code of the delivery office, resolved from HCM when the indent is
   *  served. Null for offices HCM holds no SAC for. */
  office_sac?: string | null;
  /**
   * Region/Location: the HCM location the requester is tagged to, snapshotted when the
   * indent was raised. Read-only everywhere — there is no field for it on
   * IndentCreate/IndentUpdate, and the backend ignores one if it is sent. Null on
   * indents raised before the field existed and on raisers HCM has no location for.
   */
  region_id?: number | null;
  region_name?: string | null;
  project_id?: number | null;
  project_name?: string | null;
  status: string;
  priority: string;
  total_items: number;
  total_qty: number;
  remarks?: string | null;
  current_approver_name?: string | null;
  approved_at?: string | null;
  is_bookmarked: "YES" | "NO" | string;
  can_submit: boolean;
  can_approve: boolean;
  can_reject: boolean;
  can_return_for_correction?: boolean;
  can_edit_correction?: boolean;
  can_resubmit_correction?: boolean;
  correction_owner?: {
    employee_id: number;
    employee_name?: string | null;
    position_id?: number | null;
  } | null;
  returned_from_stage?: string | null;
  resubmit_target_stage?: string | null;
  correction_comment?: string | null;
  created_at: string;
  items: IndentItem[];
}

export interface IndentListRow {
  id: number;
  indent_no: string;
  indent_type?: IndentType | string;
  requested_by_name?: string | null;
  department_name?: string | null;
  region_id?: number | null;
  region_name?: string | null;
  status: string;
  priority: string;
  total_items: number;
  current_approver_name?: string | null;
  is_bookmarked: "YES" | "NO" | string;
  created_at: string;
  /** Days since raised; frozen at the last change once CLOSED or REJECTED. */
  age_days?: number | null;
}

/** One Region/Location bucket of the stats breakdown. Null id = no location. */
export interface RegionCount {
  region_id?: number | null;
  region_name?: string | null;
  count: number;
}

export interface IndentStats {
  total: number;
  draft: number;
  awaiting_approval: number;
  approved_active: number;
  rejected: number;
  ordered: number;
  this_month: number;
  total_items: number;
  total_qty: number;
  approval_rate: number;
  by_status: Record<string, number>;
  /** Optional: a backend that predates Region omits it, so screens must tolerate that. */
  by_region?: RegionCount[];
}

export interface ActivityRow {
  event_id: string;
  indent_id: number;
  indent_no: string;
  event_type?:
  | "REQUEST_CREATED"
  | "REQUEST_SUBMITTED"
  | "APPROVAL_COMPLETED"
  | "REQUEST_REJECTED"
  | "REQUEST_RETURNED"
  | "APPROVAL_ROUTED_AUTOMATICALLY"
  | "STOCK_ALLOCATED"
  | "PROCUREMENT_REQUEST_CREATED"
  | "MATERIAL_ISSUED"
  | "MATERIAL_DISPATCHED"
  | "RECEIPT_ACKNOWLEDGED"
  | "BOOKMARK_ADDED"
  | "BOOKMARK_REMOVED"
  | string
  | null;
  event_label?: string | null;
  result?: string | null;
  result_label?: string | null;
  occurred_at?: string | null;
  actor_id?: number | null;
  actor_name?: string | null;
  actor_position?: string | null;
  item_id?: number | null;
  item_code?: string | null;
  item_name?: string | null;
  quantity?: number | string | null;
  requested_quantity?: number | string | null;
  uom_code?: string | null;
  /**
   * Lines on the whole request. Present ONLY on the header events, where `quantity` is
   * the sum of the request rather than one line's own number; null on the per-item
   * events. Optional: a backend deployed before this field omits it, and the QTY column
   * then falls back to the per-line reading it has always used.
   */
  line_count?: number | null;
  department_name?: string | null;
  office_name?: string | null;
  region_id?: number | null;
  region_name?: string | null;
  remarks?: string | null;
  source_type?: string | null;
  source_id?: number | null;

  // Temporary compatibility with a backend process serving the pre-normalized
  // Activity contract. These aliases can be removed after every deployed backend
  // serves the normalized fields above.
  event_at?: string | null;
  transaction_type?: string | null;
  direction?: string | null;
  status?: string | null;
  requested_by_name?: string | null;
  comments?: string | null;
}

/** One stage of what physically happened to the goods, after the approval stages. */
export interface FulfilmentStep {
  key: string;
  label: string;
  state: "completed" | "current" | "pending" | string;
  caption?: string | null;
}

/** One line of an indent on the "what am I still owed" screen. */
export interface AcknowledgementLine extends CombinationValue {
  /** The packs it was sent in, merged over its issue lines (2026-10-22). */
  pack_breakdown?: PackEntry[] | null;
  pack_text?: string | null;
  indent_item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  approved_quantity: number;
  issued_quantity: number;
  dispatched_quantity: number;
  received_quantity: number;
  is_serial_tracked?: boolean;
  /**
   * Which KIND of identifier `serial_numbers` holds — SERIAL, IMEI, ASSET,
   * CONSUMABLE or NONE. Served, never inferred here: the four look identical on a
   * label, and only the item says which one was printed on the goods.
   */
  tracking_type?: string;
  /** The units that left the warehouse for this line, by whichever code each carries. */
  serial_numbers?: string[];
  /**
   * How much of this line procurement is already buying. Served, because nothing on
   * the screen can work it out: the indent status describes the whole document, so a
   * mixed indent — one line off the shelf, one out to be bought — says nothing about
   * which line is which. Absent on an older backend, hence optional.
   */
  on_order_quantity?: number;
  package_quantities?: AcknowledgementPackageQuantity[];
  /** Derived server-side: "On the way to you", "With procurement", … */
  pending_with?: string | null;
}

/**
 * How much of one line travelled in one physical package — and what that package IS.
 *
 * The description is served with the quantity because the person confirming the
 * delivery is holding the carton: a number on a screen identifies it only if the
 * label happens to be facing them, where "the 12.5 kg fragile carton, 60 x 40 x 30"
 * is something they can check against the thing in their hands. Every measurement is
 * nullable and a blank is drawn as nothing at all — an unweighed package is not a
 * package weighing zero.
 */
export interface AcknowledgementPackageQuantity {
  /** The packs THIS package holds of the line, as packed (2026-10-22). */
  pack_breakdown?: PackEntry[] | null;
  pack_text?: string | null;
  dispatch_id?: number | null;
  dispatch_no?: string | null;
  package_id?: number | null;
  package_no?: string | null;
  quantity: number;
  package_type?: string | null;
  barcode?: string | null;
  weight_kg?: number | null;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  is_fragile?: boolean;
  is_temp_controlled?: boolean;
  packed_by_name?: string | null;
  packed_at?: string | null;
}

/**
 * How the goods are travelling, for the person waiting on them.
 *
 * Read-only, and served on the requester's own acknowledgement row rather than from
 * a Logistics screen they hold no permission for: "it has left" is useless without
 * the docket number to chase it with, and the carrier's own page is the only thing
 * that answers "where is it today".
 */
export interface ShipmentTrack {
  dispatch_id?: number | null;
  tr_id: number;
  tr_no: string;
  mode: string;
  status: string;
  carrier_name?: string | null;
  vehicle_number?: string | null;
  driver_name?: string | null;
  driver_phone?: string | null;
  lr_no?: string | null;
  docket_no?: string | null;
  tracking_url?: string | null;
  expected_delivery?: string | null;
  dispatched_at?: string | null;
  delivered_at?: string | null;
  acknowledged_at?: string | null;
}

/**
 * The raiser's view of one shipment carrying their indent.
 *
 * This is deliberately owned by the indents module even though it is served by the
 * transport API. Importing logistics types here would reverse the module dependency.
 */
export interface RaiserShipmentEvent {
  event_type: string;
  event_at: string;
  location_name?: string | null;
  description?: string | null;
  is_exception: boolean;
}

export interface RaiserTracking {
  dispatch_id?: number | null;
  tr_id: number;
  tr_no: string;
  status: string;
  mode: string;
  /** How it travels, in words. Served with the codes because this module sits before
   *  logistics in the chain and cannot import its mode tables to look one up. */
  mode_label?: string | null;
  carriage_mode?: string | null;
  carriage_label?: string | null;
  consignment_no?: string | null;
  /** The dispatch's own document number (`.../DSP0001`), printed on the gate pass. */
  gate_pass_no?: string | null;
  carrier_name?: string | null;
  lr_no?: string | null;
  docket_no?: string | null;
  tracking_url?: string | null;
  vehicle_number?: string | null;
  driver_name?: string | null;
  driver_phone?: string | null;
  handed_over_by_name?: string | null;
  expected_delivery?: string | null;
  dispatched_at?: string | null;
  delivered_at?: string | null;
  tracking_shared_at?: string | null;
  acknowledged_at?: string | null;
  ack_condition?: string | null;
  events: RaiserShipmentEvent[];
  /* ---- Set only when the consignment rides a multi-drop trip: one truck, several
   *      stops. `status` above is then THIS stop's, and the truck's is below. ---- */
  trip_id?: number | null;
  trip_no?: string | null;
  trip_status?: string | null;
  shipment_status?: string | null;
  stop_id?: number | null;
  stop_status?: string | null;
  stop_sequence?: number | null;
  stop_name?: string | null;
  stop_address?: string | null;
  total_stops?: number | null;
  stops_delivered?: number | null;
  /** Drops the truck still makes before this one. 0 on the road = "you are next". */
  stops_before_yours?: number | null;
  next_stop_name?: string | null;
  stop_delivered_at?: string | null;
  stop_received_by_name?: string | null;
  from_warehouse_name?: string | null;
  departure_date?: string | null;
}

export interface Acknowledgement {
  indent_id: number;
  indent_no: string;
  indent_date?: string | null;
  required_date?: string | null;
  status: string;
  priority?: string | null;
  project_name?: string | null;
  can_acknowledge: boolean;
  lines: AcknowledgementLine[];
  shipments: ShipmentTrack[];
}

/** What arrived in THIS delivery, not the running total. */
export interface AcknowledgeLine {
  indent_item_id: number;
  received_quantity: number;
}

export interface ReceiptAttachment {
  id: number;
  file_name: string;
  file_path: string;
  mime_type?: string | null;
  doc_category?: string | null;
  uploaded_by_name?: string | null;
  created_at?: string | null;
}

export interface IndentNotification {
  id: string;
  indent_id: number;
  indent_no: string;
  title: string;
  message: string;
  status: string;
  created_at: string;
}

// The approval inbox shapes (PendingApproval, ApprovalDecisionRow, TeamQueueRow)
// moved to modules/approvals/types.ts along with the screens that read them.
// Delegation is no longer exposed at all — see modules/approvals/__init__.py.

export interface IndentCreate {
  required_date?: string | null;
  priority: string;
  indent_type?: IndentType;
  vehicle_id?: number | null;
  remarks?: string | null;
  items: {
    item_id: number; quantity: number; remarks?: string;
    brand_id?: number | null; variant_id?: number | null; model_id?: number | null;
    combination_any?: boolean;
  }[];
}

export interface IndentUpdate extends IndentCreate {
  office_id?: number | null;
}

export interface BomChoice {
  id: number;
  code: string;
  name: string;
  project_name?: string | null;
  description?: string | null;
  total_items: number;
  is_active: boolean;
  /** Switched on and inside its optional validity window (masters decides both). */
  is_effective?: boolean;
}

export interface BomChoiceItem {
  id: number;
  bom_id: number;
  line_no: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  category_name?: string | null;
  uom_code?: string | null;
  quantity?: number | null;
}

export interface TemplateLineItem {
  item_id: number;
  item_code: string;
  item_name: string;
  uom_code?: string | null;
  quantity?: number | null;
}

export interface IndentJourneyStage {
  event_id?: string | null;
  sequence: number;
  title: string;
  status: "SUBMITTED" | "APPROVED" | "REJECTED" | "PENDING" | "NOT_REQUIRED" | string;
  is_current?: boolean;
  approver_name?: string | null;
  position_name?: string | null;
  timestamp?: string | null;
  comments?: string | null;
  duration_seconds?: number | null;
  stage_type: string;
  approval_mode?: string | null;
  reference_no?: string | null;
  quantity_summary?: string | null;
  evidence_source?: string | null;
}

export interface IndentJourneyHistoryEvent {
  id: string;
  event_type: string;
  title: string;
  description?: string | null;
  actor_name?: string | null;
  position_name?: string | null;
  timestamp: string;
  comments?: string | null;
  reference_no?: string | null;
  quantity_summary?: string | null;
}

export interface IndentJourney {
  contract_version?: 5;
  indent_id: number;
  indent_no: string;
  status: string;
  requested_by_name?: string | null;
  requested_by_position?: string | null;
  created_at: string;
  current_stage?: string | null;
  current_stage_message: string;
  final_any_one_outcome?: string | null;
  stages: IndentJourneyStage[];
  phases: IndentJourneyStage[];
  history: IndentJourneyHistoryEvent[];
  missing_sources: string[];
}

/** A material issue raised against no indent, as the person it was issued to sees it. */
export interface DirectIssueAck {
  issue_id: number;
  issue_no: string;
  issue_date: string | null;
  status: string;
  warehouse_name: string | null;
  department_name: string | null;
  project_name: string | null;
  issued_by_name: string | null;
  total_qty: number | string;
  acknowledged_by_name: string | null;
  acknowledged_at: string | null;
  can_acknowledge: boolean;
  lines: {
    item_code: string | null; item_name: string | null; uom_code: string | null;
    batch_no: string | null; issued_qty: number | string
  }[];
  /** The consignments carrying this issue, each with its package count. */
  consignments?: {
    dispatch_id: number; dispatch_no: string; status: string | null;
    package_count: number
  }[];
}
