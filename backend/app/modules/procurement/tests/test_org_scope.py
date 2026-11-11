"""Each value comes from the document before, or is selected on this one. Never NA.

Older documents, with no organisation, are left exactly as they were.
"""
import pytest
from sqlalchemy import select

from app.core.exceptions import ValidationError
from app.modules.inventory.models import MaterialRequest, MaterialRequestItem
from app.modules.procurement import consolidation, service
from app.platform.doc_numbering import scope as org_scope
from app.modules.procurement.models import (
    Quotation, QuotationItem, RFQ, RFQItem, RFQVendor, Requisition,
)
from app.modules.procurement.schemas import (
    ConsolidationCreate, POAmendLineIn, POCorrectionIn, POCreate, POFromQuotationIn,
    POHeaderUpdate, POLineIn, ReqCreate, ReqLineIn, RFQCreate, RFQLineIn, RFQUpdate,
)
from app.modules.procurement.tests.test_procurement import _world
from app.shared.enums import (
    MRStatus, POStatus, QuotationStatus, RFQStatus, RequisitionStatus,
)
from app.shared.models.base import utcnow
from app.shared.models.master import OrgDepartment, Organization, Project
from app.shared.numbering import selectable_fiscal_years

pytestmark = pytest.mark.asyncio

BAVYA, OTHER, HR = 2, 1, 2


async def _setup(db):
    item, vendor, indent, ind_item, creator, approver = await _world(db)
    db.add_all([
        Organization(id=OTHER, code="S-ORG-01", name="Sample Org", is_active=True,
                     synced_at=utcnow()),
        OrgDepartment(id=1, code="S-DEP-01", name="Sample Dept", is_active=True,
                      synced_at=utcnow()),
        Project(id=77, code="P-104", name="104", is_active=True),
    ])
    await db.commit()
    return item, vendor, indent, ind_item, creator


def _req(item_id, **booking):
    return ReqCreate(**booking, lines=[ReqLineIn(item_id=item_id, quantity=5)])


def _po(vendor_id, item_id, **booking):
    return POCreate(vendor_id=vendor_id, billing_address="Plant", shipping_address="Store",
                    **booking,
                    lines=[POLineIn(item_id=item_id, quantity=1, rate=10, tax_percent=0)])


async def test_direct_documents_must_select_and_the_number_follows(db):
    item, vendor, *_rest, creator = await _setup(db)

    with pytest.raises(ValidationError, match="organisation"):
        await service.create_requisition(db, _req(item.id, project_id=77), creator)
    with pytest.raises(ValidationError, match="project or the department"):
        await service.create_requisition(db, _req(item.id, organization_id=BAVYA), creator)

    req = await service.create_requisition(
        db, _req(item.id, organization_id=BAVYA, project_id=77), creator)
    assert req.req_no.startswith("BAV/104/") and "NA" not in req.req_no
    assert req.organization_name == "BAVYA" and req.organization_code == "B-01"

    by_department = await service.create_requisition(
        db, _req(item.id, organization_id=OTHER, org_department_id=HR), creator)
    assert by_department.req_no.startswith("SAM/HUM/")

    po = await service.create_po(db, _po(vendor.id, item.id, organization_id=BAVYA,
                                         org_department_id=HR), creator)
    assert po.po_no.startswith("BAV/HUM/") and po.project_id is None
    assert po.org_department_name == "HUMAN RESOURCES"


async def test_each_combination_counts_on_its_own(db):
    item, vendor, *_rest, creator = await _setup(db)
    make = lambda **booking: service.create_po(  # noqa: E731
        db, _po(vendor.id, item.id, **booking), creator)
    first = await make(organization_id=BAVYA, project_id=77)
    second = await make(organization_id=OTHER, project_id=77)
    third = await make(organization_id=BAVYA, project_id=77)
    assert first.po_no.endswith("PO0001") and first.po_no.startswith("BAV/104/")
    assert second.po_no.endswith("PO0001") and second.po_no.startswith("SAM/104/")
    assert third.po_no.endswith("PO0002")


