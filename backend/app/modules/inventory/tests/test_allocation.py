"""Reservation and pick-order tests.

Split deliberately. The pick-order tests use plain objects and run everywhere, because
FEFO is the rule most likely to be broken by a later edit and the CI box may have no
MySQL. The reservation tests need real rows and real row locks, so they take the `db`
fixture and skip when no test database is reachable.
"""
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.modules.inventory import allocation, availability
from app.modules.inventory.models import NO_BIN, NO_PROJECT, Stock
from app.shared.enums import PickStrategy, ReservationStatus, RefType
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse


# ---------------- pick order: pure logic, no database ----------------

def _row(id, expiry=None):
    return SimpleNamespace(id=id, expiry_date=expiry)


def test_fefo_orders_by_nearest_expiry():
    """A batch expiring sooner is picked before one expiring later, even though the
    later batch was received first. This is the whole reason expiry is tracked."""
    rows = [_row(1, date(2027, 1, 1)), _row(2, date(2026, 9, 1))]
    assert [r.id for r in sorted(rows, key=availability.sort_key(PickStrategy.FEFO.value))] \
        == [2, 1]


def test_fefo_puts_undated_batches_last():
    """An undated drum must not jump ahead of one that expires next week."""
    rows = [_row(1, None), _row(2, date(2026, 9, 1)), _row(3, date(2026, 8, 1))]
    assert [r.id for r in sorted(rows, key=availability.sort_key(PickStrategy.FEFO.value))] \
        == [3, 2, 1]


def test_fifo_orders_by_receipt():
    rows = [_row(3), _row(1), _row(2)]
    assert [r.id for r in sorted(rows, key=availability.sort_key(PickStrategy.FIFO.value))] \
        == [1, 2, 3]


def test_batch_tracked_items_get_fefo():
    assert availability.pick_strategy_for(
        SimpleNamespace(is_batch_tracked=True)) == PickStrategy.FEFO.value


def test_plain_items_get_fifo():
    assert availability.pick_strategy_for(
        SimpleNamespace(is_batch_tracked=False)) == PickStrategy.FIFO.value


# ---------------- reservation: needs real rows and row locks ----------------

async def _warehouse(db, code="WH-T", wtype="MAIN"):
    wh = Warehouse(code=code, name=code, warehouse_type=wtype, is_active=True)
    db.add(wh)
    await db.flush()
    return wh


async def _item(db, code="IT-1", batch_tracked=False):
    item = Item(code=code, name=code, uom_code="PCS", is_batch_tracked=batch_tracked)
    db.add(item)
    await db.flush()
    return item


async def _stock(db, item, warehouse, qty, batch_id=0, expiry=None):
    row = Stock(item_id=item.id, item_code=item.code, item_name=item.name,
                warehouse_id=warehouse.id, warehouse_name=warehouse.name,
                bin_id=NO_BIN, batch_id=batch_id, project_id=NO_PROJECT,
                expiry_date=expiry, available_qty=Decimal(str(qty)),
                reserved_qty=Decimal("0"), total_qty=Decimal(str(qty)))
    db.add(row)
    await db.flush()
    return row


@pytest.fixture
def actor():
    return SimpleNamespace(id=1, full_name="Tester")


async def test_second_reservation_sees_reduced_availability(db, actor):
    """The money path. If this breaks, two departments are both told the stock is
    theirs and one of them finds out at the loading bay."""
    wh = await _warehouse(db)
    item = await _item(db)
    await _stock(db, item, wh, 100)

    a = await allocation.reserve(db, item.id, Decimal("80"),
                                 RefType.RESERVATION.value, 1, "IND-1", actor, item=item)
    b = await allocation.reserve(db, item.id, Decimal("50"),
                                 RefType.RESERVATION.value, 2, "IND-2", actor, item=item)

    assert a == (Decimal("80"), Decimal("0"))
    assert b == (Decimal("20"), Decimal("30"))

    stock = (await db.execute(select(Stock).where(Stock.item_id == item.id))).scalar_one()
    assert stock.available_qty == Decimal("0")
    assert stock.reserved_qty == Decimal("100")
    assert stock.total_qty == Decimal("100")   # nothing physically moved


