"""End-to-end checks for the material inward (gate entry) screen.

The inward form is the first screen a store user touches, and it posts the shape the
React form actually builds — empty strings for untouched text boxes, nulls for every
optional line field. These tests post exactly that, so a change that only works when
the client sends a fully-populated line fails here rather than in the warehouse.
"""
import pytest
from sqlalchemy import select

from app.modules.warehouse.enums import RECEIPT_CREATE, RECEIPT_VIEW
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse

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
