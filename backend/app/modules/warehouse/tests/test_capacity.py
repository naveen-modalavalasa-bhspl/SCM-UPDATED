"""Bin capacity in HANDLING UNITS: the arithmetic, four gates, and the refusal to refuse.

No database. `location_occupancy` is driven through a session double that answers by
table name, so the whole path — resolve the ladder, convert a quantity into whole packs,
walk the subtree, sum the stock, run the four gates, write the sentence — is exercised on
a machine with no MySQL.

Two tests matter more than the rest:

`test_a_full_location_never_blocks_the_putaway` — capacity here is advice. If somebody
ever turns it into a gate, that one fails.

`test_a_part_pack_still_occupies_a_whole_pack` — the `ceil` that separates this module
from the loose-volume one it replaced. Drop it and every bin in the building starts
reporting room it does not have.
"""
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.modules.warehouse import capacity


def item(*, id=1, name="Cable drum", code="ITM-1", uom="NOS"):
    return SimpleNamespace(id=id, name=name, code=code, uom_code=uom)


def container(*, id=100, name="Carton", length=None, width=None, height=None,
              tare=None, tiers=None, rotatable=None, fill=None):
    return SimpleNamespace(id=id, name=name, length_cm=length, width_cm=width,
                           height_cm=height, weight_kg=tare, max_stack_tiers=tiers,
                           is_rotatable=rotatable, fill_efficiency_pct=fill)


def rung(*, id=1000, item_id=1, level=1, package_id=100, package_name="Carton",
         quantity=1, uom="NOS", length=None, width=None, height=None, gross=None,
         tiers=None, default=False):
    """One row of `mst_item_packaging`."""
    return SimpleNamespace(id=id, item_id=item_id, level=level, package_id=package_id,
                           package_name=package_name, quantity=Decimal(str(quantity)),
                           uom_code=uom, length_cm=length, width_cm=width,
                           height_cm=height, gross_weight_kg=gross,
                           max_stack_tiers=tiers, is_default_putaway_unit=default,
                           is_active=True)


def location(*, id=10, code="BIN-A1", name="A1", parent=None, capacity_volume=None,
             bin_type="BIN", length=None, width=None, height=None, max_weight=None,
             max_units=None, fill=None):
    row = SimpleNamespace(id=id, code=code, name=name, parent_id=parent,
                          bin_type=bin_type, capacity_volume=capacity_volume,
                          length_cm=length, width_cm=width, height_cm=height,
                          max_weight_capacity=max_weight, max_handling_units=max_units,
                          fill_efficiency_pct=fill)
    row.is_pickable = bin_type in capacity.BIN_TYPES
    return row


class _Result:
    """Just enough of a SQLAlchemy Result for the shapes this module reads."""

    def __init__(self, rows):
        self._rows = list(rows)

    def all(self):
        return self._rows

    def scalars(self):
        return self

    def unique(self):
        return self

    def __iter__(self):
        return iter(self._rows)


class FakeSession:
    """Answers by which table the statement names, not by call order.

    Order-keyed doubles pass until somebody reorders two independent queries and then
    fail for no reason anybody can act on. This one keeps working through a refactor and
    only breaks when the module actually asks a different question.
    """

    def __init__(self, *, locations, stock, rungs=(), containers=(), items=()):
        #: {id: location}
        self.locations = {row.id: row for row in locations}
        #: [(bin_id, item_object, qty)]
        self.stock = stock
        # Everything in stock is resolvable, plus anything named explicitly — a move can
        # perfectly well be the first of its item to reach the warehouse.
        self.items = {row.id: row for _, row, _ in stock}
        self.items.update({row.id: row for row in items})
        self.rungs = list(rungs)
        self.containers = {c.id: c for c in containers}

    async def get(self, model, ident):
        if ident is None:
            return None
        name = getattr(model, "__name__", "")
        if name in ("Bin", "WarehouseLocation"):
            return self.locations.get(ident)
        return self.items.get(ident)

    def register(self, row):
        """Make an item resolvable even when none of it is in stock."""
        self.items[row.id] = row
        return row

    async def execute(self, stmt):
        sql = str(stmt)
        if "whs_warehouse_locations" in sql:
            # subtree_ids: the children of everything in the frontier. The frontier is in
            # the bound parameters, which is more trouble than it is worth to read back
            # out — every child of every known location, filtered by the caller's own
            # `seen` set, gives the same answer for these fixtures.
            return _Result([(row.id,) for row in self.locations.values()
                            if row.parent_id is not None])
        if "mst_item_packaging" in sql:
            return _Result(self.rungs)
        if "mst_packaging" in sql:
            return _Result(list(self.containers.values()))
        if "stk_balance" in sql:
            grouped: dict[tuple, Decimal] = {}
            per_bin = "bin_id" in sql.split("GROUP BY")[-1] if "GROUP BY" in sql else False
            for bin_id, row, qty in self.stock:
                key = (bin_id, row.id) if per_bin else (row.id,)
                grouped[key] = grouped.get(key, Decimal("0")) + Decimal(str(qty))
            return _Result([(*key, total) for key, total in grouped.items()])
        if "mst_items" in sql:
            return _Result(list(self.items.values()))
        raise AssertionError(f"unexpected query: {sql[:120]}")


