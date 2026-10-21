"""Pack hierarchies, end to end, through the HTTP API (2026-10-08).

One story, every door, each pressed by the role that presses it:

  master   two hierarchies for one tablet; a container twice in one hierarchy refused
  buyer    PO for "2 Carton" of Strip-of-10 = 800 TAB
  supplier despatches in Strip-of-15 instead — refused without a reason, then PENDING
  buyer    sees the change, accepts it; the PO line moves to Strip-of-15
  gate     the declared packing is fixed: over refused, a level not sent refused,
           a short count accepted and the received quantity is the count
  putaway  re-packed on the way to the shelf; every pack a row, coded (atoms)
  stock    the shelf, the lot and the ledger all read in packs
  repack   wrap coded boxes in a carton, open it again, never below the coded level;
           refused without `stock.repack`
  issue    "1 Box" takes a box; part of a coded pack is refused without break bulk,
           refused with it but without the permission, and done with both — the code
           retires and what stays behind is still on the shelf
"""
from datetime import date
from decimal import Decimal

from sqlalchemy import select, update

from app.core.security import hash_password
from app.modules.procurement.models import PurchaseOrder, VendorUser
from app.modules.warehouse import models as m
from app.modules.warehouse.enums import HandlingUnitStatus as HUS
from app.platform.settings import codeformat
from app.platform.settings.models import Attachment, Notification
from app.shared.models.master import Item, Uom, Vendor
from app.shared.models.warehouse import Bin, Warehouse

TODAY = date.today().isoformat()
STORE_PERMS = ["receipt.create", "receipt.view", "putaway.view", "putaway.execute",
               "stock.view", "stock.view.all", "issue.create", "issue.view",
               "issue.issue"]


async def _world(db, make_user):
    uom = Uom(code="TAB", name="Tablet", uom_class="COUNT", is_active=True)
    db.add(uom)
    await db.flush()
    item = Item(code="TAB-0001", name="Paracetamol 500", uom_id=uom.id, uom_code="TAB",
                is_active=True)
    vendor = Vendor(code="VEN-PH", name="Pharma Co", vendor_type="MATERIAL",
                    is_active=True)
    wh = Warehouse(code="WH1", name="Main store", warehouse_type="MAIN",
                   is_bin_managed=True, is_active=True)
    db.add_all([item, vendor, wh])
    await db.flush()
    floor = Bin(warehouse_id=wh.id, code="F1", name="Floor 1", bin_type="FLOOR",
                is_active=True)
    db.add(floor)
    await db.flush()
    bay = Bin(warehouse_id=wh.id, code="F1-B1", name="Bay 1", bin_type="BIN",
              parent_id=floor.id, is_active=True)
    db.add(bay)
    db.add(VendorUser(vendor_id=vendor.id, username="pharma",
                      password_hash=hash_password("pw"), is_active=True,
                      must_change_password=False))
    await db.commit()
    # Coded per pack: code-tracked, countable, at a main warehouse.
    await codeformat.set_item_tracked(db, item.code, True)
    await db.commit()

    await make_user(employee_id=10, username="master", permissions=[
        "master.packaging.manage"])
    await make_user(employee_id=11, username="buyer", permissions=[
        "po.view", "po.create", "po.edit", "po.pack_change"])
    await make_user(employee_id=12, username="store",
                    permissions=STORE_PERMS + ["stock.repack"])
    await make_user(employee_id=13, username="clerk", permissions=STORE_PERMS)
    await make_user(employee_id=14, username="senior",
                    permissions=STORE_PERMS + ["issue.break_bulk"])
    return item, vendor, wh, bay


