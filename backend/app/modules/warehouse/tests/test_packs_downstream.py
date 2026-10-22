"""Packs follow the base quantity from the issue to the receiving point (2026-10-22).

- an issue pick's quantity is its base units; its packs are worked out from it, and
  stale packs never change it;
- a consignment, QC sheet or acknowledgement reads an issue line's packs cut to its
  own quantity;
- the receiving point's GRN lines carry the packs the goods were sent in.
"""
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.modules.warehouse import packing as wh_packing
from app.modules.warehouse import service
from app.modules.warehouse.tests.test_issue_split_and_holds import _stock, _world, _write
from app.modules.warehouse.tests.test_packing_shelf import _ladder
from app.shared.packing import PackEntryIn

D = Decimal


def _shape(entries):
    return sorted((e["name"], D(str(e["qty"]))) for e in entries or [])


@pytest.mark.asyncio
async def test_a_picks_packs_follow_its_quantity(db):
    w = await _world(db)
    lad = await _ladder(db, w)                 # Box = 10, Carton = 5 Box
    bay = w.floors["F1"]
    await _stock(db, w.user, w.item, w.main, 100, bay.id, w.old.id)

    data = _write(w, w.main, [(bay, w.old, 65)], indent=False)
    # Stale packs saying 20 must not turn a 65 into a 20.
    data.items[0].pack_hierarchy_id = lad.h.id
    data.items[0].pack_breakdown = [PackEntryIn(item_packaging_id=lad.l1.id, level=1, qty=D(2))]
    issue = await service.create_issue(db, data, w.user)
    line = issue.items[0]
    assert D(line.issued_qty) == D(65)
    assert _shape(line.pack_breakdown) == [("Carton", D(1)), ("Loose", D(5)), ("Box", D(1))] \
        or _shape(line.pack_breakdown) == sorted([("Carton", D(1)), ("Box", D(1)), ("Loose", D(5))])

    # Part of the line, as a consignment or a QC sheet reads it: 25 = 2 Box + 5.
    part = await wh_packing.issue_line_packs(db, {line.id: D(25)})
    assert _shape(part[line.id]["pack_breakdown"]) == sorted([("Box", D(2)), ("Loose", D(5))])

    # The receiving point's GRN line for those 25 carries the same packs.
    rows = [{"uom_code": "NOS", "_issue_lines": {line.id: D(25)}}]
    await service._receipt_lines_packed(db, rows)
    assert rows[0]["pack_hierarchy_id"] == lad.h.id
    assert _shape(rows[0]["pack_breakdown"]) == sorted([("Box", D(2)), ("Loose", D(5))])
    assert "_issue_lines" not in rows[0]


def test_merging_two_lines_packs_adds_level_by_level():
    one = [{"hierarchy": "Box of 10", "level": 1, "name": "Box", "size": "10", "qty": "1"}]
    two = [{"hierarchy": "Box of 10", "level": 1, "name": "Box", "size": "10", "qty": "1"},
           {"hierarchy": "Box of 10", "level": 0, "name": "Loose", "size": "1", "qty": "5"}]
    merged = wh_packing.merge_breakdowns([one, two], "NOS")
    assert _shape(merged["pack_breakdown"]) == sorted([("Box", D(2)), ("Loose", D(5))])
    assert wh_packing.merge_breakdowns([[], None], "NOS") is None
    _ = SimpleNamespace
