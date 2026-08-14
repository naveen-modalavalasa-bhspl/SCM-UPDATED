"""Request and response shapes.

Read models carry the snapshot columns the tables already hold, so a list response
is one row per document with nothing to join client-side. Write models carry only
what a user can actually set — `grn_no`, every `*_name`, every rollup and every
status are decided by the service, and accepting them from the client would let a
caller invent its own document number or mark its own issue approved.
"""
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.modules.warehouse.enums import (
    DispatchEventType, DispatchType, InspectionResult, InspectionType, IssueDirection,
    IssueType, PickStrategy, ReceiptType,
)
from app.shared.models.warehouse import STORAGE_TYPES

ORM = ConfigDict(from_attributes=True)


class _Read(BaseModel):
    model_config = ORM

    @field_validator("status", "result", mode="before", check_fields=False)
    @classmethod
    def _upper_status(cls, value):
        """Statuses leave this module in one case, always.

        The live tables hold both `COMPLETED` and `completed` on `whs_inspections`
        (rows written before the enum was enforced). Every screen compares against
        the enum's uppercase value, so the QC tiles counted 14 of 20 inspections and
        reported an 82% pass rate over rows it had not looked at. Normalising on read
        is the only fix available without touching the data.
        """
        return value.upper() if isinstance(value, str) else value


# ---------------------------------------------------------------------------
# Warehouse master
# ---------------------------------------------------------------------------

class WarehouseRead(_Read):
    id: int
    code: str
    name: str
    facility_id: int | None = None
    facility_name: str | None = None
    office_id: int | None = None
    office_name: str | None = None
    warehouse_type: str
    address: str | None = None
    incharge_id: int | None = None
    incharge_name: str | None = None
    is_bin_managed: bool
    # None = follow the company default. See service.requires_inward.
    requires_inward: bool | None = None
    is_active: bool
    created_at: datetime | None = None


class WarehouseWrite(BaseModel):
    code: str = Field(min_length=1, max_length=50)
    name: str = Field(min_length=1, max_length=200)
    facility_id: int | None = None
    office_id: int | None = None
    warehouse_type: str = "MAIN"
    address: str | None = None
    incharge_id: int | None = None
    is_bin_managed: bool = False
    requires_inward: bool | None = None
    is_active: bool = True


class BinRead(_Read):
    id: int
    warehouse_id: int
    code: str
    name: str | None = None
    description: str | None = None
    parent_id: int | None = None
    bin_type: str | None = None
    storage_type_id: int | None = None
    barcode: str | None = None
    floor_level: int | None = None
    shelf_level: int | None = None
    # Derived when the tree is built, not stored — see service.bin_tree.
    path: str | None = None
    level: int | None = None
    capacity_qty: Decimal | None = None
    capacity_volume: Decimal | None = None
    max_weight_capacity: Decimal | None = None
    height_cm: Decimal | None = None
    aisle_width_meters: Decimal | None = None
    temperature_controlled: bool = False
    humidity_percentage: Decimal | None = None
    target_temperature_celsius: Decimal | None = None
    min_temperature_celsius: Decimal | None = None
    max_temperature_celsius: Decimal | None = None
    is_pickable: bool
    is_active: bool
    occupied_qty: Decimal | None = None
    children: list["BinRead"] = Field(default_factory=list)


class BinWrite(BaseModel):
    warehouse_id: int
    code: str = Field(min_length=1, max_length=50)
    name: str | None = None
    description: str | None = None
    parent_id: int | None = None
    # A location's kind: BIN and COLD_STORAGE_BIN hold stock, the rest are structure.
    bin_type: str = "BIN"
    capacity_qty: Decimal | None = None
    capacity_volume: Decimal | None = None
    max_weight_capacity: Decimal | None = None
    height_cm: Decimal | None = None
    aisle_width_meters: Decimal | None = None
    temperature_controlled: bool = False
    humidity_percentage: Decimal | None = None
    target_temperature_celsius: Decimal | None = None
    min_temperature_celsius: Decimal | None = None
    max_temperature_celsius: Decimal | None = None
    storage_type_id: int | None = None
    barcode: str | None = None
    floor_level: int | None = None
    shelf_level: int | None = None
    is_active: bool = True

    @field_validator("bin_type")
    @classmethod
    def known_storage_type(cls, value: str) -> str:
        value = (value or "").upper()
        if value not in STORAGE_TYPES:
            raise ValueError(
                f"{value or 'blank'} is not a storage type. "
                f"Use one of: {', '.join(STORAGE_TYPES)}")
        return value

    @field_validator(
        "name", "description", "barcode", "floor_level", "shelf_level",
        "capacity_qty", "capacity_volume", "max_weight_capacity", "height_cm",
        "aisle_width_meters", "humidity_percentage", "target_temperature_celsius",
        "min_temperature_celsius", "max_temperature_celsius", "storage_type_id",
        mode="before",
    )
    @classmethod
    def blank_to_none(cls, value):
        return None if value == "" else value


