"""Inventory wire shapes.

Field names follow the live stk_balance / stk_ledger columns. The versions these
replaced (in logistics/schemas.py) still named facility_id and quantity, which the
DB team's tables do not have — they would have 500'd the moment a row existed.
"""
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict


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
