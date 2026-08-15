import { api } from "@/shared/api/client";
import type {
  ApprovalTrailRow, DecisionOptions, DecisionWrite, MyStockRow, Page, PositionOption,
  PurchaseReturn, Raiser, Reason, ReceivingConfig, ReturnAttachment, ReturnJourney,
  ReturnSummary, ReturnWrite, StockReturn,
} from "./types";

/**
 * Returns HTTP layer. Every call hits a real endpoint and every error propagates, so
 * a screen can say what went wrong instead of rendering invented rows.
 *
 * Empty filter values are stripped rather than sent: the backend reads `status=""` as
 * a status nobody has, which returned an empty grid the moment a filter was cleared.
 */
const clean = (params: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(params).filter(
      ([, value]) => value !== "" && value !== undefined && value !== null && value !== false,
    ),
  );

export interface ReturnListQuery {
  page?: number;
  size?: number;
  status?: string;
  search?: string;
  mine_only?: boolean;
  /**
   * A desk's work rather than a status. The decision desk and the endorsers both hold
   * PENDING_APPROVAL documents, so no status filter can tell the two backlogs apart —
   * and the queue also drops the reporting-subtree rule, because the desks hold no
   * stocking point of their own and a visibility filter written for storekeepers would
   * hand them an empty list.
   */
  queue?: "decision" | "endorsement";
}

export const returnsApi = {
  list: async (query: ReturnListQuery = {}): Promise<Page<StockReturn>> =>
    (await api.get("/api/returns", { params: clean({ ...query }) })).data,

  /** The other family of return — `pro_returns`, read only. */
  purchaseReturns: async (
    query: { page?: number; size?: number; status?: string; search?: string } = {},
  ): Promise<Page<PurchaseReturn>> =>
    (await api.get("/api/returns/purchase", { params: clean({ ...query }) })).data,

  summary: async (): Promise<ReturnSummary> =>
    (await api.get("/api/returns/summary")).data,

  reasons: async (): Promise<Reason[]> =>
    (await api.get("/api/returns/options/reasons")).data,

  /** Who the return will be tagged with, and where it is going. */
  raiser: async (): Promise<Raiser> =>
    (await api.get("/api/returns/options/raiser")).data,

  /** Only what this person is holding, and only what is free to send back. */
  myStock: async (query: { page?: number; size?: number; search?: string } = {}):
    Promise<Page<MyStockRow>> =>
    (await api.get("/api/returns/my-stock", { params: clean({ ...query }) })).data,

  /** Who checks a return after its reporting line signs. */
  receivingConfig: async (): Promise<ReceivingConfig> =>
    (await api.get("/api/returns/config/receiving")).data,

  /** Posts to build that ladder from. Two characters minimum, server-side. */
  receivingPositions: async (search: string): Promise<PositionOption[]> =>
    (await api.get("/api/returns/config/positions", { params: clean({ search }) })).data,

  saveReceivingConfig: async (positionIds: number[]): Promise<ReceivingConfig> =>
    (await api.put("/api/returns/config/receiving", { position_ids: positionIds })).data,

  get: async (id: number): Promise<StockReturn> =>
    (await api.get(`/api/returns/${id}`)).data,

  create: async (body: ReturnWrite): Promise<StockReturn> =>
    (await api.post("/api/returns", body)).data,

  update: async (id: number, body: ReturnWrite): Promise<StockReturn> =>
    (await api.put(`/api/returns/${id}`, body)).data,

  submit: async (id: number): Promise<StockReturn> =>
    (await api.post(`/api/returns/${id}/submit`)).data,

  approve: async (id: number, comments = ""): Promise<StockReturn> =>
    (await api.post(`/api/returns/${id}/approve`, { comments })).data,

  reject: async (id: number, comments: string): Promise<StockReturn> =>
    (await api.post(`/api/returns/${id}/reject`, { comments })).data,

  /** The six outcomes with their guidance, the reason's default, candidate points and
   *  liable vendors — all computed server-side so the words the decider reads are the
   *  words the trail records. */
  decisionOptions: async (id: number): Promise<DecisionOptions> =>
    (await api.get(`/api/returns/${id}/decision-options`)).data,

  /** The desk saying where the material goes. */
  decide: async (id: number, body: DecisionWrite): Promise<StockReturn> =>
    (await api.post(`/api/returns/${id}/decide`, body)).data,

  /** The floor agreeing the decision is workable. The last yes moves the stock. */
  endorse: async (id: number, comments = ""): Promise<StockReturn> =>
    (await api.post(`/api/returns/${id}/endorse`, { comments })).data,

  /** Sending the decision back for a fresh one. Not a rejection — the return stands and
   *  the hold on the stock stays; it is the route that was refused. */
  objectToDecision: async (id: number, comments: string): Promise<StockReturn> =>
    (await api.post(`/api/returns/${id}/object`, { comments })).data,

  cancel: async (id: number): Promise<StockReturn> =>
    (await api.post(`/api/returns/${id}/cancel`)).data,

  /** The raiser closing their own return once the stock has moved. */
  acknowledge: async (id: number): Promise<StockReturn> =>
    (await api.post(`/api/returns/${id}/acknowledge`)).data,

  journey: async (id: number): Promise<ReturnJourney> =>
    (await api.get(`/api/returns/${id}/journey`)).data,

  history: async (id: number): Promise<ApprovalTrailRow[]> =>
    (await api.get(`/api/returns/${id}/history`)).data,

  attachments: async (id: number): Promise<ReturnAttachment[]> =>
    (await api.get(`/api/returns/${id}/attachments`)).data,

  /** Multipart: the field name must be `file`, which is what the endpoint reads. */
  upload: async (id: number, file: File, docCategory: string): Promise<ReturnAttachment> => {
    const form = new FormData();
    form.append("file", file);
    return (
      await api.post(`/api/returns/${id}/attachments`, form, {
        params: { doc_category: docCategory },
      })
    ).data;
  },

  removeAttachment: async (id: number, attachmentId: number): Promise<void> => {
    await api.delete(`/api/returns/${id}/attachments/${attachmentId}`);
  },
};