class LocationRead(_Read):
    id: int
    warehouse_id: int
    parent_location_id: int | None = None
    storage_type: str | None = None
    storage_type_id: int | None = None
    code: str
    name: str | None = None
    description: str | None = None
    barcode: str | None = None
    floor_level: int | None = None
    shelf_level: int | None = None
    capacity_weight: Decimal | None = None
    capacity_volume: Decimal | None = None
    max_weight_capacity: Decimal | None = None
    height_cm: Decimal | None = None
    aisle_width_meters: Decimal | None = None
    temperature_controlled: bool
    humidity_percentage: Decimal | None = None
    target_temperature_celsius: Decimal | None = None
    min_temperature_celsius: Decimal | None = None
    max_temperature_celsius: Decimal | None = None
    is_active: bool


class StorageTypeRead(_Read):
    id: int
    code: str | None = None
    name: str
    description: str | None = None
    is_active: bool


class StorageTypeWrite(BaseModel):
    code: str | None = Field(default=None, max_length=50)
    name: str = Field(min_length=1, max_length=50)
    description: str | None = Field(default=None, max_length=200)
    is_active: bool = True

    @field_validator("code", "description", mode="before")
    @classmethod
    def blank_to_none(cls, value):
        return None if value == "" else value


# ---------------------------------------------------------------------------
# Inward
# ---------------------------------------------------------------------------

class ReceiptItemWrite(BaseModel):
    """`accepted_qty` is what you are keeping; rejected and short are derived from
    it by the service, so they are not accepted here."""
    id: int | None = None
    po_item_id: int | None = None
    indent_id: int | None = None
    indent_no: str | None = None
    item_id: int
    # Display only, and ignored on the way in: the service always snapshots code, name
    # and unit from the masters when it writes a line. They are here so a form that is
    # PRE-FILLED from another document (a PO, or an incoming consignment) can show what
    # the item is — without them the source payload carried a bare item_id and every
    # line rendered as a placeholder with no name.
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    ordered_qty: Decimal = Decimal("0")
    received_qty: Decimal = Decimal("0")
    accepted_qty: Decimal | None = None
    rate: Decimal | None = None
    batch_no: str | None = None
    mfg_date: date | None = None
    expiry_date: date | None = None
    bin_id: int | None = None
    rejection_reason: str | None = None
    remarks: str | None = None
    serial_numbers: list[str] | None = None
    imei_numbers: list[str] | None = None
    # Display only, like item_code above, and ignored on the way in — the service
    # reads tracking off the item master. Here so a PRE-FILLED line can render its
    # serial and IMEI cells instead of hiding the numbers it was handed.
    is_serial_tracked: bool = False
    is_imei_tracked: bool = False

    @field_validator("received_qty", "ordered_qty")
    @classmethod
    def _not_negative(cls, v: Decimal) -> Decimal:
        if v is not None and v < 0:
            raise ValueError("Quantity cannot be negative")
        return v


class ReceiptWrite(BaseModel):
    receipt_type: ReceiptType = ReceiptType.PURCHASE
    grn_date: date
    po_id: int | None = None
    # A gate entry is typed from the driver's paperwork, which may name an order that
    # was never raised in this system, so the number is accepted as text. When `po_id`
    # is set the service snapshots the order's own number and ignores this.
    po_no: str | None = Field(default=None, max_length=50)
    transfer_id: int | None = None
    # The incoming consignment being inwarded, on a DISPATCH receipt. It is stored in
    # the same `transfer_id`/`transfer_no` pair the STO uses — `receipt_type` says
    # which document those columns point at, so one source reference serves both.
    dispatch_id: int | None = None
    vendor_id: int | None = None
    warehouse_id: int
    project_id: int | None = None
    invoice_no: str | None = None
    invoice_date: date | None = None
    invoice_amount: Decimal | None = None
    eway_bill_no: str | None = None
    vehicle_no: str | None = None
    transporter_name: str | None = None
    lr_no: str | None = None
    gate_entry_no: str | None = None
    remarks: str | None = None
    items: list[ReceiptItemWrite] = Field(default_factory=list)


class ReceiptItemRead(_Read):
    id: int
    receipt_id: int
    line_no: int
    po_item_id: int | None = None
    indent_id: int | None = None
    indent_no: str | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    is_asset: bool = False
    is_serial_tracked: bool = False
    ordered_qty: Decimal
    received_qty: Decimal
    accepted_qty: Decimal
    rejected_qty: Decimal
    short_qty: Decimal
    rate: Decimal | None = None
    amount: Decimal | None = None
    batch_id: int
    batch_no: str | None = None
    mfg_date: date | None = None
    expiry_date: date | None = None
    bin_id: int
    bin_code: str | None = None
    qc_status: str
    rejection_reason: str | None = None
    remarks: str | None = None
    serial_numbers: list[str] | None = None
    imei_numbers: list[str] | None = None


