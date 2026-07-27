"""FEFO unit tests.

Proves that candidate_stock and reserve pick batches with earliest expiry first.
"""
from datetime import date, timedelta
from decimal import Decimal
import pytest

from app.modules.inventory import allocation, availability
from app.modules.inventory.models import Stock, NO_BIN, NO_PROJECT
from app.shared.enums import RefType


def test_sort_key_fefo_orders_earliest_expiry_first():
    today = date.today()
    stock_earlier = Stock(id=1, expiry_date=today + timedelta(days=5))
    stock_later = Stock(id=2, expiry_date=today + timedelta(days=30))
    stock_undated = Stock(id=3, expiry_date=None)

    key_fn = availability.sort_key("FEFO")
    items = [stock_undated, stock_later, stock_earlier]
    sorted_items = sorted(items, key=key_fn)

    assert [s.id for s in sorted_items] == [1, 2, 3]


def test_pick_strategy_for_batch_tracked_item():
    class DummyBatchItem:
        is_batch_tracked = True

    class DummyNormalItem:
        is_batch_tracked = False

    assert availability.pick_strategy_for(DummyBatchItem()) == "FEFO"
    assert availability.pick_strategy_for(DummyNormalItem()) == "FIFO"


async def test_reserve_fefo_draws_from_earliest_expiring_batch_first(db_session, make_user):
    user = await make_user(employee_id=99, username="fefo_user", password="pw", permissions=["stock.view"])
    today = date.today()

    # Create stock rows with different expiry dates for item_id 501
    s_later = Stock(
        warehouse_id=1, item_id=501, bin_id=NO_BIN, batch_id=102, batch_no="B-LATER",
        expiry_date=today + timedelta(days=60), project_id=NO_PROJECT, available_qty=Decimal("50"),
        reserved_qty=Decimal("0"), total_qty=Decimal("50"),
    )
    s_earlier = Stock(
        warehouse_id=1, item_id=501, bin_id=NO_BIN, batch_id=101, batch_no="B-EARLIER",
        expiry_date=today + timedelta(days=10), project_id=NO_PROJECT, available_qty=Decimal("50"),
        reserved_qty=Decimal("0"), total_qty=Decimal("50"),
    )
    db_session.add_all([s_later, s_earlier])
    await db_session.flush()

    class BatchItem:
        id = 501
        is_batch_tracked = True

    reserved_qty, shortfall = await allocation.reserve(
        db_session, item_id=501, qty=30, ref_type=RefType.RESERVATION.value,
        ref_id=999, ref_no="RES-FEFO-1", user=user, item=BatchItem(),
    )

    assert reserved_qty == Decimal("30")
    assert shortfall == Decimal("0")
    # Assert s_earlier was drawn from first
    assert s_earlier.available_qty == Decimal("20")
    assert s_earlier.reserved_qty == Decimal("30")
    assert s_later.available_qty == Decimal("50")
    assert s_later.reserved_qty == Decimal("0")
