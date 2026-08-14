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

/**
 * REGULAR is what every indent raised before the field was exposed carries, so it
 * stays part of the union — list and detail screens must render it, not fall through
 * to a blank. It's also the ad-hoc request type; MONTHLY is the recurring one.
 */
export type IndentType = "REGULAR" | "MONTHLY";

export interface Indent {
  id: number;
  indent_no: string;
  /**
   * Optional for the same reason ActivityRow carries its compatibility aliases: a
   * deployed backend that predates the field omits it, and the screens must render
   * rather than break. A current backend always sends it — it defaults to REGULAR.
   */
  indent_type?: IndentType | string;
  indent_date?: string | null;
  required_date?: string | null;
  vehicle_id?: number | null;
  vehicle_number?: string | null;
  requested_by_id?: number | null;
  requested_by_name?: string | null;
  position_id?: number | null;
  position_name?: string | null;
  department_id?: number | null;
  department_name?: string | null;
  office_id?: number | null;
  office_name?: string | null;
  /** Service area code of the delivery office, resolved from HCM when the indent is
   *  served. Null for offices HCM holds no SAC for. */
  office_sac?: string | null;
  /**
   * Region/Location: the HCM location the requester is tagged to, snapshotted when the
   * indent was raised. Read-only everywhere — there is no field for it on
   * IndentCreate/IndentUpdate, and the backend ignores one if it is sent. Null on
   * indents raised before the field existed and on raisers HCM has no location for.
   */
  region_id?: number | null;
  region_name?: string | null;
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
  can_return_for_correction?: boolean;
  can_edit_correction?: boolean;
  can_resubmit_correction?: boolean;
  correction_owner?: {
    employee_id: number;
    employee_name?: string | null;
    position_id?: number | null;
  } | null;
  returned_from_stage?: string | null;
  resubmit_target_stage?: string | null;
  correction_comment?: string | null;
  created_at: string;
  items: IndentItem[];
}

export interface IndentListRow {
  id: number;
  indent_no: string;
  indent_type?: IndentType | string;
  requested_by_name?: string | null;
  department_name?: string | null;
  region_id?: number | null;
  region_name?: string | null;
  status: string;
  priority: string;
  total_items: number;
  current_approver_name?: string | null;
  is_bookmarked: "YES" | "NO" | string;
  created_at: string;
}

/** One Region/Location bucket of the stats breakdown. Null id = no location. */
export interface RegionCount {
  region_id?: number | null;
  region_name?: string | null;
  count: number;
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
  /** Optional: a backend that predates Region omits it, so screens must tolerate that. */
  by_region?: RegionCount[];
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
  region_id?: number | null;
  region_name?: string | null;
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

/** One stage of what physically happened to the goods, after the approval stages. */
export interface FulfilmentStep {
  key: string;
  label: string;
  state: "completed" | "current" | "pending" | string;
  caption?: string | null;
}

/** One line of an indent on the "what am I still owed" screen. */
export interface AcknowledgementLine {
  indent_item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  approved_quantity: number;
  issued_quantity: number;
  dispatched_quantity: number;
  received_quantity: number;
  /** Derived server-side: "On the way to you", "With procurement", … */
  pending_with?: string | null;
}

export interface Acknowledgement {
  indent_id: number;
  indent_no: string;
  indent_date?: string | null;
  required_date?: string | null;
  status: string;
  priority?: string | null;
  project_name?: string | null;
  can_acknowledge: boolean;
  lines: AcknowledgementLine[];
}

/** What arrived in THIS delivery, not the running total. */
export interface AcknowledgeLine {
  indent_item_id: number;
  received_quantity: number;
}

export interface ReceiptAttachment {
  id: number;
  file_name: string;
  file_path: string;
  mime_type?: string | null;
  doc_category?: string | null;
  uploaded_by_name?: string | null;
  created_at?: string | null;
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

// The approval inbox shapes (PendingApproval, ApprovalDecisionRow, TeamQueueRow)
// moved to modules/approvals/types.ts along with the screens that read them.
// Delegation is no longer exposed at all — see modules/approvals/__init__.py.

export interface IndentCreate {
  required_date?: string | null;
  priority: string;
  indent_type?: IndentType;
  vehicle_id?: number | null;
  remarks?: string | null;
  items: { item_id: number; quantity: number; remarks?: string }[];
}

export interface IndentUpdate extends IndentCreate {
  office_id?: number | null;
}

export interface BomChoice {
  id: number;
  code: string;
  name: string;
  project_name?: string | null;
  description?: string | null;
  total_items: number;
  is_active: boolean;
  /** Switched on and inside its optional validity window (masters decides both). */
  is_effective?: boolean;
}

export interface BomChoiceItem {
  id: number;
  bom_id: number;
  line_no: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  category_name?: string | null;
  uom_code?: string | null;
  quantity?: number | null;
}

export interface TemplateLineItem {
  item_id: number;
  item_code: string;
  item_name: string;
  uom_code?: string | null;
  quantity?: number | null;
}

export interface IndentJourneyStage {
  event_id?: string | null;
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
  approval_mode?: string | null;
  reference_no?: string | null;
  quantity_summary?: string | null;
  evidence_source?: string | null;
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
  reference_no?: string | null;
  quantity_summary?: string | null;
}

export interface IndentJourney {
  contract_version?: 5;
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
  phases: IndentJourneyStage[];
  history: IndentJourneyHistoryEvent[];
  missing_sources: string[];
}
