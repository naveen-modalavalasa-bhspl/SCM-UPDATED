"""stk_ tables — Inventory owns stock.

stk_balance and stk_ledger are the DB team's tables; only the columns the app reads or
writes are mapped. stk_ledger is append-only: never UPDATE or DELETE a row. The balance
is keyed item + warehouse + bin + batch + project, which makes move_stock()'s upsert
safe under concurrency.

Inventory is the base module — it imports nothing from app.modules — so every later
module can call move_stock() without inverting the import chain.
"""
from sqlalchemy import (
    BigInteger, Column, Date, DateTime, ForeignKey, Index, Integer, Numeric, String,
    Text, UniqueConstraint,
)
from sqlalchemy.orm import relationship

from app.core.database import Base
from app.shared.enums import Priority, ReservationStatus
from app.shared.models.base import created_at_col, pk, soft_fk, updated_at_col, utcnow

"""0 rather than NULL means "not set" for bin, batch and project.

MySQL lets NULLs repeat inside a unique index, so a nullable dimension would silently
allow two balance rows for the same item in the same place. The DB team already uses
this convention for bin_id and batch_id; project_id follows it.
"""
NO_PROJECT = 0
NO_BIN = 0
NO_BATCH = 0


class Stock(Base):
    """Current balance — the DB team's stk_balance.

    Keyed item + warehouse + bin + batch + project. The project dimension is what lets
    stock move between projects without touching mst_items, per the brief.
    """
    __tablename__ = "stk_balance"
    id = pk()
    warehouse_id = Column(BigInteger, index=True, nullable=False)
    warehouse_name = Column(String(200), nullable=True)   # snapshot, saves a join
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)         # snapshot
    item_name = Column(String(300), nullable=True)        # snapshot
    uom_code = Column(String(20), nullable=True)          # snapshot
    bin_id = Column(BigInteger, nullable=False, default=NO_BIN)
    bin_code = Column(String(50), nullable=True)
    batch_id = Column(BigInteger, nullable=False, default=NO_BATCH)
    batch_no = Column(String(50), nullable=True)
    expiry_date = Column(Date, nullable=True)
    project_id = Column(BigInteger, index=True, nullable=False, default=NO_PROJECT)
    project_name = Column(String(200), nullable=True)     # snapshot
    serial_number = Column(String(50), nullable=True)
    asset_code = Column(String(40), nullable=True)
    consumable_code = Column(String(40), nullable=True)
    available_qty = Column(Numeric(16, 3), nullable=False, default=0)
    reserved_qty = Column(Numeric(16, 3), nullable=False, default=0)
    transit_qty = Column(Numeric(16, 3), nullable=False, default=0)
    total_qty = Column(Numeric(16, 3), nullable=False, default=0)
    # The DB team's own costing columns. Both are 0 across the live data today, so the
    # screens show "not costed" rather than a rupee figure — a real zero beats a
    # plausible number invented in the frontend.
    valuation_rate = Column(Numeric(16, 4), nullable=False, default=0)
    stock_value = Column(Numeric(16, 2), nullable=False, default=0)
    last_movement_at = Column(DateTime, nullable=True)
    updated_at = updated_at_col()
    __table_args__ = (
        UniqueConstraint("item_id", "warehouse_id", "bin_id", "batch_id", "project_id",
                         name="uq_stk_balance_item_wh_bin_batch_proj"),
    )


class StockMovement(Base):
    """Append-only ledger — the DB team's stk_ledger. Never updated, never deleted."""
    __tablename__ = "stk_ledger"
    id = pk()
    txn_date = Column(DateTime, nullable=False, default=utcnow)
    warehouse_id = Column(BigInteger, index=True, nullable=False)
    warehouse_name = Column(String(200), nullable=True)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    uom_code = Column(String(20), nullable=True)
    bin_id = Column(BigInteger, nullable=False, default=NO_BIN)
    bin_code = Column(String(50), nullable=True)
    batch_id = Column(BigInteger, nullable=False, default=NO_BATCH)
    batch_no = Column(String(50), nullable=True)
    project_id = Column(BigInteger, index=True, nullable=False, default=NO_PROJECT)
    direction = Column(String(3), nullable=False)   # StockDirection: IN | OUT
    quantity = Column(Numeric(16, 3), nullable=False)
    balance_after = Column(Numeric(16, 3), nullable=False)
    ref_type = Column(String(30), nullable=False)   # RefType
    ref_id = Column(BigInteger, nullable=True)
    ref_no = Column(String(50), nullable=True)
    remarks = Column(String(500), nullable=True)
    created_by_id = soft_fk()
    created_by_name = Column(String(200), nullable=True)
    created_at = created_at_col()
    # rate and value are left unmapped, as above.


