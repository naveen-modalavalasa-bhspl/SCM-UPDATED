"""whs_ tables — the location and warehouse master.

These tables are the DB team's, not ours. They already model exactly what the brief
calls "physical sites, storage points, zones": a warehouse hangs off an HCM facility,
and bins form a tree inside it. Mapping them beats inventing a parallel mst_locations
that would compete with whatever the Warehouse module writes here.

Only the columns the app reads or writes are mapped. Both tables carry NOT NULL
columns with database defaults (warehouse_type='MAIN', bin_type='STORAGE'); mapping
one and passing None sends an explicit NULL that overrides the default and raises 1048.
"""
from sqlalchemy import Boolean, Column, ForeignKey, Index, Integer, Numeric, String

from app.core.database import Base
from app.shared.models.base import created_at_col, pk, soft_fk


class Warehouse(Base):
    """A stocking point. `facility_id` is a soft FK to the HCM mirror (rule 10)."""
    __tablename__ = "whs_warehouses"
    id = pk()
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(200), nullable=False)
    facility_id = soft_fk()
    facility_name = Column(String(200), nullable=True)   # snapshot, saves a join
    office_id = soft_fk()
    office_name = Column(String(200), nullable=True)     # snapshot
    warehouse_type = Column(String(30), nullable=False, default="MAIN")
    address = Column(String(500), nullable=True)
    incharge_id = soft_fk()
    incharge_name = Column(String(200), nullable=True)   # snapshot
    # When false the warehouse stocks in bulk and stk_balance.bin_id stays 0.
    is_bin_managed = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = created_at_col()


Index("ix_whs_warehouses_active", Warehouse.is_active)


class Bin(Base):
    """A storage location inside a warehouse. Bins nest through parent_id, so zone,
    rack and shelf are the same table at different levels rather than three tables."""
    __tablename__ = "whs_bins"
    id = pk()
    warehouse_id = Column(ForeignKey("whs_warehouses.id"), index=True, nullable=False)
    code = Column(String(50), nullable=False)
    name = Column(String(200), nullable=True)
    parent_id = Column(ForeignKey("whs_bins.id"), index=True, nullable=True)
    bin_type = Column(String(30), nullable=False, default="STORAGE")
    path = Column(String(500), nullable=True)      # denormalised ancestry, e.g. A/A-1
    level = Column(Integer, nullable=False, default=1)
    capacity_qty = Column(Numeric(16, 3), nullable=True)
    is_pickable = Column(Boolean, nullable=False, default=True)
    is_active = Column(Boolean, nullable=False, default=True)


Index("ix_whs_bins_warehouse_active", Bin.warehouse_id, Bin.is_active)
