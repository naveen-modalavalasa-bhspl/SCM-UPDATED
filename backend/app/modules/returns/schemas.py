"""Request/response shapes for Returns."""
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, field_serializer, field_validator

# Journey timestamps go out with their `+05:30` offset, the way the indent journey
# serves its own: MySQL stores naive IST, and a naive value stamped `Z` renders 5h30
# early in every browser. See `app/shared/time.py`.
from app.shared.time import iso as ist_iso

from .enums import Disposition, ReturnIntent, ReturnKind, ReturnReason
from app.shared.limits import (  # request-size guards, see the module
    MAX_DOCUMENT_LINES,
)
from app.shared.masters.combinations import CombinationIn, CombinationOut


class ReturnLineIn(CombinationIn):
    item_id: int
    quantity: Decimal = Field(gt=0)
    remarks: str | None = None

    @field_validator("quantity")
    @classmethod
    def _sane(cls, value: Decimal) -> Decimal:
        # The column is Numeric(16, 3); anything finer is silently rounded on the way
        # in, so a line saved as 1.0004 came back as 1.000 and the returner was told
        # they had sent a quantity they never typed.
        if value != value.quantize(Decimal("0.001")):
            raise ValueError("Quantity cannot be finer than three decimal places")
        return value


class ReturnWrite(BaseModel):
    """What the raiser fills in. Source, destination, and the whole identity block are
    derived server-side — see `service._raiser_context`. A browser cannot claim to be
    returning somebody else's stock from somebody else's office."""

    reason: ReturnReason
    reason_note: str | None = Field(default=None, max_length=500)
    to_warehouse_id: int | None = None
    # ADDED 2026-09-07 — the indent this return answers. Optional: a return raised on its
    # own keeps the behaviour it has always had. Naming one resolves the Indent Return
    # approval flow and then keeps only rungs that existed on that indent's actual
    # approval path.
    indent_id: int | None = None
    # Everything this module writes comes off a branch shelf, so FIELD is the default and
    # the field is here to be recorded rather than chosen — a purchase return is
    # `pro_returns`, raised in the warehouse module off a rejected GRN line.
    kind: ReturnKind = ReturnKind.FIELD
    # Whether the branch still needs the material. Changes nothing about how the stock
    # moves and everything about what the decision desk decides.
    intent: ReturnIntent = ReturnIntent.RETURN
    items: list[ReturnLineIn] = Field(min_length=1, max_length=MAX_DOCUMENT_LINES)

    @field_validator("reason_note")
    @classmethod
    def _trim(cls, value: str | None) -> str | None:
        return (value or "").strip() or None


class ActionIn(BaseModel):
    comments: str = ""


class DecisionIn(BaseModel):
    """What the decision desk records: where the material goes, and why.

    The extra fields are conditional on the disposition and are validated in the service
    (`service.decide`), not here — which of them is required depends on the chosen outcome,
    and the hazard guard needs the document's items to answer at all.
    """

    disposition: Disposition
    note: str = Field(min_length=1, max_length=1000)
    # SEND_TO_POINT only.
    to_warehouse_id: int | None = None
    # TO_VENDOR only.
    vendor_id: int | None = None
    # CONTROLLED_DISPOSAL only.
    disposal_agency: str | None = Field(default=None, max_length=200)
    # Logistics leg - four standard methods reused from logistics/transport (DIRECT, COURIER, OWN_VEHICLE, THIRD_PARTY)
    logistics_mode: str | None = Field(default=None, max_length=30)
    # How the return travels: own vehicle vs vendor pickup (maps to OWN_VEHICLE vs THIRD_PARTY/vendor_arranged)
    vehicle_type: str | None = Field(default=None, max_length=30)

    @field_validator("note")
    @classmethod
    def _reason_is_real(cls, value: str) -> str:
        # Whitespace passes min_length but says nothing, and the floor is about to read it.
        text = (value or "").strip()
        if not text:
            raise ValueError("Say why you are sending it this way")
        return text

    @field_validator("disposal_agency")
    @classmethod
    def _trim(cls, value: str | None) -> str | None:
        return (value or "").strip() or None


class ObjectionIn(BaseModel):
    """The floor sending a decision back. The reason is the whole point of the action."""

    comments: str = Field(min_length=1, max_length=1000)


class SendBackIn(BaseModel):
    """A desk handing the whole document back to the raiser to correct.

    The note is mandatory and it is not a formality: the return drops to DRAFT with its
    decision cleared and its approvals abandoned, and this sentence is the only thing the
    raiser is given to work out what to change.
    """

    comments: str = Field(min_length=1, max_length=1000)


