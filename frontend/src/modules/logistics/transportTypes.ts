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

export interface EvaluationMethod {
  value: string;
  label: string;
  help: string;
  is_default: boolean;
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
  expected_delivery?: string | null;
  dispatched_at?: string | null;
  delivered_at?: string | null;
  delivered_to_name?: string | null;
  pod_url?: string | null;
  tracking_shared_at?: string | null;
  remarks?: string | null;
  requested_by_name?: string | null;
  created_at: string;
  items: TRItem[];
  quotes: CarrierQuote[];
  events: ShipmentEvent[];
}

export interface TRListRow {
  id: number;
  tr_no: string;
  tr_date?: string | null;
  mode: TransportMode;
  status: string;
  indent_no?: string | null;
  from_warehouse_name?: string | null;
  to_location_name?: string | null;
  carrier_name?: string | null;
  freight_amount?: number | null;
  total_packages: number;
  total_weight_kg: number;
  lr_no?: string | null;
  docket_no?: string | null;
  expected_delivery?: string | null;
  created_at: string;
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
}

export interface Comparison {
  tr_id: number;
  tr_no: string;
  status: string;
  evaluation_method: string;
  invited: number;
  responded: number;
  rows: ComparisonRow[];
  meets_three_quote_norm: boolean;
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
  carrier_id?: number | null;
  vehicle_number?: string | null;
  driver_name?: string | null;
  driver_phone?: string | null;
  trip_reference?: string | null;
  handed_over_by_name?: string | null;
  received_by_name?: string | null;
  lines?: TRLineInput[];
}
