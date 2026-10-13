"""Inventory wire shapes.

Field names follow the live stk_balance / stk_ledger columns. The versions these
replaced (in logistics/schemas.py) still named facility_id and quantity, which the
DB team's tables do not have — they would have 500'd the moment a row existed.
"""
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.shared.time import not_in_past
from app.shared.limits import (  # request-size guards, see the module
    Annotated, BatchDocuments, BatchIds, DocumentLines, MAX_BATCH_IDS, MAX_DOCUMENT_LINES,
    SerialList,
)


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
    # A JSON list on the table — a lot holds many units. Sent as a list so the screen
    # can say "…and 84 more" instead of pretending a lot has one identity.
    serial_number: list[str] | None = None
    asset_code: str | None = None
    consumable_code: str | None = None
    available_qty: float
    reserved_qty: float
    #: The part of `reserved_qty` that is an indent's QUANTITY hold. An indent sets
    #: aside a quantity of the item at the point, never a batch or a location — the
    #: batch is chosen FEFO when it is issued — so screens show this at item level and
    #: not as "reserved" on this lot. `available_qty` is left as it is, because stock
    #: transfer and every "is there enough" check read it.
    indent_held_qty: float = 0
    transit_qty: float = 0
    total_qty: float
    # REQ_032 — the outward pipeline for this ITEM at this POINT (not this lot), READ
    # off the warehouse documents on every call (`service.stock_pipeline`):
    #   issued_pending_qty  posted out of stock here, consignment not yet gone
    #   outgoing_qty        left here on a consignment, not yet received
    #   incoming_qty        on a consignment addressed here, not yet received
    issued_pending_qty: float = 0
    outgoing_qty: float = 0
    incoming_qty: float = 0
    # The costed rate and what the lot is worth. Both are real stk_balance columns and
    # were simply missing from this model, so response_model dropped them on the way
    # out and the screen showed "Not costed" against stock that had a perfectly good
    # rate in the database.
    valuation_rate: float = 0
    stock_value: float = 0
    last_movement_at: datetime | None = None
    updated_at: datetime | None = None
    # Not stk_balance columns — filled from mst_items by service.list_stock so the
    # balance screen can show category, reorder level and the printed barcode.
    category_name: str | None = None
    reorder_level: float = 0
    barcode_value: str | None = None
    # The UOM's readable name. `uom_code` is the snapshot taken at the movement and is
    # what every document, ledger row and export is keyed on, so it cannot be renamed —
    # but the earliest six masters carry the prefix INSIDE the code (`UOM-GMS`,
    # `UOM-L`), which printed as "12 UOM-GMS" on the grid. The name is what a reader
    # wants ("GMS"); the code stays untouched everywhere it is stored.
    uom_name: str | None = None


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
    # What the movement cost and what it was worth. Nullable because every row written
    # before these columns were mapped has NULL, and a NULL must read as "not costed"
    # rather than as a confident zero.
    rate: float | None = None
    value: float | None = None
    # Serial / IMEI carried by the line, and the asset or consumable code the same
    # unit holds. The codes are not on stk_ledger — service.list_movements reads them
    # off the balance row the movement touched.
    serial_numbers: list[str] | None = None
    asset_code: str | None = None
    consumable_code: str | None = None
    # Every unit code this movement carried, for an item that is not serial-tracked —
    # where the code IS the unit's identity. A list, because the screen's code column
    # lists and copies them one per line; `asset_code` / `consumable_code` above stay
    # the single code they have always been.
    unit_codes: list[str] | None = None
    # FIXED 2026-08-21 — the lot a movement touched. `stk_ledger` has carried both
    # since it was written and `list_movements` already reads them to look the codes
    # up, but neither was on the wire: the screen could only ask the unit lookup for
    # `item:warehouse`, which is the key placed units are NOT filed under, so every
    # put-away lot showed a dash for Serial / IMEI and Asset Code.
    bin_id: int | None = None
    batch_id: int | None = None
    ref_type: str | None = None
    ref_no: str | None = None
    created_by_name: str | None = None
    created_at: datetime


