from datetime import date, datetime, timezone

from pydantic import (
    BaseModel, ConfigDict, Field, computed_field, field_serializer, field_validator,
)

from app.modules.indents.enums import IndentType
from app.shared.enums import IndentStatus
from app.shared.time import iso as ist_iso, not_in_past, to_ist, today
from app.shared.limits import (  # request-size guards, see the module
    Annotated, BatchIds, DocumentLines, MAX_DOCUMENT_LINES,
)


_AGE_FROZEN = {IndentStatus.CLOSED.value, IndentStatus.REJECTED.value}


def _utc_iso(value: datetime | None) -> str | None:
    """Name kept (every schema below references it); the clock is IST now."""
    return ist_iso(value)


class IndentItemIn(BaseModel):
    item_id: int
    quantity: float = Field(gt=0)
    remarks: str | None = None


class IndentCreate(BaseModel):
    required_date: date | None = None

    _no_past_required_date = field_validator("required_date")(
        lambda cls, v: not_in_past(v, "Required date"))
    priority: str = "NORMAL"
    # Defaulted, not required: a caller that predates the field keeps working and
    # lands on exactly the value the database would have given it anyway.
    indent_type: IndentType = IndentType.REGULAR
    vehicle_id: int | None = None
    remarks: str | None = None
    items: Annotated[list[IndentItemIn], DocumentLines]


class IndentUpdate(BaseModel):
    required_date: date | None = None
    priority: str | None = None
    indent_type: IndentType | None = None
    vehicle_id: int | None = None
    office_id: int | None = None
    remarks: str | None = None
    items: Annotated[list[IndentItemIn], DocumentLines] | None = None


class MonthlyCopyIn(BaseModel):
    """Raise this cycle from last cycle. Everything optional — the whole point is
    that an empty body already does the right thing."""
    required_date: date | None = None
    remarks: str | None = None
    #: {item_id: quantity} for the lines the requester changed. 0 drops the line.
    overrides: dict[int, float] = Field(default_factory=dict)


class MonthlySubmitIn(BaseModel):
    indent_ids: Annotated[list[int], BatchIds]


class ActionIn(BaseModel):
    comments: str = ""


class CorrectionOwnerOut(BaseModel):
    employee_id: int
    employee_name: str | None = None
    position_id: int | None = None


class IndentItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    quantity: float
    approved_quantity: float | None = None
    ordered_quantity: float
    received_quantity: float
    remarks: str | None = None


class IndentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    indent_no: str
    indent_type: str = IndentType.REGULAR.value
    indent_date: date | None = None
    required_date: date | None = None
    vehicle_id: int | None = None
    vehicle_number: str | None = None
    requested_by_id: int | None = None
    requested_by_name: str | None = None
    position_id: int | None = None
    position_name: str | None = None
    department_id: int | None = None
    department_name: str | None = None
    office_id: int | None = None
    office_name: str | None = None
    office_sac: str | None = None
    # Region/Location, snapshotted from the requester's HCM location at create.
    # Read-only on create and edit: there is no matching field on IndentCreate/Update.
    region_id: int | None = None
    region_name: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    status: str
    priority: str
    total_items: int
    total_qty: float
    remarks: str | None = None
    current_approver_name: str | None = None
    approved_at: datetime | None = None
    is_bookmarked: str = "NO"
    can_submit: bool = False
    can_approve: bool = False
    can_reject: bool = False
    can_return_for_correction: bool = False
    can_edit_correction: bool = False
    can_resubmit_correction: bool = False
    correction_owner: CorrectionOwnerOut | None = None
    returned_from_stage: str | None = None
    resubmit_target_stage: str | None = None
    correction_comment: str | None = None
    created_at: datetime
    items: list[IndentItemOut] = []

    @field_serializer("approved_at", "created_at", when_used="json")
    def serialize_datetime(self, value: datetime | None):
        return _utc_iso(value)


class IndentListRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    indent_no: str
    indent_type: str = IndentType.REGULAR.value
    requested_by_name: str | None = None
    department_name: str | None = None
    region_id: int | None = None
    region_name: str | None = None
    status: str
    priority: str
    total_items: int
    current_approver_name: str | None = None
    is_bookmarked: str = "NO"
    created_at: datetime
    updated_at: datetime | None = Field(default=None, exclude=True)

    @field_serializer("created_at", when_used="json")
    def serialize_datetime(self, value: datetime):
        return _utc_iso(value)

    @computed_field
    @property
    def age_days(self) -> int:
        """Days since the indent was raised. A closed or rejected indent stops ageing
        at its last change — nothing is owed on it any more."""
        end = today()
        if self.status in _AGE_FROZEN and self.updated_at is not None:
            end = to_ist(self.updated_at).date()
        return max((end - to_ist(self.created_at).date()).days, 0)


