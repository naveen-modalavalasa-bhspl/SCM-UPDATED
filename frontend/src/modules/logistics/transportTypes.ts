import type { ScopedDoc } from "@/shared/useDocNumberScope";
import type { PackEntry } from "@/shared/packing";
/** The transport leg — types mirroring `backend/app/modules/logistics/schemas.py`.
 *
 * Kept apart from `types.ts`, which describes the older GRN/issue surface. The two
 * share nothing but the module folder.
 */

export type TransportMode = "DIRECT" | "COURIER" | "OWN_VEHICLE" | "THIRD_PARTY";

/** WHAT the load travels on, as against `TransportMode`, which says who moves it.
 *  Two questions, and the dispatch screen has always asked both — this is the half
 *  that now has a column behind it (`lgs_transport_requests.carriage_mode`). */
export type CarriageMode = "ROAD" | "RAIL" | "AIR" | "SEA";

/** Served by `GET /api/transport/carriage-modes`, and by
 *  `GET /api/supplier/transport-carriage-modes?mode=` for the carrier's portal.
 *  `allowed_modes` is which arrangements can be made under this carriage: only a road
 *  leg can be carried by hand or run on a company vehicle. Served, never a constant
 *  here — the screen kept its own copy of that rule and it is the backend's. */
export interface CarriageRule {
  value: CarriageMode;
  label: string;
  help: string;
  allowed_modes: TransportMode[];
}

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

/** Served by `GET /api/transport/dispatch-policy` — the slice of Company Settings the
 *  dispatch form needs, and the only one a dispatcher may read.
 *
 *  `manual_courier_dispatch` decides WHICH courier form is drawn: a vendor from the
 *  carrier register, or a name typed at the counter. The two lists below apply only to
 *  the typed one, and they are served rather than written into the screen because they
 *  are the same lists the service refuses the press on — a manual courier has no
 *  portal, so what a vendor would have filled in from their own login has to be typed
 *  here. Either one of `tracking_fields` satisfies it; the rest are each required. */
export interface DispatchPolicy {
  manual_courier_dispatch: boolean;
  manual_courier_required_fields: string[];
  manual_courier_tracking_fields: string[];
  send_third_party_to_vendor?: boolean;
}

/** What the leg is carrying, which is also WHICH WAY it runs. RETURN is the same
 *  document run backwards — field to warehouse (doc E7). */
export type TransportSource = "CONSIGNMENT" | "ISSUE" | "RETURN" | "TRIP";

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
  /** The same rung read while the desk still owes it a press. Only the award stage
   *  has one, because that rung has two halves — our sign-off, then the provider's. */
  pending_help?: string | null;
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
  /** What it is travelling on — including a carriage the WINNING carrier changed
   *  when they acknowledged the award. */
  carriage_mode?: CarriageMode | null;
  status: string;
  carrier_name?: string | null;
  lr_no?: string | null;
  /** Who is coming for it. The carrier's own answer on a tender — written when they
   *  acknowledge the award, never typed by the desk. */
  driver_name?: string | null;
  vehicle_number?: string | null;
  /** Set when the consignment rides a multi-drop trip: `tr_*` is the TRIP's shipment,
   *  and the trip is where its own stop is followed. */
  trip_id?: number | null;
  trip_no?: string | null;
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
  /** SCM_0053: the origin's address, carried into the transport leg this
   *  consignment is dispatched on. */
  warehouse_address?: string | null;
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
  /** Each issue line's packs, once per line (2026-10-22) — the rows are per unit. */
  line_packs?: ConsignmentLinePacks[];
}

export interface ConsignmentLinePacks {
  issue_item_id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  batch_no?: string | null;
  quantity: number;
  delivered_qty: number;
  pack_breakdown?: PackEntry[] | null;
  delivered_pack_breakdown?: PackEntry[] | null;
}

// --------------------------------------------------------------------------- //
//  Smart Load Planner and multi-drop trips (`/api/warehouse/trip-planner/*`,
//  `/api/warehouse/consolidated-trips`). One vehicle, several consignments, several
//  stops — carried by ONE shipment, signed for stop by stop.
// --------------------------------------------------------------------------- //

/** How sure the planner is of a consignment's weight / size. WEIGHED and MEASURED
 *  are firm (every package); ESTIMATED is from the items' packing ladders; ASSUMED is
 *  packages x the site's typical carton; null is nothing known. */
export type LoadBasis = "WEIGHED" | "MEASURED" | "ESTIMATED" | "ASSUMED" | null;

