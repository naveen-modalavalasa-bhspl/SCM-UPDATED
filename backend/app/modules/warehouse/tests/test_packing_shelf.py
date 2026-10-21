"""Pack hierarchies on the shelf, against a real database (2026-10-08).

The world is `test_issue_split_and_holds`'s: a main warehouse with a bay on each of
two floors, one item (gloves, NOS) in two batches. On top of it, a pack hierarchy
"Box of 10": Box = 10 NOS, Carton = 5 Box (50 NOS).

- the master refuses a container twice in one hierarchy, and a name twice per item;
- a putaway's packs are rows, and the shelf reads as packs;
- a repack opens and forms packs and never changes the quantity;
- an untracked issue takes the packs it names first;
- a coded pack is an atom: it can be wrapped, never split — and leaving part of it
  needs break bulk AND the permission.
"""
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.core.exceptions import ValidationError
from app.modules.warehouse import models as m
from app.modules.warehouse import packing as wh_packing
from app.modules.warehouse import service
from app.modules.warehouse.enums import HandlingUnitStatus as HUS
from app.modules.warehouse.tests.test_issue_split_and_holds import (
    _approve, _stock, _world, _write,
)
from app.platform.settings import codeformat
from app.shared.masters import defs
from app.shared.models.master import ItemPackaging, Packaging, PackHierarchy
from app.shared.packing import PackEntryIn

D = Decimal


async def _ladder(db, w) -> SimpleNamespace:
    box = Packaging(code="BOX", name="Box", is_active=True)
    carton = Packaging(code="CTN", name="Carton", is_active=True)
    db.add_all([box, carton])
    await db.flush()
    h = PackHierarchy()
    await defs.apply_pack_hierarchy(db, h, defs.PackHierarchyIn(
        item_id=w.item.id, name="Box of 10"))
    db.add(h)
    await db.flush()
    rungs = []
    for level, package, qty in ((1, box, 10), (2, carton, 5)):
        row = ItemPackaging()
        await defs.apply_item_packaging(db, row, defs.ItemPackagingIn(
            item_id=w.item.id, hierarchy_id=h.id, level=level, package_id=package.id,
            quantity=qty))
        db.add(row)
        await db.flush()
        rungs.append(row)
    await db.commit()
    return SimpleNamespace(h=h, box=box, carton=carton, l1=rungs[0], l2=rungs[1])


def _key(w, bay, batch):
    return {"item_id": w.item.id, "warehouse_id": w.main.id, "bin_id": bay.id,
            "batch_id": batch.id, "project_id": 0}


async def _text(db, key, total):
    return (await wh_packing.pack_summary(db, [{**key, "total_qty": total,
                                                "uom_code": "NOS"}]))[0]["pack_text"]


# --------------------------------------------------------------------------------- #
#  The master
# --------------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_a_container_is_used_once_per_hierarchy_and_names_are_unique(db):
    w = await _world(db)
    lad = await _ladder(db, w)
    with pytest.raises(ValidationError, match="already level 1"):
        await defs.apply_item_packaging(db, ItemPackaging(), defs.ItemPackagingIn(
            item_id=w.item.id, hierarchy_id=lad.h.id, level=3, package_id=lad.box.id,
            quantity=2))
    with pytest.raises(ValidationError, match="already has a pack hierarchy"):
        await defs.apply_pack_hierarchy(db, PackHierarchy(), defs.PackHierarchyIn(
            item_id=w.item.id, name="box of 10"))
    # A second hierarchy may use the same containers — strips of 10 and of 15 both
    # go into a Box.
    other = PackHierarchy()
    await defs.apply_pack_hierarchy(db, other, defs.PackHierarchyIn(
        item_id=w.item.id, name="Box of 12"))
    db.add(other)
    await db.flush()
    await defs.apply_item_packaging(db, ItemPackaging(), defs.ItemPackagingIn(
        item_id=w.item.id, hierarchy_id=other.id, level=1, package_id=lad.box.id,
        quantity=12))


