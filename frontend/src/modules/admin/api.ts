import { api } from "@/shared/api/client";
import type { Paginated } from "@/shared/types";
import type {
  AuditRow, Conflict, DocSeries,
  NotificationRule, Rule, RuleVocabulary, Schedule, SimulateResult, SyncResult,
  SyncStatus, WorkflowDefinition, WorkflowOptions,
} from "./types";

type ListParams = { search?: string; page?: number; size?: number };
const page = <T>(url: string, params: Record<string, unknown> = {}) =>
  api.get<Paginated<T>>(url, { params }).then((r) => r.data);
const all = <T>(url: string, params: Record<string, unknown> = {}) =>
  api.get<{ items: T[] }>(url, { params }).then((r) => r.data.items);

export const adminApi = {
  // Starts a background sync (survives refresh); poll syncStatus to track it.
  syncNow: () =>
    api.post<{ started: boolean; running: boolean }>("/api/hcm/sync-now").then((r) => r.data),
  syncStatus: () => api.get<SyncStatus>("/api/hcm/sync-status").then((r) => r.data),
  syncEntity: (entity: string) =>
    api.post<{ result: SyncResult }>(`/api/hcm/sync/${entity}`).then((r) => r.data.result),
  syncLog: () => api.get<{ items: SyncResult[] }>("/api/hcm/sync-log").then((r) => r.data.items),
  getSchedule: () => api.get<Schedule>("/api/hcm/schedule").then((r) => r.data),
  setSchedule: (body: { enabled: boolean; interval_minutes: number }) =>
    api.put<Schedule>("/api/hcm/schedule", body).then((r) => r.data),

  // ---- Rules engine ----
  rules: {
    vocabulary: () =>
      api.get<RuleVocabulary>("/api/rules/events").then((r) => r.data),
    list: (p: ListParams & { event_code?: string } = {}) => page<Rule>("/api/rules", p),
    get: (id: number) => api.get<Rule>(`/api/rules/${id}`).then((r) => r.data),
    create: (body: Partial<Rule> & { force?: boolean }) =>
      api.post<Rule>("/api/rules", body).then((r) => r.data),
    update: (id: number, body: Partial<Rule> & { force?: boolean }) =>
      api.put<Rule>(`/api/rules/${id}`, body).then((r) => r.data),
    deactivate: (id: number) => api.delete(`/api/rules/${id}`).then((r) => r.data),
    // Called while editing, so a clash surfaces before Save rather than after.
    checkConflicts: (body: Partial<Rule>, ruleId?: number) =>
      api.post<{ conflicts: Conflict[] }>("/api/rules/check-conflicts", body,
        { params: ruleId ? { rule_id: ruleId } : {} }).then((r) => r.data.conflicts),
    simulate: (event_code: string, context: Record<string, unknown>) =>
      api.post<SimulateResult>("/api/rules/simulate", { event_code, context })
        .then((r) => r.data),
    executions: (p: { event_code?: string; size?: number } = {}) =>
      page<Record<string, unknown>>("/api/rules/executions", p),
  },

  // ---- Audit, notifications, numbering ----
  audit: (p: { entity?: string; action?: string; page?: number; size?: number } = {}) =>
    page<AuditRow>("/api/admin/audit", p),
  notifications: {
    list: () => all<NotificationRule>("/api/admin/notifications"),
    create: (body: Partial<NotificationRule>) =>
      api.post<NotificationRule>("/api/admin/notifications", body).then((r) => r.data),
    update: (id: number, body: Partial<NotificationRule>) =>
      api.put<NotificationRule>(`/api/admin/notifications/${id}`, body).then((r) => r.data),
    remove: (id: number) =>
      api.delete(`/api/admin/notifications/${id}`).then((r) => r.data),
  },

  workflows: {
    list: () =>
      api.get<{ items: WorkflowDefinition[]; total: number }>("/api/workflow/definitions")
        .then((r) => r.data),
    get: (id: number) =>
      api.get<WorkflowDefinition>(`/api/workflow/definitions/${id}`).then((r) => r.data),
    options: () =>
      api.get<WorkflowOptions>("/api/workflow/definitions/options").then((r) => r.data),
    create: (body: Partial<WorkflowDefinition>) =>
      api.post<WorkflowDefinition>("/api/workflow/definitions", body).then((r) => r.data),
    update: (id: number, body: Partial<WorkflowDefinition>) =>
      api.put<WorkflowDefinition>(`/api/workflow/definitions/${id}`, body).then((r) => r.data),
    deactivate: (id: number) =>
      api.delete(`/api/workflow/definitions/${id}`).then((r) => r.data),
  },
  docSeries: {
    list: () => all<DocSeries>("/api/admin/doc-series"),
    create: (body: Partial<DocSeries>) =>
      api.post<DocSeries>("/api/admin/doc-series", body).then((r) => r.data),
    update: (id: number, body: Partial<DocSeries>) =>
      api.put<DocSeries>(`/api/admin/doc-series/${id}`, body).then((r) => r.data),
    deactivate: (id: number) =>
      api.delete(`/api/admin/doc-series/${id}`).then((r) => r.data),
  },
};
