import { api } from "@/shared/api/client";
import type { Paginated } from "@/shared/types";
import type { GRN, GRNCreate, GRNListRow, Issue, MovementRow, StockRow } from "./types";
import type {
  ActivityRow, ActivityType,
  CarriageRule, CarrierOption, CarrierQuote, Comparison, Consignment, ConsignmentDetail,
  ConsignmentLink, DispatchInput, DispatchPolicy, EvaluationMethod, FlowStage,
  LogisticsVendor, LogisticsVendorInput, LogisticsVendorSummary, ModeRule,
  ModeSuggestion,
  PartnerType, ProviderBoardRow, RaiserTracking, ReceiptEvidence, ShipmentEvent, TransportRequest,
  TransportSummary, TRInput, TRListRow, ConsolidatedTrip, PlannerPolicyResponse,
  PolicyOverrides, TripEvaluation, TripMapNetwork, TripMapPoint, TripPage,
  TripRecommendations, VehicleProfile, PointCandidates, ConsignmentPackages,
} from "./transportTypes";

export const grnApi = {
  list: (params: { status?: string; po_id?: number; page?: number; size?: number }) =>
    api.get<Paginated<GRNListRow>>("/api/grn", { params }).then((r) => r.data),
  get: (id: number) => api.get<GRN>(`/api/grn/${id}`).then((r) => r.data),
  createFromPo: (poId: number, data: GRNCreate) =>
    api.post<GRN>(`/api/grn/from-po/${poId}`, data).then((r) => r.data),
  qcPass: (id: number) => api.post<GRN>(`/api/grn/${id}/qc-pass`).then((r) => r.data),
  qcFail: (id: number) => api.post<GRN>(`/api/grn/${id}/qc-fail`).then((r) => r.data),
};

export const stockApi = {
  list: (params: { item_id?: number; facility_id?: number; page?: number; size?: number } = {}) =>
    api.get<Paginated<StockRow>>("/api/stock", { params }).then((r) => r.data),
  movements: (params: { item_id?: number; page?: number; size?: number } = {}) =>
    api.get<Paginated<MovementRow>>("/api/stock/movements", { params }).then((r) => r.data),
};

export const issueApi = {
  list: (params: { page?: number; size?: number } = {}) =>
    api.get<Paginated<Issue>>("/api/issues", { params }).then((r) => r.data),
  issue: (id: number) => api.post<Issue>(`/api/issues/${id}/issue`).then((r) => r.data),
};

// --------------------------------------------------------------------------- //
//  Transport — the outward leg
// --------------------------------------------------------------------------- //

