"""Stock held with no location, on a warehouse that starts keeping locations.

A warehouse that keeps no locations banks its GRNs at bin 0. Switch it to keeping
locations and everything received before stands at bin 0 still — counted in every
total, joined to no location, and so offered by no picker: it could be neither issued
nor moved. `warehouse/unlocated.py` gives it ONE Unlocated location per warehouse and
moves it there through the ledger, holds and units included.
"""
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

from app.core.exceptions import ValidationError
from app.modules.inventory import allocation
from app.modules.inventory.models import NO_BIN, NO_PROJECT, Reservation, Stock, StockMovement
from app.modules.warehouse import models as m
from app.modules.warehouse import schemas as s, service, unlocated
from app.modules.warehouse.enums import SerialStatus
from app.shared.enums import RefType, ReservationStatus
from app.shared.models.master import Item
from app.shared.models.warehouse import Bin, Warehouse


# ---------------- pure rules, no database ----------------

def test_the_unlocated_location_is_known_by_its_kind_not_its_code():
    assert unlocated.is_unlocated(SimpleNamespace(bin_type="UNLOCATED", code="ANYTHING"))
    assert unlocated.is_unlocated(SimpleNamespace(bin_type="unlocated", code="X"))
    assert not unlocated.is_unlocated(SimpleNamespace(bin_type="BIN", code="UNLOCATED"))
    assert not unlocated.is_unlocated(None)


def test_nothing_is_filed_inside_the_unlocated_location():
    with pytest.raises(ValidationError):
        unlocated.assert_can_hold_children(
            SimpleNamespace(bin_type="UNLOCATED", code="UNLOCATED"))
    unlocated.assert_can_hold_children(SimpleNamespace(bin_type="SHELF", code="S1"))
    unlocated.assert_can_hold_children(None)


# ---------------- against real rows ----------------

@pytest.fixture
def actor():
    return SimpleNamespace(id=1, full_name="Tester")


async def _bulk_warehouse(db, code="WH-UNL"):
    wh = Warehouse(code=code, name=code, warehouse_type="LIP", is_active=True,
                   is_bin_managed=False)
    db.add(wh)
    await db.flush()
    return wh


async def _item(db, code="IT-UNL"):
    item = Item(code=code, name=code, uom_code="PCS")
    db.add(item)
    await db.flush()
    return item


async def _bulk_stock(db, item, wh, qty, *, batch_id=0, rate="12.5"):
    row = Stock(item_id=item.id, item_code=item.code, item_name=item.name,
                warehouse_id=wh.id, warehouse_name=wh.name, bin_id=NO_BIN,
                batch_id=batch_id, project_id=NO_PROJECT,
                available_qty=Decimal(qty), reserved_qty=Decimal("0"),
                total_qty=Decimal(qty), valuation_rate=Decimal(rate))
    db.add(row)
    await db.flush()
    return row


def _switch_on(wh) -> s.WarehouseWrite:
    return s.WarehouseWrite(code=wh.code, name=wh.name, warehouse_type=wh.warehouse_type,
                            is_bin_managed=True)


async def _rows(db, item):
    return {int(r.bin_id): r for r in (await db.execute(
        select(Stock).where(Stock.item_id == item.id))).scalars().all()}


async def test_switching_on_locations_moves_bulk_stock_into_unlocated(db, actor):
    wh = await _bulk_warehouse(db)
    item = await _item(db)
    await _bulk_stock(db, item, wh, "10")
    # An approved allocation holding 4 of them: it must still hold them afterwards.
    await allocation.reserve(db, item.id, Decimal("4"), RefType.RESERVATION.value,
                             77, "IND-77", actor, item=item, ref_line_id=5)
    db.add(m.SerialNumber(item_id=item.id, serial_number="SN-1", warehouse_id=wh.id,
                          bin_id=None, status=SerialStatus.AVAILABLE.value,
                          is_active=True))
    db.add(m.SerialNumber(item_id=item.id, serial_number="SN-GONE", warehouse_id=wh.id,
                          bin_id=None, status=SerialStatus.ISSUED.value, is_active=True))
    await db.commit()

    await service.update_warehouse(db, wh.id, _switch_on(wh), actor)

    location = await unlocated.find_location(db, wh.id)
    assert location is not None and location.is_active and location.parent_id is None
    rows = await _rows(db, item)
    assert rows[NO_BIN].total_qty == 0 and rows[NO_BIN].reserved_qty == 0
    landed = rows[location.id]
    assert (landed.total_qty, landed.available_qty, landed.reserved_qty) == (
        Decimal("10"), Decimal("6"), Decimal("4"))
    assert landed.valuation_rate == Decimal("12.5")

    hold = (await db.execute(select(Reservation).where(
        Reservation.ref_id == 77,
        Reservation.status == ReservationStatus.ACTIVE.value))).scalar_one()
    assert (hold.stock_id, hold.bin_id, hold.quantity) == (
        landed.id, location.id, Decimal("4"))

    ledger = (await db.execute(select(StockMovement).where(
        StockMovement.item_id == item.id,
        StockMovement.ref_type == RefType.UNLOCATED.value))).scalars().all()
    assert sorted((r.direction, int(r.bin_id), r.quantity) for r in ledger) == sorted([
        ("IN", location.id, Decimal("10")), ("OUT", NO_BIN, Decimal("10"))])

    units = {u.serial_number: u for u in (await db.execute(
        select(m.SerialNumber).where(m.SerialNumber.item_id == item.id))).scalars()}
    assert units["SN-1"].bin_id == location.id
    assert units["SN-GONE"].bin_id is None      # history keeps the address it left from


