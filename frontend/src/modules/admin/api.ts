import { api } from "@/shared/api/client";
import type { Paginated } from "@/shared/types";
import type {
  ApprovalPost, ApprovalPostMember,
  AppLog, AuditRow, Conflict, CustomLadder, CustomLadderStep, DocSeries,
  FlowOverview, FlowRungs, FlowVersion, JobProfileOption, Ladder,
  LadderDepartment, LadderOptions, LadderPolicy, LadderPosition, LadderPost,
  LadderPreview, LadderRank,
  LadderRung, NotificationRule, ReminderConfig, ReminderRunResult, ReminderStatus,
  Rule, RuleVocabulary, Schedule, SimulateResult, StaleInstance,
  SyncResult, SyncStatus, WorkflowDefinition, WorkflowOptions,
} from "./types";

/** What the server needs to save or preview a ladder — the toggles, nothing else. */
const rungPayload = (rungs: LadderRung[]) => rungs.map((rung) => ({
  position_role_id: rung.position_role_id,
  name: rung.name,
  is_enabled: rung.is_enabled,
  selected_position_ids: rung.selected_position_ids,
  conditions: rung.conditions,
}));

/** One step of an approval chain, as the server wants it.
 *
 *  Exactly ONE of the three chair kinds is sent. The server rejects any other count,
 *  so a step that leaked a null `position_id` alongside a `post_id` would come back
 *  422 and read to the admin as "Save did nothing". Exported for its test. */
export const stepPayload = (step: CustomLadderStep) => ({
  name: step.name,
  ...(step.post_id != null ? { post_id: step.post_id }
    : step.position_role_id != null ? { position_role_id: step.position_role_id }
    : { position_id: step.position_id }),
});

/** The ladder-wide settings, omitted entirely when the caller has none — the server
 *  treats a missing policy as "leave it at the default". */