/** ROAD: every leg routed. MIXED: some routed, some estimated. ESTIMATE: none. */
export type DistanceBasis = "ROAD" | "MIXED" | "ESTIMATE";

export interface RoutingInfo {
  routing_configured: boolean;
  service?: string | null;
  service_error?: string | null;
  routed_pairs: number;
  estimate_factor: number;
  estimate_factor_source: "SITE" | "CALIBRATED";
  calibrated_pairs: number;
  /** The sentence the screen prints about where its kilometres came from. */
  text: string;
}

export interface PlannerPolicy {
  capacity_kg: number;
  /** The cargo box, m³. 0 = not limited by volume. */
  capacity_cbm: number;
  /** How much of the box a load can really fill. */
  volume_fill_pct: number;
  usable_cbm?: number;
  /** What an unweighed / unmeasured package is assumed to be. 0 = no assumption. */
  default_package_kg: number;
  default_package_cbm: number;
  /** 0 = the vehicle is limited by weight alone. */
  max_packages: number;
  max_stops: number;
  /** How much longer than the straight run a stop may make the trip. */
  max_detour_pct: number;
  detour_floor_km: number;
  cost_per_km: number;
  road_factor: number;
  return_to_origin: boolean;
  distance_basis?: string;
  road_factor_used?: number;
  routing?: RoutingInfo;
}

export interface VehicleProfile {
  code: string;
  label: string;
  capacity_kg: number;
  capacity_cbm: number;
  max_packages: number;
  cost_per_km: number;
}

export interface PlannerPolicyResponse {
  policy: PlannerPolicy;
  vehicle_profiles: VehicleProfile[];
  configured: string[];
  routing?: { configured: boolean };
}

/** One place a stocking point might be, from the offline gazetteer. */
export interface PointCandidate {
  name: string;
  district?: string | null;
  latitude: number;
  longitude: number;
  score: number;
  /** In the district HCM puts the office in. */
  in_district: boolean;
  /** The mandal the source records it in, and whether that is HCM's mandal. */
  mandal?: string | null;
  in_mandal?: boolean;
  source: "GEONAMES" | "POSTAL";
  accuracy: number;
  /** False for a postcode centroid: the right area, not the village. */
  precise: boolean;
  label: string;
}

export interface PointCandidates {
  point: TripMapPoint;
  query: string;
  district?: string | null;
  /** HCM's mandal for the office. */
  mandal?: string | null;
  candidates: PointCandidate[];
}

export interface ConsignmentMeasures {
  weight_kg: number;
  weight_basis: LoadBasis;
  volume_cbm: number;
  volume_basis: LoadBasis;
  packages: number;
  packages_weighed: number;
  packages_measured: number;
}

export interface ConsignmentPackages {
  dispatch_id: number;
  consignment_no: string;
  status: string;
  packages: {
    id: number; package_no: string; package_type?: string | null;
    weight_kg?: number | string | null; length_cm?: number | string | null;
    width_cm?: number | string | null; height_cm?: number | string | null;
  }[];
  measures: ConsignmentMeasures;
}

export interface TripMapPoint {
  id: number;
  code: string;
  name: string;
  warehouse_type?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  /** MANUAL (pinned / typed), HCM (GPS from HCM), GEONAMES_LOCALITY (matched by
   *  name), GAZETTEER_UNRESOLVED. */
  coordinate_source?: string | null;
  coordinate_label?: string | null;
  coordinate_confidence?: number | string | null;
}

export interface TripMapNetwork {
  points: TripMapPoint[];
  total: number;
  mapped: number;
  unresolved: number;
  newly_mapped: number;
  /** Set on the read that re-checked the master after the matcher improved. */
  rechecked?: { tried: number; mapped: number; moved: number; kept: number;
    withdrawn: number; unresolved: number } | null;
  source: string;
}

/** One ready consignment as the planner sees it — its UNIQUE number and where it
 *  comes off the truck. */
export interface PlanConsignment {
  dispatch_id: number;
  consignment_no: string;
  destination_warehouse_id: number;
  destination_code?: string | null;
  destination_name: string;
  /** What a person reads the stop by — "Badangi", not the operational label. */
  destination_place?: string;
  destination_type?: string | null;
  delivery_address?: string | null;
  latitude: number;
  longitude: number;
  packages: number;
  weight_kg: number;
  weight_known: boolean;
  weight_basis: LoadBasis;
  volume_cbm: number;
  volume_known: boolean;
  volume_basis: LoadBasis;
  packages_weighed: number;
  packages_measured: number;
  expected_delivery?: string | null;
  indent_no?: string | null;
  project_name?: string | null;
  direct_km: number;
}

