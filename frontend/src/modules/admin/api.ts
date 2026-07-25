import { api } from "@/shared/api/client";
import type { Paginated } from "@/shared/types";
import type {
  AccessSummary, AdminUserRow, AuditRow, Conflict, GrantResult, GroupMember,
  NotificationRule, Rule, RuleVocabulary, Schedule, SimulateResult, SyncResult,
  SyncStatus, UserGroup,
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

  // ---- Users: HCM employees granted SCM access ----
  users: {
    list: (p: ListParams & { with_access?: boolean }) =>
      page<AdminUserRow>("/api/admin/users", p),
    summary: () => api.get<AccessSummary>("/api/admin/users/summary").then((r) => r.data),
    grant: (body: { employee_id: number; role_ids: number[]; password?: string | null }) =>
      api.post<GrantResult>("/api/admin/users/grant", body).then((r) => r.data),
    revoke: (employeeId: number) =>
      api.delete(`/api/admin/users/${employeeId}/access`).then((r) => r.data),
    resetPassword: (employeeId: number) =>
      api.post<GrantResult>(`/api/admin/users/${employeeId}/reset-password`)
        .then((r) => r.data),
    setRoles: (employeeId: number, roleIds: number[]) =>
      api.put(`/api/admin/users/${employeeId}/roles`, { role_ids: roleIds })
        .then((r) => r.data),
  },

  // ---- Groups: membership is derived server-side, never stored ----
  groups: {
    list: (p: ListParams = {}) => page<UserGroup>("/api/admin/groups", p),
    create: (body: Partial<UserGroup>) =>
      api.post<UserGroup>("/api/admin/groups", body).then((r) => r.data),
    update: (id: number, body: Partial<UserGroup>) =>
      api.put<UserGroup>(`/api/admin/groups/${id}`, body).then((r) => r.data),
    deactivate: (id: number) =>
      api.delete(`/api/admin/groups/${id}`).then((r) => r.data),
    members: (id: number) => all<GroupMember>(`/api/admin/groups/${id}/members`),
    addMember: (id: number, employeeId: number) =>
      api.post(`/api/admin/groups/${id}/members/${employeeId}`).then((r) => r.data),
    removeMember: (id: number, employeeId: number) =>
      api.delete(`/api/admin/groups/${id}/members/${employeeId}`).then((r) => r.data),
  },

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
  roles: () => all<{ id: number; code: string; name: string; is_active: boolean }>(
    "/api/admin/roles"),
  // HCM's org roles ("Network Technicians"), derived from hcm_positions. Distinct
  // from roles() above, which is SCM permission roles.
  hcmRoles: () => all<{ id: number; name: string; positions: number }>(
    "/api/admin/hcm-roles"),
};
