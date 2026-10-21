"""How a purchase order asks for its goods to be packed, and the supplier's answer
(2026-10-08), against a real database.

- a PO line stated in packs keeps its quantity in base units and its breakdown beside;
- a line written with no packing is described in the item's default hierarchy;
- a trimmed quantity is rescaled in the same hierarchy;
- a supplier may send other levels of the SAME hierarchy freely, but a DIFFERENT one
  must say why, goes to the buyer, and — accepted — rewrites the order line.
"""
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.core.exceptions import ValidationError
from app.modules.procurement import packing as po_packing
from app.modules.procurement.models import (
    DespatchNote, DespatchNoteItem, POItem, PurchaseOrder,
)
from app.platform.hcm.models import HcmEmployee
from app.platform.settings.models import Notification
from app.shared.enums import PackChangeStatus
from app.shared.masters import defs
from app.shared.models.base import utcnow
from app.shared.models.master import (
    Item, ItemPackaging, Packaging, PackHierarchy, Vendor,
)
from app.shared.packing import PackEntryIn

D = Decimal


async def _hierarchy(db, item, name, strip_qty, packages):
    h = PackHierarchy()
    await defs.apply_pack_hierarchy(db, h, defs.PackHierarchyIn(item_id=item.id, name=name))
    db.add(h)
    await db.flush()
    for level, (package, qty) in enumerate(
            ((packages["strip"], strip_qty), (packages["box"], 10)), start=1):
        rung = ItemPackaging()
        await defs.apply_item_packaging(db, rung, defs.ItemPackagingIn(
            item_id=item.id, hierarchy_id=h.id, level=level, package_id=package.id,
            quantity=qty))
        db.add(rung)
        await db.flush()
    return h


async def _world(db):
    w = SimpleNamespace()
    w.buyer = HcmEmployee(id=7, full_name="Buyer", emp_code="b", is_active=True,
                          synced_at=utcnow())
    w.vendor = Vendor(code="V1", name="Pharma Co", is_active=True)
    w.item = Item(code="TAB-0001", name="Paracetamol", uom_code="TAB", is_active=True)
    db.add_all([w.buyer, w.vendor, w.item])
    await db.flush()
    packages = {"strip": Packaging(code="STRIP", name="Strip", is_active=True),
                "box": Packaging(code="BOX", name="Box", is_active=True)}
    db.add_all(packages.values())
    await db.flush()
    w.ten = await _hierarchy(db, w.item, "Strip of 10", 10, packages)
    w.fifteen = await _hierarchy(db, w.item, "Strip of 15", 15, packages)
    w.po = PurchaseOrder(po_no="PO-T-1", vendor_id=w.vendor.id, vendor_name="Pharma Co",
                         status="ACCEPTED_BY_SUPPLIER", created_by_id=w.buyer.id)
    db.add(w.po)
    await db.flush()
    await db.commit()
    return w


async def _line(db, w, qty, *, hierarchy=None, packs=None):
    row = POItem(po_id=w.po.id, item_id=w.item.id, item_code=w.item.code,
                 item_name=w.item.name, uom_code="TAB", quantity=D(qty), rate=D(1),
                 amount=D(qty))
    db.add(row)
    await po_packing.stamp_line(db, row, hierarchy_id=hierarchy, entries=packs)
    await db.flush()
    await po_packing.sync_po_packing(db, w.po.id)
    await db.commit()
    return row


@pytest.mark.asyncio
async def test_a_po_line_carries_its_packing_and_rescales_with_its_quantity(db):
    w = await _world(db)
    line = await _line(db, w, 2000, hierarchy=w.ten.id,
                       packs=[PackEntryIn(level=2, qty=D(20))])
    assert po_packing.pack_text(line) == "20 Box = 2,000 TAB"
    assert po_packing.hierarchy_name(line) == "Strip of 10"

    with pytest.raises(ValidationError, match="does not add up"):
        await po_packing.stamp_line(db, line, hierarchy_id=w.ten.id,
                                    entries=[PackEntryIn(level=2, qty=D(3))])

    line.quantity = D(1850)
    await po_packing.sync_po_packing(db, w.po.id)
    assert po_packing.pack_text(line) == "18 Box + 5 Strip = 1,850 TAB"


@pytest.mark.asyncio
async def test_a_line_with_no_packing_is_described_in_the_default_hierarchy(db):
    w = await _world(db)
    line = await _line(db, w, 230)
    assert line.pack_hierarchy_id == w.ten.id
    assert po_packing.pack_text(line) == "2 Box + 3 Strip = 230 TAB"


