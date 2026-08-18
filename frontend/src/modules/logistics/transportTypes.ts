/** The transport leg — types mirroring `backend/app/modules/logistics/schemas.py`.
 *
 * Kept apart from `types.ts`, which describes the older GRN/issue surface. The two
 * share nothing but the module folder.
 */

export type TransportMode = "DIRECT" | "COURIER" | "OWN_VEHICLE" | "THIRD_PARTY";

/** Served by `GET /api/transport/modes`. The screen never hardcodes these rules —
 * the backend enforces them, so the form asks for exactly what will be validated. */
export interface ModeRule {
  value: TransportMode;
  label: string;
  help: string;
  needs_carrier: boolean;
  needs_quotes: boolean;
  required_fields: string[];
}

/** What the leg is carrying, which is also WHICH WAY it runs. RETURN is the same
 *  document run backwards — field to warehouse (doc E7). */
export type TransportSource = "CONSIGNMENT" | "ISSUE" | "RETURN";

/** Served by `GET /api/transport/suggest-mode`. Null when the consignment carried no
 *  distance and no weight — advice off no evidence reads as an answer, so the backend
 *  says nothing instead of guessing. */
export interface ModeSuggestion {
  mode: TransportMode;
  label: string;
  reason: string;
}

/** What the RAISER of an indent is shown about the leg carrying it — enough to answer
 *  "where is my material", and nothing about freight or who else quoted. */
export interface RaiserTracking {
  tr_id: number;
  tr_no: string;
  status: string;
  mode: TransportMode;
  consignment_no?: string | null;
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
  events: {
    event_type: string;
    event_at: string;
    location_name?: string | null;
    description?: string | null;
    is_exception: boolean;
  }[];
}

export interface EvaluationMethod {
  value: string;
  label: string;
  help: string;
  is_default: boolean;
}

/** Served by `GET /api/transport/flow?mode=`. The stepper is drawn from this, not
 * from a constant here: a tendered shipment has two stages the others do not, and
 * the backend is the thing that knows which. */
export interface FlowStage {
  key: string;
  label: string;
  help: string;
  statuses: string[];
}

/** `GET /api/transport/summary` — the logistics board, one call. */
export interface TransportSummary {
  draft: number;
  pending_approval: number;
  quoting: number;
  awaiting_carrier: number;
  ready: number;
  in_transit: number;
  delivered: number;
  acknowledged: number;
  closed: number;
  open_claims: number;
  awaiting_ack: number;
  untracked: number;
}

/** Does this packed warehouse consignment already have transport, and where is it? */
export interface ConsignmentLink {
  dispatch_id: number;
  tr_id: number;
  tr_no: string;
  mode: TransportMode;
  status: string;
  carrier_name?: string | null;
  lr_no?: string | null;
}

/** A packed consignment as the warehouse serves it (`/api/warehouse/consignments`).
 *
 * Read-only here, and only the columns the logistics desk plans against — the
 * warehouse owns the document, this module only moves it. */
export interface Consignment {
  id: number;
  dispatch_no: string;
  dispatch_type: string;
  dispatch_date: string;
  status: string;
  warehouse_id: number;
  warehouse_name?: string | null;
  to_warehouse_id?: number | null;
  to_warehouse_name?: string | null;
  destination_office_id?: number | null;
  destination_office_name?: string | null;
  customer_name?: string | null;
  vendor_name?: string | null;
  project_id?: number | null;
  project_name?: string | null;
  delivery_address?: string | null;
  contact_person?: string | null;
  contact_phone?: string | null;
  ref_type?: string | null;
  ref_id?: number | null;
  ref_no?: string | null;
  transport_mode?: string | null;
  carrier_id?: number | null;
  carrier_name?: string | null;
  vehicle_number?: string | null;
  driver_name?: string | null;
  driver_phone?: string | null;
  lr_no?: string | null;
  eway_bill_no?: string | null;
  expected_delivery?: string | null;
  total_items: number;
  total_qty: number;
  total_packages: number;
  total_weight_kg: number;
  remarks?: string | null;
  created_at: string;
}

