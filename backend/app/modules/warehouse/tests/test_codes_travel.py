"""Unit codes travel with the packs they are in, between any two points (2026-10-28).

NA/104/2026-27/STO0002 moved two strips of Paracetamol LIP to LIP and the receiving
LIP got the strips with no codes inside: at the source every code still pointed at a
box back at the central warehouse, so nothing that moves a strip moved them, and they
stayed "available" at a point that no longer held them. What these pin, at each level a
transfer runs on (LIP→LIP, MDP→MDP, warehouse→warehouse):

- a box issued WHOLE lands at the far end with the strips that were inside it, same
  codes, and every unit code inside the strip it was in;
- codes still pointing at a pack somewhere else are seated into the strips here before
  the issue holds them, so they leave with the strips — and only those leave;
- at a warehouse that keeps locations, what lands at bin 0 moves into its Unlocated
  location WITH its packs, so the issue desk there can still name the boxes.
"""
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.modules.inventory.models import Stock
from app.modules.warehouse import box_codes, unlocated
from app.modules.warehouse import models as m
from app.modules.warehouse import service as wh
from app.shared.models.master import (
    Item, ItemContainerUsage, ItemPackaging, Packaging, PackHierarchy,
)
from app.shared.models.warehouse import Bin, Warehouse

pytestmark = pytest.mark.asyncio

USER = SimpleNamespace(id=None, full_name="Test storekeeper")
PAIRS = [("LIP", False), ("MDP", False), ("MAIN", True)]


async def _points(db, tier: str, bins: bool):
    src = Warehouse(code=f"{tier}-SRC", name=f"{tier} source", warehouse_type=tier,
                    is_bin_managed=bins, is_active=True)
    dst = Warehouse(code=f"{tier}-DST", name=f"{tier} destination", warehouse_type=tier,
                    is_bin_managed=bins, is_active=True)
    item = Item(code="PHA-GEN-0042", name="Paracetamol 500mg", uom_code="TAB",
                requires_qi=False, is_active=True)
    strip_t = Packaging(code="STRIP-T", name="Strip")
    box_t = Packaging(code="BOX-T", name="Box")
    db.add_all([src, dst, item, strip_t, box_t])
    await db.commit()
    ladder = PackHierarchy(item_id=item.id, name="Strip of 10", is_default=True, is_active=True)
    db.add(ladder)
    await db.commit()
    strip_r = ItemPackaging(item_id=item.id, hierarchy_id=ladder.id, level=1,
                            package_id=strip_t.id, package_name="Strip", quantity=10)
    box_r = ItemPackaging(item_id=item.id, hierarchy_id=ladder.id, level=2,
                          package_id=box_t.id, package_name="Box", quantity=10)
    db.add_all([strip_r, box_r,
                ItemContainerUsage(item_id=item.id, package_id=strip_t.id, usage="ISSUE"),
                ItemContainerUsage(item_id=item.id, package_id=box_t.id, usage="ISSUE")])
    batch = m.Batch(batch_no="10/30", item_id=item.id, expiry_date=date(2027, 11, 12))
    db.add(batch)
    await db.commit()
    bin_id = 0
    if bins:
        bay = Bin(warehouse_id=src.id, code="A-01", name="Bay A-01", bin_type="BIN",
                  is_active=True)
        db.add(bay)
        await db.commit()
        bin_id = bay.id
    return SimpleNamespace(src=src, dst=dst, item=item, ladder=ladder, strip=strip_r,
                           box=box_r, batch=batch, bin_id=bin_id)


def _pack(w, code, *, level, parent=None, wh_id=None, content=None, status=None):
    rung = w.strip if level == 1 else w.box
    return m.HandlingUnit(
        hu_code=code, item_id=w.item.id, warehouse_id=wh_id or w.src.id,
        bin_id=w.bin_id, batch_id=w.batch.id, project_id=0,
        pack_hierarchy_id=w.ladder.id, item_packaging_id=rung.id, level=level,
        pack_name="Strip" if level == 1 else "Box", pack_size=Decimal(10 if level == 1 else 100),
        content_qty=content, parent_id=parent,
        status=status or ("INSIDE" if parent else "SEALED"))


def _units(w, codes, *, hu_id, wh_id=None):
    return [m.SerialNumber(item_id=w.item.id, serial_number=c, consumable_code=c,
                           warehouse_id=wh_id or w.src.id, batch_id=w.batch.id,
                           bin_id=w.bin_id or None, handling_unit_id=hu_id,
                           status="available", is_active=True) for c in codes]


async def _shelf(db, w, *, strips: int, foreign: bool):
    """One box at the source holding `strips` strips of 10, and a code for every
    tablet — inside its own strip, or (`foreign`) still pointing at a box at another
    point, the way STO0002's codes did."""
    box = _pack(w, "BOX-1", level=2, content=Decimal(strips * 10))
    db.add(box)
    db.add(Stock(item_id=w.item.id, warehouse_id=w.src.id, bin_id=w.bin_id,
                 batch_id=w.batch.id, total_qty=strips * 10, available_qty=strips * 10))
    elsewhere = _pack(w, "BOX-AWAY", level=2, wh_id=w.dst.id + 999)
    db.add(elsewhere)
    await db.commit()
    packs = [_pack(w, f"STRIP-{i}", level=1, parent=box.id) for i in range(strips)]
    db.add_all(packs)
    await db.commit()
    for i, strip in enumerate(packs):
        db.add_all(_units(w, [f"U-{i}-{k}" for k in range(10)],
                          hu_id=elsewhere.id if foreign else strip.id))
    await db.commit()
    return box, packs


