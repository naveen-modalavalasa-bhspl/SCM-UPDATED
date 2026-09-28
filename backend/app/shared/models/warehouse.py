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
    # Verified map position used by the consolidated-trip planner.  Kept on the
    # stocking point rather than on a trip: a route is recalculated many times, but
    # the physical gate does not move.  Nullable keeps every existing warehouse and
    # every existing transaction valid until an administrator verifies the point.
    latitude = Column(Numeric(10, 7), nullable=True)
    longitude = Column(Numeric(10, 7), nullable=True)
    coordinate_source = Column(String(30), nullable=True)
    coordinate_label = Column(String(200), nullable=True)
    coordinate_confidence = Column(Numeric(5, 4), nullable=True)
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


# The storage types that mean "you can put stock here and pick it from here", as the
# system is BORN. Anything else in the tree — a block, a floor, a lane, a rack, a shelf
# — is structure you walk past on the way to a bin, not somewhere stock is counted.
#
# These two are a SEED, not the answer. What a storage type is, and whether stock is
# held in it, is a master now (`StorageType` below): a site
# that racks its goods in "carton bays" adds the rung rather than waiting for a release.
# The list of kinds used to be a hardcoded tuple here and an enum in `shared/enums.py`,
# which is why STAGING — a type the live data has always used — could be read but never
# saved from the form.
BIN_TYPES = ("BIN", "COLD_STORAGE_BIN")

# The codes that answer `is_pickable`, kept in step with the master by the warehouse
# service whenever it reads or writes one (`storage_types.pickable_codes`).
#
# It is a per-process HINT, deliberately: `is_pickable` is a plain property on an ORM
# row, so it cannot go to the database, and a lazy relationship would raise
# MissingGreenlet under async. Every QUERY that filters on pickability reads the master
# instead (`modules.warehouse.storage_types.pickable_codes`) and is therefore always right; this only decorates
# rows that have already been loaded, and it starts life holding today's answer.
_PICKABLE: set[str] = {code.upper() for code in BIN_TYPES}


def pickable_storage_types() -> tuple[str, ...]:
    """The storage type codes stock is held in, as this process last saw them."""
    return tuple(sorted(_PICKABLE))


def set_pickable_storage_types(codes) -> None:
    """Replace the registry from the master. An empty master leaves the seed alone —
    a database that has not been seeded yet must not report every location unpickable."""
    fresh = {str(code).upper() for code in codes if code}
    if not fresh:
        return
    _PICKABLE.clear()
    _PICKABLE.update(fresh)


class StorageType(Base):
    """`whs_warehouse_storage_types` — what KINDS of storage location this company has.

    Floor, lane, rack, shelf, bin, cold room, refrigerator, cold storage bin — and
    whatever else a site actually racks its goods in. This was a hardcoded enum
    (`shared.enums.BinType` plus a `STORAGE_TYPES` tuple) and a matching array in the
    location form, which is why STAGING — a kind the live data has always used — could
    be read and never saved, and why a new rung meant a release. It is a master now.

    Four flags carry everything the rest of the system used to hardcode about a kind:

    * `is_pickable` — is stock HELD here, or is this structure you walk past? The old
      `BIN_TYPES` tuple, as data.
    * `is_temperature_controlled` — a cold-chain kind, so the location form asks for
      the temperature band instead of guessing from the code containing "COLD".
    * `allow_top_level` — may a location of this kind sit at the root of a warehouse?
    * `sort_order` — the rung's depth in the building, so every list reads
      floor, lane, rack, shelf, bin rather than alphabetically.

    Which kinds a kind may sit UNDER is `StorageTypeParent` below.

    A `whs_storage_types` also exists on some servers but is an empty duplicate; do not
    point anything at it.
    """
    __tablename__ = "whs_warehouse_storage_types"

    id = pk()
    code = Column(String(50), nullable=False)
    name = Column(String(50), nullable=False)
    description = Column(String(200), nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)
    is_pickable = Column(Boolean, nullable=False, default=False)
    is_temperature_controlled = Column(Boolean, nullable=False, default=False)
    allow_top_level = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True)