def one_carton_item(*, id=1, per_pack=10, length=40, width=30, height=25, gross=None,
                    tiers=None):
    """An item whose ladder is a single rung: `per_pack` units in one measured carton.

    40 x 30 x 25 cm is 0.03 m3, which is the number most of these tests count in.
    """
    return (
        item(id=id),
        [rung(id=1000 + id, item_id=id, package_id=100, package_name="Carton",
              quantity=per_pack, length=length, width=width, height=height,
              gross=gross, tiers=tiers)],
        [container(id=100, name="Carton")],
    )


# --------------------------------------------------------------------------- #
#  space_for — the ceil that makes this a WMS and not a volume calculator
# --------------------------------------------------------------------------- #

def test_a_part_pack_still_occupies_a_whole_pack():
    """The single most important line in the module.

    Half a case sits on a shelf taking a case's footprint. `qty x volume_per_each` —
    what this module used to do — would report 6 units of a 10-unit carton as 60% of a
    carton, and a bin holding six such part-cartons as 3.6 cartons full when it is
    physically holding six.
    """
    pack = capacity.Pack(base_qty=Decimal("10"), volume_cbm=Decimal("0.03"))
    assert capacity.space_for(pack, Decimal("6"))["units"] == Decimal("1")
    assert capacity.space_for(pack, Decimal("10"))["units"] == Decimal("1")
    assert capacity.space_for(pack, Decimal("11"))["units"] == Decimal("2")
    assert capacity.space_for(pack, Decimal("25"))["units"] == Decimal("3")
    # And the space follows the packs, not the loose quantity.
    assert capacity.space_for(pack, Decimal("11"))["volume"] == Decimal("0.06")


def test_nothing_moving_takes_no_packs():
    pack = capacity.Pack(base_qty=Decimal("10"), volume_cbm=Decimal("0.03"))
    assert capacity.space_for(pack, Decimal("0"))["units"] == Decimal("0")


def test_an_unmeasured_pack_has_no_volume_rather_than_zero():
    # The whole design rests on this. Zero would report a packed bin as empty, which
    # reads as "there is room" — the one answer worse than "nobody has measured this".
    pack = capacity.Pack(base_qty=Decimal("10"), volume_cbm=None)
    assert capacity.space_for(pack, Decimal("50"))["volume"] is None
    assert capacity.space_for(None, Decimal("50"))["volume"] is None


def test_a_measured_pack_can_still_be_unweighed():
    # Separately null on purpose: a pack is commonly measured for cube and never
    # weighed, and reporting a weight of zero would sail an unweighed pallet through a
    # payload check.
    pack = capacity.Pack(base_qty=Decimal("10"), volume_cbm=Decimal("0.03"),
                         gross_weight_kg=None)
    space = capacity.space_for(pack, Decimal("10"))
    assert space["volume"] == Decimal("0.03")
    assert space["weight"] is None


