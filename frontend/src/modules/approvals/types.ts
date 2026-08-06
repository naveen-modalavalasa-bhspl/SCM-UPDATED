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
