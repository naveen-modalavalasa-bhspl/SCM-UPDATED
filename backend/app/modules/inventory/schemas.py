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
    serial_number: str | None = None
    asset_code: str | None = None
    consumable_code: str | None = None
    available_qty: float
    reserved_qty: float
    transit_qty: float = 0
    total_qty: float
    last_movement_at: datetime | None = None
    updated_at: datetime | None = None
    # Not stk_balance columns — filled from mst_items by service.list_stock so the
    # balance screen can show category, reorder level and the printed barcode.
    category_name: str | None = None
    reorder_level: float = 0
    barcode_value: str | None = None


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


class StockSummaryOut(BaseModel):
    """The tiles above the stock balance grid. Counted over every matching row, so
    they do not change when the page size does."""
    stock_lines: int
    distinct_items: int
    total_value: float
    expiring_30_days: int
    below_reorder: int


class MovementSummaryOut(BaseModel):
    """Same idea for the stock ledger."""
    movements: int
    total_in: float
    total_out: float


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


# ---------------- Stock Adjustment Schemas ----------------

class AdjustmentItemIn(BaseModel):
    item_id: int
    bin_id: int = 0
    batch_id: int = 0
    project_id: int = 0
    direction: str  # IN | OUT
    quantity: float = Field(gt=0)
    unit_cost: float = 0.0
    remarks: str | None = None


class AdjustmentIn(BaseModel):
    warehouse_id: int
    # Validated against AdjustmentReason in the service, not typed as the enum here, so
    # a bad value comes back as the app's own error shape rather than a Pydantic 422.
    reason: str
    remarks: str | None = None
    items: list[AdjustmentItemIn]


class AdjustmentRejectIn(BaseModel):
    """Why an adjustment was refused. Optional so the existing call still works."""
    remarks: str | None = None


class AdjustmentItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    bin_id: int
    batch_id: int
    project_id: int
    direction: str
    quantity: float
    unit_cost: float | None = 0.0
    remarks: str | None = None


class AdjustmentListRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    adjustment_no: str
    warehouse_id: int
    warehouse_name: str | None = None
    reason: str
    status: str
    created_by_name: str | None = None
    approved_by_name: str | None = None
    approved_at: datetime | None = None
    created_at: datetime


class AdjustmentOut(AdjustmentListRow):
    remarks: str | None = None
    items: list[AdjustmentItemOut] = Field(default_factory=list)


# ---------------- Stock Replenishment Schema ----------------

class StockLotRow(BaseModel):
    """One stk_balance row seen as a lot: its batch, its expiry, where it sits."""
    model_config = ConfigDict(from_attributes=True)
    id: int
    bin_id: int
    bin_code: str | None = None
    batch_id: int
    batch_no: str | None = None
    expiry_date: date | None = None
    days_to_expiry: int | None = None
    available_qty: float
    reserved_qty: float
    total_qty: float
    project_name: str | None = None
    serial_number: str | None = None
    asset_code: str | None = None
    # Warehouse -> zone -> rack -> ... -> bin, walked up whs_warehouse_locations.
    location_path: list[str] = []


class StockDetailOut(BaseModel):
    id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    warehouse_id: int
    warehouse_name: str | None = None
    location_path: list[str] = []
    total_available: float
    total_reserved: float
    total_on_hand: float
    lots: list[StockLotRow] = []


class ReplenishmentRuleIn(BaseModel):
    warehouse_id: int
    item_id: int
    min_qty: float = Field(ge=0)
    max_qty: float = Field(ge=0)
    reorder_qty: float = Field(ge=0)


class ReplenishmentRuleRow(ReplenishmentRuleIn):
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    warehouse_name: str | None = None
    available_qty: float = 0
    is_breached: bool = False


class ReplenishmentRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    category_name: str | None = None
    warehouse_id: int | None = None
    warehouse_name: str | None = None
    available_qty: float
    reorder_level: float
    min_order_qty: float
    suggested_order_qty: float
    lead_time_days: int | None = None
    last_purchase_price: float | None = None
    criticality: str | None = None


# ---------------- Reservation Schemas ----------------

class ReservationRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    stock_id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    warehouse_id: int
    warehouse_name: str | None = None
    bin_id: int
    batch_id: int
    project_id: int
    quantity: float
    ref_type: str
    ref_id: int
    ref_no: str | None = None
    ref_line_id: int | None = None
    status: str
    created_by_name: str | None = None
    created_at: datetime
    released_at: datetime | None = None


class ReservationReleaseOut(BaseModel):
    reservation_id: int
    released_qty: float
    status: str


# ---------------- Live Availability Schemas ----------------

class BatchAvailabilityRow(BaseModel):
    stock_id: int
    warehouse_id: int
    warehouse_name: str | None = None
    bin_id: int
    bin_code: str | None = None
    batch_id: int
    batch_no: str | None = None
    expiry_date: date | None = None
    project_id: int
    available_qty: float
    reserved_qty: float


class ItemAvailabilityOut(BaseModel):
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    total_available_qty: float
    total_reserved_qty: float
    total_transit_qty: float
    pick_strategy: str
    batches: list[BatchAvailabilityRow] = Field(default_factory=list)


