"""Logistics module tests: GRN from PO, QC pass -> stock, move_stock guards."""
import pytest

from app.core.exceptions import ValidationError
# Stock moved to modules/inventory when it became the base module; logistics keeps
# GRN and Issues and calls inventory_service.move_stock().
from app.modules.inventory import service as inventory_service
from app.modules.logistics import service
from app.modules.logistics.schemas import GRNCreate, GRNLineIn
from app.modules.procurement.models import POItem, PurchaseOrder
from app.platform.hcm.models import HcmEmployee
from app.shared.enums import GRNStatus, POStatus, StockDirection
from app.shared.models.base import utcnow
from app.shared.models.master import Item, Uom, Vendor

FACILITY = 801


async def _po_world(db):
    uom = Uom(code="NOS", name="Numbers")
    db.add(uom)
    await db.flush()
    item = Item(code="IT-1", name="Bolt", uom_id=uom.id, uom_code="NOS")
    vendor = Vendor(code="V-1", name="Acme", is_active=True)
    store = HcmEmployee(id=6, full_name="Store User", emp_code="E6", is_active=True, synced_at=utcnow())
    db.add_all([item, vendor, store])
    await db.flush()
    po = PurchaseOrder(po_no="PO/2026/0001", vendor_id=vendor.id, vendor_name="Acme",
                       facility_id=FACILITY, facility_name="Store",
                       status=POStatus.SENT_TO_VENDOR.value)
    db.add(po)
    await db.flush()
    po_item = POItem(po_id=po.id, item_id=item.id, item_code=item.code, item_name=item.name,
                     uom_code="NOS", quantity=10, rate=100, amount=1000)
    db.add(po_item)
    await db.commit()
    return item, po, po_item, store


def _grn_data(po_item_id, item_id, recv=10, acc=10, rej=0):
    return GRNCreate(invoice_no="INV-1",
                     lines=[GRNLineIn(po_item_id=po_item_id, item_id=item_id,
                                      received_quantity=recv, accepted_quantity=acc,
                                      rejected_quantity=rej)])


async def test_create_grn_marks_po_received(db):
    item, po, po_item, store = await _po_world(db)
    grn = await service.create_grn_from_po(db, po.id, _grn_data(po_item.id, item.id), store)
    assert grn.status == GRNStatus.RECEIVED.value
    assert grn.po_no == "PO/2026/0001"
    assert (await db.get(PurchaseOrder, po.id)).status == POStatus.RECEIVED.value


async def test_qc_pass_increases_stock(db):
    item, po, po_item, store = await _po_world(db)
    grn = await service.create_grn_from_po(db, po.id, _grn_data(po_item.id, item.id, acc=8), store)
    result = await service.qc_pass(db, grn.id, store)
    assert result.status == GRNStatus.QC_PASSED.value

    stock = (await inventory_service.list_stock(db, _params(), item_id=item.id))["items"]
    assert len(stock) == 1
    # stk_balance has available_qty / reserved_qty / total_qty -- there is no
# 'quantity' column. This assertion never ran while the suite was skipping.
    assert float(stock[0].available_qty) == 8
    assert stock[0].facility_id == FACILITY


async def test_partial_receipt_keeps_po_partially_received(db):
    item, po, po_item, store = await _po_world(db)
    grn = await service.create_grn_from_po(db, po.id, _grn_data(po_item.id, item.id, recv=6, acc=6), store)
    assert (await db.get(PurchaseOrder, po.id)).status == POStatus.PARTIALLY_RECEIVED.value


async def test_cannot_grn_unopen_po(db):
    item, po, po_item, store = await _po_world(db)
    po.status = POStatus.DRAFT.value
    await db.commit()
    with pytest.raises(ValidationError):
        await service.create_grn_from_po(db, po.id, _grn_data(po_item.id, item.id), store)


async def test_move_stock_out_insufficient_raises(db):
    item, po, po_item, store = await _po_world(db)
    with pytest.raises(ValidationError):
        await inventory_service.move_stock(
            db, item_id=item.id, qty=5, direction=StockDirection.OUT.value,
            ref_type="ADJUSTMENT", ref_id=0, ref_no="ADJ-1", user=store,
            facility_id=FACILITY)


def _params():
    from app.core.pagination import PageParams
    p = PageParams.__new__(PageParams)
    p.page, p.size = 1, 20
    return p