async def test_a_draft_renumbers_when_the_selection_moves_and_only_then(db):
    item, vendor, *_rest, creator = await _setup(db)
    po = await service.create_po(db, _po(vendor.id, item.id, organization_id=BAVYA,
                                         project_id=77), creator)
    first = po.po_no

    same = await service.update_po_header(
        db, po.id, POHeaderUpdate(organization_id=BAVYA, project_id=77), creator)
    assert same.po_no == first

    moved = await service.update_po_header(
        db, po.id, POHeaderUpdate(organization_id=BAVYA, org_department_id=HR), creator)
    assert moved.po_no.startswith("BAV/HUM/") and moved.po_no != first
    assert moved.project_id is None


async def test_the_po_edit_screen_renumbers_a_draft_too(db):
    """The draft editor saves through `_rewrite_po`, not `update_po_header`."""
    item, vendor, *_rest, creator = await _setup(db)
    po = await service.create_po(db, _po(vendor.id, item.id, organization_id=BAVYA,
                                         project_id=77), creator)
    edited = await service.edit_draft_po(db, po.id, POCorrectionIn(
        vendor_id=vendor.id, billing_address="Plant", shipping_address="Store",
        organization_id=OTHER, org_department_id=HR,
        lines=[POAmendLineIn(id=po.items[0].id, item_id=item.id, quantity=1, rate=10,
                             tax_percent=0)],
    ), creator)
    assert edited.po_no.startswith("SAM/HUM/")
    assert edited.organization_name == "Sample Org"


async def test_everything_is_locked_once_submitted(db):
    item, vendor, *_rest, creator = await _setup(db)
    po = await service.create_po(db, _po(vendor.id, item.id, organization_id=BAVYA,
                                         project_id=77), creator)
    number = po.po_no
    po.status = POStatus.RETURNED_FOR_CORRECTION.value
    await db.commit()
    with pytest.raises(ValidationError, match="fixed once"):
        await service._apply_po_header(
            db, po, POHeaderUpdate(organization_id=OTHER, project_id=77))
    # Sending the same values back is not a change.
    await service._apply_po_header(db, po, POHeaderUpdate(organization_id=BAVYA, project_id=77))
    assert po.po_no == number


async def test_the_chain_carries_it_and_locks_the_organisation(db):
    item, vendor, *_rest, creator = await _setup(db)
    req = await service.create_requisition(
        db, _req(item.id, organization_id=BAVYA, org_department_id=HR, project_id=77), creator)
    req.status = RequisitionStatus.APPROVED.value
    await db.commit()

    with pytest.raises(ValidationError, match="cannot be changed"):
        await service.create_rfq(db, RFQCreate(
            requisition_id=req.id, organization_id=OTHER,
            lines=[RFQLineIn(item_id=item.id, quantity=5)]), creator)

    rfq = await service.create_rfq(db, RFQCreate(
        requisition_id=req.id,
        lines=[RFQLineIn(item_id=item.id, quantity=5)]), creator)
    assert rfq.rfq_no.startswith("BAV/104/")
    assert rfq.organization_name == "BAVYA"
    assert rfq.org_department_name == "HUMAN RESOURCES"

    with pytest.raises(ValidationError, match="comes from"):
        await service.update_rfq(db, rfq.id, RFQUpdate(organization_id=OTHER), creator)


