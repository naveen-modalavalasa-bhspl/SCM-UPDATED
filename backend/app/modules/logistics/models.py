"""lgs_ and stk_ tables — GRN, Issues, Stock. Owned by modules/logistics.

stk_ledger is an append-only ledger: never UPDATE or DELETE a row. The balance in
stk_balance is keyed item + warehouse + bin + batch + project, which makes
move_stock()'s upsert safe under concurrency.

KNOWN GAP: the GRN and Issue models below still map lgs_grn / lgs_issues, which do
not exist in the live SCM_REBUILD schema — the DB team models inbound receipts as
inb_receipts and issues as out_issues. Those belong to the Inventory and Warehouse
modules and are out of scope for the Admin & Masters build, so they are left as-is
and flagged here rather than silently half-migrated.
"""
from sqlalchemy import (
    BigInteger, Column, Date, DateTime, ForeignKey, Integer, Numeric, String,
    Text, Index, UniqueConstraint,
)
from sqlalchemy.orm import relationship

from app.core.database import Base
from app.shared.models.base import (
    created_at_col, pk, soft_fk, updated_at_col, utcnow,
)


class GRN(Base):
    __tablename__ = "lgs_grn"
    id = pk()
    grn_no = Column(String(30), unique=True, nullable=False)
    grn_date = Column(Date, nullable=True)
    po_id = Column(ForeignKey("pro_purchase_orders.id"), index=True, nullable=True)  # backward pointer
    po_no = Column(String(30), nullable=True)   # snapshot
    vendor_id = soft_fk()
    vendor_name = Column(String(200), nullable=True)
    facility_id = soft_fk()
    facility_name = Column(String(200), nullable=True)
    invoice_no = Column(String(60), nullable=True)
    invoice_date = Column(Date, nullable=True)
    vehicle_no = Column(String(30), nullable=True)
    transporter = Column(String(150), nullable=True)
    received_by_id = soft_fk()
    received_by_name = Column(String(200), nullable=True)
    status = Column(String(30), nullable=False, index=True)
    total_items = Column(Integer, nullable=False, default=0)
    remarks = Column(Text, nullable=True)
    created_at = created_at_col()
    updated_at = updated_at_col()

    items = relationship(
        "GRNItem", back_populates="grn",
        cascade="all, delete-orphan", lazy="selectin",
    )


Index("ix_lgs_grn_facility_date", GRN.facility_id, GRN.grn_date.desc())


class GRNItem(Base):
    __tablename__ = "lgs_grn_items"
    id = pk()
    grn_id = Column(ForeignKey("lgs_grn.id", ondelete="CASCADE"), index=True, nullable=False)
    po_item_id = Column(ForeignKey("pro_po_items.id"), index=True, nullable=True)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    uom_code = Column(String(20), nullable=True)
    ordered_quantity = Column(Numeric(14, 3), nullable=False, default=0)
    received_quantity = Column(Numeric(14, 3), nullable=False, default=0)
    accepted_quantity = Column(Numeric(14, 3), nullable=False, default=0)
    rejected_quantity = Column(Numeric(14, 3), nullable=False, default=0)
    batch_no = Column(String(60), nullable=True)
    expiry_date = Column(Date, nullable=True)
    remarks = Column(Text, nullable=True)

    grn = relationship("GRN", back_populates="items")


class Issue(Base):
    __tablename__ = "lgs_issues"
    id = pk()
    issue_no = Column(String(30), unique=True, nullable=False)
    issue_date = Column(Date, nullable=True)
    indent_id = Column(ForeignKey("ind_indents.id"), index=True, nullable=True)
    indent_no = Column(String(30), nullable=True)
    facility_id = soft_fk()            # issued from
    facility_name = Column(String(200), nullable=True)
    department_id = soft_fk()          # issued to
    department_name = Column(String(200), nullable=True)
    issued_to_id = soft_fk()
    issued_to_name = Column(String(200), nullable=True)
    issued_by_id = soft_fk()
    issued_by_name = Column(String(200), nullable=True)
    status = Column(String(30), nullable=False, index=True)
    remarks = Column(Text, nullable=True)
    created_at = created_at_col()

    items = relationship(
        "IssueItem", back_populates="issue",
        cascade="all, delete-orphan", lazy="selectin",
    )


class IssueItem(Base):
    __tablename__ = "lgs_issue_items"
    id = pk()
    issue_id = Column(ForeignKey("lgs_issues.id", ondelete="CASCADE"), index=True, nullable=False)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    uom_code = Column(String(20), nullable=True)
    quantity = Column(Numeric(14, 3), nullable=False)
    batch_no = Column(String(60), nullable=True)

    issue = relationship("Issue", back_populates="items")


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
    available_qty = Column(Numeric(16, 3), nullable=False, default=0)
    reserved_qty = Column(Numeric(16, 3), nullable=False, default=0)
    transit_qty = Column(Numeric(16, 3), nullable=False, default=0)
    total_qty = Column(Numeric(16, 3), nullable=False, default=0)
    last_movement_at = Column(DateTime, nullable=True)
    updated_at = updated_at_col()
    # valuation_rate and stock_value are left unmapped: NOT NULL with DB defaults, and
    # costing is not this build's concern.
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
