"""ORM mapping for the warehouse tables. The schema is frozen — nothing here
creates, drops or alters a column, and there is no migration for this module.

Only the columns the app reads or writes are mapped. Several tables carry NOT NULL
columns with database defaults (`inb_receipts.receipt_type`, `whs_warehouse_items.
status`, `out_dispatch_packages.status`); mapping one and passing None sends an
explicit NULL that overrides the default and raises MySQL 1048, so every such column
carries the same default on this side.

`whs_warehouses` and `whs_bins` are already mapped in `app/shared/models/warehouse.py`
and are imported, never redefined — two mappers on one table is a startup error.

Snapshot columns (`item_code`, `item_name`, `uom_code`, every `*_name`) are written
at creation and never refreshed. A GRN raised in March must keep saying what the
vendor was called in March.
"""
from sqlalchemy import (
    JSON, BigInteger, Boolean, Column, Date, DateTime, ForeignKey, Index, Integer,
    Numeric, String, Text,
)
from sqlalchemy.orm import relationship, synonym

from app.core.database import Base
from app.modules.warehouse.enums import (
    BatchStatus,
    DispatchStatus,
    InspectionResult,
    InspectionStatus,
    IssueStatus,
    PackageStatus,
    PickLineStatus,
    PickingStatus,
    PutawayStatus,
    PutawayType,
    QcStatus,
    ReceiptStatus,
    ReceiptType,
    ReturnStatus,
    SerialStatus,
)
from app.shared.models.base import created_at_col, pk, soft_fk, updated_at_col
# Re-exported so the rest of the module has one import site for its tables.
from app.shared.models.warehouse import Bin, Warehouse  # noqa: F401

# 0 rather than NULL: these columns are NOT NULL in the schema and "no bin" /
# "no batch" is expressed as 0, matching how inventory's stk_balance already works.
NO_BIN = 0
NO_BATCH = 0

QTY = Numeric(16, 3)
MONEY = Numeric(16, 2)
RATE = Numeric(16, 4)


# ---------------------------------------------------------------------------
# Inward — gate entry, GRN
# ---------------------------------------------------------------------------

class Receipt(Base):
    """`inb_receipts`. One row is a gate entry first and a GRN afterwards;
    `receipt_type` says which, so the vehicle and paperwork are captured once."""
    __tablename__ = "inb_receipts"

    id = pk()
    grn_no = Column(String(50), nullable=False, unique=True)
    receipt_type = Column(String(30), nullable=False, default=ReceiptType.PURCHASE.value)
    grn_date = Column(Date, nullable=False)

    po_id = Column(BigInteger, index=True, nullable=True)
    po_no = Column(String(50), nullable=True)
    transfer_id = Column(BigInteger, nullable=True)
    transfer_no = Column(String(50), nullable=True)

    vendor_id = Column(BigInteger, index=True, nullable=True)
    vendor_name = Column(String(200), nullable=True)
    vendor_gstin = Column(String(20), nullable=True)

    warehouse_id = Column(BigInteger, index=True, nullable=False)
    warehouse_name = Column(String(200), nullable=True)
    project_id = Column(BigInteger, nullable=True)
    project_name = Column(String(200), nullable=True)

    invoice_no = Column(String(50), nullable=True)
    invoice_date = Column(Date, nullable=True)
    invoice_amount = Column(MONEY, nullable=True)
    eway_bill_no = Column(String(50), nullable=True)
    vehicle_no = Column(String(50), nullable=True)
    transporter_name = Column(String(200), nullable=True)
    lr_no = Column(String(50), nullable=True)
    gate_entry_no = Column(String(50), nullable=True)
    gate_entry_at = Column(DateTime, nullable=True)

    status = Column(String(30), nullable=False, default=ReceiptStatus.DRAFT.value)

    # Rollups, recomputed from the lines on every write so a list screen reads one row.
    total_items = Column(Integer, nullable=False, default=0)
    total_received_qty = Column(QTY, nullable=False, default=0)
    total_accepted_qty = Column(QTY, nullable=False, default=0)
    total_rejected_qty = Column(QTY, nullable=False, default=0)
    total_value = Column(MONEY, nullable=False, default=0)

    is_stock_posted = Column(Boolean, nullable=False, default=False)
    posted_at = Column(DateTime, nullable=True)

    received_by_id = soft_fk()
    received_by_name = Column(String(200), nullable=True)
    remarks = Column(Text, nullable=True)
    created_by_id = soft_fk()
    created_by_name = Column(String(200), nullable=True)
    created_at = created_at_col()
    updated_at = updated_at_col()

    items = relationship(
        "ReceiptItem", back_populates="receipt",
        cascade="all, delete-orphan", order_by="ReceiptItem.line_no",
    )