async def _issue_and_send(db, w, *, qty: int, named: list[str]):
    issue = m.MaterialIssue(issue_no=f"WHI-{w.src.code}", issue_date=date(2026, 10, 28),
                            warehouse_id=w.src.id, warehouse_name=w.src.name,
                            direction="OUT", status="APPROVED")
    db.add(issue)
    await db.commit()
    db.add(m.MaterialIssueLine(issue_id=issue.id, line_no=1, item_id=w.item.id,
                               item_code=w.item.code, item_name=w.item.name, uom_code="TAB",
                               batch_id=w.batch.id, bin_id=w.bin_id,
                               requested_qty=Decimal(qty), issued_qty=Decimal(qty)))
    await db.commit()
    issue = (await db.execute(select(m.MaterialIssue).options(
        selectinload(m.MaterialIssue.items)).where(m.MaterialIssue.id == issue.id))).scalar_one()
    line = issue.items[0]
    held = await box_codes.hold_line(db, issue, line, named=named,
                                     claimed_prefixes=wh._CLAIMED_REMARK_PREFIXES)
    assert held is not None and held["short"] == 0
    await box_codes.settle_on_post(db, issue, USER)
    await wh._mark_serials(db, issue, outward=True)
    issue.status, issue.is_stock_posted = "DISPATCHED", True
    dispatch = m.Dispatch(dispatch_no=f"CON-{w.src.code}", dispatch_date=date(2026, 10, 28),
                          warehouse_id=w.src.id, warehouse_name=w.src.name,
                          to_warehouse_id=w.dst.id, to_warehouse_name=w.dst.name,
                          ref_type="WH_ISSUE", ref_id=issue.id, status="DELIVERED")
    db.add(dispatch)
    await db.commit()
    for n, box in enumerate(await box_codes.line_boxes(db, issue.id, line.id), start=1):
        carried = box.content_qty if box.content_qty is not None else box.pack_size
        db.add(m.DispatchItem(dispatch_id=dispatch.id, line_no=n, issue_id=issue.id,
                              issue_item_id=line.id, item_id=w.item.id,
                              item_code=w.item.code, item_name=w.item.name,
                              batch_id=w.batch.id, box_code=box.hu_code,
                              quantity=carried, delivered_qty=carried))
    await db.commit()
    dispatch = (await db.execute(select(m.Dispatch).options(selectinload(m.Dispatch.items))
                                 .where(m.Dispatch.id == dispatch.id))).scalar_one()
    await wh.credit_arrival(db, dispatch, USER)
    await db.commit()
    return issue


async def _at(db, wh_id, item_id):
    packs = {hu.hu_code: hu for hu in (await db.execute(select(m.HandlingUnit).where(
        m.HandlingUnit.warehouse_id == wh_id, m.HandlingUnit.item_id == item_id,
        m.HandlingUnit.status.in_(("SEALED", "INSIDE", "OPENED"))))).scalars().all()}
    units = (await db.execute(select(m.SerialNumber).where(
        m.SerialNumber.warehouse_id == wh_id, m.SerialNumber.item_id == item_id,
        m.SerialNumber.status == "available"))).scalars().all()
    return packs, units


@pytest.mark.parametrize("tier,bins", PAIRS)
async def test_a_box_issued_whole_lands_with_its_strips_and_every_code(db, tier, bins):
    w = await _points(db, tier, bins)
    await _shelf(db, w, strips=10, foreign=False)
    await _issue_and_send(db, w, qty=100, named=["BOX-1"])

    packs, units = await _at(db, w.dst.id, w.item.id)
    assert set(packs) == {"BOX-1", *{f"STRIP-{i}" for i in range(10)}}
    assert packs["BOX-1"].parent_id is None and packs["BOX-1"].status == "SEALED"
    assert all(packs[f"STRIP-{i}"].parent_id == packs["BOX-1"].id for i in range(10))
    assert len(units) == 100
    by_pack = {u.consumable_code: u.handling_unit_id for u in units}
    assert all(by_pack[f"U-{i}-{k}"] == packs[f"STRIP-{i}"].id
               for i in range(10) for k in range(10))
    _src_packs, src_units = await _at(db, w.src.id, w.item.id)
    assert src_units == []


@pytest.mark.parametrize("tier,bins", PAIRS)
async def test_codes_pointing_at_a_pack_elsewhere_still_leave_with_the_strips(db, tier, bins):
    w = await _points(db, tier, bins)
    _box, strips = await _shelf(db, w, strips=3, foreign=True)
    await _issue_and_send(db, w, qty=20, named=[])

    packs, units = await _at(db, w.dst.id, w.item.id)
    assert len(packs) == 2 and len(units) == 20
    for hu in packs.values():
        assert sum(u.handling_unit_id == hu.id for u in units) == 10
    _src_packs, src_units = await _at(db, w.src.id, w.item.id)
    # Exactly the strip that stayed keeps its ten codes — none of what left.
    assert len(src_units) == 10
    left = {s.id for s in strips} - {u.handling_unit_id for u in src_units}
    assert len({u.handling_unit_id for u in src_units}) == 1 and len(left) == 2
    assert not {u.consumable_code for u in units} & {u.consumable_code for u in src_units}


async def test_a_warehouse_moves_landed_packs_into_its_unlocated_location(db):
    w = await _points(db, "MAIN", True)
    await _shelf(db, w, strips=10, foreign=False)
    await _issue_and_send(db, w, qty=100, named=["BOX-1"])

    placed = await unlocated.place(db, w.dst.id, USER)
    await db.commit()
    assert placed["units"] == 100
    packs, units = await _at(db, w.dst.id, w.item.id)
    assert {hu.bin_id for hu in packs.values()} == {placed["location_id"]}
    assert {u.bin_id for u in units} == {placed["location_id"]}
