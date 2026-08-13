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
from sqlalchemy.orm import synonym

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
    # Does a consignment landing here have to go through Material Inward -> GRN -> QC
    # before its stock counts? NULL means "whatever the company default says"
    # (settings key warehouse.requires_inward_default), so a point that was never
    # configured keeps behaving exactly as it did before the column existed. True
    # holds the goods until the GRN posts them; false credits them the moment the
    # receiver acknowledges the consignment.
    requires_inward = Column(Boolean, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = created_at_col()


Index("ix_whs_warehouses_active", Warehouse.is_active)


# The storage types that mean "you can put stock here and pick it from here". Anything
# else in the tree — a block, a floor, a lane, a rack, a shelf — is structure you walk
# past on the way to a bin, not somewhere stock is counted.
BIN_TYPES = ("BIN", "COLD_STORAGE_BIN")

# What `whs_warehouse_locations.storage_type` — a MySQL ENUM — actually accepts. It is a
# subset of `enums.BinType`, which carries values other deployments' data uses. Sending
# anything else is rejected by the database with a truncation error, i.e. a 500 on a
# form the user filled in correctly, so the write schema checks it here and 422s instead.
STORAGE_TYPES = (
    "BLOCK", "FLOOR", "LANE", "RACK", "SHELF", "BIN", "LOT",
    "COLD_ROOM", "REFRIGERATOR", "COLD_STORAGE_BIN", "PALLET",
)


class WarehouseLocation(Base):
    """`whs_warehouse_locations` — every storage point inside a warehouse.

    There is no `whs_bins` table on this deployment and there does not need to be: the
    DB team folded bins into this tree, so a bin is simply a location whose
    `storage_type` is one of `BIN_TYPES`, sitting under its shelf, rack, lane and floor
    in the same table. One tree beats a locations table and a bins table that have to
    agree with each other.

    `bin_*` attribute names are kept as synonyms because the Warehouse module and its
    screens were written against a separate bins table. They are the same columns under
    the older names, not a second row.

    Deliberately absent: `path` and `level` (ancestry is derived from `parent_id` when a
    tree is built, so it cannot go stale) and `is_pickable` (a location is pickable when
    it is a bin — see `BIN_TYPES` — rather than by a flag someone can contradict).
    """
    __tablename__ = "whs_warehouse_locations"
    id = pk()
    warehouse_id = Column(ForeignKey("whs_warehouses.id"), index=True, nullable=False)
    code = Column(String(50), nullable=False)
    name = Column(String(200), nullable=True)
    description = Column(String(500), nullable=True)
    parent_id = Column("parent_location_id", ForeignKey("whs_warehouse_locations.id"),
                       index=True, nullable=True)
    bin_type = Column("storage_type", String(50), nullable=True)
    storage_type_id = Column(Numeric(20, 0), nullable=True)
    barcode = Column(String(100), nullable=True)
    # Both are whole numbers in the database (`int`), not labels: floor 0, shelf 3.
    # Declaring them as strings made SQLAlchemy hand the router an `int` anyway — the
    # driver decides — and every read of a location with a floor set failed validation.
    floor_level = Column(Integer, nullable=True)
    shelf_level = Column(Integer, nullable=True)

    capacity_weight = Column(Numeric(16, 3), nullable=True)
    capacity_volume = Column(Numeric(16, 3), nullable=True)
    max_weight_capacity = Column(Numeric(16, 3), nullable=True)
    height_cm = Column(Numeric(10, 2), nullable=True)
    aisle_width_meters = Column(Numeric(10, 2), nullable=True)

    temperature_controlled = Column(Boolean, nullable=False, default=False)
    humidity_percentage = Column(Numeric(5, 2), nullable=True)
    target_temperature_celsius = Column(Numeric(5, 2), nullable=True)
    min_temperature_celsius = Column(Numeric(5, 2), nullable=True)
    max_temperature_celsius = Column(Numeric(5, 2), nullable=True)

    is_active = Column(Boolean, nullable=False, default=True)

    # What the Warehouse module calls a bin's capacity is this table's weight capacity.
    capacity_qty = synonym("capacity_weight")
    # The column the location screens read; same column as `parent_id`.
    parent_location_id = synonym("parent_id")
    storage_type = synonym("bin_type")

    @property
    def is_pickable(self) -> bool:
        """Stock is only ever put into, or picked from, an actual bin."""
        return (self.bin_type or "").upper() in BIN_TYPES


# The Warehouse module and the masters screens both grew up calling this a bin.
Bin = WarehouseLocation

Index("ix_whs_locations_warehouse_active",
      WarehouseLocation.warehouse_id, WarehouseLocation.is_active)