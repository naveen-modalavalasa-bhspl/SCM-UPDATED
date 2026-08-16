import { api } from "@/shared/api/client";
import type { Paginated } from "@/shared/types";
import type { GRN, GRNCreate, GRNListRow, Issue, MovementRow, StockRow } from "./types";
import type {
  CarrierOption, CarrierQuote, Comparison, EvaluationMethod, ModeRule, ShipmentEvent,
  TransportRequest, TRInput, TRListRow,
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
  evaluationMethods: () =>
    api.get<EvaluationMethod[]>("/api/transport/evaluation-methods").then((r) => r.data),
  carriers: (search?: string) =>
    api.get<CarrierOption[]>("/api/transport/carriers", { params: { search } })
      .then((r) => r.data),

  list: (params: {
    status?: string; mode?: string; carrier_id?: number; indent_id?: number;
    search?: string; page?: number; size?: number;
  } = {}) =>
    api.get<Paginated<TRListRow>>("/api/transport", { params }).then((r) => r.data),
  get: (id: number) =>
    api.get<TransportRequest>(`/api/transport/${id}`).then((r) => r.data),
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
  setProvider: (id: number, data: {
    carrier_id?: number | null; freight_amount?: number | null;
    vehicle_number?: string | null; driver_name?: string | null;
    driver_phone?: string | null; trip_reference?: string | null;
    handed_over_by_name?: string | null; received_by_name?: string | null;
  }) =>
    api.post<TransportRequest>(`/api/transport/${id}/provider`, data).then((r) => r.data),

  dispatch: (id: number, data: {
    lr_no?: string | null; docket_no?: string | null; tracking_url?: string | null;
    eway_bill_no?: string | null; expected_delivery?: string | null;
    remarks?: string | null;
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

  exceptions: (params: { page?: number; size?: number } = {}) =>
    api.get<Paginated<ShipmentEvent>>("/api/transport/exceptions", { params })
      .then((r) => r.data),
  resolveException: (eventId: number, resolution: string) =>
    api.post<ShipmentEvent>(`/api/transport/events/${eventId}/resolve`, { resolution })
      .then((r) => r.data),
};
