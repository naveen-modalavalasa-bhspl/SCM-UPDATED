"""The Warehouse -> Vendor purchase return, end to end over the API.

The flow a storekeeper walks: open the return (PRET...) -> the GRN behind it -> the PO
and the vendor's invoice -> the items with what is still available -> the vendor's own
record -> edit and save the draft -> Send to Vendor -> the status flips once, never twice.

Every number on those screens is READ off documents that already exist; nothing here
seeds a vendor onto a return by hand, which is the whole point - the vendor is whichever
vendor the source transaction names and no request may change it.

The regression these cover is the cap: `_apply_return_lines` used to allow back only a
GRN line's `rejected_qty`, while the three read paths offered `received_qty` where QC had
rejected nothing. So a receipt QC had PASSED showed ten units available and then refused
the save with "cannot exceed the available returnable quantity of 0" - the flow was
unusable on most receipts. `_grn_line_returnable` is now the one definition all four read.
"""
from datetime import date

import pytest
from sqlalchemy import select

from app.modules.indents.models import Indent
from app.modules.procurement.models import PurchaseOrder
from app.modules.warehouse.enums import RETURN_CREATE, RETURN_VIEW, ReceiptStatus
from app.modules.warehouse.models import (
    Dispatch, PurchaseReturn, PurchaseReturnItem, Receipt, ReceiptItem,
)
from app.shared.enums import IndentStatus, POStatus
from app.shared.models.master import Item, Vendor
from app.shared.models.warehouse import Warehouse

pytestmark = pytest.mark.asyncio


async def _chain(db, *, received=10, rejected=0, rate=100):
    """A vendor, a warehouse, an item and the GRN that ties them together.

    Returned as plain ids, not ORM rows: a test that rolls its session back to see what
    the API committed would otherwise trip over an expired attribute doing IO.

    `rejected=0` in the default case on purpose - a receipt whose lines QC accepted is
    the ordinary case, and the one the cap used to refuse.
    """
    vendor = Vendor(
        code="VEN-001", name="Kirloskar Electric", vendor_type="MATERIAL",
        contact_person="R. Iyer", phone="9000000001", email="sales@kirloskar.example",
        address="Plot 14, Peenya Industrial Area", city="Bengaluru", state="Karnataka",
        pincode="560058", gstin="29AABCK1234M1Z5", is_active=True,
    )
    wh = Warehouse(code="WH1", name="Main store", warehouse_type="MAIN",
                   is_bin_managed=False, is_active=True)
    item = Item(code="ELE-GEN-0001", name="Copper cable 4 sqmm", uom_code="MTR",
                is_active=True)
    db.add_all([vendor, wh, item])
    await db.flush()

    # A real indent and purchase order. Both matter: the vendor on a receipt frequently
    # lives only on its PO (`_receipt_vendor`) and so does the indent (`_receipt_indent`),
    # and a test that invents dangling ids cannot show either.
    indent = Indent(indent_no="IND/2026-27/00021", indent_date=date(2026, 8, 10),
                    status=IndentStatus.ORDERED.value)
    db.add(indent)
    await db.flush()
    po = PurchaseOrder(
        po_no="PO0001", po_date=date(2026, 8, 20), vendor_id=vendor.id,
        vendor_name=vendor.name, status=POStatus.RECEIVED.value,
        indent_id=indent.id, indent_no=indent.indent_no,
    )
    db.add(po)
    await db.flush()

    receipt = Receipt(
        grn_no="GRN0001", receipt_type="PURCHASE", grn_date=date(2026, 9, 1),
        po_id=po.id, po_no=po.po_no,
        vendor_id=vendor.id, vendor_name=vendor.name,
        warehouse_id=wh.id, warehouse_name=wh.name,
        invoice_no="INV-77/2026", invoice_date=date(2026, 8, 30),
        status=ReceiptStatus.QC_PASSED.value,
    )
    db.add(receipt)
    await db.flush()
    line = ReceiptItem(
        receipt_id=receipt.id, line_no=1,
        indent_id=99, indent_no="IND0001",
        item_id=item.id, item_code=item.code, item_name=item.name, uom_code="MTR",
        ordered_qty=received, received_qty=received, accepted_qty=received - rejected,
        rejected_qty=rejected, rate=rate, amount=received * rate,
    )
    db.add(line)
    await db.commit()
    return {
        "vendor_id": vendor.id, "warehouse_id": wh.id, "item_id": item.id,
        "grn_id": receipt.id, "grn_item_id": line.id,
        "vendor_name": vendor.name, "warehouse_name": wh.name,
        "item_code": item.code, "item_name": item.name, "grn_no": receipt.grn_no,
        "po_id": po.id, "po_no": po.po_no,
    }


