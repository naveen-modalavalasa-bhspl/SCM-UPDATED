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
from app.platform.workflow import doc_registry
from app.shared.enums import DocType
from app.modules.warehouse.enums import (
    BatchStatus,
    DispatchSourceType,
    HandlingUnitStatus,
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
from app.shared.models.combination import CombinationMixin

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
    # The vendor's own despatch note, when they filed one before the vehicle left.
    # Soft FK — procurement owns that table, and a delivery can still arrive without
    # one, which is why this is nullable and nothing checks it before receiving.
    despatch_note_id = Column(BigInteger, index=True, nullable=True)
    despatch_note_no = Column(String(30), nullable=True)
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

    # WHEN THE GOODS ARE EXPECTED, on a receipt raised before they arrive (2026-09-11).
    # Distinct from all three dates beside it: `grn_date` is this document's own date,
    # `invoice_date` is the supplier's paperwork, and `gate_entry_at` is the moment a
    # vehicle actually turned up. None of them can say "a lorry is coming on the 20th",
    # which is exactly what a DRAFT receipt raised from a supplier's replacement promise
    # exists to say — and what the receiving queue needs to sort by. Nullable, because a
    # receipt written AT the gate is describing goods that are already there.
    #
    # SET ONLY WHEN SOMEBODY IS BRINGING IT TO US. On a collection it stays null on
    # purpose — see `inbound_transport_mode`.
    expected_delivery = Column(Date, nullable=True)

    # WHO MOVES THE GOODS ON AN INBOUND LEG (2026-09-11). `SUPPLIER_DELIVERS` or
    # `WE_COLLECT` (`schemas.INBOUND_TRANSPORT_MODES`); null on every receipt raised
    # before this and on any written at the gate, where the goods are already standing
    # in front of the storekeeper and the question is moot.
    #
    # WHY THIS IS NOT `TransportMode`. That enum answers "how does it travel and who is
    # paid" — DIRECT, COURIER, OWN_VEHICLE, THIRD_PARTY — and every one of its values
    # describes a leg arranged by the party SENDING the goods. On an inbound leg the
    # first question is a different one: is anything coming at all, or must we go and
    # fetch it. `OWN_VEHICLE` cannot answer it, because on goods coming towards us
    # "own vehicle" is ambiguous between the supplier's truck and ours. The two axes are
    # genuinely independent and collapsing them loses the answer the store acts on.
    #
    # THE STORE ACTS DIFFERENTLY ON EACH, which is the whole reason it is stored: a
    # delivery is waited for at the gate, a collection is a vehicle somebody here has to
    # send. A receipt that cannot tell them apart reads as a delivery, so a collection
    # would sit in the queue until the supplier telephoned to ask why nobody came.
    inbound_transport_mode = Column(String(30), nullable=True)
    # WHERE we collect from, and WHEN it is ready — both only on a collection.
    #
    # `goods_ready_date` is NOT `expected_delivery` and must never be written to it: the
    # supplier is promising the goods will be ready on their dock, not that they will be
    # at our gate. Putting a ready date in the arrival column would have the receiving
    # queue expecting a lorry on a day nothing is coming.
    #
    # No pickup CONTACT columns: `mst_vendors` already holds the supplier's contact
    # person and phone, and `_enrich_return_with_vendor` already serves them onto the
    # return. A second copy here would be one more thing to go stale.
    pickup_address = Column(String(500), nullable=True)
    goods_ready_date = Column(Date, nullable=True)

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


class ReceiptItem(CombinationMixin, Base):
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
    # Same shape as serial_numbers above: an IMEI names the same physical unit a
    # serial does, so one storage idea rather than two.
    imei_numbers = Column(JSON, nullable=True)

    # Packing (2026-10-08). `declared_pack_breakdown` is what the supplier's despatch
    # note said — copied once, never edited by the gate. `pack_breakdown` is what was
    # COUNTED: the same levels, each at most what was declared, and `received_qty` is
    # its total. A receipt with no despatch note behind it declares nothing and the
    # storekeeper states the packing directly.
    pack_hierarchy_id = Column(BigInteger, index=True, nullable=True)
    declared_pack_breakdown = Column(JSON, nullable=True)
    pack_breakdown = Column(JSON, nullable=True)
    despatch_note_item_id = Column(BigInteger, nullable=True)

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


class InspectionItem(CombinationMixin, Base):
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
    imei_numbers = Column(JSON, nullable=True)
    # By the PACK (2026-10-27): of the packs the GRN counted, the ones QC kept (a kept
    # pack with units taken out of it is a part pack here) and the ones it rejected
    # (whole packs, plus the units taken out of kept ones, loose). Snapshotted entries;
    # NULL when the line was decided by quantity alone. Putaway shelves the accepted.
    accepted_pack_breakdown = Column(JSON, nullable=True)
    rejected_pack_breakdown = Column(JSON, nullable=True)

    inspection = relationship("Inspection", back_populates="items")


# ---------------------------------------------------------------------------
# Putaway
# ---------------------------------------------------------------------------

class PutawayTask(CombinationMixin, Base):
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

    # WHICH packaging unit landed on the dock. "3 cases" and "1500 eaches" are the same
    # `qty` and need entirely different shelf space, so the document has to carry the
    # rung it arrived in — a bin is checked against handling units, never against loose
    # volume. Blank falls back to the item's default putaway unit.
    item_packaging_id = Column(BigInteger, index=True, nullable=True)
    package_id = Column(BigInteger, nullable=True)
    package_name = Column(String(200), nullable=True)     # snapshot
    # ceil(qty / units per pack) — whole packs, because half a case still occupies a
    # case's footprint. Stamped at confirm from the rung above.
    handling_units = Column(Numeric(15, 3), nullable=True)
    # The pack hierarchy is the GRN line's and never changes here; the BREAKDOWN may
    # (2026-10-08) — the putaway desk opens a carton into its boxes, or shelves loose
    # strips as boxes. Same base total, always. Confirming it creates one
    # `whs_handling_units` row per physical pack.
    pack_hierarchy_id = Column(BigInteger, nullable=True)
    pack_breakdown = Column(JSON, nullable=True)

    suggested_bin_id = Column(BigInteger, nullable=True)
    actual_bin_id = Column(BigInteger, nullable=True)

    # Stamped at confirm, never before: a lot names *where* the stock landed
    # (LOT/WH10/A-F1-L1-R1-S1-A1/2026-27/00001), so it cannot exist until a bin is
    # chosen. Indexed because "what is in lot X" is the question it exists to answer.
    lot_no = Column(String(120), index=True, nullable=True)

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


class PickingItem(CombinationMixin, Base):
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
    issue_type = Column(String(30), nullable=False, default="DIRECT")
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
    # The stocking point the goods are going to, when the store CHOSE one on a direct
    # issue. Wins over the issued-to person's and the indent's office in
    # `service._issue_destination`. NULL keeps the derived answer.
    destination_warehouse_id = soft_fk()
    destination_warehouse_name = Column(String(200), nullable=True)

    direction = Column(String(3), nullable=False, default="OUT")
    original_issue_id = Column(BigInteger, nullable=True)
    original_issue_no = Column(String(50), nullable=True)

    # A split: one child per warehouse FLOOR, each capped at the stock that floor
    # actually holds. The parent is the generic issue the allocation raised — it is
    # not tagged to anybody and stays the header that says what was asked for.
    #
    # Which floor a child serves is stored HERE and nowhere else, and it is a fact
    # about the DOCUMENT, not about the stock: it says who was handed this piece of
    # work, which does not change if the goods are later moved. What the floor still
    # HOLDS stays read-on-demand, the way the fulfilment remainder is.
    parent_issue_id = Column(BigInteger, index=True, nullable=True)
    parent_issue_no = Column(String(50), nullable=True)
    floor_location_id = Column(BigInteger, index=True, nullable=True)
    floor_location_name = Column(String(200), nullable=True)

    status = Column(String(30), nullable=False, default=IssueStatus.DRAFT.value)
    qc_status = Column(String(30), nullable=False, default=QcStatus.NOT_REQUIRED.value)
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


class MaterialIssueLine(CombinationMixin, Base):
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
    mfg_date = Column(Date, nullable=True)
    expiry_date = Column(Date, nullable=True)

    requested_qty = Column(QTY, nullable=False, default=0)
    issued_qty = Column(QTY, nullable=False, default=0)
    returned_qty = Column(QTY, nullable=False, default=0)
    rate = Column(RATE, nullable=True)
    amount = Column(MONEY, nullable=True)
    remarks = Column(String(500), nullable=True)

    # The packs this line issues in (2026-10-08): "2 Box + 5 Strip". `issued_qty`
    # is its base total. `break_bulk` says the storekeeper is opening a coded pack to
    # give out part of it — refused without `issue.break_bulk`, and recorded so the
    # retired code has a reason next to it.
    pack_hierarchy_id = Column(BigInteger, nullable=True)
    pack_breakdown = Column(JSON, nullable=True)
    break_bulk = Column(Boolean, nullable=False, default=False)

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
    # Snapshot of the stocking point's own address (SCM_0053) — same rule as
    # warehouse_name: a document that leaves the building must not go stale because
    # somebody later edits the warehouse master. Carried onto the transport leg's own
    # from_warehouse_address, which is what the gate pass actually prints.
    warehouse_address = Column(String(500), nullable=True)
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
    sources = relationship(
        "DispatchSource", back_populates="dispatch",
        cascade="all, delete-orphan", order_by="DispatchSource.id",
    )


class DispatchSource(Base):
    """The material issues a consignment carries — ONE row per issue.

    `out_dispatches.ref_id` can name only one document, so a consignment carrying
    several issues to the same stocking point lists them here (and its `ref_id` is
    NULL). A single-issue consignment writes its one row too, so a reader can always
    ask this table; rows raised before it existed are found through `ref_id`, which is
    why every reader goes through `service._carries_issue` rather than either alone.

    `mr_id` / `mr_no` name the material request behind the issue only when there is
    exactly one — it is a trace for people, never something stock is checked against.
    """
    __tablename__ = "out_dispatch_sources"
    __table_args__ = (
        Index("uq_out_dispatch_sources_dispatch_issue", "dispatch_id", "issue_id",
              unique=True),
    )

    id = pk()
    dispatch_id = Column(ForeignKey("out_dispatches.id", ondelete="CASCADE"),
                         index=True, nullable=False)
    source_type = Column(String(30), nullable=False, default=DispatchSourceType.ISSUE.value)
    source_id = Column(BigInteger, nullable=False)
    source_no = Column(String(50), nullable=True)
    issue_id = Column(BigInteger, index=True, nullable=True)
    issue_no = Column(String(50), nullable=True)
    mr_id = Column(BigInteger, index=True, nullable=True)
    mr_no = Column(String(50), nullable=True)
    indent_id = Column(BigInteger, index=True, nullable=True)
    indent_no = Column(String(50), nullable=True)
    destination_warehouse_id = Column(BigInteger, nullable=True)
    destination_warehouse_name = Column(String(200), nullable=True)
    quantity = Column(QTY, nullable=False, default=0)

    dispatch = relationship("Dispatch", back_populates="sources")


class DispatchItem(CombinationMixin, Base):
    """`out_dispatch_items`. `package_id` records which carton a line went into —
    the thing an "it arrived short" call needs."""
    __tablename__ = "out_dispatch_items"

    id = pk()
    dispatch_id = Column(ForeignKey("out_dispatches.id", ondelete="CASCADE"),
                         index=True, nullable=False)
    line_no = Column(Integer, nullable=False, default=1)
    package_id = Column(BigInteger, nullable=True)

    issue_id = Column(BigInteger, index=True, nullable=True)
    issue_no = Column(String(50), nullable=True)
    # The issue LINE this carton line was packed from (2026-10-07). One batch drawn
    # from two bays is two issue lines, and keyed on (issue, item, batch) alone the
    # packing grid could not tell them apart — typing into one row wrote the other.
    # Soft (no FK): a consignment outlives edits to the draft issue it came from.
    issue_item_id = Column(BigInteger, index=True, nullable=True)
    mr_id = Column(BigInteger, index=True, nullable=True)
    mr_no = Column(String(50), nullable=True)
    indent_id = Column(BigInteger, nullable=True)
    indent_no = Column(String(50), nullable=True)

    item_id = Column(BigInteger, index=True, nullable=False)
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    uom_code = Column(String(20), nullable=True)
    batch_id = Column(BigInteger, nullable=True)
    batch_no = Column(String(50), nullable=True)
    # Where the issue line drew it from — shown so two rows of one batch say which bay.
    bin_code = Column(String(100), nullable=True)
    # Snapshotted beside the batch id, not re-derived. The receiving point rebuilt
    # both from stk_batches, which only works while batch_id survives — and it does
    # not on an allocation-drafted issue. A consignment states what it carries.
    mfg_date = Column(Date, nullable=True)
    expiry_date = Column(Date, nullable=True)
    serial_no = Column(String(100), nullable=True)
    imei_no = Column(String(50), nullable=True)
    # The package (box / strip) this row carries, for an item issued in packages
    # (2026-10-26): one row per package, `quantity` what it carries.
    box_code = Column(String(120), index=True, nullable=True)

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
    # Per issue line packed into this carton: the hierarchy and the packs it holds of
    # it — [{issue_item_id, item_id, batch_id, quantity, pack_hierarchy_id,
    # pack_breakdown, pack_text}] (2026-10-22). Shown at acknowledgement, shelved at
    # the destination. NULL: nothing in it is packed.
    item_packs = Column(JSON, nullable=True)

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

    # ADDED 2026-09-12. The QC that condemned the goods — the last reference the business
    # asks a purchase return to carry, and the only one it could not.
    #
    # STORED rather than derived on every read, unlike `grn_date` and `invoice_no` beside
    # it, because the business requires this one to survive the whole journey: a return
    # argued with a vendor months later must still name the inspection it was raised on,
    # and a derived value would change the day somebody re-pointed the GRN link — or
    # vanish entirely if the inspection were later cancelled.
    #
    # WRITTEN IN EXACTLY TWO PLACES, and never anywhere else: at birth, by whoever raises
    # the return, and at `send_to_vendor`, which BINDS it the same way it binds the traced
    # GRN/PO/vendor chain. `_decorate_purchase_return` fills it in on read ONLY while it is
    # null, which is a binding rather than an overwrite — the trap `manual_vendor_*`
    # documents (a derived value silently replacing a stored one on the next GET) needs an
    # UNCONDITIONAL assignment to spring, and there is none here.
    #
    # `indent_id`/`indent_no` are deliberately NOT columns beside these. They are already
    # served, derived off the bound GRN on every read, and `_decorate_purchase_return`
    # assigns them unconditionally — including to None on a manual return. Promoting them
    # to columns would let an ordinary GET blank a stored indent.
    #
    # `inb_inspections` is this module's own table, but the link is soft: a return
    # outlives an inspection somebody may cancel, and the number is the fact worth keeping
    # even then.
    inspection_id = Column(BigInteger, index=True, nullable=True)
    inspection_no = Column(String(50), nullable=True)

    vendor_id = Column(BigInteger, index=True, nullable=True)
    vendor_name = Column(String(200), nullable=True)
    warehouse_id = Column(BigInteger, index=True, nullable=True)
    warehouse_name = Column(String(200), nullable=True)

    reason = Column(String(500), nullable=True)
    # Free-text notes captured beside the reason. Nullable so every row raised
    # before remarks existed keeps reading; new drafts write it on create/update.
    remarks = Column(Text, nullable=True)
    status = Column(String(30), nullable=False, default=ReturnStatus.DRAFT.value)
    # When a DRAFT was sent to the vendor (DRAFT -> SENT_TO_VENDOR). Null until
    # sent; set once in the same transaction as the status flip so the two can
    # never disagree. Read back on the detail for the review screen.
    sent_at = Column(DateTime, nullable=True)

    # ADDED 2026-09-08 (returns work). Where the material being sent back came FROM,
    # as against which warehouse is sending it: off an upper-tier shelf, up the chain
    # from a branch, or rejected on the inspection bench after the GRN. Nullable and
    # unread by anything in this module — every existing route behaves as before — and
    # written by whoever raises the return. `returns.enums.PurchaseReturnSource` names
    # the values; the column is a plain String so the warehouse module does not have to
    # import the returns module to store one (rule 5: the chain runs the other way).
    source_category = Column(String(30), index=True, nullable=True)
    # The stock return that produced this one, where it was produced automatically off a
    # branch return landing at the warehouse. A soft link: `inv_sto` is inventory's
    # table and a purchase return outlives the transfer that caused it.
    source_return_id = Column(BigInteger, index=True, nullable=True)
    source_return_no = Column(String(50), nullable=True)

    # ADDED 2026-09-10. This document's vendor and lines were TYPED, not read off a
    # purchase transaction — the warehouse is holding goods to send back whose
    # paperwork never reached this system. Defaults false, so every row raised before
    # today, and every sourced return raised after it, behaves exactly as it did.
    is_manual = Column(Boolean, nullable=False, default=False, server_default="0")
    # The document number the storekeeper typed for their own reference, where the
    # system holds no such document. Never resolved and never linked — it is a note.
    source_ref_no = Column(String(100), nullable=True)
    # The vendor AS TYPED, in columns of their own.
    #
    # Deliberately not the `vendor_*` names the API serves: `_enrich_return_with_vendor`
    # assigns those transient attributes off `mst_vendors` on every read and several
    # callers commit straight afterwards, so a manual vendor stored under those names
    # would be blanked by the next `get_return`. The serializer reads these where
    # `is_manual` is set, which keeps the served shape identical either way.
    manual_vendor_code = Column(String(50), nullable=True)
    manual_vendor_contact_person = Column(String(200), nullable=True)
    manual_vendor_phone = Column(String(50), nullable=True)
    manual_vendor_email = Column(String(200), nullable=True)
    manual_vendor_address = Column(String(500), nullable=True)
    manual_vendor_city = Column(String(100), nullable=True)
    manual_vendor_state = Column(String(100), nullable=True)
    manual_vendor_pincode = Column(String(20), nullable=True)
    manual_vendor_gstin = Column(String(20), nullable=True)

    # ADDED 2026-09-11 (supplier portal: receipt + answer). Two independent facts, and
    # deliberately two groups of columns — see `e1f2a3b4c5d6`.
    #
    # The PHYSICAL handover, signed once by the supplier when the consignment is put
    # into their hands. This is what the acknowledgement receipt prints from. All null
    # on every return raised before today, which is the same state a new one starts in.
    vendor_receipt_confirmed_at = Column(DateTime, nullable=True)
    vendor_receipt_by_name = Column(String(200), nullable=True)
    # The vehicle AS THE SUPPLIER SAW IT. Not the same fact as the consignment's own
    # `out_dispatches.vehicle_number`: that is what we booked, this is what turned up,
    # and a transhipped load makes them genuinely different. Prefilled from the
    # consignment on screen, stored separately so a correction is never lost.
    vendor_receipt_vehicle_no = Column(String(50), nullable=True)
    vendor_receipt_remarks = Column(Text, nullable=True)

    # The DECISION: REFUNDED / REPLACED / RETURNED, or legacy ACCEPTED
    # (`enums.VendorReturnResponse`). Answered once. A plain String, like `status` beside
    # it, so the column outlives any renaming of the enum.
    vendor_response = Column(String(30), index=True, nullable=True)
    vendor_response_at = Column(DateTime, nullable=True)
    vendor_response_note = Column(Text, nullable=True)
    # What the supplier is refunding, where the answer was REFUNDED. Null on every other
    # answer and on every return answered before 2026-09-11.
    #
    # STORED rather than assumed equal to `total_value`, because a partial credit is the
    # normal case and not an exception: freight deducted, a restocking charge kept back,
    # or a line the supplier disputes. Reading the refund off `total_value` would have
    # been right until the first short credit arrived and then silently wrong, with
    # nothing on the document to say the two numbers had ever differed. The service caps
    # it at `total_value` — a supplier cannot credit more than was sent back to them.
    vendor_refund_amount = Column(MONEY, nullable=True)
    # The DRAFT inbound receipt that answer raised, where it raised one. RETURNED and
    # REPLACED both put goods back on a vehicle towards us; REFUNDED settles in money
    # and legacy ACCEPTED raised nothing, so both leave these null. A soft link —
    # `inb_receipts` is this module's own table, but a return outlives the receipt
    # somebody may later cancel.
    vendor_followup_receipt_id = Column(BigInteger, index=True, nullable=True)
    vendor_followup_receipt_no = Column(String(50), nullable=True)

    # ADDED 2026-09-11 (`a4d8e2f6b0c9`). A collection — the supplier answered REPLACED
    # and asked us to send a vehicle — raises NO receipt when it is answered, because a
    # receipt is a warehouse document and on a collection the warehouse has nothing to
    # do yet: no vehicle has gone and no date exists. It raises the TRIP instead, on the
    # logistics desk's own Dispatch board, and the receipt follows when that leg is
    # acknowledged and the goods are actually in the building.
    #
    # These four carry the answer across that gap. All null on a delivery, on a RETURNED
    # consignment and on every return raised before today.
    #
    # A SOFT link, like every other cross-module id here: `lgs_transport_requests` is
    # logistics', which sits BEFORE warehouse in the import chain (rule 5), and a return
    # outlives a leg somebody may cancel. Indexed because `transport_acknowledged` asks
    # "is a purchase return waiting on this leg?" on every shipment signature.
    collection_tr_id = Column(BigInteger, index=True, nullable=True)
    collection_tr_no = Column(String(50), nullable=True)
    # Where our vehicle goes, and the earliest it may go. The same two facts
    # `inb_receipts.pickup_address` / `goods_ready_date` hold on a delivery — held here
    # instead because on a collection there is no receipt yet to hold them.
    collection_pickup_address = Column(String(500), nullable=True)
    collection_ready_date = Column(Date, nullable=True)

    # ADDED 2026-09-11 (`b7e3c1a9d5f2`). THE DECISION ON A SENT RETURN, and the leg that
    # brings the material back from the vendor afterwards.
    #
    # Until now a return stopped at SENT_TO_VENDOR: the consignment was in the vendor's
    # hands, the screen went read-only, and whether anybody had agreed the return — and
    # whose vehicle was bringing the material back — were facts the system simply did not
    # hold. Every column below is null on every row raised before today, which is the
    # same state a new one starts in, so nothing already in flight reads differently.
    #
    # The DECISION. APPROVED / REJECTED (`ApprovalAction`), answered once. Stored beside
    # the status rather than derived from it because the status moves on afterwards —
    # through the arrangement, the vehicle and the arrival — and "who agreed this, and
    # when" has to stay readable at every one of those rungs.
    vendor_decision = Column(String(20), nullable=True)
    vendor_decision_at = Column(DateTime, nullable=True)
    vendor_decision_by_id = soft_fk()
    vendor_decision_by_name = Column(String(200), nullable=True)
    vendor_decision_note = Column(Text, nullable=True)

    # WHO PROVIDES THE VEHICLE (`enums.ReturnVehicleArrangement`). A plain String, like
    # `status` and `vendor_response` beside it, so the column outlives any renaming of
    # the enum. Null until the approval has been answered with one of the two options.
    vehicle_arrangement = Column(String(30), nullable=True)
    vehicle_arrangement_at = Column(DateTime, nullable=True)
    vehicle_arrangement_by_name = Column(String(200), nullable=True)

    # THE LOGISTICS LEG that fetches the material, on a WAREHOUSE_REQUESTS arrangement.
    #
    # ITS OWN PAIR OF COLUMNS, deliberately NOT the `collection_tr_*` pair above, which
    # the supplier-collection path writes. The two trips look alike — both run vendor's
    # dock -> our warehouse on our own vehicle — but they settle differently:
    # `_collection_arrived` matches an acknowledged leg to `collection_tr_id` and raises
    # an inbound RECEIPT against the supplier's stored REPLACED answer. A return that
    # got here has no such answer, so sharing the column would have that settlement fire
    # on a document it was never written for. Separate columns is what makes the two
    # provably independent; `_inbound_vehicle_arrived` settles this one.
    #
    # A SOFT link, like every other cross-module id here: `lgs_transport_requests` is
    # logistics', which sits BEFORE warehouse in the import chain (rule 5), and a return
    # outlives a leg somebody may cancel. Indexed because the acknowledgement hook asks
    # "is a purchase return waiting on this leg?" on every shipment signature.
    inbound_tr_id = Column(BigInteger, index=True, nullable=True)
    inbound_tr_no = Column(String(50), nullable=True)
    # Where that vehicle collects from, and the earliest it may go. Stated by the desk
    # when the request is raised, defaulted from the vendor master on screen.
    inbound_pickup_address = Column(String(500), nullable=True)
    inbound_ready_date = Column(Date, nullable=True)

    # THE VEHICLE COMING BACK, on a VENDOR_ARRANGES leg only.
    #
    # Stored ONLY on that branch, and that asymmetry is deliberate rather than an
    # omission. On a WAREHOUSE_REQUESTS leg the vehicle and the driver belong to the
    # transport request Logistics assigns them on, and they are READ back off it on every
    # load (`_decorate_return_inbound_leg`) exactly as `dispatch_no` already is — a second
    # copy here would go stale the first time the desk re-assigned a truck. On a vendor
    # leg there is no such document: the vendor states a vehicle over the phone and this
    # row is the only place it can live.
    #
    # DELIBERATELY NOT the `inbound_*` names the API serves, and for the same reason
    # `manual_vendor_*` is not `vendor_*`: `_decorate_return_inbound_leg` assigns the
    # served names as transient attributes on every read, and several callers commit
    # straight afterwards — so a vendor-stated vehicle stored under the served names
    # would be silently overwritten with logistics' copy on the next load. The
    # serializer reads these where the arrangement is VENDOR_ARRANGES, which keeps the
    # served shape identical either way.
    arranged_vehicle_no = Column(String(50), nullable=True)
    arranged_driver_name = Column(String(200), nullable=True)
    arranged_driver_phone = Column(String(30), nullable=True)
    arranged_transporter_name = Column(String(200), nullable=True)
    arranged_lr_no = Column(String(50), nullable=True)
    arranged_expected_date = Column(Date, nullable=True)
    arranged_dispatched_at = Column(DateTime, nullable=True)

    # ADDED 2026-09-12. WHEN THE VENDOR ACCEPTED THE COLLECTION JOB, on a VENDOR_ARRANGES
    # leg. Its own stamp rather than inferred from a vehicle number appearing, because
    # agreeing to come and fetch the goods on Thursday and having named a truck are two
    # different facts and the warehouse chases them differently. `arranged_dispatched_at`
    # beside it is the later moment — the vehicle actually loaded and left our gate.
    vendor_transport_accepted_at = Column(DateTime, nullable=True)
    vendor_transport_accepted_by_name = Column(String(200), nullable=True)

    # ADDED 2026-09-12. THE OUTWARD LEG — our warehouse to the vendor's dock.
    #
    # ITS OWN PAIR OF COLUMNS, deliberately not `inbound_tr_*` or `collection_tr_*` above.
    # All three name a transport request against this return and all three are settled by a
    # different hook: `collection_tr_id` raises an inbound receipt against a stored REPLACED
    # answer, `inbound_tr_id` signs the material back in at our own gate, and this one moves
    # the return to STOCK_PICKED_UP when the load actually leaves us. Sharing a column would
    # have each settlement fire on documents it was never written for; separate columns is
    # what makes the three provably independent.
    #
    # A SOFT link, like every other cross-module id here: `lgs_transport_requests` is
    # logistics', which sits BEFORE warehouse in the import chain (rule 5), and a return
    # outlives a leg somebody may cancel. Indexed because the release hook asks "is a
    # purchase return waiting on this leg?" on every shipment that goes out.
    outbound_tr_id = Column(BigInteger, index=True, nullable=True)
    outbound_tr_no = Column(String(50), nullable=True)

    # THE REPLACEMENT DISPATCH NOTE — what the vendor put on a vehicle towards us, and
    # when. Stated once, by the vendor, on the rung where they actually ship it.
    #
    # The per-line half of this note (batch, mfg date, expiry) lives on
    # `PurchaseReturnItem.replacement_*`, which already existed: replacement goods for two
    # items have two batches and two expiries, and one pair of columns here would be right
    # only for a single-line return.
    #
    # `replacement_dispatch_no` is the VENDOR's own note number, as they state it. Never
    # generated here and never resolved — it is their reference, printed on the note so the
    # two sides can quote one number at each other.
    replacement_dispatched_at = Column(DateTime, nullable=True)
    replacement_dispatch_no = Column(String(100), nullable=True)
    replacement_dispatch_date = Column(Date, nullable=True)
    replacement_expected_date = Column(Date, nullable=True)
    replacement_transporter_name = Column(String(200), nullable=True)
    replacement_vehicle_no = Column(String(50), nullable=True)
    replacement_lr_no = Column(String(50), nullable=True)
    replacement_remarks = Column(Text, nullable=True)

    # THE ARRIVAL. Signed once, by whoever took the load in at the gate.
    received_at = Column(DateTime, nullable=True)
    received_by_name = Column(String(200), nullable=True)
    received_remarks = Column(Text, nullable=True)

    # THE REFUND, where the approval settled in money instead of goods.
    #
    # The AMOUNT reuses `vendor_refund_amount` above rather than taking its own
    # column: a credit is a credit whichever desk recorded it, the cap (never more
    # than the value sent back) is the same, and the supplier-answer card already
    # reads that column. These three are the stamp of the INTERNAL settlement —
    # kept apart from `vendor_response_*` so a desk-recorded refund can never read
    # as an answer the supplier gave on their portal. All null except on REFUNDED.
    refunded_at = Column(DateTime, nullable=True)
    refunded_by_name = Column(String(200), nullable=True)
    refund_remarks = Column(Text, nullable=True)

    # ADDED 2026-09-08 (returns work). Where the material being sent back came FROM,
    # as against which warehouse is sending it: off an upper-tier shelf, up the chain
    # from a branch, or rejected on the inspection bench after the GRN. Nullable and
    # unread by anything in this module — every existing route behaves as before — and
    # written by whoever raises the return. `returns.enums.PurchaseReturnSource` names
    # the values; the column is a plain String so the warehouse module does not have to
    # import the returns module to store one (rule 5: the chain runs the other way).
    source_category = Column(String(30), index=True, nullable=True)
    # The stock return that produced this one, where it was produced automatically off a
    # branch return landing at the warehouse. A soft link: `inv_sto` is inventory's
    # table and a purchase return outlives the transfer that caused it.
    source_return_id = Column(BigInteger, index=True, nullable=True)
    source_return_no = Column(String(50), nullable=True)

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


class PurchaseReturnItem(CombinationMixin, Base):
    """`pro_return_items`."""
    __tablename__ = "pro_return_items"

    id = pk()
    return_id = Column(ForeignKey("pro_returns.id", ondelete="CASCADE"),
                       index=True, nullable=False)
    line_no = Column(Integer, nullable=False, default=1)

    po_item_id = Column(BigInteger, nullable=True)
    grn_item_id = Column(BigInteger, nullable=True)

    # NULLABLE since 2026-09-10: a manually typed line names an item that need not
    # exist in `mst_items` at all. Every reader that groups or filters on this already
    # guards for a missing value (see `_trace_purchase_source`).
    item_id = Column(BigInteger, index=True, nullable=True)
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    uom_code = Column(String(20), nullable=True)
    batch_id = Column(BigInteger, nullable=True)
    batch_no = Column(String(50), nullable=True)

    quantity = Column(QTY, nullable=False, default=0)
    rate = Column(RATE, nullable=True)
    amount = Column(MONEY, nullable=True)
    reason = Column(String(300), nullable=True)

    # ADDED 2026-09-10. This line was typed rather than read off a source document.
    is_manual = Column(Boolean, nullable=False, default=False, server_default="0")
    # Purchased / already returned / available AS TYPED. On a SOURCED line these three
    # are derived on every read from the GRN or PO behind the return and are left NULL
    # here — deriving them is what stops a screen offering a quantity the save refuses.
    # On a manual line there is no source to derive them from, so they are stored.
    original_qty = Column(QTY, nullable=True)
    previously_returned = Column(QTY, nullable=True)
    returnable_qty = Column(QTY, nullable=True)

    # ADDED 2026-09-11 (`a4d8e2f6b0c9`). WHAT THE SUPPLIER SAID IS IN THE CARTON, on a
    # replacement they are sending back. Not this line's own `batch_no` — that is the
    # batch of the FAULTY goods travelling the other way, different physical stock with
    # a different expiry, and inheriting it would prefill the store's GRN with a wrong
    # lot number.
    #
    # Written on a COLLECTION only, and only because the receipt those answers used to
    # go straight onto is no longer raised at answer time (see `collection_tr_id` on the
    # parent). The supplier is still asked, and still refused, at the moment they answer:
    # a batch-tracked line with no batch and an expiry-tracked line with no expiry both
    # stop the GRN later, and only the supplier can read them off a carton standing in
    # their own warehouse. These columns are where the answers wait for the receipt.
    replacement_batch_no = Column(String(50), nullable=True)
    replacement_mfg_date = Column(Date, nullable=True)
    replacement_expiry_date = Column(Date, nullable=True)

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
    # The unit's second identifier. It arrives on the inbound GRN and used to stop
    # there, as a JSON blob on inb_receipt_items — so the outward flow had no IMEI to
    # carry and every receiving storekeeper retyped it off the handset. On the unit,
    # it travels with the serial and can be PICKED by batch and bin.
    imei = Column(String(50), index=True, nullable=True)
    batch_id = Column(BigInteger, nullable=True)
    warehouse_id = Column(BigInteger, index=True, nullable=True)
    bin_id = Column(BigInteger, nullable=True)
    asset_code = Column(String(100), nullable=True)
    consumable_code = Column(String(100), nullable=True)
    # The lot the unit was put away under; same value as the putaway task's.
    lot_no = Column(String(120), index=True, nullable=True)
    # The innermost PACK this unit sits in (2026-10-08) — a strip, or the box it was
    # shelved in. NULL = loose. Scanning a pack's code selects every unit under it.
    handling_unit_id = Column(BigInteger, index=True, nullable=True)
    status = Column(String(20), nullable=False, default=SerialStatus.AVAILABLE.value)
    remarks = Column(String(500), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = created_at_col()
    updated_at = updated_at_col()

    # The table is per PHYSICAL UNIT, so it is the largest in the schema by a wide
    # margin — 773k rows against 94 stock balances — and `item_id` alone is worth
    # almost nothing on it (23 distinct items). These two are the shapes every unit
    # lookup actually has; without them opening one material issue took 26 seconds.
    # The `remarks` prefix index is created by `d4e5f6a7b8c9` in raw SQL: the column
    # is 500 wide and MySQL will only index the front of it.
    __table_args__ = (
        Index("ix_whs_serial_stock_lookup",
              "item_id", "warehouse_id", "status", "is_active", "batch_id", "bin_id"),
        Index("ix_whs_serial_point_item", "item_id", "warehouse_id", "is_active"),
    )


class HandlingUnit(Base):
    """`whs_handling_units` — ONE physical pack on the shelf (2026-10-08).

    A box, a carton, a strip: whatever the pack hierarchy calls a level. Stock is
    still counted in `stk_balance` in base units (rule 7); this is the layer that says
    how those units are BAGGED, so a screen can show "2 Carton + 3 Box + 4 Strip"
    instead of "2,740".

    The invariant: the live packs at one stock key (item, warehouse, location, batch,
    project) hold at most `stk_balance.total_qty`; whatever they do not hold is LOOSE,
    and loose is never stored — it is read as the difference.

    Packs nest: `parent_id` is the pack this one sits inside (status INSIDE). Only the
    outermost pack is SEALED. `pack_size` is snapshotted, so a pack keeps meaning what
    it meant when it was made even if the master is edited. `content_qty` is what is
    actually inside when that is less — a PART pack — and an issue that takes some of
    a pack shrinks it in place rather than breaking it up.

    `is_atom` marks a pack whose CODE was minted at its own level — at putaway, or by a
    break bulk. It may be wrapped into bigger packs (they get codes of their own and
    the atom keeps its code inside them) but never opened by a repack: a code names
    everything inside it, and a code cannot be split. Only a break bulk at the issue
    desk, under `issue.break_bulk`, opens one — the code retires and what is left gets
    new codes.
    """
    __tablename__ = "whs_handling_units"

    id = pk()
    hu_code = Column(String(120), unique=True, nullable=False)
    # ASSET / CONSUMABLE when the code is the item's own asset or consumable code;
    # PACK for a plain handling-unit label on an item that is not code-tracked.
    code_kind = Column(String(20), nullable=False, default="PACK")
    item_id = Column(BigInteger, index=True, nullable=False)
    warehouse_id = Column(BigInteger, nullable=False)
    bin_id = Column(BigInteger, nullable=False, default=NO_BIN)
    batch_id = Column(BigInteger, nullable=False, default=NO_BATCH)
    project_id = Column(BigInteger, nullable=False, default=0)
    pack_hierarchy_id = Column(BigInteger, index=True, nullable=False)
    item_packaging_id = Column(BigInteger, index=True, nullable=True)
    level = Column(Integer, nullable=False)
    pack_name = Column(String(200), nullable=True)
    pack_size = Column(QTY, nullable=False)
    # What is REALLY inside, in base units, when it is less than `pack_size`
    # (2026-10-11): a carton of 600 holding 500, or one that had 100 issued out of it.
    # NULL: full. `pack_size` stays the standard the pack was made to; read the
    # contents through `warehouse.packing.held`, never `pack_size` alone.
    content_qty = Column(QTY, nullable=True)
    parent_id = Column(BigInteger, index=True, nullable=True)
    is_atom = Column(Boolean, nullable=False, default=False)
    status = Column(String(20), nullable=False, default=HandlingUnitStatus.SEALED.value)
    lot_no = Column(String(120), nullable=True)
    # Where it came from: PUTAWAY, RECEIPT (a bulk site), REPACK, BREAK_BULK.
    source_type = Column(String(30), nullable=True)
    source_id = Column(BigInteger, nullable=True)
    source_no = Column(String(60), nullable=True)
    # Why and when it stopped being a pack, for OPENED / CONSUMED.
    closed_reason = Column(String(300), nullable=True)
    closed_by_name = Column(String(200), nullable=True)
    closed_at = Column(DateTime, nullable=True)
    # An issue line holding this box (2026-10-26) — the same "Reserved for issue X
    # line Y" marker a unit carries — and how much of it the line takes when that is
    # less than the whole box. After posting: "Issued by issue X line Y".
    held_by = Column(String(120), index=True, nullable=True)
    held_qty = Column(QTY, nullable=True)
    created_by_id = soft_fk()
    created_at = created_at_col()
    updated_at = updated_at_col()

    __table_args__ = (
        Index("ix_whs_hu_stock_key", "item_id", "warehouse_id", "bin_id", "batch_id",
              "status"),
    )


class BoxLabel(Base):
    """`whs_box_labels` — the print queue of new box codes (2026-10-26).

    Every box code the system makes for an item issued in a container lands here —
    at putaway, from the old-stock conversion, from a re-code after the Issue
    container changed, and the part box cut at the issue desk — so a sticker is
    printed for it from Inventory > Labels & Printing > Box labels. Snapshotted: a
    label reads what the box was when it was made.
    """
    __tablename__ = "whs_box_labels"

    id = pk()
    handling_unit_id = Column(BigInteger, index=True, nullable=False)
    hu_code = Column(String(120), nullable=False)
    item_id = Column(BigInteger, index=True, nullable=False)
    item_code = Column(String(100), nullable=True)
    item_name = Column(String(300), nullable=True)
    warehouse_id = Column(BigInteger, index=True, nullable=False)
    warehouse_name = Column(String(300), nullable=True)
    bin_code = Column(String(120), nullable=True)
    batch_no = Column(String(120), nullable=True)
    pack_name = Column(String(200), nullable=True)
    content_qty = Column(QTY, nullable=False)
    pack_size = Column(QTY, nullable=False)
    uom_code = Column(String(30), nullable=True)
    # PUTAWAY, CONVERTED, RECODED, PART_BOX
    reason = Column(String(30), nullable=False)
    source_no = Column(String(60), nullable=True)
    status = Column(String(20), index=True, nullable=False, default="QUEUED")
    printed_at = Column(DateTime, nullable=True)
    printed_by_name = Column(String(200), nullable=True)
    created_at = created_at_col()


# A location and a bin are the same row in the same table (`whs_warehouse_locations`);
# only one mapper may own it, and that mapper lives in shared because the masters
# screens need it too. Imported here so `m.WarehouseLocation` still reads naturally in
# this module. See `app/shared/models/warehouse.py` for why there is no `whs_bins`.
# `StorageType` and `StorageTypeParent` sit in shared for the same reason `Bin` does:
# the shared masters API (`/api/bins`, `shared/masters/defs.apply_bin`) has to check a
# location's kind against the master, and shared may not import a module (rule 5).
from app.shared.models.warehouse import (  # noqa: E402,F401
    BIN_TYPES,
    Bin,
    StorageType,
    StorageTypeParent,
    WarehouseLocation,
    pickable_storage_types,
    set_pickable_storage_types,
)


# `sys_attachments` moved to platform/settings/models.py — indents needs it for the
# receipt photo and bill a requester attaches when acknowledging a delivery, and it may
# not import this module (rule 5). Re-exported so `m.Attachment` keeps working here.
from app.platform.settings.models import Attachment  # noqa: E402,F401

# `sys_notifications` moved to platform/settings/models.py — the app shell's bell and
# inventory both need it, and neither may import this module (rule 5). Re-exported so
# `m.Notification` keeps working across the warehouse service and its screens.
from app.platform.settings.models import Notification  # noqa: E402,F401


# A multi-line stock movement has NO header table. `whs_stock_movement_orders` and
# `whs_stock_movement_order_items` were mapped here and queried by the service, but
# neither has ever existed on this database, so both `/stock-movement-orders`
# endpoints answered MySQL 1054. They are not needed: each line writes its OUT and IN
# through `move_stock` under one `ref_no` from `sys_doc_series`, and that shared
# number is what makes the lines one document. `stk_ledger` is the append-only record
# (rule 7); a header table would be a second copy of the same fact, free to drift.
# See `service.list_stock_movement_orders`, which rebuilds the document from it.


# ---------------------------------------------------------------------------
# Outbound QC
# ---------------------------------------------------------------------------

class OutboundInspection(Base):
    """`whs_inspections`. Dedicated table for outbound QC (after Material Issue)."""
    __tablename__ = "whs_inspections"

    id = pk()
    inspection_no = Column(String(50), nullable=False, unique=True)
    inspection_date = Column(Date, nullable=False)

    issue_id = Column(ForeignKey("out_issues.id", ondelete="CASCADE"), index=True, nullable=False)
    issue_no = Column(String(50), nullable=True)
    warehouse_id = Column(BigInteger, index=True, nullable=True)
    warehouse_name = Column(String(200), nullable=True)

    status = Column(String(30), nullable=False, default=InspectionStatus.DRAFT.value)

    total_items = Column(Integer, nullable=False, default=0)
    passed_items = Column(Integer, nullable=False, default=0)
    failed_items = Column(Integer, nullable=False, default=0)

    inspector_id = soft_fk()
    inspector_name = Column(String(200), nullable=True)
    remarks = Column(Text, nullable=True)

    # Approval, and only where a QC_OUTWARD ladder is configured. Snapshot columns of
    # the same shape the dispatch carries: the engine owns the chain, the document
    # owns the label the screen shows.
    current_approver_name = Column(String(300), nullable=True)
    approved_by_name = Column(String(200), nullable=True)
    approved_at = Column(DateTime, nullable=True)

    created_at = created_at_col()

    items = relationship(
        "OutboundInspectionItem", back_populates="inspection",
        cascade="all, delete-orphan", order_by="OutboundInspectionItem.id",
    )


class OutboundInspectionItem(CombinationMixin, Base):
    """`whs_inspection_items`. The specific items and quantities inspected for outbound QC."""
    __tablename__ = "whs_inspection_items"

    id = pk()
    inspection_id = Column(ForeignKey("whs_inspections.id", ondelete="CASCADE"),
                           index=True, nullable=False)
    issue_item_id = Column(ForeignKey("out_issue_items.id", ondelete="CASCADE"),
                           index=True, nullable=True)

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
    # A line issued in packages (2026-10-26): units rejected out of each package that
    # was otherwise kept, {code: qty}. A package rejected whole is not in the
    # accepted codes at all.
    pack_rejections = Column(JSON, nullable=True)

    inspection = relationship("OutboundInspection", back_populates="items")

# --------------------------------------------------------------------------- #
# Where these documents keep their "waiting on" snapshot.
#
# Declared HERE, beside the models, because this file is the only place that knows
# the table and column names. `platform.workflow.engine.move_to_workflow` reads the
# registry when an admin moves a document onto another ladder version — that is the
# one transition with no module on the other end to update the row afterwards, and
# before this the document went on naming the approver from the version it had just
# been taken off. See `platform/workflow/doc_registry.py`.
#
# Modules -> platform, never the reverse (rule 5): this passes plain strings, so the
# platform never imports a model.
# --------------------------------------------------------------------------- #
doc_registry.register(DocType.QC_OUTWARD.value, "whs_inspections")
doc_registry.register(DocType.DISPATCH.value, "out_dispatches")
# The three issue ladders all sit on `out_issues` — which of them a given issue is
# filed under is decided per document by `service._issue_doc_type`, so all three have
# to point at the same table or a Move would update one kind of issue and not another.
doc_registry.register(DocType.WH_ISSUE.value, "out_issues")
doc_registry.register(DocType.OWN_STOCK_ISSUE.value, "out_issues")
doc_registry.register(DocType.FORWARD_ISSUE.value, "out_issues")


# ---------------------------------------------------------------------------
# Stock corrections (2026-10-01)
# ---------------------------------------------------------------------------

class StockEdit(Base):
    """`whs_stock_edits`. A request to correct what held stock IS — a batch's number
    or dates, a unit's serial / IMEI / code — signed on the STOCK_EDIT ladder before
    anything is written. Quantities never move, so `stk_ledger` is untouched."""
    __tablename__ = "whs_stock_edits"

    id = pk()
    edit_no = Column(String(50), unique=True, nullable=False)
    warehouse_id = Column(BigInteger, index=True, nullable=False)
    warehouse_name = Column(String(200), nullable=True)
    status = Column(String(30), index=True, nullable=False)
    reason = Column(String(500), nullable=False)
    remarks = Column(Text, nullable=True)
    created_by_id = soft_fk()
    created_by_name = Column(String(200), nullable=True)
    approved_by_id = soft_fk()
    approved_by_name = Column(String(200), nullable=True)
    approved_at = Column(DateTime, nullable=True)
    current_approver_name = Column(String(300), nullable=True)
    created_at = created_at_col()
    updated_at = updated_at_col()

    items = relationship("StockEditItem", back_populates="edit",
                         cascade="all, delete-orphan", lazy="selectin")


class StockEditItem(Base):
    """One corrected batch or unit. `changes` is `{field: {"from": old, "to": new}}`,
    with `from` read by the server at raise time, never taken from the client."""
    __tablename__ = "whs_stock_edit_items"

    id = pk()
    edit_id = Column(ForeignKey("whs_stock_edits.id", ondelete="CASCADE"),
                     index=True, nullable=False)
    target_type = Column(String(10), nullable=False)       # StockEditTarget
    batch_id = Column(BigInteger, index=True, nullable=True)
    serial_id = Column(BigInteger, index=True, nullable=True)
    item_id = Column(BigInteger, index=True, nullable=False)
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    label = Column(String(200), nullable=True)              # what the row was, at raise
    changes = Column(JSON, nullable=False)

    edit = relationship("StockEdit", back_populates="items")


doc_registry.register(DocType.STOCK_EDIT.value, "whs_stock_edits")