export interface ConsignmentLine {
  id: number;
  line_no: number;
  /** Which carton this line went into. What lets the transport lines be built with
   *  each package counted exactly once. */
  package_id?: number | null;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  batch_no?: string | null;
  serial_no?: string | null;
  quantity: number;
  indent_id?: number | null;
  indent_no?: string | null;
  remarks?: string | null;
}

export interface ConsignmentPackage {
  id: number;
  package_no: string;
  package_type?: string | null;
  weight_kg?: number | null;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  is_fragile: boolean;
}

export interface ConsignmentDetail extends Consignment {
  items: ConsignmentLine[];
  packages: ConsignmentPackage[];
}

export interface TRItem {
  id: number;
  line_no: number;
  item_id?: number | null;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  quantity: number;
  delivered_qty: number;
  package_count: number;
  package_type?: string | null;
  weight_kg?: number | null;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  is_fragile: boolean;
  remarks?: string | null;
}

export interface CarrierQuote {
  id: number;
  carrier_id: number;
  carrier_name?: string | null;
  status: string;
  freight_amount?: number | null;
  other_charges: number;
  tax_percent?: number | null;
  transit_days?: number | null;
  valid_until?: string | null;
  vehicle_type?: string | null;
  remarks?: string | null;
  invited_at?: string | null;
  submitted_at?: string | null;
  score?: number | null;
  rank?: number | null;
}

export interface ShipmentEvent {
  id: number;
  event_type: string;
  event_at: string;
  location_name?: string | null;
  description?: string | null;
  is_exception: boolean;
  affected_item_name?: string | null;
  affected_qty?: number | null;
  claim_amount?: number | null;
  resolution?: string | null;
  resolved_at?: string | null;
  resolved_by_name?: string | null;
  recorded_by_name?: string | null;
  /** Present only on the Exceptions list, which returns events across requests. */
  tr_id?: number;
}

export interface TransportRequest {
  id: number;
  tr_no: string;
  tr_date?: string | null;
  mode: TransportMode;
  status: string;
  source_type?: string | null;
  source_id?: number | null;
  source_no?: string | null;
  issue_id?: number | null;
  dispatch_id?: number | null;
  consignment_no?: string | null;
  indent_id?: number | null;
  indent_no?: string | null;
  from_warehouse_id?: number | null;
  from_warehouse_name?: string | null;
  to_location_name?: string | null;
  delivery_address?: string | null;
  contact_person?: string | null;
  contact_phone?: string | null;
  distance_km?: number | null;
  project_id?: number | null;
  project_name?: string | null;
  total_items: number;
  total_qty: number;
  total_weight_kg: number;
  total_volume_cbm: number;
  total_packages: number;
  carrier_id?: number | null;
  carrier_name?: string | null;
  evaluation_method?: string | null;
  freight_amount?: number | null;
  awarded_by_name?: string | null;
  awarded_at?: string | null;
  carrier_accepted_at?: string | null;
  carrier_declined_at?: string | null;
  carrier_decline_reason?: string | null;
  carrier_reference?: string | null;
  carrier_confirmed_by_name?: string | null;
  vehicle_number?: string | null;
  driver_name?: string | null;
  driver_phone?: string | null;
  trip_reference?: string | null;
  handed_over_by_name?: string | null;
  received_by_name?: string | null;
  lr_no?: string | null;
  docket_no?: string | null;
  tracking_url?: string | null;
  eway_bill_no?: string | null;
  gate_pass_no?: string | null;
  expected_delivery?: string | null;
  dispatched_at?: string | null;
  dispatched_by_name?: string | null;
  delivered_at?: string | null;
  delivered_to_name?: string | null;
  pod_url?: string | null;
  tracking_shared_at?: string | null;
  acknowledged_at?: string | null;
  acknowledged_by_name?: string | null;
  ack_condition?: string | null;
  ack_remarks?: string | null;
  remarks?: string | null;
  requested_by_name?: string | null;
  created_at: string;
  items: TRItem[];
  quotes: CarrierQuote[];
  events: ShipmentEvent[];
}

export interface ReceiptEvidence {
  id: number;
  file_name: string;
  file_size?: number | null;
  mime_type?: string | null;
  doc_category?: string | null;
  uploaded_by_name?: string | null;
  created_at?: string | null;
}