const policyPayload = (policy?: Partial<LadderPolicy>) => (policy ? {
  self_approval_policy: policy.self_approval_policy,
  fallback_position_id: policy.fallback_position_id ?? null,
} : {});

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
  audit: (p: { entity?: string; action?: string; search?: string; page?: number; size?: number } = {}) =>
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
    // Ranks and a rank's posts are keyed on the PROJECT, not the document, so they are
    // read separately and stay cached while the admin flips between documents.
    ranks: (projectId: number | null) =>
      api.get<{ ranks: LadderRank[] }>("/api/workflow/ladders/ranks", {
        params: projectId != null ? { project_id: projectId } : {},
      }).then((r) => r.data.ranks),
    rankPositions: (projectId: number | null, roleId: number) =>
      api.get<{ positions: LadderPosition[] }>("/api/workflow/ladders/rank-positions", {
        params: { role_id: roleId, ...(projectId != null ? { project_id: projectId } : {}) },
      }).then((r) => r.data.positions),
    // Runs against the toggles currently on screen, saved or not, so the admin sees
    // the outcome of a change before committing to it.
    preview: (projectId: number | null, docType: string, rungs: LadderRung[],
              fromRoleId: number | null, policy?: Partial<LadderPolicy>) =>
      api.post<LadderPreview>("/api/workflow/ladders/preview", {
        project_id: projectId, doc_type: docType, rungs: rungPayload(rungs),
        ...policyPayload(policy),
      }, { params: fromRoleId != null ? { from_role_id: fromRoleId } : {} })
        .then((r) => r.data),
    save: (projectId: number | null, docType: string, rungs: LadderRung[],
           policy?: Partial<LadderPolicy>) =>
      api.post<Ladder>("/api/workflow/ladders", {
        project_id: projectId, doc_type: docType, rungs: rungPayload(rungs),
        ...policyPayload(policy),
      }).then((r) => r.data),
    copy: (fromProjectId: number | null, docType: string, toProjectIds: number[]) =>
      api.post<{ copied_to: number[] }>("/api/workflow/ladders/copy", {
        from_project_id: fromProjectId, doc_type: docType, to_project_ids: toProjectIds,
      }).then((r) => r.data),
    /** Documents still climbing a ladder that has since been replaced. Not scoped to
     *  the project on screen: the point is to see every one of them in one place. */
    staleInFlight: () =>
      api.get<{ items: StaleInstance[]; total: number }>(
        "/api/workflow/ladders/in-flight-stale",
      ).then((r) => r.data),
  },
  // ---- Overdue-approval chasing: remind, then escalate to the approver's manager ----
  reminders: {
    status: () =>
      api.get<ReminderStatus>("/api/workflow/reminders").then((r) => r.data),
    save: (config: ReminderConfig) =>
      api.put<ReminderConfig & { next_run: string | null }>(
        "/api/workflow/reminders", config,
      ).then((r) => r.data),
    /** Chases now, whatever the schedule says — the switch governs the timer, and a
     *  person pressing a button is not the timer. */
    runNow: () =>
      api.post<ReminderRunResult>("/api/workflow/reminders/run").then((r) => r.data),
  },
  // ---- Build your own ladder: departments, then the posts inside one ----
  // A department is a dozen posts, not three thousand, which is why this screen shows
  // checkboxes instead of a search box over 2,787 people.
  customLadders: {
    departments: (projectId: number | null) =>
      api.get<{ departments: LadderDepartment[] }>("/api/workflow/ladders/departments", {
        params: projectId != null ? { project_id: projectId } : {},
      }).then((r) => r.data.departments),
    posts: (projectId: number | null, department: string) =>
      api.get<{ posts: LadderPost[] }>("/api/workflow/ladders/department-posts", {
        params: { department, ...(projectId != null ? { project_id: projectId } : {}) },
      }).then((r) => r.data.posts),
    get: (projectId: number | null, docType: string) =>
      api.get<CustomLadder>("/api/workflow/ladders/custom", {
        params: { doc_type: docType, ...(projectId != null ? { project_id: projectId } : {}) },
      }).then((r) => r.data),
    save: (projectId: number | null, docType: string, steps: CustomLadderStep[],
           policy?: Partial<LadderPolicy>) =>
      api.post<CustomLadder>("/api/workflow/ladders/custom", {
        project_id: projectId, doc_type: docType,
        steps: steps.map((step) => ({ position_id: step.position_id, name: step.name })),
        ...policyPayload(policy),
      }).then((r) => r.data),
  },
  // ---- Settings > Approval Flow: one screen for "who signs what" ----
  // Saves through the same writer as customLadders, so a chain built here is the same
  // row a chain built there is — this is a new front, not a second store.
  flow: {
    overview: (projectId: number | null) =>
      api.get<FlowOverview>("/api/workflow/flow", {
        params: projectId != null ? { project_id: projectId } : {},
      }).then((r) => r.data),
    chain: (projectId: number | null, docType: string) =>
      api.get<CustomLadder>(`/api/workflow/flow/${docType}`, {
        params: projectId != null ? { project_id: projectId } : {},
      }).then((r) => r.data),
    /** `search` only reaches the HCM posts — local chairs and ranks are short lists and
     *  come back whole, so the picker has something to show before anyone types. */
    rungs: (projectId: number | null, search = "") =>
      api.get<FlowRungs>("/api/workflow/flow/rungs", {
        params: { search, ...(projectId != null ? { project_id: projectId } : {}) },
      }).then((r) => r.data),
    /** Every version, newest first, each with the documents still riding it. */
    versions: (projectId: number | null, docType: string) =>
      api.get<{ items: FlowVersion[] }>(`/api/workflow/flow/${docType}/versions`, {
        params: projectId != null ? { project_id: projectId } : {},
      }).then((r) => r.data.items),
    /** Copies an old version's steps forward as a new one — the old row is never
     *  revived, so documents frozen onto it keep resolving against it. */
    restore: (projectId: number | null, docType: string, workflowId: number) =>
      api.post<CustomLadder>(
        `/api/workflow/flow/${docType}/restore/${workflowId}`, null,
        { params: projectId != null ? { project_id: projectId } : {} },
      ).then((r) => r.data),
    save: (projectId: number | null, docType: string, steps: CustomLadderStep[],
           policy?: Partial<LadderPolicy>) =>
      api.post<CustomLadder>("/api/workflow/flow", {
        project_id: projectId, doc_type: docType,
        steps: steps.map(stepPayload),
        ...policyPayload(policy),
      }).then((r) => r.data),
  },
  // ---- the chairs this system owns, for the steps HCM has no post for ----
  approvalPosts: {
    list: () => api.get<{ items: ApprovalPost[] }>("/api/workflow/posts")
      .then((r) => r.data.items),
    /** Job profiles a post can carry. Seating someone in the post then grants it,
     *  so access follows the chair instead of being handed out per person. */
    profiles: () =>
      api.get<{ items?: JobProfileOption[] } | JobProfileOption[]>("/api/rbac/roles")
        .then((r) => (Array.isArray(r.data) ? r.data : r.data.items ?? [])),
    employees: (search: string) =>
      api.get<{ items: ApprovalPostMember[] }>("/api/workflow/posts/employees",
        { params: { search } }).then((r) => r.data.items),
    create: (body: Partial<ApprovalPost> & { employee_ids: number[] }) =>
      api.post<ApprovalPost>("/api/workflow/posts", body).then((r) => r.data),
    update: (id: number, body: Partial<ApprovalPost> & { employee_ids: number[] }) =>
      api.put<ApprovalPost>(`/api/workflow/posts/${id}`, body).then((r) => r.data),
    retire: (id: number) =>
      api.delete(`/api/workflow/posts/${id}`).then((r) => r.data),
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
