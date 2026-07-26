"""lgs_ tables — GRN and Issues. Owned by modules/logistics.

Stock (stk_balance, stk_ledger) moved to modules/inventory: Inventory is the base
module and owns every stock table, so logistics calls inventory.service.move_stock()
rather than mutating balances itself.

KNOWN GAP: the GRN and Issue models below still map lgs_grn / lgs_issues, which do
not exist in the live SCM_REBUILD schema — the DB team models inbound receipts as
inb_receipts and issues as out_issues. Those belong to the Inventory and Warehouse
modules and are out of scope for the Admin & Masters build, so they are left as-is
and flagged here rather than silently half-migrated.
"""
from sqlalchemy import (
    Column, Date, ForeignKey, Integer, Numeric, String, Text, Index,
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


