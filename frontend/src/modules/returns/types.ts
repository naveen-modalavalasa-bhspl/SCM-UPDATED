import type { ScopedDoc } from "@/shared/useDocNumberScope";
import type { CombinationValue } from "@/shared/combination";
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
  /** Logistics released the load: the stock has left the branch and is on the road. */
  | "DISPATCHED"
  | "RECEIVED"
  | "REJECTED"
  | "CANCELLED";

/**
 * Which stage is holding it, in the order the document travels: the raiser's approval
 * ladder, the decision desk, the floor's sign-off, then logistics. The first three are
 * all PENDING_APPROVAL and the last spans APPROVED and DISPATCHED, so the status alone
 * can never say which.
 *
 * FIX 2026-09-07: the order was written here as desk → sign-off → ladder. The backend
 * now runs the ladder FIRST for every return (see returns/enums.py
 * `PHASES_APPROVAL_FIRST`), so the comment described a route no new return takes. The
 * union itself is unchanged — the four phases are the same four, only their sequence
 * moved.
 */
export type ReturnPhase = "DECISION" | "ENDORSE" | "FIELD" | "LOGISTICS";

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

export interface ReturnLine extends CombinationValue {
  id: number;
  item_id: number;
  item_code: string | null;
  item_name: string | null;
  uom_code: string | null;
  /** Numeric(16,3) arrives as a JSON string from MySQL via Pydantic. */
  quantity: string | number;
  /** What left the branch on this line, and what the far end has already signed for.
   *  The receipt form asks per line and caps the ask at the first minus the second. */
  dispatched_quantity: string | number;
  received_quantity: string | number;
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

/**
 * The transport request carrying a return. A real `lgs_transport_requests` row worked on
 * the Logistics > Shipments screen — this module only names it, and never drives it.
 */
export interface ReturnTransport {
  transport_request_id: number;
  transport_request_no: string | null;
  leg: string | null;
  leg_label: string | null;
}

/** Why a draft is sitting with the raiser again, and who sent it there. */
export interface ReturnSentBack {
  count: number;
  note: string | null;
  by_name: string | null;
  from_stage: string | null;
}

export interface StockReturn extends ScopedDoc {
  id: number;
  return_no: string;
  status: ReturnStatus;
  phase: ReturnPhase;
  kind: ReturnKind | null;
  kind_label: string | null;
  intent: ReturnIntent | null;
  intent_label: string | null;
  /** The MAIN reason (the one with the most units). */
  reason: string | null;
  /** The words for every reason, joined: "Damaged, Expired". */
  reason_label: string | null;
  /** Every reason with how many units it covers (2026-11-07). Empty on a return raised
   *  from an acknowledgement until somebody has been asked why. */
  reasons: ReturnReasonRow[];
  reason_note: string | null;
  /** The indent this return answers. Null on one raised on its own — and that is what
   *  decides which approval chain the return travels. */
  indent_id: number | null;
  indent_no: string | null;

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
  /**
   * Handing the whole document back to the raiser to correct. True only for whoever is
   * actually holding it, at any of the three approval stages — computed from the live
   * workflow task, never from a permission.
   */
  can_send_back: boolean;
  can_acknowledge: boolean;
  /** ADDED 2026-09-10. True while that acknowledgement is still a receipt: the press
   *  credits the receiving point's stock balance and raises the purchase return. False
   *  once the material has landed, where the same press only closes the document. */
  can_receive: boolean;
  can_withdraw: boolean;
  can_approve_logistics: boolean;
  /**
   * Whether the paper trail behind the MATERIAL may be read — the other modules'
   * documents under the item, never this document. `return.decide`, the decision desk's
   * own code, and served on the single-document read only.
   *
   * Asked rather than guessed: `GET /related-documents` is gated on the same code, so a
   * screen that renders the section for everyone collects a 403 for most of the people
   * who open a return, and an error panel reads as a broken screen rather than a private
   * one. Optional so a payload from a backend older than this reads as false.
   */
  can_view_trail?: boolean;

  /** STORE or SUPPLIER. Null until a decision chose an outcome that travels. */
  leg: string | null;
  leg_label: string | null;
  /** The shipment carrying it. Null until the final approval raises one. */
  transport: ReturnTransport | null;
  /** Set on a draft a desk handed back. Null on one that has never been out. */
  sent_back: ReturnSentBack | null;
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
  dispatched: number;
  acknowledged: number;
  rejected: number;
  cancelled: number;
  total: number;
  by_status: Record<string, number>;