# --------------------------------------------------------------------------- #
#  pack_ladders / choose_pack — resolving the item's own rungs
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_a_ladder_multiplies_up_and_inherits_the_container_box():
    db = FakeSession(
        locations=[], stock=[],
        rungs=[
            rung(id=1, level=1, package_id=100, package_name="Carton", quantity=50),
            rung(id=2, level=2, package_id=101, package_name="Pallet", quantity=20),
        ],
        containers=[container(id=100, name="Carton", length=40, width=30, height=25),
                    container(id=101, name="Pallet", length=120, width=100, height=150)],
    )
    packs = (await capacity.pack_ladders(db, [1]))[1]

    # base_qty is cumulative: a pallet is 20 cartons of 50, i.e. 1000 base units.
    assert [p.base_qty for p in packs] == [Decimal("50"), Decimal("1000")]
    # Neither rung carries its own box, so both took the container type's.
    assert packs[0].volume_cbm == Decimal("0.03")
    assert packs[1].volume_cbm == Decimal("1.8")
    assert [p.dims_from for p in packs] == ["PACKAGE", "PACKAGE"]


@pytest.mark.asyncio
async def test_a_rung_measured_itself_overrides_the_container_type():
    db = FakeSession(
        locations=[], stock=[],
        rungs=[rung(id=1, level=1, quantity=10, length=50, width=50, height=40)],
        containers=[container(id=100, length=40, width=30, height=25)],
    )
    pack = (await capacity.pack_ladders(db, [1]))[1][0]
    assert pack.volume_cbm == Decimal("0.1")     # 50x50x40, not 40x30x25
    assert pack.dims_from == "RUNG"


@pytest.mark.asyncio
async def test_a_ladder_with_a_missing_rung_is_cut_off_not_multiplied_through():
    """A gap in the ladder would silently multiply the wrong rungs together.

    Levels 1 and 3 with 2 missing: taking level 3 as "3 of level 2" when level 2 is not
    there gives a pack smaller than the real one, and understating a pack understates
    every bin it goes into. Dropped instead.
    """
    db = FakeSession(
        locations=[], stock=[],
        rungs=[rung(id=1, level=1, quantity=50), rung(id=3, level=3, quantity=20)],
        containers=[container(id=100, length=40, width=30, height=25)],
    )
    packs = (await capacity.pack_ladders(db, [1]))[1]
    assert [p.level for p in packs] == [1]


def test_the_documents_own_choice_of_pack_wins():
    # A putaway that says "three pallets" is asking about pallets. Second-guessing it
    # would silently answer a different question.
    carton = capacity.Pack(item_packaging_id=1, level=1, base_qty=Decimal("50"),
                           volume_cbm=Decimal("0.03"))
    pallet = capacity.Pack(item_packaging_id=2, level=2, base_qty=Decimal("1000"),
                           volume_cbm=Decimal("1.8"))
    assert capacity.choose_pack([carton, pallet], 2) is pallet
    # Then the flagged default, then the lowest measured rung.
    assert capacity.choose_pack([carton, pallet]) is carton
    pallet.is_default = True
    assert capacity.choose_pack([carton, pallet]) is pallet


def test_an_unmeasured_default_does_not_beat_a_measured_rung():
    # Being flagged as the putaway unit does not make an unmeasured rung usable; the
    # answer a bin can actually check beats the answer somebody ticked a box for.
    flagged = capacity.Pack(item_packaging_id=1, level=1, base_qty=Decimal("50"),
                            volume_cbm=None, is_default=True)
    measured = capacity.Pack(item_packaging_id=2, level=2, base_qty=Decimal("1000"),
                             volume_cbm=Decimal("1.8"))
    assert capacity.choose_pack([flagged, measured]) is measured


# --------------------------------------------------------------------------- #
#  fill_status — one verdict, so the meter, the chips and the tree agree
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("occupied,expected", [
    ("0", capacity.STATUS_OK),
    ("50", capacity.STATUS_OK),
    ("89.9", capacity.STATUS_OK),
    ("90", capacity.STATUS_TIGHT),
    ("99.9", capacity.STATUS_TIGHT),
    ("100", capacity.STATUS_FULL),
    ("100.1", capacity.STATUS_OVER),
])
def test_fill_status_thresholds(occupied, expected):
    assert capacity.fill_status(Decimal("100"), Decimal(occupied)) == expected


def test_no_capacity_is_its_own_answer_not_a_full_shelf():
    # A location nobody sized is not a location with no room.
    assert capacity.fill_status(None, Decimal("5")) == capacity.STATUS_NO_CAPACITY
    assert capacity.fill_status(Decimal("0"), Decimal("5")) == capacity.STATUS_NO_CAPACITY


# --------------------------------------------------------------------------- #
#  fits_inside / slot_capacity — the gate loose volume can never express
# --------------------------------------------------------------------------- #

