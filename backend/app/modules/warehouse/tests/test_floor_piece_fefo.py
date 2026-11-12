"""A split issue's floor pieces: FEFO per floor, and across the floors as a family
(2026-11-12).

The shelf is WHI0003's, as found on QA:

    item        Floor 1                       Floor 2
    SAFE-4004   batch 13/11, later expiry     batch 12/11, EARLIER expiry
    LAB-2003    batch 12/11, EARLIER expiry   batch 13/11, later expiry

The split gave Floor 1 the stock on Floor 1 and Floor 2 the stock on Floor 2. Judged
against the whole warehouse, each piece had to take first a batch only the OTHER
piece could reach, so neither could ever be issued.

Pinned here:
- each floor piece is judged on its own floor, so both pass;
- the pieces together are judged warehouse-wide — and pass, because between them
  they take every older batch;
- a family that leaves an older batch on no piece at all is refused, even though
  each piece passes on its own floor (the gap a per-floor check alone would open).
"""
from datetime import timedelta
from decimal import Decimal

import pytest

from app.core.exceptions import ValidationError
from app.modules.inventory import service as inv
from app.modules.warehouse import models as m
from app.modules.warehouse import schemas as s
from app.modules.warehouse import service
from app.modules.warehouse.enums import IssueStatus
from app.shared.time import today as ist_today
from app.shared.models.master import Item
from app.shared.models.warehouse import Bin, Warehouse

pytestmark = pytest.mark.asyncio


async def _shelf(db, make_user):
    user = await make_user(employee_id=501, username="floor_store",
                           permissions=())
    wh = Warehouse(code="WH-FLR", name="Two-floor store", warehouse_type="MAIN",
                   is_bin_managed=True, is_active=True)
    safe = Item(code="SAFE-4004", name="Gloves", uom_code="NOS", is_active=True)
    lab = Item(code="LAB-2003", name="Reagent", uom_code="NOS", is_active=True)
    db.add_all([wh, safe, lab])
    await db.commit()
    floor_1 = Bin(warehouse_id=wh.id, code="WAREHOUSE-01", name="Floor 1", bin_type="FLOOR")
    floor_2 = Bin(warehouse_id=wh.id, code="WAREHOUSE-2ND", name="Floor 2", bin_type="FLOOR")
    db.add_all([floor_1, floor_2])
    await db.commit()
    bay_1 = Bin(warehouse_id=wh.id, code="F1-BAY", name="Bay 1", bin_type="BIN",
                parent_id=floor_1.id)
    bay_2 = Bin(warehouse_id=wh.id, code="F2-BAY", name="Bay 2", bin_type="BIN",
                parent_id=floor_2.id)
    db.add_all([bay_1, bay_2])
    today = ist_today()
    early, late = today + timedelta(days=17), today + timedelta(days=24)
    batches = {
        ("SAFE", 2): m.Batch(batch_no="12/11", item_id=safe.id, expiry_date=early),
        ("SAFE", 1): m.Batch(batch_no="13/11", item_id=safe.id, expiry_date=late),
        ("LAB", 1): m.Batch(batch_no="12/11", item_id=lab.id, expiry_date=early),
        ("LAB", 2): m.Batch(batch_no="13/11", item_id=lab.id, expiry_date=late + timedelta(days=30)),
    }
    db.add_all(batches.values())
    await db.commit()
    bays = {1: bay_1, 2: bay_2}
    items = {"SAFE": safe, "LAB": lab}
    for (name, floor), batch in batches.items():
        await inv.move_stock(db, item_id=items[name].id, qty=10, direction="IN",
                             ref_type="INIT", ref_id=1, ref_no="INIT", user=user,
                             warehouse_id=wh.id, bin_id=bays[floor].id, batch_id=batch.id)
    return SimpleShelf(wh, {1: floor_1, 2: floor_2}, bays, items, batches)