class ReceiptRead(_Read):
    id: int
    grn_no: str
    receipt_type: str
    grn_date: date
    po_id: int | None = None
    po_no: str | None = None
    transfer_id: int | None = None
    transfer_no: str | None = None
    vendor_id: int | None = None
    vendor_name: str | None = None
    vendor_gstin: str | None = None
    warehouse_id: int
    warehouse_name: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    invoice_no: str | None = None
    invoice_date: date | None = None
    invoice_amount: Decimal | None = None
    eway_bill_no: str | None = None
    vehicle_no: str | None = None
    transporter_name: str | None = None
    lr_no: str | None = None
    gate_entry_no: str | None = None
    gate_entry_at: datetime | None = None
    status: str
    total_items: int
    total_received_qty: Decimal
    total_accepted_qty: Decimal
    total_rejected_qty: Decimal
    total_value: Decimal
    is_stock_posted: bool
    posted_at: datetime | None = None
    received_by_id: int | None = None
    received_by_name: str | None = None
    remarks: str | None = None
    created_by_id: int | None = None
    created_by_name: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class ReceiptDetail(ReceiptRead):
    items: list[ReceiptItemRead] = Field(default_factory=list)


class PoLineOption(BaseModel):
    """An open PO line, so the GRN form fills itself from the order."""
    po_item_id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    ordered_qty: Decimal
    received_qty: Decimal
    pending_qty: Decimal
    rate: Decimal | None = None


class TransferReceiptSource(BaseModel):
    transfer_id: int
    transfer_no: str
    warehouse_id: int
    project_id: int | None = None
    items: list[ReceiptItemWrite] = Field(default_factory=list)
    indent_id: int | None = None
    indent_no: str | None = None


class DispatchReceiptSource(BaseModel):
    """An incoming consignment, shaped so the inward form fills itself.

    `is_bin_managed` travels with it because it decides how much of the form the
    receiving point sees: an MDP or a LIP with no bins configured is never asked
    which shelf the goods went on.
    """
    dispatch_id: int
    dispatch_no: str
    warehouse_id: int
    warehouse_name: str | None = None
    is_bin_managed: bool = False
    from_warehouse_id: int | None = None
    from_warehouse_name: str | None = None
    project_id: int | None = None
    dispatch_date: date | None = None
    lr_no: str | None = None
    vehicle_number: str | None = None
    indent_id: int | None = None
    indent_no: str | None = None
    items: list[ReceiptItemWrite] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Quality
# ---------------------------------------------------------------------------

class InspectionParameter(BaseModel):
    name: str
    expected: str | None = None
    observed: str | None = None
    result: str | None = None


class InspectionItemWrite(BaseModel):
    id: int | None = None
    receipt_item_id: int | None = None
    item_id: int
    batch_no: str | None = None
    inspected_qty: Decimal = Decimal("0")
    accepted_qty: Decimal = Decimal("0")
    parameters: list[InspectionParameter] | None = None
    result: InspectionResult = InspectionResult.PENDING
    defect_type: str | None = None
    rejection_reason: str | None = None
    remarks: str | None = None
    serial_numbers: list[str] | None = None
    imei_numbers: list[str] | None = None


class InspectionWrite(BaseModel):
    inspection_date: date
    receipt_id: int | None = None
    warehouse_id: int | None = None
    inspection_type: InspectionType = InspectionType.INCOMING
    inspector_id: int | None = None
    remarks: str | None = None
    items: list[InspectionItemWrite] = []


class InspectionItemRead(_Read):
    id: int
    inspection_id: int
    receipt_item_id: int | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    batch_no: str | None = None
    inspected_qty: Decimal
    accepted_qty: Decimal
    rejected_qty: Decimal
    parameters: list[InspectionParameter] | None = None
    result: str
    defect_type: str | None = None
    rejection_reason: str | None = None
    remarks: str | None = None
    serial_numbers: list[str] | None = None
    imei_numbers: list[str] | None = None


class InspectionRead(_Read):
    id: int
    inspection_no: str
    inspection_date: date
    receipt_id: int | None = None
    grn_no: str | None = None
    warehouse_id: int | None = None
    warehouse_name: str | None = None
    vendor_id: int | None = None
    vendor_name: str | None = None
    inspection_type: str
    status: str
    total_items: int
    passed_items: int
    failed_items: int
    inspector_id: int | None = None
    inspector_name: str | None = None
    remarks: str | None = None
    created_at: datetime | None = None


class InspectionDetail(InspectionRead):
    items: list[InspectionItemRead] = []


# ---------------------------------------------------------------------------
# Putaway
# ---------------------------------------------------------------------------

class PutawayRead(_Read):
    """The task plus the labels the queue screen shows. The `*_name` fields are
    filled by the service from the masters, because `whs_warehouse_items` carries
    only ids — it is a work queue, not a document."""
    id: int
    putaway_no: str | None = None
    grn_id: int | None = None
    grn_no: str | None = None
    grn_item_id: int | None = None
    warehouse_id: int
    warehouse_name: str | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_id: int | None = None
    uom_code: str | None = None
    batch_id: int | None = None
    batch_no: str | None = None
    expiry_date: date | None = None
    qty: Decimal
    suggested_bin_id: int | None = None
    suggested_bin_code: str | None = None
    actual_bin_id: int | None = None
    actual_bin_code: str | None = None
    # Derived from the location tree, not stored — see service._ancestry.
    actual_bin_path: str | None = None
    # Stamped at confirm from the storage path; empty until the task is completed.
    lot_no: str | None = None
    putaway_type: str
    status: str
    assigned_to: int | None = None
    assigned_to_name: str | None = None
    scanned_by: int | None = None
    scanned_at: datetime | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    remarks: str | None = None
    serial_numbers: list[str] | None = None
    imei_numbers: list[str] | None = None
    is_serial_tracked: bool = False
    is_asset: bool = False
    created_at: datetime | None = None