async def _awarded_rfq(db, vendor, item, **fields):
    rfq = RFQ(rfq_no="OLD/RFQ/1", status=RFQStatus.AWARDED.value, is_price_frozen=True,
              total_items=1, **fields)
    db.add(rfq)
    await db.flush()
    line = RFQItem(rfq_id=rfq.id, line_no=1, item_id=item.id, item_code=item.code,
                   item_name=item.name, uom_code="NOS", quantity=5)
    db.add(line)
    await db.flush()
    db.add(RFQVendor(rfq_id=rfq.id, vendor_id=vendor.id, vendor_name=vendor.name))
    quote = Quotation(quotation_no="OLD/QUO/1", rfq_id=rfq.id, rfq_no=rfq.rfq_no,
                      vendor_id=vendor.id, vendor_name=vendor.name,
                      status=QuotationStatus.ACCEPTED.value)
    db.add(quote)
    await db.flush()
    db.add(QuotationItem(quotation_id=quote.id, line_no=1, rfq_item_id=line.id,
                         item_id=item.id, item_code=item.code, item_name=item.name,
                         uom_code="NOS", quantity=5, rate=10, amount=50))
    await db.commit()
    return rfq, quote


async def test_po_from_a_quotation_copies_a_department_only_rfq(db):
    """The old defect: the department did not travel, so this printed .../NA/..."""
    item, vendor, *_rest, creator = await _setup(db)
    _rfq, quote = await _awarded_rfq(
        db, vendor, item, organization_id=BAVYA, organization_code="B-01",
        organization_name="BAVYA", org_department_id=HR,
        org_department_name="HUMAN RESOURCES")
    po = await service.create_po_from_quotation(db, quote.id, POFromQuotationIn(), creator)
    assert po.po_no.startswith("BAV/HUM/")
    assert po.org_department_name == "HUMAN RESOURCES"


async def test_po_from_a_quotation_takes_the_buyers_selection_in_its_number(db):
    item, vendor, *_rest, creator = await _setup(db)
    _rfq, quote = await _awarded_rfq(
        db, vendor, item, organization_id=BAVYA, organization_name="BAVYA",
        organization_code="B-01", project_id=77, project_name="104")
    po = await service.create_po_from_quotation(
        db, quote.id, POFromQuotationIn(org_department_id=HR), creator)
    assert po.po_no.startswith("BAV/HUM/") and po.project_id is None


async def test_an_older_rfq_needs_the_organisation_selected_on_its_po(db):
    item, vendor, *_rest, creator = await _setup(db)
    _rfq, quote = await _awarded_rfq(db, vendor, item, project_id=77, project_name="104")
    with pytest.raises(org_scope.OrganisationRequired):
        await service.create_po_from_quotation(db, quote.id, POFromQuotationIn(), creator)
    po = await service.create_po_from_quotation(
        db, quote.id, POFromQuotationIn(organization_id=BAVYA), creator)
    assert po.po_no.startswith("BAV/104/")


async def test_a_draft_raised_by_mr_approval_holds_until_it_is_selected(db):
    item, _vendor, *_rest, creator = await _setup(db)
    mr = MaterialRequest(mr_no="MR-1", status=MRStatus.APPROVED.value, project_id=77,
                         project_name="104")
    db.add(mr)
    await db.flush()
    db.add(MaterialRequestItem(mr_id=mr.id, item_id=item.id, item_code=item.code,
                               item_name=item.name, uom_code="NOS", quantity=5))
    await db.commit()

    req = await service.create_requisition_from_mr(db, mr.id, creator)
    assert org_scope.is_holding(req.req_no) and "NA" not in req.req_no.split("-")[0]
    assert req.organization_id is None

    with pytest.raises(ValidationError, match="Select the organisation"):
        await service.submit_requisition(db, req.id, creator)

    numbered = await service.update_requisition(
        db, req.id, ReqCreate(organization_id=BAVYA, project_id=77,
                              lines=[ReqLineIn(item_id=item.id, quantity=5)]), creator)
    assert numbered.req_no.startswith("BAV/104/")