export interface TRListRow {
  id: number;
  tr_no: string;
  tr_date?: string | null;
  mode: TransportMode;
  status: string;
  dispatch_id?: number | null;
  consignment_no?: string | null;
  indent_no?: string | null;
  from_warehouse_name?: string | null;
  to_location_name?: string | null;
  carrier_name?: string | null;
  freight_amount?: number | null;
  total_items: number;
  total_qty: number;
  total_packages: number;
  total_weight_kg: number;
  lr_no?: string | null;
  docket_no?: string | null;
  tracking_url?: string | null;
  expected_delivery?: string | null;
  dispatched_at?: string | null;
  delivered_at?: string | null;
  acknowledged_at?: string | null;
  tracking_shared_at?: string | null;
  created_at: string;
  /** The signed-in carrier's own answer to this tender — served by the carrier portal
   *  only, absent on the desk's list. `freight_amount` is the AGREED price and stays
   *  empty right through the tender, so this is the only thing that says "I priced it". */
  my_quote_status?: string | null;
  my_quote_amount?: number | null;
  my_quote_submitted_at?: string | null;
}

export interface ComparisonRow {
  quote_id: number;
  carrier_id: number;
  carrier_name?: string | null;
  status: string;
  freight_amount: number;
  other_charges: number;
  tax_percent: number;
  landed_cost: number;
  transit_days?: number | null;
  vehicle_type?: string | null;
  valid_until?: string | null;
  remarks?: string | null;
  score: number;
  rank: number;
  is_recommended: boolean;
  /** The cheapest landed cost on the sheet, and the fewest transit days — flagged
   *  independently of the rank, because the rank is one number hiding two facts and
   *  the trade-off between them is the decision the desk is actually making. Ties are
   *  all flagged: two carriers at the same price are both the cheapest. */
  is_cheapest: boolean;
  is_fastest: boolean;
}

/** Invited and silent. Carried on the sheet so "who has not answered yet" is one
 *  glance rather than a diff against the invite list. */
export interface PendingQuote {
  quote_id: number;
  carrier_id: number;
  carrier_name?: string | null;
  invited_at?: string | null;
}

/** Who the numbers point at, and what choosing them costs against the alternatives.
 *
 * A recommendation, never a decision — the backend will award any submitted quote,
 * not only this one, because the numbers do not know which carrier lost a pallet
 * last month. Facts only, no sentence: the wording and the money formatting are the
 * screen's job.
 */
export interface Recommendation {
  quote_id: number;
  carrier_id: number;
  carrier_name?: string | null;
  landed_cost: number;
  transit_days?: number | null;
  score: number;
  is_cheapest: boolean;
  is_fastest: boolean;
  cheapest?: QuoteBrief | null;
  fastest?: QuoteBrief | null;
  /** The quote this one was chosen over. Absent on a single-quote sheet. */
  runner_up?: QuoteBrief | null;
  /** What the recommendation saves against the next best price, and what it gives
   *  away in days against the quickest. `days_slower` is null when nobody quoted a
   *  transit time — an invented lead time is worse than an admitted gap. */
  saving?: number | null;
  days_slower?: number | null;
  /** Cheapest and fastest are different carriers: there is a real trade-off here. */
  is_trade_off: boolean;
}

export interface QuoteBrief {
  quote_id: number;
  carrier_id: number;
  carrier_name?: string | null;
  landed_cost: number;
  transit_days?: number | null;
}

export interface Comparison {
  tr_id: number;
  tr_no: string;
  status: string;
  mode: TransportMode;
  consignment_no?: string | null;
  to_location_name?: string | null;
  evaluation_method: string;
  invited: number;
  responded: number;
  rows: ComparisonRow[];
  pending: PendingQuote[];
  recommendation?: Recommendation | null;
  awarded_quote_id?: number | null;
  meets_three_quote_norm: boolean;
}

/** `GET /api/transport/provider-board` — a shipment as the Provider Selection desk
 *  sees it: the transport row plus how many of the partners asked have answered.
 *  A mode with no tender reads 0 of 0 — it was settled at dispatch. */
