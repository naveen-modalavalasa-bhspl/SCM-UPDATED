"""Labels for a posted issue, and for an acknowledged receipt (2026-10-28).

What these pin is WHICH stickers a document hands the printer:

- only after posting — a draft's boxes are a claim, and its part packs have no code;
- the packs the line issued, parent first with the strips inside each under it, and the
  part pack cut at the desk flagged as new — never a box still on the shelf;
- asset / consumable codes, never a unit known only by a serial or an IMEI;
- at the receiving end, only what the acknowledgement said ARRIVED.
"""
from datetime import date
from decimal import Decimal

import pytest

from app.modules.warehouse import box_codes
from app.modules.warehouse import models as m
from app.modules.warehouse.enums import DISPATCH_VIEW, ISSUE_VIEW
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse

pytestmark = pytest.mark.asyncio


def _hu(code, *, item_id, wh_id, size, level, issue=None, line=None, parent=None,
        content=None, status="CONSUMED", source=None, name="Box"):
    return m.HandlingUnit(
        hu_code=code, item_id=item_id, warehouse_id=wh_id, pack_hierarchy_id=1,
        level=level, pack_name=name, pack_size=Decimal(size), content_qty=content,
        parent_id=parent, status=status,
        held_by=box_codes.issued_marker(issue, line) if issue else None,
        source_type=source[0] if source else None, source_id=source[1] if source else None)


async def _posted_issue(db, *, posted=True):
    wh = Warehouse(code="WH-ISL", name="Main store", warehouse_type="MAIN",
                   is_bin_managed=False, is_active=True)
    item = Item(code="PHA-GEN-0001", name="Paracetamol 500mg", uom_code="TAB",
                requires_qi=False, is_active=True)
    db.add_all([wh, item])
    await db.commit()
    issue = m.MaterialIssue(issue_no="WHI0099", issue_date=date(2026, 10, 28),
                            warehouse_id=wh.id, warehouse_name=wh.name,
                            destination_warehouse_name="LIP Badangi",
                            status="ISSUED" if posted else "DRAFT", is_stock_posted=posted)
    db.add(issue)
    await db.commit()
    line = m.MaterialIssueLine(issue_id=issue.id, line_no=1, item_id=item.id,
                               item_code=item.code, item_name=item.name, uom_code="TAB",
                               requested_qty=Decimal("105"), issued_qty=Decimal("105"),
                               brand_name="Dolo")
    db.add(line)
    await db.commit()
    return wh, item, issue, line


async def test_a_posted_issue_prints_its_packs_parent_first_and_its_asset_codes(
    db, client, make_user, login,
):
    wh, item, issue, line = await _posted_issue(db)
    box = _hu("PK-BOX-1", item_id=item.id, wh_id=wh.id, size=100, level=2,
              issue=issue.id, line=line.id)
    shelf = _hu("PK-BOX-2", item_id=item.id, wh_id=wh.id, size=100, level=2, status="SEALED")
    part = _hu("PK-PART-1", item_id=item.id, wh_id=wh.id, size=10, level=1, name="Strip",
               issue=issue.id, line=line.id, content=Decimal("5"),
               source=("ISSUE", issue.id))
    db.add_all([box, shelf, part])
    await db.commit()
    db.add_all([
        _hu(f"PK-STRIP-{i}", item_id=item.id, wh_id=wh.id, size=10, level=1, name="Strip",
            parent=box.id) for i in range(2)
    ])
    db.add_all([
        m.SerialNumber(item_id=item.id, serial_number="S-1", asset_code="AST-0001",
                       warehouse_id=wh.id, status="ISSUED", remarks=f"Issued by issue {issue.id}"),
        # Known only by its serial: the maker's label, never ours.
        m.SerialNumber(item_id=item.id, serial_number="S-2", warehouse_id=wh.id,
                       status="ISSUED", remarks=f"Issued by issue {issue.id}"),
    ])
    await db.commit()

    await make_user(username="desk", permissions=[ISSUE_VIEW])
    headers = await login("desk", "pw")
    got = await client.get(f"/api/warehouse/issues/{issue.id}/labels", headers=headers)
    assert got.status_code == 200, got.text
    body = got.json()
    packs = [r for r in body["labels"] if r["kind"] == "PACK"]
    units = [r for r in body["labels"] if r["kind"] == "UNIT"]

    assert [r["code"] for r in packs] == ["PK-BOX-1", "PK-STRIP-0", "PK-STRIP-1", "PK-PART-1"]
    assert [r["depth"] for r in packs] == [0, 1, 1, 0]
    assert packs[1]["parent_code"] == "PK-BOX-1"
    assert packs[0]["packs_inside"] == "2 Strips"
    assert "PK-BOX-2" not in {r["code"] for r in packs}
    assert packs[3]["new_here"] and packs[3]["part"] and packs[3]["qty"] == 5
    assert [r["code"] for r in units] == ["AST-0001"]
    assert all(r["qr_token"] for r in body["labels"])
    assert body["lines"][0]["packs"] == 2 and body["lines"][0]["units"] == 1
    assert body["document_no"] == "WHI0099" and body["to_name"] == "LIP Badangi"

    printed = await client.post(f"/api/warehouse/issues/{issue.id}/labels/printed",
                                json={"label_ids": [], "printed": 5}, headers=headers)
    assert printed.status_code == 200, printed.text


async def test_an_issue_not_yet_posted_prints_nothing(db, client, make_user, login):
    _wh, _item, issue, _line = await _posted_issue(db, posted=False)
    await make_user(username="early", permissions=[ISSUE_VIEW])
    headers = await login("early", "pw")
    got = await client.get(f"/api/warehouse/issues/{issue.id}/labels", headers=headers)
    assert got.status_code in (400, 422), got.text
    assert "not been issued" in got.text


async def test_a_receipt_prints_only_what_arrived(db, client, make_user, login):
    wh, item, issue, line = await _posted_issue(db)
    arrived = _hu("PK-BOX-A", item_id=item.id, wh_id=wh.id, size=100, level=2, status="SEALED")
    missing = _hu("PK-BOX-M", item_id=item.id, wh_id=wh.id, size=100, level=2)
    db.add_all([arrived, missing])
    dispatch = m.Dispatch(dispatch_no="DSP0099", dispatch_date=date(2026, 10, 28),
                          warehouse_id=wh.id, warehouse_name=wh.name,
                          to_warehouse_name="LIP Badangi", status="ACKNOWLEDGED")
    db.add(dispatch)
    await db.commit()
    db.add_all([
        m.DispatchItem(dispatch_id=dispatch.id, line_no=1, issue_item_id=line.id,
                       item_id=item.id, item_code=item.code, item_name=item.name,
                       box_code="PK-BOX-A", quantity=Decimal("100"), delivered_qty=Decimal("90")),
        m.DispatchItem(dispatch_id=dispatch.id, line_no=2, issue_item_id=line.id,
                       item_id=item.id, item_code=item.code, item_name=item.name,
                       box_code="PK-BOX-M", quantity=Decimal("100"), delivered_qty=Decimal("0")),
    ])
    await db.commit()

    await make_user(username="site", permissions=[DISPATCH_VIEW, "indent.acknowledge"])
    headers = await login("site", "pw")
    got = await client.get(f"/api/warehouse/dispatches/{dispatch.id}/received-labels",
                           headers=headers)
    assert got.status_code == 200, got.text
    labels = got.json()["labels"]
    assert [r["code"] for r in labels] == ["PK-BOX-A"]
    assert labels[0]["qty"] == 90
