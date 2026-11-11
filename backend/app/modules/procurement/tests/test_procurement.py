"""Procurement module tests: PO from approved indent, engine submit/approve,
send-to-vendor, and guards."""
import pytest

from app.core.exceptions import ValidationError
from app.modules.indents.models import Indent, IndentItem
from app.modules.inventory.models import MaterialRequest, MaterialRequestItem
from app.modules.procurement import service
from app.modules.procurement.models import (
    Quotation, QuotationItem, RFQ, RFQItem, RFQVendor,
    Requisition, RequisitionItem,
)
from app.modules.procurement.schemas import (
    AwardIn, POAmendIn, POCreate, POFromQuotationIn, POLineIn,
    RFQQuantitiesIn, RFQQuantityIn,
)
from app.platform.hcm.models import HcmEmployee
from app.platform.workflow.models import Stage, Workflow
from app.shared.enums import (
    IndentStatus, MRStatus, POStatus, POVendorStatus, QuotationStatus, RFQStatus,
    RequisitionStatus,
)
from app.shared.models.base import utcnow
from app.shared.models.master import Item, OrgDepartment, Organization, Uom, Vendor


async def _world(db, indent_status=IndentStatus.APPROVED.value):
    uom = Uom(code="NOS", name="Numbers")
    db.add(uom)
    await db.flush()
    item = Item(code="IT-1", name="Bolt", uom_id=uom.id, uom_code="NOS")
    vendor = Vendor(code="V-1", name="Acme", gstin="GST1", is_active=True)
    creator = HcmEmployee(id=4, full_name="Proc User", emp_code="E4", is_active=True, synced_at=utcnow())
    approver = HcmEmployee(id=5, full_name="PO Head", emp_code="E5", is_active=True, synced_at=utcnow())
    db.add_all([item, vendor, creator, approver,
                Organization(id=2, code="B-01", name="BAVYA", is_active=True,
                             synced_at=utcnow()),
                OrgDepartment(id=2, code="HR-01", name="HUMAN RESOURCES", is_active=True,
                              synced_at=utcnow())])
    await db.flush()

    indent = Indent(indent_no="IND/2026/0001", indent_date=utcnow().date(),
                    status=indent_status, priority="NORMAL",
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
    return POCreate(vendor_id=vendor_id, organization_id=2, org_department_id=2,
                    billing_address="Plant", shipping_address="Store",
                    lines=[POLineIn(item_id=item_id, indent_item_id=indent_item_id,
                                    quantity=10, rate=100, tax_percent=18)])


def test_rfq_award_payload_requires_one_safe_shape():
    assert AwardIn(quotation_id=7).quotation_id == 7
    assert AwardIn(quotation_ids=[7]).quotation_ids == [7]
    assert AwardIn(allocations=[
        {"item_id": 1, "vendor_id": 2, "quantity": 3},
    ]).allocations[0].quantity == 3
    with pytest.raises(ValueError):
        AwardIn(quotation_id=7, allocations=[
            {"item_id": 1, "vendor_id": 2, "quantity": 3},
        ])
    with pytest.raises(ValueError):
        AwardIn()


async def test_create_po_from_indent(db):
    item, vendor, indent, ind_item, creator, _ = await _world(db)
    po = await service.create_po_from_indent(db, indent.id, _po_data(vendor.id, item.id, ind_item.id), creator)
    assert po.status == POStatus.DRAFT.value
    assert "/PO" in po.po_no
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


async def test_amendment_can_increase_quantity_before_reapproval(db):
    item, vendor, indent, ind_item, creator, _ = await _world(db)
    po = await service.create_po_from_indent(
        db, indent.id, _po_data(vendor.id, item.id, ind_item.id), creator)
    po.status = POStatus.ACCEPTED_BY_SUPPLIER.value
    po.vendor_status = POVendorStatus.ACCEPTED.value
    await db.commit()

    amended = await service.amend_po(db, po.id, POAmendIn(
        reason="Quantity increased after supplier discussion",
        lines=[{
            "id": po.items[0].id,
            "item_id": item.id,
            "quantity": 25,
            "rate": 100,
            "tax_percent": 18,
        }],
    ), creator)

    assert float(amended.items[0].quantity) == 25
    assert amended.status == POStatus.DRAFT.value

    submitted = await service.submit_po(db, amended.id, creator)
    assert submitted.status == POStatus.PENDING_APPROVAL.value


async def test_cannot_send_unapproved_po(db):
    item, vendor, indent, ind_item, creator, _ = await _world(db)
    po = await service.create_po_from_indent(db, indent.id, _po_data(vendor.id, item.id, ind_item.id), creator)
    with pytest.raises(ValidationError):
        await service.send_to_vendor(db, po.id, creator)


async def test_rfq_quantity_can_be_corrected_up_to_source_quantity(db):
    item, _vendor, _indent, _ind_item, creator, _approver = await _world(db)
    requisition = Requisition(
        req_no="REQ/2026/0001", status=RequisitionStatus.APPROVED.value,
        total_items=1, created_by_id=creator.id, created_by_name=creator.full_name,
    )
    db.add(requisition)
    await db.flush()
    db.add(RequisitionItem(
        requisition_id=requisition.id, item_id=item.id, item_code=item.code,
        item_name=item.name, uom_code="NOS", quantity=1000,
    ))
    rfq = RFQ(
        rfq_no="RFQ/2026/0001", requisition_id=requisition.id,
        requisition_no=requisition.req_no, status=RFQStatus.DRAFT.value,
        total_items=1, created_by_id=creator.id, created_by_name=creator.full_name,
    )
    db.add(rfq)
    await db.flush()
    line = RFQItem(
        rfq_id=rfq.id, item_id=item.id, item_code=item.code, item_name=item.name,
        uom_code="NOS", quantity=500,
    )
    db.add(line)
    await db.commit()

    updated = await service.set_rfq_quantities(
        db, rfq.id,
        RFQQuantitiesIn(lines=[RFQQuantityIn(id=line.id, quantity=600)]), creator,
    )
    assert float(updated.items[0].quantity) == 600

    with pytest.raises(ValidationError, match="maximum 1000"):
        await service.set_rfq_quantities(
            db, rfq.id,
            RFQQuantitiesIn(lines=[RFQQuantityIn(id=line.id, quantity=1001)]), creator,
        )


async def test_split_award_creates_quantity_limited_purchase_orders(db):
    item, first_vendor, _indent, _ind_item, creator, _approver = await _world(db)
    second_vendor = Vendor(code="V-2", name="Bravo", gstin="GST2", is_active=True)
    db.add(second_vendor)
    await db.flush()

    rfq = RFQ(
        organization_id=2, organization_code="B-01", organization_name="BAVYA",
        org_department_id=2, org_department_name="HUMAN RESOURCES",
        rfq_no="RFQ/2026/SPLIT", status=RFQStatus.PUBLISHED.value,
        total_items=1, vendor_count=2,
        created_by_id=creator.id, created_by_name=creator.full_name,
    )
    db.add(rfq)
    await db.flush()
    rfq_line = RFQItem(
        rfq_id=rfq.id, line_no=1, item_id=item.id, item_code=item.code,
        item_name=item.name, uom_code="NOS", quantity=10,
    )
    db.add(rfq_line)
    quotes = []
    for vendor in (first_vendor, second_vendor):
        db.add(RFQVendor(
            rfq_id=rfq.id, vendor_id=vendor.id, vendor_name=vendor.name,
            mapped_item_ids=[item.id], item_quantities={str(item.id): 10},
        ))
        quote = Quotation(
            quotation_no=f"Q-{vendor.code}", rfq_id=rfq.id, rfq_no=rfq.rfq_no,
            vendor_id=vendor.id, vendor_name=vendor.name,
            status=QuotationStatus.SUBMITTED.value, sub_total=1000,
            discount_amount=50, tax_amount=180, freight_amount=100,
            grand_total=1230,
        )
        db.add(quote)
        await db.flush()
        quotes.append(quote)
        db.add(QuotationItem(
            quotation_id=quote.id, line_no=1, rfq_item_id=rfq_line.id,
            item_id=item.id, item_code=item.code, item_name=item.name,
            uom_code="NOS", quantity=10, rate=100, tax_percent=18,
            amount=1000,
        ))
    await db.commit()

    # Freeze Prices (2026-09-26): an award is only legal on a frozen comparison.
    rfq.is_price_frozen = True
    await db.commit()

    awarded = await service.award_rfq(db, rfq.id, AwardIn(allocations=[
        {"item_id": item.id, "vendor_id": first_vendor.id, "quantity": 4},
        {"item_id": item.id, "vendor_id": second_vendor.id, "quantity": 6},
    ], generate_pos=False), creator)
    assert awarded.awarded_vendor_id is None
    assert all(quote.status == QuotationStatus.ACCEPTED.value for quote in quotes)

    first_po = await service.create_po_from_quotation(
        db, quotes[0].id, POFromQuotationIn(), creator)
    second_po = await service.create_po_from_quotation(
        db, quotes[1].id, POFromQuotationIn(), creator)
    assert [float(first_po.items[0].quantity), float(second_po.items[0].quantity)] == [4, 6]
    assert [float(first_po.freight_amount), float(second_po.freight_amount)] == [40, 60]
    assert [float(first_po.discount_amount), float(second_po.discount_amount)] == [20, 30]

    # The comparison must report the quantities on live orders, not the static award
    # JSON. A rejected/cancelled PO therefore releases its share automatically and a
    # buyer can re-share it without maintaining a second allocation by hand.
    live = await service.get_rfq(db, rfq.id)
    live_by_vendor = {row.vendor_id: row.live_allocated_quantities for row in live.vendors}
    assert live_by_vendor[first_vendor.id] == {str(item.id): 4.0}
    assert live_by_vendor[second_vendor.id] == {str(item.id): 6.0}

    first_po.status = POStatus.REJECTED.value
    await db.commit()
    live = await service.get_rfq(db, rfq.id)
    live_by_vendor = {row.vendor_id: row.live_allocated_quantities for row in live.vendors}
    assert live_by_vendor[first_vendor.id] is None
    assert live_by_vendor[second_vendor.id] == {str(item.id): 6.0}

    # The other supplier's rejected order can be re-shared to Bravo even though
    # Bravo's first PO remains live. The saved award grows from 6 to 10, while the
    # next PO contains only the extra 4; neither the first PO nor its commercial
    # amounts are duplicated.
    # The re-award stays on the frozen comparison (the freeze flag was never
    # cleared; unfreezing would also block the PO below).
    await service.award_rfq(db, rfq.id, AwardIn(allocations=[
        {"item_id": item.id, "vendor_id": second_vendor.id, "quantity": 10},
    ], generate_pos=False), creator)
    balance_po = await service.create_po_from_quotation(
        db, quotes[1].id, POFromQuotationIn(), creator)
    assert float(balance_po.items[0].quantity) == 4
    assert float(balance_po.freight_amount) == 40
    assert float(balance_po.discount_amount) == 20

    live = await service.get_rfq(db, rfq.id)
    live_by_vendor = {row.vendor_id: row.live_allocated_quantities for row in live.vendors}
    assert live_by_vendor[second_vendor.id] == {str(item.id): 10.0}
    bravo_orders = [row for row in live.purchase_orders
                    if row.quotation_id == quotes[1].id]
    assert [row.item_quantities for row in bravo_orders] == [
        {str(item.id): 6.0}, {str(item.id): 4.0},
    ]


async def test_split_award_auto_generates_pos_for_each_supplier(db):
    item, first_vendor, _indent, _ind_item, creator, _approver = await _world(db)
    second_vendor = Vendor(code="V-3", name="Charlie", gstin="GST3", is_active=True)
    db.add(second_vendor)
    await db.flush()

    rfq = RFQ(
        rfq_no="RFQ/2026/AUTO_PO", status=RFQStatus.PUBLISHED.value,
        organization_id=2, organization_code="B-01", organization_name="BAVYA",
        org_department_id=2, org_department_name="HUMAN RESOURCES",
        total_items=1, vendor_count=2, is_price_frozen=True,
        created_by_id=creator.id, created_by_name=creator.full_name,
    )
    db.add(rfq)
    await db.flush()
    rfq_line = RFQItem(
        rfq_id=rfq.id, line_no=1, item_id=item.id, item_code=item.code,
        item_name=item.name, uom_code="NOS", quantity=10,
    )
    db.add(rfq_line)
    for vendor in (first_vendor, second_vendor):
        db.add(RFQVendor(
            rfq_id=rfq.id, vendor_id=vendor.id, vendor_name=vendor.name,
            mapped_item_ids=[item.id], item_quantities={str(item.id): 10},
        ))
        quote = Quotation(
            quotation_no=f"Q-AUTO-{vendor.code}", rfq_id=rfq.id, rfq_no=rfq.rfq_no,
            vendor_id=vendor.id, vendor_name=vendor.name,
            status=QuotationStatus.SUBMITTED.value, sub_total=1000,
            discount_amount=50, tax_amount=180, freight_amount=100,
            grand_total=1230,
        )
        db.add(quote)
        await db.flush()
        db.add(QuotationItem(
            quotation_id=quote.id, line_no=1, rfq_item_id=rfq_line.id,
            item_id=item.id, item_code=item.code, item_name=item.name,
            uom_code="NOS", quantity=10, rate=100, tax_percent=18,
            amount=1000,
        ))
    await db.commit()

    awarded_rfq = await service.award_rfq(db, rfq.id, AwardIn(allocations=[
        {"item_id": item.id, "vendor_id": first_vendor.id, "quantity": 3},
        {"item_id": item.id, "vendor_id": second_vendor.id, "quantity": 7},
    ], generate_pos=True), creator)

    assert awarded_rfq.status == RFQStatus.AWARDED.value
    pos = awarded_rfq.purchase_orders
    assert len(pos) == 2
    pos_by_vendor = {po.vendor_id: po for po in pos}
    assert pos_by_vendor[first_vendor.id].item_quantities == {str(item.id): 3.0}
    assert pos_by_vendor[second_vendor.id].item_quantities == {str(item.id): 7.0}


async def _allow_po_view(monkeypatch):
    from app.platform.rbac import permissions as perms

    async def _perms(*_args, **_kwargs):
        return {perms.PO_VIEW, perms.PO_CREATE}
    monkeypatch.setattr(service, "get_user_permissions", _perms)


async def test_copy_po_template_cleans_against_masters_and_saves_nothing(db, monkeypatch):
    from sqlalchemy import func, select
    from app.modules.procurement.models import PurchaseOrder

    await _allow_po_view(monkeypatch)
    item, vendor, indent, ind_item, creator, _ = await _world(db)
    retired = Item(code="IT-2", name="Old washer", uom_code="NOS", is_active=False)
    db.add(retired)
    await db.flush()
    data = _po_data(vendor.id, item.id, ind_item.id)
    data.discount_amount = 500
    po = await service.create_po_from_indent(db, indent.id, data, creator)
    item.tax_percent = 12
    db.add(service.POItem(po_id=po.id, item_id=retired.id, item_code="IT-2",
                          item_name="Old washer", uom_code="NOS", quantity=1, rate=5000,
                          tax_percent=18, amount=5000))
    await db.commit()
    count = (await db.execute(select(func.count(PurchaseOrder.id)))).scalar()

    copy = await service.copy_po_template(db, po.id, creator)

    assert copy["source_po_no"] == po.po_no
    assert copy["vendor_id"] == vendor.id
    assert [line["item_id"] for line in copy["lines"]] == [item.id]
    assert copy["lines"][0]["tax_percent"] == 12          # today's master, not the PO's
    assert "indent_id" not in copy and "indent_item_id" not in copy["lines"][0]
    assert any("Old washer" in w for w in copy["warnings"])
    assert copy["discount_amount"] == 500                 # still under the 1000 left
    assert (await db.execute(select(func.count(PurchaseOrder.id)))).scalar() == count


async def test_copy_po_blanks_blacklisted_vendor_and_records_source_on_save(db, monkeypatch):
    await _allow_po_view(monkeypatch)
    item, vendor, indent, ind_item, creator, _ = await _world(db)
    po = await service.create_po_from_indent(
        db, indent.id, _po_data(vendor.id, item.id, ind_item.id), creator)
    vendor.is_blacklisted = True
    await db.commit()

    copy = await service.copy_po_template(db, po.id, creator)
    assert copy["vendor_id"] is None and copy["warnings"]

    other = Vendor(code="V-2", name="Beta", is_active=True)
    db.add(other)
    await db.commit()
    new = await service.create_po(db, POCreate(
        vendor_id=other.id, billing_address="Plant", shipping_address="Store",
        copied_from_po_id=po.id, organization_id=2, org_department_id=2,
        lines=[POLineIn(**{k: copy["lines"][0][k]
                           for k in ("item_id", "quantity", "rate", "tax_percent")})],
    ), creator)
    assert new.po_no != po.po_no and new.status == POStatus.DRAFT.value
    assert new.copied_from_po_id == po.id and new.copied_from_po_no == po.po_no
    assert new.indent_id is None
    assert new.org_department_name == "HUMAN RESOURCES" and new.project_id is None


async def test_direct_po_needs_exactly_one_of_project_or_department(db):
    """2026-11-04: a hand-raised order is booked to a project OR a department."""
    from app.core.exceptions import ValidationError

    item, vendor, _indent, _ind_item, creator, _ = await _world(db)

    def order(**booking):
        return POCreate(vendor_id=vendor.id, organization_id=2, billing_address="Plant",
                        shipping_address="Store", **booking,
                        lines=[POLineIn(item_id=item.id, quantity=1, rate=10,
                                        tax_percent=0)])

    with pytest.raises(ValidationError):
        await service.create_po(db, order(), creator)
    po = await service.create_po(db, order(org_department_id=2), creator)
    assert po.org_department_name == "HUMAN RESOURCES"
    # The department fills the series' project slot — never NA.
    assert "/NA/" not in po.po_no


async def test_edit_draft_po_rewrites_lines_vendor_and_refuses_past_draft(db):
    from app.modules.procurement.schemas import POAmendLineIn, POCorrectionIn

    item, vendor, indent, ind_item, creator, _ = await _world(db)
    po = await service.create_po_from_indent(
        db, indent.id, _po_data(vendor.id, item.id, ind_item.id), creator)
    other = Vendor(code="V-2", name="Beta", is_active=True)
    extra = Item(code="IT-3", name="Nut", uom_code="NOS")
    db.add_all([other, extra])
    await db.commit()
    kept = po.items[0].id

    edited = await service.edit_draft_po(db, po.id, POCorrectionIn(
        vendor_id=other.id, billing_address="Plant", shipping_address="Store",
        lines=[POAmendLineIn(id=kept, item_id=item.id, quantity=4, rate=100, tax_percent=0),
               POAmendLineIn(item_id=extra.id, quantity=2, rate=50, tax_percent=0)],
    ), creator)
    assert edited.vendor_name == "Beta" and edited.status == POStatus.DRAFT.value
    assert sorted(float(i.quantity) for i in edited.items) == [2, 4]
    assert float(edited.total_amount) == 500

    po_row = await db.get(service.PurchaseOrder, po.id)
    po_row.status = POStatus.PENDING_APPROVAL.value
    await db.commit()
    with pytest.raises(ValidationError):
        await service.edit_draft_po(db, po.id, POCorrectionIn(
            lines=[POAmendLineIn(item_id=item.id, quantity=1, rate=1)]), creator)
