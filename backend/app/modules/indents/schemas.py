from datetime import date, datetime, timezone

from pydantic import BaseModel, ConfigDict, Field, field_serializer

from app.modules.indents.enums import IndentType


def _utc_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None or value.utcoffset() is None:
        value = value.replace(tzinfo=timezone.utc)
    else:
        value = value.astimezone(timezone.utc)
    return value.isoformat().replace("+00:00", "Z")


class IndentItemIn(BaseModel):
    item_id: int
    quantity: float = Field(gt=0)
    remarks: str | None = None


class IndentCreate(BaseModel):
    required_date: date | None = None
    priority: str = "NORMAL"
    # Defaulted, not required: a caller that predates the field keeps working and
    # lands on exactly the value the database would have given it anyway.
    indent_type: IndentType = IndentType.REGULAR
    vehicle_id: int | None = None
    remarks: str | None = None
    items: list[IndentItemIn]


class IndentUpdate(BaseModel):
    required_date: date | None = None
    priority: str | None = None
    indent_type: IndentType | None = None
    vehicle_id: int | None = None
    office_id: int | None = None
    remarks: str | None = None
    items: list[IndentItemIn] | None = None


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

    @field_serializer("created_at", when_used="json")
    def serialize_datetime(self, value: datetime):
        return _utc_iso(value)


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
    lines: list[AcknowledgeLineIn] = Field(min_length=1)


class DeliveryLineRow(BaseModel):
    """One indent line on the "what is owed to me" screen."""
    indent_item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    approved_quantity: float
    issued_quantity: float
    dispatched_quantity: float
    received_quantity: float
    # Plain-English answer to "why hasn't my stuff come yet", derived at read time from
    # the issue and dispatch state — never stored, so it cannot go stale.
    pending_with: str | None = None


class DeliveryRow(BaseModel):
    indent_id: int
    indent_no: str
    indent_date: date | None = None
    required_date: date | None = None
    status: str
    priority: str | None = None
    project_name: str | None = None
    can_acknowledge: bool = False
    lines: list[DeliveryLineRow] = []


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