class StockSummaryOut(BaseModel):
    """The tiles above the stock balance grid. Counted over every matching row, so
    they do not change when the page size does."""
    stock_lines: int
    distinct_items: int
    # On hand including reserved — the same figure Stocking Points shows, so the two
    # screens can be reconciled instead of only compared by row count.
    total_qty: float = 0
    total_value: float
    expiring_30_days: int
    below_reorder: int
    # False when no item in the master carries a reorder level, which makes
    # `below_reorder` an artefact rather than an answer. Defaults True so an older
    # client that never reads it behaves exactly as before.
    reorder_configured: bool = True
    # REQ_032 — the same three pipeline figures as StockRow, totalled over the points
    # this screen is showing.
    issued_pending_qty: float = 0
    outgoing_qty: float = 0
    incoming_qty: float = 0


class MovementSummaryOut(BaseModel):
    """Same idea for the stock ledger."""
    movements: int
    total_in: float
    total_out: float


class StockGroupBatch(BaseModel):
    """One batch inside an item-at-point card: what the bayRADAR card expands to."""
    batch_id: int
    batch_no: str | None = None
    expiry_date: date | None = None
    total_qty: float = 0
    available_qty: float = 0
    reserved_qty: float = 0
    indent_held_qty: float = 0
    bins: int = 0
    bin_codes: list[str] = []


class StockGroupRow(BaseModel):
    """One item at one point: the grouped stock balance row.

    Lots are detail, not the list — one card per item per warehouse/MDP/LIP with
    the reserved quantity on the face and the batches one tap away.
    """
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    category_name: str | None = None
    uom_code: str | None = None
    uom_name: str | None = None
    warehouse_id: int
    warehouse_name: str | None = None
    total_qty: float = 0
    available_qty: float = 0
    reserved_qty: float = 0
    indent_held_qty: float = 0
    lots: int = 0
    batches: list[StockGroupBatch] = []


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
    # The ladder rung the request is waiting on ("Regional Manager"), computed on read
    # from the frozen chain — not a column, and not the approver's name.
    current_stage_name: str | None = None
    # Whether THIS login, under the position it is currently wearing, is the one the
    # request is waiting on. Not "am I an approver" — one person often holds two rungs
    # of the same ladder, and the screen has to know which hat is on. Advice for the
    # buttons only; `engine.act` re-checks and is the gate (rule 6).
    can_act: bool = False
    project_name: str | None = None
    remarks: str | None = None
    approved_at: datetime | None = None
    has_requisition: bool = False
    items: list[MRItemOut] = Field(default_factory=list)


class MRLineIn(BaseModel):
    """One line of a hand-raised request."""
    item_id: int
    quantity: float = Field(gt=0)
    project_id: int | None = None
    # Set when the line came from the allocation screen, so procurement can trace the
    # buy back to the indent line that could not be served off the shelf.
    indent_item_id: int | None = None


class MRCreateIn(BaseModel):
    """Raise a material request by hand.

    `indent_id` is optional on purpose: the allocation screen raises against the
    indent it is working, and the Material Requests screen raises a free-standing
    buy that no indent asked for. Same document either way.
    """
    items: list[MRLineIn] = Field(min_length=1, max_length=MAX_DOCUMENT_LINES)
    indent_id: int | None = None
    indent_no: str | None = None
    priority: str | None = None
    required_by: date | None = None
    remarks: str | None = None

    _no_past_required_by = field_validator("required_by")(
        lambda cls, v: not_in_past(v, "Required by"))


class MRLineReviseIn(BaseModel):
    """One line's new quantity. Keyed by the MR LINE id, not the item: an MR may carry
    the same item twice when two indent lines were short of it, and keying on item_id
    would silently rewrite both."""
    id: int
    quantity: float = Field(gt=0)


class MRReviseIn(BaseModel):
    lines: list[MRLineReviseIn] = Field(default_factory=list, max_length=MAX_DOCUMENT_LINES)
    comments: str = ""