export const transportApi = {
  /** The mode rules and the scoring methods come from the backend, never from a
   * constant here: the form must ask for exactly what the service enforces. */
  modes: () => api.get<ModeRule[]>("/api/transport/modes").then((r) => r.data),
  /** Road / rail / air / sea, and which arrangements each one allows. Served for the
   * same reason `modes` is — the screen used to hold its own copy of "you cannot run
   * a company van onto a ship", and a rule with two copies has two values. */
  carriageModes: () =>
    api.get<CarriageRule[]>("/api/transport/carriage-modes").then((r) => r.data),
  evaluationMethods: () =>
    api.get<EvaluationMethod[]>("/api/transport/evaluation-methods").then((r) => r.data),
  /** Which mode SUITS this load (doc E3). Advice, not a decision — the thresholds are
   * a business rule and they live in the backend, so there is one copy of them. */
  suggestMode: (params: {
    distance_km?: number | null; weight_kg?: number | null; packages?: number | null;
  }) =>
    api.get<ModeSuggestion | null>("/api/transport/suggest-mode", { params })
      .then((r) => r.data),
  /** The stepper for this mode. Served, never hardcoded — see FlowStage. */
  flow: (mode?: string, manualCourier = false) =>
    api.get<FlowStage[]>("/api/transport/flow", {
      params: { mode, manual_courier: manualCourier },
    })
      .then((r) => r.data),
  summary: () =>
    api.get<TransportSummary>("/api/transport/summary").then((r) => r.data),
  carriers: (search?: string) =>
    api.get<CarrierOption[]>("/api/transport/carriers", { params: { search } })
      .then((r) => r.data),
  /** The safe subset of Company Settings that the dispatch form needs — which
   * courier form to draw, and which of its boxes the service will hold the press
   * back for. Both come from the backend for the same reason `modes` does. */
  dispatchPolicy: () =>
    api.get<DispatchPolicy>("/api/transport/dispatch-policy").then((r) => r.data),

  /** Which of these warehouse consignments already have a transport leg. One call
   * for a whole page of consignments rather than one lookup per row. */
  forConsignments: (dispatchIds: number[]) =>
    dispatchIds.length
      ? api.get<ConsignmentLink[]>("/api/transport/for-consignments",
          { params: { ids: dispatchIds.join(",") } }).then((r) => r.data)
      : Promise.resolve([] as ConsignmentLink[]),

  list: (params: {
    status?: string; mode?: string; carrier_id?: number; indent_id?: number;
    dispatch_id?: number; search?: string; page?: number; size?: number;
    /** CONSIGNMENT / ISSUE for the outward leg, RETURN for the way back (doc E7). */
    source_type?: string;
  } = {}) =>
    api.get<Paginated<ProviderBoardRow>>("/api/transport", { params }).then((r) => r.data),

  /** "Where is my material?" — the legs carrying an indent, readable by the person
   * who RAISED that indent rather than by the logistics desk. Authorised by
   * ownership, so an indent screen can call it with no transport permission. */
  forIndent: (indentId: number) =>
    api.get<RaiserTracking[]>(`/api/transport/for-indent/${indentId}`)
      .then((r) => r.data),

  /** Provider Selection's board: everything still waiting on "who is taking this",
   * with the reply counts and the best price on the table beside each row. */
  providerBoard: (params: {
    status?: string; search?: string; page?: number; size?: number;
  } = {}) =>
    api.get<Paginated<ProviderBoardRow>>("/api/transport/provider-board", { params })
      .then((r) => r.data),

  get: (id: number) =>
    api.get<TransportRequest>(`/api/transport/${id}`).then((r) => r.data),
  receiptEvidence: (id: number) =>
    api.get<ReceiptEvidence[]>(`/api/transport/${id}/receipt-evidence`)
      .then((r) => r.data),
  downloadReceiptEvidence: (id: number, attachmentId: number) =>
    api.get<Blob>(`/api/transport/${id}/receipt-evidence/${attachmentId}/download`, {
      responseType: "blob",
    }).then((r) => r.data),
  /** The paperwork that travels WITH the load — the way bill and the delivery
   * challan — as against the receipt evidence above, which comes back from the far
   * end. Filed against the shipment, so both front doors read the same two files. */
  documents: (id: number) =>
    api.get<ReceiptEvidence[]>(`/api/transport/${id}/documents`).then((r) => r.data),
  /** Multipart: the field name must be `file`, which is what the endpoint reads. */
  uploadDocument: (id: number, file: File, docCategory: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("doc_category", docCategory);
    return api.post<ReceiptEvidence>(`/api/transport/${id}/documents`, form)
      .then((r) => r.data);
  },
  downloadDocument: (id: number, attachmentId: number) =>
    api.get<Blob>(`/api/transport/${id}/documents/${attachmentId}/download`, {
      responseType: "blob",
    }).then((r) => r.data),
  create: (data: TRInput) =>
    api.post<TransportRequest>("/api/transport", data).then((r) => r.data),
  update: (id: number, data: Partial<TRInput>) =>
    api.put<TransportRequest>(`/api/transport/${id}`, data).then((r) => r.data),
  remove: (id: number) => api.delete(`/api/transport/${id}`).then((r) => r.data),

  submit: (id: number) =>
    api.post<TransportRequest>(`/api/transport/${id}/submit`).then((r) => r.data),
  approve: (id: number, comments = "") =>
    api.post<TransportRequest>(`/api/transport/${id}/approve`, { comments })
      .then((r) => r.data),
  reject: (id: number, comments: string) =>
    api.post<TransportRequest>(`/api/transport/${id}/reject`, { comments })
      .then((r) => r.data),
  cancel: (id: number, comments = "") =>
    api.post<TransportRequest>(`/api/transport/${id}/cancel`, { comments })
      .then((r) => r.data),

  invite: (id: number, carrier_ids: number[], evaluation_method?: string) =>
    api.post<TransportRequest>(`/api/transport/${id}/invite`,
      { carrier_ids, evaluation_method }).then((r) => r.data),
  recordQuote: (id: number, carrierId: number, data: {
    freight_amount: number; other_charges?: number; tax_percent?: number | null;
    transit_days?: number | null; valid_until?: string | null;
    vehicle_type?: string | null; remarks?: string | null;
  }) =>
    api.post<CarrierQuote>(`/api/transport/${id}/quotes/${carrierId}`, data)
      .then((r) => r.data),
  comparison: (id: number, method?: string) =>
    api.get<Comparison>(`/api/transport/${id}/comparison`, { params: { method } })
      .then((r) => r.data),
  award: (id: number, quote_id: number, comments = "") =>
    api.post<TransportRequest>(`/api/transport/${id}/award`, { quote_id, comments })
      .then((r) => r.data),
  approveAward: (id: number, comments = "") =>
    api.post<TransportRequest>(`/api/transport/${id}/award/approve`, { comments })
      .then((r) => r.data),
  rejectAward: (id: number, comments: string) =>
    api.post<TransportRequest>(`/api/transport/${id}/award/reject`, { comments })
      .then((r) => r.data),
  /** Dispatch a packed consignment: mode, providers, go. One call — on the floor it
   * is one decision. A third-party choice lands in EVERY chosen provider's portal at
   * once and comes back to Provider Selection as a comparison. */
  dispatchConsignment: (data: DispatchInput) =>
    api.post<TransportRequest>("/api/transport/dispatch-consignment", data)
      .then((r) => r.data),
  /** ADDED 2026-09-10. The same press, on a leg that already exists.
   *
   * A return's shipment is drafted by the returns module the moment the return
   * reaches logistics, so there is nothing for this desk to create — only to arrange.
   * This applies the arrangement and, on a draft, walks it on exactly as
   * `dispatchConsignment` does: out to the providers for a price, or ready to leave.
   * It never releases the load — a return leg may not leave before the return's own
   * logistics approval is signed. */
  dispatchLeg: (id: number, data: Partial<DispatchInput>) =>
    api.post<TransportRequest>(`/api/transport/${id}/dispatch-leg`, data)
      .then((r) => r.data),
  /** "That price is fine" — books the provider and readies the shipment. */
  acceptQuote: (id: number, quote_id?: number) =>
    api.post<TransportRequest>(`/api/transport/${id}/accept-quote`,
      { quote_id: quote_id ?? null }).then((r) => r.data),
  /** "Too dear, price it again" — hands the job back to the provider with a note. */
  askRevisedQuote: (id: number, note: string) =>
    api.post<TransportRequest>(`/api/transport/${id}/ask-revised-quote`, { note })
      .then((r) => r.data),

  /** The desk confirming, on the phone, what the carrier would otherwise confirm in
   * their portal. Recorded as a desk confirmation, never as the carrier's own. */
  confirmCarrier: (id: number, confirmed_by: string, carrier_reference?: string) =>
    api.post<TransportRequest>(`/api/transport/${id}/carrier-confirm`,
      { confirmed_by, carrier_reference: carrier_reference || null })
      .then((r) => r.data),
  carrierDeclined: (id: number, reason: string) =>
    api.post<TransportRequest>(`/api/transport/${id}/carrier-declined`, { reason })
      .then((r) => r.data),

  setProvider: (id: number, data: {
    carrier_id?: number | null; freight_amount?: number | null;
    vehicle_number?: string | null; driver_name?: string | null;
    driver_phone?: string | null; trip_reference?: string | null;
    handed_over_by_name?: string | null;
  }) =>
    api.post<TransportRequest>(`/api/transport/${id}/provider`, data).then((r) => r.data),

  /** "It has left." The custody block is the HAND-OVER's half of the LR and the
   *  docket beside it — that leg has neither paper, so who took the goods is the
   *  whole record, and this press is the last moment it can be corrected. The
   *  service applies those four only to a direct hand-over. */
  dispatch: (id: number, data: {
    lr_no?: string | null; docket_no?: string | null; tracking_url?: string | null;
    eway_bill_no?: string | null; gate_pass_no?: string | null;
    expected_delivery?: string | null; remarks?: string | null;
    handed_over_by_name?: string | null;
    handed_over_employee_id?: string | null;
    handed_over_aadhaar?: string | null;
    handed_over_phone?: string | null;
  }) =>
    api.post<TransportRequest>(`/api/transport/${id}/dispatch`, data).then((r) => r.data),
  addEvent: (id: number, data: {
    event_type: string; event_at?: string | null; location_name?: string | null;
    description?: string | null; affected_item_name?: string | null;
    affected_qty?: number | null; claim_amount?: number | null;
  }) =>
    api.post<ShipmentEvent>(`/api/transport/${id}/events`, data).then((r) => r.data),
  deliver: (id: number, data: {
    delivered_at?: string | null; delivered_to_name?: string | null;
    pod_url?: string | null; remarks?: string | null;
  }) =>
    api.post<TransportRequest>(`/api/transport/${id}/deliver`, data).then((r) => r.data),
  shareTracking: (id: number) =>
    api.post<TransportRequest>(`/api/transport/${id}/share-tracking`).then((r) => r.data),
  close: (id: number) =>
    api.post<TransportRequest>(`/api/transport/${id}/close`).then((r) => r.data),
  history: (id: number) =>
    api.get<unknown[]>(`/api/transport/${id}/history`).then((r) => r.data),

  /** The activity ledger. `dispatch_id` scopes it to one consignment's own trail,
   *  which is how the Dispatch queue opens it for a single row. */
  activity: (params: {
    search?: string; date_from?: string; date_to?: string; event_type?: string;
    only_exceptions?: boolean; tr_id?: number; dispatch_id?: number;
    page?: number; size?: number;
  } = {}) =>
    api.get<Paginated<ActivityRow>>("/api/transport/activity", { params })
      .then((r) => r.data),
  activityTypes: () =>
    api.get<ActivityType[]>("/api/transport/activity-types").then((r) => r.data),

  exceptions: (params: { page?: number; size?: number } = {}) =>
    api.get<Paginated<ShipmentEvent>>("/api/transport/exceptions", { params })
      .then((r) => r.data),
  resolveException: (eventId: number, resolution: string) =>
    api.post<ShipmentEvent>(`/api/transport/events/${eventId}/resolve`, { resolution })
      .then((r) => r.data),
};

