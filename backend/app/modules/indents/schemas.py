from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class IndentItemIn(BaseModel):
    item_id: int
    quantity: float = Field(gt=0)
    remarks: str | None = None


class IndentCreate(BaseModel):
    required_date: date | None = None
    priority: str = "NORMAL"
    facility_id: int | None = None
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
    department_id: int | None = None
    department_name: str | None = None
    facility_id: int | None = None
    facility_name: str | None = None
    status: str
    priority: str
    total_items: int
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