export interface PlanStop {
  sequence: number;
  destination_warehouse_id: number;
  destination_code?: string | null;
  destination_name: string;
  /** What a person reads the stop by — "Badangi", not the operational label. */
  destination_place?: string;
  destination_type?: string | null;
  delivery_address?: string | null;
  latitude: number;
  longitude: number;
  distance_from_previous_km: number;
  distance_basis?: DistanceBasis;
  cumulative_km: number;
  adds_km: number;
  /** Why this stop is on this truck, in a sentence. */
  reason: string;
  consignments: PlanConsignment[];
  total_packages: number;
  total_weight_kg: number;
  total_volume_cbm?: number;
}

export interface PlannedTrip {
  key?: string;
  /** Named for the farthest drop — the run everything else rides along on. */
  label?: string;
  kind: "MULTI_DROP" | "SAME_STOP";
  stops: PlanStop[];
  consignments: PlanConsignment[];
  total_consignments: number;
  total_packages: number;
  total_weight_kg: number;
  firm_weight_kg?: number;
  total_volume_cbm?: number;
  firm_volume_cbm?: number;
  weight_bases?: Record<string, number>;
  volume_bases?: Record<string, number>;
  capacity_utilisation_pct: number;
  volume_utilisation_pct?: number | null;
  package_utilisation_pct?: number | null;
  estimated_distance_km: number;
  /** The shortest order for the same stops, and its length — beside the one driven. */
  optimal_order?: number[];
  optimal_distance_km?: number;
  order_is_optimal?: boolean;
  distance_basis?: DistanceBasis;
  return_km: number;
  separate_distance_km: number;
  estimated_saving_km: number;
  estimated_cost: number;
  separate_cost: number;
  estimated_saving_amount: number;
  saving_pct: number;
  vehicles_saved: number;
  /** What REFUSES the trip — only ever firm figures or counts. Also in `warnings`. */
  blockers?: string[];
  warnings: string[];
}

export interface PlanOrigin {
  id: number;
  code: string;
  name: string;
  place?: string;
  warehouse_type?: string | null;
  latitude: number;
  longitude: number;
}

export interface PlanExcluded {
  dispatch_id: number;
  consignment_no: string;
  destination_warehouse_id?: number | null;
  destination_name?: string | null;
  destination_place?: string | null;
  reason: string;
  can_pin: boolean;
}

export interface PlanSingle extends PlanConsignment {
  reason: string;
}

export interface TripRecommendations {
  origin: PlanOrigin;
  policy: PlannerPolicy;
  candidates: PlanConsignment[];
  excluded: PlanExcluded[];
  trips: PlannedTrip[];
  singles: PlanSingle[];
  totals: {
    consignments: number;
    vehicles_before: number;
    vehicles_after: number;
    separate_distance_km: number;
    planned_distance_km: number;
    saving_km: number;
    saving_amount: number;
    saving_pct: number;
  };
}

export interface TripAddition extends PlanConsignment {
  adds_km: number;
  saves_km: number;
  saves_amount: number;
  fits: boolean;
  blocked_reason?: string | null;
  on_the_way: boolean;
}

/** One place the truck could call at NEXT, measured from the route's last stop —
 *  what the hand-built route offers under "Add a stop". */
export interface NextStopOption {
  destination_warehouse_id: number;
  destination_place: string;
  destination_name: string;
  destination_code?: string | null;
  destination_type?: string | null;
  latitude: number;
  longitude: number;
  dispatch_ids: number[];
  consignment_nos: string[];
  packages: number;
  weight_kg: number;
  /** The last stop it is measured from; null = from the origin. */
  from_place?: string | null;
  from_last_km: number;
  distance_basis?: DistanceBasis | null;
  adds_km: number;
  /** Against ONE truck sent to that place on its own. Negative = costs more. */
  saves_km: number;
  saves_amount: number;
  already_a_stop: boolean;
  fits: boolean;
  blocked_reason?: string | null;
}

export interface TripEvaluation extends PlannedTrip {
  unavailable: number[];
  additions: TripAddition[];
  next_stops?: NextStopOption[];
  origin: PlanOrigin;
  policy: PlannerPolicy;
}

export type PolicyOverrides = Partial<Omit<PlannerPolicy, "distance_basis">>;