class SimpleShelf:
    def __init__(self, wh, floors, bays, items, batches):
        self.wh, self.floors, self.bays, self.items, self.batches = wh, floors, bays, items, batches

    def line(self, name, floor, *, batch_floor=None, qty=10):
        """A pick of `name` from the bay on `floor`, batch from `batch_floor`'s lot."""
        batch = self.batches[(name, batch_floor or floor)]
        return s.IssueItemWrite(item_id=self.items[name].id, item_code=f"{name}",
                                requested_qty=Decimal(qty), issued_qty=Decimal(qty),
                                batch_id=batch.id, bin_id=self.bays[floor].id)


async def _family(db, shelf, pieces: dict[int, list]):
    """A SPLIT parent and one APPROVED piece per floor, carrying `pieces[floor]`."""
    today = ist_today()
    parent = m.MaterialIssue(issue_no="WHI0003", issue_date=today, warehouse_id=shelf.wh.id,
                             status=IssueStatus.SPLIT.value, direction="OUT")
    db.add(parent)
    await db.commit()
    children = {}
    for floor, lines in pieces.items():
        child = m.MaterialIssue(
            issue_no=f"WHI0003-00{floor}", issue_date=today, warehouse_id=shelf.wh.id,
            status=IssueStatus.APPROVED.value, direction="OUT",
            parent_issue_id=parent.id, parent_issue_no="WHI0003",
            floor_location_id=shelf.floors[floor].id,
            floor_location_name=shelf.floors[floor].name)
        db.add(child)
        await db.commit()
        for no, line in enumerate(lines, start=1):
            db.add(m.MaterialIssueLine(
                issue_id=child.id, line_no=no, item_id=line.item_id, item_code=line.item_code,
                bin_id=line.bin_id, batch_id=line.batch_id,
                requested_qty=line.requested_qty, issued_qty=line.issued_qty))
        await db.commit()
        children[floor] = child
    return parent, children


async def test_each_floor_piece_passes_fefo_on_its_own_floor(db, make_user):
    shelf = await _shelf(db, make_user)
    pieces = {1: [shelf.line("LAB", 1), shelf.line("SAFE", 1)],
              2: [shelf.line("LAB", 2), shelf.line("SAFE", 2)]}
    _parent, children = await _family(db, shelf, pieces)
    # Before the fix both raised: "take 10 from 12/11 … before 13/11".
    await service._assert_issue_sources(db, children[1], pieces[1])
    await service._assert_issue_sources(db, children[2], pieces[2])


async def test_the_family_together_passes_warehouse_wide(db, make_user):
    shelf = await _shelf(db, make_user)
    pieces = {1: [shelf.line("LAB", 1), shelf.line("SAFE", 1)],
              2: [shelf.line("LAB", 2), shelf.line("SAFE", 2)]}
    parent, _children = await _family(db, shelf, pieces)
    await service._assert_split_family_fefo(db, parent)


async def test_an_older_batch_left_on_no_piece_is_refused(db, make_user):
    shelf = await _shelf(db, make_user)
    # Floor 1 takes SAFE-4004's NEWER batch; nobody takes the older one on Floor 2.
    pieces = {1: [shelf.line("SAFE", 1)], 2: [shelf.line("LAB", 2)]}
    parent, children = await _family(db, shelf, pieces)
    # Each piece on its own floor: fine (Floor 1 has only the newer SAFE batch).
    await service._assert_issue_sources(db, children[1], pieces[1])
    # The family: SAFE-4004 skips its older batch — refused, and says where.
    with pytest.raises(ValidationError) as caught:
        await service._assert_split_family_fefo(db, parent)
    assert "Across the floor pieces of WHI0003" in caught.value.message
    assert "SAFE" in caught.value.message


async def test_an_ordinary_issue_is_still_judged_on_the_whole_warehouse(db, make_user):
    shelf = await _shelf(db, make_user)
    issue = m.MaterialIssue(issue_no="WHI0009", issue_date=ist_today(),
                            warehouse_id=shelf.wh.id, status=IssueStatus.DRAFT.value,
                            direction="OUT")
    db.add(issue)
    await db.commit()
    with pytest.raises(ValidationError, match="before"):
        await service._assert_issue_sources(db, issue, [shelf.line("SAFE", 1)])