def test_a_pack_may_be_turned_on_its_base_without_being_tipped():
    # Setting a pallet down the other way round is turning it, not tipping it, and is
    # always allowed. 120 deep x 80 wide goes into an 80 x 120 opening.
    pack = capacity.Pack(length_cm=Decimal("120"), width_cm=Decimal("80"),
                         height_cm=Decimal("100"), is_rotatable=False)
    assert capacity.fits_inside(
        pack, (Decimal("80"), Decimal("120"), Decimal("100"))) is True


def test_a_container_that_may_not_be_turned_is_checked_upright_only():
    # A drum on its side is not a stored drum. Tall and thin does not become short and
    # wide just because the arithmetic would let it.
    tall = dict(length_cm=Decimal("40"), width_cm=Decimal("40"),
                height_cm=Decimal("120"))
    shelf = (Decimal("130"), Decimal("60"), Decimal("50"))
    assert capacity.fits_inside(capacity.Pack(**tall, is_rotatable=True), shelf) is True
    assert capacity.fits_inside(capacity.Pack(**tall, is_rotatable=False), shelf) is False


def test_a_pack_well_inside_the_cube_can_still_not_fit_through_the_door():
    """The case that justifies the whole FOOTPRINT gate.

    A 2 m x 0.1 m x 0.1 m bar is 0.02 m3 and would pass any volume check against a
    1 m cube bay 50 times over. It does not go in.
    """
    bar = capacity.Pack(length_cm=Decimal("200"), width_cm=Decimal("10"),
                        height_cm=Decimal("10"), volume_cbm=Decimal("0.02"))
    assert capacity.fits_inside(
        bar, (Decimal("100"), Decimal("100"), Decimal("100"))) is False


def test_an_unmeasured_side_makes_the_fit_unknown_not_true():
    pack = capacity.Pack(length_cm=Decimal("40"), width_cm=None,
                         height_cm=Decimal("25"))
    assert capacity.fits_inside(
        pack, (Decimal("100"), Decimal("100"), Decimal("100"))) is None
    assert capacity.fits_inside(
        capacity.Pack(length_cm=Decimal("1"), width_cm=Decimal("1"),
                      height_cm=Decimal("1")), None) is None


def test_slotting_counts_across_deep_and_high_and_respects_the_stack_limit():
    spec = capacity.BinSpec(location(length=Decimal("120"), width=Decimal("100"),
                                     height=Decimal("200")))
    carton = capacity.Pack(length_cm=Decimal("40"), width_cm=Decimal("50"),
                           height_cm=Decimal("50"))
    # 3 across x 2 deep x 4 high = 24.
    assert capacity.slot_capacity(carton, spec) == 24
    # A carton rated for two tiers does not become four because the bay is tall.
    carton.max_stack_tiers = 2
    assert capacity.slot_capacity(carton, spec) == 12


def test_a_pack_taller_than_the_bay_slots_none_of_them():
    spec = capacity.BinSpec(location(length=Decimal("120"), width=Decimal("100"),
                                     height=Decimal("40")))
    tall = capacity.Pack(length_cm=Decimal("40"), width_cm=Decimal("50"),
                         height_cm=Decimal("50"))
    assert capacity.slot_capacity(tall, spec) == 0


# --------------------------------------------------------------------------- #
#  BinSpec — where a location's usable cube comes from
# --------------------------------------------------------------------------- #

def test_a_locations_cube_is_derived_from_its_sides_when_none_is_stated():
    # Measured once, not typed twice.
    spec = capacity.BinSpec(location(length=Decimal("100"), width=Decimal("100"),
                                     height=Decimal("100")))
    assert spec.stated_volume == Decimal("1")
    assert spec.derived_volume is True


def test_a_stated_cube_wins_over_the_sides():
    spec = capacity.BinSpec(location(capacity_volume=Decimal("5"),
                                     length=Decimal("100"), width=Decimal("100"),
                                     height=Decimal("100")))
    assert spec.stated_volume == Decimal("5")
    assert spec.derived_volume is False