// --------------------------------------------------------------------------- //
//  Indents — READ ONLY, for the "against indent" picker
// --------------------------------------------------------------------------- //
// A transport leg points BACKWARD at the indent that asked for the material, and that
// pointer is a number somebody used to type from memory. Typing it is how a leg ends
// up against an indent that does not exist, which breaks the raiser's own tracking
// (`/api/transport/for-indent/{id}`) silently — nothing errors, the material simply
// never appears on the screen of the person waiting for it.
//
// `/api/indents` is guarded by `indent.view`, which a logistics job profile may not
// hold. So this RESOLVES TO AN EMPTY LIST rather than throwing: the form falls back to
// a plain text box, exactly as it behaved before. A picker the desk cannot load must
// not be a picker that stops the desk working.

export interface IndentOption {
  id: number;
  indent_no: string;
  status: string;
  department_name?: string | null;
  requested_by_name?: string | null;
}

export const indentLookupApi = {
  options: (search?: string) =>
    api.get<Paginated<IndentOption>>("/api/indents", {
      params: { search: search?.trim() || undefined, size: 50 },
    })
      .then((r) => r.data.items)
      .catch(() => [] as IndentOption[]),
};

// --------------------------------------------------------------------------- //
//  Consignments — READ ONLY, from the warehouse
// --------------------------------------------------------------------------- //
// The consignment is the warehouse's document: it is what was picked, packed and
// labelled, and only the warehouse writes it. Logistics reads it to plan the leg that
// carries it, which is why there is no create/update/delete here and why the backend
// half of this module never touches `out_dispatches` — warehouse sits AFTER logistics
// in the import chain (rule 5), so the join is done by the screen, over HTTP, or not
// at all.