Index("ix_stk_ledger_item_created", StockMovement.item_id,
      StockMovement.created_at.desc())
Index("ix_stk_ledger_ref", StockMovement.ref_type, StockMovement.ref_id)


class Reservation(Base):
    """One row per promised quantity — stock spoken for but not yet issued.

    Exists so stk_balance.reserved_qty is explainable: a reserved quantity with no
    matching ACTIVE reservation is a bug the system can detect. Rows are never
    deleted, only moved to RELEASED or CONSUMED, because "who held this stock in
    March" has to stay answerable.

    Reserving is not a stock movement — nothing has physically moved — so there is no
    stk_ledger row and total_qty is untouched. See allocation.py.
    """
    __tablename__ = "inv_reservations"
    id = pk()
    stock_id = Column(ForeignKey("stk_balance.id", ondelete="CASCADE"),
                      index=True, nullable=False)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    # denormalised from the stock row so a reservation report needs no join
    warehouse_id = Column(BigInteger, index=True, nullable=False)
    bin_id = Column(BigInteger, nullable=False, default=NO_BIN)
    batch_id = Column(BigInteger, nullable=False, default=NO_BATCH)
    project_id = Column(BigInteger, nullable=False, default=NO_PROJECT)
    quantity = Column(Numeric(16, 3), nullable=False)
    ref_type = Column(String(30), nullable=False)      # RefType
    ref_id = Column(BigInteger, nullable=False)
    ref_no = Column(String(50), nullable=True)
    ref_line_id = Column(BigInteger, index=True, nullable=True)   # ind_indent_items.id
    status = Column(String(20), nullable=False, index=True,
                    default=ReservationStatus.ACTIVE.value)
    created_by_id = soft_fk()
    created_by_name = Column(String(200), nullable=True)
    created_at = created_at_col()
    released_at = Column(DateTime, nullable=True)


Index("ix_inv_reservations_ref", Reservation.ref_type, Reservation.ref_id)
Index("ix_inv_reservations_active", Reservation.status, Reservation.item_id)


class Allocation(Base):
    """Inventory's decision on how much stock an approved indent actually gets.

    This is a document, not a calculation. Sixty bags of cement with four projects
    wanting it is a judgement: who gets what, from which warehouse, and what waits.
    Recording it means "why did this project get 40 and not 60" has an answer, and it
    can go through its own approval chain (DocType.ALLOCATION) where a site wants the
    inventory manager to sign off on what an executive proposed.

    Nothing is reserved until this reaches APPROVED.
    """
    __tablename__ = "inv_allocations"
    id = pk()
    allocation_no = Column(String(30), unique=True, nullable=False)
    indent_id = Column(BigInteger, index=True, nullable=False)
    indent_no = Column(String(30), nullable=True)
    status = Column(String(30), nullable=False)
    allocated_by_id = soft_fk()
    allocated_by_name = Column(String(200), nullable=True)
    department_id = soft_fk()
    remarks = Column(Text, nullable=True)
    current_approver_name = Column(String(200), nullable=True)
    approved_at = Column(DateTime, nullable=True)
    created_at = created_at_col()
    updated_at = updated_at_col()

    items = relationship("AllocationItem", back_populates="allocation",
                         cascade="all, delete-orphan", lazy="selectin")


Index("ix_inv_allocations_status_created", Allocation.status,
      Allocation.created_at.desc())


class AllocationItem(Base):
    """One decision: this indent line gets this much, out of this warehouse.

    A line can appear more than once when the allocator splits it across warehouses.
    quantity may be zero -- "give nothing now" is a valid, recorded decision.
    """
    __tablename__ = "inv_allocation_items"
    id = pk()
    allocation_id = Column(ForeignKey("inv_allocations.id", ondelete="CASCADE"),
                           index=True, nullable=False)
    indent_item_id = Column(BigInteger, index=True, nullable=False)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    uom_code = Column(String(20), nullable=True)
    requested_qty = Column(Numeric(16, 3), nullable=False, default=0)
    quantity = Column(Numeric(16, 3), nullable=False, default=0)   # what to give
    warehouse_id = Column(BigInteger, nullable=True)
    warehouse_name = Column(String(200), nullable=True)
    project_id = Column(BigInteger, nullable=False, default=NO_PROJECT)
    remarks = Column(String(500), nullable=True)

    allocation = relationship("Allocation", back_populates="items")