export interface TripConsignment {
  id: number;
  dispatch_id: number;
  consignment_no: string;
  destination_warehouse_id?: number | null;
  destination_name: string;
  indent_id?: number | null;
  indent_no?: string | null;
  indent_nos?: string | null;
  packages: number;
  weight_kg: number | string;
  /** PLANNED / IN_TRANSIT / DELIVERED / ACKNOWLEDGED / CANCELLED. */
  status: string;
  /** The consignment's OWN document status on the warehouse side. */
  consignment_status?: string | null;
  delivery_address?: string | null;
  contact_person?: string | null;
  contact_phone?: string | null;
  delivered_at?: string | null;
  acknowledged_at?: string | null;
  acknowledged_by_name?: string | null;
  ack_condition?: string | null;
}

export interface TripStop {
  id: number;
  sequence: number;
  destination_warehouse_id: number;
  destination_code?: string | null;
  destination_name: string;
  delivery_address?: string | null;
  latitude: number | string;
  longitude: number | string;
  status: string;
  distance_from_previous_km: number | string;
  total_consignments: number;
  total_packages: number;
  total_weight_kg: number | string;
  delivered_at?: string | null;
  delivered_by_name?: string | null;
  received_by_name?: string | null;
  /** DESK or CARRIER — who reported the stop reached. */
  delivered_via?: string | null;
  pod_url?: string | null;
  contact_person?: string | null;
  contact_phone?: string | null;
  acknowledged_at?: string | null;
  consignments: TripConsignment[];
}

export interface TripShipmentEvent {
  id: number;
  event_type: string;
  event_at: string;
  location_name?: string | null;
  description?: string | null;
  is_exception: boolean;
  resolved_at?: string | null;
  recorded_by_name?: string | null;
}

export interface TripShipment {
  id: number;
  tr_no: string;
  status: string;
  mode: string;
  carriage_mode?: string | null;
  carrier_name?: string | null;
  freight_amount?: number | string | null;
  lr_no?: string | null;
  docket_no?: string | null;
  gate_pass_no?: string | null;
  vehicle_number?: string | null;
  driver_name?: string | null;
  driver_phone?: string | null;
  tracking_url?: string | null;
  dispatched_at?: string | null;
  delivered_at?: string | null;
  acknowledged_at?: string | null;
  quotes_received: number;
  quotes_invited: number;
  open_claims: number;
  events: TripShipmentEvent[];
}

export interface TripNextAction {
  code: "ARRANGE" | "PROVIDER" | "RELEASE" | "DELIVER" | "AWAIT_ACK" | "NONE";
  label: string;
  hint?: string | null;
  stop_id?: number | null;
}

export interface ConsolidatedTrip {
  id: number;
  trip_no: string;
  status: string;
  departure_date: string;
  from_warehouse_id: number;
  from_warehouse_name?: string | null;
  origin_latitude: number | string;
  origin_longitude: number | string;
  tr_id?: number | null;
  tr_no?: string | null;
  policy_name: string;
  vehicle_profile?: string | null;
  vehicle_capacity_kg?: number | string | null;
  returns_to_origin: boolean;
  road_factor?: number | string | null;
  cost_per_km?: number | string | null;
  total_consignments: number;
  total_stops: number;
  total_packages: number;
  total_weight_kg: number | string;
  estimated_distance_km: number | string;
  separate_distance_km: number | string;
  estimated_saving_km: number | string;
  estimated_saving_amount: number | string;
  distance_basis?: DistanceBasis;
  vehicle_capacity_cbm?: number | string | null;
  total_volume_cbm?: number | string | null;
  vehicle_number?: string | null;
  driver_name?: string | null;
  driver_phone?: string | null;
  gate_pass_no?: string | null;
  dispatched_at?: string | null;
  completed_at?: string | null;
  cancelled_at?: string | null;
  remarks?: string | null;
  created_by_name?: string | null;
  created_at?: string | null;
  stops_delivered: number;
  stops_acknowledged: number;
  consignments_acknowledged: number;
  stops: TripStop[];
  shipment?: TripShipment | null;
  next_action: TripNextAction;
  /** List rows only. */
  shipment_status?: string | null;
  carrier_name?: string | null;
  mode?: string | null;
}

/** A multi-drop run as the WINNING carrier's portal shows it (`transport.trip_brief`). */
export interface CarrierTripStop {
  id: number;
  sequence: number;
  destination_name: string;
  destination_code?: string | null;
  delivery_address?: string | null;
  contact_person?: string | null;
  contact_phone?: string | null;
  latitude: number | string;
  longitude: number | string;
  status: string;
  distance_from_previous_km: number | string;
  total_packages: number;
  total_weight_kg: number | string;
  delivered_at?: string | null;
  received_by_name?: string | null;
  delivered_via?: string | null;
  pod_url?: string | null;
  consignments: { consignment_no: string; packages: number; weight_kg: number | string;
    status: string }[];
}