export const consignmentApi = {
  list: (params: {
    status?: string; search?: string; page?: number; size?: number;
  } = {}) =>
    api.get<Paginated<Consignment>>("/api/warehouse/consignments", { params })
      .then((r) => r.data),
  get: (id: number) =>
    api.get<ConsignmentDetail>(`/api/warehouse/consignments/${id}`).then((r) => r.data),
};

/** The Smart Load Planner and the multi-drop trips it plans. Served by the warehouse
 *  module, which owns the consignments a trip carries (rule 5). */
export const tripApi = {
  /** Every stocking point in scope, located — matched once against the offline
   *  gazetteer the first time it is asked for. */
  network: () => api.post<TripMapNetwork>(
    "/api/warehouse/trip-planner/map-network").then((r) => r.data),
  policy: () => api.get<PlannerPolicyResponse>(
    "/api/warehouse/trip-planner/policy").then((r) => r.data),
  savePolicy: (data: PolicyOverrides & { vehicle_profiles?: VehicleProfile[] }) =>
    api.put<PlannerPolicyResponse>("/api/warehouse/trip-planner/policy", data).then((r) => r.data),
  pin: (warehouseId: number, data: { latitude: number; longitude: number; label?: string | null }) =>
    api.put<TripMapPoint>(`/api/warehouse/trip-planner/points/${warehouseId}/location`, data)
      .then((r) => r.data),
  /** Where an unmapped stocking point might be — gazetteer places to confirm with one
   *  press. `q` searches a different spelling. */
  candidates: (warehouseId: number, q?: string) =>
    api.get<PointCandidates>(`/api/warehouse/trip-planner/points/${warehouseId}/candidates`,
      { params: q ? { q } : {} }).then((r) => r.data),
  /** Try the gazetteer again on every point still not on the map. */
  rematch: () => api.post<{ tried: number; mapped: number; still_unresolved: number }>(
    "/api/warehouse/trip-planner/points/rematch").then((r) => r.data),
  packages: (dispatchId: number) => api.get<ConsignmentPackages>(
    `/api/warehouse/trip-planner/consignments/${dispatchId}/packages`).then((r) => r.data),
  /** Weigh and measure a packed consignment's cartons from the planner. */
  measure: (dispatchId: number, packages: {
    package_id: number; weight_kg?: number | null; length_cm?: number | null;
    width_cm?: number | null; height_cm?: number | null;
  }[]) => api.put<ConsignmentPackages>(
    `/api/warehouse/trip-planner/consignments/${dispatchId}/measurements`, { packages })
    .then((r) => r.data),
  recommend: (data: PolicyOverrides & { warehouse_id: number; departure_date?: string | null }) =>
    api.post<TripRecommendations>("/api/warehouse/trip-planner/recommendations", data)
      .then((r) => r.data),
  evaluate: (data: PolicyOverrides & {
    warehouse_id: number; dispatch_ids: number[]; stop_order?: number[] | null;
    departure_date?: string | null;
  }) => api.post<TripEvaluation>("/api/warehouse/trip-planner/evaluate", data).then((r) => r.data),
  create: (data: PolicyOverrides & {
    warehouse_id: number; dispatch_ids: number[]; stop_order?: number[] | null;
    departure_date: string; policy_name?: string | null; vehicle_profile?: string | null;
    remarks?: string | null;
  }) => api.post<ConsolidatedTrip>("/api/warehouse/consolidated-trips", data).then((r) => r.data),
  list: (params: { page?: number; size?: number; status?: string; warehouse_id?: number;
    search?: string } = {}) =>
    api.get<TripPage>("/api/warehouse/consolidated-trips", { params }).then((r) => r.data),
  get: (id: number) => api.get<ConsolidatedTrip>(
    `/api/warehouse/consolidated-trips/${id}`).then((r) => r.data),
  deliverStop: (tripId: number, stopId: number,
    data: { received_by_name?: string | null; remarks?: string | null;
      pod_url?: string | null } = {}) =>
    api.post<ConsolidatedTrip>(
      `/api/warehouse/consolidated-trips/${tripId}/stops/${stopId}/deliver`, data)
      .then((r) => r.data),
  cancel: (id: number, reason: string) => api.post<ConsolidatedTrip>(
    `/api/warehouse/consolidated-trips/${id}/cancel`, { reason }).then((r) => r.data),
};

