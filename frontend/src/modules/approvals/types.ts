export interface PendingApproval {
  instance_id: number;
  doc_type: string;
  doc_id: number;
  stage_sequence: number;
  doc_no?: string | null;
  summary?: string | null;
  requested_by_name?: string | null;
  amount?: number | null;
  waiting_since?: string | null;
  due_at?: string | null;
  current_stage_name?: string | null;
  approver_name?: string | null;
}

export interface ApprovalDecisionRow {
  id: number;
  doc_type: string;
  doc_id: number;
  doc_no?: string | null;
  stage_sequence: number;
  stage_name?: string | null;
  decision: string;
  comments?: string | null;
  decision_at?: string | null;
  started_at?: string | null;
  duration_hours?: number | null;
  within_sla?: boolean | null;
  requester?: string | null;
  approver_name?: string | null;
  workflow_status: string;
}

export interface ApprovalReportRow {
  key: string;
  doc_type: string;
  doc_id: number;
  doc_no?: string | null;
  requester?: string | null;
  approver_name?: string | null;
  stage: string;
  status: "PENDING" | string;
  report_at?: string | null;
  raised_at?: string | null;
  duration_hours?: number | null;
  overdue: boolean;
  within_sla?: boolean | null;
  comments?: string | null;
}

export interface TeamQueueRow {
  approver_id: number;
  approver_name: string;
  pending_count: number;
  overdue_count: number;
  oldest_waiting_since?: string | null;
  average_waiting_hours: number;
  document_types: string[];
}

export interface ApprovalIndentLine {
  id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  requested_quantity: number;
  approved_quantity: number;
  /** Ceiling for this approver — the request, or what the level below approved. */
  max_quantity: number;
  remarks?: string | null;
}

export interface ApprovalIndent {
  id: number;
  indent_no: string;
  status: string;
  priority: string;
  requested_by_name?: string | null;
  position_name?: string | null;
  department_name?: string | null;
  office_name?: string | null;
  current_stage_name?: string | null;
  current_approver_name?: string | null;
  can_return_for_correction?: boolean;
  created_at: string;
  items: ApprovalIndentLine[];
}

export interface ApprovalQuantityInput {
  line_id: number;
  approved_quantity: number;
}

export interface ApprovalHistoryRow {
  id: number;
  stage_sequence: number;
  stage_name?: string | null;
  actor_id?: number | null;
  actor_name?: string | null;
  actor_position?: string | null;
  action: string;
  comments?: string | null;
  acted_at?: string | null;
}

export interface ApprovalReport {
  total_decisions: number;
  approved: number;
  rejected: number;
  returned: number;
  pending: number;
  overdue: number;
  average_decision_hours: number;
}

/** One indent's share of a consolidated item line. */
export interface ConsolidatedItemAllocation {
  indent_id: number;
  indent_no: string;
  line_id: number;
  requested_by_name?: string | null;
  requested_quantity: number;
  ceiling_quantity: number;
}

export interface ConsolidatedItem {
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  total_requested_quantity: number;
  /** The most this approver could pass on for this item across the whole batch. */
  total_ceiling_quantity: number;
  indent_count: number;
  /** Who asked for this item, per indent — what an approved total is split across. */
  allocations: ConsolidatedItemAllocation[];
}

export interface ConsolidationIndentSummary {
  id: number;
  indent_no: string;
  status: string;
  requested_by_id?: number | null;
  requested_by_name?: string | null;
  requested_by_code?: string | null;
  region_id?: number | null;
  region_name?: string | null;
  project_id?: number | null;
  project_name?: string | null;
  office_id?: number | null;
  office_name?: string | null;
  vehicle_id?: number | null;
  vehicle_number?: string | null;
  current_stage_name?: string | null;
  line_count: number;
  total_requested_quantity: number;
  /** null at the first approval stage — nothing "previous" to show yet. */
  previous_approved_quantity?: number | null;
  current_ceiling_quantity: number;
}

export interface ConsolidationBatch {
  batch_key: string;
  cycle: string;
  month_label: string;
  region_id?: number | null;
  region_name?: string | null;
  project_id?: number | null;
  project_name?: string | null;
  current_stage_name?: string | null;
  indent_count: number;
  requester_count: number;
  /** Distinct projects/regions across the FILTERED indents in this cycle. */
  project_count: number;
  region_count: number;
  requesters: string[];
  consolidated_items: ConsolidatedItem[];
  indents: ConsolidationIndentSummary[];
}

/** The dimensions the Consolidation workspace can be narrowed by. Every one maps to
 *  a column that already exists on ind_indents / ind_indent_items. There is no
 *  `phase`: the data model has no phase column, so the screen offers no such filter. */
export type ConsolidationDimension =
  "cycle" | "region" | "project" | "vehicle" | "office" | "requester" | "item";

export interface ConsolidationFilterOption {
  value: string;
  label: string;
  indent_count: number;
}

/** A dimension with an empty list is one the current queue carries no values for —
 *  the filter bar hides that control instead of showing an empty dropdown. */
export type ConsolidationFilterOptions = Record<ConsolidationDimension, ConsolidationFilterOption[]>;

export type ConsolidationQuery = Partial<Record<
  "cycle" | "region_id" | "project_id" | "vehicle_id" | "office_id" | "requester_id" | "item_id",
  string
>>;

export interface ConsolidationWorkspace {
  items: ConsolidationBatch[];
  filter_options: ConsolidationFilterOptions;
  applied: Record<string, string | number>;
  total_indent_count: number;
  total_requester_count: number;
  /** Pending Monthly indents before any filter — lets the header say "8 of 24". */
  unfiltered_indent_count: number;
}

export interface ConsolidationApprovalInput {
  /** The filtered set on screen — this is what gets approved. */
  indent_ids: number[];
  /** Only the quantities the split produced; an untouched line keeps its ceiling. */
  lines: Array<{ indent_id: number; line_id: number; approved_quantity: number }>;
  comments?: string;
}

export interface ConsolidationApprovalResult {
  approved_count: number;
  approved_indent_ids: number[];
  /** An indent that moved on since the screen loaded — reported, not fatal. */
  failed: Array<{ indent_id: number; reason: string }>;
}

export interface CorrectionIndent {
  id: number;
  indent_no: string;
  required_date?: string | null;
  priority: string;
  remarks?: string | null;
  status: string;
  can_edit_correction?: boolean;
  can_resubmit_correction?: boolean;
  items: Array<{
    id: number;
    item_id: number;
    item_code?: string | null;
    item_name?: string | null;
    uom_code?: string | null;
    quantity: number;
    remarks?: string | null;
  }>;
}
