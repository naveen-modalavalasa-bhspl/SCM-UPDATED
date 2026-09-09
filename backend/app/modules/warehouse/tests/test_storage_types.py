"""The storage-type master, and the shape of the building it describes.

The kinds of storage location — floor, lane, rack, shelf, bin, cold room — used to be
an enum in `shared/enums.py`, a tuple in `shared/models/warehouse.py` and an array in
the browser. They are rows now, and two rules come with them:

* **A kind sits where the master says it sits.** A bin goes on a shelf or a rack; it
  does not go on a floor's floor. That used to be a `defaultChildType` ladder in the
  location form that guessed a child's kind and constrained nothing, so a floor could
  be filed under a bin with nothing said.
* **Pickability is a property of the kind**, not a tuple compiled into the code, which
  is what `test_a_new_pickable_kind_is_offered_as_a_location_for_stock` is about.

The seeded ladder lives in `storage_types.DEFAULTS` and is loaded for every test by the
`engine` fixture, exactly as `bootstrap` loads it for a real database.
"""
from decimal import Decimal

import pytest

from app.core.exceptions import ValidationError
from app.modules.warehouse import schemas as s, service, storage_types
from app.shared.models.warehouse import Bin, Warehouse


async def _warehouse(db, code="WH-ST"):
    wh = Warehouse(code=code, name=code, warehouse_type="MAIN", is_active=True,
                   is_bin_managed=True)
    db.add(wh)
    await db.flush()
    return wh


def _write(code, *, warehouse_id, bin_type=None, storage_type_id=None, parent_id=None):
    return s.BinWrite(warehouse_id=warehouse_id, code=code, bin_type=bin_type,
                      storage_type_id=storage_type_id, parent_id=parent_id)


async def _kind(db, code):
    return await storage_types.resolve(db, storage_type_id=None, code=code)


# ---------------- the master itself ----------------

async def test_the_ladder_is_seeded_and_reseeding_adds_nothing(db):
    rows = await service.list_storage_types(db)
    codes = {r["code"] for r in rows}
    assert {"FLOOR", "LANE", "RACK", "SHELF", "BIN", "COLD_ROOM",
            "COLD_STORAGE_BIN"} <= codes
    assert await storage_types.ensure_defaults(db) == 0


async def test_a_kind_carries_the_kinds_it_sits_inside(db):
    rows = {r["code"]: r for r in await service.list_storage_types(db)}
    assert "SHELF" in rows["BIN"]["parent_type_codes"]
    assert "RACK" in rows["BIN"]["parent_type_codes"]
    # A floor is not somewhere a bin is filed directly under a rack's grandparent by
    # accident — but it IS a legal home for one, and the master says so out loud.
    assert rows["SHELF"]["parent_type_codes"] == ["RACK"]
    # Ordered by the rung's depth, so a list reads floor, lane, rack, shelf, bin.
    ordered = [r["code"] for r in await service.list_storage_types(db)]
    assert ordered.index("FLOOR") < ordered.index("RACK") < ordered.index("BIN")


async def test_cold_chain_is_a_property_of_the_kind(db):
    """The location form asks for a temperature band because the KIND says so — not
    because somebody's code happens to contain the letters COLD."""
    rows = {r["code"]: r for r in await service.list_storage_types(db)}
    assert rows["COLD_ROOM"]["is_temperature_controlled"] is True
    assert rows["RACK"]["is_temperature_controlled"] is False


async def test_pickability_is_a_property_of_the_kind(db):
    rows = {r["code"]: r for r in await service.list_storage_types(db)}
    assert rows["BIN"]["is_pickable"] is True
    assert rows["RACK"]["is_pickable"] is False
    assert set(await storage_types.pickable_codes(db)) >= {"BIN", "COLD_STORAGE_BIN"}


async def test_a_kind_cannot_be_its_own_parent(db):
    rack = await _kind(db, "RACK")
    with pytest.raises(ValidationError):
        await service.update_storage_type(
            db, int(rack.id),
            s.StorageTypeWrite(code="RACK", name="Rack", parent_type_ids=[int(rack.id)]),
            None)