class ReceiptLineIn(BaseModel):
    """One line of a return, and how much of it arrived."""

    line_id: int
    #: What turned up on THIS line, never the running total. Capped server-side at what
    #: was dispatched on it (`_receipt_lines`).
    received_quantity: float = Field(gt=0)


class AcknowledgeIn(BaseModel):
    """What the far end says about the material it is signing for.

    Every field is optional and an EMPTY body is the whole of the older contract: no
    lines means the load arrived as it was sent, and no condition means it arrived in
    good order. That is what keeps the raiser's plain close — which moves nothing and
    has no delivery to describe — a single press.
    """

    lines: list[ReceiptLineIn] = Field(default_factory=list,
                                       max_length=MAX_DOCUMENT_LINES)
    #: GOOD or DAMAGED. Not SHORT — the quantities above already say that, and the
    #: service derives it from them (`service.ACK_CONDITIONS`).
    condition: str | None = None
    #: Required when anything is wrong with it; it is what the claim is worked from.
    remarks: str | None = None


class RejectIn(BaseModel):
    """A desk refusing the return outright. Ends the document, so it has to say why."""

    comments: str = Field(min_length=1, max_length=1000)


class TransportRefOut(BaseModel):
    """The shipment carrying this return. None until the final approval raises one."""

    transport_request_id: int
    transport_request_no: str | None = None
    # STORE or SUPPLIER — which of the two journeys the decision put it on.
    leg: str | None = None
    leg_label: str | None = None


class SentBackOut(BaseModel):
    """Why this draft is sitting with the raiser again."""

    count: int = 0
    note: str | None = None
    by_name: str | None = None
    from_stage: str | None = None


class ReturnLineOut(CombinationOut):
    model_config = ConfigDict(from_attributes=True)

    id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    quantity: Decimal
    # What left the branch on this line, and what the far end has signed for. The receipt
    # form asks for a quantity per line and caps it at the first minus the second, so both
    # are served rather than inferred from the document's status.
    dispatched_quantity: Decimal = Decimal("0")
    received_quantity: Decimal = Decimal("0")
    remarks: str | None = None
    # The handling features this item's category carries — derived, never stored. Anything
    # with one is refused the plain Scrap route.
    hazard_features: list[str] = []


class DecisionOut(BaseModel):
    """What the desk decided, and what it was worth when they decided it."""

    disposition: str
    disposition_label: str | None = None
    note: str | None = None
    decided_by_name: str | None = None
    decided_at: str | None = None
    vendor_id: int | None = None
    vendor_name: str | None = None
    disposal_agency: str | None = None
    # Snapshotted at decision time. None where nothing on the return has a cost recorded —
    # the screens print an em dash for that and never a zero.
    value: Decimal | None = None
    # How many times the floor has sent a decision back on this return.
    objections: int = 0


class ReturnOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    return_no: str
    status: str
    # DECISION, ENDORSE, FIELD or LOGISTICS — which stage is holding it, in that order.
    # The first three are all PENDING_APPROVAL so the status alone cannot separate them,
    # and LOGISTICS spans APPROVED and DISPATCHED for the same reason.
    phase: str = "FIELD"
    kind: str | None = None
    kind_label: str | None = None
    intent: str | None = None
    intent_label: str | None = None
    reason: str | None = None
    reason_label: str | None = None
    reason_note: str | None = None
    # The request this return answers. None on a return raised on its own — which is every
    # return raised before 2026-09-07, and those keep their own approval chain.
    indent_id: int | None = None
    indent_no: str | None = None

    # None means nothing on this return has a cost recorded anywhere.
    value: Decimal | None = None
    is_costed: bool = False
    decision: DecisionOut | None = None
    hazard_features: list[str] = []

    from_warehouse_id: int | None = None
    from_warehouse_name: str | None = None
    to_warehouse_id: int | None = None
    to_warehouse_name: str | None = None

    raised_by_id: int | None = None
    raised_by_name: str | None = None
    raised_by_code: str | None = None
    office_name: str | None = None

    total_qty: Decimal = Decimal("0")
    total_items: int = 0

    current_approver_name: str | None = None
    can_edit: bool = False
    can_submit: bool = False
    can_act: bool = False
    # Choosing where the material goes. Not the same act as approving, so not the same flag.
    can_decide: bool = False
    # Agreeing with that choice, or sending it back for another one.
    can_endorse: bool = False
    # Handing the whole document back to the raiser. True only for whoever is actually
    # holding it, at any of the three approval stages.
    can_send_back: bool = False
    can_acknowledge: bool = False
    # ADDED 2026-09-10. True while that acknowledgement is still a RECEIPT — the material
    # is on its leg, and the press credits the receiving point's stock balance and raises
    # the purchase return. False once it has landed, where the same press only closes the
    # document.
    can_receive: bool = False
    can_withdraw: bool = False
    can_approve_logistics: bool = False
    # Whether the paper trail behind the MATERIAL may be read — the other modules'
    # documents under the item, not this document. `return.decide`, served on the
    # single-document read only. Default False, so a payload built by anything that does
    # not set it leaves the section out rather than drawing it for everybody.
    can_view_trail: bool = False

    # STORE or SUPPLIER, and the shipment carrying it. All three are None until the
    # decision desk has chosen an outcome that travels.
    leg: str | None = None
    leg_label: str | None = None
    transport: TransportRefOut | None = None
    # Set on a draft that a desk handed back. None on one that has never been out.
    sent_back: SentBackOut | None = None
    # A controlled disposal cannot close on the agency's name alone. False on everything
    # that is not one.
    needs_certificate: bool = False
    has_certificate: bool = False
    can_attach_certificate: bool = False

    created_at: datetime | None = None
    updated_at: datetime | None = None
    approved_at: datetime | None = None
    received_at: datetime | None = None

    items: list[ReturnLineOut] = []
    can_approve_logistics: bool = False


