"""Which units are turned away: they land first, and a return ships exactly them."""
import pytest
from sqlalchemy import select

from app.core.exceptions import ValidationError
from app.modules.warehouse import models as m
from app.modules.warehouse import service as wh
from app.modules.warehouse.enums import SerialStatus
from app.shared.models.master import Item, Uom


async def _units(db, codes, *, status=SerialStatus.ISSUED.value, remarks="Issued by issue 7",
                 warehouse_id=1):
    uom = Uom(code="NOS", name="Numbers")
    db.add(uom)
    await db.flush()
    item = Item(code="IT-SN", name="Serial Item", uom_id=uom.id, uom_code="NOS",
                is_serial_tracked=True)
    db.add(item)
    await db.flush()
    for code in codes:
        db.add(m.SerialNumber(item_id=item.id, serial_number=code, status=status,
                              remarks=remarks, warehouse_id=warehouse_id, is_active=True))
    await db.commit()
    return item


async def _row(db, code):
    return (await db.execute(select(m.SerialNumber).where(
        m.SerialNumber.serial_number == code))).scalar_one()


async def test_units_on_the_road_can_be_turned_away(db):
    item = await _units(db, ["A1", "A2", "A3"])
    rows = await wh.resolve_rejected_units(db, item_id=item.id, codes=["A2", "A3"])
    assert [r.serial_number for r in rows] == ["A2", "A3"]


async def test_a_code_that_is_not_this_items_is_refused(db):
    item = await _units(db, ["A1"])
    with pytest.raises(ValidationError, match="ZZ9"):
        await wh.resolve_rejected_units(db, item_id=item.id, codes=["A1", "ZZ9"])


async def test_a_unit_already_turned_away_cannot_be_named_again(db):
    item = await _units(db, ["A1"], status=SerialStatus.AVAILABLE.value,
                        remarks=wh.REJECTED_UNIT_PREFIX + "IND-1", warehouse_id=5)
    with pytest.raises(ValidationError, match="A1"):
        await wh.resolve_rejected_units(db, item_id=item.id, codes=["A1"],
                                        receiver_warehouse_id=5)


async def test_preferred_units_land_before_the_oldest_ones(db):
    item = await _units(db, ["A1", "A2", "A3"])
    landed = await wh._land_units(
        db, markers=("Issued by issue 7",), item_id=item.id, qty=1, to_warehouse_id=9,
        ref_no="DSP-1", prefer=["A3"])
    assert landed == ["A3"]
    assert (await _row(db, "A3")).warehouse_id == 9
    assert (await _row(db, "A1")).status == SerialStatus.ISSUED.value


async def test_the_rest_of_the_quantity_still_lands_oldest_first(db):
    item = await _units(db, ["A1", "A2", "A3"])
    landed = await wh._land_units(
        db, markers=("Issued by issue 7",), item_id=item.id, qty=2, to_warehouse_id=9,
        ref_no="DSP-1", prefer=["A3"])
    assert sorted(landed) == ["A1", "A3"]


async def test_a_unit_that_never_landed_is_not_part_of_this_delivery(db):
    item = await _units(db, ["A1"])
    rows = await wh.resolve_rejected_units(db, item_id=item.id, codes=["A1"])
    with pytest.raises(ValidationError, match="not part of this delivery"):
        await wh.mark_rejected_units(db, rows, "IND-1")   # still ISSUED: it did not land


async def test_landed_units_are_stamped_so_they_cannot_be_named_twice(db):
    item = await _units(db, ["A1"])
    await wh._land_units(db, markers=("Issued by issue 7",), item_id=item.id, qty=1,
                         to_warehouse_id=9, ref_no="DSP-1", prefer=["A1"])
    rows = await wh.resolve_rejected_units(db, item_id=item.id, codes=["A1"],
                                           receiver_warehouse_id=9)
    await wh.mark_rejected_units(db, rows, "IND-1")
    assert (await _row(db, "A1")).remarks.startswith(wh.REJECTED_UNIT_PREFIX)


async def test_a_return_ships_exactly_the_units_named(db):
    item = await _units(db, ["A1", "A2", "A3"], status=SerialStatus.AVAILABLE.value,
                        remarks=wh.REJECTED_UNIT_PREFIX + "IND-1", warehouse_id=9)
    sent = await wh.ship_named_units(db, item_id=item.id, warehouse_id=9,
                                     codes=["A3"], marker="Returned by RET-1")
    assert sent == ["A3"]
    assert (await _row(db, "A3")).status == SerialStatus.ISSUED.value
    assert (await _row(db, "A1")).status == SerialStatus.AVAILABLE.value


async def test_a_return_cannot_ship_a_unit_that_left_the_shelf(db):
    item = await _units(db, ["A1"], status=SerialStatus.AVAILABLE.value, warehouse_id=4)
    with pytest.raises(ValidationError, match="not on the sending shelf"):
        await wh.ship_named_units(db, item_id=item.id, warehouse_id=9, codes=["A1"],
                                  marker="Returned by RET-1")