async def test_a_sheet_refuses_two_organisations_and_carries_one(db):
    item, _vendor, *_rest, creator = await _setup(db)

    async def approved(**booking):
        req = await service.create_requisition(db, _req(item.id, **booking), creator)
        req.status = RequisitionStatus.APPROVED.value
        await db.commit()
        return req.id

    bavya_a = await approved(organization_id=BAVYA, project_id=77)
    bavya_b = await approved(organization_id=BAVYA, project_id=77)
    other = await approved(organization_id=OTHER, project_id=77)

    with pytest.raises(ValidationError, match="different organisations"):
        await consolidation.create_consolidation(
            db, ConsolidationCreate(requisition_ids=[bavya_a, other]), creator)

    sheet = await consolidation.create_consolidation(
        db, ConsolidationCreate(requisition_ids=[bavya_a, bavya_b]), creator)
    assert sheet.cons_no.startswith("BAV/104/")
    assert sheet.organization_name == "BAVYA"


async def test_an_older_document_is_left_exactly_as_it_was(db):
    """No organisation on it: its number, its fields and its rules do not change."""
    item, _vendor, *_rest, creator = await _setup(db)
    req = Requisition(req_no="NA/104/2026-27/REQ0001", status=RequisitionStatus.DRAFT.value,
                      project_id=77, project_name="104", created_by_id=creator.id)
    db.add(req)
    await db.commit()
    edited = await service.update_requisition(
        db, req.id, ReqCreate(project_id=77, company_name="BHS",
                              lines=[ReqLineIn(item_id=item.id, quantity=2)]), creator)
    assert edited.req_no == "NA/104/2026-27/REQ0001"
    assert edited.organization_id is None and edited.company_name == "BHS"
    still = (await db.execute(select(Requisition).where(Requisition.id == req.id))).scalars().one()
    assert still.req_no == "NA/104/2026-27/REQ0001"


async def test_the_year_can_be_picked_and_a_linked_document_takes_todays(db):
    item, vendor, *_rest, creator = await _setup(db)
    current, previous = selectable_fiscal_years()

    req = await service.create_requisition(
        db, _req(item.id, organization_id=BAVYA, project_id=77, fiscal_year=previous), creator)
    assert req.fiscal_year == previous and f"/{previous}/" in req.req_no
    with pytest.raises(ValidationError, match="cannot be used"):
        await service.create_requisition(
            db, _req(item.id, organization_id=BAVYA, project_id=77, fiscal_year="2001-02"), creator)

    plain = await service.create_po(db, _po(vendor.id, item.id, organization_id=BAVYA,
                                            project_id=77), creator)
    assert plain.fiscal_year == current and f"/{current}/" in plain.po_no

    rfq = RFQ(rfq_no="BAV/104/x/RFQ1", status=RFQStatus.PUBLISHED.value, organization_id=BAVYA,
              organization_name="BAVYA", project_name="104", fiscal_year=previous)
    db.add(rfq)
    await db.flush()
    assert org_scope.number_args(rfq, carried=True)["fiscal_year"] is None
    assert org_scope.number_args(rfq)["fiscal_year"] == previous


async def test_moving_the_year_on_a_draft_renumbers_it_and_submitting_fixes_it(db):
    item, _vendor, *_rest, creator = await _setup(db)
    current, previous = selectable_fiscal_years()
    req = await service.create_requisition(
        db, _req(item.id, organization_id=BAVYA, project_id=77), creator)
    first = req.req_no

    same = await service.update_requisition(
        db, req.id, _req(item.id, organization_id=BAVYA, project_id=77, fiscal_year=current), creator)
    assert same.req_no == first

    moved = await service.update_requisition(
        db, req.id, _req(item.id, organization_id=BAVYA, project_id=77, fiscal_year=previous), creator)
    assert f"/{previous}/" in moved.req_no and moved.fiscal_year == previous

    with pytest.raises(ValidationError, match="fixed once"):
        org_scope.assert_lockable(moved, moved.req_no, is_draft=False, source_has_org=False,
                                  fiscal_year=current, given={"fiscal_year"})
