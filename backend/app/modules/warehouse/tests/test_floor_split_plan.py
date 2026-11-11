"""A split across floors is cut from the parent's OWN picks (2026-11-10).

What these pin, without a database (the location tree, the shelf read and the item
lookups are stubbed):

- a pick naming a storage location goes to that location's floor with exactly its batch
  and quantity — never a fresh pick off the shelf;
- two picks of one item on two lots stay two lots (the old split re-read the shelf from
  the top for each pick and landed both on the first);
- a pick at a location on no floor stays on the parent, said out loud;
- a pick naming no location is placed FEFO over the drawable stock, and what a fixed
  pick holds is never placed twice.
"""
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.modules.warehouse import service

pytestmark = pytest.mark.asyncio

FLOOR_1, FLOOR_2 = 100, 200
BAY_A, BAY_B, BAY_ROOT = 11, 21, 99


def _index():
    floor = lambda fid, name: [{"id": fid, "name": name}]  # noqa: E731
    return {
        BAY_A: {"code": "F1-A", "steps": floor(FLOOR_1, "Ground floor") + [{"id": BAY_A}]},
        BAY_B: {"code": "F2-B", "steps": floor(FLOOR_2, "Third floor") + [{"id": BAY_B}]},
        BAY_ROOT: {"code": "DOCK", "steps": []},          # on no floor
    }


def _line(no, bin_id, batch_id, qty, *, item_id=1, batch_no=None):
    return SimpleNamespace(
        line_no=no, indent_item_id=7, item_id=item_id, item_code="IT-1",
        item_name="Cable", uom_code="NOS", bin_id=bin_id, bin_code=None,
        batch_id=batch_id, batch_no=batch_no or (f"B{batch_id}" if batch_id else None),
        expiry_date=None, requested_qty=Decimal(qty), issued_qty=Decimal(qty),
        rate=Decimal("2"), brand_id=None, variant_id=None, model_id=None,
        combination_any=False)


class _Rows:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _DB:
    """Answers the one shelf read the planner makes, for lines naming no location."""

    def __init__(self, rows=()):
        self.rows = list(rows)

    async def execute(self, _stmt):
        return _Rows(self.rows)


@pytest.fixture(autouse=True)
def _stubs(monkeypatch):
    async def index(_db, _warehouse_id):
        return _index()

    async def nothing(*_args, **_kwargs):
        return None

    async def item(_db, _item_id):
        return SimpleNamespace(code="IT-1", is_serial_tracked=False)

    async def decimals(_db, codes):
        return {code: 3 for code in codes}

    monkeypatch.setattr(service, "_location_index", index)
    monkeypatch.setattr(service, "_release_issue_hold", nothing)
    monkeypatch.setattr(service, "_item_snapshot", item)
    monkeypatch.setattr(service.uom_rules, "decimals_by_code", decimals)
    monkeypatch.setattr(service.combinations, "carry", lambda _line: {})


def _parent(*lines):
    return SimpleNamespace(id=5, issue_no="WHI0110", warehouse_id=1, indent_id=None,
                           items=list(lines))


async def test_each_pick_goes_to_its_own_floor_with_its_own_lot():
    by_floor, shortfall = await service._plan_floor_split(
        _DB(), _parent(_line(1, BAY_A, 3, "6"), _line(2, BAY_B, 4, "4")))

    assert shortfall == []
    assert [(l["batch_id"], l["bin_id"], l["qty"]) for l in by_floor[FLOOR_1]["lines"]] \
        == [(3, BAY_A, Decimal("6"))]
    assert [(l["batch_id"], l["bin_id"], l["qty"]) for l in by_floor[FLOOR_2]["lines"]] \
        == [(4, BAY_B, Decimal("4"))]


async def test_two_picks_of_one_item_on_one_floor_stay_two_lots():
    by_floor, _shortfall = await service._plan_floor_split(
        _DB(), _parent(_line(1, BAY_A, 3, "6"), _line(2, BAY_A, 8, "4")))
    lots = [(l["batch_id"], l["qty"]) for l in by_floor[FLOOR_1]["lines"]]
    assert lots == [(3, Decimal("6")), (8, Decimal("4"))]    # never 3 twice


async def test_a_pick_on_no_floor_stays_on_the_parent():
    by_floor, shortfall = await service._plan_floor_split(
        _DB(), _parent(_line(1, BAY_ROOT, 3, "5"), _line(2, BAY_A, 3, "2")))
    assert list(by_floor) == [FLOOR_1]
    assert shortfall[0]["qty"] == "5" and "no floor" in shortfall[0]["reason"]


async def test_a_loose_pick_is_placed_fefo_and_never_on_a_fixed_picks_stock():
    shelf = [
        SimpleNamespace(item_id=1, bin_id=BAY_A, batch_id=3, qty=Decimal("10"),
                        batch_no="B3", expiry_date=date(2027, 1, 1)),
        SimpleNamespace(item_id=1, bin_id=BAY_B, batch_id=9, qty=Decimal("10"),
                        batch_no="B9", expiry_date=date(2027, 6, 1)),
    ]
    # A fixed pick holds 8 of the 10 in B3 at bay A; the loose pick needs 5.
    by_floor, shortfall = await service._plan_floor_split(
        _DB(shelf), _parent(_line(1, BAY_A, 3, "8"), _line(2, None, None, "5")))
    assert shortfall == []
    floor_1 = [(l["batch_id"], l["qty"]) for l in by_floor[FLOOR_1]["lines"]]
    floor_2 = [(l["batch_id"], l["qty"]) for l in by_floor[FLOOR_2]["lines"]]
    assert floor_1 == [(3, Decimal("8")), (3, Decimal("2"))]   # only the 2 left in B3
    assert floor_2 == [(9, Decimal("3"))]                      # then the next batch


async def test_whoever_raised_the_parent_may_issue_its_floor_pieces(monkeypatch):
    async def no(*_args, **_kwargs):
        return False

    monkeypatch.setattr(service, "_may_act_as_issue_holder", no)
    monkeypatch.setattr(service, "_issue_approved_by", no)

    class _Scalar:
        async def scalar(self, _stmt):
            return 42          # the parent's created_by_id

    piece = SimpleNamespace(id=9, parent_issue_id=5)
    assert await service._may_issue(_Scalar(), piece, SimpleNamespace(id=42), []) is True
    assert await service._may_issue(_Scalar(), piece, SimpleNamespace(id=43), []) is False
    # Not a piece of a split: the parent's raiser is no reason at all.
    whole = SimpleNamespace(id=9, parent_issue_id=None)
    assert await service._may_issue(_Scalar(), whole, SimpleNamespace(id=42), []) is False
