"""stk_ tables — Inventory owns stock.

stk_balance and stk_ledger are the DB team's tables; only the columns the app reads or
writes are mapped. stk_ledger is append-only: never UPDATE or DELETE a row. The balance
is keyed item + warehouse + bin + batch + project, which makes move_stock()'s upsert
safe under concurrency.

Inventory is the base module — it imports nothing from app.modules — so every later
module can call move_stock() without inverting the import chain.
"""
from sqlalchemy import (
    BigInteger, Column, Date, DateTime, ForeignKey, Index, Numeric, String,
    UniqueConstraint,
)

from app.core.database import Base
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