class PutawayCreate(BaseModel):
    """Raise putaway tasks by hand, always against GRN lines.

    A task is normally raised by QC passing a line. This is the repair path, so it
    still points at the receipt it came from: a putaway with no GRN line behind it
    would put stock into a bin that nothing ever received. An empty `grn_item_ids`
    means every eligible line on the GRN.
    """
    grn_id: int
    grn_item_ids: list[int] = Field(default_factory=list)


class PutawayCandidate(BaseModel):
    """A GRN line offered to the manual putaway picker. Ineligible lines are returned
    too, carrying the reason — the screen shows them greyed out rather than hiding
    them, so "why is this one not here" never has to be asked."""
    grn_item_id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    batch_no: str | None = None
    accepted_qty: Decimal
    qc_status: str | None = None
    existing_putaway_no: str | None = None
    eligible: bool
    reason: str | None = None


class PutawayConfirm(BaseModel):
    actual_bin_id: int
    qty: Decimal | None = None
    remarks: str | None = None
    serial_numbers: list[str] | None = None
    imei_numbers: list[str] | None = None


class StockMovementWrite(BaseModel):
    movement_type: str = Field(default="BIN_TO_BIN", max_length=30)
    warehouse_id: int
    source_bin_id: int
    destination_bin_id: int
    item_id: int
    batch_id: int | None = None
    quantity: Decimal = Field(gt=0)
    serial_numbers: list[str] | None = None
    imei_numbers: list[str] | None = None
    remarks: str | None = Field(default=None, max_length=500)


class StockMovementRead(BaseModel):
    movement_no: str
    movement_type: str
    warehouse_id: int
    warehouse_name: str | None = None
    source_bin_id: int
    source_bin_code: str | None = None
    destination_bin_id: int
    destination_bin_code: str | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    batch_id: int | None = None
    batch_no: str | None = None
    quantity: Decimal
    serial_numbers: list[str] = Field(default_factory=list)
    status: str = "COMPLETED"
    moved_by_name: str | None = None
    moved_at: datetime | None = None
    remarks: str | None = None


class StockAvailabilityRead(BaseModel):
    available_qty: Decimal = Decimal("0")
    serial_numbers: list[str] = Field(default_factory=list)
    is_serial_tracked: bool = False


class StockMovementOrderItemWrite(BaseModel):
    item_id: int
    source_bin_id: int
    destination_bin_id: int
    quantity: Decimal = Field(gt=0)
    batch_id: int | None = None
    serial_numbers: list[str] | None = None

    @model_validator(mode='after')
    def check_bins(self):
        if self.source_bin_id == self.destination_bin_id:
            raise ValueError("Source location and destination location must not be the same")
        return self


class StockMovementOrderWrite(BaseModel):
    warehouse_id: int
    reason: str | None = Field(default=None, max_length=500)
    items: list[StockMovementOrderItemWrite] = Field(min_length=1)


class StockMovementOrderItemRead(BaseModel):
    """One line of a movement, read back off the ledger rows it wrote.

    No `id`: there is no line table. The document is its `order_no`, carried on every
    `stk_ledger` row the line produced.
    """
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    source_bin_id: int
    source_bin_code: str | None = None
    destination_bin_id: int
    destination_bin_code: str | None = None
    quantity: Decimal
    batch_id: int | None = None
    serial_numbers: list[str] | str | None = Field(default_factory=list)

    @field_validator("serial_numbers", mode="before")
    @classmethod
    def parse_serials(cls, v):
        if not v:
            return []
        if isinstance(v, str):
            return v.split(",")
        return v



class StockMovementOrderRead(BaseModel):
    """A movement document. `order_no` is its identity — see the item schema above.

    The list endpoint groups the ledger by `order_no` and cannot cheaply rebuild every
    line, so `items` is empty there and populated on create.
    """
    order_no: str
    warehouse_id: int
    warehouse_name: str | None = None
    status: str
    reason: str | None = None
    total_lines: int = 0
    created_by_name: str | None = None
    created_at: datetime | None = None
    items: list[StockMovementOrderItemRead] = Field(default_factory=list)

# ---------------------------------------------------------------------------
# Picking
# ---------------------------------------------------------------------------

class PickingItemWrite(BaseModel):
    item_id: int
    bin_id: int | None = None
    batch_id: int | None = None
    required_qty: Decimal


class PickingWrite(BaseModel):
    pick_date: date
    warehouse_id: int
    ref_type: str | None = None
    ref_id: int | None = None
    strategy: PickStrategy = PickStrategy.FEFO
    assigned_to_id: int | None = None
    items: list[PickingItemWrite] = []