def test_the_void_factor_derates_the_usable_cube():
    # Loose parts in a rigid bay never reach 100% of its cube, and pretending otherwise
    # overstates every location in the building.
    spec = capacity.BinSpec(location(capacity_volume=Decimal("10"), fill=Decimal("80")))
    assert spec.usable_volume == Decimal("8")
    # A blank factor is 100%, not zero — and a nonsense one above 100 is not compounded
    # into extra capacity.
    assert capacity.BinSpec(location(capacity_volume=Decimal("10"))).usable_volume \
        == Decimal("10")
    assert capacity.BinSpec(
        location(capacity_volume=Decimal("10"), fill=Decimal("400"))).usable_volume \
        == Decimal("10")


# --------------------------------------------------------------------------- #
#  location_occupancy — what the screens actually read
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_it_reports_what_is_stored_and_what_is_left_in_packs():
    drum, rungs, boxes = one_carton_item(per_pack=10)   # 0.03 m3 per 10 units
    db = FakeSession(locations=[location(id=10, capacity_volume=Decimal("100"))],
                     stock=[(10, drum, 1000)], rungs=rungs, containers=boxes)
    room = await capacity.location_occupancy(db, 10, item_id=1, qty=Decimal("100"))

    assert room["capacity_volume"] == Decimal("100.000000")
    assert room["occupied_units"] == Decimal("100.000")       # 1000 / 10
    assert room["occupied_volume"] == Decimal("3.000000")     # 100 x 0.03
    assert room["move_units"] == Decimal("10.000")            # 100 / 10
    assert room["move_volume"] == Decimal("0.300000")
    assert room["projected_volume"] == Decimal("3.300000")
    assert room["status"] == capacity.STATUS_OK
    # And it names the pack, so a screen never has to guess which rung was used.
    assert room["pack_name"] == "Carton"
    assert room["pack_base_qty"] == Decimal("10.000")


@pytest.mark.asyncio
async def test_a_full_location_never_blocks_the_putaway():
    """Capacity is advice. It says so loudly and it lets the work through.

    The goods are physically on the floor whether or not the master data says they fit;
    refusing here only means the stock ends up in a bin nobody wrote down. If this ever
    raises, the feature has become the thing it was built to avoid.
    """
    drum, rungs, boxes = one_carton_item(per_pack=1, length=100, width=100, height=100)
    db = FakeSession(
        locations=[location(id=10, code="BIN-A1", capacity_volume=Decimal("100"))],
        stock=[(10, drum, 95)], rungs=rungs, containers=boxes)
    room = await capacity.location_occupancy(db, 10, item_id=1, qty=Decimal("20"))

    assert room["status"] == capacity.STATUS_OVER
    assert room["over_by"] == Decimal("15.000000")
    # It has to SAY it, and it has to say the work goes ahead.
    assert "does not have room" in room["headline"]
    assert "Nothing is stopped" in room["detail"]


@pytest.mark.asyncio
async def test_a_pack_that_will_not_fit_is_a_different_verdict_from_over_capacity():
    """And it also does not block. Different problem, different fix, same tolerance.

    The bay has 99% of its cube free; the pack simply does not enter it. Calling that
    OVER would send the storekeeper to make room that already exists.
    """
    drum, rungs, boxes = one_carton_item(per_pack=1, length=200, width=10, height=10)
    db = FakeSession(
        locations=[location(id=10, code="BIN-A1", capacity_volume=Decimal("100"),
                            length=Decimal("100"), width=Decimal("100"),
                            height=Decimal("100"))],
        stock=[], rungs=rungs, containers=boxes, items=[drum])
    room = await capacity.location_occupancy(db, 10, item_id=1, qty=Decimal("1"))

    assert room["status"] == capacity.STATUS_WONT_FIT
    assert "will not go into" in room["headline"]
    assert "Nothing is stopped" in room["detail"]
    fit = next(g for g in room["gates"] if g["key"] == capacity.GATE_FOOTPRINT)
    assert fit["status"] == capacity.STATUS_WONT_FIT
    # The cube gate is still perfectly happy, which is exactly the point.
    cube = next(g for g in room["gates"] if g["key"] == capacity.GATE_VOLUME)
    assert cube["status"] == capacity.STATUS_OK


