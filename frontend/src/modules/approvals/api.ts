import { api } from "@/shared/api/client";
import type {
  ApprovalDecisionRow, ApprovalHistoryRow, ApprovalIndent, ApprovalQuantityInput,
  ApprovalReport, BulkActionResult, BulkDocumentRef,
  ConsolidationApprovalInput, ConsolidationApprovalResult,
  IndentAvailability, IssueFromStockLine, IssueFromStockResult,
  ConsolidationFilterOptions, ConsolidationQuery, ConsolidationWorkspace,
  CorrectionIndent, PendingApproval, TeamQueueRow,
} from "./types";
import type { Paginated } from "@/shared/types";

async function allPages<T>(path: string): Promise<T[]> {
  const size = 500;
  const first = await api.get<Paginated<T>>(path, { params: { page: 1, size } });
  const items = [...first.data.items];
  const pages = Math.ceil(first.data.total / size);
  for (let page = 2; page <= pages; page += 1) {
    const response = await api.get<Paginated<T>>(path, { params: { page, size } });
    items.push(...response.data.items);
  }
  return items;
}

const EMPTY_FILTER_OPTIONS: ConsolidationFilterOptions = {
  cycle: [], region: [], project: [], vehicle: [], office: [], requester: [], item: [],
};

/** Fill in anything the response left out, so every consumer sees the full shape.
 *  The header counts fall back to the batches themselves rather than to 0 — a stale
 *  or partial payload should read as "no filter metadata", never as "no indents". */
function normaliseConsolidation(data: Partial<ConsolidationWorkspace>): ConsolidationWorkspace {
  const items = data.items ?? [];
  const indentCount = items.reduce((sum, batch) => sum + (batch.indent_count ?? 0), 0);
  return {
    items,
    filter_options: { ...EMPTY_FILTER_OPTIONS, ...(data.filter_options ?? {}) },
    applied: data.applied ?? {},
    total_indent_count: data.total_indent_count ?? indentCount,
    total_requester_count: data.total_requester_count ?? new Set(
      items.flatMap((batch) => (batch.indents ?? []).map((row) => row.requested_by_id))
        .filter((id) => id !== null && id !== undefined),
    ).size,
    unfiltered_indent_count: data.unfiltered_indent_count ?? indentCount,
  };
}

/** Make a monthly approval represent only what is still owed after earlier rungs
 * served stock. The consolidation endpoint retains the original asks; availability
 * is the frontend's existing source for the live remainder (including allocations
 * already committed but not yet posted). Applying it to allocations first keeps the
 * displayed totals, proportional split and submitted quantities on the same number.
 */
async function applyOutstandingConsolidation(
  workspace: ConsolidationWorkspace,
): Promise<ConsolidationWorkspace> {
  const indentIds = [...new Set(
    workspace.items.flatMap((batch) => batch.indents.map((indent) => indent.id)),
  )];
  if (indentIds.length === 0) return workspace;

  const responses = await Promise.allSettled(indentIds.map(async (indentId) => {
    const response = await api.get<IndentAvailability>(
      `/api/approvals/indents/${indentId}/availability`,
    );
    return response.data;
  }));
  // All of it or none of it. Skipping only the indents whose call failed would leave
  // one batch total adding up corrected and uncorrected lines — a number that matches
  // neither what is owed nor what the endpoint said, on the screen that commits the
  // approval. Falling back to the backend's own figures is at worst stale; a blend is
  // wrong, and nothing on the screen would show which lines were which.
  if (responses.some((response) => response.status === "rejected")) return workspace;

  const remainderByLine = new Map<number, number>();
  for (const response of responses) {
    if (response.status !== "fulfilled") continue;
    for (const line of response.value.items) {
      remainderByLine.set(line.line_id, Math.max(0, Number(line.remainder)));
    }
  }

  return {
    ...workspace,
    items: workspace.items.map((batch) => {
      const consolidatedItems = batch.consolidated_items.map((item) => {
        const allocations = item.allocations.map((allocation) => {
          const remainder = remainderByLine.get(allocation.line_id);
          if (remainder === undefined) return allocation;
          return {
            ...allocation,
            requested_quantity: remainder,
            ceiling_quantity: Math.min(allocation.ceiling_quantity, remainder),
          };
        });
        return {
          ...item,
          allocations,
          total_requested_quantity: allocations.reduce(
            (sum, allocation) => sum + allocation.requested_quantity, 0,
          ),
          total_ceiling_quantity: allocations.reduce(
            (sum, allocation) => sum + allocation.ceiling_quantity, 0,
          ),
        };
      });
      const totalsByIndent = new Map<number, { requested: number; ceiling: number }>();
      for (const item of consolidatedItems) {
        for (const allocation of item.allocations) {
          const total = totalsByIndent.get(allocation.indent_id) ?? { requested: 0, ceiling: 0 };
          total.requested += allocation.requested_quantity;
          total.ceiling += allocation.ceiling_quantity;
          totalsByIndent.set(allocation.indent_id, total);
        }
      }
      return {
        ...batch,
        consolidated_items: consolidatedItems,
        indents: batch.indents.map((indent) => {
          const totals = totalsByIndent.get(indent.id);
          return totals ? {
            ...indent,
            total_requested_quantity: totals.requested,
            current_ceiling_quantity: totals.ceiling,
          } : indent;
        }),
      };
    }),
  };
}