async def test_placing_twice_moves_nothing_and_makes_one_location(db, actor):
    wh = await _bulk_warehouse(db)
    item = await _item(db)
    await _bulk_stock(db, item, wh, "3")
    wh.is_bin_managed = True
    await db.flush()

    first = await unlocated.place(db, wh.id, actor)
    second = await unlocated.place(db, wh.id, actor)
    assert (first["rows"], first["quantity"]) == (1, Decimal("3"))
    assert (second["rows"], second["quantity"]) == (0, Decimal("0"))
    assert await db.scalar(select(func.count()).select_from(Bin).where(
        Bin.warehouse_id == wh.id)) == 1


async def test_a_warehouse_without_locations_keeps_its_stock_at_bin_zero(db, actor):
    wh = await _bulk_warehouse(db)
    item = await _item(db)
    await _bulk_stock(db, item, wh, "5")

    assert (await unlocated.place(db, wh.id, actor))["rows"] == 0
    assert await unlocated.find_location(db, wh.id) is None
    assert (await _rows(db, item))[NO_BIN].total_qty == Decimal("5")


async def test_the_pickers_find_stock_left_at_bin_zero_by_any_door(db, actor):
    """Flipped through the shared masters API, which cannot call the warehouse module
    — the first pick heals it, so the storekeeper is offered the stock."""
    wh = await _bulk_warehouse(db)
    item = await _item(db)
    await _bulk_stock(db, item, wh, "7")
    wh.is_bin_managed = True
    await db.commit()

    options = await service.bin_options(db, wh.id, item_id=item.id)
    location = await unlocated.find_location(db, wh.id)
    assert [o["id"] for o in options] == [location.id]

    sources = await service.issue_stock_sources(db, warehouse_id=wh.id,
                                                item_ids=[item.id])
    assert [(r["bin_id"], r["drawable_qty"]) for r in sources] == [
        (location.id, Decimal("7"))]


async def test_nobody_makes_or_unmakes_an_unlocated_location_by_hand(db, actor):
    wh = await _bulk_warehouse(db)
    item = await _item(db)
    await _bulk_stock(db, item, wh, "2")
    wh.is_bin_managed = True
    await db.flush()
    await unlocated.place(db, wh.id, actor)
    await db.commit()
    location = await unlocated.find_location(db, wh.id)

    with pytest.raises(ValidationError):        # a second one
        await service.create_bin(db, s.BinWrite(
            warehouse_id=wh.id, code="UNL-2", bin_type="UNLOCATED"), actor)
    with pytest.raises(ValidationError):        # something filed inside it
        await service.create_bin(db, s.BinWrite(
            warehouse_id=wh.id, code="B-IN", bin_type="STORAGE",
            parent_id=location.id), actor)
    with pytest.raises(ValidationError):        # switched off while it holds stock
        await service.update_bin(db, location.id, s.BinWrite(
            warehouse_id=wh.id, code=location.code, bin_type="UNLOCATED",
            is_active=False), actor)
    with pytest.raises(ValidationError):        # turned into an ordinary location
        await service.update_bin(db, location.id, s.BinWrite(
            warehouse_id=wh.id, code=location.code, bin_type="STORAGE"), actor)

    # Its code and name are the site's own.
    renamed = await service.update_bin(db, location.id, s.BinWrite(
        warehouse_id=wh.id, code="OLD-STOCK", name="Old stock", bin_type="UNLOCATED"),
        actor)
    assert renamed.code == "OLD-STOCK"
    assert (await unlocated.find_location(db, wh.id)).id == location.id
