export interface AppSettings {
  company: {
    name: string;
    legal_name: string;
    gstin: string;
    address: string;
    phone: string;
    email: string;
  };
  regional: {
    fiscal_year: string;
    default_warehouse_id?: number | null;
    currency: string;
    date_format: string;
    timezone: string;
  };
  hcm_sync: {
    enabled: boolean;
    interval_minutes: number;
  };
  numbering: {
    fiscal_year_prefix: string;
    default_pattern: string;
    reset_policy: string;
  };
  notifications: {
    channels: string[];
    email_enabled: boolean;
    in_app_enabled: boolean;
  };
  fallback: {
    workflow_fallback_enabled: boolean;
    notify_admin_on_fallback: boolean;
    allow_auto_admin_fallback: boolean;
  };
  warehouse: {
    /** What a stocking point does with an arriving consignment when it has not
     *  answered for itself. The per-point flag on the warehouse master wins. */
    requires_inward_default: boolean;
    /** 0 = no limit. */
    max_serials_per_line: number;
    max_serials_per_request: number;
    max_units_per_code_mint: number;
  };
  logistics: {
    /** Let the dispatch desk record a courier name without a logistics-vendor login. */
    manual_courier_dispatch: boolean;
  };
  security: {
    /** How long a vendor's one-time code stays good for, in seconds. Enforced by the
     *  server at verification time — the vendor's screen shows the window but never
     *  decides it, so a client that ignores the number gets no longer a life. */
    vendor_quote_otp_seconds: number;
    /** How long a "forgot password" link stays live, in minutes. Rejected server-side
     *  on redemption, so the number here is the rule and not a hint. */
    password_reset_minutes: number;
  };
}

/** GET/PUT /api/settings/code-formats — the asset & consumable code formula.
 *  Separate from AppSettings because it has its own permission. */
export interface CodeFormats {
  asset_format: string;
  consumable_format: string;
  /** The serial minted at goods-in for a unit that arrived without one. Cannot use
   *  {serial} — it IS the serial — and must include {seq}. */
  serial_format: string;
  new_flag: string;
  legacy_flag: string;
  /** ISO date. Items created before it render `legacy_flag` for {new_flag}. */
  legacy_before: string;
}

export interface CodeFormatToken {
  token: string;
  description: string;
}

export interface MonthlyIndentCycle {
  is_enabled: boolean;
  approval_flow_enabled: boolean;
  /** Which month the window OPENS in, counted from the current month. Only read by
   *  the server when `anchor_month` is empty (a row saved before it existed). */
  cycle_month_offset: number;
  /** YYYY-MM-01 of a month a cycle opens in. Cycles open there and every
   *  `period_months` either side of it. Always served. */
  anchor_month?: string | null;
  /** Only people a submission rule names may raise a monthly indent. */
  restrict_to_rules: boolean;
  start_day: number;
  /** How many months after the opening month it CLOSES in — 0 is the same month. */
  end_month_offset: number;
  end_day: number;
  /** Which month the indents are FOR, counted from the opening month. Names the
   *  cycle; moves no date. */
  serves_month_offset: number;
  timezone: string;
  scheduler_enabled: boolean;
  scheduler_interval_minutes: number;
  cycle_start?: string;
  cycle_end?: string;
  cycle_key?: string;
  serves_start?: string;
  serves_month?: string;
  /** How many months apart consecutive cycles open. Served; read-only. */
  period_months?: number;
}

export type MonthlyIndentCondition = "NOT_SUBMITTED" | "PENDING_APPROVAL" | "NOT_RESPONDED";
export type MonthlyIndentTargetType = "HCM_ROLE" | "POSITION" | "EMPLOYEE";
export type MonthlyIndentEscalationTargetType = "REPORTING_MANAGER" | "HCM_ROLE" | "EMPLOYEE";

export interface MonthlyIndentRule {
  id: number;
  name: string;
  is_active: boolean;
  trigger_day: number;
  trigger_time: string;
  target_type: MonthlyIndentTargetType;
  target_ref_id: number;
  target_name?: string | null;
  condition: MonthlyIndentCondition;
  message_template: string;
  escalation_enabled: boolean;
  escalation_day?: number | null;
  escalation_time?: string | null;
  escalation_target_type?: MonthlyIndentEscalationTargetType | null;
  escalation_target_ref_id?: number | null;
  escalation_target_name?: string | null;
  escalation_message_template?: string | null;
  /** Follow up this many days after the reminder instead of on a fixed day. */
  escalation_after_days?: number | null;
  /** How many rungs of the reporting line are told, one step apart. */
  escalation_levels?: number;
}

export interface MonthlyIndentSubmissionRule {
  id: number;
  name: string;
  is_active: boolean;
  target_type: MonthlyIndentTargetType;
  target_ref_id: number;
  target_name?: string | null;
  max_submissions: number;
  deadline_day: number;
  allow_after_deadline: boolean;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface MonthlyIndentLog {
  id: number;
  rule_id: number;
  cycle_key: string;
  /** PRIMARY, ESCALATION (level 1) or ESCALATION_L<n> for a later rung. */
  kind: string;
  target_employee_id: number;
  target_employee_name?: string | null;
  recipient_employee_id: number;
  recipient_employee_name?: string | null;
  status: "SENT" | "SKIPPED";
  reason?: string | null;
  title?: string | null;
  message?: string | null;
  sent_at: string;
}

export interface MonthlyIndentSettings {
  cycle: MonthlyIndentCycle;
  rules: MonthlyIndentRule[];
  submission_rules: MonthlyIndentSubmissionRule[];
  logs: MonthlyIndentLog[];
  next_run?: string | null;
}
