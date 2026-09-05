"""Every storage location is measured, and a location contains what is inside it.

Two halves, split for the reason `test_allocation.py` splits: the arithmetic is pure
and runs on a machine with no MySQL, while the containment rule needs real rows,
because the sum it checks is a query over a parent's children.

**The rule.** `length_cm`, `width_cm`, `height_cm` and `capacity_volume` have always
been on `whs_warehouse_locations` — one table for the whole tree, so a floor, a lane
and a rack each carry a cube exactly as a bay does — and nothing had ever checked them
against each other. A 2 m3 rack could be given four 1 m3 shelves, every screen would
report each of them as having room, and the building was described as holding twice
what it can.

So: **a location's cube is at least the sum of the cubes directly inside it**, checked
at every edge on every write. That is what makes it hold for N levels — if every
parent contains its own children and each of those contains theirs, the floor contains
everything under it by induction, and no write has to re-read the building to prove it.
"""
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.core.exceptions import ValidationError
from app.modules.warehouse import capacity, service
from app.shared.models.warehouse import Bin, Warehouse


# ---------------- the cube itself: pure, no database ----------------

def measured(*, volume=None, length=None, width=None, height=None):
    return SimpleNamespace(capacity_volume=volume, length_cm=length,
                           width_cm=width, height_cm=height)


def test_a_stated_volume_wins_over_the_sides():
    # Somebody who has typed a cube has measured the usable inside of the bay, which
    # the outside dimensions overstate. Their number stands.
    row = measured(volume=Decimal("1.5"), length=200, width=100, height=100)
    assert capacity.gross_volume(row) == Decimal("1.5")
    assert capacity.volume_source(row) == "stated"


def test_the_sides_are_used_when_no_volume_was_typed():
    # 200 x 100 x 100 cm = 2 m3. Measured once, not typed twice.
    row = measured(length=200, width=100, height=100)
    assert capacity.gross_volume(row) == Decimal("2")
    assert capacity.volume_source(row) == "derived"


def test_two_sides_out_of_three_measure_nothing():
    # A missing side is not a zero one; treating it as zero would let anything through.
    row = measured(length=200, width=100)
    assert capacity.gross_volume(row) is None
    assert capacity.volume_source(row) is None


def test_an_unmeasured_location_is_none_and_never_zero():
    """The distinction the whole budget rests on. Zero reads as "no room here"; None
    reads as "nobody has measured this", and only one of those is true."""
    assert capacity.gross_volume(measured()) is None


def test_containment_is_not_derated_by_the_void_factor():
    """`usable_volume` answers "how much stock goes in here" — gangway, reach,
    dunnage. Containment answers "does this box enclose those boxes", which is
    geometry. A rack derated to 80% still physically encloses all of its shelves, and
    derating the parent while not derating the children would refuse a warehouse that
    is laid out correctly."""
    row = SimpleNamespace(capacity_volume=Decimal("10"), length_cm=None, width_cm=None,
                          height_cm=None, fill_efficiency_pct=Decimal("80"),
                          max_weight_capacity=None, max_handling_units=None)
    assert capacity.gross_volume(row) == Decimal("10")
    assert capacity.BinSpec(row).usable_volume == Decimal("8")


# ---------------- the rule: needs real rows ----------------

async def _warehouse(db, code="WH-VOL"):
    wh = Warehouse(code=code, name=code, warehouse_type="MAIN", is_active=True,
                   is_bin_managed=True)
    db.add(wh)
    await db.flush()
    return wh


async def _location(db, wh, code, *, parent=None, volume=None, bin_type="RACK"):
    row = Bin(warehouse_id=wh.id, code=code, name=code, bin_type=bin_type,
              parent_id=parent.id if parent else None,
              capacity_volume=None if volume is None else Decimal(str(volume)),
              is_active=True)
    db.add(row)
    await db.flush()
    return row


def _write(code, *, warehouse_id, parent_id=None, volume=None, bin_type="SHELF",
           length=None, width=None, height=None):
    from app.modules.warehouse import schemas as s

    return s.BinWrite(
        warehouse_id=warehouse_id, code=code, bin_type=bin_type, parent_id=parent_id,
        capacity_volume=volume, length_cm=length, width_cm=width, height_cm=height,
    )


async def test_a_shelf_that_fits_its_rack_is_accepted(db):
    wh = await _warehouse(db, "WH-VOL1")
    rack = await _location(db, wh, "RACK-1", volume=4)
    await _location(db, wh, "SHELF-1", parent=rack, volume=1, bin_type="SHELF")

    # 1 + 2 = 3, inside the rack's 4.
    await service._assert_volume_contains(
        db, code="SHELF-2", node_id=None, parent_id=rack.id, own_volume=Decimal("2"))


async def test_a_shelf_that_bursts_its_rack_is_refused(db):
    """The money case. Four 1 m3 shelves in a 2 m3 rack is the shape that made the
    whole building report twice the space it has."""
    wh = await _warehouse(db, "WH-VOL2")
    rack = await _location(db, wh, "RACK-2", volume=2)
    await _location(db, wh, "SHELF-A", parent=rack, volume=1, bin_type="SHELF")
    await _location(db, wh, "SHELF-B", parent=rack, volume=1, bin_type="SHELF")

    with pytest.raises(ValidationError) as caught:
        await service._assert_volume_contains(
            db, code="SHELF-C", node_id=None, parent_id=rack.id,
            own_volume=Decimal("1"))
    # The message has to say by how much, or it tells somebody they are wrong without
    # telling them what to change.
    assert "RACK-2" in str(caught.value)


