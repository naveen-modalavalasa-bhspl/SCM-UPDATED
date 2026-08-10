export interface SyncResult {
  entity: string;
  status: string; // RUNNING | SUCCESS | FAILED
  records_fetched: number;
  records_upserted: number;
  error_message?: string | null;
}

export interface SyncStatus {
  running: boolean;
  items: SyncResult[];
}

export interface Schedule {
  enabled: boolean;
  interval_minutes: number;
  next_run: string | null;
}

export type ResetPolicy = "NEVER" | "YEARLY" | "MONTHLY";

export interface DocSeries {
  id: number;
  doc_type: string;
  fiscal_year: string;
  prefix: string;
  pattern: string;
  last_number: number;
  reset_policy: ResetPolicy;
  last_reset_period?: string | null;
  is_active: boolean;
  preview: string;
}

export type Operator =
  | "EQ" | "NEQ" | "GT" | "GTE" | "LT" | "LTE" | "IN" | "NOT_IN" | "BETWEEN";
export type ActionType =
  | "ROUTE_APPROVAL" | "ROUTE_FULFILLMENT" | "SPLIT_FULFILLMENT" | "NOTIFY" | "SET_FIELD";

export interface RuleCondition {
  id?: number;
  field_name: string;
  operator: Operator;
  field_value: string;
  logic: "AND" | "OR";
}

export interface RuleAction {
  id?: number;
  seq: number;
  action_type: ActionType;
  params: Record<string, unknown>;
}

export interface Conflict {
  severity: "error" | "warning";
  rule_id: number;
  rule_name: string;
  action_type: string;
  message: string;
}

export interface Rule {
  id: number;
  event_code: string;
  name: string;
  description?: string | null;
  priority: number;
  stop_on_match: boolean;
  is_active: boolean;
  effective_from?: string | null;
  effective_to?: string | null;
  conditions?: RuleCondition[];
  actions?: RuleAction[];
  warnings?: Conflict[];
}

export interface RuleEvent {
  code: string;
  name: string;
  module?: string | null;
  description?: string | null;
  /** field name -> "number" | "string"; drives the field picker in the builder. */
  context_schema: Record<string, string>;
}

export interface RuleVocabulary {
  items: RuleEvent[];
  operators: Operator[];
  logics: ("AND" | "OR")[];
  action_types: ActionType[];
}

export interface SimulateResult {
  matched: boolean;
  actions: {
    action_type: string;
    params: Record<string, unknown>;
    rule_id: number;
    rule_name: string;
  }[];
}

export type ApproverType =
  | "REPORTING_MANAGER" | "DEPT_HEAD" | "POSITION" | "ROLE" | "SPECIFIC_USER";
export type ApprovalMode = "ANY_ONE" | "ALL" | "MAJORITY";

export interface WorkflowCondition {
  id?: number;
  field_name: string;
  operator: Operator;
  field_value: string;
  logic: "AND" | "OR";
}

export interface WorkflowStage {
  id?: number;
  sequence: number;
  name: string;
  approver_type: ApproverType;
  position_id?: number | null;
  role_id?: number | null;
  employee_id?: number | null;
  approval_mode: ApprovalMode;
  is_optional: boolean;
  can_edit_document: boolean;
  sla_hours?: number | null;
  conditions: WorkflowCondition[];
}

export interface WorkflowDefinition {
  id: number;
  code: string;
  name: string;
  doc_type: string;
  version: number;
  is_active: boolean;
  is_fallback: boolean;
  effective_from?: string | null;
  effective_to?: string | null;
  created_at: string;
  stages: WorkflowStage[];
}

export interface WorkflowOption {
  id: number;
  name: string;
}

export interface DefaultFlowStep {
  doc_type: string;
  title: string;
  steps: string[];
  fallback: string;
}

export interface WorkflowOptions {
  doc_types: string[];
  approver_types: ApproverType[];
  approval_modes: ApprovalMode[];
  operators: Operator[];
  positions: WorkflowOption[];
  roles: WorkflowOption[];
  employees: WorkflowOption[];
  default_flow: DefaultFlowStep[];
}