class PickLine(BaseModel):
    picked_qty: Decimal
    bin_id: int | None = None


class PickingItemRead(_Read):
    id: int
    picking_id: int
    line_no: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    is_serial_tracked: bool = False
    bin_id: int | None = None
    bin_code: str | None = None
    batch_id: int | None = None
    batch_no: str | None = None
    required_qty: Decimal
    picked_qty: Decimal
    status: str
    picked_by_id: int | None = None
    picked_at: datetime | None = None


class PickingRead(_Read):
    id: int
    pick_no: str
    pick_date: date
    warehouse_id: int
    warehouse_name: str | None = None
    ref_type: str | None = None
    ref_id: int | None = None
    ref_no: str | None = None
    strategy: str | None = None
    status: str
    total_lines: int
    picked_lines: int
    assigned_to_id: int | None = None
    assigned_to_name: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    created_at: datetime | None = None


class PickingDetail(PickingRead):
    items: list[PickingItemRead] = []


# ---------------------------------------------------------------------------
# Issues
# ---------------------------------------------------------------------------

class IssueItemWrite(BaseModel):
    id: int | None = None
    indent_item_id: int | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    is_serial_tracked: bool = False
    bin_id: int | None = None
    batch_id: int | None = None
    requested_qty: Decimal
    issued_qty: Decimal | None = None
    rate: Decimal | None = None
    remarks: str | None = None
    serial_numbers: list[str] | None = None
    imei_numbers: list[str] | None = None


class IssueWrite(BaseModel):
    issue_type: IssueType = IssueType.DEPARTMENT
    issue_date: date
    indent_id: int | None = None
    picking_id: int | None = None
    warehouse_id: int
    department_id: int | None = None
    project_id: int | None = None
    vehicle_id: int | None = None
    # Typed, not picked: transport owns `trn_vehicles` and most site deliveries go on
    # a vehicle nobody registered there. Without this the number the store typed was
    # dropped on the way in and the column was written from `vehicle_id` alone.
    vehicle_number: str | None = Field(default=None, max_length=50)
    issued_to_id: int | None = None
    direction: IssueDirection = IssueDirection.OUT
    original_issue_id: int | None = None
    remarks: str | None = None
    items: list[IssueItemWrite] = []


class IssueItemRead(_Read):
    id: int
    issue_id: int
    line_no: int
    indent_item_id: int | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    is_serial_tracked: bool = False
    bin_id: int | None = None
    bin_code: str | None = None
    batch_id: int | None = None
    batch_no: str | None = None
    mfg_date: date | None = None
    expiry_date: date | None = None
    requested_qty: Decimal
    issued_qty: Decimal
    returned_qty: Decimal
    rate: Decimal | None = None
    amount: Decimal | None = None
    remarks: str | None = None
    is_imei_tracked: bool = False
    serial_numbers: list[str] | None = None
    imei_numbers: list[str] | None = None
    # Which identifier names one unit of this item — SERIAL, IMEI or CODE. The screen
    # validates on this one and shows the rest of the matched unit beside it.
    unit_mode: str | None = None
    # The reserved units, stated in that same currency.
    unit_keys: list[str] | None = None
    # Whether this item has identified units in stock at all, so a bulk consumable
    # line does not offer a picker with nothing in it.
    has_units: bool = False


class IssueRead(_Read):
    id: int
    issue_no: str
    issue_type: str
    issue_date: date
    indent_id: int | None = None
    indent_no: str | None = None
    picking_id: int | None = None
    pick_no: str | None = None
    warehouse_id: int
    warehouse_name: str | None = None
    department_id: int | None = None
    department_name: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    vehicle_id: int | None = None
    vehicle_number: str | None = None
    issued_to_id: int | None = None
    issued_to_name: str | None = None
    destination_office_id: int | None = None
    destination_office_name: str | None = None
    direction: str
    original_issue_id: int | None = None
    original_issue_no: str | None = None
    status: str
    total_items: int
    total_qty: Decimal
    total_value: Decimal
    is_stock_posted: bool
    posted_at: datetime | None = None
    current_approver_name: str | None = None
    approved_by_name: str | None = None
    approved_at: datetime | None = None
    acknowledged_by_name: str | None = None
    acknowledged_at: datetime | None = None
    issued_by_id: int | None = None
    issued_by_name: str | None = None
    remarks: str | None = None
    created_by_id: int | None = None
    created_by_name: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class IssueDetail(IssueRead):
    items: list[IssueItemRead] = []
    # True only for the person the document is waiting on RIGHT NOW. Holding the
    # permission is not enough: every warehouse post shares one HCM rank, so all
    # eleven of them hold `issue.issue` and a permission-gated button appeared for
    # all eleven on a document only one of them could act on.
    can_approve: bool = False
    # False until the indent raiser has confirmed this issue's quantities in My
    # Deliveries. The sending store must not be able to certify its own delivery.
    can_acknowledge: bool = False


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

