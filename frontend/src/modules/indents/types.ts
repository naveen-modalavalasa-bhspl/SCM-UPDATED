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
  event_at: string;
  transaction_type: "RAISED" | "SUBMITTED" | "APPROVED" | "REJECTED" | "RETURNED" | "ACKNOWLEDGED" | string;
  direction?: "INWARD" | "OUTWARD" | null;
  indent_id: number;
  indent_no: string;
  status: string;
  requested_by_name?: string | null;
  department_name?: string | null;
  item_id?: number | null;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  quantity: number;
  actor_name?: string | null;
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