export interface PendingApprovalQuery {
  search?: string;
  doc_type?: string;
  overdue_only?: boolean;
  raised_from?: string;
  raised_to?: string;
  sort?: string;
}

export const approvalsApi = {
  pending: (page = 1, size = 20, filters: PendingApprovalQuery = {}) =>
    api.get<Paginated<PendingApproval>>("/api/approvals/pending", { params: { page, size, ...filters } }).then((r) => r.data),
  pendingAll: () => allPages<PendingApproval>("/api/approvals/pending"),
  decisions: (page = 1, size = 20, filters: { search?: string; decision?: string } = {}) =>
    api.get<Paginated<ApprovalDecisionRow>>("/api/approvals/my-decisions", { params: { page, size, ...filters } }).then((r) => r.data),
  decisionsAll: () => allPages<ApprovalDecisionRow>("/api/approvals/my-decisions"),
  teamQueue: () =>
    api.get<{ items: TeamQueueRow[] }>("/api/approvals/team-queue").then((r) => r.data.items),
  // Normalised on arrival: an older API build answers with `{items}` alone, and the
  // screen must degrade to "no filters offered" rather than blank out reading
  // `filter_options` off undefined. The live outstanding quantities are then applied
  // so every downstream monthly rung sees only what earlier rungs left unserved.
  consolidation: (filters: ConsolidationQuery = {}) =>
    api.get<Partial<ConsolidationWorkspace>>("/api/approvals/consolidation", { params: filters })
      .then((r) => applyOutstandingConsolidation(normaliseConsolidation(r.data))),
  // Approve the whole filtered batch in one call. `lines` carries only the
  // quantities the split produced; anything absent keeps this approver's ceiling.
  approveConsolidation: (body: ConsolidationApprovalInput) =>
    api.post<ConsolidationApprovalResult>("/api/approvals/consolidation/approve", body)
      .then((r) => r.data),
  /** What is still owed on each line, and what this approver holds against it. */
  indentAvailability: (indentId: number) =>
    api.get<IndentAvailability>(`/api/approvals/indents/${indentId}/availability`)
      .then((r) => r.data),
  /** Serve what you have, from your own point, without leaving the screen. The kind
   *  of movement is derived server-side from the two points — only `reason` is ours. */
  issueFromStock: (
    indentId: number, lines: IssueFromStockLine[], reason = "",
    forwardRemainder = false,
  ) =>
    api.post<IssueFromStockResult>(
      `/api/approvals/indents/${indentId}/issue-from-stock`,
      { lines, reason, forward_remainder: forwardRemainder },
    ).then((r) => r.data),
  getIndent: (id: number) =>
    api.get<ApprovalIndent>(`/api/approvals/indents/${id}`).then((r) => r.data),
  approveIndent: (id: number, items: ApprovalQuantityInput[], comments = "") =>
    api.post<ApprovalIndent>(`/api/approvals/indents/${id}/approve`, { items, comments })
      .then((r) => r.data),
  rejectIndent: (id: number, comments = "") =>
    api.post<ApprovalIndent>(`/api/approvals/indents/${id}/reject`, { comments })
      .then((r) => r.data),
  returnIndent: (id: number, comments: string) =>
    api.post<ApprovalIndent>(`/api/indents/${id}/return-for-correction`, { comments })
      .then((r) => r.data),
  approveDocument: (docType: string, id: number, comments = "") =>
    api.post(`/api/approvals/documents/${docType}/${id}/approve`, { comments })
      .then((r) => r.data),
  rejectDocument: (docType: string, id: number, comments: string) =>
    api.post(`/api/approvals/documents/${docType}/${id}/reject`, { comments })
      .then((r) => r.data),
  /** Sign a whole selection in one request. One round trip rather than one per row —
   *  an approver holding forty requisitions was spending minutes on a single decision.
   *  Partial success is normal and is reported per document in `failed`. */
  bulkApprove: (documents: BulkDocumentRef[], comments = "") =>
    api.post<BulkActionResult>("/api/approvals/documents/bulk-approve",
      { documents, comments }).then((r) => r.data),
  bulkReject: (documents: BulkDocumentRef[], comments: string) =>
    api.post<BulkActionResult>("/api/approvals/documents/bulk-reject",
      { documents, comments }).then((r) => r.data),
  history: (docType: string, docId: number) =>
    api.get<{ items: ApprovalHistoryRow[] }>(`/api/approvals/history/${docType}/${docId}`)
      .then((r) => r.data.items),
  report: () =>
    api.get<ApprovalReport>("/api/approvals/reports/summary").then((r) => r.data),
  remind: (approverId: number) =>
    api.post<{ notifications_created: number }>(`/api/approvals/team-queue/${approverId}/remind`)
      .then((r) => r.data),
  getCorrection: (indentId: number) =>
    api.get<CorrectionIndent>(`/api/indents/${indentId}`).then((r) => r.data),
  saveCorrection: (indentId: number, data: {
    required_date?: string | null;
    priority: string;
    remarks?: string | null;
    items: Array<{ item_id: number; quantity: number; remarks?: string }>;
  }) => api.put<CorrectionIndent>(`/api/indents/${indentId}`, data).then((r) => r.data),
  resubmitCorrection: (indentId: number) =>
    api.post<CorrectionIndent>(`/api/indents/${indentId}/resubmit-correction`).then((r) => r.data),
};
