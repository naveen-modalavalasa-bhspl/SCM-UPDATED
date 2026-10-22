"""A consignment carton holds its OWN share of a line, in packs (2026-10-22).

- a line issued as packs and split over two cartons is two smaller sets of packs, not
  the issued packs repeated in each;
- the packer may change a carton's packs, but they must add up to its quantity;
- at the destination the cartons' packs are shelved with the stock, a partial
  credit taking only its own share of them.
"""
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.core.exceptions import ValidationError
from app.modules.warehouse import models as m
from app.modules.warehouse import packing as wh_packing
from app.modules.warehouse import service
from app.modules.warehouse.tests.test_issue_split_and_holds import _world
from app.modules.warehouse.tests.test_packing_shelf import _ladder
from app.shared.packing import PackEntryIn

D = Decimal


def _shape(entries):
    return sorted((e["name"], D(str(e["qty"]))) for e in entries or [])


@pytest.mark.asyncio
async def test_a_cartons_share_is_its_own_smaller_packs(db):
    w = await _world(db)
    lad = await _ladder(db, w)                 # Box = 10, Carton = 5 Box
    line = SimpleNamespace(pack_hierarchy_id=lad.h.id)

    # 65 issued as 1 Carton + 1 Box + 5, packed 15 + 50 over two cartons.
    first = await wh_packing.package_line_packs(db, item=w.item, issue_line=line, qty=D(15))
    second = await wh_packing.package_line_packs(db, item=w.item, issue_line=line, qty=D(50))
    assert _shape(first["pack_breakdown"]) == sorted([("Box", D(1)), ("Loose", D(5))])
    assert _shape(second["pack_breakdown"]) == [("Carton", D(1))]

    # Changed by the packer: 50 as five boxes, not a carton.
    boxes = await wh_packing.package_line_packs(
        db, item=w.item, issue_line=line, qty=D(50),
        entries=[PackEntryIn(item_packaging_id=lad.l1.id, level=1, qty=D(5))])
    assert _shape(boxes["pack_breakdown"]) == [("Box", D(5))]

    # ...and never a different quantity.
    with pytest.raises(ValidationError, match="does not add up"):
        await wh_packing.package_line_packs(
            db, item=w.item, issue_line=line, qty=D(50),
            entries=[PackEntryIn(item_packaging_id=lad.l1.id, level=1, qty=D(4))])


@pytest.mark.asyncio
async def test_the_destination_shelves_the_cartons_packs(db):
    w = await _world(db)
    lad = await _ladder(db, w)
    dispatch = m.Dispatch(dispatch_no="DSP-T-1", dispatch_date=date.today(),
                          warehouse_id=w.main.id, to_warehouse_id=w.mdp.id)
    db.add(dispatch)
    await db.flush()
    for qty, packs in ((15, [("Box", 1, 1, 10), ("Loose", 0, 5, 1)]),
                       (50, [("Carton", 2, 1, 50)])):
        db.add(m.DispatchPackage(
            dispatch_id=dispatch.id, package_no=f"P{qty}", barcode=f"B{qty}",
            item_packs=[{
                "issue_item_id": 1, "item_id": w.item.id, "batch_id": w.old.id,
                "quantity": str(qty), "pack_hierarchy_id": lad.h.id,
                "pack_breakdown": [
                    {"item_packaging_id": (lad.l1.id if lv == 1 else lad.l2.id if lv == 2 else None),
                     "level": lv, "name": name, "size": str(size), "qty": str(n),
                     "hierarchy": "Box of 10"}
                    for name, lv, n, size in packs]}]))
    await db.commit()

    # A partial credit of 15 shelves the first carton's packs only...
    await service._shelve_arrival_packs(db, dispatch, item_id=w.item.id,
                                        batch_id=w.old.id, qty=D(15), already=D(0),
                                        user=w.user)
    # ...and the rest, credited later, the second carton's.
    await service._shelve_arrival_packs(db, dispatch, item_id=w.item.id,
                                        batch_id=w.old.id, qty=D(50), already=D(15),
                                        user=w.user)
    await db.commit()
    rows = (await db.execute(m.HandlingUnit.__table__.select().where(
        m.HandlingUnit.warehouse_id == w.mdp.id))).all()
    assert sorted(r.pack_name for r in rows) == ["Box", "Carton"]
