"""ind_ tables — Indents. Owned by modules/indents.

Soft FK + snapshot for HCM people/org; hard FK to mst_items; hard FK with CASCADE
to the parent indent for line items.
"""
from sqlalchemy import (
    Column, Date, DateTime, ForeignKey, Integer, Numeric, String, Text, Index,
)
from sqlalchemy.orm import relationship

from app.core.database import Base
from app.shared.models.base import created_at_col, pk, soft_fk, updated_at_col


class Indent(Base):
    __tablename__ = "ind_indents"
    id = pk()
    indent_no = Column(String(30), unique=True, nullable=False)
    indent_date = Column(Date, nullable=True)
    required_date = Column(Date, nullable=True)

    # who / where (soft FK + snapshot)
    requested_by_id = soft_fk()
    requested_by_name = Column(String(200), nullable=True)
    requested_by_code = Column(String(50), nullable=True)
    department_id = soft_fk()
    department_name = Column(String(200), nullable=True)
    section_id = soft_fk()
    office_id = soft_fk()
    office_name = Column(String(200), nullable=True)
    facility_id = soft_fk()
    facility_name = Column(String(200), nullable=True)

    # state
    status = Column(String(30), nullable=False, index=True)
    priority = Column(String(20), nullable=False, default="NORMAL")
    total_items = Column(Integer, nullable=False, default=0)
    remarks = Column(Text, nullable=True)

    # approval summary (denormalised from wf_ so list screens need no join)
    current_approver_name = Column(String(200), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)

    created_at = created_at_col()
    updated_at = updated_at_col()

    items = relationship(
        "IndentItem", back_populates="indent",
        cascade="all, delete-orphan", lazy="selectin",
    )


Index("ix_ind_indents_dept_status", Indent.department_id, Indent.status)
Index("ix_ind_indents_created", Indent.created_at.desc())


class IndentItem(Base):
    __tablename__ = "ind_indent_items"
    id = pk()
    indent_id = Column(ForeignKey("ind_indents.id", ondelete="CASCADE"), index=True, nullable=False)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)   # snapshot
    item_name = Column(String(300), nullable=True)  # snapshot
    uom_code = Column(String(20), nullable=True)     # snapshot
    quantity = Column(Numeric(14, 3), nullable=False)
    approved_quantity = Column(Numeric(14, 3), nullable=True)
    ordered_quantity = Column(Numeric(14, 3), nullable=False, default=0)    # rolled up from POs
    received_quantity = Column(Numeric(14, 3), nullable=False, default=0)   # rolled up from GRNs
    remarks = Column(Text, nullable=True)

    indent = relationship("Indent", back_populates="items")