@pytest.mark.asyncio
async def test_the_payload_gate_catches_a_load_the_cube_lets_through():
    # Dense goods: a few small cartons well within the cube, far past what the rack
    # carries. Three gates passing and one failing is failing.
    drum, rungs, boxes = one_carton_item(per_pack=1, length=20, width=20, height=20,
                                         gross=Decimal("60"))
    db = FakeSession(
        locations=[location(id=10, capacity_volume=Decimal("100"),
                            max_weight=Decimal("250"))],
        stock=[], rungs=rungs, containers=boxes, items=[drum])
    room = await capacity.location_occupancy(db, 10, item_id=1, qty=Decimal("5"))

    assert room["projected_weight_kg"] == Decimal("300.000")
    assert room["status"] == capacity.STATUS_OVER
    weight = next(g for g in room["gates"] if g["key"] == capacity.GATE_WEIGHT)
    assert weight["status"] == capacity.STATUS_OVER
    assert weight["over_by"] == Decimal("50.000")
    assert "rated to carry" in weight["detail"]


@pytest.mark.asyncio
async def test_a_stated_unit_limit_is_a_gate_of_its_own():
    """"This bay takes one euro-pallet" is a limit no cube expresses.

    The pallet is a fraction of the bay's stated cube and the bay still only takes one.
    """
    drum, rungs, boxes = one_carton_item(per_pack=1000, length=120, width=100,
                                         height=150)
    db = FakeSession(
        locations=[location(id=10, capacity_volume=Decimal("50"), max_units=1)],
        stock=[(10, drum, 1000)], rungs=rungs, containers=boxes)
    room = await capacity.location_occupancy(db, 10, item_id=1, qty=Decimal("1000"))

    units = next(g for g in room["gates"] if g["key"] == capacity.GATE_UNITS)
    assert units["capacity"] == Decimal("1.000")
    assert units["projected"] == Decimal("2.000")
    assert units["status"] == capacity.STATUS_OVER
    assert units["note"] == "Stated limit for this location."
    assert room["status"] == capacity.STATUS_OVER


@pytest.mark.asyncio
async def test_the_unit_limit_is_slotted_when_nobody_stated_one():
    drum, rungs, boxes = one_carton_item(per_pack=10, length=40, width=50, height=50)
    db = FakeSession(
        locations=[location(id=10, length=Decimal("120"), width=Decimal("100"),
                            height=Decimal("200"))],
        stock=[], rungs=rungs, containers=boxes, items=[drum])
    room = await capacity.location_occupancy(db, 10, item_id=1, qty=Decimal("10"))

    units = next(g for g in room["gates"] if g["key"] == capacity.GATE_UNITS)
    assert units["capacity"] == Decimal("24.000")     # 3 across x 2 deep x 4 high
    assert "Slotted from" in units["note"]


@pytest.mark.asyncio
async def test_one_failing_gate_decides_the_headline_and_names_itself():
    # "Over capacity" without saying whether it was the cube, the payload or the door
    # is advice nobody can act on, so the sentence comes from the gate that failed.
    drum, rungs, boxes = one_carton_item(per_pack=1, length=20, width=20, height=20,
                                         gross=Decimal("100"))
    db = FakeSession(
        locations=[location(id=10, code="BIN-A1", capacity_volume=Decimal("100"),
                            max_weight=Decimal("150"))],
        stock=[], rungs=rungs, containers=boxes, items=[drum])
    room = await capacity.location_occupancy(db, 10, item_id=1, qty=Decimal("2"))
    assert "kg more on BIN-A1" in room["detail"]


@pytest.mark.asyncio
async def test_taking_stock_out_gives_the_space_back():
    # The other half of the ask: an issue frees room, and the same call answers it.
    drum, rungs, boxes = one_carton_item(per_pack=1, length=100, width=100, height=100)
    db = FakeSession(locations=[location(id=10, capacity_volume=Decimal("100"))],
                     stock=[(10, drum, 100)], rungs=rungs, containers=boxes)
    room = await capacity.location_occupancy(
        db, 10, item_id=1, qty=Decimal("20"), direction=capacity.OUT)

    assert room["move_volume"] == Decimal("20.000000")
    assert room["projected_volume"] == Decimal("80.000000")
    assert room["projected_free_volume"] == Decimal("20.000000")
    assert room["direction"] == capacity.OUT
    assert "frees up" in room["headline"]


