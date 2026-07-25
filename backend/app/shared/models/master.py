"""mst_ tables — SCM's own master data. Owned by shared/."""
from sqlalchemy import (
    Boolean, Column, Date, ForeignKey, Index, Integer, Numeric, String,
)

from app.core.database import Base
from app.shared.models.base import created_at_col, pk, soft_fk, updated_at_col


class Uom(Base):
    # Maps only the columns the app uses. The live table also has NOT-NULL columns
    # (uom_class, decimal_places) with DB defaults; leaving them UNMAPPED lets those
    # defaults apply on insert — mapping them and passing None would send an explicit
    # NULL that overrides the default and raises IntegrityError.
    __tablename__ = "mst_uom"
    id = pk()
    code = Column(String(20), unique=True, nullable=False)
    name = Column(String(100), nullable=False)
    is_active = Column(Boolean, nullable=False, default=True)


class ItemCategory(Base):
    # Columns mirror the DB team's live mst_item_categories table exactly. Keep in
    # sync with SHOW COLUMNS mst_item_categories — a stray column crashes SELECTs.
    __tablename__ = "mst_item_categories"
    id = pk()
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(200), nullable=False)
    parent_id = Column(ForeignKey("mst_item_categories.id"), index=True, nullable=True)
    # NOT NULL in the live table with DB default 1; mirror the default so inserts that
    # don't compute a tree level still satisfy the constraint. (path is left unmapped.)
    level = Column(Integer, nullable=False, default=1)
    is_active = Column(Boolean, nullable=False, default=True)


class Item(Base):
    # Columns mirror the DB team's live mst_items table exactly. Keep in sync with
    # SHOW COLUMNS mst_items — a column here that the table lacks makes select(Item)
    # fail with "Unknown column", which empties the /api/items dropdown.
    __tablename__ = "mst_items"
    id = pk()
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(300), nullable=False)
    short_name = Column(String(100), nullable=True)
    category_id = Column(ForeignKey("mst_item_categories.id"), index=True, nullable=True)
    category_name = Column(String(200), nullable=True)   # snapshot
    uom_id = Column(ForeignKey("mst_uom.id"), index=True, nullable=True)
    uom_code = Column(String(20), nullable=True)          # snapshot
    item_type = Column(String(30), nullable=True)
    hsn_code = Column(String(20), nullable=True)
    tax_percent = Column(Numeric(6, 3), nullable=True)
    is_batch_tracked = Column(Boolean, nullable=False, default=False)
    is_serial_tracked = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = created_at_col()
    updated_at = updated_at_col()


# Plain index on name for search. (Guide's Postgres gin/to_tsvector is not portable
# to MySQL/SQLite; search uses LIKE on this index. See root CLAUDE.md deviations.)
Index("ix_mst_items_name", Item.name)
Index("ix_mst_items_is_active", Item.is_active)


class Vendor(Base):
    # Maps only the columns the app reads/writes. The live table has more (vendor_type,
    # rating, credit_limit, is_approved, is_blacklisted, pincode, payment_terms_days,
    # pan, address) — some NOT NULL with DB defaults (e.g. vendor_type='MATERIAL').
    # Those are left UNMAPPED so their defaults apply on insert; mapping a NOT-NULL
    # column and passing None sends an explicit NULL that overrides the default.
    __tablename__ = "mst_vendors"
    id = pk()
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(200), nullable=False, index=True)
    contact_person = Column(String(150), nullable=True)
    phone = Column(String(30), nullable=True)
    email = Column(String(200), nullable=True)
    city = Column(String(100), nullable=True)
    state = Column(String(100), nullable=True)
    gstin = Column(String(20), nullable=True)
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


class UomConversion(Base):
    """factor = how many `to_uom` in one `from_uom`. BOX -> PCS with factor 12 means
    one box is twelve pieces. Only the forward direction is stored; the reverse is
    1/factor, so a pair cannot disagree with itself.

    Columns mirror the DB team's live table exactly — it has no is_active and no code
    snapshots, so neither is mapped (a mapped column the table lacks raises 1054 on
    every SELECT).
    """
    __tablename__ = "mst_uom_conversions"
    id = pk()
    from_uom_id = Column(ForeignKey("mst_uom.id", ondelete="CASCADE"), index=True,
                         nullable=False)
    to_uom_id = Column(ForeignKey("mst_uom.id", ondelete="CASCADE"), index=True,
                       nullable=False)
    factor = Column(Numeric(16, 6), nullable=False)


class Project(Base):
    """Projects own stock without owning items: mst_items stays project-agnostic and
    the project dimension lives on the stock ledger, so a transfer between projects
    never touches the item master.

    Maps only the columns the app uses; the live table also has customer_*, manager_*,
    budget_amount and created_at, some NOT NULL with DB defaults (status='ACTIVE').
    """
    __tablename__ = "mst_projects"
    id = pk()
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(200), nullable=False)
    office_id = soft_fk()
    office_name = Column(String(200), nullable=True)
    start_date = Column(Date, nullable=True)
    end_date = Column(Date, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