class TopRowOut(BaseModel):
    label: str
    count: int


class SummaryOut(BaseModel):
    """The KPI tiles. Counted over the same scope the grid uses, so the tiles and the
    grid can never disagree."""

    draft: int = 0
    pending_approval: int = 0
    approved: int = 0
    dispatched: int = 0
    acknowledged: int = 0
    rejected: int = 0
    cancelled: int = 0
    total: int = 0
    by_status: dict[str, int] = {}

    # Each stage's own backlog. The first three are all PENDING_APPROVAL, so one status
    # count cannot separate them and whichever stage is behind stays invisible.
    awaiting_decision: int = 0
    awaiting_endorsement: int = 0
    awaiting_approval: int = 0
    # Signed off and waiting on a vehicle, and already on one. Neither is an approval
    # backlog — they are what is sitting on the yard and what is on the road.
    awaiting_dispatch: int = 0
    in_transit: int = 0
    written_off: int = 0
    refused_uneconomic: int = 0
    # Whole days the longest-waiting return has been sitting at a desk, or None when
    # nothing is waiting.
    oldest_waiting_days: int | None = None
    top_reasons: list[TopRowOut] = []
    top_branches: list[TopRowOut] = []


class DispositionOptionOut(BaseModel):
    """One of the six outcomes, as the decision desk sees it."""

    value: str
    label: str
    hint: str
    needs_destination: bool = False
    needs_vendor: bool = False
    needs_agency: bool = False
    moves_stock: bool = True
    # Refused for THIS return — scrapping something the masters flag as affecting
    # handling. Blocked in the service too; this only stops the button being offered.
    is_blocked: bool = False
    blocked_reason: str | None = None
    # Pre-selected from the reason. The desk confirms a default rather than inventing an
    # answer from a blank form, and can always override it.
    is_default: bool = False


class OptionOut(BaseModel):
    """A served value/label pair. The screen renders it and never invents one."""

    value: str
    label: str
    hint: str | None = None


class DestinationOptionOut(BaseModel):
    """A point the material could go to, and how much of it that point already holds."""

    warehouse_id: int
    warehouse_name: str | None = None
    warehouse_code: str | None = None
    warehouse_type: str | None = None
    tier_label: str | None = None
    on_hand: Decimal = Decimal("0")
    is_default: bool = False
    #: This is the point the material came from, resolved off the paper trail — as
    #: against merely being the pre-filled row. Said separately so a fallback default is
    #: not labelled as a resolved one.
    is_originating: bool = False


class VendorOptionOut(BaseModel):
    id: int
    name: str | None = None
    code: str | None = None