@pytest.mark.asyncio
async def test_an_outward_move_is_not_asked_whether_it_fits():
    # "Does it go through the door" is not a question about goods being taken off a
    # shelf they are already sitting on.
    drum, rungs, boxes = one_carton_item(per_pack=1, length=200, width=10, height=10)
    db = FakeSession(
        locations=[location(id=10, capacity_volume=Decimal("100"),
                            length=Decimal("100"), width=Decimal("100"),
                            height=Decimal("100"))],
        stock=[(10, drum, 10)], rungs=rungs, containers=boxes)
    room = await capacity.location_occupancy(
        db, 10, item_id=1, qty=Decimal("1"), direction=capacity.OUT)
    assert not any(g["key"] == capacity.GATE_FOOTPRINT for g in room["gates"])


@pytest.mark.asyncio
async def test_a_shelf_cannot_go_negative_however_much_leaves():
    # Taking more out than the arithmetic says is in there is a measurement gap, not a
    # negative shelf. The screen must never show minus one cubic metre.
    drum, rungs, boxes = one_carton_item(per_pack=1, length=100, width=100, height=100)
    db = FakeSession(locations=[location(id=10, capacity_volume=Decimal("100"))],
                     stock=[(10, drum, 5)], rungs=rungs, containers=boxes)
    room = await capacity.location_occupancy(
        db, 10, item_id=1, qty=Decimal("500"), direction=capacity.OUT)
    assert room["projected_volume"] == Decimal("0.000000")
    assert room["projected_units"] == Decimal("0.000")


@pytest.mark.asyncio
async def test_unmeasured_stock_is_declared_not_counted_as_zero():
    measured, rungs, boxes = one_carton_item(id=1, per_pack=1, length=100, width=100,
                                             height=200)          # 2 m3 each
    unmeasured = item(id=2, name="Unmeasured", code="ITM-2")
    db = FakeSession(locations=[location(id=10, capacity_volume=Decimal("100"))],
                     stock=[(10, measured, 10), (10, unmeasured, 999)],
                     rungs=rungs, containers=boxes)
    room = await capacity.location_occupancy(db, 10)

    assert room["occupied_volume"] == Decimal("20.000000")   # the 999 is NOT zero m3
    assert room["unmeasured_items"] == 1
    assert room["unmeasured_qty"] == Decimal("999.000")
    assert room["is_partial"] is True
    assert "higher than this" in room["detail"]


@pytest.mark.asyncio
async def test_an_item_with_no_pack_says_so_instead_of_guessing():
    db = FakeSession(locations=[location(id=10, capacity_volume=Decimal("100"))],
                     stock=[])
    db.register(item(id=7, name="Never packed"))
    room = await capacity.location_occupancy(db, 10, item_id=7, qty=Decimal("5"))

    assert room["status"] == capacity.STATUS_UNMEASURED
    assert room["move_volume"] is None
    assert room["unmeasured_lines"] == 1
    # And it points at where the fix is, which is the packaging chain, not the item.
    assert "Masters > Packages" in room["detail"]
    # The line is still listed, so the screen can name what it could not count.
    assert len(room["lines"]) == 1
    assert room["lines"][0]["volume"] is None


@pytest.mark.asyncio
async def test_a_location_with_no_capacity_at_all_says_so_and_checks_nothing():
    drum, rungs, boxes = one_carton_item(per_pack=1)
    db = FakeSession(locations=[location(id=10, capacity_volume=None)],
                     stock=[(10, drum, 5)], rungs=rungs, containers=boxes)
    room = await capacity.location_occupancy(db, 10, item_id=1, qty=Decimal("1000"))

    assert room["status"] == capacity.STATUS_NO_CAPACITY
    assert room["capacity_volume"] is None
    assert room["free_volume"] is None
    assert "how much it holds" in room["detail"]


@pytest.mark.asyncio
async def test_one_gate_saying_ok_beats_three_saying_nothing():
    # A location with only a weight limit set is checked on weight and reported as OK,
    # not written off as unconfigured because its cube is blank.
    drum, rungs, boxes = one_carton_item(per_pack=1, gross=Decimal("5"))
    db = FakeSession(locations=[location(id=10, max_weight=Decimal("500"))],
                     stock=[], rungs=rungs, containers=boxes, items=[drum])
    room = await capacity.location_occupancy(db, 10, item_id=1, qty=Decimal("3"))
    assert room["status"] == capacity.STATUS_OK
    assert room["projected_weight_kg"] == Decimal("15.000")