class StorageTypeParent(Base):
    """`whs_storage_type_parents` — which kinds a kind may sit inside.

    A bin goes on a shelf or straight onto a rack; a rack stands in a lane; a lane is
    on a floor. That is what the tree MEANS, and until now it was a `defaultChildType`
    ladder in the browser that only guessed the child of a parent and never constrained
    anything — so a floor could be filed under a bin and nothing said a word.

    A link table rather than a JSON column on the type: the parent list is queried (the
    location form asks "which locations may this one hang off"), and `whs_*` tables that
    carry JSON are the ones the ORDER BY rule in CLAUDE.md exists for.

    No row for a kind means it can only sit at the top — which is why `allow_top_level`
    is a separate flag: a floor both hangs off a block AND stands on its own.
    """
    __tablename__ = "whs_storage_type_parents"

    id = pk()
    storage_type_id = Column(
        ForeignKey("whs_warehouse_storage_types.id", ondelete="CASCADE"),
        index=True, nullable=False)
    parent_storage_type_id = Column(
        ForeignKey("whs_warehouse_storage_types.id", ondelete="CASCADE"),
        index=True, nullable=False)

    __table_args__ = (
        Index("uq_whs_storage_type_parent", "storage_type_id",
              "parent_storage_type_id", unique=True),
    )


class WarehouseLocation(Base):
    """`whs_warehouse_locations` — every storage point inside a warehouse.

    There is no `whs_bins` table on this deployment and there does not need to be: the
    DB team folded bins into this tree, so a bin is simply a location whose
    `storage_type` is a pickable kind, sitting under its shelf, rack, lane and floor
    in the same table. One tree beats a locations table and a bins table that have to
    agree with each other.

    A location's KIND is `storage_type_id` — a row of `whs_warehouse_storage_types`,
    the storage-type master — and `storage_type` is that row's code, denormalised so
    every query that already reads the code keeps working. Only the warehouse service
    writes the pair, so they cannot drift.

    `bin_*` attribute names are kept as synonyms because the Warehouse module and its
    screens were written against a separate bins table. They are the same columns under
    the older names, not a second row.

    Deliberately absent: `path` and `level` (ancestry is derived from `parent_id` when a
    tree is built, so it cannot go stale) and `is_pickable` (a location is pickable when
    its TYPE is — see the storage-type master — rather than by a flag on the row that
    someone can set to contradict its own kind).
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
    # The three gates a putaway is checked against, plus the discrete one.
    #
    # `capacity_volume` is the stated cube in m3. Left blank it is DERIVED from the
    # three dimensions below, so a bin measured once needs nothing typed twice.
    capacity_volume = Column(Numeric(16, 3), nullable=True)
    # Gate 2: what the rack can physically carry, against the GROSS weight of the
    # handling units standing on it.
    max_weight_capacity = Column(Numeric(16, 3), nullable=True)
    # Gate 3: the bin's own inner bounding box. A pallet whose cube "fits" a shelf it
    # is too wide to enter does not fit, and only these three columns can say so.
    length_cm = Column(Numeric(10, 2), nullable=True)
    width_cm = Column(Numeric(10, 2), nullable=True)
    height_cm = Column(Numeric(10, 2), nullable=True)
    # Gate 4, the discrete one: "this bay takes one euro-pallet, or four totes". No
    # cube expresses that, and it is the limit a floor actually works to.
    max_handling_units = Column(Integer, nullable=True)
    # Void factor for the bin itself — gangway, dunnage, the space you need to get a
    # hand in. NULL means 100%, i.e. nobody has derated this location.
    fill_efficiency_pct = Column(Numeric(5, 2), nullable=True)
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
        """Does this KIND of location hold stock? Answered by the storage-type master
        (see `_PICKABLE` above for why it is read from a registry and not a join)."""
        return (self.bin_type or "").upper() in _PICKABLE


# The Warehouse module and the masters screens both grew up calling this a bin.
Bin = WarehouseLocation

Index("ix_whs_locations_warehouse_active",
      WarehouseLocation.warehouse_id, WarehouseLocation.is_active)