class DecisionOptionsOut(BaseModel):
    """Everything the decision desk needs on one screen, computed server-side."""

    dispositions: list[DispositionOptionOut] = []
    default_disposition: str | None = None
    destinations: list[DestinationOptionOut] = []
    vendors: list[VendorOptionOut] = []
    hazard_features: list[str] = []
    value: Decimal | None = None
    intent: str | None = None
    intent_label: str | None = None
    # ADDED 2026-09-08 — the pre-filled destination and what put it there, the trip, and
    # the category the resulting purchase return will be filed under. All served so the
    # screen never works out its own answer and then disagrees with the service.
    originating_warehouse_id: int | None = None
    originating_warehouse_name: str | None = None
    originating_source_doc: str | None = None
    originating_is_resolved: bool = False
    current_warehouse_id: int | None = None
    current_warehouse_name: str | None = None
    logistics_modes: list[OptionOut] = []
    vehicle_options: list[OptionOut] = []
    default_logistics_mode: str | None = None
    default_vehicle_type: str | None = None
    purchase_return_category: str | None = None
    purchase_return_category_label: str | None = None
    #: The rung actually resolved for THIS document, said in a served sentence. The
    #: category is a coarse three-way filter over a THREE-rung chain (WAREHOUSE / MDP /
    #: LIP), so it cannot name the point on its own — this does, in the same words the
    #: stock screens use (`inventory.locations`).
    purchase_return_source_detail: str | None = None
    purchase_return_source_tier: str | None = None
    #: False when no warehouse row answered, so the category is a fallback rather than a
    #: fact and the screen can say which it is reading.
    purchase_return_source_resolved: bool = False
    qc_rejected_tag: bool = False


class PurchaseReturnOut(BaseModel):
    """A row of `pro_returns`, read only. Written by the warehouse module, never here."""

    id: int
    return_no: str
    status: str
    kind: str
    kind_label: str
    return_date: str | None = None
    po_id: int | None = None
    po_no: str | None = None
    grn_id: int | None = None
    grn_no: str | None = None
    vendor_id: int | None = None
    vendor_name: str | None = None
    warehouse_id: int | None = None
    warehouse_name: str | None = None
    reason: str | None = None
    #: Where the material came from: FROM_WAREHOUSE / FROM_LIP_MDB / QC_REJECTED_GRN.
    #: Null on every row raised before 2026-09-08 and on hand-raised ones, which reads as
    #: "source not stated" rather than as a fourth category.
    source_category: str | None = None
    source_category_label: str | None = None
    #: The branch stock return that produced this one, where it was produced
    #: automatically off a returned load landing at the warehouse.
    source_return_id: int | None = None
    source_return_no: str | None = None
    total_items: int = 0
    total_qty: Decimal = Decimal("0")
    total_value: Decimal = Decimal("0")
    credit_note_no: str | None = None
    created_by_name: str | None = None
    created_at: datetime | None = None


class JourneyPhaseOut(BaseModel):
    key: str
    label: str
    sequence: int
    state: str
    caption: str | None = None


class JourneyStageOut(BaseModel):
    """One STEP of the journey — a rung that signed, or one still owed a decision.

    The same shape at both zooms: the eight-dot stepper reads `phases`, the journey screen
    reads these, and both come out of one server-side answer so they cannot disagree.
    """

    event_id: str | None = None
    sequence: int
    title: str
    status: str
    is_current: bool = False
    approver_name: str | None = None
    position_name: str | None = None
    timestamp: datetime | None = None
    comments: str | None = None
    duration_seconds: int | None = None
    #: Which leg this step belongs to: draft, submission, decision, sign_off, approval,
    #: logistics, movement, acknowledgement. The screen groups the timeline by it.
    stage_type: str
    reference_no: str | None = None
    quantity_summary: str | None = None

    @field_serializer("timestamp", when_used="json")
    def _stamp(self, value: datetime | None):
        return ist_iso(value)


class JourneyEventOut(BaseModel):
    """One press on the return, from the immutable audit rows. Append-only history."""

    id: str
    event_type: str
    title: str
    description: str | None = None
    actor_name: str | None = None
    position_name: str | None = None
    timestamp: datetime | None = None
    comments: str | None = None
    reference_no: str | None = None
    quantity_summary: str | None = None

    @field_serializer("timestamp", when_used="json")
    def _stamp(self, value: datetime | None):
        return ist_iso(value)


