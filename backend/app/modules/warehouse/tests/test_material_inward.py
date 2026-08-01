"""End-to-end checks for the material inward (gate entry) screen.

The inward form is the first screen a store user touches, and it posts the shape the
React form actually builds — empty strings for untouched text boxes, nulls for every
optional line field. These tests post exactly that, so a change that only works when
the client sends a fully-populated line fails here rather than in the warehouse.
"""
import pytest
from sqlalchemy import select

from app.modules.warehouse.enums import (
    INSPECTION_EXECUTE, INSPECTION_VIEW, ISSUE_CREATE, PUTAWAY_EXECUTE, PUTAWAY_VIEW,
    RECEIPT_CREATE, RECEIPT_VIEW,
)
from app.shared.models.master import Item
from app.shared.models.warehouse import Bin, Warehouse

pytestmark = pytest.mark.asyncio


async def _fixtures(db):
    wh = Warehouse(code="WH1", name="Main store", warehouse_type="MAIN",
                   is_bin_managed=False, is_active=True)
    item = Item(code="ELE-GEN-0001", name="Copper cable 4 sqmm", uom_code="MTR",
                is_active=True)
    db.add_all([wh, item])
    await db.commit()
    return wh, item


async def test_material_inward_saves_the_shape_the_form_posts(db, client, make_user, login):
    wh, item = await _fixtures(db)
    await make_user(username="store", permissions=[RECEIPT_CREATE, RECEIPT_VIEW])
    headers = await login("store", "pw")

    body = {
        "receipt_type": "GATE_ENTRY",
        "grn_date": "2026-07-30",
        "po_id": None,
        "vendor_id": None,
        "warehouse_id": wh.id,
        "project_id": None,
        "invoice_no": "",
        "invoice_date": None,
        "invoice_amount": None,
        "eway_bill_no": "",
        "vehicle_no": "",
        "transporter_name": "",
        "lr_no": "",
        "gate_entry_no": "",
        "remarks": "",
        "items": [{
            "item_id": item.id,
            "ordered_qty": 0,
            "received_qty": 10,
            "accepted_qty": 10,
            "rejected_qty": 0,
            "rate": None,
            "batch_no": None,
            "mfg_date": None,
            "expiry_date": None,
            "bin_id": None,
            "remarks": None,
            "serial_numbers": None,
        }],
    }
    r = await client.post("/api/warehouse/receipts", json=body, headers=headers)
    assert r.status_code == 201, r.text
    saved = r.json()
    assert saved["status"] == "GATE_ENTRY"
    assert saved["gate_entry_no"]
    assert saved["items"][0]["item_code"] == "ELE-GEN-0001"
    assert saved["items"][0]["item_name"] == "Copper cable 4 sqmm"


async def test_material_inward_takes_a_typed_purchase_order_number(db, client, make_user, login):
    """The PO on a gate entry is whatever the driver's paperwork says — it is typed in,
    not picked, so an order the buyer raised outside this system still gets received."""
    wh, item = await _fixtures(db)
    await make_user(username="store", permissions=[RECEIPT_CREATE, RECEIPT_VIEW])
    headers = await login("store", "pw")

    body = {
        "receipt_type": "GATE_ENTRY",
        "grn_date": "2026-07-30",
        "po_no": "PO/2026-27/00042",
        "warehouse_id": wh.id,
        "items": [{"item_id": item.id, "received_qty": 5}],
    }
    r = await client.post("/api/warehouse/receipts", json=body, headers=headers)
    assert r.status_code == 201, r.text
    assert r.json()["po_no"] == "PO/2026-27/00042"
    assert r.json()["po_id"] is None