class RegionCount(BaseModel):
    """One Region/Location bucket. `region_id` is None for indents with no location."""
    region_id: int | None = None
    region_name: str | None = None
    count: int


class IndentStatsOut(BaseModel):
    total: int
    draft: int
    awaiting_approval: int
    approved_active: int
    rejected: int
    ordered: int
    this_month: int
    total_items: int
    total_qty: float
    approval_rate: float
    by_status: dict[str, int]
    by_region: list[RegionCount] = []


class ActivityRow(BaseModel):
    event_id: str
    indent_id: int
    indent_no: str
    event_type: str
    event_label: str
    result: str
    result_label: str
    occurred_at: datetime
    actor_id: int | None = None
    actor_name: str | None = None
    actor_position: str | None = None
    item_id: int | None = None
    item_code: str | None = None
    item_name: str | None = None
    quantity: float | None = None
    requested_quantity: float | None = None
    uom_code: str | None = None
    #: Set only on the header events (created/submitted/approved/…), where `quantity`
    #: is the whole request rather than one line. NULL on the per-item events.
    line_count: int | None = None
    department_name: str | None = None
    office_name: str | None = None
    region_id: int | None = None
    region_name: str | None = None
    remarks: str | None = None
    source_type: str
    source_id: int

    @field_serializer("occurred_at", when_used="json")
    def serialize_datetime(self, value: datetime):
        return _utc_iso(value)


class AcknowledgmentRow(BaseModel):
    id: int
    indent_id: int
    indent_no: str
    action: str
    stage_name: str | None = None
    actor_name: str | None = None
    comments: str | None = None
    acted_at: datetime

    @field_serializer("acted_at", when_used="json")
    def serialize_datetime(self, value: datetime):
        return _utc_iso(value)


class FulfilmentStep(BaseModel):
    """One stage of what physically happened to the goods, for the indent stepper.

    Sits after the approval stages, which stop at "Ready for Allocation" — everything
    the warehouse then did to the order was invisible on the indent until now.
    """
    key: str
    label: str
    state: str
    caption: str | None = None


class AcknowledgeLineIn(BaseModel):
    indent_item_id: int
    # What arrived in THIS delivery, not the running total. The service adds it to what
    # was already acknowledged, so the caller never has to know the previous figure.
    received_quantity: float = Field(gt=0)


class AcknowledgeIn(BaseModel):
    lines: list[AcknowledgeLineIn] = Field(min_length=1, max_length=MAX_DOCUMENT_LINES)
    #: What state the goods arrived in. GOOD or DAMAGED only — SHORT is NOT asked for
    #: and must never be, because the quantities above already say it: a requester who
    #: types 6 against 10 dispatched has reported the shortage. Offering a SHORT flag
    #: as well would let one form say "all ten arrived" and "it was short" in the same
    #: breath, which is the disagreement this whole path exists to prevent. The service
    #: derives SHORT from the numbers and takes DAMAGED from here.
    condition: str | None = None
    #: Required when something is wrong — it is what the claim is investigated from.
    remarks: str | None = None


class AcknowledgementPackageQuantityRow(BaseModel):
    """How much of one acknowledgement line travelled in one physical package.

    The package's OWN description travels with the quantity — what kind of container
    it is, what it weighs, how big it is, whether it is fragile or cold-chain, and who
    sealed it. A person standing in front of a delivery identifies the carton they are
    holding by those things and not by `package_id`: the screen used to name a package
    only by its number, so two identical-looking cartons were told apart by reading a
    label that may be on the side facing the wall. Every field is optional because
    every column behind it is — a load packed in a hurry carries a number and nothing
    else, and a blank is simply not drawn.
    """
    dispatch_id: int | None = None
    dispatch_no: str | None = None
    package_id: int | None = None
    package_no: str | None = None
    quantity: float
    package_type: str | None = None
    barcode: str | None = None
    weight_kg: float | None = None
    length_cm: float | None = None
    width_cm: float | None = None
    height_cm: float | None = None
    is_fragile: bool = False
    is_temp_controlled: bool = False
    packed_by_name: str | None = None
    packed_at: datetime | None = None


