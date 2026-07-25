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

// --------------------------------------------------------------------------- //
//  Admin module: users, groups, rules, audit, notifications
// --------------------------------------------------------------------------- //

export interface AdminUserRow {
  employee_id: number;
  emp_code?: string | null;
  full_name: string;
  email?: string | null;
  department_name?: string | null;
  has_access: boolean;
  locked: boolean;
  last_login_at?: string | null;
  roles: {
    id: number;
    code: string;
    name: string;
    source: "HCM" | "SCM";
    assignable: boolean;
  }[];
  positions: { id: number; name: string }[];
}

export interface AccessSummary {
  active_employees: number;
  users_with_access: number;
  active_roles: number;
}

export interface PageAccessMatrix {
  pages: {
    code: string;
    name: string;
    module?: string | null;
    always_on: boolean;
    required_permission?: string | null;
  }[];
  roles: {
    id: number;
    code: string;
    name: string;
    source: "HCM" | "SCM";
    page_codes: string[];
  }[];
}

export interface FeatureAccessMatrix {
  features: {
    code: string;
    module: string;
    description: string;
  }[];
  roles: {
    id: number;
    code: string;
    name: string;
    source: "HCM" | "SCM";
    permission_codes: string[];
  }[];
}

/** Returned once, on grant or reset. The password is never readable again. */
export interface GrantResult {
  success: boolean;
  employee_id: number;
  temporary_password?: string | null;
}

// ROLE is an SCM permission role (what you may do); HCM_ROLE is the HRMS org role
// (what you are). Both exist on purpose.
export type GroupType = "ROLE" | "HCM_ROLE" | "POSITION" | "LOCATION";

export interface UserGroup {
  id: number;
  code: string;
  name: string;
  description?: string | null;
  parent_id?: number | null;
  group_type: GroupType;
  role_id?: number | null;
  position_id?: number | null;
  location_id?: number | null;
  is_active: boolean;
}

export interface GroupMember {
  id: number;
  emp_code?: string | null;
  full_name: string;
  email?: string | null;
  department_name?: string | null;
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
