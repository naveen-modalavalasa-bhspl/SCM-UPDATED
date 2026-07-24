"""pro_ tables — Purchase Orders. Owned by modules/procurement.

Backward pointer only: a PO stores indent_id; an indent never stores its PO id.
"""
from sqlalchemy import (
    Column, Date, DateTime, ForeignKey, Numeric, String, Text, Index,
)
from sqlalchemy.orm import relationship

from app.core.database import Base
from app.shared.models.base import created_at_col, pk, soft_fk, updated_at_col


class PurchaseOrder(Base):
    __tablename__ = "pro_purchase_orders"
    id = pk()
    po_no = Column(String(30), unique=True, nullable=False)
    po_date = Column(Date, nullable=True)
    expected_date = Column(Date, nullable=True)

    indent_id = Column(ForeignKey("ind_indents.id"), index=True, nullable=True)  # backward pointer
    indent_no = Column(String(30), nullable=True)   # snapshot

    vendor_id = Column(ForeignKey("mst_vendors.id"), index=True, nullable=False)
    vendor_name = Column(String(200), nullable=True)   # snapshot
    vendor_gstin = Column(String(20), nullable=True)   # snapshot

    created_by_id = soft_fk()
    created_by_name = Column(String(200), nullable=True)  # snapshot
    office_id = soft_fk()
    facility_id = soft_fk()
    facility_name = Column(String(200), nullable=True)

    status = Column(String(30), nullable=False, index=True)
    sub_total = Column(Numeric(16, 2), nullable=False, default=0)
    tax_amount = Column(Numeric(16, 2), nullable=False, default=0)
    total_amount = Column(Numeric(16, 2), nullable=False, default=0)
    current_approver_name = Column(String(200), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    remarks = Column(Text, nullable=True)
    created_at = created_at_col()
    updated_at = updated_at_col()

    items = relationship(
        "POItem", back_populates="po",
        cascade="all, delete-orphan", lazy="selectin",
    )


Index("ix_pro_po_date", PurchaseOrder.po_date.desc())


class POItem(Base):
    __tablename__ = "pro_po_items"
    id = pk()
    po_id = Column(ForeignKey("pro_purchase_orders.id", ondelete="CASCADE"), index=True, nullable=False)
    indent_item_id = Column(ForeignKey("ind_indent_items.id"), index=True, nullable=True)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    uom_code = Column(String(20), nullable=True)
    quantity = Column(Numeric(14, 3), nullable=False)
    rate = Column(Numeric(14, 2), nullable=False, default=0)
    tax_percent = Column(Numeric(5, 2), nullable=False, default=0)
    amount = Column(Numeric(16, 2), nullable=False, default=0)
    received_quantity = Column(Numeric(14, 3), nullable=False, default=0)

    po = relationship("PurchaseOrder", back_populates="items")