export interface AuditRow {
  id: number;
  entity: string;
  entity_id: number;
  entity_no?: string | null;
  action: string;
  actor_id?: number | null;
  actor_name?: string | null;
  /** field -> {from, to}; only the fields that actually changed. */
  changed_fields?: Record<string, { from: unknown; to: unknown }> | null;
  at?: string | null;
}

export interface AppLog {
  id: number;
  request_id: string;
  source: "BACKEND" | "FRONTEND";
  level: "ERROR" | "WARNING";
  message: string;
  error_type?: string | null;
  status_code?: number | null;
  http_method?: string | null;
  endpoint?: string | null;
  page_url?: string | null;
  source_file?: string | null;
  function_name?: string | null;
  line_number?: number | null;
  column_number?: number | null;
  stack_trace?: string | null;
  actor_id?: number | null;
  actor_name?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
  context_data?: Record<string, unknown> | null;
  created_at: string;
}

export type RecipientType = "ROLE" | "POSITION" | "GROUP" | "EMPLOYEE";

export interface NotificationRule {
  id: number;
  event_code: string;
  stage?: string | null;
  recipient_type: RecipientType;
  recipient_id?: number | null;
  recipient_name?: string | null;
  channel: "IN_APP" | "EMAIL";
  template?: string | null;
  is_active: boolean;
}

// ---------------- Approval ladders (Settings > Approvals Config) ----------------

/** A rung names a RANK (hcm_positions.role_id — COO, SPH, REGIONAL MANAGER…), never
 *  a person and never a position row. The approver is found at submit time by
 *  climbing the raiser's own reporting line. */
export interface LadderHolder {
  id: number;
  name: string;
  code?: string | null;
}

export interface LadderPosition {
  id: number;
  name: string;
  department_id?: number | null;
  department_name: string;
  holders: LadderHolder[];
}

/** A rank with its people. Keyed on the project alone, so it survives a change of
 *  document — which is why it is fetched apart from the ladder. */
export interface LadderRank {
  role_id: number;
  role_name: string;
  depth: number;
  position_count: number;
  holders: LadderHolder[];
  holder_count: number;
}

export interface LadderRung {
  sequence: number;
  name: string;
  position_role_id: number;
  is_enabled: boolean;
  /** How many posts sit under this rank, and how many people fill them. The posts
   *  themselves are loaded only when the rung is opened — a live project has ~3,400. */
  position_count: number;
  holder_count: number;
  /** null — the default — is every post at this rank. A list narrows the rung to
   *  exactly those posts, which also excludes any ancestor outside them. */
  selected_position_ids: number[] | null;
  /** Nobody in this project holds a position at this rank any more. */
  is_dead?: boolean;
  /** HCM added this rank after the ladder was saved; offered switched off. */
  is_new_rank?: boolean;
  conditions: WorkflowCondition[];
}

/** Who may approve a document raised by someone who is also ON this ladder.
 *
 *  INDEPENDENT — the raiser is dropped from every rung; somebody else has to sign.
 *  CREATOR_ALLOWED — the raiser stays on the ladder and gets the approval task, which
 *  is what Inventory and Warehouse need: the same handful of people hold every post
 *  there, so dropping the raiser emptied the whole ladder and nothing moved.
 *  NO_APPROVAL — nobody signs it; the document is born approved with a wf_actions row
 *  saying so. Unticking every rung is NOT the same thing: an empty ladder reads as a
 *  misconfiguration and falls through to the reporting line. */
export type SelfApprovalPolicy = "INDEPENDENT" | "CREATOR_ALLOWED" | "NO_APPROVAL";

/** Both ladder kinds carry the same policy — it belongs to the ladder, not to a role
 *  or a person, so each project decides for itself. */