class JourneyOut(BaseModel):
    """What the tracker draws. Built server-side so the stepper and the status guards
    can never describe different flows.

    `phases` is the eight-dot tracker on the document; `stages` and `history` are the same
    journey at step level, which the journey screen draws. All three describe the RETURN —
    `indent_no` is the request it answers and is a reference only, never a source of steps.
    """

    return_id: int | None = None
    return_no: str | None = None
    status: str
    indent_id: int | None = None
    indent_no: str | None = None
    raised_by_name: str | None = None
    raised_by_position: str | None = None
    created_at: datetime | None = None
    phases: list[JourneyPhaseOut] = []
    current_sequence: int = 1
    current_stage_message: str | None = None
    stages: list[JourneyStageOut] = []
    history: list[JourneyEventOut] = []

    @field_serializer("created_at", when_used="json")
    def _stamp(self, value: datetime | None):
        return ist_iso(value)


class HolderOut(BaseModel):
    id: int
    name: str | None = None
    code: str | None = None


class PositionOut(BaseModel):
    """One post the receiving ladder can be built from."""

    id: int
    name: str | None = None
    role_name: str | None = None
    holders: list[HolderOut] = []


class ReceivingStepOut(BaseModel):
    sequence: int
    position_id: int
    name: str | None = None
    holders: list[HolderOut] = []
    is_dead: bool = False


class ReceivingConfigOut(BaseModel):
    """Who looks at a return after its reporting line has signed."""

    version: int = 0
    is_configured: bool = False
    in_flight: int = 0
    steps: list[ReceivingStepOut] = []
    warnings: list[str] = []


class ReceivingConfigIn(BaseModel):
    """The posts, in the order they should sign. Empty means no receiving check."""

    position_ids: list[int] = Field(default_factory=list, max_length=10)


class IndentOptionOut(BaseModel):
    """One indent a return may be raised against — the raiser's own, past approval, and
    still holding something of its own on the raiser's shelf."""

    id: int
    indent_no: str
    indent_date: str | None = None
    status: str
    total_items: int = 0
    # How many of those items the raiser is still holding and could send back. Served
    # rather than inferred: the picker labels the option with it, and an option that
    # advertises the indent's ORIGINAL line count on an indent holding nothing is the
    # dead end `service.returnable_indents` exists to remove.
    returnable_items: int = 0
    total_qty: Decimal = Decimal("0")
    project_name: str | None = None
    position_name: str | None = None


class ApprovalStepOut(BaseModel):
    """One rung of a resolved chain, as the screens draw it — and where the document has
    reached on it.

    `state` is one of the five the return's own journey uses — completed, current,
    pending, rejected, cancelled — so the approval stepper and the progress tracker are
    drawn from one vocabulary. It is read off the press made on the rung and off the
    instance's `current_sequence`, never inferred from the document's status.
    """

    sequence: int
    name: str
    position_name: str | None = None
    role_name: str | None = None
    approver_names: list[str] = []
    state: str = "pending"
    # What the state says under the circle. Served so two screens cannot word it two ways.
    caption: str | None = None
    # Who actually pressed the rung, which is not always one of `approver_names`: a
    # delegate signs a rung he is not a member of.
    actor_name: str | None = None
    acted_at: datetime | None = None


class ApprovalFlowOut(BaseModel):
    """The approval a return will follow, resolved rather than described.

    Produced by `engine.preview_chain`, which is the same resolution the submit runs, so
    the steps listed here are the people the document will actually be routed to.
    """

    indent_id: int | None = None
    indent_no: str | None = None
    # Always STOCK_RETURN: linked indents affect the resolution context, not the doc type.
    doc_type: str
    # False means no chain is configured for this scope at all — different from a chain
    # configured to need no signature, which is `is_configured` with no steps.
    is_configured: bool = False
    # True once the reporting line has actually started, in which case the steps are the
    # document's own frozen chain and their states are facts. False means a forecast.
    is_live: bool = False
    # The rung the document is sitting on, for the "Stage N of M" line. Null while nothing
    # has started, or once the chain is settled.
    current_sequence: int | None = None
    # Where the approval has reached, in one sentence, built from the steps themselves.
    current_stage_message: str | None = None
    steps: list[ApprovalStepOut] = []
    note: str | None = None


class MyStockOut(BaseModel):
    """One returnable line: an item the signed-in raiser is actually holding."""

    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    available_qty: Decimal
    warehouse_id: int
    warehouse_name: str | None = None
    expiry_date: str | None = None
    batch_no: str | None = None


class RaiserOut(BaseModel):
    """The identity block the form shows read-only, so the returner can see what the
    return will be tagged with before they submit it."""

    employee_id: int | None = None
    employee_code: str | None = None
    employee_name: str | None = None
    position_name: str | None = None
    office_name: str | None = None
    from_warehouse_id: int | None = None
    from_warehouse_name: str | None = None
    to_warehouse_id: int | None = None
    to_warehouse_name: str | None = None
    destination_note: str | None = None