async def test_a_kind_in_use_is_switched_off_rather_than_deleted(db):
    wh = await _warehouse(db, "WH-ST-DEL")
    await service.create_bin(db, _write("F1", warehouse_id=wh.id, bin_type="FLOOR"), None)
    floor = await _kind(db, "FLOOR")

    with pytest.raises(ValidationError) as caught:
        await service.delete_storage_type(db, int(floor.id), None)
    assert "switch the type off" in str(caught.value).lower()


# ---------------- the rule a location is saved under ----------------

async def test_a_kind_the_master_has_never_heard_of_is_refused(db):
    wh = await _warehouse(db, "WH-ST-UNK")
    with pytest.raises(ValidationError) as caught:
        await service.create_bin(
            db, _write("X1", warehouse_id=wh.id, bin_type="CUPBOARD"), None)
    # Named, and told where to add one — a refusal that does not say what to do next
    # is a refusal somebody works around by typing BIN.
    assert "Storage types" in str(caught.value)


async def test_a_bin_may_sit_on_a_rack(db):
    wh = await _warehouse(db, "WH-ST-OK")
    floor = await service.create_bin(
        db, _write("F1", warehouse_id=wh.id, bin_type="FLOOR"), None)
    lane = await service.create_bin(
        db, _write("F1-A1", warehouse_id=wh.id, bin_type="LANE",
                   parent_id=floor.id), None)
    rack = await service.create_bin(
        db, _write("F1-A1-R1", warehouse_id=wh.id, bin_type="RACK",
                   parent_id=lane.id), None)
    bin_row = await service.create_bin(
        db, _write("F1-A1-R1-B1", warehouse_id=wh.id, bin_type="BIN",
                   parent_id=rack.id), None)

    # The kind is a ROW; the code on the location is that row's code, denormalised.
    kind = await _kind(db, "BIN")
    assert int(bin_row.storage_type_id) == int(kind.id)
    assert bin_row.bin_type == "BIN"


async def test_a_floor_cannot_be_filed_inside_a_bin(db):
    """The shape the browser's ladder never enforced. A floor under a bin was accepted
    silently and produced a tree nobody could walk."""
    wh = await _warehouse(db, "WH-ST-BAD")
    floor = await service.create_bin(
        db, _write("F1", warehouse_id=wh.id, bin_type="FLOOR"), None)
    rack = await service.create_bin(
        db, _write("R1", warehouse_id=wh.id, bin_type="RACK", parent_id=floor.id), None)
    bay = await service.create_bin(
        db, _write("B1", warehouse_id=wh.id, bin_type="BIN", parent_id=rack.id), None)

    with pytest.raises(ValidationError) as caught:
        await service.create_bin(
            db, _write("F2", warehouse_id=wh.id, bin_type="FLOOR",
                       parent_id=bay.id), None)
    said = str(caught.value)
    assert "B1" in said and "floor" in said.lower()


async def test_a_kind_that_needs_a_parent_cannot_stand_on_its_own(db):
    """A shelf is a level of a rack. On its own it is a row nobody can find."""
    wh = await _warehouse(db, "WH-ST-TOP")
    with pytest.raises(ValidationError) as caught:
        await service.create_bin(
            db, _write("SH-1", warehouse_id=wh.id, bin_type="SHELF"), None)
    assert "Rack" in str(caught.value)


async def test_a_floor_may_stand_on_its_own_even_though_it_has_a_parent_kind(db):
    """`allow_top_level` is separate from the parent list for exactly this: a floor
    hangs off a block where there is one and stands on its own where there is not, and
    both are true at the same site."""
    wh = await _warehouse(db, "WH-ST-FLOOR")
    row = await service.create_bin(
        db, _write("GF", warehouse_id=wh.id, bin_type="FLOOR"), None)
    assert row.parent_id is None


async def test_a_location_moved_under_a_kind_that_cannot_hold_it_is_refused(db):
    wh = await _warehouse(db, "WH-ST-MOVE")
    floor = await service.create_bin(
        db, _write("F", warehouse_id=wh.id, bin_type="FLOOR"), None)
    rack = await service.create_bin(
        db, _write("R", warehouse_id=wh.id, bin_type="RACK", parent_id=floor.id), None)
    shelf = await service.create_bin(
        db, _write("S", warehouse_id=wh.id, bin_type="SHELF", parent_id=rack.id), None)

    with pytest.raises(ValidationError):
        await service.update_bin(
            db, shelf.id,
            _write("S", warehouse_id=wh.id, bin_type="SHELF", parent_id=floor.id), None)