async def test_material_inward_uploads_a_document(db, client, make_user, login):
    wh, item = await _fixtures(db)
    await make_user(username="store", permissions=[RECEIPT_CREATE, RECEIPT_VIEW, "stock.view"])
    headers = await login("store", "pw")

    created = await client.post("/api/warehouse/receipts", json={
        "receipt_type": "GATE_ENTRY",
        "grn_date": "2026-07-30",
        "warehouse_id": wh.id,
        "items": [{"item_id": item.id, "received_qty": 5}],
    }, headers=headers)
    assert created.status_code == 201, created.text
    receipt_id = created.json()["id"]

    r = await client.post(
        "/api/warehouse/attachments",
        data={"entity_type": "RECEIPT", "entity_id": str(receipt_id), "doc_category": "INWARD"},
        files={"file": ("invoice.pdf", b"%PDF-1.4 fake", "application/pdf")},
        headers=headers,
    )
    assert r.status_code == 201, r.text
    assert r.json()["file_name"] == "invoice.pdf"

    listed = await client.get("/api/warehouse/attachments",
                             params={"entity_type": "RECEIPT", "entity_id": receipt_id},
                             headers=headers)
    assert listed.status_code == 200, listed.text
    assert [a["file_name"] for a in listed.json()] == ["invoice.pdf"]

    # An upload that stores no bytes is the bug this guards: the document must come
    # back down again.
    attachment_id = listed.json()[0]["id"]
    download = await client.get(f"/api/warehouse/attachments/{attachment_id}/download",
                               headers=headers)
    assert download.status_code == 200, download.text
    assert download.content == b"%PDF-1.4 fake"

    removed = await client.delete(f"/api/warehouse/attachments/{attachment_id}",
                                  headers=headers)
    assert removed.status_code == 204, removed.text
    gone = await client.get(f"/api/warehouse/attachments/{attachment_id}/download",
                            headers=headers)
    assert gone.status_code == 404, gone.text