async def test_purchase_return_auto_fetches_the_whole_chain_and_sends_once(
        db, client, make_user, login):
    src = await _chain(db)
    await make_user(username="store", permissions=[RETURN_VIEW, RETURN_CREATE])
    headers = await login("store", "pw")

    # --- the source auto-fetch: GRN -> PO/invoice -> item -> vendor, one call ---
    r = await client.get("/api/warehouse/returns/source-detail",
                         params={"source_type": "GRN", "source_id": src["grn_id"]},
                         headers=headers)
    assert r.status_code == 200, r.text
    fetched = r.json()
    assert fetched["purchase"]["grn_no"] == "GRN0001"
    assert fetched["purchase"]["po_no"] == "PO0001"
    assert fetched["purchase"]["invoice_no"] == "INV-77/2026"
    assert fetched["purchase"]["indent_no"] == "IND0001"
    # The vendor is read whole off mst_vendors, never typed onto the return.
    assert fetched["vendor"]["vendor_id"] == src["vendor_id"]
    assert fetched["vendor"]["vendor_code"] == "VEN-001"
    assert fetched["vendor"]["contact_person"] == "R. Iyer"
    assert fetched["vendor"]["gstin"] == "29AABCK1234M1Z5"
    assert fetched["vendor"]["city"] == "Bengaluru"
    offered = fetched["items"][0]
    assert offered["item_code"] == "ELE-GEN-0001"
    assert offered["item_name"] == "Copper cable 4 sqmm"
    assert float(offered["returnable_qty"]) == 10          # QC rejected nothing
    assert float(offered["previously_returned"]) == 0
    assert float(offered["unit_price"]) == 100

    # --- save the draft, at a quantity the screen just offered ---
    draft = await client.post("/api/warehouse/returns", json={
        "return_date": "2026-09-10",
        "grn_id": src["grn_id"],
        "vendor_id": src["vendor_id"],
        "warehouse_id": src["warehouse_id"],
        "reason": "DAMAGED",
        "remarks": "Two drums crushed in transit",
        "items": [{
            "item_id": src["item_id"], "grn_item_id": src["grn_item_id"],
            "quantity": 4, "rate": 100, "reason": "DAMAGED",
        }],
    }, headers=headers)
    assert draft.status_code == 201, draft.text
    saved = draft.json()
    return_id = saved["id"]
    assert saved["status"] == "DRAFT"
    assert saved["return_no"]

    # --- opening it: the whole chain again, off the document itself ---
    r = await client.get(f"/api/warehouse/returns/{return_id}", headers=headers)
    assert r.status_code == 200, r.text
    doc = r.json()
    assert doc["grn_no"] == "GRN0001"
    assert doc["grn_date"] == "2026-09-01"
    assert doc["po_no"] == "PO0001"
    assert doc["invoice_no"] == "INV-77/2026"
    assert doc["invoice_date"] == "2026-08-30"
    assert doc["indent_no"] == "IND0001"
    assert doc["vendor_id"] == src["vendor_id"]
    assert doc["vendor_code"] == "VEN-001"
    assert doc["vendor_phone"] == "9000000001"
    assert doc["vendor_gstin"] == "29AABCK1234M1Z5"
    assert doc["reason_code"] == "DAMAGED"
    assert doc["reason_label"] == "Damaged"
    assert doc["remarks"] == "Two drums crushed in transit"
    assert doc["can_send_to_vendor"] is True
    assert doc["sent_at"] is None
    row = doc["items"][0]
    assert row["item_name"] == "Copper cable 4 sqmm"
    assert float(row["original_qty"]) == 10
    assert float(row["returnable_qty"]) == 10
    assert float(row["quantity"]) == 4
    assert float(row["rate"]) == 100
    assert float(row["amount"]) == 400

    # --- edit: over the available quantity is refused, against the served number ---
    over = await client.put(f"/api/warehouse/returns/{return_id}", json={
        "return_date": "2026-09-10",
        "grn_id": src["grn_id"], "vendor_id": src["vendor_id"],
        "warehouse_id": src["warehouse_id"],
        "reason": "DAMAGED", "remarks": "Two drums crushed in transit",
        "items": [{"item_id": src["item_id"], "grn_item_id": src["grn_item_id"],
                   "quantity": 11, "rate": 100}],
    }, headers=headers)
    assert over.status_code == 422, over.text
    assert "exceed" in over.json()["error"].lower()

    # --- edit: within it is saved, and the relationships are preserved ---
    ok = await client.put(f"/api/warehouse/returns/{return_id}", json={
        "return_date": "2026-09-10",
        "grn_id": src["grn_id"], "vendor_id": src["vendor_id"],
        "warehouse_id": src["warehouse_id"],
        "reason": "DEFECTIVE", "remarks": "Six drums off spec",
        "items": [{"item_id": src["item_id"], "grn_item_id": src["grn_item_id"],
                   "quantity": 6, "rate": 100}],
    }, headers=headers)
    assert ok.status_code == 200, ok.text
    edited = ok.json()
    assert float(edited["total_qty"]) == 6
    assert edited["vendor_id"] == src["vendor_id"]         # unchanged by the edit
    assert edited["grn_id"] == src["grn_id"]
    assert edited["items"][0]["grn_item_id"] == src["grn_item_id"]
    assert edited["reason_code"] == "DEFECTIVE"

    # --- send to vendor: one flip, one logistics leg ---
    sent = await client.post(f"/api/warehouse/returns/{return_id}/send-to-vendor", json={
        "return_reason": "DEFECTIVE",
        "remarks": "Six drums off spec",
        "items": [{"item_id": src["item_id"], "grn_item_id": src["grn_item_id"],
                   "quantity": 6, "rate": 100}],
        "grn_id": src["grn_id"], "vendor_id": src["vendor_id"],
        "warehouse_id": src["warehouse_id"],
    }, headers=headers)
    assert sent.status_code == 200, sent.text
    body = sent.json()
    assert body["status"] == "SENT_TO_VENDOR"
    assert body["sent_at"]
    assert body["can_send_to_vendor"] is False
    # THE SEND IS PAPERWORK, and nothing physical happens on it (2026-09-12). It used to
    # raise the consignment and a logistics leg in the same press, so the vendor was asked
    # to approve goods already standing on their dock. The goods now move at
    # `arrange_return_transport`, once the vendor has approved AND asked for a
    # replacement â€” which is where the consignment assertions moved to.
    assert body["dispatch_no"] is None
    # It IS the moment the QC that condemned the goods is bound to the document, beside
    # the GRN, the PO and the vendor.
    assert body["grn_id"] == src["grn_id"]

    # MySQL reads REPEATABLE READ, and this session's transaction opened before the
    # requests above ran (`make_user` ends on a read), so its snapshot predates the send.
    # Ending it is what lets the row the API just committed be seen at all.
    await db.rollback()
    leg = await db.scalar(select(Dispatch).where(Dispatch.ref_type == "PURCHASE_RETURN",
                                                 Dispatch.ref_id == return_id))
    assert leg is None, "the send must not put goods on a vehicle"

    # --- re-reading it offers no second send, and the vendor now owes the decision ---
    r = await client.get(f"/api/warehouse/returns/{return_id}", headers=headers)
    assert r.status_code == 200, r.text
    reread = r.json()
    assert reread["status"] == "SENT_TO_VENDOR"
    assert reread["can_send_to_vendor"] is False
    assert reread["awaiting_vendor_decision"] is True
    # Our desk cannot answer for them, and cannot arrange transport for a replacement
    # nobody has agreed to yet.
    assert reread["can_arrange_transport"] is False

    # --- and sending twice is refused ---
    again = await client.post(f"/api/warehouse/returns/{return_id}/send-to-vendor", json={
        "return_reason": "DEFECTIVE",
        "items": [{"item_id": src["item_id"], "grn_item_id": src["grn_item_id"],
                   "quantity": 6}],
    }, headers=headers)
    assert again.status_code == 422, again.text
    assert "already been sent" in again.json()["error"].lower()


async def test_a_qc_rejected_line_still_caps_at_what_was_rejected(
        db, client, make_user, login):
    """Widening the cap must not widen it past a rejection.

    Where QC DID reject something, that quantity - not the received one - is what may go
    back, because the rest of the delivery was accepted onto our own shelf.
    """
    src = await _chain(db, received=10, rejected=3)
    await make_user(username="store", permissions=[RETURN_VIEW, RETURN_CREATE])
    headers = await login("store", "pw")

    r = await client.get("/api/warehouse/returns/source-detail",
                         params={"source_type": "GRN", "source_id": src["grn_id"]},
                         headers=headers)
    assert r.status_code == 200, r.text
    assert float(r.json()["items"][0]["returnable_qty"]) == 3

    over = await client.post("/api/warehouse/returns", json={
        "return_date": "2026-09-10",
        "grn_id": src["grn_id"], "vendor_id": src["vendor_id"],
        "warehouse_id": src["warehouse_id"], "reason": "QUALITY_ISSUE",
        "items": [{"item_id": src["item_id"], "grn_item_id": src["grn_item_id"],
                   "quantity": 4}],
    }, headers=headers)
    assert over.status_code == 422, over.text

    ok = await client.post("/api/warehouse/returns", json={
        "return_date": "2026-09-10",
        "grn_id": src["grn_id"], "vendor_id": src["vendor_id"],
        "warehouse_id": src["warehouse_id"], "reason": "QUALITY_ISSUE",
        "items": [{"item_id": src["item_id"], "grn_item_id": src["grn_item_id"],
                   "quantity": 3}],
    }, headers=headers)
    assert ok.status_code == 201, ok.text
    assert float(ok.json()["total_qty"]) == 3


async def test_an_automatically_raised_return_reads_its_availability_off_the_grn(
        db, client, make_user, login):
    """The returns module raises `pro_returns` drafts with no `grn_item_id` on the line
    and the reason as PROSE - it knows the item and the quantity that went on the truck,
    not which GRN line it came off, and the reason was written by the field.

    Both used to strand the document on this screen: availability was reported as the
    line's own quantity (so the screen could offer what the save would refuse), and the
    stored reason is not one of the served codes, which is why `reason_code` is served
    null and the review screen asks for one instead of posting prose the send refuses.
    """
    src = await _chain(db, received=10, rejected=0)
    doc = PurchaseReturn(
        return_no="PRET0001", return_date=date(2026, 9, 10),
        po_id=src["po_id"], po_no=src["po_no"],
        grn_id=src["grn_id"], grn_no=src["grn_no"],
        vendor_id=src["vendor_id"], vendor_name=src["vendor_name"],
        warehouse_id=src["warehouse_id"], warehouse_name=src["warehouse_name"],
        reason="Damaged in transit",          # prose, not one of the served codes
        status="DRAFT", total_items=1, total_qty=2, total_value=200,
    )
    doc.items.append(PurchaseReturnItem(
        line_no=1, item_id=src["item_id"], item_code=src["item_code"],
        item_name=src["item_name"], uom_code="MTR", quantity=2, rate=100, amount=200,
        reason="Damaged in transit",
    ))
    db.add(doc)
    await db.commit()
    return_id = doc.id

    await make_user(username="store", permissions=[RETURN_VIEW, RETURN_CREATE])
    headers = await login("store", "pw")

    r = await client.get(f"/api/warehouse/returns/{return_id}", headers=headers)
    assert r.status_code == 200, r.text
    read = r.json()
    assert read["return_no"] == "PRET0001"
    assert read["grn_no"] == "GRN0001"
    assert read["invoice_no"] == "INV-77/2026"
    assert read["vendor_code"] == "VEN-001"
    assert read["reason_code"] is None                  # prose - the screen must ask
    assert read["reason_label"] == "Damaged in transit"
    assert read["can_send_to_vendor"] is True
    row = read["items"][0]
    assert row["grn_item_id"] is None
    # Read off the GRN's own line for this item, not off the return's own quantity.
    assert float(row["original_qty"]) == 10
    assert float(row["returnable_qty"]) == 10

    # And the send goes through with a reason code the storekeeper picks.
    sent = await client.post(f"/api/warehouse/returns/{return_id}/send-to-vendor", json={
        "return_reason": "DAMAGED",
        "remarks": "Damaged in transit",
        "items": [{"item_id": src["item_id"], "quantity": 2, "rate": 100}],
    }, headers=headers)
    assert sent.status_code == 200, sent.text
    assert sent.json()["status"] == "SENT_TO_VENDOR"


