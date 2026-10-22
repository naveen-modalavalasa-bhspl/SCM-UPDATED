"""One item, one batch, two pack hierarchies on one Material Inward (2026-10-21).

A supplier sends one batch of masks as "Box of 10" and "Box of 20": two despatch-note
lines, two ladders of packs. The receipt used to refuse the second line as a duplicate
of the first, because "one line per item per batch" did not know packing existed.

- the same batch in two hierarchies is two lines, and both are kept;
- the same batch in the SAME hierarchy is still the same goods entered twice.
"""
from datetime import date
from decimal import Decimal

import pytest

from app.core.exceptions import ValidationError
from app.modules.warehouse import schemas as s
from app.modules.warehouse import service
from app.modules.warehouse.tests.test_issue_split_and_holds import _world
from app.modules.warehouse.tests.test_packing_shelf import _ladder
from app.shared.masters import defs
from app.shared.models.master import ItemPackaging, PackHierarchy
from app.shared.packing import PackEntryIn

D = Decimal


async def _box_of_20(db, w, box) -> PackHierarchy:
    h = PackHierarchy()
    await defs.apply_pack_hierarchy(db, h, defs.PackHierarchyIn(
        item_id=w.item.id, name="Box of 20"))
    db.add(h)
    await db.flush()
    rung = ItemPackaging()
    await defs.apply_item_packaging(db, rung, defs.ItemPackagingIn(
        item_id=w.item.id, hierarchy_id=h.id, level=1, package_id=box.id, quantity=20))
    db.add(rung)
    await db.commit()
    return h


def _line(w, hierarchy_id: int, boxes: int, size: int) -> s.ReceiptItemWrite:
    return s.ReceiptItemWrite(
        item_id=w.item.id, received_qty=D(boxes * size), batch_no="B-OLD",
        pack_hierarchy_id=hierarchy_id,
        pack_breakdown=[PackEntryIn(level=1, qty=D(boxes))])


def _gate(w, lines) -> s.ReceiptWrite:
    return s.ReceiptWrite(receipt_type="GATE_ENTRY", grn_date=date.today(),
                          warehouse_id=w.main.id, items=lines)


@pytest.mark.asyncio
async def test_one_batch_in_two_hierarchies_is_two_lines(db):
    w = await _world(db)
    lad = await _ladder(db, w)
    twenty = await _box_of_20(db, w, lad.box)

    receipt = await service.create_receipt(db, _gate(w, [
        _line(w, lad.h.id, 3, 10), _line(w, twenty.id, 2, 20)]), w.user)

    got = sorted((line.pack_hierarchy_id, D(line.received_qty)) for line in receipt.items)
    assert got == sorted([(lad.h.id, D(30)), (twenty.id, D(40))])


@pytest.mark.asyncio
async def test_one_batch_twice_in_one_hierarchy_is_still_a_duplicate(db):
    w = await _world(db)
    lad = await _ladder(db, w)

    with pytest.raises(ValidationError, match="same batch and packing"):
        await service.create_receipt(db, _gate(w, [
            _line(w, lad.h.id, 3, 10), _line(w, lad.h.id, 1, 10)]), w.user)