@pytest.mark.asyncio
async def test_a_different_hierarchy_goes_to_the_buyer_and_can_be_accepted(db):
    w = await _world(db)
    line = await _line(db, w, 1500, hierarchy=w.ten.id)
    note = DespatchNote(dn_no="DN-T-1", po_id=w.po.id, vendor_id=w.vendor.id,
                        status="DRAFT")
    db.add(note)
    await db.flush()

    same = DespatchNoteItem(despatch_note_id=note.id, line_no=1, po_item_id=line.id,
                            item_id=w.item.id, uom_code="TAB", despatched_qty=D(0))
    await po_packing.stamp_despatch_line(
        db, same, line, hierarchy_id=None, reason=None,
        entries=[PackEntryIn(level=2, qty=D(1)), PackEntryIn(level=1, qty=D(50))])
    assert same.despatched_qty == D(600)
    assert same.pack_change_status == PackChangeStatus.NONE.value

    other = DespatchNoteItem(despatch_note_id=note.id, line_no=2, po_item_id=line.id,
                             item_id=w.item.id, uom_code="TAB", despatched_qty=D(0))
    with pytest.raises(ValidationError, match="Say why"):
        await po_packing.stamp_despatch_line(
            db, other, line, hierarchy_id=w.fifteen.id, reason=None,
            entries=[PackEntryIn(level=1, qty=D(60))])
    await po_packing.stamp_despatch_line(
        db, other, line, hierarchy_id=w.fifteen.id, reason="10-strips out of stock",
        entries=[PackEntryIn(level=1, qty=D(60))])
    assert other.despatched_qty == D(900)
    assert other.pack_change_status == PackChangeStatus.PENDING.value
    assert other.ordered_pack_hierarchy_name == "Strip of 10"
    db.add_all([same, other])
    await db.flush()
    await db.refresh(note, ["items"])

    assert await po_packing.notify_buyer_of_changes(db, note, w.po) == 1
    told = (await db.execute(Notification.__table__.select().where(
        Notification.employee_id == w.buyer.id))).all()
    assert told and "changed the packing" in told[0].title
    await db.commit()

    decided = await po_packing.decide_pack_change(
        db, w.po.id, other.id, accept=True, note=None, user=w.buyer)
    assert decided["status"] == PackChangeStatus.ACCEPTED.value
    await db.refresh(line)
    assert line.pack_hierarchy_id == w.fifteen.id
    assert po_packing.pack_text(line) == "10 Box = 1,500 TAB"

    with pytest.raises(ValidationError, match="already accepted"):
        await po_packing.decide_pack_change(db, w.po.id, other.id, accept=False,
                                            note="no", user=w.buyer)


@pytest.mark.asyncio
async def test_the_gate_receives_the_declared_packing_and_may_only_come_up_short(db):
    from app.modules.warehouse.packing import receipt_line_packing

    w = await _world(db)
    line = await _line(db, w, 1000, hierarchy=w.ten.id)
    note = DespatchNote(dn_no="DN-T-2", po_id=w.po.id, vendor_id=w.vendor.id,
                        status="SUBMITTED")
    db.add(note)
    await db.flush()
    sent = DespatchNoteItem(despatch_note_id=note.id, line_no=1, po_item_id=line.id,
                            item_id=w.item.id, uom_code="TAB", despatched_qty=D(0))
    await po_packing.stamp_despatch_line(
        db, sent, line, hierarchy_id=None, reason=None,
        entries=[PackEntryIn(level=2, qty=D(8)), PackEntryIn(level=1, qty=D(20))])
    db.add(sent)
    await db.commit()

    def at_gate(qty, packs=None, hierarchy=None):
        return SimpleNamespace(despatch_note_item_id=sent.id, po_item_id=line.id,
                               pack_hierarchy_id=hierarchy, pack_breakdown=packs,
                               received_qty=D(qty))

    # A bare count is read inside the declared packs.
    got = await receipt_line_packing(db, item=w.item, line_in=at_gate(950), received=D(950))
    assert [(e["name"], e["qty"]) for e in got["pack_breakdown"]] == [("Box", "8"),
                                                                      ("Strip", "15")]
    assert got["declared_pack_breakdown"] == sent.pack_breakdown
    # A count in packs sets the quantity.
    got = await receipt_line_packing(
        db, item=w.item, line_in=at_gate(0, [PackEntryIn(level=2, qty=D(7))]),
        received=D(0))
    assert got["received"] == D(700)
    # Never over, never a level the supplier did not send, never another hierarchy.
    with pytest.raises(ValidationError, match="never over"):
        await receipt_line_packing(
            db, item=w.item, line_in=at_gate(0, [PackEntryIn(level=2, qty=D(9))]),
            received=D(0))
    with pytest.raises(ValidationError, match="more than the despatch note"):
        await receipt_line_packing(db, item=w.item, line_in=at_gate(1100), received=D(1100))
    with pytest.raises(ValidationError, match="fixed at the gate"):
        await receipt_line_packing(db, item=w.item, line_in=at_gate(100, None, w.fifteen.id),
                                   received=D(100))
