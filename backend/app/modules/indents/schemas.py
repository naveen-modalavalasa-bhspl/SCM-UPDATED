from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


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
    created_at: datetime
    items: list[IndentItemOut] = []


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
    created_at: datetime


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
    event_at: datetime
    transaction_type: str
    direction: str | None = None
    indent_id: int
    indent_no: str
    status: str
    requested_by_name: str | None = None
    department_name: str | None = None
    item_id: int | None = None
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    quantity: float = 0
    actor_name: str | None = None
    comments: str | None = None


class AcknowledgmentRow(BaseModel):
    id: int
    indent_id: int
    indent_no: str
    action: str
    stage_name: str | None = None
    actor_name: str | None = None
    comments: str | None = None
    acted_at: datetime


class IndentNotificationRow(BaseModel):
    id: str
    indent_id: int
    indent_no: str
    title: str
    message: str
    status: str
    created_at: datetime