// --------------------------------------------------------------------------- //
//  The carrier portal
// --------------------------------------------------------------------------- //
// Served under /api/supplier on purpose: the shared axios client attaches the VENDOR
// token to everything under that prefix and the employee token to everything else, so
// a carrier's session works here without the client having to learn a second rule.
// The same functions are also mounted at /api/carrier by the backend.

const PORTAL = "/api/supplier";

export const carrierPortalApi = {
  summary: () =>
    api.get<{
      to_quote: number; to_confirm: number; to_pick_up: number;
      on_the_road: number; delivered: number;
      /** Priced and not won. Its queue is asked for as `status=NOT_AWARDED`, which is
       *  an outcome rather than a shipment status — the shipment itself is somebody
       *  else's job by then, and the portal must never show it as this carrier's. */
      not_awarded: number;
    }>(`${PORTAL}/transport-summary`).then((r) => r.data),
  list: (params: { status?: string; page?: number; size?: number } = {}) =>
    api.get<Paginated<TRListRow>>(`${PORTAL}/transport`, { params })
      .then((r) => r.data),
  get: (id: number) =>
    api.get<TransportRequest>(`${PORTAL}/transport/${id}`).then((r) => r.data),
  quote: (id: number, data: {
    freight_amount: number; other_charges?: number; tax_percent?: number | null;
    transit_days?: number | null; valid_until?: string | null;
    vehicle_type?: string | null; remarks?: string | null;
  }) =>
    api.post<CarrierQuote>(`${PORTAL}/transport/${id}/quote`, data).then((r) => r.data),
  accept: (id: number, carrier_reference?: string) =>
    api.post<TransportRequest>(`${PORTAL}/transport/${id}/accept`,
      { carrier_reference: carrier_reference || null }).then((r) => r.data),
  /** Taking the job AND saying what is coming for it — the same boxes the dispatch
   *  desk fills on a leg it settles itself. One press: the service writes the vehicle
   *  and the driver, then accepts the award, so a shipment can never reach READY with
   *  nobody named against it. */
  acknowledge: (id: number, data: {
    driver_name: string; vehicle_number: string;
    driver_phone?: string | null;
    driver_licence_no?: string | null; lr_no?: string | null;
    docket_no?: string | null; tracking_url?: string | null;
    eway_bill_no?: string | null; carrier_reference?: string | null;
  }) =>
    api.post<TransportRequest>(`${PORTAL}/transport/${id}/acknowledge`, data)
      .then((r) => r.data),
  decline: (id: number, reason: string) =>
    api.post<TransportRequest>(`${PORTAL}/transport/${id}/decline`, { reason })
      .then((r) => r.data),
  track: (id: number, data: {
    lr_no?: string | null; docket_no?: string | null; tracking_url?: string | null;
    carrier_reference?: string | null; event_type?: string | null;
    location_name?: string | null; description?: string | null;
  }) =>
    api.post<TransportRequest>(`${PORTAL}/transport/${id}/tracking`, data)
      .then((r) => r.data),
  deliver: (id: number, data: {
    delivered_to_name?: string | null; pod_url?: string | null;
    remarks?: string | null;
  }) =>
    api.post<TransportRequest>(`${PORTAL}/transport/${id}/deliver`, data)
      .then((r) => r.data),
  /** One stop of a multi-drop run reached and put down — the carrier's word and proof
   *  for THAT stop; the site there still signs for its own consignment. */
  deliverStop: (id: number, stopId: number, data: {
    delivered_to_name?: string | null; pod_url?: string | null;
    remarks?: string | null;
  }) =>
    api.post<TransportRequest>(`${PORTAL}/transport/${id}/stops/${stopId}/deliver`, data)
      .then((r) => r.data),
};

