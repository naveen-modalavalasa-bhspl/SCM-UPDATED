from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class POLineIn(BaseModel):
    item_id: int
    indent_item_id: int | None = None
    quantity: float = Field(gt=0)
    rate: float = Field(ge=0)
    tax_percent: float = Field(ge=0, default=0)


class POCreate(BaseModel):
    vendor_id: int
    expected_date: date | None = None
    remarks: str | None = None
    lines: list[POLineIn]


class ActionIn(BaseModel):
    comments: str = ""


class POItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    quantity: float
    rate: float
    tax_percent: float
    amount: float
    received_quantity: float


class POOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    po_no: str
    po_date: date | None = None
    expected_date: date | None = None
    indent_id: int | None = None
    indent_no: str | None = None
    vendor_id: int
    vendor_name: str | None = None
    facility_id: int | None = None
    facility_name: str | None = None
    status: str
    sub_total: float
    tax_amount: float
    total_amount: float
    current_approver_name: str | None = None
    created_at: datetime
    items: list[POItemOut] = []


class POListRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    po_no: str
    vendor_name: str | None = None
    indent_no: str | None = None
    status: str
    total_amount: float
    created_at: datetime