@pytest.mark.asyncio
async def test_a_rack_counts_the_bins_underneath_it():
    # Stock only ever sits in a bin, so a capacity set on a rack has to roll its bins up
    # or it would read as empty forever.
    drum, rungs, boxes = one_carton_item(per_pack=1, length=100, width=100, height=100)
    db = FakeSession(
        locations=[
            location(id=1, code="RACK-1", bin_type="RACK", capacity_volume=Decimal("50")),
            location(id=2, code="BIN-A", parent=1),
            location(id=3, code="BIN-B", parent=1),
        ],
        stock=[(2, drum, 20), (3, drum, 25)], rungs=rungs, containers=boxes)
    room = await capacity.location_occupancy(db, 1)

    assert room["counts_locations"] == 3
    assert room["occupied_volume"] == Decimal("45.000000")
    assert room["free_volume"] == Decimal("5.000000")
    # 45 of 50 is 90% — near enough to full that the storekeeper is told before they
    # walk over, not after.
    assert room["status"] == capacity.STATUS_TIGHT


@pytest.mark.asyncio
async def test_several_lines_out_of_one_bin_are_netted_not_asked_one_at_a_time():
    # An issue takes five lines out of three bins; the space that frees is their sum,
    # added up here rather than in a screen.
    heavy = item(id=1, name="Heavy", code="ITM-1")
    light = item(id=2, name="Light", code="ITM-2")
    db = FakeSession(
        locations=[location(id=10, capacity_volume=Decimal("100"))],
        stock=[(10, heavy, 50), (10, light, 40)],
        rungs=[
            rung(id=1, item_id=1, package_id=100, quantity=1),      # 1 m3 each
            rung(id=2, item_id=2, package_id=101, quantity=1),      # 0.25 m3 each
        ],
        containers=[container(id=100, length=100, width=100, height=100),
                    container(id=101, length=100, width=50, height=50)])
    rows = await capacity.occupancy_preview(db, [
        {"location_id": 10, "item_id": 1, "qty": Decimal("10"), "direction": "OUT"},
        {"location_id": 10, "item_id": 2, "qty": Decimal("8"), "direction": "OUT"},
        {"location_id": None, "item_id": 1, "qty": Decimal("5"), "direction": "OUT"},
    ])

    assert len(rows) == 1                     # one row per LOCATION, not per line
    assert rows[0]["move_volume"] == Decimal("12.000000")     # 10 + 2
    assert rows[0]["projected_volume"] == Decimal("48.000000")
    assert len(rows[0]["lines"]) == 2         # the line with no bin yet is not a claim


@pytest.mark.asyncio
async def test_the_preview_puts_the_shelf_that_cannot_take_it_first():
    # A storekeeper must not have to scroll to find the problem.
    drum, rungs, boxes = one_carton_item(per_pack=1, length=100, width=100, height=100)
    db = FakeSession(
        locations=[
            location(id=10, code="BIN-ROOM", capacity_volume=Decimal("100")),
            location(id=11, code="BIN-FULL", capacity_volume=Decimal("10")),
        ],
        stock=[(10, drum, 5), (11, drum, 9)], rungs=rungs, containers=boxes)
    rows = await capacity.occupancy_preview(db, [
        {"location_id": 10, "item_id": 1, "qty": Decimal("1"), "direction": "IN"},
        {"location_id": 11, "item_id": 1, "qty": Decimal("50"), "direction": "IN"},
    ])
    assert [r["location_code"] for r in rows] == ["BIN-FULL", "BIN-ROOM"]
    assert rows[0]["status"] == capacity.STATUS_OVER


@pytest.mark.asyncio
async def test_the_chips_rank_on_the_worst_gate_not_only_the_cube():
    # A bay at its stated pallet limit is full whatever its cube says, and a chip that
    # only reads the cube sends a storekeeper toward a bay with no slot left in it.
    drum, rungs, boxes = one_carton_item(per_pack=1000, length=120, width=100,
                                         height=150)
    roomy = location(id=10, code="BIN-A", capacity_volume=Decimal("50"), max_units=1)
    db = FakeSession(locations=[roomy], stock=[(10, drum, 1000)],
                     rungs=rungs, containers=boxes)
    chips = await capacity.bin_occupancy_map(db, [roomy])

    assert chips[10]["occupied_units"] == Decimal("1.000")
    assert chips[10]["status"] == capacity.STATUS_FULL     # not OK on 1.8 of 50 m3
