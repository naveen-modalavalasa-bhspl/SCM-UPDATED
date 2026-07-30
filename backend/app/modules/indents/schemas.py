from datetime import date, datetime, timezone

from pydantic import BaseModel, ConfigDict, Field, field_serializer


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
    remarks: str | None = None
    items: list[IndentItemIn]


class IndentUpdate(BaseModel):
    required_date: date | None = None
    priority: str | None = None
    remarks: str | None = None
    items: list[IndentItemIn] | None = None


class ActionIn(BaseModel):
    comments: str = ""


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
    indent_date: date | None = None
    required_date: date | None = None
    requested_by_id: int | None = None
    requested_by_name: str | None = None
    position_id: int | None = None
    position_name: str | None = None
    department_id: int | None = None
    department_name: str | None = None
    office_id: int | None = None
    office_name: str | None = None
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
    created_at: datetime
    items: list[IndentItemOut] = []

    @field_serializer("approved_at", "created_at", when_used="json")
    def serialize_datetime(self, value: datetime | None):
        return _utc_iso(value)


class IndentListRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    indent_no: str
    requested_by_name: str | None = None
    department_name: str | None = None
    status: str
    priority: str
    total_items: int
    current_approver_name: str | None = None
    is_bookmarked: str = "NO"
    created_at: datetime

    @field_serializer("created_at", when_used="json")
    def serialize_datetime(self, value: datetime):
        return _utc_iso(value)


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

    @field_serializer("timestamp", when_used="json")
    def serialize_datetime(self, value: datetime):
        return _utc_iso(value)


class IndentJourneyOut(BaseModel):
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
    history: list[IndentJourneyHistoryEvent]

    @field_serializer("created_at", when_used="json")
    def serialize_datetime(self, value: datetime):
        return _utc_iso(value)