class DispatchItemWrite(BaseModel):
    id: int | None = None
    package_id: int | None = None
    indent_id: int | None = None
    item_id: int
    batch_id: int | None = None
    serial_no: str | None = None
    quantity: Decimal
    rate: Decimal | None = None
    remarks: str | None = None


class DispatchWrite(BaseModel):
    dispatch_type: DispatchType = DispatchType.TRANSFER
    dispatch_date: date
    warehouse_id: int
    to_warehouse_id: int | None = None
    customer_id: int | None = None
    vendor_id: int | None = None
    project_id: int | None = None
    delivery_address: str | None = None
    contact_person: str | None = None
    contact_phone: str | None = None
    ref_type: str | None = None
    ref_id: int | None = None
    transport_mode: str | None = None
    carrier_id: int | None = None
    vehicle_id: int | None = None
    driver_name: str | None = None
    driver_phone: str | None = None
    lr_no: str | None = None
    eway_bill_no: str | None = None
    freight_amount: Decimal | None = None
    expected_delivery: date | None = None
    remarks: str | None = None
    items: list[DispatchItemWrite] = []


class PackageWrite(BaseModel):
    package_no: str | None = Field(default=None, max_length=50)
    package_type: str | None = None
    barcode: str | None = Field(default=None, max_length=100)
    weight_kg: Decimal | None = None
    length_cm: Decimal | None = None
    width_cm: Decimal | None = None
    height_cm: Decimal | None = None
    is_fragile: bool = False
    is_temp_controlled: bool = False
    item_ids: list[int] = []


class ConsignmentPackageItemWrite(BaseModel):
    indent_id: int | None = None
    item_id: int
    batch_id: int | None = None
    serial_no: str | None = None
    serial_numbers: list[str] = []
    quantity: Decimal
    rate: Decimal | None = None
    remarks: str | None = None


class ConsignmentPackageWrite(BaseModel):
    package_no: str | None = Field(default=None, max_length=50)
    package_type: str | None = Field(default="BOX", max_length=30)
    barcode: str | None = Field(default=None, max_length=100)
    weight_kg: Decimal | None = None
    length_cm: Decimal | None = None
    width_cm: Decimal | None = None
    height_cm: Decimal | None = None
    is_fragile: bool = False
    is_temp_controlled: bool = False
    items: list[ConsignmentPackageItemWrite] = []

    @field_validator("package_no", "package_type", "barcode", mode="before")
    @classmethod
    def blank_to_none(cls, value):
        return None if value == "" else value


class ConsignmentWrite(BaseModel):
    issue_id: int
    dispatch_type: DispatchType = DispatchType.TRANSFER
    dispatch_date: date
    to_warehouse_id: int | None = None
    customer_id: int | None = None
    vendor_id: int | None = None
    project_id: int | None = None
    delivery_address: str | None = None
    contact_person: str | None = None
    contact_phone: str | None = None
    transport_mode: str | None = "ROAD"
    carrier_id: int | None = None
    vehicle_id: int | None = None
    driver_name: str | None = None
    driver_phone: str | None = None
    lr_no: str | None = None
    eway_bill_no: str | None = None
    freight_amount: Decimal | None = None
    expected_delivery: date | None = None
    remarks: str | None = None
    packages: list[ConsignmentPackageWrite] = []


class DispatchEventWrite(BaseModel):
    event_type: DispatchEventType
    location_name: str | None = None
    latitude: Decimal | None = None
    longitude: Decimal | None = None
    temperature_c: Decimal | None = None
    humidity_percent: Decimal | None = None
    notes: str | None = None


class AcknowledgeLine(BaseModel):
    id: int
    delivered_qty: Decimal


class AcknowledgeWrite(BaseModel):
    acknowledged_by_name: str | None = None
    pod_url: str | None = None
    remarks: str | None = None
    lines: list[AcknowledgeLine] = []


class DispatchItemRead(_Read):
    id: int
    dispatch_id: int
    line_no: int
    package_id: int | None = None
    indent_id: int | None = None
    indent_no: str | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    batch_id: int | None = None
    batch_no: str | None = None
    mfg_date: date | None = None
    expiry_date: date | None = None
    serial_no: str | None = None
    imei_no: str | None = None
    quantity: Decimal
    delivered_qty: Decimal
    rate: Decimal | None = None
    amount: Decimal | None = None
    remarks: str | None = None


class DispatchPackageRead(_Read):
    id: int
    dispatch_id: int
    package_no: str
    package_type: str | None = None
    barcode: str | None = None
    weight_kg: Decimal | None = None
    length_cm: Decimal | None = None
    width_cm: Decimal | None = None
    height_cm: Decimal | None = None
    is_fragile: bool
    is_temp_controlled: bool
    status: str
    packed_by_name: str | None = None
    packed_at: datetime | None = None


class DispatchEventRead(_Read):
    id: int
    dispatch_id: int
    event_type: str
    event_at: datetime
    location_name: str | None = None
    latitude: Decimal | None = None
    longitude: Decimal | None = None
    temperature_c: Decimal | None = None
    humidity_percent: Decimal | None = None
    is_breach: bool
    notes: str | None = None
    recorded_by_id: int | None = None
    recorded_by_name: str | None = None