Index("ix_inb_receipts_status_wh", Receipt.status, Receipt.warehouse_id)


class ReceiptItem(Base):
    """`inb_receipt_items`. `rejected_qty` and `short_qty` are derived on write —
    the service computes them, so the three quantities cannot disagree."""
    __tablename__ = "inb_receipt_items"

    id = pk()
    receipt_id = Column(ForeignKey("inb_receipts.id", ondelete="CASCADE"),
                        index=True, nullable=False)
    line_no = Column(Integer, nullable=False, default=1)

    po_item_id = Column(BigInteger, nullable=True)
    indent_id = Column(BigInteger, nullable=True)
    indent_no = Column(String(50), nullable=True)

    item_id = Column(BigInteger, index=True, nullable=False)
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    uom_code = Column(String(20), nullable=True)

    ordered_qty = Column(QTY, nullable=False, default=0)
    received_qty = Column(QTY, nullable=False, default=0)
    accepted_qty = Column(QTY, nullable=False, default=0)
    rejected_qty = Column(QTY, nullable=False, default=0)
    short_qty = Column(QTY, nullable=False, default=0)
    rate = Column(RATE, nullable=True)
    amount = Column(MONEY, nullable=True)

    batch_id = Column(BigInteger, nullable=False, default=NO_BATCH)
    batch_no = Column(String(50), nullable=True)
    mfg_date = Column(Date, nullable=True)
    expiry_date = Column(Date, nullable=True)
    bin_id = Column(BigInteger, nullable=False, default=NO_BIN)
    bin_code = Column(String(50), nullable=True)

    qc_status = Column(String(30), nullable=False, default=QcStatus.PENDING.value)
    rejection_reason = Column(String(300), nullable=True)
    remarks = Column(String(500), nullable=True)
    serial_numbers = Column(JSON, nullable=True)

    receipt = relationship("Receipt", back_populates="items")


# ---------------------------------------------------------------------------
# Quality
# ---------------------------------------------------------------------------

class Inspection(Base):
    """`inb_inspections`. `inspection_type` separates incoming QC from the outward
    check before a consignment leaves — one table, two points in the flow."""
    __tablename__ = "inb_inspections"

    id = pk()
    inspection_no = Column(String(50), nullable=False, unique=True)
    inspection_date = Column(Date, nullable=False)

    receipt_id = Column(BigInteger, index=True, nullable=True)
    grn_no = Column(String(50), nullable=True)
    warehouse_id = Column(BigInteger, index=True, nullable=True)
    warehouse_name = Column(String(200), nullable=True)
    vendor_id = Column(BigInteger, nullable=True)
    vendor_name = Column(String(200), nullable=True)

    inspection_type = Column(String(30), nullable=False, default="INCOMING")
    status = Column(String(30), nullable=False, default=InspectionStatus.DRAFT.value)

    total_items = Column(Integer, nullable=False, default=0)
    passed_items = Column(Integer, nullable=False, default=0)
    failed_items = Column(Integer, nullable=False, default=0)

    inspector_id = soft_fk()
    inspector_name = Column(String(200), nullable=True)
    remarks = Column(Text, nullable=True)
    created_at = created_at_col()

    items = relationship(
        "InspectionItem", back_populates="inspection",
        cascade="all, delete-orphan", order_by="InspectionItem.id",
    )


