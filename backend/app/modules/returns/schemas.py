"""Request/response shapes for Returns."""
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .enums import Disposition, ReturnIntent, ReturnKind, ReturnReason


class ReturnLineIn(BaseModel):
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
    # Everything this module writes comes off a branch shelf, so FIELD is the default and
    # the field is here to be recorded rather than chosen — a purchase return is
    # `pro_returns`, raised in the warehouse module off a rejected GRN line.
    kind: ReturnKind = ReturnKind.FIELD
    # Whether the branch still needs the material. Changes nothing about how the stock
    # moves and everything about what the decision desk decides.
    intent: ReturnIntent = ReturnIntent.RETURN
    items: list[ReturnLineIn] = Field(min_length=1)

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


class ReturnLineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    quantity: Decimal
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
    # FIELD or DECISION or ENDORSE — which desk is holding it. Both of the last two are
    # PENDING_APPROVAL, so the status alone cannot say.
    phase: str = "FIELD"
    kind: str | None = None
    kind_label: str | None = None
    intent: str | None = None
    intent_label: str | None = None
    reason: str | None = None
    reason_label: str | None = None
    reason_note: str | None = None

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
    can_acknowledge: bool = False
    can_withdraw: bool = False
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


class TopRowOut(BaseModel):
    label: str
    count: int


class SummaryOut(BaseModel):
    """The KPI tiles. Counted over the same scope the grid uses, so the tiles and the
    grid can never disagree."""

    draft: int = 0
    pending_approval: int = 0
    approved: int = 0
    acknowledged: int = 0
    rejected: int = 0
    cancelled: int = 0
    total: int = 0
    by_status: dict[str, int] = {}

    # The two desks' backlogs. Both are PENDING_APPROVAL, so one status count cannot
    # separate them and the desk that is behind stays invisible.
    awaiting_decision: int = 0
    awaiting_endorsement: int = 0
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


class DestinationOptionOut(BaseModel):
    """A point the material could go to, and how much of it that point already holds."""

    warehouse_id: int
    warehouse_name: str | None = None
    warehouse_code: str | None = None
    warehouse_type: str | None = None
    tier_label: str | None = None
    on_hand: Decimal = Decimal("0")
    is_default: bool = False


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


class JourneyOut(BaseModel):
    """What the tracker draws. Built server-side so the stepper and the status guards
    can never describe different flows."""

    status: str
    phases: list[JourneyPhaseOut] = []
    current_sequence: int = 1
    current_stage_message: str | None = None


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


class AttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    file_name: str
    file_size: int | None = None
    mime_type: str | None = None
    doc_category: str | None = None
    uploaded_by_name: str | None = None
    created_at: datetime | None = None
