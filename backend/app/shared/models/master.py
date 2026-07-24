"""mst_ tables — SCM's own master data. Owned by shared/."""
from sqlalchemy import (
    Boolean, Column, ForeignKey, Index, Numeric, String, Text,
)

from app.core.database import Base
from app.shared.models.base import created_at_col, pk, updated_at_col


class Uom(Base):
    __tablename__ = "mst_uom"
    id = pk()
    code = Column(String(20), unique=True, nullable=False)
    name = Column(String(100), nullable=False)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = created_at_col()


class ItemCategory(Base):
    __tablename__ = "mst_item_categories"
    id = pk()
    code = Column(String(30), unique=True, nullable=False)
    name = Column(String(150), nullable=False)
    parent_id = Column(ForeignKey("mst_item_categories.id"), index=True, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = created_at_col()


class Item(Base):
    __tablename__ = "mst_items"
    id = pk()
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(300), nullable=False)
    description = Column(Text, nullable=True)
    category_id = Column(ForeignKey("mst_item_categories.id"), index=True, nullable=True)
    category_name = Column(String(200), nullable=True)   # snapshot
    uom_id = Column(ForeignKey("mst_uom.id"), index=True, nullable=True)
    uom_code = Column(String(20), nullable=True)          # snapshot
    hsn_code = Column(String(20), nullable=True)
    reorder_level = Column(Numeric(14, 3), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = created_at_col()
    updated_at = updated_at_col()


# Plain index on name for search. (Guide's Postgres gin/to_tsvector is not portable
# to MySQL/SQLite; search uses LIKE on this index. See root CLAUDE.md deviations.)
Index("ix_mst_items_name", Item.name)
Index("ix_mst_items_is_active", Item.is_active)


class Vendor(Base):
    __tablename__ = "mst_vendors"
    id = pk()
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(200), nullable=False, index=True)
    contact_person = Column(String(150), nullable=True)
    phone = Column(String(30), nullable=True)
    email = Column(String(200), nullable=True)
    address = Column(Text, nullable=True)
    city = Column(String(100), nullable=True)
    state = Column(String(100), nullable=True)
    gstin = Column(String(20), nullable=True)
    pan = Column(String(20), nullable=True)
    payment_terms = Column(String(100), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True, index=True)
    created_at = created_at_col()
    updated_at = updated_at_col()


class VendorItem(Base):
    __tablename__ = "mst_vendor_items"
    id = pk()
    vendor_id = Column(ForeignKey("mst_vendors.id", ondelete="CASCADE"), index=True, nullable=False)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    last_rate = Column(Numeric(14, 2), nullable=True)
    lead_time_days = Column(Numeric(6, 0), nullable=True)
    is_preferred = Column(Boolean, nullable=False, default=False)