async def test_a_return_raised_with_no_purchase_reads_the_chain_behind_its_stock(
        db, client, make_user, login):
    """The live case: `pro_returns` rows with grn_id, po_id AND vendor_id all null.

    The returns module resolves the chain at gate-out by asking whether a PO was raised
    against the INDENT the field return names. Where the branch was served out of stock
    bought on some other indent's order - the ordinary case - that finds nothing and the
    document is saved with the whole chain null. The screen then showed an empty header
    and an empty vendor block, which is what "details not fetched" looks like.

    The GRN behind the stock is read instead, and its vendor comes through the PO because
    a receipt taken at the barrier frequently carries no vendor of its own. None of it is
    written until the send, which posts it back and binds it.
    """
    src = await _chain(db, received=20, rejected=0)
    # The live shape: the receipt names neither the vendor nor the indent, and its lines
    # carry no indent link either. Only the purchase order behind it knows both.
    await db.execute(
        Receipt.__table__.update()
        .where(Receipt.__table__.c.id == src["grn_id"])
        .values(vendor_id=None, vendor_name=None))
    await db.execute(
        ReceiptItem.__table__.update()
        .where(ReceiptItem.__table__.c.receipt_id == src["grn_id"])
        .values(indent_id=None, indent_no=None))
    po_vendor_id = src["vendor_id"]
    doc = PurchaseReturn(
        return_no="PRET0002", return_date=date(2026, 9, 10),
        warehouse_id=src["warehouse_id"], warehouse_name=src["warehouse_name"],
        reason="Damaged (in transit or in store)",
        status="DRAFT", total_items=1, total_qty=1, total_value=520,
    )
    doc.items.append(PurchaseReturnItem(
        line_no=1, item_id=src["item_id"], item_code=src["item_code"],
        item_name=src["item_name"], uom_code="KIT", quantity=1, rate=520, amount=520,
    ))
    db.add(doc)
    await db.commit()
    return_id = doc.id

    await make_user(username="store", permissions=[RETURN_VIEW, RETURN_CREATE])
    headers = await login("store", "pw")

    r = await client.get(f"/api/warehouse/returns/{return_id}", headers=headers)
    assert r.status_code == 200, r.text
    read = r.json()
    # Nothing stored...
    assert read["grn_id"] is None
    assert read["po_id"] is None
    assert read["vendor_id"] is None
    # ...and the chain read behind the stock, kept separate and announced.
    assert read["chain_traced"] is True
    assert read["chain_note"]
    assert read["traced_grn_no"] == "GRN0001"
    assert read["traced_po_no"] == "PO0001"
    assert read["traced_vendor_id"] == po_vendor_id     # through the PO, not the GRN
    assert read["traced_vendor_name"] == "Kirloskar Electric"
    assert read["vendor_code"] == "VEN-001"             # full master record, as ever
    assert read["vendor_gstin"] == "29AABCK1234M1Z5"
    assert read["invoice_no"] == "INV-77/2026"
    # Off the PO, since neither the receipt nor its lines name the request.
    assert read["indent_no"] == "IND/2026-27/00021"
    assert read["can_send_to_vendor"] is True
    # Availability is measured against the traced GRN, not the return's own quantity.
    assert float(read["items"][0]["original_qty"]) == 20
    assert float(read["items"][0]["returnable_qty"]) == 20

    # A plain re-read must not have persisted any of it - traced is evidence, not a bind.
    await db.rollback()
    still = await db.get(PurchaseReturn, return_id)
    assert still.grn_id is None and still.po_id is None and still.vendor_id is None

    # Sending posts the traced chain back, which is what binds it.
    sent = await client.post(f"/api/warehouse/returns/{return_id}/send-to-vendor", json={
        "return_reason": "DAMAGED",
        "items": [{"item_id": src["item_id"], "quantity": 1, "rate": 520}],
        "grn_id": read["traced_grn_id"], "po_id": read["traced_po_id"],
        "vendor_id": read["traced_vendor_id"],
    }, headers=headers)
    assert sent.status_code == 200, sent.text
    body = sent.json()
    assert body["status"] == "SENT_TO_VENDOR"
    assert body["vendor_id"] == po_vendor_id
    assert body["grn_no"] == "GRN0001"
    # No consignment on the send any more â€” the goods travel at the transport decision.
    assert body["dispatch_no"] is None

    await db.rollback()
    bound = await db.get(PurchaseReturn, return_id)
    assert bound.grn_id == src["grn_id"]
    assert bound.vendor_id == po_vendor_id
    assert bound.vendor_name == "Kirloskar Electric"


async def test_the_registers_show_the_traced_chain_not_just_the_return_number(
        db, client, make_user, login):
    """Both purchase-return registers, not only the review screen.

    The lists never decorated, so a row storing no GRN, PO or vendor rendered as its
    PRET number beside three empty columns â€” the same blank the detail screen had.
    Traced for the whole page at once (`trace_purchase_sources`) and marked as traced.
    """
    src = await _chain(db, received=20, rejected=0)
    doc = PurchaseReturn(
        return_no="PRET0003", return_date=date(2026, 9, 10),
        warehouse_id=src["warehouse_id"], warehouse_name=src["warehouse_name"],
        reason="Damaged (in transit or in store)",
        status="DRAFT", total_items=1, total_qty=1, total_value=520,
    )
    doc.items.append(PurchaseReturnItem(
        line_no=1, item_id=src["item_id"], item_code=src["item_code"],
        item_name=src["item_name"], uom_code="KIT", quantity=1, rate=520, amount=520,
    ))
    db.add(doc)
    await db.commit()
    return_id = doc.id       # held as an int: the rollback below expires the instance

    await make_user(username="store", permissions=[RETURN_VIEW, RETURN_CREATE])
    headers = await login("store", "pw")

    # The warehouse register, which serves the traced fields beside the stored ones.
    r = await client.get("/api/warehouse/returns", params={"status": "DRAFT"},
                         headers=headers)
    assert r.status_code == 200, r.text
    row = next(x for x in r.json()["items"] if x["return_no"] == "PRET0003")
    assert row["grn_no"] is None                       # nothing stored, as raised
    assert row["chain_traced"] is True
    assert row["traced_grn_no"] == "GRN0001"
    assert row["traced_po_no"] == "PO0001"
    assert row["traced_vendor_name"] == "Kirloskar Electric"

    # The returns register, which folds them into the columns and flags the row.
    r = await client.get("/api/returns/purchase", headers=headers)
    assert r.status_code == 200, r.text
    row = next(x for x in r.json()["items"] if x["return_no"] == "PRET0003")
    assert row["grn_no"] == "GRN0001"
    assert row["po_no"] == "PO0001"
    assert row["vendor_name"] == "Kirloskar Electric"
    assert row["chain_traced"] is True

    # And a listing must not have written any of it onto the document.
    await db.rollback()
    still = await db.get(PurchaseReturn, return_id)
    assert still.grn_id is None and still.po_id is None and still.vendor_id is None