// --------------------------------------------------------------------------- //
//  Logistics vendors — the register behind the Dispatch dropdown
// --------------------------------------------------------------------------- //
// Every call returns the WHOLE partner row, login state included, so the screen never
// has to refetch a second list to find out whether the press worked.

const VENDORS = "/api/logistics-vendors";

export const logisticsVendorApi = {
  /** Served, not a constant here: a type this form offers that Dispatch does not
   *  accept would create a partner nobody can ship with. */
  types: () => api.get<PartnerType[]>(`${VENDORS}/types`).then((r) => r.data),
  summary: () =>
    api.get<LogisticsVendorSummary>(`${VENDORS}/summary`).then((r) => r.data),
  list: (params: {
    search?: string; vendor_type?: string; active_only?: boolean;
    page?: number; size?: number;
  } = {}) =>
    api.get<Paginated<LogisticsVendor>>(VENDORS, { params }).then((r) => r.data),
  create: (data: LogisticsVendorInput) =>
    api.post<LogisticsVendor>(VENDORS, data).then((r) => r.data),
  update: (id: number, data: Partial<LogisticsVendorInput> & {
    is_active?: boolean; is_blacklisted?: boolean;
  }) => api.put<LogisticsVendor>(`${VENDORS}/${id}`, data).then((r) => r.data),
  deactivate: (id: number) =>
    api.delete<LogisticsVendor>(`${VENDORS}/${id}`).then((r) => r.data),

  /** Their way in. Same account, same portal, same default password as a supplier —
   *  a carrier IS a vendor, so there is only ever one kind of login. */
  issueLogin: (id: number, username?: string) =>
    api.post<LogisticsVendor>(`${VENDORS}/${id}/login`,
      { username: username || null }).then((r) => r.data),
  resetLogin: (id: number) =>
    api.post<LogisticsVendor>(`${VENDORS}/${id}/login/reset`).then((r) => r.data),
  setLoginActive: (id: number, active: boolean) =>
    api.post<LogisticsVendor>(
      `${VENDORS}/${id}/login/${active ? "enable" : "disable"}`).then((r) => r.data),
};