async def test_a_rack_exactly_filled_by_its_shelves_is_allowed(db):
    """`>=`, not `>`. Three 1 m3 shelves in a 3 m3 rack is how racking is built, and
    refusing it would mean nobody could describe a real rack."""
    wh = await _warehouse(db, "WH-VOL3")
    rack = await _location(db, wh, "RACK-3", volume=3)
    await _location(db, wh, "SH-1", parent=rack, volume=1, bin_type="SHELF")
    await _location(db, wh, "SH-2", parent=rack, volume=1, bin_type="SHELF")

    await service._assert_volume_contains(
        db, code="SH-3", node_id=None, parent_id=rack.id, own_volume=Decimal("1"))


async def test_shrinking_a_rack_below_its_shelves_is_refused(db):
    """The other direction. One write can break the rule either way: shrinking a rack
    can make it too small for what is already in it."""
    wh = await _warehouse(db, "WH-VOL4")
    rack = await _location(db, wh, "RACK-4", volume=4)
    await _location(db, wh, "SH-A", parent=rack, volume=2, bin_type="SHELF")
    await _location(db, wh, "SH-B", parent=rack, volume=2, bin_type="SHELF")

    with pytest.raises(ValidationError):
        await service._assert_volume_contains(
            db, code="RACK-4", node_id=rack.id, parent_id=None,
            own_volume=Decimal("3"))


async def test_an_unmeasured_parent_cannot_refuse_anything(db):
    """Nobody has measured the rack, so there is no budget to be over. Refusing here
    would block every warehouse whose master data is half-entered — which is all of
    them, on the day the levels are being typed in."""
    wh = await _warehouse(db, "WH-VOL5")
    rack = await _location(db, wh, "RACK-5", volume=None)

    await service._assert_volume_contains(
        db, code="SHELF-X", node_id=None, parent_id=rack.id,
        own_volume=Decimal("99"))


async def test_an_unmeasured_child_claims_nothing_and_is_counted_separately(db):
    """It is left out of the sum — nothing else is honest — and said out loud, because
    a budget that quietly treats four unmeasured shelves as taking no space is worse
    than one that admits it cannot answer."""
    wh = await _warehouse(db, "WH-VOL6")
    rack = await _location(db, wh, "RACK-6", volume=3)
    await _location(db, wh, "SH-M", parent=rack, volume=1, bin_type="SHELF")
    await _location(db, wh, "SH-U", parent=rack, volume=None, bin_type="SHELF")

    budget = await service.location_volume_budget(db, rack.id)
    assert budget["children_volume"] == Decimal("1")
    assert budget["unmeasured_children"] == 1
    assert budget["free_volume"] == Decimal("2")
    assert "unmeasured" in budget["detail"]


async def test_the_rule_holds_over_several_levels(db):
    """N levels, without any write walking the tree. Floor contains lane contains rack
    contains shelf — each edge checked on its own write, and the containment of the
    whole follows by induction. The shelf that bursts its rack is refused even though
    the floor above has plenty of room."""
    wh = await _warehouse(db, "WH-VOL7")
    floor = await _location(db, wh, "F1", volume=100, bin_type="FLOOR")
    lane = await _location(db, wh, "F1-A1", parent=floor, volume=20, bin_type="LANE")
    rack = await _location(db, wh, "F1-A1-R1", parent=lane, volume=2)
    await _location(db, wh, "F1-A1-R1-B1", parent=rack, volume=2, bin_type="BIN")

    with pytest.raises(ValidationError):
        await service._assert_volume_contains(
            db, code="F1-A1-R1-B2", node_id=None, parent_id=rack.id,
            own_volume=Decimal("1"))


async def test_a_location_created_through_the_service_is_checked(db):
    """The rule is on the write path, not only in a helper somebody can forget to
    call."""
    wh = await _warehouse(db, "WH-VOL8")
    rack = await _location(db, wh, "RACK-8", volume=1)

    with pytest.raises(ValidationError):
        await service.create_bin(
            db,
            _write("SHELF-8", warehouse_id=wh.id, parent_id=rack.id, volume=Decimal("2")),
            SimpleNamespace(id=1, full_name="Tester"),
        )


async def test_the_sides_count_towards_the_budget_just_as_a_stated_cube_does(db):
    """A location measured with three sides and one measured with a cube are the same
    kind of fact, and the budget has to read both or half the tree escapes it."""
    wh = await _warehouse(db, "WH-VOL9")
    rack = await _location(db, wh, "RACK-9", volume=2)

    # 200 x 100 x 100 cm = 2 m3, which exactly fills the rack.
    await service._assert_volume_contains(
        db, code="SH-9", node_id=None, parent_id=rack.id, own_volume=Decimal("2"))

    with pytest.raises(ValidationError):
        await service.create_bin(
            db,
            _write("SH-9B", warehouse_id=wh.id, parent_id=rack.id,
                   length=Decimal("300"), width=Decimal("100"), height=Decimal("100")),
            SimpleNamespace(id=1, full_name="Tester"),
        )