class MRClaimRow(BaseModel):
    """Another open request for the same item, so the number below the line can be
    opened up into the documents behind it."""
    mr_id: int
    mr_no: str
    status: str
    indent_id: int | None = None
    indent_no: str | None = None
    requested_by_name: str | None = None
    department_name: str | None = None
    project_name: str | None = None
    priority: str | None = None
    quantity: float
    ordered_quantity: float
    created_at: datetime | None = None


class MRClaimsOut(BaseModel):
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    total_qty: float
    available_qty: float
    reserved_qty: float
    # What every OTHER open request wants, and across how many indents. This request
    # is excluded from both, exactly as the allocation screen excludes its own indent.
    claimed_total: float
    indent_count: int
    claims: list[MRClaimRow] = Field(default_factory=list)


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
    decisions: Annotated[list[AllocationDecisionIn], DocumentLines]
    remarks: str | None = None


class AllocBatchActionIn(BaseModel):
    """Approve or reject a whole cycle's allocations in one act."""
    allocation_ids: Annotated[list[int], BatchIds]
    comments: str = ""


class AllocationRevisionIn(BaseModel):
    """The approver's own number for one allocation line.

    Approving used to reserve exactly what inventory proposed, so an approver who
    disagreed could only reject the whole allocation and ask for it again. `id` is the
    allocation LINE id — the line is already tied to its item and warehouse, so a
    revision can only change how much, never what or from where.
    """
    id: int
    quantity: float = Field(ge=0)


class AllocApproveIn(BaseModel):
    """Approve, optionally revising the quantities first."""
    comments: str = ""
    revisions: list[AllocationRevisionIn] = Field(default_factory=list, max_length=MAX_DOCUMENT_LINES)


class AllocationLineAvailability(BaseModel):
    """What one allocation line could actually be given, read right now.

    `free` is the shelf at the chosen point less what other un-approved allocations
    have already promised out of it — the same arithmetic the allocation screen does,
    so an approver is never shown stock somebody else has already spoken for.
    """
    id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    warehouse_id: int | None = None
    warehouse_name: str | None = None
    requested_qty: float
    quantity: float
    on_shelf: float
    pledged_elsewhere: float
    free: float
    max_allowed: float
    # The indent LINE's request, shared by every row serving it from another point.
    line_requested_qty: float = 0


class AllocationHistoryBatchIn(BaseModel):
    allocation_ids: Annotated[list[int], BatchIds]


class AllocationBatchIn(BaseModel):
    """Every indent in a monthly cycle decided in one go.

    One `AllocationIn` per indent, exactly what the single-indent screen posts — the
    batch screen is a faster way to fill them in, not a different decision. Each still
    becomes its own allocation with its own ladder, so nothing about how a reservation
    is written or approved changes."""
    allocations: Annotated[list[AllocationIn], BatchDocuments]


class AllocationBatchFailureOut(BaseModel):
    indent_id: int
    indent_no: str | None = None
    reason: str


class AllocationBatchOut(BaseModel):
    created_count: int
    created_indent_ids: list[int] = Field(default_factory=list)
    failed: list[AllocationBatchFailureOut] = Field(default_factory=list)


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
    # Line totals, filled by one grouped query in `list_allocations`. The approvals
    # screen used to fetch every allocation in full just to add these two numbers up,
    # which was one request per row.
    total_qty: float = 0
    requested_total: float = 0


class AllocationOut(AllocationListRow):
    remarks: str | None = None
    items: list[AllocationItemOut] = Field(default_factory=list)


# ---------------- Stock Adjustment Schemas ----------------