export interface ProviderBoardRow extends TRListRow {
  invited_count: number;
  responded_count: number;
  best_amount?: number | null;
  best_carrier_name?: string | null;
  best_transit_days?: number | null;
}

export interface CarrierOption {
  id: number;
  code?: string | null;
  name: string;
}

export interface TRLineInput {
  item_id?: number | null;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  quantity?: number;
  package_count?: number;
  package_type?: string | null;
  weight_kg?: number | null;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  is_fragile?: boolean;
  remarks?: string | null;
}

export interface TRInput {
  mode: TransportMode;
  tr_date?: string | null;
  source_type?: string | null;
  source_id?: number | null;
  source_no?: string | null;
  issue_id?: number | null;
  dispatch_id?: number | null;
  consignment_no?: string | null;
  indent_id?: number | null;
  indent_no?: string | null;
  from_warehouse_id?: number | null;
  from_warehouse_name?: string | null;
  to_location_name?: string | null;
  delivery_address?: string | null;
  contact_person?: string | null;
  contact_phone?: string | null;
  distance_km?: number | null;
  project_id?: number | null;
  project_name?: string | null;
  expected_delivery?: string | null;
  remarks?: string | null;
  /** Written on the dispatch screen, when the pass is already in hand. The dispatch
   *  step overwrites it if a different one is quoted as the goods leave. */
  gate_pass_no?: string | null;
  /** The tracking handles, when the desk already holds them at booking time — a
   *  courier docket is written on the slip at the counter, and asking for it again
   *  on a second screen is how it ends up typed nowhere. */
  lr_no?: string | null;
  docket_no?: string | null;
  tracking_url?: string | null;
  eway_bill_no?: string | null;
  carrier_id?: number | null;
  vehicle_number?: string | null;
  driver_name?: string | null;
  driver_phone?: string | null;
  trip_reference?: string | null;
  handed_over_by_name?: string | null;
  lines?: TRLineInput[];
}

/** What Dispatch sends. `carrier_ids` is the plural of `carrier_id`, and the field
 *  that makes a tender a tender: the same job goes to every provider named, each
 *  prices it in their own portal, and the RFQ desk compares what comes back. A mode
 *  that books outright still sends one. */
export interface DispatchInput extends TRInput {
  freight_amount?: number | null;
  carrier_ids?: number[];
  evaluation_method?: string | null;
  /** Release it on the same press. On a settled mode the gate pass, the docket and
   *  the driver are all on this form, so "confirm dispatch" IS the load leaving —
   *  and leaving is what puts it in front of the receiving site to acknowledge.
   *  Ignored on a tender: there is no carrier to leave with until it is awarded. */
  release_now?: boolean;
}

// --------------------------------------------------------------------------- //
//  Logistics vendors — the register behind the Dispatch dropdown
// --------------------------------------------------------------------------- //

/** A third-party provider (Amazon, Flipkart, Alibaba, Misaba, a truck operator) with
 *  its portal login flattened onto the same row. One row answers both questions the
 *  desk actually asks: can I dispatch with them, and can they sign in to answer? */
export interface LogisticsVendor {
  id: number;
  code?: string | null;
  name: string;
  vendor_type: string;
  contact_person?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  state?: string | null;
  gstin?: string | null;
  payment_terms_days?: number | null;
  is_active: boolean;
  is_approved: boolean;
  is_blacklisted: boolean;
  has_login: boolean;
  username?: string | null;
  login_is_active?: boolean | null;
  must_change_password?: boolean | null;
  last_login_at?: string | null;
  /** Whether Dispatch will offer them. Mirrors `carrier_options`' own filter. */
  dispatchable: boolean;
}

export interface LogisticsVendorInput {
  name: string;
  code?: string | null;
  vendor_type: string;
  contact_person?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  gstin?: string | null;
  pan?: string | null;
  payment_terms_days?: number | null;
  issue_login?: boolean;
  username?: string | null;
}

export interface LogisticsVendorSummary {
  total: number;
  dispatchable: number;
  with_login: number;
  without_login: number;
}

export interface PartnerType {
  value: string;
  label: string;
}