async def test_pack_hierarchies_end_to_end(client, db, make_user, login):
    item, vendor, wh, bay = await _world(db, make_user)
    # Plain ids: the test expires its session to read what the API wrote.
    item_id, vendor_id, wh_id, bay_id = item.id, vendor.id, wh.id, bay.id

    # ---------------------------------------------------------------- master --
    h = await login("master", "pw")
    containers = {}
    for code, name in (("STR", "Strip"), ("BOX", "Box"), ("CTN", "Carton")):
        r = await client.post("/api/packaging", headers=h, json={"code": code, "name": name})
        assert r.status_code in (200, 201), r.text
        containers[code] = r.json()["id"]
    hierarchies = {}
    for name in ("Strip of 10", "Strip of 15"):
        r = await client.post("/api/pack-hierarchies", headers=h,
                              json={"item_id": item_id, "name": name})
        assert r.status_code in (200, 201), r.text
        hierarchies[name] = r.json()["id"]
    for name, strip in (("Strip of 10", 10), ("Strip of 15", 15)):
        for level, code, qty in ((1, "STR", strip), (2, "BOX", 10), (3, "CTN", 4)):
            r = await client.post("/api/item-packaging", headers=h, json={
                "item_id": item_id, "hierarchy_id": hierarchies[name], "level": level,
                "package_id": containers[code], "quantity": qty})
            assert r.status_code in (200, 201), r.text
    # The same container twice in ONE hierarchy is refused.
    r = await client.post("/api/item-packaging", headers=h, json={
        "item_id": item_id, "hierarchy_id": hierarchies["Strip of 10"], "level": 4,
        "package_id": containers["BOX"], "quantity": 2})
    assert r.status_code == 422 and "already level 2" in r.text, r.text
    r = await client.get("/api/pack-options", headers=h, params={"item_ids": str(item_id)})
    options = {row["name"]: row for row in r.json()["items"][0]["hierarchies"]}
    assert [lv["size"] for lv in options["Strip of 10"]["levels"]] == [1, 10, 100, 400]
    assert [lv["size"] for lv in options["Strip of 15"]["levels"]] == [1, 15, 150, 600]
    ten, fifteen = hierarchies["Strip of 10"], hierarchies["Strip of 15"]

    # ------------------------------------------------------------------ buyer --
    h = await login("buyer", "pw")
    po_body = {
        "vendor_id": vendor_id, "billing_address": "HQ", "shipping_address": "Main store",
        "lines": [{"item_id": item_id, "quantity": 800, "rate": 2,
                   "pack_hierarchy_id": ten,
                   "pack_breakdown": [{"level": 3, "qty": 2}]}]}
    r = await client.post("/api/pos", headers=h, json={
        **po_body, "lines": [{**po_body["lines"][0], "quantity": 700}]})
    assert r.status_code == 422 and "does not add up" in r.text, r.text
    r = await client.post("/api/pos", headers=h, json=po_body)
    assert r.status_code in (200, 201), r.text
    po = r.json()
    po_id, po_line = po["id"], po["items"][0]
    assert po_line["pack_text"] == "2 Carton = 800 TAB"
    assert po_line["pack_hierarchy_name"] == "Strip of 10"

    # On a draft, re-packing the line changes its quantity and its money.
    r = await client.put(f"/api/pos/{po_id}/lines/{po_line['id']}/packing", headers=h, json={
        "pack_hierarchy_id": ten, "pack_breakdown": [{"level": 3, "qty": 3}]})
    assert r.status_code == 200, r.text
    assert r.json()["items"][0]["quantity"] == 1200
    assert r.json()["items"][0]["amount"] == 2400
    r = await client.put(f"/api/pos/{po_id}/lines/{po_line['id']}/packing", headers=h, json={
        "pack_hierarchy_id": ten, "pack_breakdown": [{"level": 3, "qty": 2}]})
    assert r.json()["items"][0]["quantity"] == 800
    # Approval is not what this test is about: the order is simply sent.
    await db.execute(update(PurchaseOrder).where(PurchaseOrder.id == po_id)
                     .values(status="SENT_TO_VENDOR"))
    await db.commit()
    # Once approved, the packs may be re-described at the same quantity...
    r = await client.put(f"/api/pos/{po_id}/lines/{po_line['id']}/packing", headers=h, json={
        "pack_hierarchy_id": ten, "pack_breakdown": [{"level": 2, "qty": 8}]})
    assert r.status_code == 200, r.text
    assert r.json()["items"][0]["pack_text"] == "8 Box = 800 TAB"
    # ...but not to a different one.
    r = await client.put(f"/api/pos/{po_id}/lines/{po_line['id']}/packing", headers=h, json={
        "pack_hierarchy_id": ten, "pack_breakdown": [{"level": 2, "qty": 9}]})
    assert r.status_code == 422 and "amending the order" in r.text, r.text
    r = await client.put(f"/api/pos/{po_id}/lines/{po_line['id']}/packing", headers=h, json={
        "pack_hierarchy_id": ten, "pack_breakdown": [{"level": 3, "qty": 2}]})
    assert r.status_code == 200, r.text

    # --------------------------------------------------------------- supplier --
    r = await client.post("/api/supplier/login", json={"username": "pharma", "password": "pw"})
    assert r.status_code == 200, r.text
    vh = {"Authorization": f"Bearer {r.json()['access_token']}"}
    r = await client.post(f"/api/supplier/pos/{po_id}/respond", headers=vh,
                          json={"accept": True})
    assert r.status_code == 200, r.text
    r = await client.get(f"/api/supplier/pos/{po_id}", headers=vh)
    line = r.json()["lines"][0]
    assert line["pack_text"] == "2 Carton = 800 TAB"
    assert {o["name"] for o in line["pack_options"]} == {"Strip of 10", "Strip of 15"}

    note_body = {"invoice_no": "INV-9", "vehicle_no": "AP39X1", "lines": [{
        "po_item_id": po_line["id"], "pack_hierarchy_id": fifteen,
        "pack_breakdown": [{"level": 2, "qty": 5}]}]}
    r = await client.post(f"/api/supplier/pos/{po_id}/despatch-notes", headers=vh,
                          json=note_body)
    assert r.status_code == 422 and "Say why" in r.text, r.text
    note_body["lines"][0]["pack_change_reason"] = "10-strips out of stock"
    r = await client.post(f"/api/supplier/pos/{po_id}/despatch-notes", headers=vh,
                          json=note_body)
    assert r.status_code == 201, r.text
    note = r.json()
    sent = note["items"][0]
    assert sent["despatched_qty"] == 750                 # 5 Box x 150
    assert sent["pack_change_status"] == "PENDING"
    for category in ("INVOICE", "DC"):
        db.add(Attachment(entity_type="PURCHASE_ORDER", entity_id=po_id,
                          file_name=f"{category}.pdf", file_path="/dev/null",
                          doc_category=category))
    await db.commit()
    r = await client.post(f"/api/supplier/despatch-notes/{note['id']}/submit", headers=vh)
    assert r.status_code == 200, r.text
    await db.commit()   # a fresh snapshot: the API wrote in its own session
    db.expire_all()     # and nothing loaded earlier is trusted
    told = (await db.execute(select(Notification).where(
        Notification.employee_id == 11))).scalars().all()
    assert any("changed the packing" in n.title for n in told)

    # ---------------------------------------------------------- buyer answers --
    h = await login("buyer", "pw")
    r = await client.get(f"/api/pos/{po_id}/pack-changes", headers=h)
    changes = r.json()["items"]
    assert [(c["ordered_hierarchy_name"], c["sent_hierarchy_name"], c["status"])
            for c in changes] == [("Strip of 10", "Strip of 15", "PENDING")]
    r = await client.post(f"/api/pos/{po_id}/pack-changes/{changes[0]['id']}/accept",
                          headers=h, json={})
    assert r.status_code == 200 and r.json()["status"] == "ACCEPTED", r.text
    r = await client.get(f"/api/pos/{po_id}", headers=h)
    assert r.json()["items"][0]["pack_text"] == "1 Carton + 1 Box + 3 Strip + 5 loose TAB = 800 TAB"

    # ------------------------------------------------------------------- gate --
    h = await login("store", "pw")
    r = await client.get("/api/warehouse/options/despatch-prefill", headers=h,
                         params={"note_id": note["id"]})
    assert r.status_code == 200, r.text
    pre = r.json()["lines"][0]
    assert pre["pack_text"] == "5 Box = 750 TAB"
    assert pre["pack_change_status"] == "ACCEPTED"

    def receipt(packs):
        return {"receipt_type": "PURCHASE", "grn_date": TODAY, "po_id": po_id,
                "despatch_note_id": note["id"], "warehouse_id": wh_id,
                "invoice_no": "INV-9", "items": [{
                    "po_item_id": po_line["id"], "item_id": item_id,
                    "despatch_note_item_id": pre["despatch_note_item_id"],
                    "ordered_qty": 800, "received_qty": 0, "pack_breakdown": packs}]}
    r = await client.post("/api/warehouse/receipts", headers=h,
                          json=receipt([{"level": 2, "qty": 6}]))
    assert r.status_code == 422 and "never over" in r.text, r.text
    r = await client.post("/api/warehouse/receipts", headers=h,
                          json=receipt([{"level": 3, "qty": 1}]))
    assert r.status_code == 422 and "did not send any Carton" in r.text, r.text
    # Only what was sent can be counted: a strip is not a level the note declared.
    r = await client.post("/api/warehouse/receipts", headers=h,
                          json=receipt([{"level": 2, "qty": 4}, {"level": 1, "qty": 9}]))
    assert r.status_code == 422 and "did not send any Strip" in r.text, r.text
    # One box arrived opened and part-empty: 4 Box + 135 loose = 735.
    r = await client.post("/api/warehouse/receipts", headers=h,
                          json=receipt([{"level": 2, "qty": 4}, {"level": 0, "qty": 135}]))
    assert r.status_code == 201, r.text
    grn = r.json()
    grn_line = grn["items"][0]
    assert Decimal(str(grn_line["received_qty"])) == 735
    assert grn_line["declared_pack_text"] == "5 Box = 750 TAB"
    assert grn_line["pack_text"] == "4 Box + 135 loose TAB = 735 TAB"
    r = await client.post(f"/api/warehouse/receipts/{grn['id']}/submit", headers=h)
    assert r.status_code == 200, r.text

    # ---------------------------------------------------------------- putaway --
    r = await client.get("/api/warehouse/putaways", headers=h)
    task = next(t for t in r.json()["items"] if t["grn_id"] == grn["id"])
    r = await client.get(f"/api/warehouse/putaways/{task['id']}", headers=h)
    detail = r.json()
    assert detail["pack_hierarchy_name"] == "Strip of 15"
    assert detail["codes_per_pack"] is True
    # Re-packed on the way to the shelf: one box opened, the loose tablets stripped —
    # 3 Box + 19 Strip.
    r = await client.post(f"/api/warehouse/putaways/{task['id']}/confirm", headers=h, json={
        "actual_bin_id": bay_id, "qty": 735,
        "pack_breakdown": [{"level": 2, "qty": 3}, {"level": 1, "qty": 19}]})
    assert r.status_code == 200, r.text
    await db.commit()   # a fresh snapshot: the API wrote in its own session
    db.expire_all()     # and nothing loaded earlier is trusted
    packs = (await db.execute(select(m.HandlingUnit))).scalars().all()
    assert sorted((p.level, p.is_atom) for p in packs) == [(1, True)] * 19 + [(2, True)] * 3
    assert all(p.hu_code.endswith("-BOX") or p.hu_code.endswith("-STRIP") for p in packs)

    # ------------------------------------------------------------------ stock --
    from app.modules.inventory.models import Stock
    await db.commit()   # a fresh snapshot: the API wrote in its own session
    db.expire_all()     # and nothing loaded earlier is trusted
    stock = (await db.execute(select(Stock).where(
        Stock.item_id == item_id, Stock.bin_id == bay_id))).scalars().one()
    stock_id = stock.id
    r = await client.post("/api/warehouse/packs/summary", headers=h,
                          json={"stock_ids": [stock_id]})
    assert r.json()["items"][0]["pack_text"] == "3 Box + 19 Strip = 735 TAB"
    r = await client.get("/api/stock/movements", headers=h, params={"item_id": item_id})
    assert any(row["pack_text"] == "3 Box + 19 Strip = 735 TAB"
               for row in r.json()["items"]), r.json()["items"]

    # ----------------------------------------------------------------- repack --
    r = await client.post(f"/api/warehouse/packs/lots/{stock_id}/repack",
                          headers=await login("clerk", "pw"), json={
                              "pack_hierarchy_id": fifteen,
                              "target": [{"level": 3, "qty": 1}, {"level": 1, "qty": 9}]})
    assert r.status_code == 403, r.text
    r = await client.get(f"/api/warehouse/packs/lots/{stock_id}", headers=h)
    lot = r.json()
    assert next(x for x in lot["hierarchies"] if x["in_use"])["coded_floor"] == 1
    # Wrap: ten strips form a box, and four boxes a carton.
    r = await client.post(f"/api/warehouse/packs/lots/{stock_id}/repack", headers=h, json={
        "pack_hierarchy_id": fifteen,
        "target": [{"level": 3, "qty": 1}, {"level": 1, "qty": 9}]})
    assert r.status_code == 200, r.text
    assert r.json()["pack_text"] == "1 Carton + 9 Strip = 735 TAB"
    # Back down to the coded level.
    r = await client.post(f"/api/warehouse/packs/lots/{stock_id}/repack", headers=h, json={
        "pack_hierarchy_id": fifteen,
        "target": [{"level": 2, "qty": 3}, {"level": 1, "qty": 19}]})
    assert r.status_code == 200, r.text
    assert r.json()["pack_text"] == "3 Box + 19 Strip = 735 TAB"
    # Never below it.
    r = await client.post(f"/api/warehouse/packs/lots/{stock_id}/repack", headers=h, json={
        "pack_hierarchy_id": fifteen, "target": [{"level": 1, "qty": 49}]})
    assert r.status_code == 422 and "cannot be split" in r.text, r.text
    # Never the quantity.
    r = await client.post(f"/api/warehouse/packs/lots/{stock_id}/repack", headers=h, json={
        "pack_hierarchy_id": fifteen, "target": [{"level": 2, "qty": 5}]})
    assert r.status_code == 422 and "never changes the quantity" in r.text, r.text

    # ------------------------------------------------------------------ issue --
    def issue_body(qty=None, packs=None, break_bulk=False):
        line = {"item_id": item_id, "bin_id": bay_id, "requested_qty": qty or 0,
                "break_bulk": break_bulk}
        if packs:
            line.update(pack_hierarchy_id=fifteen, pack_breakdown=packs,
                        requested_qty=150)
        else:
            line["issued_qty"] = qty
        return {"issue_type": "DIRECT", "issue_date": TODAY, "warehouse_id": wh_id,
                "items": [line]}

    async def approve_and_post(issue_id, headers):
        await db.execute(update(m.MaterialIssue).where(m.MaterialIssue.id == issue_id)
                         .values(status="APPROVED"))
        await db.commit()
        r = await client.post(f"/api/warehouse/issues/{issue_id}/issue", headers=headers)
        assert r.status_code == 200, r.text

    # "1 Box" takes a box — not ten of the loose strips standing beside it.
    r = await client.post("/api/warehouse/issues", headers=h,
                          json=issue_body(packs=[{"level": 2, "qty": 1}]))
    assert r.status_code == 201, r.text
    issued = r.json()
    assert Decimal(str(issued["items"][0]["issued_qty"])) == 150
    assert issued["items"][0]["pack_text"] == "1 Box = 150 TAB"
    await approve_and_post(issued["id"], h)
    r = await client.post("/api/warehouse/packs/summary", headers=h,
                          json={"stock_ids": [stock_id]})
    assert r.json()["items"][0]["pack_text"] == "2 Box + 19 Strip = 585 TAB"
    await db.commit()   # a fresh snapshot: the API wrote in its own session
    db.expire_all()     # and nothing loaded earlier is trusted
    boxes = (await db.execute(select(m.HandlingUnit).where(
        m.HandlingUnit.level == 2))).scalars().all()
    assert sum(b.status == HUS.CONSUMED.value for b in boxes) == 1

    # Part of a coded strip: refused, refused again without the permission...
    r = await client.post("/api/warehouse/issues", headers=h, json=issue_body(qty=5))
    assert r.status_code == 422 and "leaves whole" in r.text, r.text
    r = await client.post("/api/warehouse/issues", headers=h,
                          json=issue_body(qty=5, break_bulk=True))
    assert r.status_code == 422 and "Break bulk permission" in r.text, r.text
    # ...and done by somebody who holds it.
    s = await login("senior", "pw")
    r = await client.post("/api/warehouse/issues", headers=s,
                          json=issue_body(qty=5, break_bulk=True))
    assert r.status_code == 201, r.text
    await approve_and_post(r.json()["id"], s)
    r = await client.post("/api/warehouse/packs/summary", headers=h,
                          json={"stock_ids": [stock_id]})
    assert r.json()["items"][0]["pack_text"] == "2 Box + 18 Strip + 10 loose TAB = 580 TAB"
    await db.commit()   # a fresh snapshot: the API wrote in its own session
    db.expire_all()     # and nothing loaded earlier is trusted
    opened = (await db.execute(select(m.HandlingUnit).where(
        m.HandlingUnit.status == HUS.OPENED.value,
        m.HandlingUnit.closed_reason.like("Break bulk%")))).scalars().all()
    assert len(opened) == 1 and opened[0].level == 1
