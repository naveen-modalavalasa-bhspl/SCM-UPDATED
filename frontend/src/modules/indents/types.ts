export interface IndentItem {
  id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  quantity: number;
  approved_quantity?: number | null;
  ordered_quantity: number;
  received_quantity: number;
  remarks?: string | null;
}

export interface Indent {
  id: number;
  indent_no: string;
  indent_date?: string | null;
  required_date?: string | null;
  requested_by_id?: number | null;
  requested_by_name?: string | null;
  position_id?: number | null;
  position_name?: string | null;
  department_id?: number | null;
  department_name?: string | null;
  office_id?: number | null;
  office_name?: string | null;
  project_id?: number | null;
  project_name?: string | null;
  status: string;
  priority: string;
  total_items: number;
  total_qty: number;
  remarks?: string | null;
  current_approver_name?: string | null;
  approved_at?: string | null;
  is_bookmarked: "YES" | "NO" | string;
  can_submit: boolean;
  can_approve: boolean;
  can_reject: boolean;
  created_at: string;
  items: IndentItem[];
}

export interface IndentListRow {
  id: number;
  indent_no: string;
  requested_by_name?: string | null;
  department_name?: string | null;
  status: string;
  priority: string;
  total_items: number;
  current_approver_name?: string | null;
  is_bookmarked: "YES" | "NO" | string;
  created_at: string;
}

export interface IndentStats {
  total: number;
  draft: number;
  awaiting_approval: number;
  approved_active: number;
  rejected: number;
  ordered: number;
  this_month: number;
  total_items: number;
  total_qty: number;
  approval_rate: number;
  by_status: Record<string, number>;
}

export interface ActivityRow {
  event_id: string;
  indent_id: number;
  indent_no: string;
  event_type?:
    | "REQUEST_CREATED"
    | "REQUEST_SUBMITTED"
    | "APPROVAL_COMPLETED"
    | "REQUEST_REJECTED"
    | "REQUEST_RETURNED"
    | "APPROVAL_ROUTED_AUTOMATICALLY"
    | "STOCK_ALLOCATED"
    | "PROCUREMENT_REQUEST_CREATED"
    | "BOOKMARK_ADDED"
    | "BOOKMARK_REMOVED"
    | string
    | null;
  event_label?: string | null;
  result?: string | null;
  result_label?: string | null;
  occurred_at?: string | null;
  actor_id?: number | null;
  actor_name?: string | null;
  actor_position?: string | null;
  item_id?: number | null;
  item_code?: string | null;
  item_name?: string | null;
  quantity?: number | string | null;
  requested_quantity?: number | string | null;
  uom_code?: string | null;
  department_name?: string | null;
  office_name?: string | null;
  remarks?: string | null;
  source_type?: string | null;
  source_id?: number | null;

  // Temporary compatibility with a backend process serving the pre-normalized
  // Activity contract. These aliases can be removed after every deployed backend
  // serves the normalized fields above.
  event_at?: string | null;
  transaction_type?: string | null;
  direction?: string | null;
  status?: string | null;
  requested_by_name?: string | null;
  comments?: string | null;
}

export interface AcknowledgmentRow {
  id: number;
  indent_id: number;
  indent_no: string;
  action: string;
  stage_name?: string | null;
  actor_name?: string | null;
  comments?: string | null;
  acted_at: string;
}

export interface IndentNotification {
  id: string;
  indent_id: number;
  indent_no: string;
  title: string;
  message: string;
  status: string;
  created_at: string;
}

export interface PendingApproval {
  instance_id: number;
  doc_type: string;
  doc_id: number;
  stage_sequence: number;
  doc_no?: string | null;
  summary?: string | null;
  requested_by_name?: string | null;
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
  requester?: string | null;
  workflow_status: string;
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

export interface ApprovalDelegation {
  id: number;
  from_employee_id: number;
  from_employee_name?: string | null;
  to_employee_id: number;
  to_employee_name?: string | null;
  doc_type?: string | null;
  valid_from: string;
  valid_to: string;
  reason?: string | null;
  is_active: boolean;
}

export interface IndentCreate {
  required_date?: string | null;
  priority: string;
  remarks?: string | null;
  items: { item_id: number; quantity: number; remarks?: string }[];
}

export interface IndentJourneyStage {
  sequence: number;
  title: string;
  status: "SUBMITTED" | "APPROVED" | "REJECTED" | "PENDING" | "NOT_REQUIRED" | string;
  is_current?: boolean;
  approver_name?: string | null;
  position_name?: string | null;
  timestamp?: string | null;
  comments?: string | null;
  duration_seconds?: number | null;
  stage_type: string;
}

export interface IndentJourneyHistoryEvent {
  id: string;
  event_type: string;
  title: string;
  description?: string | null;
  actor_name?: string | null;
  position_name?: string | null;
  timestamp: string;
  comments?: string | null;
}

export interface IndentJourney {
  indent_id: number;
  indent_no: string;
  status: string;
  requested_by_name?: string | null;
  requested_by_position?: string | null;
  created_at: string;
  current_stage?: string | null;
  current_stage_message: string;
  final_any_one_outcome?: string | null;
  stages: IndentJourneyStage[];
  history: IndentJourneyHistoryEvent[];
}