async def test_release_restores_exact_pre_allocation_availability(db, actor):
    wh = await _warehouse(db)
    item = await _item(db)
    await _stock(db, item, wh, 100)

    await allocation.reserve(db, item.id, Decimal("42"), RefType.RESERVATION.value,
                             7, "IND-7", actor, item=item)
    returned = await allocation.release(db, RefType.RESERVATION.value, 7)

    stock = (await db.execute(select(Stock).where(Stock.item_id == item.id))).scalar_one()
    assert returned == Decimal("42")
    assert stock.available_qty == Decimal("100")
    assert stock.reserved_qty == Decimal("0")


async def test_consume_clears_the_hold_without_returning_stock(db, actor):
    """At issue time the goods leave. The hold goes, availability does NOT come back —
    move_stock() posts the actual reduction."""
    wh = await _warehouse(db)
    item = await _item(db)
    await _stock(db, item, wh, 100)

    await allocation.reserve(db, item.id, Decimal("30"), RefType.RESERVATION.value,
                             8, "IND-8", actor, item=item)
    used = await allocation.consume(db, RefType.RESERVATION.value, 8)

    stock = (await db.execute(select(Stock).where(Stock.item_id == item.id))).scalar_one()
    assert used == Decimal("30")
    assert stock.reserved_qty == Decimal("0")
    assert stock.available_qty == Decimal("70")


async def test_fefo_draws_from_the_nearest_expiry_batch_first(db, actor):
    """End-to-end FEFO against real rows, not just the sort key."""
    wh = await _warehouse(db)
    item = await _item(db, batch_tracked=True)
    far = await _stock(db, item, wh, 50, batch_id=1, expiry=date(2027, 1, 1))
    near = await _stock(db, item, wh, 30, batch_id=2, expiry=date(2026, 9, 1))

    reserved, short = await allocation.reserve(
        db, item.id, Decimal("40"), RefType.RESERVATION.value, 9, "IND-9",
        actor, item=item)

    assert (reserved, short) == (Decimal("40"), Decimal("0"))
    await db.refresh(near)
    await db.refresh(far)
    assert near.available_qty == Decimal("0")    # drained first
    assert far.available_qty == Decimal("40")    # only the remainder taken


async def test_reservation_rows_explain_the_reserved_quantity(db, actor):
    """reserved_qty must always be backed by ACTIVE reservation rows summing to it."""
    wh = await _warehouse(db)
    item = await _item(db)
    await _stock(db, item, wh, 100)

    await allocation.reserve(db, item.id, Decimal("25"), RefType.RESERVATION.value,
                             10, "IND-10", actor, item=item)

    stock = (await db.execute(select(Stock).where(Stock.item_id == item.id))).scalar_one()
    held = await allocation.reserved_for(db, RefType.RESERVATION.value, 10)
    assert held == stock.reserved_qty == Decimal("25")


async def test_released_rows_are_kept_not_deleted(db, actor):
    """"Who held this stock in March" has to stay answerable."""
    from app.modules.inventory.models import Reservation

    wh = await _warehouse(db)
    item = await _item(db)
    await _stock(db, item, wh, 10)
    await allocation.reserve(db, item.id, Decimal("5"), RefType.RESERVATION.value,
                             11, "IND-11", actor, item=item)
    await allocation.release(db, RefType.RESERVATION.value, 11)

    rows = (await db.execute(select(Reservation).where(Reservation.ref_id == 11))).scalars().all()
    assert len(rows) == 1
    assert rows[0].status == ReservationStatus.RELEASED.value
    assert rows[0].released_at is not None
