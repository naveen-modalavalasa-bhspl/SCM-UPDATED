import { api } from "@/shared/api/client";
import type {
  ApprovalDecisionRow, ApprovalHistoryRow, ApprovalIndent, ApprovalQuantityInput,
  ApprovalReport, CorrectionIndent, PendingApproval, TeamQueueRow,
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
