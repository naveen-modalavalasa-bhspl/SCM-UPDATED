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

/** One line the approver DROPPED when they signed — stored on the indent line
 *  itself (`is_excluded`), served with the decision so the ledger can say what was
 *  left out without sending the reader to the document to guess from a zero. */
export interface ApprovalDecisionExclusion {
  line_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  requested_quantity: number;
  excluded_by_name?: string | null;
  excluded_at?: string | null;
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
  excluded_items?: ApprovalDecisionExclusion[];
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
  required_date?: string | null;
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

/** The inbox counted in SQL — already scoped to the caller by the API. */
export interface PendingSummary {
  total: number;
  past_due: number;
  /** ISO timestamp of the longest-waiting task, or null on an empty queue. */
  oldest_waiting_since: string | null;
  by_doc_type: Record<string, number>;
}

/** A monthly allocation cycle waiting on the caller. */
export interface AllocationCycleRow {
  cycle: string;
  indent_count?: number;
  item_count?: number;
  total_qty?: number;
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
  /** Dropped at a rung below this one. Optional: a backend deployed before the flag
   *  omits it, and the row then behaves exactly as it always did. */
  is_excluded?: boolean;
  excluded_by_name?: string | null;
}

export interface ConsolidatedItem {
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  /** Decimal places this unit may carry: 0 for anything counted in whole numbers, 3
   *  for anything measured. Optional — an older API build does not send it, and the
   *  split then falls back to its own rule. */
  uom_decimals?: number;
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
  /** NORMAL / URGENT. Optional: an older API build does not send it. */
  priority?: string | null;
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
  /** The consolidation document — the same number the Fulfilment Queue and Allocation
   *  Approvals show for this set. Null only for indents that predate the document. */
  consolidation_no?: string | null;
  consolidation_status?: string | null;
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

/** `search` and the raised-on window are free-text/date, not dimensions: they have no
 *  dropdown and are always available, so they live here but never in
 *  `ConsolidationDimension`. Dates are ISO `YYYY-MM-DD`, what `<input type="date">`
 *  gives and what FastAPI parses into a `date`. */
export type ConsolidationQuery = Partial<Record<
  "cycle" | "region_id" | "project_id" | "vehicle_id" | "office_id" | "requester_id"
  | "item_id" | "search" | "raised_from" | "raised_to",
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
  /** `skipped` means the batch deliberately left it alone (already served in
   *  full), not that anything went wrong. */
  failed: Array<{ indent_id: number; reason: string; skipped?: boolean }>;
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

/** One line's fulfilment position: what is owed, and what this approver can cover. */
export interface IndentAvailabilityLine {
  line_id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  requested_quantity: number;
  approved_quantity: number;
  allocated_quantity: number;
  /** approved − allocated: what still has to come from somewhere. */
  remainder: number;
  available_at_my_points: number;
  /** min(remainder, available) — what an Issue now would actually move. */
  issuable_now: number;
  sources: Array<{ warehouse_id: number; warehouse_name?: string | null; available_quantity: number }>;
}

export interface IndentAvailability {
  indent_id: number;
  indent_no: string;
  /** The requester's own point — where an issue lands. Null when untagged. */
  target_warehouse_id?: number | null;
  target_warehouse_name?: string | null;
  my_warehouse_ids: number[];
  items: IndentAvailabilityLine[];
}

export interface IssueFromStockLine {
  line_id: number;
  warehouse_id: number;
  quantity: number;
}

export interface IssueFromStockResult {
  /** True when the remainder was handed to the next approver in the same act. */
  forwarded?: boolean;
  indent_id: number;
  /** The allocation this raised. Nothing moved — its approval reserves the stock,
   *  and the warehouse material issue is what finally hands the goods over. */
  allocation_id: number;
  allocation_no: string;
  allocation_status: string;
  issued: Array<{
    line_id: number;
    item_name?: string | null;
    quantity: number;
    from_warehouse_id: number;
    to_warehouse_id: number;
    remainder: number;
  }>;
  outstanding_quantity: number;
  /** Nothing owed anywhere — the indent has no reason to climb further. */
  fully_served: boolean;
  /** The ladder ended with this act: the indent is out of approval, so the screen
   *  must leave rather than refetch a document that is no longer awaiting anyone. */
  closed?: boolean;
}

/** One row of the queue, named the way the engine names it. */
export interface BulkDocumentRef {
  doc_type: string;
  doc_id: number;
}

/** Counts first: after a bulk sign the approver's question is "did they all go?",
 *  and `failed` names the ones that did not so the queue can be retried on those. */
export interface BulkActionResult {
  action: string;
  requested: number;
  succeeded: number;
  items: Array<{ doc_type: string; doc_id: number; action: string }>;
  failed: Array<{ doc_type?: string | null; doc_id?: number | null; error: string }>;
}