class InspectionItem(Base):
    """`inb_inspection_items`. `parameters` holds what was measured — a failure with
    no reading behind it is not something a vendor can be held to."""
    __tablename__ = "inb_inspection_items"

    id = pk()
    inspection_id = Column(ForeignKey("inb_inspections.id", ondelete="CASCADE"),
                           index=True, nullable=False)
    receipt_item_id = Column(BigInteger, nullable=True)

    item_id = Column(BigInteger, index=True, nullable=False)
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    uom_code = Column(String(20), nullable=True)
    batch_no = Column(String(50), nullable=True)

    inspected_qty = Column(QTY, nullable=False, default=0)
    accepted_qty = Column(QTY, nullable=False, default=0)
    rejected_qty = Column(QTY, nullable=False, default=0)

    parameters = Column(JSON, nullable=True)
    result = Column(String(20), nullable=False, default=InspectionResult.PENDING.value)
    defect_type = Column(String(100), nullable=True)
    rejection_reason = synonym("defect_type")
    remarks = Column(String(500), nullable=True)
    serial_numbers = Column(JSON, nullable=True)

    inspection = relationship("Inspection", back_populates="items")


# ---------------------------------------------------------------------------
# Putaway
# ---------------------------------------------------------------------------

class PutawayTask(Base):
    """`whs_warehouse_items`. One task per received line, because putting away is
    done a pallet at a time and a task covering eight lines cannot be half done.

    `status` and `putaway_type` are MySQL ENUMs with lower-case members; the values
    come from `enums.PutawayStatus` / `PutawayType` and must not be upper-cased.
    """
    __tablename__ = "whs_warehouse_items"

    id = pk()
    putaway_no = Column(String(50), nullable=True)
    grn_id = Column(BigInteger, index=True, nullable=True)
    grn_item_id = Column(BigInteger, nullable=True)
    warehouse_id = Column(BigInteger, index=True, nullable=False)
    item_id = Column(BigInteger, index=True, nullable=False)
    batch_id = Column(BigInteger, nullable=True)
    uom_id = Column(BigInteger, nullable=True)
    qty = Column(Numeric(15, 3), nullable=False, default=0)

    suggested_bin_id = Column(BigInteger, nullable=True)
    actual_bin_id = Column(BigInteger, nullable=True)

    putaway_type = Column(
        String(20), nullable=False, default=PutawayType.SYSTEM_DIRECTED.value
    )
    status = Column(String(20), nullable=False, default=PutawayStatus.PENDING.value)

    assigned_to = soft_fk()
    scanned_by = soft_fk()
    scanned_at = Column(DateTime, nullable=True)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    remarks = Column(String(500), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = created_at_col()
    updated_at = updated_at_col()


Index("ix_whs_warehouse_items_status", PutawayTask.status, PutawayTask.warehouse_id)


# ---------------------------------------------------------------------------
# Outward — picking, issues, dispatch
# ---------------------------------------------------------------------------

class Picking(Base):
    """`out_picking`. `picked_lines` is maintained as lines are picked so a hundred
    open picklists stay one query rather than a hundred line counts."""
    __tablename__ = "out_picking"

    id = pk()
    pick_no = Column(String(50), nullable=False, unique=True)
    pick_date = Column(Date, nullable=False)
    warehouse_id = Column(BigInteger, index=True, nullable=False)
    warehouse_name = Column(String(200), nullable=True)

    ref_type = Column(String(30), nullable=True)
    ref_id = Column(BigInteger, nullable=True)
    ref_no = Column(String(50), nullable=True)

    strategy = Column(String(20), nullable=True, default="FEFO")
    status = Column(String(30), nullable=False, default=PickingStatus.DRAFT.value)

    total_lines = Column(Integer, nullable=False, default=0)
    picked_lines = Column(Integer, nullable=False, default=0)

    assigned_to_id = soft_fk()
    assigned_to_name = Column(String(200), nullable=True)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    created_at = created_at_col()

    items = relationship(
        "PickingItem", back_populates="picking",
        cascade="all, delete-orphan", order_by="PickingItem.line_no",
    )


class PickingItem(Base):
    """`out_picking_items`."""
    __tablename__ = "out_picking_items"

    id = pk()
    picking_id = Column(ForeignKey("out_picking.id", ondelete="CASCADE"),
                        index=True, nullable=False)
    line_no = Column(Integer, nullable=False, default=1)

    item_id = Column(BigInteger, index=True, nullable=False)
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    uom_code = Column(String(20), nullable=True)

    bin_id = Column(BigInteger, nullable=True)
    bin_code = Column(String(50), nullable=True)
    batch_id = Column(BigInteger, nullable=True)
    batch_no = Column(String(50), nullable=True)

    required_qty = Column(QTY, nullable=False, default=0)
    picked_qty = Column(QTY, nullable=False, default=0)
    status = Column(String(30), nullable=False, default=PickLineStatus.PENDING.value)
    picked_by_id = soft_fk()
    picked_at = Column(DateTime, nullable=True)

    picking = relationship("Picking", back_populates="items")


class MaterialIssue(Base):
    """`out_issues`. `direction` pairs an issue with the return that reverses it,
    which is what lets `original_issue_id` point somewhere real."""
    __tablename__ = "out_issues"

    id = pk()
    issue_no = Column(String(50), nullable=False, unique=True)
    issue_type = Column(String(30), nullable=False, default="DEPARTMENT")
    issue_date = Column(Date, nullable=False)

    indent_id = Column(BigInteger, index=True, nullable=True)
    indent_no = Column(String(50), nullable=True)
    picking_id = Column(BigInteger, nullable=True)
    pick_no = Column(String(50), nullable=True)

    warehouse_id = Column(BigInteger, index=True, nullable=False)
    warehouse_name = Column(String(200), nullable=True)
    department_id = soft_fk()
    department_name = Column(String(200), nullable=True)
    project_id = Column(BigInteger, nullable=True)
    project_name = Column(String(200), nullable=True)
    vehicle_id = Column(BigInteger, nullable=True)
    vehicle_number = Column(String(50), nullable=True)
    issued_to_id = soft_fk()
    issued_to_name = Column(String(200), nullable=True)

    direction = Column(String(3), nullable=False, default="OUT")
    original_issue_id = Column(BigInteger, nullable=True)
    original_issue_no = Column(String(50), nullable=True)

    status = Column(String(30), nullable=False, default=IssueStatus.DRAFT.value)
    total_items = Column(Integer, nullable=False, default=0)
    total_qty = Column(QTY, nullable=False, default=0)
    total_value = Column(MONEY, nullable=False, default=0)

    is_stock_posted = Column(Boolean, nullable=False, default=False)
    posted_at = Column(DateTime, nullable=True)

    # Snapshots of where the workflow got to, so a list screen never has to ask the
    # engine who is holding each of two hundred documents.
    current_approver_name = Column(String(200), nullable=True)
    approved_by_name = Column(String(200), nullable=True)
    approved_at = Column(DateTime, nullable=True)
    acknowledged_by_name = Column(String(200), nullable=True)
    acknowledged_at = Column(DateTime, nullable=True)

    issued_by_id = soft_fk()
    issued_by_name = Column(String(200), nullable=True)
    remarks = Column(Text, nullable=True)
    created_by_id = soft_fk()
    created_by_name = Column(String(200), nullable=True)
    created_at = created_at_col()
    updated_at = updated_at_col()

    items = relationship(
        "MaterialIssueLine", back_populates="issue",
        cascade="all, delete-orphan", order_by="MaterialIssueLine.line_no",
    )


Index("ix_out_issues_status_dir", MaterialIssue.status, MaterialIssue.direction)


class MaterialIssueLine(Base):
    """`out_issue_items`. `requested_qty` and `issued_qty` are both kept: a short
    issue has to stay visible as a short issue."""
    __tablename__ = "out_issue_items"

    id = pk()
    issue_id = Column(ForeignKey("out_issues.id", ondelete="CASCADE"),
                      index=True, nullable=False)
    line_no = Column(Integer, nullable=False, default=1)
    indent_item_id = Column(BigInteger, nullable=True)

    item_id = Column(BigInteger, index=True, nullable=False)
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    uom_code = Column(String(20), nullable=True)

    bin_id = Column(BigInteger, nullable=True)
    bin_code = Column(String(50), nullable=True)
    batch_id = Column(BigInteger, nullable=True)
    batch_no = Column(String(50), nullable=True)
    expiry_date = Column(Date, nullable=True)

    requested_qty = Column(QTY, nullable=False, default=0)
    issued_qty = Column(QTY, nullable=False, default=0)
    returned_qty = Column(QTY, nullable=False, default=0)
    rate = Column(RATE, nullable=True)
    amount = Column(MONEY, nullable=True)
    remarks = Column(String(500), nullable=True)

    issue = relationship("MaterialIssue", back_populates="items")


class Dispatch(Base):
    """`out_dispatches`."""
    __tablename__ = "out_dispatches"

    id = pk()
    dispatch_no = Column(String(50), nullable=False, unique=True)
    dispatch_type = Column(String(30), nullable=False, default="TRANSFER")
    dispatch_date = Column(Date, nullable=False)

    warehouse_id = Column(BigInteger, index=True, nullable=False)
    warehouse_name = Column(String(200), nullable=True)
    to_warehouse_id = Column(BigInteger, nullable=True)
    to_warehouse_name = Column(String(200), nullable=True)
    customer_id = Column(BigInteger, nullable=True)
    customer_name = Column(String(200), nullable=True)
    vendor_id = Column(BigInteger, nullable=True)
    vendor_name = Column(String(200), nullable=True)
    project_id = Column(BigInteger, nullable=True)
    project_name = Column(String(200), nullable=True)

    delivery_address = Column(String(500), nullable=True)
    contact_person = Column(String(200), nullable=True)
    contact_phone = Column(String(20), nullable=True)

    ref_type = Column(String(30), nullable=True)
    ref_id = Column(BigInteger, nullable=True)
    ref_no = Column(String(50), nullable=True)

    transport_mode = Column(String(30), nullable=True)
    carrier_id = Column(BigInteger, nullable=True)
    carrier_name = Column(String(200), nullable=True)
    vehicle_id = Column(BigInteger, nullable=True)
    vehicle_number = Column(String(50), nullable=True)
    driver_name = Column(String(200), nullable=True)
    driver_phone = Column(String(20), nullable=True)
    lr_no = Column(String(50), nullable=True)
    eway_bill_no = Column(String(50), nullable=True)
    freight_amount = Column(MONEY, nullable=True)

    gate_pass_no = Column(String(50), nullable=True)
    gate_out_at = Column(DateTime, nullable=True)
    security_by_name = Column(String(200), nullable=True)

    status = Column(String(30), nullable=False, default=DispatchStatus.DRAFT.value)
    total_items = Column(Integer, nullable=False, default=0)
    total_qty = Column(QTY, nullable=False, default=0)
    total_packages = Column(Integer, nullable=False, default=0)
    total_weight_kg = Column(QTY, nullable=False, default=0)
    total_value = Column(MONEY, nullable=False, default=0)

    expected_delivery = Column(Date, nullable=True)
    delivered_at = Column(DateTime, nullable=True)
    acknowledged_by_name = Column(String(200), nullable=True)
    acknowledged_at = Column(DateTime, nullable=True)
    pod_url = Column(String(500), nullable=True)

    current_approver_name = Column(String(200), nullable=True)
    approved_by_name = Column(String(200), nullable=True)
    approved_at = Column(DateTime, nullable=True)

    remarks = Column(Text, nullable=True)
    created_by_id = soft_fk()
    created_by_name = Column(String(200), nullable=True)
    created_at = created_at_col()
    updated_at = updated_at_col()

    items = relationship(
        "DispatchItem", back_populates="dispatch",
        cascade="all, delete-orphan", order_by="DispatchItem.line_no",
    )
    packages = relationship(
        "DispatchPackage", back_populates="dispatch",
        cascade="all, delete-orphan", order_by="DispatchPackage.id",
    )
    events = relationship(
        "DispatchEvent", back_populates="dispatch",
        cascade="all, delete-orphan", order_by="DispatchEvent.event_at",
    )


class DispatchItem(Base):
    """`out_dispatch_items`. `package_id` records which carton a line went into —
    the thing an "it arrived short" call needs."""
    __tablename__ = "out_dispatch_items"

    id = pk()
    dispatch_id = Column(ForeignKey("out_dispatches.id", ondelete="CASCADE"),
                         index=True, nullable=False)
    line_no = Column(Integer, nullable=False, default=1)
    package_id = Column(BigInteger, nullable=True)

    indent_id = Column(BigInteger, nullable=True)
    indent_no = Column(String(50), nullable=True)

    item_id = Column(BigInteger, index=True, nullable=False)
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    uom_code = Column(String(20), nullable=True)
    batch_id = Column(BigInteger, nullable=True)
    batch_no = Column(String(50), nullable=True)
    serial_no = Column(String(100), nullable=True)

    quantity = Column(QTY, nullable=False, default=0)
    delivered_qty = Column(QTY, nullable=False, default=0)
    rate = Column(RATE, nullable=True)
    amount = Column(MONEY, nullable=True)
    remarks = Column(String(500), nullable=True)

    dispatch = relationship("Dispatch", back_populates="items")


class DispatchPackage(Base):
    """`out_dispatch_packages` — the labelling unit."""
    __tablename__ = "out_dispatch_packages"

    id = pk()
    dispatch_id = Column(ForeignKey("out_dispatches.id", ondelete="CASCADE"),
                         index=True, nullable=False)
    package_no = Column(String(50), nullable=False)
    package_type = Column(String(30), nullable=True)
    barcode = Column(String(100), nullable=True)

    weight_kg = Column(QTY, nullable=True)
    length_cm = Column(Numeric(10, 2), nullable=True)
    width_cm = Column(Numeric(10, 2), nullable=True)
    height_cm = Column(Numeric(10, 2), nullable=True)

    is_fragile = Column(Boolean, nullable=False, default=False)
    is_temp_controlled = Column(Boolean, nullable=False, default=False)
    status = Column(String(30), nullable=False, default=PackageStatus.PACKED.value)
    packed_by_name = Column(String(200), nullable=True)
    packed_at = Column(DateTime, nullable=True)

    dispatch = relationship("Dispatch", back_populates="packages")


class DispatchEvent(Base):
    """`out_dispatch_events` — the custody and cold-chain trail. Append-only:
    a temperature reading is evidence, and evidence is not edited."""
    __tablename__ = "out_dispatch_events"

    id = pk()
    dispatch_id = Column(ForeignKey("out_dispatches.id", ondelete="CASCADE"),
                         index=True, nullable=False)
    event_type = Column(String(30), nullable=False)
    event_at = Column(DateTime, nullable=False)

    location_name = Column(String(200), nullable=True)
    latitude = Column(Numeric(10, 7), nullable=True)
    longitude = Column(Numeric(10, 7), nullable=True)
    temperature_c = Column(Numeric(6, 2), nullable=True)
    humidity_percent = Column(Numeric(6, 2), nullable=True)
    is_breach = Column(Boolean, nullable=False, default=False)
    notes = Column(String(500), nullable=True)

    recorded_by_id = soft_fk()
    recorded_by_name = Column(String(200), nullable=True)
    created_at = created_at_col()

    dispatch = relationship("Dispatch", back_populates="events")


# ---------------------------------------------------------------------------
# Purchase returns
# ---------------------------------------------------------------------------

class PurchaseReturn(Base):
    """`pro_returns`. Owned here rather than in procurement because the goods
    physically leave a warehouse, and it is the store that sends them back."""
    __tablename__ = "pro_returns"

    id = pk()
    return_no = Column(String(50), nullable=False, unique=True)
    return_date = Column(Date, nullable=False)

    po_id = Column(BigInteger, nullable=True)
    po_no = Column(String(50), nullable=True)
    grn_id = Column(BigInteger, index=True, nullable=True)
    grn_no = Column(String(50), nullable=True)

    vendor_id = Column(BigInteger, index=True, nullable=True)
    vendor_name = Column(String(200), nullable=True)
    warehouse_id = Column(BigInteger, index=True, nullable=True)
    warehouse_name = Column(String(200), nullable=True)

    reason = Column(String(500), nullable=True)
    status = Column(String(30), nullable=False, default=ReturnStatus.DRAFT.value)

    total_items = Column(Integer, nullable=False, default=0)
    total_qty = Column(QTY, nullable=False, default=0)
    total_value = Column(MONEY, nullable=False, default=0)
    credit_note_no = Column(String(50), nullable=True)

    created_by_id = soft_fk()
    created_by_name = Column(String(200), nullable=True)
    created_at = created_at_col()

    items = relationship(
        "PurchaseReturnItem", back_populates="parent",
        cascade="all, delete-orphan", order_by="PurchaseReturnItem.line_no",
    )


class PurchaseReturnItem(Base):
    """`pro_return_items`."""
    __tablename__ = "pro_return_items"

    id = pk()
    return_id = Column(ForeignKey("pro_returns.id", ondelete="CASCADE"),
                       index=True, nullable=False)
    line_no = Column(Integer, nullable=False, default=1)

    po_item_id = Column(BigInteger, nullable=True)
    grn_item_id = Column(BigInteger, nullable=True)

    item_id = Column(BigInteger, index=True, nullable=False)
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    uom_code = Column(String(20), nullable=True)
    batch_id = Column(BigInteger, nullable=True)
    batch_no = Column(String(50), nullable=True)

    quantity = Column(QTY, nullable=False, default=0)
    rate = Column(RATE, nullable=True)
    amount = Column(MONEY, nullable=True)
    reason = Column(String(300), nullable=True)

    parent = relationship("PurchaseReturn", back_populates="items")


# ---------------------------------------------------------------------------
# Supporting tables
# ---------------------------------------------------------------------------

class Batch(Base):
    """`stk_batches`. Created by the GRN when a line carries a batch number."""
    __tablename__ = "stk_batches"

    id = pk()
    batch_no = Column(String(50), nullable=False)
    item_id = Column(BigInteger, index=True, nullable=False)
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    vendor_id = Column(BigInteger, nullable=True)
    vendor_name = Column(String(200), nullable=True)

    mfg_date = Column(Date, nullable=True)
    expiry_date = Column(Date, index=True, nullable=True)
    received_date = Column(Date, nullable=True)

    grn_id = Column(BigInteger, nullable=True)
    grn_no = Column(String(50), nullable=True)
    initial_qty = Column(QTY, nullable=False, default=0)
    rate = Column(RATE, nullable=True)
    status = Column(String(30), nullable=False, default=BatchStatus.ACTIVE.value)
    recall_reason = Column(String(500), nullable=True)
    created_at = created_at_col()


class SerialNumber(Base):
    """`whs_serial_numbers`. The asset/consumable code is generated during putaway,
    never in masters (see the masters overhaul note in CLAUDE.md).

    `status` is a MySQL ENUM with lower-case members — see `enums.SerialStatus`.
    """
    __tablename__ = "whs_serial_numbers"

    id = pk()
    item_id = Column(BigInteger, index=True, nullable=False)
    serial_number = Column(String(100), index=True, nullable=False)
    batch_id = Column(BigInteger, nullable=True)
    warehouse_id = Column(BigInteger, index=True, nullable=True)
    bin_id = Column(BigInteger, nullable=True)
    asset_code = Column(String(100), nullable=True)
    consumable_code = Column(String(100), nullable=True)
    status = Column(String(20), nullable=False, default=SerialStatus.AVAILABLE.value)
    remarks = Column(String(500), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = created_at_col()
    updated_at = updated_at_col()


# A location and a bin are the same row in the same table (`whs_warehouse_locations`);
# only one mapper may own it, and that mapper lives in shared because the masters
# screens need it too. Imported here so `m.WarehouseLocation` still reads naturally in
# this module. See `app/shared/models/warehouse.py` for why there is no `whs_bins`.
from app.shared.models.warehouse import BIN_TYPES, Bin, WarehouseLocation  # noqa: E402,F401


class StorageType(Base):
    """`whs_warehouse_storage_types` — the DB team's table, the one with rows in it.
    A `whs_storage_types` also exists on the server but is an empty duplicate; do not
    point anything at it."""
    __tablename__ = "whs_warehouse_storage_types"

    id = pk()
    name = Column(String(50), nullable=False)
    description = Column(String(200), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)


class Attachment(Base):
    """`sys_attachments`, keyed by `(entity_type, entity_id)` so one panel serves
    every document without per-document wiring."""
    __tablename__ = "sys_attachments"

    id = pk()
    entity_type = Column(String(50), index=True, nullable=False)
    entity_id = Column(BigInteger, index=True, nullable=False)
    file_name = Column(String(300), nullable=False)
    file_path = Column(String(500), nullable=False)
    file_size = Column(BigInteger, nullable=True)
    mime_type = Column(String(100), nullable=True)
    doc_category = Column(String(50), nullable=True)
    uploaded_by_id = soft_fk()
    uploaded_by_name = Column(String(200), nullable=True)
    created_at = created_at_col()


class Notification(Base):
    """`sys_notifications`. Raised when a document needs someone."""
    __tablename__ = "sys_notifications"

    id = pk()
    employee_id = Column(BigInteger, index=True, nullable=False)
    title = Column(String(200), nullable=False)
    body = Column(String(1000), nullable=True)
    entity_type = Column(String(50), nullable=True)
    entity_id = Column(BigInteger, nullable=True)
    deep_link = Column(String(300), nullable=True)
    is_read = Column(Boolean, nullable=False, default=False)
    created_at = created_at_col()