class DispatchRead(_Read):
    id: int
    dispatch_no: str
    dispatch_type: str
    dispatch_date: date
    warehouse_id: int
    warehouse_name: str | None = None
    to_warehouse_id: int | None = None
    to_warehouse_name: str | None = None
    customer_id: int | None = None
    customer_name: str | None = None
    vendor_id: int | None = None
    vendor_name: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    destination_office_id: int | None = None
    destination_office_name: str | None = None
    # Set on the detail read only: this consignment landed at a relay point that put it
    # straight on the shelf, so the way on from here is the consignment, not a GRN.
    can_forward: bool = False
    delivery_address: str | None = None
    contact_person: str | None = None
    contact_phone: str | None = None
    ref_type: str | None = None
    ref_id: int | None = None
    ref_no: str | None = None
    transport_mode: str | None = None
    carrier_id: int | None = None
    carrier_name: str | None = None
    vehicle_id: int | None = None
    vehicle_number: str | None = None
    driver_name: str | None = None
    driver_phone: str | None = None
    lr_no: str | None = None
    eway_bill_no: str | None = None
    freight_amount: Decimal | None = None
    gate_pass_no: str | None = None
    gate_out_at: datetime | None = None
    security_by_name: str | None = None
    status: str
    total_items: int
    total_qty: Decimal
    total_packages: int
    total_weight_kg: Decimal
    total_value: Decimal
    expected_delivery: date | None = None
    delivered_at: datetime | None = None
    acknowledged_by_name: str | None = None
    acknowledged_at: datetime | None = None
    pod_url: str | None = None
    current_approver_name: str | None = None
    approved_by_name: str | None = None
    approved_at: datetime | None = None
    remarks: str | None = None
    created_by_id: int | None = None
    created_by_name: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class DispatchDetail(DispatchRead):
    items: list[DispatchItemRead] = []
    packages: list[DispatchPackageRead] = []
    events: list[DispatchEventRead] = []
    #: See IssueDetail.can_approve.
    can_approve: bool = False


# ---------------------------------------------------------------------------
# Purchase returns
# ---------------------------------------------------------------------------

class ReturnItemWrite(BaseModel):
    id: int | None = None
    po_item_id: int | None = None
    grn_item_id: int | None = None
    item_id: int
    batch_id: int | None = None
    quantity: Decimal
    rate: Decimal | None = None
    reason: str | None = None


class ReturnWrite(BaseModel):
    return_date: date
    po_id: int | None = None
    grn_id: int | None = None
    vendor_id: int | None = None
    warehouse_id: int | None = None
    reason: str | None = None
    items: list[ReturnItemWrite] = []


class ReturnItemRead(_Read):
    id: int
    return_id: int
    line_no: int
    po_item_id: int | None = None
    grn_item_id: int | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    batch_id: int | None = None
    batch_no: str | None = None
    quantity: Decimal
    rate: Decimal | None = None
    amount: Decimal | None = None
    reason: str | None = None


class ReturnRead(_Read):
    id: int
    return_no: str
    return_date: date
    po_id: int | None = None
    po_no: str | None = None
    grn_id: int | None = None
    grn_no: str | None = None
    vendor_id: int | None = None
    vendor_name: str | None = None
    warehouse_id: int | None = None
    warehouse_name: str | None = None
    reason: str | None = None
    status: str
    total_items: int
    total_qty: Decimal
    total_value: Decimal
    credit_note_no: str | None = None
    created_by_id: int | None = None
    created_by_name: str | None = None
    created_at: datetime | None = None


class ReturnDetail(ReturnRead):
    items: list[ReturnItemRead] = []
    #: See IssueDetail.can_approve.
    can_approve: bool = False


# ---------------------------------------------------------------------------
# Supporting
# ---------------------------------------------------------------------------

class BatchRead(_Read):
    id: int
    batch_no: str
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    is_asset: bool = False
    vendor_id: int | None = None
    vendor_name: str | None = None
    mfg_date: date | None = None
    expiry_date: date | None = None
    received_date: date | None = None
    grn_id: int | None = None
    grn_no: str | None = None
    initial_qty: Decimal
    rate: Decimal | None = None
    status: str
    recall_reason: str | None = None


class SerialRead(_Read):
    id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    is_asset: bool = False
    serial_number: str
    imei: str | None = None
    batch_id: int | None = None
    batch_no: str | None = None
    mfg_date: date | None = None
    expiry_date: date | None = None
    warehouse_id: int | None = None
    warehouse_name: str | None = None
    bin_id: int | None = None
    bin_code: str | None = None
    asset_code: str | None = None
    consumable_code: str | None = None
    status: str
    remarks: str | None = None
    is_active: bool


class AttachmentRead(_Read):
    id: int
    entity_type: str
    entity_id: int
    file_name: str
    file_path: str
    file_size: int | None = None
    mime_type: str | None = None
    doc_category: str | None = None
    uploaded_by_id: int | None = None
    uploaded_by_name: str | None = None
    created_at: datetime | None = None