export interface LadderPolicy {
  self_approval_policy: SelfApprovalPolicy;
  /** Where an INDEPENDENT ladder sends a document when every rung resolved to the
   *  raiser himself. A POST, so it survives the person in the chair changing. */
  fallback_position_id: number | null;
  /** One line per person who fills more than one switched-on rung; they collapse to a
   *  single approver at submit, so a "two-step" ladder would only ever be one step. */
  warnings: string[];
}

export interface Ladder extends LadderPolicy {
  workflow_id: number | null;
  version: number;
  project_id: number | null;
  doc_type: string;
  module: string;
  /** No ladder saved yet — these rungs are an unsaved draft from the project's ranks. */
  is_new: boolean;
  /** A hand-built ladder is what actually runs for this document; these rungs are only
   *  a draft. One scope has one ladder, so saving here would replace it. */
  has_custom?: boolean;
  rungs: LadderRung[];
  /** Documents mid-approval that will finish on the version now live. */
  in_flight: number;
}

/** The overdue-approval chase settings. */
export interface ReminderConfig {
  enabled: boolean;
  interval_minutes: number;
  max_reminders: number;
  gap_hours: number;
  /** Only used when wf_pending.due_at is NULL, which today is every row. */
  overdue_after_days: number;
}

/** One overdue approval, and what the next sweep would do about it. */
export interface OverdueApproval {
  pending_id: number;
  doc_type: string;
  doc_no: string | null;
  doc_id: number;
  approver_id: number;
  raised_by: string | null;
  stage_name: string | null;
  due_at: string | null;
  /** False when the due date was derived rather than set on the task itself. */
  due_at_is_set: boolean;
  days_overdue: number;
  reminders_sent: number;
  escalated: boolean;
  next_action: "REMIND" | "ESCALATE" | "WAIT";
}

export interface ReminderStatus {
  config: ReminderConfig;
  items: OverdueApproval[];
  total: number;
  next_run: string | null;
}

export interface ReminderRunResult {
  overdue: number;
  reminded: number;
  escalated: number;
  skipped: number;
  enabled: boolean;
}

/** One document still climbing a ladder that has since been replaced. Correct
 *  behaviour — the chain is frozen at submit — but worth being able to see. */
export interface StaleInstance {
  instance_id: number;
  doc_type: string;
  doc_no: string | null;
  doc_id: number;
  raised_by: string | null;
  started_at: string | null;
  stage_name: string | null;
  stage_sequence: number;
  ladder_code: string;
  project_name: string | null;
  running_version: number;
  live_version: number;
  versions_behind: number;
}

export interface LadderOptions {
  projects: { id: number; name: string }[];
  doc_types: { code: string; label: string; module: string }[];
  module_order: string[];
}

/* ---- hand-built ladders (Approvals Config > Build your own ladder) ----
 *
 * For Inventory and Warehouse the approver is not above the raiser at all — the whole
 * warehouse department sits on posts with no parent and no children, and all twelve
 * share one rank. So a step names a POST, and the steps run in the order they were
 * ticked. Still not a person: whoever takes the chair inherits the approval. */

export interface LadderDepartment {
  name: string;
  position_count: number;
}

export interface LadderPost {
  id: number;
  name: string;
  role_name: string;
  holders: LadderHolder[];
}

export interface CustomLadderStep {
  sequence: number;
  position_id: number;
  name: string;
  holders: LadderHolder[];
  /** Nobody sits in this chair any more — it is skipped at submit. */
  is_dead?: boolean;
}

export interface CustomLadder extends LadderPolicy {
  workflow_id: number | null;
  version: number;
  project_id: number | null;
  doc_type: string;
  is_new: boolean;
  steps: CustomLadderStep[];
  in_flight: number;
}

export interface LadderPreview {
  from: { position_id: number; position_name: string } | null;
  chain: { role_name: string; position_name: string; approver_names: string[] }[];
  self_approved?: boolean;
  /** The climb reached only the raiser, so the ladder's nominated fallback post is
   *  where this really goes. */
  used_fallback?: boolean;
  note?: string;
}
