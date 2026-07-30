import { api } from "@/shared/api/client";
import type { Paginated } from "@/shared/types";
import type {
  AppLog, AuditRow, Conflict, DocSeries, Ladder, LadderOptions, LadderPreview,
  LadderRung, NotificationRule, Rule, RuleVocabulary, Schedule, SimulateResult,
  SyncResult, SyncStatus, WorkflowDefinition, WorkflowOptions,
} from "./types";

/** What the server needs to save or preview a ladder — the toggles, nothing else. */
const rungPayload = (rungs: LadderRung[]) => rungs.map((rung) => ({
  position_role_id: rung.position_role_id,
  name: rung.name,
  is_enabled: rung.is_enabled,
  conditions: rung.conditions,
}));

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
  appLogs: {
    list: (p: {
      source?: string; level?: string; status_code?: number;
      search?: string; page?: number; size?: number;
      endpoint?: string; source_file?: string; function_name?: string;
      message?: string; request_id?: string;
    } = {}) => page<AppLog>("/api/admin/app-logs", p),
  },
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
  // ---- Approvals Config: one ladder per project per document ----
  ladders: {
    options: () =>
      api.get<LadderOptions>("/api/workflow/ladders/options").then((r) => r.data),
    get: (projectId: number | null, docType: string) =>
      api.get<Ladder>("/api/workflow/ladders", {
        params: { doc_type: docType, ...(projectId != null ? { project_id: projectId } : {}) },
      }).then((r) => r.data),
    // Runs against the toggles currently on screen, saved or not, so the admin sees
    // the outcome of a change before committing to it.
    preview: (projectId: number | null, docType: string, rungs: LadderRung[],
              fromRoleId: number | null) =>
      api.post<LadderPreview>("/api/workflow/ladders/preview", {
        project_id: projectId, doc_type: docType, rungs: rungPayload(rungs),
      }, { params: fromRoleId != null ? { from_role_id: fromRoleId } : {} })
        .then((r) => r.data),
    save: (projectId: number | null, docType: string, rungs: LadderRung[]) =>
      api.post<Ladder>("/api/workflow/ladders", {
        project_id: projectId, doc_type: docType, rungs: rungPayload(rungs),
      }).then((r) => r.data),
    copy: (fromProjectId: number | null, docType: string, toProjectIds: number[]) =>
      api.post<{ copied_to: number[] }>("/api/workflow/ladders/copy", {
        from_project_id: fromProjectId, doc_type: docType, to_project_ids: toProjectIds,
      }).then((r) => r.data),
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
