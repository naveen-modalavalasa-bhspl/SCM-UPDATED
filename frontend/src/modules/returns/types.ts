/** Returns — types mirror the backend schemas field for field. Backend names win. */

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

export type ReturnStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "RECEIVED"
  | "REJECTED"
  | "CANCELLED";

/** Which desk is holding it. Both of the last two are PENDING_APPROVAL, so the status
 *  alone cannot say which. */
export type ReturnPhase = "FIELD" | "DECISION" | "ENDORSE";

export type ReturnKind = "FIELD" | "PURCHASE";

export type ReturnIntent = "REPLACEMENT" | "RETURN";

/** The six outcomes the decision desk picks between. */
export type Disposition =
  | "SEND_TO_POINT"
  | "TO_VENDOR"
  | "USE_AT_SOURCE"
  | "SCRAP"
  | "CONTROLLED_DISPOSAL"
  | "REJECT_UNECONOMIC";

export interface ReturnLine {
  id: number;
  item_id: number;
  item_code: string | null;
  item_name: string | null;
  uom_code: string | null;
  /** Numeric(16,3) arrives as a JSON string from MySQL via Pydantic. */
  quantity: string | number;
  remarks: string | null;
  /** Handling features this item's category carries. Anything with one is refused the
   *  plain Scrap route — the guard is in the service, not only on the screen. */
  hazard_features: string[];
}

/** What the desk decided, and what the material was worth when they decided it. */
export interface ReturnDecision {
  disposition: Disposition;
  disposition_label: string | null;
  note: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  vendor_id: number | null;
  vendor_name: string | null;
  disposal_agency: string | null;
  /** null where nothing on the return has a cost recorded. Print an em dash, never ₹0. */
  value: string | number | null;
  objections: number;
}

export interface StockReturn {
  id: number;
  return_no: string;
  status: ReturnStatus;
  phase: ReturnPhase;
  kind: ReturnKind | null;
  kind_label: string | null;
  intent: ReturnIntent | null;
  intent_label: string | null;
  reason: string | null;
  reason_label: string | null;
  reason_note: string | null;

  /** null when not one line could be costed. Every screen renders that as "—". */
  value: string | number | null;
  is_costed: boolean;
  decision: ReturnDecision | null;
  hazard_features: string[];

  from_warehouse_id: number | null;
  from_warehouse_name: string | null;
  to_warehouse_id: number | null;
  to_warehouse_name: string | null;

  raised_by_id: number | null;
  raised_by_name: string | null;
  raised_by_code: string | null;
  office_name: string | null;

  total_qty: string | number;
  total_items: number;

  current_approver_name: string | null;
  can_edit: boolean;
  can_submit: boolean;
  can_act: boolean;
  /** Choosing where the material goes. Not the same act as approving. */
  can_decide: boolean;
  /** Agreeing with that choice, or sending it back for another one. */
  can_endorse: boolean;
  can_acknowledge: boolean;
  can_withdraw: boolean;
  /** A controlled disposal cannot close on the agency's name alone — the licensed
   *  agency's certificate has to be on the document. False on everything else. */
  needs_certificate: boolean;
  has_certificate: boolean;
  can_attach_certificate: boolean;

  created_at: string | null;
  updated_at: string | null;
  approved_at: string | null;
  received_at: string | null;

  items: ReturnLine[];
}

export interface TopRow {
  label: string;
  count: number;
}

export interface ReturnSummary {
  draft: number;
  pending_approval: number;
  approved: number;
  acknowledged: number;
  rejected: number;
  cancelled: number;
  total: number;
  by_status: Record<string, number>;

  /** The two desks' backlogs. Both are PENDING_APPROVAL, so one status count cannot
   *  separate them and the desk that is behind stays invisible. */
  awaiting_decision: number;
  awaiting_endorsement: number;
  written_off: number;
  refused_uneconomic: number;
  oldest_waiting_days: number | null;
  top_reasons: TopRow[];
  top_branches: TopRow[];
}

/** One of the six outcomes, as the decision desk sees it. */
export interface DispositionOption {
  value: Disposition;
  label: string;
  hint: string;
  needs_destination: boolean;
  needs_vendor: boolean;
  needs_agency: boolean;
  moves_stock: boolean;
  /** Refused for THIS return — scrapping something flagged as affecting handling. */
  is_blocked: boolean;
  blocked_reason: string | null;
  /** Pre-selected from the reason. Always overridable. */
  is_default: boolean;
}

/** A point the material could go to, and how much of it that point already holds. */
export interface DestinationOption {
  warehouse_id: number;
  warehouse_name: string | null;
  warehouse_code: string | null;
  warehouse_type: string | null;
  tier_label: string | null;
  on_hand: string | number;
  is_default: boolean;
}

export interface VendorOption {
  id: number;
  name: string | null;
  code: string | null;
}

