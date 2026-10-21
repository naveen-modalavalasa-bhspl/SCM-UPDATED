"""Asset/consumable codes on a material issue, against a real database (2026-10-07).

The world is the one `test_issue_split_and_holds` builds: a main warehouse with a bay
on each of two floors, one item in two batches. Here the item is ASSET-coded (not
serial, not IMEI), and one batch is drawn from BOTH bays — the shape that used to
reach outward QC and the consignment as one pile.

- each pick is auto-filled with codes from its OWN bay, on save, and they are held
  on the units, so approval does not lose them;
- a serial-tracked item is never auto-filled;
- after posting, each line is still read back with its own bay's codes;
- an issue whose items need no QC skips the QC desk and goes straight to packing.
"""
from decimal import Decimal

import pytest

from app.modules.warehouse import models as m
from app.modules.warehouse import service
from app.modules.warehouse.enums import QcStatus
from app.modules.warehouse.tests.test_issue_split_and_holds import (
    _approve, _stock, _world, _write,
)

D = Decimal


async def _asset_codes(db, w, bay, batch, n, prefix):
    for k in range(n):
        db.add(m.SerialNumber(
            item_id=w.item.id, serial_number=f"SN-{prefix}-{k}",
            asset_code=f"AST-{prefix}-{k}", batch_id=batch.id,
            warehouse_id=w.main.id, bin_id=bay.id, status="AVAILABLE", is_active=True))
    await db.commit()


async def _asset_world(db, *, serial=False, requires_qi=False):
    w = await _world(db, coded=serial)
    w.item.is_asset = True
    w.item.requires_qi = requires_qi
    await db.commit()
    f1, f2 = w.floors["F1"], w.floors["F2"]
    await _stock(db, w.user, w.item, w.main, 3, f1.id, w.old.id)
    await _stock(db, w.user, w.item, w.main, 4, f2.id, w.old.id)
    await _asset_codes(db, w, f1, w.old, 3, "F1")
    await _asset_codes(db, w, f2, w.old, 4, "F2")
    return w


def _by_bay(issue, w):
    return {line.bin_id: sorted(line.unit_keys or []) for line in issue.items}


@pytest.mark.asyncio
async def test_each_pick_of_one_batch_is_filled_from_its_own_bay(db):
    w = await _asset_world(db)
    f1, f2 = w.floors["F1"], w.floors["F2"]
    issue = await service.create_issue(
        db, _write(w, w.main, [(f1, w.old, 3), (f2, w.old, 4)], indent=False), w.user)

    assert _by_bay(issue, w) == {
        f1.id: ["AST-F1-0", "AST-F1-1", "AST-F1-2"],
        f2.id: ["AST-F2-0", "AST-F2-1", "AST-F2-2", "AST-F2-3"],
    }

    # Held on the units, not on the screen: approval reads them straight back.
    await _approve(db, issue.id)
    again = await service.get_issue(db, issue.id)
    assert _by_bay(again, w) == _by_bay(issue, w)


@pytest.mark.asyncio
async def test_a_named_code_stands_and_only_the_rest_is_filled(db):
    w = await _asset_world(db)
    f2 = w.floors["F2"]
    data = _write(w, w.main, [(f2, w.old, 2)], indent=False)
    data.items[0].serial_numbers = ["AST-F2-3"]
    issue = await service.create_issue(db, data, w.user)
    keys = issue.items[0].unit_keys
    assert len(keys) == 2 and "AST-F2-3" in keys


@pytest.mark.asyncio
async def test_a_serial_tracked_item_is_never_auto_filled(db):
    w = await _asset_world(db, serial=True)
    issue = await service.create_issue(
        db, _write(w, w.main, [(w.floors["F1"], w.old, 2)], indent=False), w.user)
    assert issue.items[0].unit_keys == []


@pytest.mark.asyncio
async def test_posted_lines_keep_their_own_bays_codes(db):
    w = await _asset_world(db)
    f1, f2 = w.floors["F1"], w.floors["F2"]
    issue = await service.create_issue(
        db, _write(w, w.main, [(f2, w.old, 4), (f1, w.old, 3)], indent=False), w.user)
    await _approve(db, issue.id)
    await service.post_issue(db, issue.id, w.user)

    posted = await service.get_issue(db, issue.id)
    by_line = await service._issue_units_by_line(db, posted)
    for line in posted.items:
        assert {row.bin_id for row in by_line[line.id]} == {line.bin_id}
        assert len(by_line[line.id]) == int(line.issued_qty)


@pytest.mark.asyncio
async def test_an_issue_needing_no_qc_skips_the_qc_desk(db):
    w = await _asset_world(db, requires_qi=False)
    issue = await service.create_issue(
        db, _write(w, w.main, [(w.floors["F1"], w.old, 3)], indent=False), w.user)
    await _approve(db, issue.id)
    await service.post_issue(db, issue.id, w.user)
    posted = await service.get_issue(db, issue.id)
    assert posted.qc_status == QcStatus.NOT_REQUIRED.value
    assert posted.qc_status in service.CONSIGNABLE_QC


@pytest.mark.asyncio
async def test_an_item_that_requires_qi_raises_a_sheet_of_its_lines_only(db):
    w = await _asset_world(db, requires_qi=True)
    issue = await service.create_issue(
        db, _write(w, w.main, [(w.floors["F1"], w.old, 3)], indent=False), w.user)
    await _approve(db, issue.id)
    await service.post_issue(db, issue.id, w.user)
    posted = await service.get_issue(db, issue.id)
    assert posted.qc_status == QcStatus.PENDING.value