  /** Each stage's own backlog. The first three are all PENDING_APPROVAL, so one status
   *  count cannot separate them and whichever stage is behind stays invisible. */
  awaiting_decision: number;
  awaiting_endorsement: number;
  awaiting_approval: number;
  /** Signed off and waiting on a vehicle, and already on one. Neither is an approval
   *  backlog — they are what is on the yard and what is on the road. */
  awaiting_dispatch: number;
  in_transit: number;
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

/** A value/label pair served by the API. Never assembled in a screen. */
export interface ServedOption {
  value: string;
  label: string;
  hint?: string | null;
}

/** A point the material could go to, and how much of it that point already holds. */
export interface DestinationOption {
  warehouse_id: number;
  warehouse_name: string | null;
  warehouse_code: string | null;
  warehouse_type: string | null;
  tier_label: string | null;
  on_hand: string | number;
  /** The row the picker pre-fills. */
  is_default: boolean;
  /**
   * This is the point the material CAME from, resolved off the paper trail — as against
   * merely being the pre-filled row. Separate so a fallback default is not labelled as
   * a resolved one.
   */
  is_originating: boolean;
}

/** Where the material a purchase return sends back came from. */
export type PurchaseReturnSource =
  | "FROM_WAREHOUSE" | "FROM_LIP_MDB" | "QC_REJECTED_GRN";

/** Whose vehicle carries the load: ours, or the vendor collects. */
export type VehicleArrangement = "OWN_VEHICLE" | "VENDOR_PICKUP";

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
  /** Where the material came from, and which document said so. Pre-fills the picker. */
  originating_warehouse_id: number | null;
  originating_warehouse_name: string | null;
  originating_source_doc: string | null;
  originating_is_resolved: boolean;
  /** Where the stock stands today. Never offered as a destination. */
  current_warehouse_id: number | null;
  current_warehouse_name: string | null;
  /** The four standard methods, from logistics' own rules. */
  logistics_modes: ServedOption[];
  vehicle_options: ServedOption[];
  default_logistics_mode: string | null;
  default_vehicle_type: string | null;
  /** What the resulting purchase return will be filed under, shown before the press. */
  purchase_return_category: PurchaseReturnSource | null;
  purchase_return_category_label: string | null;
  /**
   * The rung actually resolved for THIS document, in a SERVED sentence.
   *
   * The category is a coarse three-way filter over a chain of THREE rungs — warehouse,
   * MDP, LIP — so it cannot name the point on its own, and for years it named it wrong:
   * "From LIP / MDB" for a bucket holding only LIP returns, "From warehouse" for the
   * bucket holding every MDP one. This says which point the material really came off,
   * in the same words the stock screens use.
   */
  purchase_return_source_detail: string | null;
  /** WAREHOUSE | MDP | LIP — the resolved rung, for a screen that needs the code. */
  purchase_return_source_tier: string | null;
  /** False when no warehouse row answered: the category is then a fallback, not a fact. */
  purchase_return_source_resolved: boolean;
  qc_rejected_tag: boolean;
}

export interface DecisionWrite {
  disposition: Disposition;
  note: string;
  to_warehouse_id?: number | null;
  vendor_id?: number | null;
  disposal_agency?: string | null;
  logistics_mode?: string | null;
  vehicle_type?: string | null;
}

export interface RelatedDocument {
  doc_type: string;
  /** What this kind of document is CALLED, served with the row (`enums.TRAIL_LABELS`).
   *  A type this screen has never heard of still renders with its real name. */
  doc_label?: string | null;
  /** Which leg of the material's life this row is read under (`enums.TRAIL_CHAPTERS`).
   *  Served, like `doc_label`, so the screen groups by a key it was given rather than by
   *  a second copy of the doc-type-to-chapter map. Null on a type the server could not
   *  place, which the trail draws under its own heading at the end. */
  chapter?: string | null;
  doc_id: number | null;
  doc_no: string | null;
  status: string | null;
  date: string | null;
  vendor_name: string | null;
  warehouse_name: string | null;
  /** The one-line qualifier that makes a row worth opening: who signed the allocation,
   *  the vendor's invoice number, the lot the stock stood in, the LR of the truck. */
  note?: string | null;
  extra?: Record<string, unknown> | null;
}

/** One leg of the material's life, served with the trail (`enums.TRAIL_CHAPTERS`). */
export interface TrailChapter {
  key: string;
  label: string;
  /** The question this leg answers, in the words the served payload uses. Never
   *  composed here — the same chapter is named by this screen and by the payload, and
   *  two copies of that wording is how one of them goes stale. */
  caption: string;
  count: number;
}

export interface RelatedDocuments {
  return_id: number;
  return_no: string | null;
  /** Where the material came from, resolved from the trail. Pre-fills the picker. */
  originating_warehouse_id: number | null;
  originating_warehouse_name: string | null;
  /** Which document answered, or null when this is the addressed-to fallback. */
  originating_source_doc: string | null;
  originating_is_resolved: boolean;
  /** Where the stock physically stands today. A different fact, never a destination. */
  current_warehouse_id: number | null;
  current_warehouse_name: string | null;
  material_issue_no: string | null;
  material_issue_id: number | null;
  intent: string | null;
  intent_label: string | null;
  items: {
    item_id: number;
    item_code: string | null;
    item_name: string | null;
    quantity: string;
    uom_code?: string | null;
  }[];
  documents: RelatedDocument[];
  /** The legs of the material's life, in the order the work happens — EVERY one of
   *  them, including the ones nothing landed in. A `count` of 0 is a fact about this
   *  material ("never bought — it came off stock already on the shelf") and only a
   *  heading that is present can say so. Optional: an older payload sends none, and the
   *  screen then falls back to one flat list. */
  chapters?: TrailChapter[];
  /** Set only when a kind of document hit the per-kind cap. Null — the normal case —
   *  means the list above is the whole trail. */
  documents_note: string | null;
  purchase_return_category: PurchaseReturnSource | null;
  purchase_return_category_label: string | null;
  /**
   * The rung actually resolved for THIS document, in a SERVED sentence.
   *
   * The category is a coarse three-way filter over a chain of THREE rungs — warehouse,
   * MDP, LIP — so it cannot name the point on its own, and for years it named it wrong:
   * "From LIP / MDB" for a bucket holding only LIP returns, "From warehouse" for the
   * bucket holding every MDP one. This says which point the material really came off,
   * in the same words the stock screens use.
   */
  purchase_return_source_detail: string | null;
  /** WAREHOUSE | MDP | LIP — the resolved rung, for a screen that needs the code. */
  purchase_return_source_tier: string | null;
  /** False when no warehouse row answered: the category is then a fallback, not a fact. */
  purchase_return_source_resolved: boolean;
  qc_rejected_tag: boolean;
  vehicle_options: ServedOption[];
  vehicle_type: VehicleArrangement | null;
  logistics_mode: string | null;
  /** The warehouse-side document the gate-out raised, once the load has left. */
  warehouse_return_no: string | null;
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
  /**
   * Where the material came from. Null on every row raised before 2026-09-08 and on
   * ones raised by hand at the warehouse — render that as "not stated", not as a
   * fourth category.
   */
  source_category: PurchaseReturnSource | null;
  source_category_label: string | null;
  /**
   * True where the GRN / PO / vendor above were READ off the purchase behind the stock
   * rather than stored on the document — every return raised automatically off a branch
   * consignment stores none of them. Marked on the row, never presented as recorded.
   */
  chain_traced?: boolean;
  /** The branch stock return that produced this one, where one did. */
  source_return_id: number | null;
  source_return_no: string | null;
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

/**
 * One STEP of the return's journey: a rung that signed, or one still owed a decision.
 *
 * `stage_type` is the leg it belongs to — draft, submission, decision, sign_off,
 * approval, logistics, movement, acknowledgement — and the journey screen groups the
 * timeline by it. Served, never derived in the browser: a second copy of the flow here is
 * how a rejected document ends up rendering as though the stock moved.
 */
export interface ReturnJourneyStage {
  event_id: string | null;
  sequence: number;
  title: string;
  status: string;
  is_current: boolean;
  approver_name: string | null;
  position_name: string | null;
  timestamp: string | null;
  comments: string | null;
  duration_seconds?: number | null;
  stage_type: string;
  reference_no: string | null;
  quantity_summary: string | null;
}

/** One press on the return, off the immutable audit rows. Append-only. */
export interface ReturnJourneyHistoryEvent {
  id: string;
  event_type: string;
  title: string;
  description: string | null;
  actor_name: string | null;
  position_name: string | null;
  timestamp: string | null;
  comments: string | null;
  reference_no: string | null;
  quantity_summary?: string | null;
}

/**
 * The tracker, built server-side so it can never disagree with the status guards.
 *
 * `phases` is the eight dots on the document; `stages` and `history` are the same journey
 * at step level, which `/returns/:id/journey` draws. Every one of them describes THIS
 * return — `indent_no` is the request it answers and is a reference only, never a source
 * of steps: the indent has its own journey screen.
 */
export interface ReturnJourney {
  return_id?: number | null;
  return_no?: string | null;
  status: string;
  indent_id?: number | null;
  indent_no?: string | null;
  raised_by_name?: string | null;
  raised_by_position?: string | null;
  created_at?: string | null;
  phases: JourneyPhase[];
  current_sequence: number;
  current_stage_message: string | null;
  stages?: ReturnJourneyStage[];
  history?: ReturnJourneyHistoryEvent[];
}

/** One returnable row: an item the signed-in raiser is actually holding. */
export interface MyStockRow extends CombinationValue {
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

export interface ReturnLineWrite extends CombinationValue {
  /** Typed in an Issue container (screen only): which level, how many. */
  packLevel?: number;
  packCount?: number | "";
  item_id: number;
  quantity: string;
  remarks?: string | null;
}

/** One indent a return may be raised against — the raiser's own, past approval. */
export interface IndentOption extends ScopedDoc {
  id: number;
  indent_no: string;
  indent_date: string | null;
  status: string;
  total_items: number;
  /**
   * How many of this indent's items are still on the raiser's shelf and could be sent
   * back. SERVED (`returnable_indents`), never derived here from `total_items` — the gap
   * between the two is exactly what the picker has to say. The list itself only ever
   * carries indents where this is at least 1, so an indent whose items have all already
   * come back is not offered at all.
   */
  returnable_items: number;
  total_qty: string | number;
  project_name: string | null;
  position_name: string | null;
}

/**
 * One rung of a resolved approval chain, and where the document has reached on it.
 *
 * `state` is the SAME five-word vocabulary the journey tracker uses (`JourneyState`), and
 * it is served: read off the press made on the rung and off the instance's current
 * sequence. Nothing here is derived in the browser from the document's status — a second
 * copy of the flow in the screen is how a rejected document draws as though it were live.
 */
export interface ApprovalFlowStep {
  sequence: number;
  name: string;
  position_name: string | null;
  role_name: string | null;
  approver_names: string[];
  state: JourneyState;
  caption: string | null;
  /** Who pressed it — not always one of `approver_names`, since a delegate may sign. */
  actor_name: string | null;
  acted_at: string | null;
}

/**
 * The approval a return will follow, resolved by the workflow engine rather than
 * described. A linked indent uses the Indent Return ladder, filtered to rungs that
 * existed on the original indent's actual approval path.
 */
export interface ApprovalFlow {
  indent_id: number | null;
  indent_no: string | null;
  /** Always STOCK_RETURN; linked indents affect the resolution context. */
  doc_type: string;
  /** False means nothing is configured for this scope at all — different from a chain
   *  configured to need no signature, which is `is_configured` with no steps. */
  is_configured: boolean;
  /** True once the chain has actually started: the steps are then the document's own
   *  frozen chain and their states are facts rather than a forecast. */
  is_live: boolean;
  /** The rung the document is sitting on, for the "Stage N of M" line. */
  current_sequence: number | null;
  current_stage_message: string | null;
  steps: ApprovalFlowStep[];
  note: string | null;
}

export interface ReturnReasonRow {
  reason: string;
  reason_label?: string | null;
  quantity: string | number;
  note?: string | null;
}

export interface ReturnWrite {
  /** The number card's selection (2026-11-12) — `docNumberPayload`. Against an indent
   *  that carries an organisation the server copies the indent's instead. */
  organization_id?: number | null;
  project_id?: number | null;
  org_department_id?: number | null;
  fiscal_year?: string | null;
  /** Shorthand for "all of it, for this reason"; the form sends `reasons` instead. */
  reason?: string | null;
  /** Why it is going back, by quantity. Must add up to the quantity returned. */
  reasons?: { reason: string; quantity: string; note: string | null }[];
  reason_note?: string | null;
  to_warehouse_id?: number | null;
  /** The indent this return answers. Sending it resolves the Indent Return approval
   *  flow and filters it against that indent's actual approval path. */
  indent_id?: number | null;
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

/**
 * The delivery evidence taken at the FAR END of the leg. Matches
 * `service.RECEIPT_PHOTO_CATEGORY` / `RECEIPT_BILL_CATEGORY`.
 *
 * Not `PHOTO_CATEGORY`: those are the branch's pictures of what it was sending, frozen at
 * submit because they are what the decision desk decided from. These are what came off the
 * truck a week later, and the receipt is refused without at least one of them.
 */
export const RECEIPT_PHOTO_CATEGORY = "RETURN_RECEIPT_PHOTO";
export const RECEIPT_BILL_CATEGORY = "RETURN_RECEIPT_BILL";

/** One line of a return, and how much of it turned up. */
export interface ReceiptLineWrite {
  line_id: number;
  received_quantity: number;
}

/** What the far end says about the material it is signing for. */
export interface ReturnReceiptWrite {
  lines?: ReceiptLineWrite[];
  /** GOOD or DAMAGED. A shortage is stated by the quantities, never by a third value. */
  condition?: "GOOD" | "DAMAGED";
  remarks?: string;
}
