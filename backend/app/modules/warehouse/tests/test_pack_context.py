"""Where a pack sits, what is inside it, and empty shells (2026-10-28).

`pack_context` is what lets outward QC, the consignment and the receiving site draw a
line's packages as the carton and box they came out of, and check a kept box strip by
strip. What it must get right:

- the path is OUTERMOST first;
- a live box lists the strips still in it — not one taken out earlier;
- a box that LEFT lists the strips that left with it (closed at the same moment);
- an empty shell is never offered as a box.
"""
from datetime import datetime
from decimal import Decimal

import pytest

from app.modules.warehouse import box_codes
from app.modules.warehouse import models as m
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse

pytestmark = pytest.mark.asyncio

LEFT = datetime(2026, 10, 28, 10, 0, 0)


def _hu(code, *, item_id, wh_id, size, level, name, parent=None, status="SEALED",
        content=None, closed_at=None):
    return m.HandlingUnit(hu_code=code, item_id=item_id, warehouse_id=wh_id,
                          pack_hierarchy_id=1, level=level, pack_name=name,
                          pack_size=Decimal(size), content_qty=content, parent_id=parent,
                          status=status, closed_at=closed_at)


async def _shelf(db):
    wh = Warehouse(code="WH-PCX", name="Main store", warehouse_type="MAIN",
                   is_bin_managed=False, is_active=True)
    item = Item(code="PHA-GEN-0009", name="Paracetamol", uom_code="TAB",
                requires_qi=False, is_active=True)
    db.add_all([wh, item])
    await db.commit()
    carton = _hu("CAR-1", item_id=item.id, wh_id=wh.id, size=1000, level=3, name="Carton")
    db.add(carton)
    await db.commit()
    live_box = _hu("BOX-LIVE", item_id=item.id, wh_id=wh.id, size=100, level=2, name="Box",
                   parent=carton.id, content=Decimal("90"))
    gone_box = _hu("BOX-GONE", item_id=item.id, wh_id=wh.id, size=100, level=2, name="Box",
                   parent=carton.id, status="CONSUMED", closed_at=LEFT)
    db.add_all([live_box, gone_box])
    await db.commit()
    db.add_all([
        *[_hu(f"LIVE-S{i}", item_id=item.id, wh_id=wh.id, size=10, level=1, name="Strip",
              parent=live_box.id) for i in range(9)],
        # Taken out of the live box by an earlier issue.
        _hu("LIVE-OUT", item_id=item.id, wh_id=wh.id, size=10, level=1, name="Strip",
            parent=live_box.id, status="CONSUMED", closed_at=datetime(2026, 10, 1)),
        *[_hu(f"GONE-S{i}", item_id=item.id, wh_id=wh.id, size=10, level=1, name="Strip",
              parent=gone_box.id, status="CONSUMED", closed_at=LEFT) for i in range(10)],
    ])
    await db.commit()
    return wh, item


async def test_paths_are_outermost_first_and_inner_is_what_is_still_inside(db):
    await _shelf(db)
    ctx = await box_codes.pack_context(db, ["LIVE-S0", "BOX-LIVE", "BOX-GONE"])

    assert [p["code"] for p in ctx["LIVE-S0"]["path"]] == ["CAR-1", "BOX-LIVE"]
    assert [p["code"] for p in ctx["BOX-LIVE"]["path"]] == ["CAR-1"]
    live_inner = {r["code"] for r in ctx["BOX-LIVE"]["inner"]}
    assert len(live_inner) == 9 and "LIVE-OUT" not in live_inner
    # A box that left took its strips with it.
    assert len(ctx["BOX-GONE"]["inner"]) == 10


async def test_decorate_adds_name_path_and_inner_in_place(db):
    await _shelf(db)
    rows = [{"code": "BOX-LIVE", "quantity": 90.0}, {"code": "NOT-A-PACK", "quantity": 1.0}]
    await box_codes.decorate_packs(db, rows)
    assert rows[0]["name"] == "Box"
    assert [p["code"] for p in rows[0]["path"]] == ["CAR-1"]
    assert len(rows[0]["inner"]) == 9
    assert "path" not in rows[1]


async def test_an_empty_shell_is_closed_and_never_offered(db):
    wh, item = await _shelf(db)
    empty = _hu("BOX-EMPTY", item_id=item.id, wh_id=wh.id, size=100, level=2, name="Box",
                content=Decimal("0"))
    db.add(empty)
    await db.commit()
    closed = await box_codes._close_empty_shells(
        db, item_id=item.id, warehouse_id=wh.id, reason="test", who="t", now=LEFT)
    await db.commit()
    assert closed == 1
    await db.refresh(empty)
    assert empty.status == "CONSUMED"
