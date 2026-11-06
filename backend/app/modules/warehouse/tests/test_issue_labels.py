"""Labels for a posted issue, and for an acknowledged receipt (2026-10-28).

What these pin is WHICH stickers a document hands the printer:

- only after posting — a draft's boxes are a claim, and its part packs have no code;
- the packs the line issued, parent first with the strips inside each under it, and the
  part pack cut at the desk flagged as new — never a box still on the shelf;
- asset / consumable codes; a serial / IMEI only when the item is tracked by it;
- at the receiving end, only what the acknowledgement said ARRIVED.
"""
from datetime import date, datetime
from decimal import Decimal

import pytest

from app.modules.warehouse import box_codes
from app.modules.warehouse import models as m
from app.modules.warehouse.enums import DISPATCH_VIEW, ISSUE_VIEW
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse

pytestmark = pytest.mark.asyncio


LEFT_AT = datetime(2026, 10, 28, 10, 0, 0)


def _hu(code, *, item_id, wh_id, size, level, issue=None, line=None, parent=None,
        content=None, status="CONSUMED", source=None, name="Box", closed_at=LEFT_AT):
    return m.HandlingUnit(
        closed_at=closed_at if status == "CONSUMED" else None,
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
    carton = _hu("PK-CAR-1", item_id=item.id, wh_id=wh.id, size=1000, level=3,
                 name="Carton", status="SEALED", content=Decimal("900"))
    db.add(carton)
    await db.commit()
    box = _hu("PK-BOX-1", item_id=item.id, wh_id=wh.id, size=100, level=2,
              issue=issue.id, line=line.id, parent=carton.id)
    shelf = _hu("PK-BOX-2", item_id=item.id, wh_id=wh.id, size=100, level=2, status="SEALED",
                parent=carton.id)
    db.add_all([box, shelf])
    await db.commit()
    part = _hu("PK-PART-1", item_id=item.id, wh_id=wh.id, size=10, level=1, name="Strip",
               issue=issue.id, line=line.id, content=Decimal("5"),
               source=("ISSUE", issue.id), parent=shelf.id)
    db.add(part)
    db.add_all([
        _hu(f"PK-STRIP-{i}", item_id=item.id, wh_id=wh.id, size=10, level=1, name="Strip",
            parent=box.id) for i in range(2)
    ])
    # Taken out of the box by an EARLIER issue: not inside it any more.
    db.add(_hu("PK-STRIP-OLD", item_id=item.id, wh_id=wh.id, size=10, level=1, name="Strip",
               parent=box.id, closed_at=datetime(2026, 10, 1)))
    db.add_all([
        m.SerialNumber(item_id=item.id, serial_number="S-1", asset_code="AST-0001",
                       warehouse_id=wh.id, status="ISSUED", remarks=f"Issued by issue {issue.id}"),
        # Known only by its serial, on an item NOT tracked by serial: internal.
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

    # The tree they came out of: the carton once (a parent label, on top), the box that
    # left whole and its strips, then the part strip cut out of the box that stayed —
    # that box as a parent label too, because the strip's sticker names it.
    assert [r["code"] for r in packs] == [
        "PK-CAR-1", "PK-BOX-1", "PK-STRIP-0", "PK-STRIP-1", "PK-BOX-2", "PK-PART-1"]
    assert [r["context"] for r in packs] == [True, False, False, False, True, False]
    assert [r["issued"] for r in packs] == [False, True, False, False, False, True]
    assert [p["code"] for p in packs[2]["path"]] == ["PK-CAR-1", "PK-BOX-1"]
    assert [p["code"] for p in packs[5]["path"]] == ["PK-CAR-1", "PK-BOX-2"]
    assert packs[1]["packs_inside"] == "2 Strips"
    assert "PK-STRIP-OLD" not in {r["code"] for r in packs}
    assert packs[5]["new_here"] and packs[5]["part"] and packs[5]["qty"] == 5
    assert [r["code"] for r in units] == ["AST-0001"]
    assert all(r["qr_token"] for r in body["labels"])
    assert body["lines"][0]["packs"] == 2 and body["lines"][0]["units"] == 1
    assert body["document_no"] == "WHI0099" and body["to_name"] == "LIP Badangi"

    printed = await client.post(f"/api/warehouse/issues/{issue.id}/labels/printed",
                                json={"label_ids": [], "printed": 5}, headers=headers)
    assert printed.status_code == 200, printed.text


async def test_a_serial_or_imei_tracked_unit_prints_its_own_number(
    db, client, make_user, login,
):
    """2026-11-02: a handset issued by serial gets a sticker of its serial (and IMEI)."""
    wh, item, issue, _line = await _posted_issue(db)
    item.is_serial_tracked = True
    db.add_all([
        m.SerialNumber(item_id=item.id, serial_number="SN-100", imei="356000000000001",
                       warehouse_id=wh.id, status="ISSUED", remarks=f"Issued by issue {issue.id}"),
        m.SerialNumber(item_id=item.id, serial_number="SN-101", warehouse_id=wh.id,
                       status="ISSUED", remarks=f"Issued by issue {issue.id}"),
    ])
    await db.commit()

    await make_user(username="serialdesk", permissions=[ISSUE_VIEW])
    headers = await login("serialdesk", "pw")
    got = await client.get(f"/api/warehouse/issues/{issue.id}/labels", headers=headers)
    assert got.status_code == 200, got.text
    units = [r for r in got.json()["labels"] if r["kind"] == "UNIT"]
    assert sorted(r["code"] for r in units) == ["SN-100", "SN-101"]
    assert all(r["pack_name"] == "Serial no." for r in units)
    by_code = {r["code"]: r for r in units}
    assert by_code["SN-100"]["imei"] == "356000000000001"
    assert by_code["SN-100"]["serial_number"] == "SN-100"


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
