from datetime import date, datetime, timezone

from pydantic import (
    BaseModel, ConfigDict, Field, computed_field, field_serializer, field_validator,
    model_validator,
)

from app.modules.indents.enums import IndentType
from app.shared.enums import IndentStatus
from app.shared.time import iso as ist_iso, not_in_past, to_ist, today
from app.shared.limits import (  # request-size guards, see the module
    Annotated, BatchIds, DocumentLines, MAX_DOCUMENT_LINES,
)
from app.shared.masters.combinations import CombinationIn, CombinationOut


_AGE_FROZEN = {IndentStatus.CLOSED.value, IndentStatus.REJECTED.value}


def _utc_iso(value: datetime | None) -> str | None:
    """Name kept (every schema below references it); the clock is IST now."""
    return ist_iso(value)


class IndentItemIn(CombinationIn):
    """A line: the item, and which brand / variant / model of it — or "Any"
    (2026-10-23). The same item in two combinations is two lines."""
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


class ReturnForCorrectionIn(BaseModel):
    """`target_sequence`: 0 sends the indent back to the requester, a positive number to
    whoever signed that step. Left out, it goes to the nearest earlier step."""
    comments: str = ""
    target_sequence: int | None = Field(default=None, ge=0)


class ReturnTargetOut(BaseModel):
    sequence: int
    stage_name: str | None = None
    owner_name: str | None = None
    owner_position_id: int | None = None
    is_requester: bool = False
    is_default: bool = False


class CorrectionOwnerOut(BaseModel):
    employee_id: int
    employee_name: str | None = None
    position_id: int | None = None


class BrandChangeOut(BaseModel):
    """An allocation that gave another brand than the indent line asked for."""
    asked_for: str | None = None
    given: str | None = None
    quantity: float = 0
    reason: str | None = None
    allocation_no: str | None = None


class IndentItemOut(CombinationOut):
    model_config = ConfigDict(from_attributes=True)
    #: Brand changes made at the Fulfilment Desk (2026-10-24), read on the detail.
    brand_changes: list[BrandChangeOut] = Field(default_factory=list)
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
    can_send_correction_back: bool = False
    #: The returns an acknowledgement just raised for goods it did not accept (2026-11-06).
    #: Only set on the response to that acknowledgement; empty everywhere else.
    receipt_returns: list[dict] = Field(default_factory=list)
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


#: Why a delivered quantity was not accepted (2026-11-06), with the words the screen
#: shows. The VALUES are the Returns module's own reasons, one for one, because each
#: rejection is raised there as a return of that reason; `returns/tests` asserts every one
#: is a real `ReturnReason`, so the two cannot drift apart. Indents may not import returns
#: (rule 5), hence a copy that is checked rather than a shared import.
ACK_REJECTION_LABELS: dict[str, str] = {
    "DAMAGED": "Damaged",
    "EXPIRED": "Expired",
    "NEAR_EXPIRY": "Near expiry",
    "LEAKED_SPILLED": "Leakage",
    "PACKAGING_DAMAGED": "Broken package",
    "OTHER": "Other",
}

#: The reasons that mean the goods were harmed in transit, so the carrier is claimed
#: against as well. Expired / near-expiry / other are the supplier's or the shelf's
#: problem, not the carrier's.
ACK_DAMAGE_REASONS = frozenset({"DAMAGED", "PACKAGING_DAMAGED", "LEAKED_SPILLED"})


class ReceiptRejectionIn(BaseModel):
    """Part of a line that reached the requester and is NOT being accepted, and why."""
    reason: str
    quantity: float = Field(gt=0, allow_inf_nan=False)
    comment: str | None = Field(default=None, max_length=500)

    @field_validator("reason")
    @classmethod
    def _known_reason(cls, value: str) -> str:
        reason = (value or "").strip().upper()
        if reason not in ACK_REJECTION_LABELS:
            raise ValueError(
                "Pick a reason: " + ", ".join(ACK_REJECTION_LABELS.values()))
        return reason

    @field_validator("comment")
    @classmethod
    def _trim(cls, value: str | None) -> str | None:
        return (value or "").strip() or None

    @model_validator(mode="after")
    def _other_says_what(self):
        # "Other" on its own tells whoever handles the return nothing.
        if self.reason == "OTHER" and not self.comment:
            raise ValueError("Say what the problem is when the reason is Other")
        return self


class AcknowledgeLineIn(BaseModel):
    indent_item_id: int
    # What arrived in THIS delivery AND WAS ACCEPTED, not the running total. The service
    # adds it to what was already acknowledged, so the caller never has to know the
    # previous figure. Zero is allowed when the whole line is being rejected.
    received_quantity: float = Field(ge=0)
    #: What reached the requester and is NOT being accepted, by reason (2026-11-06).
    #: Accepted + rejected + still missing is what was sent.
    rejections: list[ReceiptRejectionIn] = Field(default_factory=list, max_length=12)
    #: A line issued in PACKAGES (2026-10-26): how much arrived in each package that
    #: came SHORT or MISSING (0), by code. Packages not named arrived whole.
    package_receipts: dict[str, float] | None = None

    @model_validator(mode="after")
    def _something_is_confirmed(self):
        if self.received_quantity + sum(r.quantity for r in self.rejections) <= 0:
            raise ValueError("Enter what you received, or what you are not accepting")
        return self


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
    #: The packs THIS package holds of the line, as the packer left them (2026-10-22).
    pack_breakdown: list[dict] | None = None
    pack_text: str | None = None
    #: The packages this carton holds of a line issued in packages, {code, quantity}.
    box_codes: list[dict] = Field(default_factory=list)


class AcknowledgementLineRow(CombinationOut):
    """One indent line on the "what is owed to me" screen."""
    indent_item_id: int
    item_id: int | None = None
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    approved_quantity: float
    issued_quantity: float
    #: What was actually ISSUED against the line, per brand / variant / model
    #: (2026-10-26): a substituted brand, or stock with no brand recorded.
    issued_combinations: list[dict] = Field(default_factory=list)
    #: Issued in BOXES (2026-10-26): {code, pack_name, quantity} per box. The site
    #: checks these boxes; no code per piece is asked for.
    box_codes: list[dict] = Field(default_factory=list)
    dispatched_quantity: float
    received_quantity: float
    #: Reached the requester and was not accepted (2026-11-06). Counted as arrived, so it
    #: is not offered for acknowledgement again, but it is not received: the line is
    #: still owed.
    rejected_quantity: float = 0
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
    #: The packs the line was sent in — "1 Box + 5 loose" — read off its issue lines
    #: (2026-10-22). Codes stay per unit; this only describes them.
    pack_breakdown: list[dict] | None = None
    pack_text: str | None = None
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
    #: STR rows are received on Inventory > Stock Transfer, not Indents (2026-10-29).
    indent_type: str | None = None
    #: An STR's route, off the orders serving it: STO numbers, source(s), destination.
    sto_nos: list[str] = []
    from_warehouse_names: list[str] = []
    to_warehouse_name: str | None = None
    indent_date: date | None = None
    required_date: date | None = None
    status: str
    priority: str | None = None
    project_name: str | None = None
    can_acknowledge: bool = False
    #: Returns raised by the acknowledgement that produced this row (2026-11-06).
    receipt_returns: list[dict] = Field(default_factory=list)
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
    qc_status: str | None = None
    qc_inspection_no: str | None = None
    qc_complete: bool = False
    consignment_no: str | None = None
    consignment_status: str | None = None

    @field_serializer("created_at", when_used="json")
    def serialize_datetime(self, value: datetime):
        return _utc_iso(value)