class MaterialRequest(Base):
    """The bridge from a short indent to procurement.

    Flow doc §4.2 raises it at inventory level; §5.1 has procurement approve it. It
    lives in inventory rather than procurement so the import chain stays one-way —
    inventory is the base module and procurement reads it, not the reverse.
    """
    __tablename__ = "inv_material_requests"
    id = pk()
    mr_no = Column(String(30), unique=True, nullable=False)
    mr_date = Column(Date, nullable=True)
    # backward pointer to the indent that ran short (business flow: each doc points back)
    indent_id = Column(BigInteger, index=True, nullable=True)
    indent_no = Column(String(30), nullable=True)
    requested_by_id = soft_fk()
    requested_by_name = Column(String(200), nullable=True)
    department_id = soft_fk()
    department_name = Column(String(200), nullable=True)
    facility_id = soft_fk()
    project_id = soft_fk()
    project_name = Column(String(200), nullable=True)
    # No index=True here: the composite below already leads with status, and an
    # auto-named single-column index would collide with it (MySQL 1061).
    status = Column(String(30), nullable=False)
    priority = Column(String(20), nullable=False, default=Priority.NORMAL.value)
    required_by = Column(Date, nullable=True)
    remarks = Column(Text, nullable=True)
    # denormalised from wf_ so list screens need no join
    current_approver_name = Column(String(200), nullable=True)
    approved_at = Column(DateTime, nullable=True)
    created_at = created_at_col()
    updated_at = updated_at_col()

    items = relationship("MaterialRequestItem", back_populates="mr",
                         cascade="all, delete-orphan", lazy="selectin")


Index("ix_inv_material_requests_status_created", MaterialRequest.status,
      MaterialRequest.created_at.desc())


class MaterialRequestItem(Base):
    __tablename__ = "inv_material_request_items"
    id = pk()
    mr_id = Column(ForeignKey("inv_material_requests.id", ondelete="CASCADE"),
                   index=True, nullable=False)
    line_no = Column(Integer, nullable=False, default=1)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)     # snapshot
    item_name = Column(String(300), nullable=True)    # snapshot
    uom_code = Column(String(20), nullable=True)      # snapshot
    quantity = Column(Numeric(16, 3), nullable=False)
    ordered_quantity = Column(Numeric(16, 3), nullable=False, default=0)
    project_id = Column(BigInteger, nullable=False, default=NO_PROJECT)
    indent_item_id = Column(BigInteger, index=True, nullable=True)
    remarks = Column(String(500), nullable=True)

    mr = relationship("MaterialRequest", back_populates="items")


class StockAdjustment(Base):
    """Stock adjustment with reason (damage, expiry, count variance, found).

    Must go through move_stock() so a ledger row is written. Large adjustments
    require approval before move_stock() is called.
    """
    __tablename__ = "inv_adjustments"
    id = pk()
    adjustment_no = Column(String(30), unique=True, nullable=False)
    warehouse_id = Column(BigInteger, index=True, nullable=False)
    warehouse_name = Column(String(200), nullable=True)
    reason = Column(String(50), nullable=False)   # DAMAGE, EXPIRY, COUNT_VARIANCE, FOUND, etc.
    status = Column(String(30), nullable=False)   # DRAFT, PENDING_APPROVAL, APPROVED, REJECTED
    remarks = Column(Text, nullable=True)
    created_by_id = soft_fk()
    created_by_name = Column(String(200), nullable=True)
    approved_by_id = soft_fk()
    approved_by_name = Column(String(200), nullable=True)
    approved_at = Column(DateTime, nullable=True)
    created_at = created_at_col()
    updated_at = updated_at_col()

    items = relationship("StockAdjustmentItem", back_populates="adjustment",
                         cascade="all, delete-orphan", lazy="selectin")


class StockAdjustmentItem(Base):
    __tablename__ = "inv_adjustment_items"
    id = pk()
    adjustment_id = Column(ForeignKey("inv_adjustments.id", ondelete="CASCADE"),
                           index=True, nullable=False)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    uom_code = Column(String(20), nullable=True)
    bin_id = Column(BigInteger, nullable=False, default=NO_BIN)
    batch_id = Column(BigInteger, nullable=False, default=NO_BATCH)
    project_id = Column(BigInteger, nullable=False, default=NO_PROJECT)
    direction = Column(String(3), nullable=False)   # StockDirection: IN | OUT
    quantity = Column(Numeric(16, 3), nullable=False)
    unit_cost = Column(Numeric(16, 2), nullable=True, default=0.00)
    remarks = Column(String(500), nullable=True)

    adjustment = relationship("StockAdjustment", back_populates="items")


