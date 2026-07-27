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