async def _sent(db, client, headers, src, *, qty=5, rate=100) -> int:
    """A return raised and sent to the vendor â€” the state every press below starts from.

    Its own helper because the vendor-led flow has six rungs and a test of the fifth
    should not be forty lines of getting to it.
    """
    draft = await client.post("/api/warehouse/returns", json={
        "return_date": "2026-09-10",
        "grn_id": src["grn_id"], "vendor_id": src["vendor_id"],
        "warehouse_id": src["warehouse_id"], "reason": "DAMAGED",
        "items": [{"item_id": src["item_id"], "grn_item_id": src["grn_item_id"],
                   "quantity": qty, "rate": rate, "reason": "DAMAGED"}],
    }, headers=headers)
    assert draft.status_code == 201, draft.text
    return_id = draft.json()["id"]
    sent = await client.post(f"/api/warehouse/returns/{return_id}/send-to-vendor", json={
        "return_reason": "DAMAGED",
        "items": [{"item_id": src["item_id"], "grn_item_id": src["grn_item_id"],
                   "quantity": qty, "rate": rate}],
        "grn_id": src["grn_id"], "vendor_id": src["vendor_id"],
        "warehouse_id": src["warehouse_id"],
    }, headers=headers)
    assert sent.status_code == 200, sent.text
    return return_id


async def test_the_vendor_decides_and_a_rejection_must_say_why(
        db, client, make_user, login):
    """Approve/Reject belongs to the VENDOR, on their own portal, and a refusal explains.

    It used to be our own desk pressing these (`/decide-approve`), answering for a
    supplier who was already holding the goods. Nothing travels until the vendor has
    answered now, so a rejection costs a conversation rather than a wasted lorry.

    The reason is demanded on a rejection and not on an approval: the storekeeper who
    raised the return has to argue the refusal, and an unexplained one is useless to them.
    An approval's reason is the reason it was raised.
    """
    src = await _chain(db)
    await make_user(username="store5", permissions=[RETURN_VIEW, RETURN_CREATE])
    headers = await login("store5", "pw")
    portal = await _portal(db, src["vendor_id"], "kirloskar5")
    return_id = await _sent(db, client, headers, src)

    # A refusal with nothing said is refused, and the document does not move.
    bad = await client.post(f"/api/supplier/returns/{return_id}/decide",
                            json={"action": "REJECTED"}, headers=portal)
    assert bad.status_code == 422, bad.text
    assert "why" in bad.json()["error"].lower()
    await db.rollback()
    assert (await db.get(PurchaseReturn, return_id)).status == "SENT_TO_VENDOR"

    ok = await client.post(f"/api/supplier/returns/{return_id}/decide",
                           json={"action": "APPROVED", "remarks": "Agreed, send them"},
                           headers=portal)
    assert ok.status_code == 200, ok.text
    assert ok.json()["status"] == "VENDOR_APPROVED"

    # Answered once. The rung has moved, which is what refuses the second press â€” there
    # is no separate "already done" flag to keep in step with anything.
    again = await client.post(f"/api/supplier/returns/{return_id}/decide",
                              json={"action": "REJECTED", "remarks": "changed my mind"},
                              headers=portal)
    assert again.status_code == 422, again.text
    assert "twice" in again.json()["error"].lower()

    await db.rollback()
    doc = await db.get(PurchaseReturn, return_id)
    assert doc.status == "VENDOR_APPROVED"
    assert doc.vendor_decision == "APPROVED"
    # Recorded against the VENDOR, not an employee: `vendor_decision_by_id` is a soft fk
    # to `hcm_employees` and there is nobody of ours behind this press.
    assert doc.vendor_decision_by_name == src["vendor_name"]
    assert doc.vendor_decision_by_id is None


async def test_a_rejection_by_the_vendor_is_terminal_and_moves_nothing(
        db, client, make_user, login):
    """A refused return raises no consignment and offers our desk nothing to arrange."""
    src = await _chain(db)
    await make_user(username="store6", permissions=[RETURN_VIEW, RETURN_CREATE])
    headers = await login("store6", "pw")
    portal = await _portal(db, src["vendor_id"], "kirloskar6")
    return_id = await _sent(db, client, headers, src)

    r = await client.post(f"/api/supplier/returns/{return_id}/decide",
                          json={"action": "REJECTED",
                                "remarks": "Outside the warranty window"},
                          headers=portal)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "REJECTED"

    await db.rollback()
    assert await db.scalar(select(Dispatch).where(
        Dispatch.ref_type == "PURCHASE_RETURN", Dispatch.ref_id == return_id)) is None

    read = await client.get(f"/api/warehouse/returns/{return_id}", headers=headers)
    assert read.status_code == 200, read.text
    body = read.json()
    assert body["can_arrange_transport"] is False
    assert body["awaiting_vendor_settlement"] is False
    # The tracker says it stopped rather than drawing the rest as still owed.
    dossier = await client.get(f"/api/warehouse/returns/{return_id}/dossier",
                               headers=headers)
    assert dossier.status_code == 200, dossier.text
    legs = {leg["key"]: leg for leg in dossier.json()["journey"]}
    assert legs["vendor_decision"]["state"] == "rejected"
    # The travelling legs say they will NEVER happen rather than sitting at `pending`,
    # which a reader would take as work somebody still owes.
    assert legs["transport"]["state"] == "cancelled"
    assert "nothing travels" in legs["transport"]["detail"].lower()
    assert legs["warehouse_received"]["state"] == "cancelled"
    # And nothing after the refusal is drawn as the document's current position.
    assert not any(leg["state"] == "current" for leg in legs.values())


async def test_a_refund_settles_the_return_and_nothing_travels(
        db, client, make_user, login):
    """Refund is terminal: no consignment, no leg, no receipt â€” and it is capped.

    The cap is checked against the row rather than trusted from the request, because a
    refund is the one number on this document a counterparty supplies.
    """
    src = await _chain(db)
    await make_user(username="store7", permissions=[RETURN_VIEW, RETURN_CREATE])
    headers = await login("store7", "pw")
    portal = await _portal(db, src["vendor_id"], "kirloskar7")
    return_id = await _sent(db, client, headers, src, qty=5, rate=100)  # 500 of goods

    await client.post(f"/api/supplier/returns/{return_id}/decide",
                      json={"action": "APPROVED"}, headers=portal)

    over = await client.post(f"/api/supplier/returns/{return_id}/settle",
                             json={"settlement": "REFUNDED", "refund_amount": 501},
                             headers=portal)
    assert over.status_code == 422, over.text
    assert "more than" in over.json()["error"].lower()

    # A refund with no figure on it is the half-answer this press exists to eliminate.
    empty = await client.post(f"/api/supplier/returns/{return_id}/settle",
                              json={"settlement": "REFUNDED"}, headers=portal)
    assert empty.status_code == 422, empty.text

    ok = await client.post(f"/api/supplier/returns/{return_id}/settle",
                           json={"settlement": "REFUNDED", "refund_amount": 450,
                                 "remarks": "Freight deducted"},
                           headers=portal)
    assert ok.status_code == 200, ok.text

    await db.rollback()
    doc = await db.get(PurchaseReturn, return_id)
    assert doc.status == "REFUNDED"
    assert float(doc.vendor_refund_amount) == 450
    assert await db.scalar(select(Dispatch).where(
        Dispatch.ref_type == "PURCHASE_RETURN", Dispatch.ref_id == return_id)) is None

    read = await client.get(f"/api/warehouse/returns/{return_id}", headers=headers)
    assert read.json()["can_arrange_transport"] is False, \
        "a refunded return must never be asked whose vehicle is coming"

    # The travelling legs say they will never happen rather than sitting at pending as
    # though somebody still owed them.
    dossier = await client.get(f"/api/warehouse/returns/{return_id}/dossier",
                               headers=headers)
    legs = {leg["key"]: leg for leg in dossier.json()["journey"]}
    assert legs["settlement"]["state"] == "completed"
    assert legs["transport"]["state"] == "cancelled"
    assert "nothing travels" in legs["transport"]["detail"].lower()