# --------------------------------------------------------------------------------- #
#  Shelf, repack and an untracked issue
# --------------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_shelved_packs_are_rows_and_a_repack_never_changes_the_quantity(db):
    w = await _world(db)
    lad = await _ladder(db, w)
    bay = w.floors["F1"]
    await _stock(db, w.user, w.item, w.main, 120, bay.id, w.old.id)
    key = _key(w, bay, w.old)

    entries = await wh_packing.shelve(
        db, item=w.item, key=key, qty=D(120), hierarchy_id=lad.h.id,
        entries_in=[PackEntryIn(level=2, qty=D(2)), PackEntryIn(level=1, qty=D(2))],
        source=("TEST", 0, None), user=w.user)
    await db.commit()
    assert [(e["name"], e["qty"]) for e in entries] == [("Carton", "2"), ("Box", "2")]
    assert await _text(db, key, 120) == "2 Carton + 2 Box = 120 NOS"

    stock_id = (await wh_packing._balance(db, key)).id
    # Open both cartons: their boxes are carved out of them.
    after = await wh_packing.repack_stock(db, stock_id, SimpleNamespace(
        pack_hierarchy_id=lad.h.id, target=[PackEntryIn(level=1, qty=D(12))],
        reason="Count by the box"), w.user)
    assert after["pack_text"] == "12 Box = 120 NOS"
    opened = await db.scalar(
        m.HandlingUnit.__table__.select().with_only_columns(m.HandlingUnit.id)
        .where(m.HandlingUnit.status == HUS.OPENED.value).limit(1))
    assert opened is not None

    # And back: ten boxes go into two new cartons.
    after = await wh_packing.repack_stock(db, stock_id, SimpleNamespace(
        pack_hierarchy_id=lad.h.id,
        target=[PackEntryIn(level=2, qty=D(2)), PackEntryIn(level=1, qty=D(2))],
        reason=None), w.user)
    assert after["pack_text"] == "2 Carton + 2 Box = 120 NOS"

    with pytest.raises(ValidationError, match="never changes the quantity"):
        await wh_packing.repack_stock(db, stock_id, SimpleNamespace(
            pack_hierarchy_id=lad.h.id, target=[PackEntryIn(level=2, qty=D(3))],
            reason=None), w.user)


@pytest.mark.asyncio
async def test_an_untracked_issue_takes_the_packs_it_names(db):
    w = await _world(db)
    lad = await _ladder(db, w)
    bay = w.floors["F1"]
    await _stock(db, w.user, w.item, w.main, 100, bay.id, w.old.id)
    key = _key(w, bay, w.old)
    await wh_packing.shelve(
        db, item=w.item, key=key, qty=D(100), hierarchy_id=lad.h.id,
        entries_in=[PackEntryIn(level=2, qty=D(1)), PackEntryIn(level=1, qty=D(5))],
        source=("TEST", 0, None), user=w.user)
    await db.commit()

    data = _write(w, w.main, [(bay, w.old, 30)], indent=False)
    data.items[0].pack_hierarchy_id = lad.h.id
    data.items[0].pack_breakdown = [PackEntryIn(level=1, qty=D(3))]
    issue = await service.create_issue(db, data, w.user)
    assert issue.items[0].issued_qty == D(30)
    await _approve(db, issue.id)
    await service.post_issue(db, issue.id, w.user)

    # 3 loose boxes left the shelf; the carton was never touched.
    assert await _text(db, key, 70) == "1 Carton + 2 Box = 70 NOS"


# --------------------------------------------------------------------------------- #
#  Coded packs are atoms
# --------------------------------------------------------------------------------- #
async def _coded_units(db, w, bay, batch, n):
    for k in range(n):
        db.add(m.SerialNumber(
            item_id=w.item.id, serial_number=f"CN-{k:03d}", consumable_code=f"CN-{k:03d}",
            batch_id=batch.id, warehouse_id=w.main.id, bin_id=bay.id,
            status="AVAILABLE", is_active=True))
    await db.commit()