async def test_a_new_pickable_kind_is_offered_as_a_location_for_stock(db):
    """The `BIN_TYPES` tuple, as data. A site that racks its goods in carton bays adds
    the rung and the picker offers it — no release, no code change."""
    wh = await _warehouse(db, "WH-ST-NEW")
    rack_kind = await _kind(db, "RACK")
    created = await service.create_storage_type(db, s.StorageTypeWrite(
        code="CARTON_BAY", name="Carton bay", sort_order=61, is_pickable=True,
        parent_type_ids=[int(rack_kind.id)]), None)

    floor = await service.create_bin(
        db, _write("F", warehouse_id=wh.id, bin_type="FLOOR"), None)
    rack = await service.create_bin(
        db, _write("R", warehouse_id=wh.id, bin_type="RACK", parent_id=floor.id), None)
    bay = await service.create_bin(
        db, _write("CB-1", warehouse_id=wh.id, storage_type_id=created["id"],
                   parent_id=rack.id), None)

    assert bay.bin_type == "CARTON_BAY"
    assert bay.is_pickable is True
    offered = {row["code"] for row in await service.bin_options(db, wh.id)}
    assert "CB-1" in offered
    # And the rack it stands in is still structure, so it is not offered beside it.
    assert "R" not in offered


async def test_a_location_carries_its_kind_and_its_place_in_the_building(db):
    """What the floor plan draws. Both are derived on the way out — a stored path goes
    stale the day somebody re-parents a rack, and nothing tells you it has."""
    wh = await _warehouse(db, "WH-ST-PLAN")
    floor = await service.create_bin(
        db, _write("F1", warehouse_id=wh.id, bin_type="FLOOR"), None)
    rack = await service.create_bin(
        db, _write("F1-R1", warehouse_id=wh.id, bin_type="RACK",
                   parent_id=floor.id), None)
    await service.create_bin(
        db, _write("F1-R1-B1", warehouse_id=wh.id, bin_type="BIN",
                   parent_id=rack.id), None)

    rows = {r["code"]: r for r in await service.list_locations(db, wh.id)}
    bay = rows["F1-R1-B1"]
    assert bay["storage_type_name"] == "Storage bin"
    assert bay["path"] == "F1 / F1-R1 / F1-R1-B1"
    assert bay["level"] == 3
    assert bay["parent_code"] == "F1-R1"
    assert rows["F1"]["child_count"] == 1
    assert bay["is_pickable"] is True


async def test_renaming_a_kinds_code_renames_it_on_every_location_of_that_kind(db):
    """The code is stamped on the location. Leave it behind and the row points at a
    code the master no longer answers to, which is how STAGING became unsavable."""
    wh = await _warehouse(db, "WH-ST-CODE")
    floor_kind = await _kind(db, "FLOOR")
    row = await service.create_bin(
        db, _write("GF", warehouse_id=wh.id, bin_type="FLOOR"), None)

    await service.update_storage_type(db, int(floor_kind.id), s.StorageTypeWrite(
        code="LEVEL", name="Level", sort_order=20, allow_top_level=True), None)

    await db.refresh(row)
    assert row.bin_type == "LEVEL"
    assert int(row.storage_type_id) == int(floor_kind.id)


async def test_capacity_still_warns_rather_than_blocks_on_a_new_kind(db):
    """A kind somebody has just added must not accidentally become a gate: the
    location is saved whether or not anything about its size is known."""
    wh = await _warehouse(db, "WH-ST-CAP")
    created = await service.create_storage_type(db, s.StorageTypeWrite(
        code="DRUM_PAD", name="Drum pad", sort_order=90, is_pickable=True,
        allow_top_level=True), None)
    row = await service.create_bin(
        db, _write("PAD-1", warehouse_id=wh.id, storage_type_id=created["id"]), None)
    assert row.capacity_volume is None
    assert Decimal(str(row.id)) > 0
