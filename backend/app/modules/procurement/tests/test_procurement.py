"""Procurement module tests: PO from approved indent, engine submit/approve,
send-to-vendor, and guards."""
import pytest

from app.core.exceptions import ValidationError
from app.modules.indents.models import Indent, IndentItem
from app.modules.inventory.models import MaterialRequest, MaterialRequestItem
from app.modules.procurement import service
from app.modules.procurement.schemas import POCreate, POLineIn
from app.platform.hcm.models import HcmEmployee
from app.platform.workflow.models import Stage, Workflow
from app.shared.enums import IndentStatus, MRStatus, POStatus
from app.shared.models.base import utcnow
from app.shared.models.master import Item, Uom, Vendor


async def _world(db, indent_status=IndentStatus.APPROVED.value):
    uom = Uom(code="NOS", name="Numbers")
    db.add(uom)
    await db.flush()
    item = Item(code="IT-1", name="Bolt", uom_id=uom.id, uom_code="NOS")
    vendor = Vendor(code="V-1", name="Acme", gstin="GST1", is_active=True)
    creator = HcmEmployee(id=4, full_name="Proc User", emp_code="E4", is_active=True, synced_at=utcnow())
    approver = HcmEmployee(id=5, full_name="PO Head", emp_code="E5", is_active=True, synced_at=utcnow())
    db.add_all([item, vendor, creator, approver])
    await db.flush()

    indent = Indent(indent_no="IND/2026/0001", status=indent_status, priority="NORMAL",
                    department_id=501, office_id=801, office_name="Store", total_items=1)
    db.add(indent)
    await db.flush()
    ind_item = IndentItem(indent_id=indent.id, item_id=item.id, item_code=item.code,
                          item_name=item.name, uom_code="NOS", quantity=10)
    db.add(ind_item)

    wf = Workflow(code="WF-PO", name="PO", doc_type="PO", is_active=True)
    db.add(wf)
    await db.flush()
    db.add(Stage(workflow_id=wf.id, sequence=1, name="Approver",
                 approver_type="SPECIFIC_USER", employee_id=approver.id,
                 approval_mode="ANY_ONE"))
    await db.commit()
    return item, vendor, indent, ind_item, creator, approver


def _po_data(vendor_id, item_id, indent_item_id):
    return POCreate(vendor_id=vendor_id,
                    lines=[POLineIn(item_id=item_id, indent_item_id=indent_item_id,
                                    quantity=10, rate=100, tax_percent=18)])


async def test_create_po_from_indent(db):
    item, vendor, indent, ind_item, creator, _ = await _world(db)
    po = await service.create_po_from_indent(db, indent.id, _po_data(vendor.id, item.id, ind_item.id), creator)
    assert po.status == POStatus.DRAFT.value
    assert po.po_no.startswith("PO/")
    assert float(po.sub_total) == 1000 and float(po.tax_amount) == 180
    assert float(po.total_amount) == 1180
    assert po.vendor_name == "Acme"
    refreshed = await db.get(Indent, indent.id)
    assert refreshed.status == IndentStatus.ORDERED.value


async def test_cannot_po_unapproved_indent(db):
    item, vendor, indent, ind_item, creator, _ = await _world(db, indent_status=IndentStatus.DRAFT.value)
    with pytest.raises(ValidationError):
        await service.create_po_from_indent(db, indent.id, _po_data(vendor.id, item.id, ind_item.id), creator)


async def test_shortage_requires_approved_mr_before_procurement(db):
    item, vendor, indent, ind_item, creator, _ = await _world(
        db, indent_status=IndentStatus.PENDING_PROCUREMENT.value,
    )
    mr = MaterialRequest(
        mr_no="MR/2026/0001", indent_id=indent.id, indent_no=indent.indent_no,
        status=MRStatus.PENDING_APPROVAL.value, priority="NORMAL",
    )
    db.add(mr)
    await db.flush()
    db.add(MaterialRequestItem(
        mr_id=mr.id, line_no=1, item_id=item.id, item_code=item.code,
        item_name=item.name, uom_code=item.uom_code, quantity=10,
        indent_item_id=ind_item.id,
    ))
    await db.commit()

    with pytest.raises(ValidationError, match="must be approved"):
        await service.create_po_from_indent(
            db, indent.id, _po_data(vendor.id, item.id, ind_item.id), creator,
        )

    mr.status = MRStatus.APPROVED.value
    await db.commit()
    po = await service.create_po_from_indent(
        db, indent.id, _po_data(vendor.id, item.id, ind_item.id), creator,
    )
    assert po.status == POStatus.DRAFT.value


async def test_submit_approve_send_to_vendor(db):
    item, vendor, indent, ind_item, creator, approver = await _world(db)
    po = await service.create_po_from_indent(db, indent.id, _po_data(vendor.id, item.id, ind_item.id), creator)

    await service.submit_po(db, po.id, creator)
    assert (await service.get_po(db, po.id)).status == POStatus.PENDING_APPROVAL.value

    await service.act_on_po(db, po.id, "APPROVE", "ok", approver)
    assert (await service.get_po(db, po.id)).status == POStatus.APPROVED.value

    await service.send_to_vendor(db, po.id, creator)
    assert (await service.get_po(db, po.id)).status == POStatus.SENT_TO_VENDOR.value


async def test_cannot_send_unapproved_po(db):
    item, vendor, indent, ind_item, creator, _ = await _world(db)
    po = await service.create_po_from_indent(db, indent.id, _po_data(vendor.id, item.id, ind_item.id), creator)
    with pytest.raises(ValidationError):
        await service.send_to_vendor(db, po.id, creator)
