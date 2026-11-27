"""Saving serials line by line keeps every line's serial (2026-11-26, WHI0352).

On an approved issue the storekeeper names each line's serial in the picker, line
after line. `set_issue_serials` used to free EVERY line's units and re-hold them all
from the copy of the issue it had read — so a save that had read the issue before an
earlier save committed wrote that earlier line back as "no serial". Only the line
saved last kept its serial, and Issue from stock refused the document:
"Serial numbers are incomplete — 060300-001: 0 of 1 serial numbers captured".

These pin that a save touches only its own lines, sequentially and when one save
works from a copy read before another committed.
"""
import asyncio
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.modules.inventory.models import Stock
from app.modules.warehouse import models as m
from app.modules.warehouse import schemas as s
from app.modules.warehouse import service as wh
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse

pytestmark = pytest.mark.asyncio

USER = SimpleNamespace(id=None, full_name="Test storekeeper")
ITEMS = [("050000-001", "ERBA XL 200"), ("060100-001", "Wireless Key Board"),
         ("050001-001", "ERBA H-360"), ("060300-001", "Epson M1100 Printer")]


@pytest.fixture(autouse=True)
def _anyone_may_issue(monkeypatch):
    """Who may act on an approved issue is the workflow's question, not this one's."""
    async def _ok(*_args, **_kwargs):
        return None
    monkeypatch.setattr(wh, "_assert_issue_holder", _ok)


async def _approved_issue(db):
    """An APPROVED issue with one serial-tracked line per item, 1 unit each, and
    three serials of every item on the shelf. Same serial strings across items, as on
    the live data (20P0396 is an XL 200 AND an AIO)."""
    point = Warehouse(code="WH-T", name="Test warehouse", warehouse_type="MAIN",
                      is_bin_managed=False, is_active=True)
    db.add(point)
    await db.commit()
    issue = m.MaterialIssue(issue_no="BHS/104/2026-27/WHI0352", issue_date=date(2026, 11, 24),
                            warehouse_id=point.id, warehouse_name=point.name,
                            direction="OUT", status="APPROVED")
    db.add(issue)
    await db.commit()
    for n, (code, name) in enumerate(ITEMS, start=1):
        item = Item(code=code, name=name, uom_code="NOS", is_serial_tracked=True,
                    requires_qi=False, is_active=True)
        db.add(item)
        await db.commit()
        batch = m.Batch(batch_no="DUMMY01", item_id=item.id)
        db.add(batch)
        await db.commit()
        db.add(Stock(item_id=item.id, warehouse_id=point.id, bin_id=0, batch_id=batch.id,
                     total_qty=3, available_qty=3))
        db.add_all([m.SerialNumber(item_id=item.id, serial_number=f"20P04{k}",
                                   warehouse_id=point.id, batch_id=batch.id,
                                   status="available", is_active=True) for k in range(3)])
        db.add(m.MaterialIssueLine(issue_id=issue.id, line_no=n, item_id=item.id,
                                   item_code=code, item_name=name, uom_code="NOS",
                                   batch_id=batch.id, bin_id=0,
                                   requested_qty=Decimal(1), issued_qty=Decimal(1)))
        await db.commit()
    lines = (await db.execute(select(m.MaterialIssueLine).where(
        m.MaterialIssueLine.issue_id == issue.id).order_by(m.MaterialIssueLine.line_no)
    )).scalars().all()
    return issue.id, [line.id for line in lines]


def _one(line_id: int, serial: str) -> s.IssueSerialsIn:
    return s.IssueSerialsIn(lines=[{"id": line_id, "serial_numbers": [serial]}])


async def _held(session_factory, issue_id):
    async with session_factory() as fresh:
        issue = await wh.get_issue(fresh, issue_id)
        return {line.line_no: list(line.serial_numbers or []) for line in issue.items}


async def test_saving_lines_one_after_another_keeps_every_line(db, session_factory):
    issue_id, line_ids = await _approved_issue(db)
    for line_id, serial in zip(line_ids, ["20P040", "20P041", "20P042", "20P040"]):
        await wh.set_issue_serials(db, issue_id, _one(line_id, serial), USER)
    assert await _held(session_factory, issue_id) == {
        1: ["20P040"], 2: ["20P041"], 3: ["20P042"], 4: ["20P040"]}


async def test_a_save_working_from_an_older_copy_does_not_wipe_another_line(
        db, session_factory):
    """The WHI0352 case, made deterministic: the second save reads the issue BEFORE
    the first one commits, then saves its own line from that copy."""
    issue_id, line_ids = await _approved_issue(db)
    keyboard, hematology = line_ids[1], line_ids[2]       # lines 2 and 3
    async with session_factory() as late:
        # The second request opens the issue while the first is still running —
        # under REPEATABLE READ, everything it reads from here on is this snapshot.
        await wh.get_issue(late, issue_id)

        async with session_factory() as early:
            await wh.set_issue_serials(early, issue_id, _one(keyboard, "20P041"), USER)

        await wh.set_issue_serials(late, issue_id, _one(hematology, "20P042"), USER)

    held = await _held(session_factory, issue_id)
    assert held[2] == ["20P041"], "the Keyboard's serial was wiped by the later save"
    assert held[3] == ["20P042"]


async def test_two_saves_at_the_same_moment_both_keep_their_line(db, session_factory):
    issue_id, (first, second, *_rest) = await _approved_issue(db)

    async def save(line_id, serial):
        async with session_factory() as session:
            await wh.set_issue_serials(session, issue_id, _one(line_id, serial), USER)

    await asyncio.gather(save(first, "20P040"), save(second, "20P041"))
    held = await _held(session_factory, issue_id)
    assert held[1] == ["20P040"] and held[2] == ["20P041"]


async def test_changing_a_lines_serial_frees_the_old_one_and_leaves_the_rest(
        db, session_factory):
    issue_id, (first, second, *_rest) = await _approved_issue(db)
    await wh.set_issue_serials(db, issue_id, _one(first, "20P040"), USER)
    await wh.set_issue_serials(db, issue_id, _one(second, "20P041"), USER)
    await wh.set_issue_serials(db, issue_id, _one(first, "20P042"), USER)

    held = await _held(session_factory, issue_id)
    assert held[1] == ["20P042"] and held[2] == ["20P041"]
    async with session_factory() as fresh:
        line = (await fresh.execute(select(m.MaterialIssueLine).where(
            m.MaterialIssueLine.id == first))).scalar_one()
        old = (await fresh.execute(select(m.SerialNumber).where(
            m.SerialNumber.item_id == line.item_id,
            m.SerialNumber.serial_number == "20P040"))).scalar_one()
    assert old.remarks is None, "the serial the line gave up is still held"
