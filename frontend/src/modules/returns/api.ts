import { api } from "@/shared/api/client";
import type {
  ApprovalFlow, ApprovalTrailRow, DecisionOptions, DecisionWrite, IndentOption,
  MyStockRow, Page, PositionOption, PurchaseReturn, Raiser, Reason, ReceivingConfig,
  RelatedDocuments, ReturnAttachment, ReturnJourney, ReturnReceiptWrite, ReturnSummary,
  ReturnWrite, StockReturn,
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
  queue?: "decision" | "endorsement" | "logistics" | "receipt";
  /**
   * The day the return was RAISED, both ends inclusive, as `YYYY-MM-DD`. That is the
   * date these screens print, so the filter and the column can never disagree; the
   * server bounds `created_at` and does the inclusive end itself.
   */
  date_from?: string;
  date_to?: string;
}

/**
 * Which stage a send-back or a reject is being pressed from. The route differs per stage
 * because the PERMISSION does: the decision desk, the floor and the reporting line are
 * three different people holding three different `return.*` codes, and one shared
 * endpoint would have had to be gated on somebody else's.
 */
export type ReturnStage = "approval" | "decision" | "sign-off";

export const returnsApi = {
  list: async (query: ReturnListQuery = {}): Promise<Page<StockReturn>> =>
    (await api.get("/api/returns", { params: clean({ ...query }) })).data,

  /**
   * The other family of return — `pro_returns`, read only.
   *
   * `source` narrows to where the material came from (FROM_WAREHOUSE / FROM_LIP_MDB /
   * QC_REJECTED_GRN), which is a different question from `status`: one is how far the
   * paperwork has got, the other is what the buying desk is actually chasing.
   */
  purchaseReturns: async (
    query: {
      page?: number; size?: number; status?: string; search?: string; source?: string;
    } = {},
  ): Promise<Page<PurchaseReturn>> =>
    (await api.get("/api/returns/purchase", { params: clean({ ...query }) })).data,

  /** The three source categories, served so the filter and the desk agree on wording. */
  purchaseReturnSources: async (): Promise<Reason[]> =>
    (await api.get("/api/returns/options/purchase-sources")).data,

  summary: async (): Promise<ReturnSummary> =>
    (await api.get("/api/returns/summary")).data,

  reasons: async (): Promise<Reason[]> =>
    (await api.get("/api/returns/options/reasons")).data,

  /** Who the return will be tagged with, and where it is going. */
  raiser: async (): Promise<Raiser> =>
    (await api.get("/api/returns/options/raiser")).data,

  /**
   * Only what this person is holding, and only what is free to send back.
   *
   * `indent_id` narrows it to the items that indent asked for — the return form offers
   * nothing until an indent has been picked, so a line can never be filed under the
   * approval chain of a request that never asked for it.
   */
  myStock: async (
    query: { page?: number; size?: number; search?: string; indent_id?: number } = {},
  ): Promise<Page<MyStockRow>> =>
    (await api.get("/api/returns/my-stock", { params: clean({ ...query }) })).data,

  /** The indents this person may return against — their own, past approval. */
  indents: async (query: { page?: number; size?: number; search?: string } = {}):
    Promise<Page<IndentOption>> =>
    (await api.get("/api/returns/options/indents", { params: clean({ ...query }) })).data,

  /**
   * Who will sign a return raised against this indent, BEFORE it is raised. Resolved by
   * the workflow engine's own preview, so what the form shows is what the submit does.
   * Called with no indent to see the stock return's own chain instead.
   */
  approvalFlowFor: async (indentId: number | null): Promise<ApprovalFlow> =>
    (await api.get("/api/returns/options/approval-flow", {
      params: clean({ indent_id: indentId }),
    })).data,

  /** An existing return's own approval chain — the route ahead, not the trail behind. */
  approvalFlow: async (id: number): Promise<ApprovalFlow> =>
    (await api.get(`/api/returns/${id}/approval-flow`)).data,

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

  /**
   * Any of the three stages handing the whole document back to the raiser to correct.
   *
   * Not a rejection and not an objection: the return drops to DRAFT, the hold on the
   * stock is released, both approval chains are abandoned and the decision is cleared,
   * so a corrected return is decided and approved again from the top. The note is the
   * only thing the raiser is given to work out what to change, so it is mandatory.
   */
  sendBack: async (id: number, stage: ReturnStage, comments: string):
    Promise<StockReturn> =>
    (await api.post(`/api/returns/${id}/${stage}/send-back`, { comments })).data,

  /** Either desk refusing the return outright. Ends the document and frees the hold. */
  rejectAtStage: async (id: number, stage: Exclude<ReturnStage, "approval">,
                        comments: string): Promise<StockReturn> =>
    (await api.post(`/api/returns/${id}/${stage}/reject`, { comments })).data,

  cancel: async (id: number): Promise<StockReturn> =>
    (await api.post(`/api/returns/${id}/cancel`)).data,

  /**
   * One route, two presses — which one it is depends on where the material has got to.
   *
   * A RECEIPT while the return is still on its leg (`can_receive`): the body says how much
   * of each line arrived and in what state, the server credits only that much to the
   * receiving point and refuses the whole thing without a delivery photograph on file.
   * A CLOSE once it has landed: nothing physical happens, so it takes no body at all.
   */
  acknowledge: async (id: number, body?: ReturnReceiptWrite): Promise<StockReturn> =>
    (await api.post(`/api/returns/${id}/acknowledge`, body ?? null)).data,

  journey: async (id: number): Promise<ReturnJourney> =>
    (await api.get(`/api/returns/${id}/journey`)).data,

  history: async (id: number): Promise<ApprovalTrailRow[]> =>
    (await api.get(`/api/returns/${id}/history`)).data,

  relatedDocuments: async (id: number): Promise<RelatedDocuments> =>
    (await api.get(`/api/returns/${id}/related-documents`)).data,

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