async def test_a_warehouse_arranged_replacement_raises_the_logistics_return_leg(
        db, client, make_user, login):
    """WAREHOUSE_REQUESTS: the goods go out on OUR leg, warehouse -> vendor.

    The Logistics Return Leg the business asks for. It is an ordinary transport request
    on the board logistics already works â€” `source_type=RETURN`, DRAFT, on the Dispatch
    page's second queue â€” so there is no new table, no new status and no screen to build.

    `source_id` must stay NULL: the returns module resolves that column against `inv_sto`,
    and a `pro_returns` id there would eventually name somebody else's field return.
    """
    from app.modules.logistics.models import TransportRequest

    src = await _chain(db)
    await make_user(username="store8",
                    permissions=[RETURN_VIEW, RETURN_CREATE, "return.approve"])
    headers = await login("store8", "pw")
    portal = await _portal(db, src["vendor_id"], "kirloskar8")
    return_id = await _sent(db, client, headers, src, qty=4)

    await client.post(f"/api/supplier/returns/{return_id}/decide",
                      json={"action": "APPROVED"}, headers=portal)
    settled = await client.post(f"/api/supplier/returns/{return_id}/settle",
                                json={"settlement": "REPLACED"}, headers=portal)
    assert settled.status_code == 200, settled.text
    # The document now stands on OUR desk, and says so.
    assert settled.json()["status"] == "REPLACEMENT_AGREED"
    read = await client.get(f"/api/warehouse/returns/{return_id}", headers=headers)
    assert read.json()["can_arrange_transport"] is True

    r = await client.post(f"/api/warehouse/returns/{return_id}/transport", json={
        "arrangement": "WAREHOUSE_REQUESTS",
        "pickup_address": "Dock 2, Main store",
        "ready_date": "2026-09-15",
    }, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "VEHICLE_REQUESTED"

    await db.rollback()
    # The consignment â€” the warehouse's own outward document, raised HERE and not at the
    # send, because this is when the goods actually leave.
    leg = await db.scalar(select(Dispatch).where(Dispatch.ref_type == "PURCHASE_RETURN",
                                                 Dispatch.ref_id == return_id))
    assert leg is not None
    assert leg.vendor_id == src["vendor_id"]
    assert float(leg.total_qty) == 4

    doc = await db.get(PurchaseReturn, return_id)
    tr = await db.scalar(select(TransportRequest).where(
        TransportRequest.id == doc.outbound_tr_id))
    assert tr is not None, "a warehouse-arranged replacement owes Logistics a leg"
    assert tr.status == "DRAFT"
    assert tr.source_type == "RETURN"
    assert tr.source_id is None, "a pro_returns id here would name a field return"
    assert tr.source_no == doc.return_no
    # Which way round the ends go: out of OUR warehouse, to the vendor.
    assert tr.from_warehouse_id == src["warehouse_id"]
    assert tr.to_location_name == src["vendor_name"]
    assert doc.outbound_tr_no == tr.tr_no


async def test_a_vendor_arranged_replacement_runs_to_the_end_without_logistics(
        db, client, make_user, login):
    """VENDOR_ARRANGES, walked to the finish: no logistics leg, and every rung recorded.

    The whole of branch A â€” the vendor accepts the collection, their vehicle loads at our
    gate, they sign for the goods at their dock, they dispatch the replacement with its
    batch and expiry, and we sign it in.

    Two things are asserted beyond the rungs: no transport request is EVER raised on this
    branch, and the replacement dispatch note raises the inbound receipt the store will
    book the goods against.
    """
    from app.modules.logistics.models import TransportRequest

    src = await _chain(db)
    # `receipt.*` as well as the return codes: this walk ends by BOOKING THE REPLACEMENT
    # IN on the inbound receipt, which is a storekeeper's ordinary GRN press and is what
    # closes the return now that the screen carries no receive button of its own.
    await make_user(username="store9",
                    permissions=[RETURN_VIEW, RETURN_CREATE, "return.approve",
                                 "receipt.view", "receipt.create"])
    headers = await login("store9", "pw")
    portal = await _portal(db, src["vendor_id"], "kirloskar9")
    return_id = await _sent(db, client, headers, src, qty=3)

    await client.post(f"/api/supplier/returns/{return_id}/decide",
                      json={"action": "APPROVED"}, headers=portal)
    await client.post(f"/api/supplier/returns/{return_id}/settle",
                      json={"settlement": "REPLACED"}, headers=portal)

    r = await client.post(f"/api/warehouse/returns/{return_id}/transport",
                          json={"arrangement": "VENDOR_ARRANGES"}, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "AWAITING_VENDOR_VEHICLE"

    r = await client.post(f"/api/supplier/returns/{return_id}/accept-transport",
                          json={"vehicle_no": "KA01AB1234", "driver_name": "M. Rao"},
                          headers=portal)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "VENDOR_TRANSPORT_ACCEPTED"

    r = await client.post(f"/api/supplier/returns/{return_id}/pickup",
                          json={"vehicle_no": "KA01AB1234"}, headers=portal)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "STOCK_PICKED_UP"

    r = await client.post(f"/api/supplier/returns/{return_id}/confirm-receipt",
                          json={"received_by_name": "Gate 1, Kirloskar"}, headers=portal)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "VENDOR_RECEIVED"

    r = await client.post(f"/api/supplier/returns/{return_id}/dispatch-replacement",
                          json={"dispatch_no": "VDN-4471",
                                "dispatch_date": "2026-09-20",
                                "expected_date": "2026-09-23",
                                "transporter_name": "VRL",
                                "lines": [{"line_no": 1, "batch_no": "B-NEW-01"}]},
                          headers=portal)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "REPLACEMENT_DISPATCHED"

    # THE RECEIPT CLOSES IT, not a button on the return. The warehouse's own screen no
    # longer carries a "Received at the warehouse" press: the store books the replacement
    # in the ordinary way, on the inbound receipt the dispatch note raised, and submitting
    # that receipt is what brings the return home. Two documents for one lorry was how a
    # replacement got received, inspected and put away with the return still reading
    # "Replacement dispatched".
    #
    # THIS warehouse keeps no bins and this item needs no QC, so the submit finishes the
    # receipt outright — there is no inspection to run and nothing to put away — and the
    # return therefore closes in the same press. The QC-and-putaway tail is walked in
    # `test_the_replacement_closes_the_return_only_once_qc_and_putaway_are_done`.
    await db.rollback()
    doc = await db.get(PurchaseReturn, return_id)
    assert doc.status == "REPLACEMENT_DISPATCHED"
    assert doc.vendor_followup_receipt_id, "the dispatch note must raise the receipt"

    submitted = await client.post(
        f"/api/warehouse/receipts/{doc.vendor_followup_receipt_id}/submit",
        headers=headers)
    assert submitted.status_code == 200, submitted.text

    await db.rollback()
    doc = await db.get(PurchaseReturn, return_id)
    # NO LOGISTICS LEG ON THIS BRANCH â€” the business rule this test exists for.
    assert doc.outbound_tr_id is None
    assert await db.scalar(select(TransportRequest).where(
        TransportRequest.source_no == doc.return_no)) is None
    # But the consignment still exists, because the goods still left the building.
    assert await db.scalar(select(Dispatch).where(
        Dispatch.ref_type == "PURCHASE_RETURN", Dispatch.ref_id == return_id)) is not None
    # Every rung stamped, with who and when.
    assert doc.vendor_transport_accepted_at is not None
    assert doc.arranged_dispatched_at is not None
    assert doc.vendor_receipt_confirmed_at is not None
    assert doc.replacement_dispatched_at is not None
    assert doc.replacement_dispatch_no == "VDN-4471"
    # Brought home by the receipt, with the GRN named on the return so a reader can see
    # which document closed it — and closed by that same receipt finishing.
    assert doc.status == "COMPLETED"
    assert doc.received_at is not None
    assert doc.vendor_followup_receipt_no in (doc.received_remarks or "")
    # EVERY ORIGINAL REFERENCE SURVIVES THE CLOSE. The close writes one column; the chain
    # the return was raised off is what a dispute is argued from.
    assert doc.grn_no == "GRN0001"
    assert doc.po_no == "PO0001"
    assert doc.vendor_id == src["vendor_id"]
    assert doc.vendor_followup_receipt_id
    # The dispatch note raised the receipt the store books the replacement against, and
    # carried the SUPPLIER's batch onto it â€” not the batch of the faulty goods.
    assert doc.vendor_followup_receipt_no
    line = await db.scalar(select(PurchaseReturnItem).where(
        PurchaseReturnItem.return_id == return_id))
    assert line.replacement_batch_no == "B-NEW-01"


async def test_the_references_survive_the_whole_journey(db, client, make_user, login):
    """GRN, PO, QC and Indent are on the document at every rung, start to finish.

    The business rule is "do not break GRN/PO/QC/Indent relationships", and the QC was the
    one this document could not carry at all until 2026-09-12 â€” it is the evidence the
    vendor is being asked to accept.
    """
    from app.modules.warehouse.models import Inspection

    src = await _chain(db)
    db.add(Inspection(
        inspection_no="QC0001", inspection_date=date(2026, 9, 2),
        receipt_id=src["grn_id"], grn_no=src["grn_no"],
        warehouse_id=src["warehouse_id"], vendor_id=src["vendor_id"],
        inspection_type="INCOMING", status="COMPLETED", inspector_name="A. QC",
    ))
    await db.commit()

    await make_user(username="store10",
                    permissions=[RETURN_VIEW, RETURN_CREATE, "return.approve"])
    headers = await login("store10", "pw")
    portal = await _portal(db, src["vendor_id"], "kirloskar10")
    return_id = await _sent(db, client, headers, src, qty=2)

    def _refs(body):
        return (body["grn_no"], body["po_no"], body["inspection_no"], body["indent_no"])

    sent_refs = _refs((await client.get(f"/api/warehouse/returns/{return_id}",
                                        headers=headers)).json())
    assert sent_refs[0] == "GRN0001"
    assert sent_refs[1] == "PO0001"
    assert sent_refs[2] == "QC0001", "the QC that condemned the goods must be named"
    assert sent_refs[3]

    # Bound, not merely derived: the column carries it once the return has gone out.
    await db.rollback()
    assert (await db.get(PurchaseReturn, return_id)).inspection_no == "QC0001"

    await client.post(f"/api/supplier/returns/{return_id}/decide",
                      json={"action": "APPROVED"}, headers=portal)
    await client.post(f"/api/supplier/returns/{return_id}/settle",
                      json={"settlement": "REPLACED"}, headers=portal)
    await client.post(f"/api/warehouse/returns/{return_id}/transport",
                      json={"arrangement": "VENDOR_ARRANGES"}, headers=headers)
    await client.post(f"/api/supplier/returns/{return_id}/accept-transport",
                      json={"vehicle_no": "KA05XY9"}, headers=portal)
    await client.post(f"/api/supplier/returns/{return_id}/pickup",
                      json={"vehicle_no": "KA05XY9"}, headers=portal)
    await client.post(f"/api/supplier/returns/{return_id}/confirm-receipt",
                      json={"received_by_name": "Their gate"}, headers=portal)

    end_refs = _refs((await client.get(f"/api/warehouse/returns/{return_id}",
                                       headers=headers)).json())
    assert end_refs == sent_refs, "the references must not drift as the return travels"

    # And the supplier reads the same four on their own copy, which is what they are
    # being asked to verify the return against.
    theirs = await client.get(f"/api/supplier/returns/{return_id}", headers=portal)
    assert theirs.status_code == 200, theirs.text
    assert theirs.json()["grn_no"] == "GRN0001"
    assert theirs.json()["po_no"] == "PO0001"


async def test_transport_is_asked_once_and_only_on_the_right_rung(
        db, client, make_user, login):
    """The one press our desk still has: refused early, refused twice.

    Asking twice would raise a second consignment and a second vehicle for one load,
    which is the "prevent duplicate actions" rule with teeth on it.
    """
    src = await _chain(db)
    await make_user(username="store11",
                    permissions=[RETURN_VIEW, RETURN_CREATE, "return.approve"])
    headers = await login("store11", "pw")
    portal = await _portal(db, src["vendor_id"], "kirloskar11")
    return_id = await _sent(db, client, headers, src, qty=2)

    # Too early: the vendor has not answered, let alone asked for a replacement.
    early = await client.post(f"/api/warehouse/returns/{return_id}/transport",
                              json={"arrangement": "VENDOR_ARRANGES"}, headers=headers)
    assert early.status_code == 422, early.text

    await client.post(f"/api/supplier/returns/{return_id}/decide",
                      json={"action": "APPROVED"}, headers=portal)
    # Still too early: approved, but no replacement agreed â€” it could yet be a refund.
    mid = await client.post(f"/api/warehouse/returns/{return_id}/transport",
                            json={"arrangement": "VENDOR_ARRANGES"}, headers=headers)
    assert mid.status_code == 422, mid.text

    await client.post(f"/api/supplier/returns/{return_id}/settle",
                      json={"settlement": "REPLACED"}, headers=portal)
    ok = await client.post(f"/api/warehouse/returns/{return_id}/transport",
                           json={"arrangement": "VENDOR_ARRANGES"}, headers=headers)
    assert ok.status_code == 200, ok.text

    twice = await client.post(f"/api/warehouse/returns/{return_id}/transport",
                              json={"arrangement": "WAREHOUSE_REQUESTS"}, headers=headers)
    assert twice.status_code == 422, twice.text
    assert "already" in twice.json()["error"].lower()

    # Exactly one consignment, whatever the second press said.
    await db.rollback()
    legs = (await db.execute(select(Dispatch).where(
        Dispatch.ref_type == "PURCHASE_RETURN",
        Dispatch.ref_id == return_id))).scalars().all()
    assert len(legs) == 1


async def _to_replacement_dispatched(db, client, headers, portal, src, *, qty=3) -> int:
    """A return walked to REPLACEMENT_DISPATCHED — the rung the intake starts from.

    The whole vendor-led leg in one call, because a test of what happens to the
    replacement AFTER it is dispatched should not be thirty lines of getting it dispatched.
    Every press is the real route; nothing is stamped onto the row by hand.
    """
    return_id = await _sent(db, client, headers, src, qty=qty)
    for path, body in (
        (f"/api/supplier/returns/{return_id}/decide", {"action": "APPROVED"}),
        (f"/api/supplier/returns/{return_id}/settle", {"settlement": "REPLACED"}),
    ):
        r = await client.post(path, json=body, headers=portal)
        assert r.status_code == 200, r.text
    r = await client.post(f"/api/warehouse/returns/{return_id}/transport",
                          json={"arrangement": "VENDOR_ARRANGES"}, headers=headers)
    assert r.status_code == 200, r.text
    for path, body in (
        (f"/api/supplier/returns/{return_id}/accept-transport", {"vehicle_no": "KA09QC1"}),
        (f"/api/supplier/returns/{return_id}/pickup", {"vehicle_no": "KA09QC1"}),
        (f"/api/supplier/returns/{return_id}/confirm-receipt",
         {"received_by_name": "Their gate"}),
        (f"/api/supplier/returns/{return_id}/dispatch-replacement",
         {"dispatch_no": "VDN-9001", "dispatch_date": "2026-09-20",
          "expected_date": "2026-09-23",
          "lines": [{"line_no": 1, "batch_no": "B-NEW-09"}]}),
    ):
        r = await client.post(path, json=body, headers=portal)
        assert r.status_code == 200, r.text
    return return_id


async def test_the_replacement_closes_the_return_only_once_qc_and_putaway_are_done(
        db, client, make_user, login):
    """The tail of the vendor-led flow, walked on the store's ORDINARY inward path.

        REPLACEMENT_DISPATCHED -> GRN draft -> submitted -> QC -> passed
                               -> stock posted -> the return closes itself

    The business rule this exists for is "putaway only after QC, and close only after
    putaway". Before it the return stopped dead at RECEIVED_AT_WAREHOUSE and waited for
    somebody to remember to press Complete, so the whole of the work that actually happens
    to the replacement was a gap in the middle of the story.

    THREE THINGS ARE ASSERTED BEYOND THE RUNGS, all of them the guards the rule needs:
    one GRN and no more, one QC and no more, and a manual Complete refused for as long as
    the intake is open — that press would close the document early AND post the goods out
    of stock a second time, since the faulty material left the books at the gate pass.

    This warehouse keeps no bins, so QC passing IS the end of the intake and there is no
    separate putaway task to confirm. `confirm_putaway` carries the same hook for a
    bin-managed one; what is proved here is that the CLOSE waits for the receipt to reach
    COMPLETED, whichever of the two finishes it.
    """
    from app.modules.warehouse.models import Inspection

    src = await _chain(db)
    # QC is the item master's rule, not the return's — a replacement is inspected exactly
    # when any other delivery of the same item would be. Switched on here so the submit
    # lands on PENDING_QC and raises the inspection this test is about.
    item = await db.get(Item, src["item_id"])
    item.requires_qi = True
    await db.commit()

    await make_user(username="store12", permissions=[
        RETURN_VIEW, RETURN_CREATE, "return.approve", "receipt.view", "receipt.create",
        "inspection.view", "inspection.execute",
    ])
    headers = await login("store12", "pw")
    portal = await _portal(db, src["vendor_id"], "kirloskar12")
    return_id = await _to_replacement_dispatched(db, client, headers, portal, src, qty=3)

    await db.rollback()
    doc = await db.get(PurchaseReturn, return_id)
    receipt_id = doc.vendor_followup_receipt_id
    assert receipt_id, "the dispatch note must raise the GRN draft"

    # --- the GRN draft is linked to the return, the vendor, the PO, the item and the
    #     batch the VENDOR stated for the replacement --------------------------------
    grn = await db.get(Receipt, receipt_id)
    assert grn.status == "DRAFT"
    assert grn.vendor_id == src["vendor_id"]
    assert grn.po_id == src["po_id"] and grn.po_no == "PO0001"
    assert grn.warehouse_id == src["warehouse_id"]
    assert doc.return_no in (grn.remarks or ""), "the GRN must name the return it came from"
    grn_line = await db.scalar(select(ReceiptItem).where(ReceiptItem.receipt_id == grn.id))
    assert grn_line.item_id == src["item_id"]
    assert grn_line.batch_no == "B-NEW-09", "the replacement's batch, not the faulty one's"
    # Held as plain values: `expire_all` below detaches these rows from their loaded
    # state, and reading an expired attribute mid-test triggers a lazy refresh outside
    # the greenlet the async session needs.
    grn_no, grn_line_id = grn.grn_no, grn_line.id

    # ONE GRN AND NO MORE. The rung the dispatch note is pressed on is left behind by the
    # press itself, so a second one cannot raise a second lorry's worth of paperwork.
    twice = await client.post(f"/api/supplier/returns/{return_id}/dispatch-replacement",
                              json={"dispatch_no": "VDN-9002",
                                    "dispatch_date": "2026-09-21",
                                    "lines": [{"line_no": 1, "batch_no": "B-NEW-99"}]},
                              headers=portal)
    assert twice.status_code == 422, twice.text
    receipts = (await db.execute(select(Receipt).where(
        Receipt.receipt_type == "RETURN"))).scalars().all()
    assert len(receipts) == 1

    # --- the tracker names the three new legs, and nothing has happened on them yet ---
    def _legs(body):
        return {leg["key"]: leg for leg in body["journey"]}

    dossier = await client.get(f"/api/warehouse/returns/{return_id}/dossier",
                               headers=headers)
    assert dossier.status_code == 200, dossier.text
    legs = _legs(dossier.json())
    assert list(legs)[-4:] == ["grn", "qc", "putaway", "closed"]
    assert legs["warehouse_received"]["state"] == "current"
    assert legs["grn"]["reference_no"] == grn_no
    assert legs["putaway"]["state"] == "pending"

    # --- the store books it in: what physically arrived, then submit ---
    # Written on the line rather than through the GRN form: this test is about the return's
    # tail, and the receiving screen has its own tests. The draft is raised with
    # `received_qty` zero on purpose — it says what to EXPECT.
    grn_line.received_qty = 3
    await db.commit()

    submitted = await client.post(f"/api/warehouse/receipts/{receipt_id}/submit",
                                  headers=headers)
    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["status"] == "PENDING_QC"

    # `expire_all` as well as the rollback, and this is not belt and braces: this test
    # has COMMITTED in its own session (the received quantity above), the fixture
    # session is `expire_on_commit=False`, and a rollback with no transaction open is a
    # no-op — so `db.get` would hand back the copy of the row this session was already
    # holding and the assertion would be about a snapshot taken before the API ran.
    await db.rollback()
    db.expire_all()
    doc = await db.get(PurchaseReturn, return_id)
    assert doc.status == "RECEIVED_AT_WAREHOUSE", \
        "the submit brings the return home, and stops there while QC is owed"

    # A MANUAL CLOSE IS REFUSED while the intake is open — it would close the document
    # early and post the goods out of stock a second time.
    early = await client.post(f"/api/warehouse/returns/{return_id}/complete",
                              json={}, headers=headers)
    assert early.status_code == 422, early.text
    assert "qc" in early.json()["error"].lower()

    dossier = await client.get(f"/api/warehouse/returns/{return_id}/dossier",
                               headers=headers)
    legs = _legs(dossier.json())
    assert legs["grn"]["state"] == "completed"
    assert legs["qc"]["state"] == "current"
    assert legs["putaway"]["state"] == "pending"
    assert legs["closed"]["state"] == "pending"

    # --- QC: one inspection, raised by the submit, and no second one allowed ---
    inspection = await db.scalar(select(Inspection).where(
        Inspection.receipt_id == receipt_id))
    assert inspection is not None, "submitting the GRN must raise its QC"
    second_qc = await client.post("/api/warehouse/inspections", json={
        "inspection_date": "2026-09-24", "receipt_id": receipt_id,
        "warehouse_id": src["warehouse_id"], "inspection_type": "INCOMING",
        "items": [{"item_id": src["item_id"], "receipt_item_id": grn_line_id,
                   "inspected_qty": 3, "accepted_qty": 3, "result": "PASSED"}],
    }, headers=headers)
    assert second_qc.status_code == 422, second_qc.text
    assert "already inspected" in second_qc.json()["error"].lower()

    read = await client.get(f"/api/warehouse/inspections/{inspection.id}", headers=headers)
    assert read.status_code == 200, read.text
    lines = read.json()["items"]
    assert lines, "the inspection must carry the line it was raised for"
    filled = await client.put(f"/api/warehouse/inspections/{inspection.id}", json={
        "inspection_date": "2026-09-24", "receipt_id": receipt_id,
        "warehouse_id": src["warehouse_id"], "inspection_type": "INCOMING",
        "items": [{"id": line["id"], "receipt_item_id": line["receipt_item_id"],
                   "item_id": line["item_id"], "inspected_qty": 3, "accepted_qty": 3,
                   "result": "PASSED"} for line in lines],
    }, headers=headers)
    assert filled.status_code == 200, filled.text

    passed = await client.post(f"/api/warehouse/inspections/{inspection.id}/complete",
                               headers=headers)
    assert passed.status_code == 200, passed.text

    # --- and THAT closes the return, because the intake is finished ---
    await db.rollback()
    db.expire_all()
    grn = await db.get(Receipt, receipt_id)
    assert grn.status == "COMPLETED" and grn.is_stock_posted
    doc = await db.get(PurchaseReturn, return_id)
    assert doc.status == "COMPLETED", "the finished intake is what closes the return"
    # EVERY ORIGINAL REFERENCE SURVIVES THE CLOSE.
    assert doc.grn_no == "GRN0001" and doc.po_no == "PO0001"
    assert doc.vendor_id == src["vendor_id"]
    assert doc.vendor_followup_receipt_id == receipt_id
    assert doc.replacement_dispatch_no == "VDN-9001"
    assert doc.received_at is not None

    dossier = await client.get(f"/api/warehouse/returns/{return_id}/dossier",
                               headers=headers)
    legs = _legs(dossier.json())
    for key in ("warehouse_received", "grn", "qc", "putaway", "closed"):
        assert legs[key]["state"] == "completed", f"{key} is {legs[key]['state']}"
    assert grn_no in (legs["closed"]["detail"] or "")

    # Closed once. A second Complete is refused by the status guard, not ignored.
    again = await client.post(f"/api/warehouse/returns/{return_id}/complete",
                              json={}, headers=headers)
    assert again.status_code == 422, again.text


async def test_a_vendor_cannot_answer_another_vendors_return(
        db, client, make_user, login):
    """The vendor id comes from the token, never from the request.

    A return belonging to somebody else is a 404 rather than a 403: telling the caller
    which would confirm that a guessed return number exists.
    """
    src = await _chain(db)
    other = Vendor(code="VEN-002", name="Someone Else", vendor_type="MATERIAL",
                   is_active=True)
    db.add(other)
    await db.commit()

    await make_user(username="store12", permissions=[RETURN_VIEW, RETURN_CREATE])
    headers = await login("store12", "pw")
    intruder = await _portal(db, other.id, "intruder")
    return_id = await _sent(db, client, headers, src)

    for path, body in (("decide", {"action": "APPROVED"}),
                       ("settle", {"settlement": "REPLACED"}),
                       ("accept-transport", {}),
                       ("pickup", {}),
                       ("confirm-receipt", {"received_by_name": "x"}),
                       ("dispatch-replacement", {"lines": []})):
        r = await client.post(f"/api/supplier/returns/{return_id}/{path}",
                              json=body, headers=intruder)
        assert r.status_code == 404, f"{path} leaked: {r.status_code} {r.text}"

    await db.rollback()
    assert (await db.get(PurchaseReturn, return_id)).status == "SENT_TO_VENDOR"


async def _portal(db, vendor_id: int, username: str) -> dict:
    """A supplier-portal login for one vendor, and the headers it authenticates with.

    The token is minted rather than fetched through `/api/supplier/login`: the login
    verifies an Argon hash, which costs more than this test is measuring. `typ:
    "vendor"` is the part that matters â€” `get_current_vendor` accepts nothing else,
    and `get_current_user` refuses it outright.
    """
    from app.core.security import create_access_token
    from app.modules.procurement.models import VendorUser

    db.add(VendorUser(vendor_id=vendor_id, username=username,
                      password_hash="x", is_active=True, must_change_password=False))
    await db.commit()
    token = create_access_token(vendor_id, {"typ": "vendor", "username": username})
    return {"Authorization": f"Bearer {token}"}


async def test_a_sent_return_lands_on_the_suppliers_own_portal(
        db, client, make_user, login):
    """The supplier sees goods coming back to them â€” and only once they are sent.

    The portal's returns list is served by the WAREHOUSE module on `/api/supplier`,
    because procurement (where the rest of the portal lives) may not import a later
    module. What this proves is the behaviour, not the wiring: a draft is invisible, a
    sent return is visible with its consignment attached, and one vendor never sees
    another's.
    """
    src = await _chain(db)
    await make_user(username="store4", permissions=[RETURN_VIEW, RETURN_CREATE])
    headers = await login("store4", "pw")
    portal = await _portal(db, src["vendor_id"], "kirloskar")

    # Nothing sent yet.
    r = await client.get("/api/supplier/returns", headers=portal)
    assert r.status_code == 200, r.text
    assert r.json()["items"] == []

    draft = await client.post("/api/warehouse/returns", json={
        "return_date": "2026-09-10",
        "grn_id": src["grn_id"], "vendor_id": src["vendor_id"],
        "warehouse_id": src["warehouse_id"], "reason": "DAMAGED",
        "remarks": "Two drums crushed in transit",
        "items": [{"item_id": src["item_id"], "grn_item_id": src["grn_item_id"],
                   "quantity": 5, "rate": 100, "reason": "DAMAGED"}],
    }, headers=headers)
    assert draft.status_code == 201, draft.text
    return_id = draft.json()["id"]

    # A DRAFT is ours, not theirs. The supplier is not a party to a return we have
    # not decided to send, and must never be shown one.
    r = await client.get("/api/supplier/returns", headers=portal)
    assert r.status_code == 200, r.text
    assert r.json()["items"] == []

    sent = await client.post(f"/api/warehouse/returns/{return_id}/send-to-vendor", json={
        "return_reason": "DAMAGED",
        "remarks": "Two drums crushed in transit",
        "items": [{"item_id": src["item_id"], "grn_item_id": src["grn_item_id"],
                   "quantity": 5, "rate": 100}],
        "grn_id": src["grn_id"], "vendor_id": src["vendor_id"],
        "warehouse_id": src["warehouse_id"],
    }, headers=headers)
    assert sent.status_code == 200, sent.text
    return_no = sent.json()["return_no"]

    r = await client.get("/api/supplier/returns", headers=portal)
    assert r.status_code == 200, r.text
    rows = r.json()["items"]
    assert len(rows) == 1
    row = rows[0]
    assert row["return_no"] == return_no
    assert row["po_no"] == "PO0001"
    assert row["grn_no"] == "GRN0001"
    # The reason as a WORD. A supplier reading "DAMAGED" is reading our database.
    assert row["reason_code"] == "DAMAGED"
    assert row["reason_label"] == "Damaged"
    assert row["remarks"] == "Two drums crushed in transit"
    assert float(row["total_qty"]) == 5
    assert float(row["total_value"]) == 500
    assert row["status"] == "SENT_TO_VENDOR"
    assert row["sent_at"]
    # NO CONSIGNMENT YET, and that is the point of the send since 2026-09-12: what the
    # supplier has been handed is the PAPERWORK, to check against the GRN, the PO and the
    # QC before anything is put on a lorry. The transport facts appear on their copy once
    # they have approved it and this warehouse has arranged a vehicle.
    assert row["dispatch_no"] is None
    assert row["transport_mode"] is None

    # Searching by the numbers a supplier has on their own paperwork.
    r = await client.get("/api/supplier/returns", params={"search": "GRN0001"},
                         headers=portal)
    assert r.status_code == 200, r.text
    assert len(r.json()["items"]) == 1
    r = await client.get("/api/supplier/returns", params={"search": "NOTHING"},
                         headers=portal)
    assert r.json()["items"] == []

    # --- and it is THEIRS alone ---
    other = Vendor(code="VEN-002", name="Somebody Else", vendor_type="MATERIAL",
                   is_active=True)
    db.add(other)
    await db.commit()
    other_portal = await _portal(db, other.id, "somebodyelse")
    r = await client.get("/api/supplier/returns", headers=other_portal)
    assert r.status_code == 200, r.text
    assert r.json()["items"] == []

    # An employee token must not open a portal route at all.
    r = await client.get("/api/supplier/returns", headers=headers)
    assert r.status_code == 401, r.text