export interface CarrierTrip {
  id: number;
  trip_no: string;
  status: string;
  total_stops: number;
  stops_delivered: number;
  next_stop_id?: number | null;
  distance_basis?: DistanceBasis;
  stops: CarrierTripStop[];
}

export interface TripPage {
  items: ConsolidatedTrip[];
  total: number;
  page: number;
  size: number;
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
  package_quantities?: PackageQuantity[];
}

export interface PackageQuantity {
  package_id?: number | null;
  package_no?: string | null;
  package_type?: string | null;
  quantity: number;
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

export interface TransportRequest extends ScopedDoc {
  id: number;
  tr_no: string;
  /** The stops of the multi-drop run this shipment carries — served to the winning
   *  carrier's portal, where each stop is reported delivered. */
  trip?: CarrierTrip | null;
  tr_date?: string | null;
  mode: TransportMode;
  carriage_mode?: CarriageMode | null;
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
  /** The origin's address (SCM_0053) — what the DC/DOD gate pass prints under
   *  "From". Carried off the consignment's own warehouse_address. */
  from_warehouse_address?: string | null;
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
  /** The consignment's cartons, each counted once (SCM_0130) — what the gate counts.
   *  Null on a leg with no consignment behind it. */
  consignment_package_total?: number | null;
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
  driver_licence_no?: string | null;
  trip_reference?: string | null;
  handed_over_by_name?: string | null;
  handed_over_employee_id?: string | null;
  handed_over_aadhaar?: string | null;
  handed_over_phone?: string | null;
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
  carriage_mode?: CarriageMode | null;
  status: string;
  /** FIX 2026-09-07: which document the leg carries. An outward leg names itself with
   *  `consignment_no` / `indent_no` below; a RETURN leg has neither, so without these
   *  the dispatch board could not tell a return apart from anything else on it. */
  source_type?: TransportSource | null;
  source_no?: string | null;
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
  /** The number card's selection (2026-11-12) — `docNumberPayload`. Against an indent
   *  that carries an organisation the server copies the indent's instead. */
  organization_id?: number | null;
  org_department_id?: number | null;
  fiscal_year?: string | null;
  mode: TransportMode;
  /** Road / rail / air / sea. Optional on the wire: the service falls back to ROAD,
   *  which is what a leg that named no carriage has always been. */
  carriage_mode?: CarriageMode | null;
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
  /** The origin's address (SCM_0053) — what the DC/DOD gate pass prints under
   *  "From". Carried off the consignment's own warehouse_address. */
  from_warehouse_address?: string | null;
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
  /** Used only when Company Settings enables manual courier dispatch. */
  manual_courier_name?: string | null;
  carrier_reference?: string | null;
  vehicle_number?: string | null;
  driver_name?: string | null;
  driver_phone?: string | null;
  driver_licence_no?: string | null;
  trip_reference?: string | null;
  handed_over_by_name?: string | null;
  handed_over_employee_id?: string | null;
  handed_over_aadhaar?: string | null;
  handed_over_phone?: string | null;
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

// --------------------------------------------------------------------------- //
//  The activity ledger
// --------------------------------------------------------------------------- //
// `GET /api/transport/activity` — one normalised row per event, unioned from the
// request header, the approval actions, the carrier quotes and the shipment
// timeline. The screen renders what it is sent: `event_label` and `result` are
// SERVED, never mapped here, so the ledger and the backend cannot drift.

export interface ActivityRow {
  /** Unique across the union ("evt:12", "wf:9", "tr:5:awarded"). */
  event_id: string;
  tr_id: number;
  tr_no: string;
  consignment_no?: string | null;
  indent_no?: string | null;
  mode: TransportMode;
  event_type: string;
  event_label: string;
  /** The rung this event put the shipment on — not its status today. */
  result: string;
  occurred_at: string;
  actor_name?: string | null;
  carrier_name?: string | null;
  location_name?: string | null;
  detail?: string | null;
  /** Freight quoted, freight awarded, or the value of a claim. */
  amount?: number | null;
  is_exception: boolean;
  from_name?: string | null;
  to_name?: string | null;
}

/** `GET /api/transport/activity-types` — the filter's options, in the order the
 *  events happen. Served for the same reason the mode rules are. */
export interface ActivityType {
  value: string;
  label: string;
  is_exception: boolean;
}