/** Everything the decision desk needs on one screen, computed server-side. */
export interface DecisionOptions {
  dispositions: DispositionOption[];
  default_disposition: Disposition | null;
  destinations: DestinationOption[];
  vendors: VendorOption[];
  hazard_features: string[];
  value: string | number | null;
  intent: ReturnIntent | null;
  intent_label: string | null;
}

export interface DecisionWrite {
  disposition: Disposition;
  note: string;
  to_warehouse_id?: number | null;
  vendor_id?: number | null;
  disposal_agency?: string | null;
}

/** A row of `pro_returns` — the other family of return. Read only here. */
export interface PurchaseReturn {
  id: number;
  return_no: string;
  status: string;
  kind: "PURCHASE";
  kind_label: string;
  return_date: string | null;
  po_id: number | null;
  po_no: string | null;
  grn_id: number | null;
  grn_no: string | null;
  vendor_id: number | null;
  vendor_name: string | null;
  warehouse_id: number | null;
  warehouse_name: string | null;
  reason: string | null;
  total_items: number;
  total_qty: string | number;
  total_value: string | number;
  credit_note_no: string | null;
  created_by_name: string | null;
  created_at: string | null;
}

export type JourneyState =
  | "completed" | "current" | "pending" | "rejected" | "cancelled";

export interface JourneyPhase {
  key: string;
  label: string;
  sequence: number;
  state: JourneyState;
  caption: string | null;
}

/** The tracker, built server-side so it can never disagree with the status guards. */
export interface ReturnJourney {
  status: string;
  phases: JourneyPhase[];
  current_sequence: number;
  current_stage_message: string | null;
}

/** One returnable row: an item the signed-in raiser is actually holding. */
export interface MyStockRow {
  item_id: number;
  item_code: string | null;
  item_name: string | null;
  uom_code: string | null;
  available_qty: string | number;
  warehouse_id: number;
  warehouse_name: string | null;
  expiry_date: string | null;
  batch_no: string | null;
}

/** Derived server-side and shown read-only — the raiser cannot claim another office. */
export interface Raiser {
  employee_id: number | null;
  employee_code: string | null;
  employee_name: string | null;
  position_name: string | null;
  office_name: string | null;
  from_warehouse_id: number | null;
  from_warehouse_name: string | null;
  to_warehouse_id: number | null;
  to_warehouse_name: string | null;
  /** Why there is no destination, when there is none. */
  destination_note: string | null;
}

export interface Reason {
  value: string;
  label: string;
}

export interface Holder {
  id: number;
  name: string | null;
  code: string | null;
}

/** One post the receiving ladder can be built from. */
export interface PositionOption {
  id: number;
  name: string | null;
  role_name: string | null;
  holders: Holder[];
}

export interface ReceivingStep {
  sequence: number;
  position_id: number;
  name: string | null;
  holders: Holder[];
  is_dead: boolean;
}

/** Who looks at a return once its reporting line has signed. */
export interface ReceivingConfig {
  version: number;
  is_configured: boolean;
  in_flight: number;
  steps: ReceivingStep[];
  warnings: string[];
}

export interface ReturnLineWrite {
  item_id: number;
  quantity: string;
  remarks?: string | null;
}

export interface ReturnWrite {
  reason: string;
  reason_note?: string | null;
  to_warehouse_id?: number | null;
  /** Everything this screen raises comes off a branch shelf. Sent so the register never
   *  has to infer which family a row belongs to. */
  kind?: ReturnKind;
  /** Whether the branch still needs the material. What the decision desk weighs. */
  intent?: ReturnIntent;
  items: ReturnLineWrite[];
}

export interface ApprovalTrailRow {
  stage_sequence: number | null;
  stage_name: string | null;
  actor_name: string | null;
  actor_position: string | null;
  action: string;
  comments: string | null;
  acted_at: string | null;
}

export interface ReturnAttachment {
  id: number;
  file_name: string;
  file_size: number | null;
  mime_type: string | null;
  doc_category: string | null;
  uploaded_by_name: string | null;
  created_at: string | null;
}

/**
 * A file picked before the return has an id. `sys_attachments` is keyed by document id,
 * so on a brand new return the bytes are held in the browser and posted the instant the
 * draft exists — the raiser photographs the stock while standing at it, not afterwards.
 */
export interface StagedAttachment {
  key: string;
  file: File;
  category: string;
}

/** Matches service.PHOTO_CATEGORY / DOCUMENT_CATEGORY / CERTIFICATE_CATEGORY. */
export const PHOTO_CATEGORY = "RETURN_PHOTO";
export const DOCUMENT_CATEGORY = "RETURN_DOCUMENT";
/** The licensed agency's proof that regulated material was actually destroyed. Its own
 *  category because the close is gated on it — an inward bill is not that. */
export const CERTIFICATE_CATEGORY = "RETURN_DISPOSAL_CERTIFICATE";