class StockTransferOrder(Base):
    """Stock Transfer Order (STO): create -> approval -> dispatch -> receive.

    Stock moves physically ONLY upon receipt (via move_stock).
    """
    __tablename__ = "inv_sto"
    id = pk()
    sto_no = Column(String(30), unique=True, nullable=False)
    from_warehouse_id = Column(BigInteger, nullable=False)
    from_warehouse_name = Column(String(200), nullable=True)
    to_warehouse_id = Column(BigInteger, nullable=False)
    to_warehouse_name = Column(String(200), nullable=True)
    from_project_id = Column(BigInteger, nullable=False, default=NO_PROJECT)
    to_project_id = Column(BigInteger, nullable=False, default=NO_PROJECT)
    status = Column(String(30), nullable=False, index=True) # DRAFT, PENDING_APPROVAL, APPROVED, DISPATCHED, RECEIVED, REJECTED, CANCELLED
    requested_by_id = soft_fk()
    requested_by_name = Column(String(200), nullable=True)
    approved_by_name = Column(String(200), nullable=True)
    approved_at = Column(DateTime, nullable=True)
    dispatched_at = Column(DateTime, nullable=True)
    received_at = Column(DateTime, nullable=True)
    remarks = Column(Text, nullable=True)
    created_at = created_at_col()
    updated_at = updated_at_col()

    items = relationship("StockTransferOrderItem", back_populates="sto",
                         cascade="all, delete-orphan", lazy="selectin")


class StockTransferOrderItem(Base):
    __tablename__ = "inv_sto_items"
    id = pk()
    sto_id = Column(ForeignKey("inv_sto.id", ondelete="CASCADE"),
                    index=True, nullable=False)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    uom_code = Column(String(20), nullable=True)
    requested_qty = Column(Numeric(16, 3), nullable=False)
    dispatched_qty = Column(Numeric(16, 3), nullable=False, default=0)
    received_qty = Column(Numeric(16, 3), nullable=False, default=0)
    remarks = Column(String(500), nullable=True)

    sto = relationship("StockTransferOrder", back_populates="items")


class CycleCount(Base):
    """Cycle count: plan count -> enter counted quantity -> show variance -> post adjustment."""
    __tablename__ = "inv_cycle_counts"
    id = pk()
    count_no = Column(String(30), unique=True, nullable=False)
    warehouse_id = Column(BigInteger, index=True, nullable=False)
    warehouse_name = Column(String(200), nullable=True)
    count_date = Column(Date, nullable=False)
    status = Column(String(30), nullable=False, index=True) # PLANNED, IN_PROGRESS, COMPLETED, CANCELLED
    planned_by_name = Column(String(200), nullable=True)
    posted_by_name = Column(String(200), nullable=True)
    posted_at = Column(DateTime, nullable=True)
    remarks = Column(Text, nullable=True)
    created_at = created_at_col()
    updated_at = updated_at_col()

    items = relationship("CycleCountItem", back_populates="cycle_count",
                         cascade="all, delete-orphan", lazy="selectin")


class CycleCountItem(Base):
    __tablename__ = "inv_cycle_count_items"
    id = pk()
    cycle_count_id = Column(ForeignKey("inv_cycle_counts.id", ondelete="CASCADE"),
                            index=True, nullable=False)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    uom_code = Column(String(20), nullable=True)
    bin_id = Column(BigInteger, nullable=False, default=NO_BIN)
    batch_id = Column(BigInteger, nullable=False, default=NO_BATCH)
    snapshot_qty = Column(Numeric(16, 3), nullable=False, default=0)
    counted_qty = Column(Numeric(16, 3), nullable=True)
    variance_qty = Column(Numeric(16, 3), nullable=True)
    remarks = Column(String(500), nullable=True)

    cycle_count = relationship("CycleCount", back_populates="items")



class PositionLocation(Base):
    """Which stocking points a POSITION draws from — the MDP/LIP tagging.

    Keyed by position, not by employee: people move, the post does not, and the
    approval ladder already reasons in positions. Many rows per position on purpose —
    one OE can cover several MDPs.

    `project_id` is snapshotted here because a stocking point has no project of its
    own: `whs_warehouses` carries office and facility, and HCM keeps the project on
    the employee. Without it there is nothing to compare for the cross-project rule
    that decides whether the Inventory Manager has to approve a transfer.
    """
    __tablename__ = "inv_position_locations"
    __table_args__ = (
        UniqueConstraint("position_id", "warehouse_id", name="uq_inv_position_location"),
    )

    id = pk()
    position_id = soft_fk()          # hcm_positions.id — soft, HCM is a mirror
    warehouse_id = Column(ForeignKey("whs_warehouses.id", ondelete="CASCADE"),
                          index=True, nullable=False)
    project_id = Column(BigInteger, nullable=False, default=NO_PROJECT, index=True)
    project_name = Column(String(200), nullable=True)   # snapshot, never re-synced
    # The point this position issues from by default when it holds more than one.
    is_primary = Column(Integer, nullable=False, default=0)
    is_active = Column(Integer, nullable=False, default=1)
    created_at = created_at_col()


Index("ix_inv_position_locations_active", PositionLocation.position_id,
      PositionLocation.is_active)
