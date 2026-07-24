from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class GRNLineIn(BaseModel):
    po_item_id: int | None = None
    item_id: int
    received_quantity: float = Field(ge=0)
    accepted_quantity: float = Field(ge=0)
    rejected_quantity: float = Field(ge=0, default=0)
    batch_no: str | None = None


class GRNCreate(BaseModel):
    invoice_no: str | None = None
    invoice_date: date | None = None
    vehicle_no: str | None = None
    transporter: str | None = None
    remarks: str | None = None
    lines: list[GRNLineIn]


class GRNItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    ordered_quantity: float
    received_quantity: float
    accepted_quantity: float
    rejected_quantity: float
    batch_no: str | None = None


class GRNOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    grn_no: str
    grn_date: date | None = None
    po_id: int | None = None
    po_no: str | None = None
    vendor_name: str | None = None
    facility_id: int | None = None
    facility_name: str | None = None
    invoice_no: str | None = None
    vehicle_no: str | None = None
    status: str
    total_items: int
    created_at: datetime
    items: list[GRNItemOut] = []


class GRNListRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    grn_no: str
    po_no: str | None = None
    vendor_name: str | None = None
    status: str
    created_at: datetime


class StockRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    facility_id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    quantity: float
    reserved_quantity: float
    updated_at: datetime


class MovementRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    facility_id: int
    item_id: int
    direction: str
    quantity: float
    balance_after: float
    ref_type: str | None = None
    ref_no: str | None = None
    created_by_name: str | None = None
    created_at: datetime


class IssueLineIn(BaseModel):
    item_id: int
    quantity: float = Field(gt=0)
    batch_no: str | None = None


class IssueCreate(BaseModel):
    indent_id: int | None = None
    facility_id: int
    department_id: int | None = None
    remarks: str | None = None
    lines: list[IssueLineIn]


class IssueOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    issue_no: str
    facility_id: int | None = None
    department_id: int | None = None
    status: str
    created_at: datetime