# ---------------- Ageing & Valuation Schemas ----------------

class AgeingRow(BaseModel):
    stock_id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    warehouse_id: int
    warehouse_name: str | None = None
    batch_no: str | None = None
    expiry_date: date | None = None
    quantity: float
    days_in_stock: int
    age_bucket: str  # 0-30, 31-60, 61-90, 90+
    days_to_expiry: int | None = None
    expiry_bucket: str | None = None  # EXPIRED, 0-30, 31-60, 61-90, 90+


class AgeingSummaryOut(BaseModel):
    items: list[AgeingRow] = Field(default_factory=list)
    bucket_0_30_qty: float = 0.0
    bucket_31_60_qty: float = 0.0
    bucket_61_90_qty: float = 0.0
    bucket_90_plus_qty: float = 0.0


class ValuationRow(BaseModel):
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    warehouse_id: int
    warehouse_name: str | None = None
    total_qty: float
    moving_avg_cost: float
    total_stock_value: float


class ValuationSummaryOut(BaseModel):
    items: list[ValuationRow] = Field(default_factory=list)
    total_portfolio_value: float = 0.0


class NearExpiryAlertRow(BaseModel):
    stock_id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    warehouse_id: int
    warehouse_name: str | None = None
    batch_no: str | None = None
    expiry_date: date
    days_to_expiry: int
    quantity: float


# ---------------- STO (Stock Transfer Order) Schemas ----------------

class STOItemIn(BaseModel):
    item_id: int
    requested_qty: float = Field(gt=0)
    remarks: str | None = None


class STOIn(BaseModel):
    from_warehouse_id: int
    to_warehouse_id: int
    from_project_id: int = 0
    to_project_id: int = 0
    remarks: str | None = None
    items: list[STOItemIn]


class STOItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    requested_qty: float
    dispatched_qty: float
    received_qty: float
    remarks: str | None = None


class STOListRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    sto_no: str
    from_warehouse_id: int
    from_warehouse_name: str | None = None
    to_warehouse_id: int
    to_warehouse_name: str | None = None
    status: str
    requested_by_name: str | None = None
    approved_by_name: str | None = None
    created_at: datetime


class STOOut(STOListRow):
    remarks: str | None = None
    approved_at: datetime | None = None
    dispatched_at: datetime | None = None
    received_at: datetime | None = None
    items: list[STOItemOut] = Field(default_factory=list)


# ---------------- Cycle Count Schemas ----------------

class CycleCountIn(BaseModel):
    warehouse_id: int
    count_date: date
    remarks: str | None = None
    item_ids: list[int] = Field(default_factory=list)


class CycleCountItemUpdateIn(BaseModel):
    id: int
    counted_qty: float = Field(ge=0)
    remarks: str | None = None


class CycleCountUpdateIn(BaseModel):
    remarks: str | None = None
    items: list[CycleCountItemUpdateIn]


class CycleCountItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    bin_id: int
    batch_id: int
    snapshot_qty: float
    counted_qty: float | None = None
    variance_qty: float | None = None
    remarks: str | None = None


class CycleCountListRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    count_no: str
    warehouse_id: int
    warehouse_name: str | None = None
    count_date: date
    status: str
    planned_by_name: str | None = None
    posted_by_name: str | None = None
    created_at: datetime


class CycleCountOut(CycleCountListRow):
    remarks: str | None = None
    posted_at: datetime | None = None
    items: list[CycleCountItemOut] = Field(default_factory=list)


# ---------------- Overview KPI Schema ----------------

class StockOverviewKPIs(BaseModel):
    total_stock_value: float | None = None
    items_below_reorder: int
    near_expiry_30_days: int
    near_expiry_60_days: int
    near_expiry_90_days: int
    total_reserved_qty: float
    total_available_qty: float
    dead_stock_count: int



# ---------------- Stocking points: tiers, tagging, classification ----------------

class PositionLocationIn(BaseModel):
    """Tag a position to a stocking point. Many per position — one OE can cover
    several MDPs — so this creates a row rather than replacing the position's set."""
    position_id: int = Field(gt=0)
    warehouse_id: int = Field(gt=0)
    project_id: int = Field(default=0, ge=0)
    project_name: str | None = None
    is_primary: bool = False


class PositionLocationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    position_id: int
    position_name: str | None = None
    warehouse_id: int
    warehouse_code: str | None = None
    warehouse_name: str | None = None
    # Derived from warehouse_type, never stored — see inventory/locations.py.
    warehouse_type: str | None = None
    tier: int
    tier_label: str
    project_id: int = 0
    project_name: str | None = None
    is_primary: bool = False


class MovementClassificationOut(BaseModel):
    """What a move between two points would be, before anything is created.

    The screen shows this read-only next to the from/to pickers: the user says WHY
    (`reason`), never WHAT. Letting them pick the kind would make skipping the
    Inventory Manager on a cross-project transfer a one-click affair.
    """
    from_warehouse_id: int | None = None
    to_warehouse_id: int | None = None
    from_tier: int
    to_tier: int
    movement_kind: str
    doc_type: str
    needs_inventory_manager: bool
    # Plain-language explanation, so the screen never has to restate the rule.
    explanation: str