class NotificationRead(_Read):
    id: int
    employee_id: int
    title: str
    body: str | None = None
    entity_type: str | None = None
    entity_id: int | None = None
    deep_link: str | None = None
    is_read: bool
    created_at: datetime | None = None


class ScanResult(BaseModel):
    """What a scanned code turned out to be."""
    kind: str
    id: int
    doc_no: str | None = None
    deep_link: str | None = None


class Option(BaseModel):
    id: int
    code: str | None = None
    name: str
    is_bin_managed: bool | None = None
    # Only warehouse options carry this. It tells a form whether it is standing at a
    # main store or at an MDP / LIP, which is what decides the shape of the GRN.
    warehouse_type: str | None = None


class ItemOption(Option):
    uom_code: str | None = None
    is_batch_tracked: bool = False
    is_serial_tracked: bool = False
    is_imei_tracked: bool = False
    has_expiry: bool = False
    is_asset: bool = False
    requires_qi: bool = False


class IndentIssueSource(BaseModel):
    indent_id: int
    indent_no: str
    warehouse_id: int
    department_id: int | None = None
    project_id: int | None = None
    # True when some reserved stock was received for a different project (or for
    # none). Informational: the screen says so, nothing blocks the issue.
    mixed_projects: bool = False
    issued_to_id: int | None = None
    # Carried beside the id because the employee dropdown holds only its first page:
    # without the name the form has a value it cannot label, and shows a placeholder.
    issued_to_name: str | None = None
    vehicle_id: int | None = None
    vehicle_number: str | None = None
    destination_office_id: int | None = None
    destination_office_name: str | None = None
    items: list[IssueItemWrite] = []


class PickingIssueSource(BaseModel):
    picking_id: int
    warehouse_id: int
    indent_id: int | None = None
    department_id: int | None = None
    project_id: int | None = None
    mixed_projects: bool = False
    issued_to_id: int | None = None
    issued_to_name: str | None = None
    vehicle_id: int | None = None
    vehicle_number: str | None = None
    items: list[IssueItemWrite] = []


class IssueDispatchSourceItem(DispatchItemWrite):
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    batch_no: str | None = None
    # Snapshotted on the issue line, not re-derived downstream — see
    # `out_dispatch_items.mfg_date` for why the consignment carries them itself.
    mfg_date: date | None = None
    expiry_date: date | None = None
    is_serial_tracked: bool = False
    is_imei_tracked: bool = False
    serial_numbers: list[str] = []
    # serial -> IMEI, so the packing screen shows the handset's number beside the
    # unit it belongs to rather than making the receiving point retype it.
    imei_by_serial: dict[str, str] = {}


class IssueDispatchSource(BaseModel):
    issue_id: int
    issue_no: str
    warehouse_id: int
    project_id: int | None = None
    destination_office_id: int | None = None
    destination_office_name: str | None = None
    # The stocking point serving the requesting office — what "To warehouse" defaults
    # to. Blank when that point IS the origin, which `destination_is_origin` explains.
    destination_warehouse_id: int | None = None
    destination_warehouse_name: str | None = None
    destination_is_origin: bool = False
    items: list[IssueDispatchSourceItem] = []


class ReasonIn(BaseModel):
    """The body every cancel/skip endpoint takes."""
    reason: str | None = None


class ApprovalIn(BaseModel):
    comments: str = ""


class GatePassIn(BaseModel):
    gate_pass_no: str | None = None


class CreditNoteIn(BaseModel):
    credit_note_no: str | None = None


class AcknowledgeIssueIn(BaseModel):
    remarks: str | None = None


class IssueSerialLineIn(BaseModel):
    """One line's physical units, named after approval."""
    id: int
    serial_numbers: list[str] = Field(default_factory=list)


class IssueSerialsIn(BaseModel):
    """Serial capture on an approved, unposted issue.

    A draft is created by inventory when it approves an allocation, and inventory
    has no idea which physical units the storekeeper will pick. post_issue demands
    the full set, so without a way to name them after approval a serialized issue
    could never be posted at all.
    """
    lines: list[IssueSerialLineIn]


class DashboardRead(BaseModel):
    """Queue depths, computed server-side so the screen makes one call."""
    pending_gate_entries: int = 0
    pending_grn: int = 0
    pending_inspections: int = 0
    pending_putaways: int = 0
    open_picklists: int = 0
    pending_issues: int = 0
    in_transit_dispatches: int = 0
    open_returns: int = 0
    stock_value: Decimal = Decimal("0")
    bin_utilisation_percent: Decimal = Decimal("0")
    recent: list[dict] = []
    inward_trend: list[dict] = []


class ReportColumn(BaseModel):
    key: str
    header: str
    numeric: bool = False


class ReportResult(BaseModel):
    """Reports carry their own columns, so a new report needs no frontend change."""
    columns: list[ReportColumn]
    rows: list[dict]
    total: int


BinRead.model_rebuild()


class IssueBatchIn(BaseModel):
    """The issues to post in one go — a whole monthly cycle, usually."""
    issue_ids: list[int]