@pytest.mark.asyncio
async def test_a_coded_pack_can_be_wrapped_but_never_split(db):
    w = await _world(db)
    await codeformat.set_item_tracked(db, w.item.code, True)
    lad = await _ladder(db, w)
    bay = w.floors["F1"]
    await _stock(db, w.user, w.item, w.main, 50, bay.id, w.old.id)
    await _coded_units(db, w, bay, w.old, 50)
    key = _key(w, bay, w.old)
    await wh_packing.shelve(
        db, item=w.item, key=key, qty=D(50), hierarchy_id=lad.h.id,
        entries_in=[PackEntryIn(level=1, qty=D(5))], source=("TEST", 0, None),
        user=w.user)
    await db.commit()
    boxes = (await db.execute(m.HandlingUnit.__table__.select().where(
        m.HandlingUnit.status == HUS.SEALED.value))).all()
    assert len(boxes) == 5 and all(b.is_atom for b in boxes)
    assert all(b.hu_code.endswith("-BOX") for b in boxes)

    stock_id = (await wh_packing._balance(db, key)).id
    wrapped = await wh_packing.repack_stock(db, stock_id, SimpleNamespace(
        pack_hierarchy_id=lad.h.id, target=[PackEntryIn(level=2, qty=D(1))],
        reason=None), w.user)
    assert wrapped["pack_text"] == "1 Carton = 50 NOS"

    with pytest.raises(ValidationError, match="cannot be split"):
        await wh_packing.repack_stock(db, stock_id, SimpleNamespace(
            pack_hierarchy_id=lad.h.id, target=[PackEntryIn(level=0, qty=D(50))],
            reason=None), w.user)


@pytest.mark.asyncio
async def test_leaving_part_of_a_coded_pack_needs_break_bulk_and_the_permission(db):
    w = await _world(db)
    await codeformat.set_item_tracked(db, w.item.code, True)
    lad = await _ladder(db, w)
    bay = w.floors["F1"]
    await _stock(db, w.user, w.item, w.main, 20, bay.id, w.old.id)
    await _coded_units(db, w, bay, w.old, 20)
    key = _key(w, bay, w.old)
    await wh_packing.shelve(
        db, item=w.item, key=key, qty=D(20), hierarchy_id=lad.h.id,
        entries_in=[PackEntryIn(level=1, qty=D(2))], source=("TEST", 0, None),
        user=w.user)
    await db.commit()

    # A whole box leaves whole: fine.
    issue = await service.create_issue(
        db, _write(w, w.main, [(bay, w.old, 10)], indent=False), w.user)
    assert len(issue.items[0].unit_keys) == 10

    # Both requests are built up front: a rollback expires every loaded row.
    plain = _write(w, w.main, [(bay, w.old, 4)], indent=False)
    flagged = _write(w, w.main, [(bay, w.old, 4)], indent=False)
    flagged.items[0].break_bulk = True

    # Four units out of a coded box: refused without break bulk...
    with pytest.raises(ValidationError, match="leaves whole"):
        await service.create_issue(db, plain, w.user)
    await db.rollback()
    await db.refresh(w.user)

    # ...and refused WITH it when the person has no break-bulk permission.
    with pytest.raises(ValidationError, match="Break bulk permission"):
        await service.create_issue(db, flagged, w.user)


@pytest.mark.asyncio
async def test_a_break_bulk_retires_the_code_and_leaves_the_rest_on_the_shelf(
        db, monkeypatch):
    from app.platform.rbac import permissions as perms
    from app.platform.rbac import service as rbac_service

    async def granted(*_args, **_kwargs):
        return {perms.ISSUE_BREAK_BULK}
    monkeypatch.setattr(rbac_service, "get_user_permissions", granted)

    w = await _world(db)
    await codeformat.set_item_tracked(db, w.item.code, True)
    lad = await _ladder(db, w)
    bay = w.floors["F1"]
    await _stock(db, w.user, w.item, w.main, 20, bay.id, w.old.id)
    await _coded_units(db, w, bay, w.old, 20)
    key = _key(w, bay, w.old)
    await wh_packing.shelve(
        db, item=w.item, key=key, qty=D(20), hierarchy_id=lad.h.id,
        entries_in=[PackEntryIn(level=1, qty=D(2))], source=("TEST", 0, None),
        user=w.user)
    await db.commit()

    data = _write(w, w.main, [(bay, w.old, 4)], indent=False)
    data.items[0].break_bulk = True
    issue = await service.create_issue(db, data, w.user)
    await _approve(db, issue.id)
    await service.post_issue(db, issue.id, w.user)

    # The opened box's code is retired with a reason; the other box is untouched and
    # the six units left behind stand loose, each still carrying its own unit code.
    rows = (await db.execute(m.HandlingUnit.__table__.select().order_by(
        m.HandlingUnit.id))).all()
    assert [r.status for r in rows] == [HUS.OPENED.value, HUS.SEALED.value]
    assert rows[0].closed_reason.startswith("Break bulk on")
    assert await _text(db, key, 16) == "1 Box + 6 loose NOS = 16 NOS"


