"""Inventory wire shapes.

Field names follow the live stk_balance / stk_ledger columns. The versions these
replaced (in logistics/schemas.py) still named facility_id and quantity, which the
DB team's tables do not have — they would have 500'd the moment a row existed.
"""
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class StockRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    warehouse_id: int
    warehouse_name: str | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    bin_id: int
    bin_code: str | None = None
    batch_id: int
    batch_no: str | None = None
    expiry_date: date | None = None
    project_id: int
    project_name: str | None = None
    available_qty: float
    reserved_qty: float
    total_qty: float
    updated_at: datetime | None = None


class MovementRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    warehouse_id: int
    warehouse_name: str | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    batch_no: str | None = None
    direction: str
    quantity: float
    balance_after: float
    ref_type: str | None = None
    ref_no: str | None = None
    created_by_name: str | None = None
    created_at: datetime


class TransferIn(BaseModel):
    item_id: int
    quantity: float = Field(gt=0)
    from_warehouse_id: int
    to_warehouse_id: int
    from_project_id: int = 0
    to_project_id: int = 0
    remarks: str | None = None


class MRItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    line_no: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    quantity: float
    ordered_quantity: float
    indent_item_id: int | None = None
    remarks: str | None = None


class MRListRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    mr_no: str
    mr_date: date | None = None
    indent_id: int | None = None
    indent_no: str | None = None
    requested_by_name: str | None = None
    department_name: str | None = None
    status: str
    priority: str
    required_by: date | None = None
    current_approver_name: str | None = None
    created_at: datetime


class MROut(MRListRow):
    project_name: str | None = None
    remarks: str | None = None
    approved_at: datetime | None = None
    items: list[MRItemOut] = Field(default_factory=list)


class ActionIn(BaseModel):
    comments: str = ""


class AllocationLineOut(BaseModel):
    """One line of the fulfilment queue: what an approved indent still needs and how
    much of it is actually on the shelf right now."""
    indent_item_id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    requested_qty: float
    allocated_qty: float
    available_qty: float
    status: str


class AllocationDecisionIn(BaseModel):
    """One decision: this indent line gets this much, out of this warehouse.
    quantity may be 0 -- "give nothing now" is a decision, not a missing value."""
    indent_item_id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    requested_qty: float = 0
    quantity: float = Field(ge=0)
    warehouse_id: int | None = None
    project_id: int = 0
    remarks: str | None = None


class AllocationIn(BaseModel):
    indent_id: int
    decisions: list[AllocationDecisionIn]
    remarks: str | None = None


class AllocationItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    indent_item_id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    requested_qty: float
    quantity: float
    warehouse_id: int | None = None
    warehouse_name: str | None = None
    remarks: str | None = None


class AllocationListRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    allocation_no: str
    indent_id: int
    indent_no: str | None = None
    status: str
    allocated_by_name: str | None = None
    current_approver_name: str | None = None
    approved_at: datetime | None = None
    created_at: datetime


class AllocationOut(AllocationListRow):
    remarks: str | None = None
    items: list[AllocationItemOut] = Field(default_factory=list)
