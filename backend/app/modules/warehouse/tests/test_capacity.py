"""Storage-area capacity: the arithmetic, the verdict and the refusal to refuse.

No database. `location_occupancy` is driven through a session double that answers by
table name, so the whole path — resolve the moves, walk the subtree, sum the stock,
decide the verdict, write the sentence — is exercised on a machine with no MySQL.

The test that matters most is `test_a_full_location_never_blocks_the_putaway`: capacity
here is advice. If somebody ever turns it into a gate, that one fails.
"""
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.modules.warehouse import capacity


def item(*, id=1, name="Cable drum", code="ITM-1", uom="NOS",
         volume=None, length=None, width=None, height=None):
    return SimpleNamespace(id=id, name=name, code=code, uom_code=uom,
                           unit_volume_cbm=volume, length_cm=length,
                           width_cm=width, height_cm=height)


def location(*, id=10, code="BIN-A1", name="A1", parent=None, capacity_volume=None,
             bin_type="BIN"):
    row = SimpleNamespace(id=id, code=code, name=name, parent_id=parent,
                          bin_type=bin_type, capacity_volume=capacity_volume)
    row.is_pickable = bin_type in capacity.BIN_TYPES
    return row


class _Result:
    """Just enough of a SQLAlchemy Result for the three shapes this module reads."""

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
    fail for no reason anybody can act on. This one keeps working through a refactor
    and only breaks when the module actually asks a different question.
    """

    def __init__(self, *, locations, stock):
        #: {id: location}
        self.locations = {row.id: row for row in locations}
        #: [(bin_id, item_object, qty)]
        self.stock = stock
        self.items = {row.id: row for _, row, _ in stock}

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

    async def execute(self, stmt):
        sql = str(stmt)
        if "whs_warehouse_locations" in sql:
            # subtree_ids: the children of everything in the frontier. The frontier is
            # in the bound parameters, which is more trouble than it is worth to read
            # back out — every child of every known location, filtered by the caller's
            # own `seen` set, gives the same answer for these fixtures.
            return _Result([(row.id,) for row in self.locations.values()
                            if row.parent_id is not None])
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


# ---------------------------------------------------------------------------
# unit_volume — the one place an item's size is decided
# ---------------------------------------------------------------------------

def test_the_stated_figure_wins_over_the_dimensions():
    # Somebody who filled in both meant the figure: a carton's outer dimensions
    # overstate a soft good that packs down.
    row = item(volume=Decimal("0.5"), length=100, width=100, height=100)
    assert capacity.unit_volume(row) == Decimal("0.5")


def test_dimensions_are_converted_from_cm_to_cubic_metres():
    # 40 x 30 x 25 cm is 0.03 m3, not 30000 of anything.
    assert capacity.unit_volume(item(length=40, width=30, height=25)) == Decimal("0.03")


def test_an_unmeasured_item_has_no_volume_rather_than_zero():
    # The whole design rests on this. Zero would report a packed bin as empty, which
    # reads as "there is room" — the one answer worse than "nobody has measured this".
    assert capacity.unit_volume(item()) is None
    assert capacity.unit_volume(None) is None
    # A part-measured item is unmeasured: two sides of a box are not a volume.
    assert capacity.unit_volume(item(length=40, width=30)) is None
    assert capacity.unit_volume(item(volume=Decimal("0"))) is None


# ---------------------------------------------------------------------------
# fill_status — one verdict, so the meter, the chips and the tree agree
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# location_occupancy — what the screens actually read
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_it_reports_what_is_stored_and_what_is_left():
    drum = item(id=1, volume=Decimal("0.25"))
    db = FakeSession(
        locations=[location(id=10, capacity_volume=Decimal("500"))],
        stock=[(10, drum, 400)],                      # 400 x 0.25 = 100 m3
    )
    room = await capacity.location_occupancy(db, 10, item_id=1, qty=Decimal("40"))

    assert room["capacity_volume"] == Decimal("500.000000")
    assert room["occupied_volume"] == Decimal("100.000000")
    assert room["free_volume"] == Decimal("400.000000")   # the user's "400 is left"
    assert room["move_volume"] == Decimal("10.000000")    # 40 x 0.25
    assert room["projected_volume"] == Decimal("110.000000")
    assert room["projected_free_volume"] == Decimal("390.000000")
    assert room["status"] == capacity.STATUS_OK
    assert room["over_by"] == Decimal("0.000000")


@pytest.mark.asyncio
async def test_a_full_location_never_blocks_the_putaway():
    """Capacity is advice. It says so loudly and it lets the work through.

    The goods are physically on the floor whether or not the master data says they
    fit; refusing here only means the stock ends up in a bin nobody wrote down. If
    this ever raises, the feature has become the thing it was built to avoid.
    """
    drum = item(id=1, volume=Decimal("1"))
    db = FakeSession(
        locations=[location(id=10, code="BIN-A1", capacity_volume=Decimal("100"))],
        stock=[(10, drum, 95)],
    )
    room = await capacity.location_occupancy(db, 10, item_id=1, qty=Decimal("20"))

    assert room["status"] == capacity.STATUS_OVER
    assert room["over_by"] == Decimal("15.000000")
    assert room["projected_free_volume"] == Decimal("-15.000000")
    # It has to SAY it, and it has to say the work goes ahead.
    assert "does not have room" in room["headline"]
    assert "Nothing is stopped" in room["detail"]


@pytest.mark.asyncio
async def test_taking_stock_out_gives_the_space_back():
    # The other half of the ask: an issue frees room, and the same call answers it.
    drum = item(id=1, volume=Decimal("0.5"))
    db = FakeSession(
        locations=[location(id=10, capacity_volume=Decimal("100"))],
        stock=[(10, drum, 100)],                      # 50 m3 in
    )
    room = await capacity.location_occupancy(
        db, 10, item_id=1, qty=Decimal("20"), direction=capacity.OUT)

    assert room["move_volume"] == Decimal("10.000000")
    assert room["projected_volume"] == Decimal("40.000000")
    assert room["projected_free_volume"] == Decimal("60.000000")
    assert room["direction"] == capacity.OUT
    assert "frees up" in room["headline"]


@pytest.mark.asyncio
async def test_a_shelf_cannot_go_negative_however_much_leaves():
    # Taking more out than the arithmetic says is in there is a measurement gap, not a
    # negative shelf. The screen must never show minus one cubic metre.
    drum = item(id=1, volume=Decimal("1"))
    db = FakeSession(
        locations=[location(id=10, capacity_volume=Decimal("100"))],
        stock=[(10, drum, 5)],
    )
    room = await capacity.location_occupancy(
        db, 10, item_id=1, qty=Decimal("500"), direction=capacity.OUT)
    assert room["projected_volume"] == Decimal("0.000000")


@pytest.mark.asyncio
async def test_unmeasured_stock_is_declared_not_counted_as_zero():
    measured = item(id=1, volume=Decimal("2"))
    unmeasured = item(id=2)
    db = FakeSession(
        locations=[location(id=10, capacity_volume=Decimal("100"))],
        stock=[(10, measured, 10), (10, unmeasured, 999)],
    )
    room = await capacity.location_occupancy(db, 10)

    assert room["occupied_volume"] == Decimal("20.000000")   # the 999 is NOT zero m3
    assert room["unmeasured_items"] == 1
    assert room["unmeasured_qty"] == Decimal("999.000")
    assert room["is_partial"] is True
    assert "higher than this" in room["detail"]


@pytest.mark.asyncio
async def test_an_unmeasured_item_being_placed_says_so_instead_of_guessing():
    db = FakeSession(
        locations=[location(id=10, capacity_volume=Decimal("100"))],
        stock=[],
    )
    db.register(item(id=7))
    room = await capacity.location_occupancy(db, 10, item_id=7, qty=Decimal("5"))

    assert room["status"] == capacity.STATUS_UNMEASURED
    assert room["move_volume"] is None
    assert room["unmeasured_lines"] == 1
    assert "Masters > Items" in room["detail"]


@pytest.mark.asyncio
async def test_a_location_with_no_capacity_says_so_and_checks_nothing():
    drum = item(id=1, volume=Decimal("1"))
    db = FakeSession(locations=[location(id=10, capacity_volume=None)],
                     stock=[(10, drum, 5)])
    room = await capacity.location_occupancy(db, 10, item_id=1, qty=Decimal("1000"))

    assert room["status"] == capacity.STATUS_NO_CAPACITY
    assert room["capacity_volume"] is None
    assert room["free_volume"] is None
    assert "how much it holds" in room["detail"]


@pytest.mark.asyncio
async def test_a_rack_counts_the_bins_underneath_it():
    # Stock only ever sits in a bin, so a capacity set on a rack has to roll its bins
    # up or it would read as empty forever.
    drum = item(id=1, volume=Decimal("1"))
    db = FakeSession(
        locations=[
            location(id=1, code="RACK-1", bin_type="RACK", capacity_volume=Decimal("50")),
            location(id=2, code="BIN-A", parent=1),
            location(id=3, code="BIN-B", parent=1),
        ],
        stock=[(2, drum, 20), (3, drum, 25)],
    )
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
    heavy = item(id=1, volume=Decimal("1"))
    light = item(id=2, volume=Decimal("0.25"))
    db = FakeSession(
        locations=[location(id=10, capacity_volume=Decimal("100"))],
        stock=[(10, heavy, 50), (10, light, 40)],     # 50 + 10 = 60 m3
    )
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
    drum = item(id=1, volume=Decimal("1"))
    db = FakeSession(
        locations=[
            location(id=10, code="BIN-ROOM", capacity_volume=Decimal("100")),
            location(id=11, code="BIN-FULL", capacity_volume=Decimal("10")),
        ],
        stock=[(10, drum, 5), (11, drum, 9)],
    )
    rows = await capacity.occupancy_preview(db, [
        {"location_id": 10, "item_id": 1, "qty": Decimal("1"), "direction": "IN"},
        {"location_id": 11, "item_id": 1, "qty": Decimal("50"), "direction": "IN"},
    ])
    assert [r["location_code"] for r in rows] == ["BIN-FULL", "BIN-ROOM"]
    assert rows[0]["status"] == capacity.STATUS_OVER