# --------------------------------------------------------------------------------- #
#  Part packs (2026-10-11): the size is a ceiling, the floor is the master's
# --------------------------------------------------------------------------------- #
async def _floor(db, w, lad, qty):
    await defs.apply_item_packaging(db, lad.l2, defs.ItemPackagingIn(
        item_id=w.item.id, hierarchy_id=lad.h.id, level=2, package_id=lad.carton.id,
        quantity=5, min_fill_qty=qty))
    await db.commit()


@pytest.mark.asyncio
async def test_a_carton_is_shelved_holding_less_but_never_under_its_floor(db):
    w = await _world(db)
    lad = await _ladder(db, w)
    await _floor(db, w, lad, 40)
    bay = w.floors["F1"]
    await _stock(db, w.user, w.item, w.main, 45, bay.id, w.old.id)
    key = _key(w, bay, w.old)
    with pytest.raises(ValidationError, match="at least 40"):
        await wh_packing.shelve(
            db, item=w.item, key=key, qty=D(45), hierarchy_id=lad.h.id,
            entries_in=[PackEntryIn(level=2, qty=D(1), fill=D(30)),
                        PackEntryIn(level=0, qty=D(15))],
            source=("TEST", 0, None), user=w.user)
    # Refused before any pack row was written, so nothing to undo.
    await wh_packing.shelve(
        db, item=w.item, key=key, qty=D(45), hierarchy_id=lad.h.id,
        entries_in=[PackEntryIn(level=2, qty=D(1), fill=D(45))],
        source=("TEST", 0, None), user=w.user)
    await db.commit()
    assert await _text(db, key, 45) == "1 Carton (45 of 50) = 45 NOS"


@pytest.mark.asyncio
async def test_an_issue_shrinks_the_carton_in_place_and_a_repack_clears_the_flag(db):
    w = await _world(db)
    lad = await _ladder(db, w)
    await _floor(db, w, lad, 40)
    bay = w.floors["F1"]
    await _stock(db, w.user, w.item, w.main, 50, bay.id, w.old.id)
    key = _key(w, bay, w.old)
    await wh_packing.shelve(
        db, item=w.item, key=key, qty=D(50), hierarchy_id=lad.h.id,
        entries_in=[PackEntryIn(level=2, qty=D(1))],
        source=("TEST", 0, None), user=w.user)
    await db.commit()

    issue = await service.create_issue(db, _write(w, w.main, [(bay, w.old, 20)],
                                                  indent=False), w.user)
    await _approve(db, issue.id)
    await service.post_issue(db, issue.id, w.user)

    # The carton is still a carton — holding 30 now, under its 40 floor, and flagged.
    summary = (await wh_packing.pack_summary(db, [{**key, "total_qty": 30,
                                                   "uom_code": "NOS"}]))[0]
    assert summary["pack_text"] == "1 Carton (30 of 50) = 30 NOS"
    assert summary["below_min"] == 1
    opened = await db.scalar(
        m.HandlingUnit.__table__.select().with_only_columns(m.HandlingUnit.id)
        .where(m.HandlingUnit.status == HUS.OPENED.value).limit(1))
    assert opened is None

    # Repacking it into its boxes clears the flag; the quantity never moves.
    stock_id = (await wh_packing._balance(db, key)).id
    after = await wh_packing.repack_stock(db, stock_id, SimpleNamespace(
        pack_hierarchy_id=lad.h.id, target=[PackEntryIn(level=1, qty=D(3))],
        reason="Short carton"), w.user)
    assert after["pack_text"] == "3 Box = 30 NOS"
    assert after["below_min"] == 0
