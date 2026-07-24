"""lgs_ and stk_ tables — GRN, Issues, Stock. Owned by modules/logistics.

stk_movements is an append-only ledger: never UPDATE or DELETE a row.
Stock is facility-wise: UNIQUE(facility_id, item_id) makes move_stock() upsert
safe under concurrency.
"""
from sqlalchemy import (
    BigInteger, Column, Date, ForeignKey, Integer, Numeric, String,
    Text, Index, UniqueConstraint,
)
from sqlalchemy.orm import relationship

from app.core.database import Base
from app.shared.models.base import created_at_col, pk, soft_fk, updated_at_col


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


class Stock(Base):
    __tablename__ = "stk_stock"    # current balance, one row per item+facility
    id = pk()
    facility_id = Column(BigInteger, index=True, nullable=False)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)   # snapshot
    item_name = Column(String(300), nullable=True)  # snapshot
    quantity = Column(Numeric(16, 3), nullable=False, default=0)
    reserved_quantity = Column(Numeric(16, 3), nullable=False, default=0)
    updated_at = updated_at_col()
    __table_args__ = (UniqueConstraint("facility_id", "item_id", name="uq_stock_facility_item"),)


class StockMovement(Base):
    __tablename__ = "stk_movements"   # append-only ledger
    id = pk()
    facility_id = Column(BigInteger, index=True, nullable=False)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    direction = Column(String(3), nullable=False)   # IN | OUT
    quantity = Column(Numeric(16, 3), nullable=False)
    balance_after = Column(Numeric(16, 3), nullable=False)
    ref_type = Column(String(20), nullable=True)    # GRN | ISSUE | ADJUSTMENT | TRANSFER
    ref_id = Column(BigInteger, nullable=True)
    ref_no = Column(String(30), nullable=True)
    created_by_id = soft_fk()
    created_by_name = Column(String(200), nullable=True)
    remarks = Column(Text, nullable=True)
    created_at = created_at_col()


Index("ix_stk_mov_item_created", StockMovement.item_id, StockMovement.created_at.desc())
Index("ix_stk_mov_ref", StockMovement.ref_type, StockMovement.ref_id)