class AcknowledgementLineRow(BaseModel):
    """One indent line on the "what is owed to me" screen."""
    indent_item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    approved_quantity: float
    issued_quantity: float
    dispatched_quantity: float
    received_quantity: float
    is_serial_tracked: bool = False
    #: WHICH kind of identifier the labels below are — SERIAL, IMEI, ASSET,
    #: CONSUMABLE or NONE (`warehouse.enums.TRACKING_META`). Served rather than
    #: inferred in the screen for the same reason the issue picker serves it: the
    #: four are indistinguishable by eye, and only the item knows which was printed
    #: on the goods the requester is holding.
    tracking_type: str = "NONE"
    #: The units that actually left the warehouse against this line — named by
    #: whichever identifier each one carries. Read-only, so the requester can match
    #: what is in their hands before acknowledging receipt.
    serial_numbers: list[str] = Field(default_factory=list)
    #: How much of this line procurement is already buying (an unsettled material
    #: request). Served because no screen can derive it: the indent status describes
    #: the whole document, so a mixed indent — one line off the shelf, one out to be
    #: bought — says nothing about which line is which.
    on_order_quantity: float = 0
    #: Physical package split for this line. The acknowledgement itself is still per
    #: indent line, but the receipt desk has to open the packages warehouse labelled.
    package_quantities: list[AcknowledgementPackageQuantityRow] = Field(default_factory=list)
    # Plain-English answer to "why hasn't my stuff come yet", derived at read time from
    # the issue and dispatch state — never stored, so it cannot go stale.
    pending_with: str | None = None


class ShipmentTrackRow(BaseModel):
    """How the goods are travelling, for the person waiting on them.

    Served on the requester's own row rather than behind a logistics screen they have
    no permission for: "it has left" is useless without the docket number to chase it
    with, and the carrier's tracking page is the only thing that answers "where is it
    today". Read-only — the leg itself belongs to Logistics.
    """
    dispatch_id: int | None = None
    consignment_no: str | None = None
    tr_id: int
    tr_no: str
    mode: str
    status: str
    carrier_name: str | None = None
    vehicle_number: str | None = None
    driver_name: str | None = None
    driver_phone: str | None = None
    lr_no: str | None = None
    docket_no: str | None = None
    tracking_url: str | None = None
    expected_delivery: date | None = None
    dispatched_at: datetime | None = None
    delivered_at: datetime | None = None
    acknowledged_at: datetime | None = None


class AcknowledgementRow(BaseModel):
    indent_id: int
    indent_no: str
    indent_date: date | None = None
    required_date: date | None = None
    status: str
    priority: str | None = None
    project_name: str | None = None
    can_acknowledge: bool = False
    lines: list[AcknowledgementLineRow] = []
    shipments: list[ShipmentTrackRow] = []


class IndentNotificationRow(BaseModel):
    id: str
    indent_id: int
    indent_no: str
    title: str
    message: str
    status: str
    created_at: datetime

    @field_serializer("created_at", when_used="json")
    def serialize_datetime(self, value: datetime):
        return _utc_iso(value)


class IndentJourneyStage(BaseModel):
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
    stage_type: str
    approval_mode: str | None = None
    reference_no: str | None = None
    quantity_summary: str | None = None
    evidence_source: str | None = None

    @field_serializer("timestamp", when_used="json")
    def serialize_datetime(self, value: datetime | None):
        return _utc_iso(value)


class IndentJourneyHistoryEvent(BaseModel):
    id: str
    event_type: str
    title: str
    description: str | None = None
    actor_name: str | None = None
    position_name: str | None = None
    timestamp: datetime
    comments: str | None = None
    reference_no: str | None = None
    quantity_summary: str | None = None

    @field_serializer("timestamp", when_used="json")
    def serialize_datetime(self, value: datetime):
        return _utc_iso(value)


class IndentJourneyOut(BaseModel):
    contract_version: int = 5
    indent_id: int
    indent_no: str
    status: str
    requested_by_name: str | None = None
    requested_by_position: str | None = None
    created_at: datetime
    current_stage: str | None = None
    current_stage_message: str
    final_any_one_outcome: str | None = None
    stages: list[IndentJourneyStage]
    phases: list[IndentJourneyStage]
    history: list[IndentJourneyHistoryEvent]
    missing_sources: list[str] = Field(default_factory=list)

    @field_serializer("created_at", when_used="json")
    def serialize_datetime(self, value: datetime):
        return _utc_iso(value)