class PurchaseSourceOut(BaseModel):
    """One of the three purchase-return source categories, served for the filter."""

    value: str
    label: str


class ReasonOut(BaseModel):
    value: str
    label: str


class HistoryOut(BaseModel):
    stage_sequence: int | None = None
    stage_name: str | None = None
    actor_name: str | None = None
    actor_position: str | None = None
    action: str
    comments: str | None = None
    acted_at: datetime | None = None


class RelatedDocumentOut(BaseModel):
    """One document on the trail behind the returned item.

    The same fields whatever kind it is, so the section renders one way and branches on
    nothing. `doc_label` is SERVED rather than mapped in the screen (`enums.TRAIL_LABELS`)
    — a document type the frontend has never heard of still renders with its real name.
    `note` is the one-line qualifier that makes a row worth opening: who signed the
    allocation, the vendor's invoice number, the lot the stock stood in, the LR of the
    truck. `extra` carries what a link or a badge needs and nothing a reader sees.
    """

    doc_type: str
    doc_label: str | None = None
    #: Which leg of the material's life this row belongs to (`enums.TRAIL_CHAPTERS`).
    #: Served on the row so the screen groups by a key it was given rather than by a
    #: second copy of the doc-type-to-chapter map — the way `doc_label` already works.
    chapter: str | None = None
    doc_id: int | None = None
    doc_no: str | None = None
    status: str | None = None
    date: str | None = None
    vendor_name: str | None = None
    warehouse_name: str | None = None
    note: str | None = None
    extra: dict | None = None


class TrailChapterOut(BaseModel):
    """One leg of the material's life, and the question that leg answers.

    Sent in the order the work happens, and sent COMPLETE — a chapter nothing landed in
    still arrives, because "this material was never bought, it came off stock already on
    the shelf" is a fact the reviewer needs and an absent heading cannot state it.
    """

    key: str
    label: str
    caption: str
    #: How many rows of the trail landed here. Zero is meaningful, see above.
    count: int = 0


class RelatedDocumentsOut(BaseModel):
    """The paper trail behind the item, for the reviewer to check before deciding.

    `originating_*` is where the material CAME from, resolved from the trail, and is what
    the destination picker pre-fills with. `current_*` is where the stock stands today —
    a different fact, and never a destination, since a return cannot go back to the shelf
    it is already on.
    """

    return_id: int
    return_no: str | None = None
    originating_warehouse_id: int | None = None
    originating_warehouse_name: str | None = None
    #: Which document answered, or null when this is the addressed-to fallback.
    originating_source_doc: str | None = None
    originating_is_resolved: bool = False
    current_warehouse_id: int | None = None
    current_warehouse_name: str | None = None
    material_issue_no: str | None = None
    material_issue_id: int | None = None
    intent: str | None = None
    intent_label: str | None = None
    items: list[dict] = []
    documents: list[RelatedDocumentOut] = []
    #: The legs of the material's life, in order, every one of them — the headings the
    #: `documents` above are read under. Served rather than held in the screen so a
    #: document type added to the trail lands under a heading without the frontend
    #: knowing it exists.
    chapters: list[TrailChapterOut] = []
    #: Set only when a kind of document hit the per-kind cap, so a reader can tell a
    #: complete trail from a truncated one. Null is the normal case and means the list
    #: below is everything.
    documents_note: str | None = None
    purchase_return_category: str | None = None
    purchase_return_category_label: str | None = None
    #: The rung actually resolved for THIS document, said in a served sentence. The
    #: category is a coarse three-way filter over a THREE-rung chain (WAREHOUSE / MDP /
    #: LIP), so it cannot name the point on its own — this does, in the same words the
    #: stock screens use (`inventory.locations`).
    purchase_return_source_detail: str | None = None
    purchase_return_source_tier: str | None = None
    #: False when no warehouse row answered, so the category is a fallback rather than a
    #: fact and the screen can say which it is reading.
    purchase_return_source_resolved: bool = False
    qc_rejected_tag: bool = False
    vehicle_options: list[OptionOut] = []
    vehicle_type: str | None = None
    logistics_mode: str | None = None
    #: The warehouse-side document the gate-out raised, once the load has left.
    warehouse_return_no: str | None = None


class AttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    file_name: str
    file_size: int | None = None
    mime_type: str | None = None
    doc_category: str | None = None
    uploaded_by_name: str | None = None
    created_at: datetime | None = None