class AdjustmentItemIn(BaseModel):
    """One line of a stock audit or adjustment.

    A COUNTED line sends `physical_qty` and nothing else about quantity: the server
    reads the system figure itself and derives the direction and the correction, so
    a screen holding a stale system number cannot post the wrong difference. A DIRECT
    line (a known write-off) sends `direction` and `quantity` instead.

    `serial_numbers` are the unit codes the write-off covers, on coded items. The
    warehouse module (which owns them, via a hook) retires exactly these rows so
    the issue screen stops offering goods the audit just declared gone; a code not
    on this line's item/batch/bin is refused, which is what keeps the remarks-text
    workaround from coming back. Empty on anything the shelf holds without codes.
    """
    item_id: int
    bin_id: int = 0
    batch_id: int = 0
    project_id: int = 0
    physical_qty: float | None = Field(default=None, ge=0)
    direction: str | None = None  # IN | OUT, direct lines only
    quantity: float | None = Field(default=None, gt=0)
    serial_numbers: Annotated[list[str], SerialList] = []
    unit_cost: float = 0.0
    remarks: str | None = None


class AdjustmentIn(BaseModel):
    warehouse_id: int
    # Validated against AdjustmentReason in the service, not typed as the enum here, so
    # a bad value comes back as the app's own error shape rather than a Pydantic 422.
    reason: str
    remarks: str | None = None
    items: Annotated[list[AdjustmentItemIn], DocumentLines]


class AdjustmentRejectIn(BaseModel):
    """Why an adjustment was refused. Optional so the existing call still works."""
    remarks: str | None = None


class CountSheetRow(BaseModel):
    """What the system holds of one item at one warehouse — the audit's left column."""
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    system_qty: float
    reserved_qty: float


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
    system_qty: float | None = None
    physical_qty: float | None = None
    unit_cost: float | None = 0.0
    # The unit codes an OUT line writes off — what the audit retired, read back so
    # the screen can say which of them died rather than only how many.
    serial_numbers: list[str] | None = None
    remarks: str | None = None


class AdjustmentListRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    adjustment_no: str
    warehouse_id: int
    warehouse_name: str | None = None
    reason: str
    status: str
    created_by_id: int | None = None
    created_by_name: str | None = None
    approved_by_name: str | None = None
    approved_at: datetime | None = None
    current_approver_name: str | None = None
    created_at: datetime


class AdjustmentOut(AdjustmentListRow):
    remarks: str | None = None
    items: list[AdjustmentItemOut] = Field(default_factory=list)
    # Set per caller by the detail read: may THIS login approve or reject it now.
    can_act: bool = False


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
    #: See `StockRow.indent_held_qty`.
    indent_held_qty: float = 0
    total_qty: float
    project_name: str | None = None
    serial_number: str | None = None
    asset_code: str | None = None
    # Warehouse -> zone -> rack -> ... -> bin, walked up whs_warehouse_locations.
    location_path: list[str] = []


class IndentSetAside(BaseModel):
    """One indent's quantity hold on an item at a point (no batch, no location)."""
    indent_id: int
    indent_no: str | None = None
    quantity: float
    since: datetime | None = None
    by_name: str | None = None


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
    #: What indents have set aside of this item at this point — quantity only.
    set_aside_total: float = 0
    set_aside: list[IndentSetAside] = []


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


# ---------------- Ageing & Valuation ------------------------

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
    items: Annotated[list[STOItemIn], DocumentLines]


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
    doc_kind: str | None = None
    requested_by_name: str | None = None
    approved_by_name: str | None = None
    # The STR this order serves (NULL when raised directly) and the material issue
    # executing it. `stage` is READ off that issue — see service._STO_STAGE_BY_ISSUE.
    str_id: int | None = None
    str_no: str | None = None
    issue_id: int | None = None
    issue_no: str | None = None
    issue_status: str | None = None
    stage: str | None = None
    created_at: datetime


class STOReject(BaseModel):
    comments: str = Field(min_length=1, max_length=1000)


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
    item_ids: list[int] = Field(default_factory=list, max_length=MAX_BATCH_IDS)


class CycleCountItemUpdateIn(BaseModel):
    id: int
    counted_qty: float = Field(ge=0)
    remarks: str | None = None


class CycleCountUpdateIn(BaseModel):
    remarks: str | None = None
    items: Annotated[list[CycleCountItemUpdateIn], DocumentLines]


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


class FloorAccessIn(BaseModel):
    position_id: int = Field(gt=0)
    location_id: int = Field(gt=0)


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
    location_id: int | None = None
    section_name: str | None = None
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