async def test_submitting_a_receipt_raises_its_inspection(db, client, make_user, login):
    """Submit branches on the item's `requires_qi`, and only the True branch builds an
    inspection. Every other test here uses a plain item, so the inspection path was
    never exercised and shipped broken."""
    wh, _ = await _fixtures(db)
    item = Item(code="ELE-GEN-0002", name="Contactor 32A", uom_code="NOS",
                requires_qi=True, is_active=True)
    db.add(item)
    await db.commit()
    await make_user(username="store", permissions=[RECEIPT_CREATE, RECEIPT_VIEW])
    headers = await login("store", "pw")

    created = await client.post("/api/warehouse/receipts", json={
        "receipt_type": "PURCHASE",
        "grn_date": "2026-07-31",
        "warehouse_id": wh.id,
        "items": [{"item_id": item.id, "received_qty": 4, "accepted_qty": 4}],
    }, headers=headers)
    assert created.status_code == 201, created.text

    r = await client.post(f"/api/warehouse/receipts/{created.json()['id']}/submit",
                          headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "PENDING_QC"


async def test_serials_are_optional_until_putaway(db, client, make_user, login):
    """Serials may be captured at the GRN, at QC, or at neither — putaway is where every
    unit is accounted for. A storekeeper counting cartons off a vehicle cannot read what
    is inside them, so demanding serials earlier stopped the consignment being booked in
    at all. More serials than units is still a contradiction and stays refused."""
    wh, _ = await _fixtures(db)
    item = Item(code="ELE-GEN-0003", name="Laptop dock", uom_code="NOS",
                requires_qi=True, is_serial_tracked=True, is_active=True)
    db.add(item)
    await db.commit()
    await make_user(username="store", permissions=[RECEIPT_CREATE, RECEIPT_VIEW])
    headers = await login("store", "pw")

    created = await client.post("/api/warehouse/receipts", json={
        "receipt_type": "PURCHASE",
        "grn_date": "2026-07-31",
        "warehouse_id": wh.id,
        "items": [{"item_id": item.id, "received_qty": 3}],
    }, headers=headers)
    assert created.status_code == 201, created.text
    receipt_id = created.json()["id"]
    assert created.json()["items"][0]["serial_numbers"] is None

    # A partial capture is fine — the rest are read at putaway.
    partial = await client.put(f"/api/warehouse/receipts/{receipt_id}", json={
        "receipt_type": "PURCHASE",
        "grn_date": "2026-07-31",
        "warehouse_id": wh.id,
        "items": [{"item_id": item.id, "received_qty": 3, "serial_numbers": ["SN-1"]}],
    }, headers=headers)
    assert partial.status_code == 200, partial.text
    assert partial.json()["items"][0]["serial_numbers"] == ["SN-1"]

    too_many = await client.put(f"/api/warehouse/receipts/{receipt_id}", json={
        "receipt_type": "PURCHASE",
        "grn_date": "2026-07-31",
        "warehouse_id": wh.id,
        "items": [{"item_id": item.id, "received_qty": 1,
                   "serial_numbers": ["SN-1", "SN-2"]}],
    }, headers=headers)
    assert too_many.status_code == 422, too_many.text

    submitted = await client.post(f"/api/warehouse/receipts/{receipt_id}/submit",
                                  headers=headers)
    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["status"] == "PENDING_QC"


async def test_cancelling_an_inspection_reopens_its_receipt(db, client, make_user, login):
    """PENDING_QC has nothing that can finish it once the inspection is gone, and it is
    outside what update_receipt will edit — so a cancelled inspection used to strand its
    receipt with no way forward or back."""
    wh, _ = await _fixtures(db)
    item = Item(code="ELE-GEN-0004", name="Relay module", uom_code="NOS",
                requires_qi=True, is_active=True)
    db.add(item)
    await db.commit()
    await make_user(username="store", permissions=[RECEIPT_CREATE, RECEIPT_VIEW,
                                                   INSPECTION_VIEW, INSPECTION_EXECUTE])
    headers = await login("store", "pw")

    created = await client.post("/api/warehouse/receipts", json={
        "receipt_type": "PURCHASE",
        "grn_date": "2026-07-31",
        "warehouse_id": wh.id,
        "items": [{"item_id": item.id, "received_qty": 6}],
    }, headers=headers)
    receipt_id = created.json()["id"]
    submitted = await client.post(f"/api/warehouse/receipts/{receipt_id}/submit", headers=headers)
    assert submitted.json()["status"] == "PENDING_QC", submitted.text

    listed = await client.get("/api/warehouse/inspections", headers=headers)
    inspection_id = listed.json()["items"][0]["id"]

    cancelled = await client.post(f"/api/warehouse/inspections/{inspection_id}/cancel",
                                  json={"reason": "raised in error"}, headers=headers)
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "CANCELLED"

    receipt = await client.get(f"/api/warehouse/receipts/{receipt_id}", headers=headers)
    assert receipt.json()["status"] == "DRAFT", receipt.text

    # And it is editable again — the point of walking it back.
    fixed = await client.put(f"/api/warehouse/receipts/{receipt_id}", json={
        "receipt_type": "PURCHASE",
        "grn_date": "2026-07-31",
        "warehouse_id": wh.id,
        "items": [{"item_id": item.id, "received_qty": 5}],
    }, headers=headers)
    assert fixed.status_code == 200, fixed.text


async def test_cancelling_leaves_a_receipt_whose_stock_moved_alone(db, client, make_user, login):
    """A line that needs no QC is released to stock at submit. Walking that receipt back
    to DRAFT would let it be submitted — and posted — a second time."""
    wh, plain = await _fixtures(db)          # requires_qi is False on the plain item
    qc_item = Item(code="ELE-GEN-0005", name="Isolator", uom_code="NOS",
                   requires_qi=True, is_active=True)
    db.add(qc_item)
    await db.commit()
    await make_user(username="store", permissions=[RECEIPT_CREATE, RECEIPT_VIEW,
                                                   INSPECTION_VIEW, INSPECTION_EXECUTE,
                                                   "stock.view"])
    headers = await login("store", "pw")

    created = await client.post("/api/warehouse/receipts", json={
        "receipt_type": "PURCHASE",
        "grn_date": "2026-07-31",
        "warehouse_id": wh.id,
        "items": [{"item_id": plain.id, "received_qty": 3},
                  {"item_id": qc_item.id, "received_qty": 2}],
    }, headers=headers)
    receipt_id = created.json()["id"]
    await client.post(f"/api/warehouse/receipts/{receipt_id}/submit", headers=headers)

    listed = await client.get("/api/warehouse/inspections", headers=headers)
    inspection_id = listed.json()["items"][0]["id"]
    await client.post(f"/api/warehouse/inspections/{inspection_id}/cancel",
                      json={"reason": "raised in error"}, headers=headers)

    receipt = await client.get(f"/api/warehouse/receipts/{receipt_id}", headers=headers)
    assert receipt.json()["status"] == "PENDING_QC", receipt.text


async def test_completing_an_inspection_raises_a_putaway_task(db, client, make_user, login):
    """Passing QC on a bin-managed site releases the line to putaway. Every other test
    here uses a bulk warehouse, which has nowhere to put anything away to, so the insert
    was never exercised — and it omitted a column the live schema requires."""
    wh = Warehouse(code="WH-BIN", name="Bin store", warehouse_type="MAIN",
                   is_bin_managed=True, is_active=True)
    item = Item(code="ELE-GEN-0006", name="Busbar", uom_code="NOS",
                requires_qi=True, is_active=True)
    db.add_all([wh, item])
    await db.commit()
    await make_user(username="store", permissions=[RECEIPT_CREATE, RECEIPT_VIEW,
                                                   INSPECTION_VIEW, INSPECTION_EXECUTE,
                                                   PUTAWAY_VIEW, "stock.view"])
    headers = await login("store", "pw")

    created = await client.post("/api/warehouse/receipts", json={
        "receipt_type": "PURCHASE",
        "grn_date": "2026-07-31",
        "warehouse_id": wh.id,
        "items": [{"item_id": item.id, "received_qty": 4}],
    }, headers=headers)
    assert created.status_code == 201, created.text
    submitted = await client.post(f"/api/warehouse/receipts/{created.json()['id']}/submit",
                                  headers=headers)
    assert submitted.status_code == 200, submitted.text

    listed = await client.get("/api/warehouse/inspections", headers=headers)
    inspection_id = listed.json()["items"][0]["id"]
    detail = await client.get(f"/api/warehouse/inspections/{inspection_id}", headers=headers)
    line = detail.json()["items"][0]

    saved = await client.put(f"/api/warehouse/inspections/{inspection_id}", json={
        "inspection_date": "2026-07-31",
        "receipt_id": created.json()["id"],
        "warehouse_id": wh.id,
        "inspection_type": "INCOMING",
        "items": [{
            "receipt_item_id": line["receipt_item_id"],
            "item_id": item.id,
            "inspected_qty": 4,
            "accepted_qty": 4,
            "result": "PASSED",
        }],
    }, headers=headers)
    assert saved.status_code == 200, saved.text

    completed = await client.post(f"/api/warehouse/inspections/{inspection_id}/complete",
                                  headers=headers)
    assert completed.status_code == 200, completed.text

    tasks = await client.get("/api/warehouse/putaways", headers=headers)
    assert tasks.status_code == 200, tasks.text
    assert tasks.json()["total"] == 1, tasks.text


async def test_putaway_stamps_a_lot_number_from_the_storage_path(
    db, client, make_user, login,
):
    """A lot number names where the stock came to rest, so it can only be built once a
    bin is chosen — and it is built from the bin's ancestry, not from the bin alone."""
    wh = Warehouse(code="WH-TREE", name="Tiered store", warehouse_type="MAIN",
                   is_bin_managed=True, is_active=True)
    item = Item(code="ELE-GEN-0007", name="Cable tray", uom_code="MTR",
                requires_qi=False, is_active=True)
    db.add_all([wh, item])
    await db.commit()

    # block A > flr-1 > lane -1 > rack-1 > shf-1 > bin A1, the shape the live warehouse
    # is configured with.
    parent_id = None
    for code, storage_type in [("block A", "BLOCK"), ("flr-1", "FLOOR"),
                               ("lane -1", "LANE"), ("rack-1", "RACK"),
                               ("shf-1", "SHELF"), ("bin A1", "BIN")]:
        node = Bin(warehouse_id=wh.id, code=code, name=code, bin_type=storage_type,
                   parent_id=parent_id, is_active=True)
        db.add(node)
        await db.commit()
        parent_id = node.id
    bin_id = parent_id

    await make_user(username="putter", permissions=[RECEIPT_CREATE, RECEIPT_VIEW,
                                                    PUTAWAY_VIEW, PUTAWAY_EXECUTE,
                                                    "stock.view", "stock.transfer"])
    headers = await login("putter", "pw")

    created = await client.post("/api/warehouse/receipts", json={
        "receipt_type": "PURCHASE",
        "grn_date": "2026-07-31",
        "warehouse_id": wh.id,
        "items": [{"item_id": item.id, "received_qty": 5}],
    }, headers=headers)
    assert created.status_code == 201, created.text
    submitted = await client.post(f"/api/warehouse/receipts/{created.json()['id']}/submit",
                                  headers=headers)
    assert submitted.status_code == 200, submitted.text

    tasks = await client.get("/api/warehouse/putaways", headers=headers)
    task_id = tasks.json()["items"][0]["id"]

    confirmed = await client.post(f"/api/warehouse/putaways/{task_id}/confirm", json={
        "actual_bin_id": bin_id,
        "qty": 5,
    }, headers=headers)
    assert confirmed.status_code == 200, confirmed.text

    body = confirmed.json()
    assert body["lot_no"].startswith(f"LOT/WH{wh.id}/A-F1-L1-R1-S1-A1/"), body["lot_no"]
    assert body["lot_no"].endswith("/00001"), body["lot_no"]
    assert body["actual_bin_path"] == "block A / flr-1 / lane -1 / rack-1 / shf-1 / bin A1"


async def test_creating_a_picklist_saves_its_lines(db, client, make_user, login):
    """Same shape as the inspection bug above — a fresh parent row appends lines to a
    collection that nothing loaded. Nothing covered picklist creation, so it crashed the
    same way."""
    wh, item = await _fixtures(db)
    await make_user(username="picker", permissions=[ISSUE_CREATE])
    headers = await login("picker", "pw")

    r = await client.post("/api/warehouse/pickings", json={
        "pick_date": "2026-07-31",
        "warehouse_id": wh.id,
        "items": [{"item_id": item.id, "required_qty": 3}],
    }, headers=headers)
    assert r.status_code == 201, r.text
    assert len(r.json()["items"]) == 1


async def test_gate_register_keeps_converted_entries(db, client, make_user, login):
    """Converting promotes the row to a GRN (`receipt_type` becomes PURCHASE). The gate
    register must still list it — a gate entry that was worked on is not a gate entry
    that never happened, and the storekeeper's own screen went blank without this."""
    wh, item = await _fixtures(db)
    await make_user(username="store", permissions=[RECEIPT_CREATE, RECEIPT_VIEW])
    headers = await login("store", "pw")

    created = await client.post("/api/warehouse/receipts", json={
        "receipt_type": "GATE_ENTRY",
        "grn_date": "2026-07-30",
        "warehouse_id": wh.id,
        "items": [{"item_id": item.id, "received_qty": 5}],
    }, headers=headers)
    assert created.status_code == 201, created.text
    receipt_id = created.json()["id"]

    converted = await client.post(f"/api/warehouse/receipts/{receipt_id}/convert-to-grn",
                                  headers=headers)
    assert converted.status_code == 200, converted.text
    assert converted.json()["receipt_type"] == "PURCHASE"

    # The old filter — rows still typed GATE_ENTRY — is now empty.
    strict = await client.get("/api/warehouse/receipts",
                              params={"receipt_type": "GATE_ENTRY"}, headers=headers)
    assert [r["id"] for r in strict.json()["items"]] == []

    register = await client.get("/api/warehouse/receipts",
                                params={"gate_register": "true"}, headers=headers)
    assert register.status_code == 200, register.text
    row = register.json()["items"][0]
    assert row["id"] == receipt_id
    assert row["gate_entry_no"]


async def test_item_options_label_the_item_with_its_code(db, client, make_user, login):
    await _fixtures(db)
    await make_user(username="store", permissions=["stock.view"])
    headers = await login("store", "pw")

    r = await client.get("/api/warehouse/options/items", params={"search": "copper"},
                         headers=headers)
    assert r.status_code == 200, r.text
    row = r.json()[0]
    assert row["code"] == "ELE-GEN-0001"
    assert row["name"] == "Copper cable 4 sqmm"


async def test_unsaved_items_are_not_left_behind(db):
    """Guards the ORM state assumption `_apply_receipt_lines` relies on."""
    from app.modules.warehouse import models as m
    rows = (await db.execute(select(m.Receipt))).scalars().all()
    assert rows == []
