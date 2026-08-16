"""Procurement business logic. May import indents (backward in the chain);
never imports logistics. Approvals go only through the workflow engine.

Two audiences read this module. Everything above `Vendor portal` is for an employee
holding a `procurement.*` permission. Everything below it is reached by a vendor —
somebody outside the company — and every one of those functions takes the vendor id
from the token rather than from the request body, so a vendor cannot ask about an RFQ
they were not invited to by editing a URL.
"""
import logging
import secrets
from decimal import Decimal
from types import SimpleNamespace

from sqlalchemy import func, select, true
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.exceptions import AuthenticationError, NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.core.security import create_access_token, hash_password, verify_password
from app.modules.indents import service as indent_service
from app.modules.indents.models import IndentItem
from app.modules.inventory.models import MaterialRequest, MaterialRequestItem
from app.modules.procurement.models import (
    DespatchNote, DespatchNoteItem, POItem, PurchaseConsolidation,
    PurchaseConsolidationSource, PurchaseOrder, Quotation, QuotationItem, Requisition,
    RequisitionItem, RFQ, RFQItem, RFQVendor, VendorUser,
)
from app.modules.procurement.schemas import (
    AwardIn, DespatchNoteIn, POCreate, POFromQuotationIn, QuoteSubmit, ReqCreate,
    RFQCreate, RFQUpdate, VendorAccountIn,
)
from app.modules.procurement import consolidation
from app.platform.workflow import engine
from app.shared import evaluation
from app.shared.scope import scope_condition

logger = logging.getLogger(__name__)
from app.shared.enums import (
    ConsolidationStatus, DespatchNoteStatus, DocType, IndentStatus, InstanceStatus,
    MRStatus, POStatus, QuotationStatus, RequisitionStatus, RFQStatus,
)
from app.shared.models.base import utcnow
from app.shared.models.master import Item, Vendor, VendorItem
from app.shared.numbering import next_number


def _d(value) -> Decimal:
    return Decimal(str(value))


async def create_po_from_indent(db: AsyncSession, indent_id: int, data: POCreate, user) -> PurchaseOrder:
    indent = await indent_service.get_indent(db, indent_id)
    # An approved indent that the availability check could not fill lands in
    # PENDING_PROCUREMENT or PARTIALLY_FULFILLED. Those are still approved indents --
    # they are in fact the ones that most need buying -- so they convert to a PO too.
    BUYABLE = (
        IndentStatus.APPROVED.value,
        IndentStatus.PARTIALLY_ORDERED.value,
        IndentStatus.PENDING_PROCUREMENT.value,
        IndentStatus.PARTIALLY_FULFILLED.value,
    )
    if indent.status not in BUYABLE:
        raise ValidationError("Only approved indents can be converted to a PO")
    if not data.lines:
        raise ValidationError("PO must have at least one line")

    approved_mr_items: list[MaterialRequestItem] = []
    if indent.status in {
        IndentStatus.PENDING_PROCUREMENT.value,
        IndentStatus.PARTIALLY_FULFILLED.value,
    }:
        approved_mr_items = list((await db.execute(
            select(MaterialRequestItem)
            .join(MaterialRequest, MaterialRequest.id == MaterialRequestItem.mr_id)
            .where(
                MaterialRequest.indent_id == indent.id,
                MaterialRequest.status == MRStatus.APPROVED.value,
            )
            .order_by(MaterialRequestItem.id)
        )).scalars().all())
        if not approved_mr_items:
            raise ValidationError(
                "The shortage Material Request must be approved before Procurement"
            )

    vendor = await db.get(Vendor, data.vendor_id)
    if not vendor:
        raise ValidationError(f"Unknown vendor {data.vendor_id}")

    items_map = {i.id: i for i in (await db.execute(
        select(Item).where(Item.id.in_([l.item_id for l in data.lines]))
    )).scalars().all()}

    po = PurchaseOrder(
        po_no=await next_number(db, "po", project=getattr(indent, "project_name", None)),
        po_date=utcnow().date(),
        expected_date=data.expected_date,
        indent_id=indent.id,
        indent_no=indent.indent_no,
        vendor_id=vendor.id,
        vendor_name=vendor.name,
        vendor_gstin=vendor.gstin,
        created_by_id=user.id,
        created_by_name=user.full_name,
        office_id=indent.office_id,
        # Indents now snapshot the HCM office; the old facility fields were removed.
        # Warehouse will choose the physical receipt location in its own module.
        facility_id=None,
        facility_name=indent.office_name,
        status=POStatus.DRAFT.value,
        remarks=data.remarks,
    )
    db.add(po)
    await db.flush()

    sub_total = tax_total = Decimal("0")
    for line in data.lines:
        item = items_map.get(line.item_id)
        if not item:
            raise ValidationError(f"Unknown item id: {line.item_id}")
        matching_mr_items = [
            mr_line for mr_line in approved_mr_items
            if mr_line.indent_item_id == line.indent_item_id
            and mr_line.item_id == line.item_id
        ]
        if approved_mr_items:
            remaining = sum(
                _d(mr_line.quantity) - _d(mr_line.ordered_quantity or 0)
                for mr_line in matching_mr_items
            )
            if not matching_mr_items or _d(line.quantity) > remaining:
                raise ValidationError(
                    f"PO quantity for item {item.code} exceeds the approved MR shortage"
                )
        amount = _d(line.quantity) * _d(line.rate)
        tax = amount * _d(line.tax_percent) / _d(100)
        sub_total += amount
        tax_total += tax
        db.add(POItem(
            po_id=po.id, indent_item_id=line.indent_item_id, item_id=item.id,
            item_code=item.code, item_name=item.name, uom_code=item.uom_code,
            quantity=_d(line.quantity), rate=_d(line.rate),
            tax_percent=_d(line.tax_percent), amount=amount,
        ))
        # roll the ordered quantity up onto the indent line
        if line.indent_item_id:
            ind_item = await db.get(IndentItem, line.indent_item_id)
            if ind_item:
                ind_item.ordered_quantity = (ind_item.ordered_quantity or 0) + _d(line.quantity)
        to_apply = _d(line.quantity)
        for mr_line in matching_mr_items:
            if to_apply <= 0:
                break
            available = _d(mr_line.quantity) - _d(mr_line.ordered_quantity or 0)
            applied = min(available, to_apply)
            mr_line.ordered_quantity = _d(mr_line.ordered_quantity or 0) + applied
            to_apply -= applied

    po.sub_total = sub_total
    po.tax_amount = tax_total
    po.total_amount = sub_total + tax_total

    indent.status = IndentStatus.ORDERED.value
    await db.commit()
    await db.refresh(po)
    return po


async def create_po_from_quotation(db: AsyncSession, quotation_id: int,
                                   data: POFromQuotationIn, user) -> PurchaseOrder:
    """Turn the awarded quotation into a purchase order, lines, rates and tax and all.

    The last hop of the buying chain, and the one that was missing: `award_rfq` picks a
    winner and says the PO is "a separate, approved act" — but the only way to raise one
    was `from-indent`, which knows nothing about the offer. So the winning vendor's
    rates were retyped, and nothing connected the PO to the RFQ that chose it.

    Written from the QUOTATION, never from the RFQ: the RFQ says what was asked for, the
    quotation says what was offered, and a purchase order is an acceptance of an offer.
    Discount is applied before tax, exactly as the vendor's own line total was computed.

    Every quantity is rolled BACKWARD as it goes — the requisition line, then the
    material request line it came from — so a chain bought in two tenders shows what is
    still owed rather than going quiet after the first one.
    """
    quote = (await db.execute(
        select(Quotation)
        .options(selectinload(Quotation.items))
        .where(Quotation.id == quotation_id)
    )).scalars().first()
    if quote is None:
        raise NotFoundError(f"Quotation {quotation_id} not found")

    rfq = await db.get(RFQ, quote.rfq_id)
    if rfq is None:
        raise NotFoundError(f"RFQ {quote.rfq_id} not found")
    if rfq.status != RFQStatus.AWARDED.value:
        raise ValidationError(
            f"{rfq.rfq_no} is {rfq.status}; award it before raising the purchase order")
    if quote.status != QuotationStatus.ACCEPTED.value:
        raise ValidationError(
            f"{quote.quotation_no} did not win {rfq.rfq_no}; only the awarded "
            "quotation becomes a purchase order")

    existing = await db.scalar(
        select(PurchaseOrder.po_no).where(
            PurchaseOrder.quotation_id == quote.id,
            PurchaseOrder.status != POStatus.CANCELLED.value,
        ).limit(1)
    )
    if existing:
        raise ValidationError(f"{quote.quotation_no} already became {existing}")

    vendor = await db.get(Vendor, quote.vendor_id)
    if vendor is None:
        raise ValidationError(f"Unknown vendor {quote.vendor_id}")

    lines = [line for line in quote.items if _d(line.quantity) > 0]
    if not lines:
        raise ValidationError(f"{quote.quotation_no} has no quantities to order")

    requisition = (await db.get(Requisition, rfq.requisition_id)
                   if rfq.requisition_id else None)
    req_items = list((await db.execute(
        select(RequisitionItem)
        .where(RequisitionItem.requisition_id == requisition.id)
        .order_by(RequisitionItem.line_no)
    )).scalars().all()) if requisition else []

    # An indent only rides along when the whole requisition served exactly one. A
    # consolidated sheet serves many, and stamping one of them on the PO would say the
    # other indents were never ordered.
    indent_ids = {row.indent_id for row in req_items if row.indent_id}
    indent_id = next(iter(indent_ids)) if len(indent_ids) == 1 else None
    indent_no = next((row.indent_no for row in req_items
                      if row.indent_id == indent_id and row.indent_no), None)

    po = PurchaseOrder(
        po_no=await next_number(db, "po", project=rfq.project_name),
        po_date=utcnow().date(),
        expected_date=data.expected_date,
        indent_id=indent_id,
        indent_no=indent_no,
        requisition_id=requisition.id if requisition else None,
        requisition_no=requisition.req_no if requisition else None,
        rfq_id=rfq.id,
        rfq_no=rfq.rfq_no,
        quotation_id=quote.id,
        quotation_no=quote.quotation_no,
        vendor_id=vendor.id,
        vendor_name=vendor.name,
        vendor_gstin=vendor.gstin,
        created_by_id=user.id,
        created_by_name=user.full_name,
        office_id=None,
        facility_id=None,
        facility_name=rfq.warehouse_name,
        status=POStatus.DRAFT.value,
        remarks=data.remarks or f"Raised from {quote.quotation_no} against {rfq.rfq_no}",
    )
    db.add(po)
    await db.flush()

    # item -> the requisition lines still owed on it, in line order. Matched on the item
    # rather than on a line id because an RFQ line carries no pointer back to the
    # requisition line, and the consolidated sheet aggregates one line per (item, uom)
    # anyway — two requisition lines for the same item are one thing to buy.
    owed: dict[int, list[RequisitionItem]] = {}
    for row in req_items:
        owed.setdefault(row.item_id, []).append(row)

    sub_total = tax_total = Decimal("0")
    for index, line in enumerate(lines, start=1):
        quantity = _d(line.quantity)
        gross = quantity * _d(line.rate)
        amount = gross - gross * _d(line.discount_percent or 0) / _d(100)
        tax = amount * _d(line.tax_percent or 0) / _d(100)
        sub_total += amount
        tax_total += tax

        remaining = quantity
        indent_item_id = None
        for req_line in owed.get(line.item_id, []):
            if remaining <= 0:
                break
            free = _d(req_line.quantity) - _d(req_line.ordered_qty or 0)
            if free <= 0:
                continue
            applied = min(free, remaining)
            req_line.ordered_qty = _d(req_line.ordered_qty or 0) + applied
            remaining -= applied
            indent_item_id = indent_item_id or req_line.indent_item_id

        db.add(POItem(
            po_id=po.id, indent_item_id=indent_item_id, item_id=line.item_id,
            item_code=line.item_code, item_name=line.item_name,
            uom_code=line.uom_code, quantity=quantity, rate=_d(line.rate),
            tax_percent=_d(line.tax_percent or 0), amount=amount,
        ))

    # Freight is money the company pays for these goods, so it belongs on the order.
    # Left off, a PO raised from a quote quietly under-reads its own quotation.
    po.sub_total = sub_total + _d(quote.freight_amount or 0)
    po.tax_amount = tax_total
    po.total_amount = po.sub_total + tax_total

    if requisition is not None:
        await _close_requisition_if_ordered(db, requisition, req_items)
    if rfq.consolidation_id:
        await _close_sheet_if_ordered(db, rfq.consolidation_id)

    await db.commit()
    logger.info("purchase order %s raised from %s (%s, %d line(s))",
                po.po_no, quote.quotation_no, rfq.rfq_no, len(lines))
    return await get_po(db, po.id)


async def _close_requisition_if_ordered(db: AsyncSession, requisition: Requisition,
                                        req_items: list[RequisitionItem]) -> None:
    """Move the requisition — and the material request behind it — forward.

    ORDERED only when every line is fully covered. A requisition bought in two tenders
    must keep reading RFQ_RAISED in between, or the second half looks already done.
    """
    fully = all(_d(row.ordered_qty or 0) >= _d(row.quantity) for row in req_items)
    if requisition.status in (RequisitionStatus.APPROVED.value,
                              RequisitionStatus.CONSOLIDATED.value,
                              RequisitionStatus.RFQ_RAISED.value):
        requisition.status = (RequisitionStatus.ORDERED.value if fully
                              else RequisitionStatus.RFQ_RAISED.value)

    if not requisition.source_mr_id:
        return
    mr = await db.get(MaterialRequest, requisition.source_mr_id)
    if mr is None:
        return
    mr_items = list((await db.execute(
        select(MaterialRequestItem)
        .where(MaterialRequestItem.mr_id == mr.id)
        .order_by(MaterialRequestItem.line_no)
    )).scalars().all())

    # The MR is the document the field is waiting on, so its ordered quantities must
    # track the requisition's rather than being recomputed from the PO — the requisition
    # is what was actually tendered, and anything it dropped was never bought.
    by_item: dict[int, Decimal] = {}
    for row in req_items:
        by_item[row.item_id] = by_item.get(row.item_id, Decimal("0")) + _d(row.ordered_qty or 0)
    for row in mr_items:
        claimable = by_item.get(row.item_id, Decimal("0"))
        if claimable <= 0:
            continue
        applied = min(claimable, _d(row.quantity))
        # The pool is spent whether or not this line moved: two MR lines for the same
        # item must not both claim the same ordered quantity.
        by_item[row.item_id] = claimable - applied
        if applied > _d(row.ordered_quantity or 0):
            row.ordered_quantity = applied

    if mr.status == MRStatus.APPROVED.value and all(
        _d(row.ordered_quantity or 0) >= _d(row.quantity) for row in mr_items
    ):
        mr.status = MRStatus.ORDERED.value


async def _close_sheet_if_ordered(db: AsyncSession, consolidation_id: int) -> None:
    """A consolidated sheet closes only when every requisition on it is ORDERED."""
    sheet = await db.get(PurchaseConsolidation, consolidation_id)
    if sheet is None or sheet.status not in (ConsolidationStatus.APPROVED.value,
                                             ConsolidationStatus.RFQ_RAISED.value):
        return
    statuses = list((await db.execute(
        select(Requisition.status)
        .join(PurchaseConsolidationSource,
              PurchaseConsolidationSource.requisition_id == Requisition.id)
        .where(PurchaseConsolidationSource.consolidation_id == sheet.id)
    )).scalars().all())
    if statuses and all(value == RequisitionStatus.ORDERED.value for value in statuses):
        sheet.status = ConsolidationStatus.CLOSED.value


async def get_po(db: AsyncSession, po_id: int, user=None) -> PurchaseOrder:
    po = (await db.execute(select(PurchaseOrder).where(
            PurchaseOrder.id == po_id,
            # Same scope the list applies. A document hidden from the list must
            # not be readable by putting its id in the URL.
            await scope_condition(
                db, user,
                owner_col=PurchaseOrder.created_by_id,
                office_col=PurchaseOrder.office_id,
            ) if user is not None else true(),
        ))).scalar_one_or_none()
    if not po:
        raise NotFoundError(f"PO {po_id} not found")
    return po


async def list_pos(db: AsyncSession, params: PageParams, status: str | None = None,
                   vendor_id: int | None = None, user=None) -> dict:
    stmt = select(PurchaseOrder)
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user,
            owner_col=PurchaseOrder.created_by_id,
            office_col=PurchaseOrder.office_id,
        ))
    if status:
        stmt = stmt.where(PurchaseOrder.status == status)
    if vendor_id is not None:
        stmt = stmt.where(PurchaseOrder.vendor_id == vendor_id)
    return await paginate(db, stmt.order_by(PurchaseOrder.created_at.desc()), params)


async def submit_po(db: AsyncSession, po_id: int, user) -> PurchaseOrder:
    po = await get_po(db, po_id)
    if po.status != POStatus.DRAFT.value:
        raise ValidationError(f"Cannot submit a PO in {po.status} status")
    await engine.start(db, DocType.PO.value, po.id,
                       context={"total_amount": float(po.total_amount)}, user=user)
    po.status = POStatus.PENDING_APPROVAL.value
    await _refresh_current_approver(db, po)
    await db.commit()
    await db.refresh(po)
    return po


async def act_on_po(db: AsyncSession, po_id: int, action: str, comments: str, user) -> PurchaseOrder:
    po = await get_po(db, po_id)
    if po.status != POStatus.PENDING_APPROVAL.value:
        raise ValidationError(f"PO is not awaiting approval (status {po.status})")
    instance = await engine.act(db, DocType.PO.value, po.id, action, user, comments)
    if instance.status == InstanceStatus.APPROVED.value:
        po.status = POStatus.APPROVED.value
        po.approved_at = utcnow()
        po.current_approver_name = None
    elif instance.status == InstanceStatus.REJECTED.value:
        po.status = POStatus.REJECTED.value
        po.current_approver_name = None
    else:
        await _refresh_current_approver(db, po)
    await db.commit()
    await db.refresh(po)
    return po


async def send_to_vendor(db: AsyncSession, po_id: int, user) -> PurchaseOrder:
    po = await get_po(db, po_id)
    if po.status != POStatus.APPROVED.value:
        raise ValidationError(f"Only an approved PO can be sent to vendor (status {po.status})")
    po.status = POStatus.SENT_TO_VENDOR.value
    await db.commit()
    await db.refresh(po)
    return po


async def open_for_grn(db: AsyncSession, params: PageParams) -> dict:
    stmt = (
        select(PurchaseOrder)
        .where(PurchaseOrder.status.in_([POStatus.SENT_TO_VENDOR.value,
                                         POStatus.PARTIALLY_RECEIVED.value]))
        .order_by(PurchaseOrder.created_at.desc())
    )
    return await paginate(db, stmt, params)


async def _refresh_current_approver(db: AsyncSession, po: PurchaseOrder) -> None:
    approvers = await engine.current_approvers(db, DocType.PO.value, po.id)
    po.current_approver_name = ", ".join(a.full_name for a in approvers) or None


# =========================================================================== #
#  Requisitions
# =========================================================================== #

async def _approver_names(db: AsyncSession, doc_type: str, doc_id: int) -> str | None:
    approvers = await engine.current_approvers(db, doc_type, doc_id)
    return ", ".join(a.full_name for a in approvers) or None


async def _item_snapshot(db: AsyncSession, item_id: int) -> Item | None:
    """Read once, snapshot onto the line. Renaming a master must not rewrite a
    document that was raised against the old name (rule 10)."""
    return await db.get(Item, item_id)


async def create_requisition(db: AsyncSession, data: ReqCreate, user) -> Requisition:
    req = Requisition(
        req_no=await next_number(db, DocType.REQUISITION.value),
        req_date=utcnow().date(),
        warehouse_id=data.warehouse_id,
        project_id=data.project_id,
        priority=data.priority,
        remarks=data.remarks,
        status=RequisitionStatus.DRAFT.value,
        created_by_id=user.id,
        created_by_name=user.full_name,
    )
    db.add(req)
    await db.flush()
    await _write_requisition_lines(db, req, data.lines)
    await db.commit()
    return await get_requisition(db, req.id)


async def create_requisition_from_mr(db: AsyncSession, mr_id: int, user) -> Requisition:
    """Turn an approved material request into a requisition, lines and all.

    The handoff the flow document asks for at §3.3 step 2-3: the SCM Head approves the
    material request, and Purchase picks it up. Until now the only way across was to
    read the MR on one screen and retype every line into `create_requisition` on
    another — the one join in the whole chain a human had to make by hand, and the one
    place a quantity could quietly change between two documents.

    Follows the same shape as `create_po_from_indent`: the new document points BACK at
    what it came from, line by line, so an item can be traced indent -> MR ->
    requisition -> RFQ -> PO without a guess anywhere.

    Only what is still owed is carried over. A line already ordered in an earlier pass
    contributes nothing, and an MR with nothing left raises rather than writing an
    empty requisition.
    """
    mr = (await db.execute(
        select(MaterialRequest)
        .options(selectinload(MaterialRequest.items))
        .where(MaterialRequest.id == mr_id)
    )).scalars().first()
    if mr is None:
        raise NotFoundError(f"Material request {mr_id} not found")
    if mr.status != MRStatus.APPROVED.value:
        raise ValidationError(
            f"{mr.mr_no} is {mr.status}; only an approved material request "
            f"becomes a requisition"
        )

    existing = await db.scalar(
        select(Requisition.req_no)
        .join(RequisitionItem, RequisitionItem.requisition_id == Requisition.id)
        .where(Requisition.source_mr_id == mr.id,
               Requisition.status != RequisitionStatus.CANCELLED.value)
        .limit(1)
    )
    if existing:
        raise ValidationError(f"{mr.mr_no} already became requisition {existing}")

    lines = [
        SimpleNamespace(
            item_id=line.item_id,
            quantity=_d(line.quantity) - _d(line.ordered_quantity),
            uom_code=line.uom_code,
            # Left to `_write_requisition_lines` to price. Nobody has quoted yet, so
            # this is only ever an estimate — but a requisition worth ₹0 is worse than
            # an approximate one: the approval ladder routes on `total_amount`, so a
            # zero sends every requisition down the cheapest branch of the chain.
            estimated_rate=0,
            required_date=None,
            indent_id=mr.indent_id,
            indent_item_id=line.indent_item_id,
        )
        for line in mr.items
        if _d(line.quantity) - _d(line.ordered_quantity) > 0
    ]
    if not lines:
        raise ValidationError(f"Every line on {mr.mr_no} is already ordered")

    req = Requisition(
        req_no=await next_number(db, DocType.REQUISITION.value),
        req_date=utcnow().date(),
        warehouse_id=None,
        project_id=mr.project_id,
        priority=getattr(mr, "priority", None),
        remarks=f"Raised from {mr.mr_no}"
               + (f" for indent {mr.indent_no}" if mr.indent_no else ""),
        status=RequisitionStatus.DRAFT.value,
        source_mr_id=mr.id,
        source_mr_no=mr.mr_no,
        created_by_id=user.id,
        created_by_name=user.full_name,
    )
    db.add(req)
    await db.flush()
    await _write_requisition_lines(db, req, lines)
    await db.commit()
    logger.info("requisition %s raised from %s (%d line(s))",
                req.req_no, mr.mr_no, len(lines))
    return await get_requisition(db, req.id)


async def _last_known_rates(db: AsyncSession, item_ids: list[int]) -> dict[int, Decimal]:
    """The best guess at what each item costs, for lines that arrive without a rate.

    Order matters. The preferred vendor's agreed rate is a real commercial number; any
    other vendor's last rate is at least something somebody charged; the item master's
    `purchase_price` is a valuation figure fed by GRN and is the last resort.

    This is an ESTIMATE and nothing downstream treats it as a price — the PO is written
    from the quotation. But the requisition ladder routes on `total_amount`, so leaving
    it at zero is not neutral: it sends every requisition down the cheapest branch of
    the approval chain regardless of what is actually being bought.
    """
    if not item_ids:
        return {}
    rates: dict[int, Decimal] = {}
    # Preferred last, so it overwrites a non-preferred vendor's row for the same item.
    for row in (await db.execute(
        select(VendorItem.item_id, VendorItem.last_rate)
        .where(VendorItem.item_id.in_(item_ids), VendorItem.last_rate.isnot(None),
               VendorItem.last_rate > 0)
        .order_by(VendorItem.is_preferred)
    )).all():
        rates[row[0]] = _d(row[1])
    for row in (await db.execute(
        select(Item.id, Item.purchase_price)
        .where(Item.id.in_(item_ids), Item.purchase_price > 0)
    )).all():
        rates.setdefault(row[0], _d(row[1]))
    return rates


async def _write_requisition_lines(db: AsyncSession, req: Requisition, lines) -> None:
    total = Decimal(0)
    # Only consulted for lines that came in at zero — a buyer who typed a rate meant it.
    fallback = await _last_known_rates(
        db, [line.item_id for line in lines if not _d(line.estimated_rate)])
    for index, line in enumerate(lines, start=1):
        item = await _item_snapshot(db, line.item_id)
        if item is None:
            raise ValidationError(f"Item {line.item_id} does not exist")
        rate = _d(line.estimated_rate) or fallback.get(line.item_id, Decimal(0))
        amount = _d(line.quantity) * rate
        total += amount
        db.add(RequisitionItem(
            requisition_id=req.id, line_no=index,
            indent_id=line.indent_id, indent_item_id=line.indent_item_id,
            item_id=item.id, item_code=item.code, item_name=item.name,
            uom_code=line.uom_code or getattr(item, "uom_code", None),
            quantity=_d(line.quantity), estimated_rate=rate,
            estimated_amount=amount, required_date=line.required_date,
        ))
    req.total_items = len(lines)
    req.estimated_value = total


async def get_requisition(db: AsyncSession, req_id: int, user=None) -> Requisition:
    req = (await db.execute(select(Requisition).where(
        Requisition.id == req_id,
        # Same scope the list applies: a row hidden from the register must not be
        # readable by putting its id in the URL.
        await scope_condition(db, user, owner_col=Requisition.created_by_id)
        if user is not None else true(),
    ))).scalar_one_or_none()
    if not req:
        raise NotFoundError(f"Requisition {req_id} not found")
    return req


async def list_requisitions(db: AsyncSession, params: PageParams,
                            status: str | None = None, user=None) -> dict:
    stmt = select(Requisition)
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user, owner_col=Requisition.created_by_id))
    if status:
        stmt = stmt.where(Requisition.status == status)
    return await paginate(db, stmt.order_by(Requisition.created_at.desc()), params)


async def update_requisition(db: AsyncSession, req_id: int, data: ReqCreate,
                             user) -> Requisition:
    req = await get_requisition(db, req_id, user)
    if req.status != RequisitionStatus.DRAFT.value:
        raise ValidationError(f"Cannot edit a requisition in {req.status} status")
    for line in list(req.items):
        await db.delete(line)
    await db.flush()
    req.warehouse_id = data.warehouse_id
    req.project_id = data.project_id
    req.priority = data.priority
    req.remarks = data.remarks
    await _write_requisition_lines(db, req, data.lines)
    await db.commit()
    return await get_requisition(db, req_id)


async def submit_requisition(db: AsyncSession, req_id: int, user) -> Requisition:
    req = await get_requisition(db, req_id, user)
    if req.status != RequisitionStatus.DRAFT.value:
        raise ValidationError(f"Cannot submit a requisition in {req.status} status")
    await engine.start(db, DocType.REQUISITION.value, req.id,
                       context={"total_amount": float(req.estimated_value)}, user=user)
    req.status = RequisitionStatus.PENDING_APPROVAL.value
    req.current_approver_name = await _approver_names(
        db, DocType.REQUISITION.value, req.id)
    await db.commit()
    return await get_requisition(db, req_id)


async def act_on_requisition(db: AsyncSession, req_id: int, action: str,
                             comments: str, user) -> Requisition:
    req = await get_requisition(db, req_id)
    if req.status != RequisitionStatus.PENDING_APPROVAL.value:
        raise ValidationError(
            f"Requisition is not awaiting approval (status {req.status})")
    instance = await engine.act(db, DocType.REQUISITION.value, req.id,
                                action, user, comments)
    if instance.status == InstanceStatus.APPROVED.value:
        req.status = RequisitionStatus.APPROVED.value
        req.approved_at = utcnow()
        req.approved_by_name = user.full_name
        req.current_approver_name = None
    elif instance.status == InstanceStatus.REJECTED.value:
        req.status = RequisitionStatus.REJECTED.value
        req.current_approver_name = None
    else:
        req.current_approver_name = await _approver_names(
            db, DocType.REQUISITION.value, req.id)
    await db.commit()
    return await get_requisition(db, req_id)


async def cancel_requisition(db: AsyncSession, req_id: int, user) -> Requisition:
    req = await get_requisition(db, req_id, user)
    CLOSED = (RequisitionStatus.ORDERED.value, RequisitionStatus.CANCELLED.value)
    if req.status in CLOSED:
        raise ValidationError(f"Requisition is already {req.status}")
    req.status = RequisitionStatus.CANCELLED.value
    req.current_approver_name = None
    await db.commit()
    return await get_requisition(db, req_id)


# =========================================================================== #
#  RFQ
# =========================================================================== #

async def create_rfq(db: AsyncSession, data: RFQCreate, user) -> RFQ:
    requisition = None
    if data.requisition_id:
        requisition = await get_requisition(db, data.requisition_id)
        # A requisition folded into a consolidated sheet is bought through the sheet,
        # so it is a legitimate source too — otherwise consolidating a requisition
        # would make it impossible to tender.
        if requisition.status not in (RequisitionStatus.APPROVED.value,
                                      RequisitionStatus.CONSOLIDATED.value):
            raise ValidationError(
                "Only an approved requisition can go out for quotation "
                f"(status {requisition.status})")

    sheet = None
    if data.consolidation_id:
        sheet = await consolidation.get_consolidation(db, data.consolidation_id)
        if sheet.status not in (ConsolidationStatus.APPROVED.value,
                                ConsolidationStatus.RFQ_RAISED.value):
            raise ValidationError(
                "Only an approved consolidated sheet can go out for quotation "
                f"(status {sheet.status})")

    if data.evaluation_method and not evaluation.is_valid(data.evaluation_method):
        raise ValidationError(
            f"{data.evaluation_method!r} is not an evaluation method")

    rfq = RFQ(
        rfq_no=await next_number(db, DocType.RFQ.value),
        rfq_date=utcnow().date(),
        title=data.title,
        requisition_id=requisition.id if requisition else None,
        requisition_no=requisition.req_no if requisition else None,
        consolidation_id=sheet.id if sheet else None,
        consolidation_no=sheet.cons_no if sheet else None,
        warehouse_id=data.warehouse_id or (requisition.warehouse_id if requisition else None),
        warehouse_name=requisition.warehouse_name if requisition else None,
        project_id=data.project_id or (requisition.project_id if requisition else None),
        project_name=requisition.project_name if requisition else None,
        due_date=data.due_date,
        terms=data.terms,
        evaluation_method=(data.evaluation_method.upper()
                           if data.evaluation_method else None),
        status=RFQStatus.DRAFT.value,
        created_by_id=user.id,
        created_by_name=user.full_name,
    )
    db.add(rfq)
    await db.flush()
    await _write_rfq_lines(db, rfq, data.lines)
    await _set_rfq_vendors(db, rfq, data.vendor_ids)
    await db.commit()
    return await get_rfq(db, rfq.id)


async def _write_rfq_lines(db: AsyncSession, rfq: RFQ, lines) -> None:
    for index, line in enumerate(lines, start=1):
        item = await _item_snapshot(db, line.item_id)
        if item is None:
            raise ValidationError(f"Item {line.item_id} does not exist")
        db.add(RFQItem(
            rfq_id=rfq.id, line_no=index, item_id=item.id,
            item_code=item.code, item_name=item.name,
            description=line.description,
            uom_code=line.uom_code or getattr(item, "uom_code", None),
            quantity=_d(line.quantity), required_date=line.required_date,
        ))
    rfq.total_items = len(lines)


async def _set_rfq_vendors(db: AsyncSession, rfq: RFQ, vendor_ids) -> None:
    """Reconcile the invited list. Existing rows are KEPT, not rewritten — dropping
    and re-adding would mint a new access token and break a link already emailed.

    The current rows are SELECTed rather than read off `rfq.vendors`: on a freshly
    flushed RFQ that collection has never been loaded, and touching it here raises
    MissingGreenlet instead of quietly returning the empty list it looks like.
    """
    wanted = list(dict.fromkeys(vendor_ids or []))
    current = {row.vendor_id: row for row in (await db.execute(
        select(RFQVendor).where(RFQVendor.rfq_id == rfq.id)
    )).scalars().all()}
    for vendor_id, row in current.items():
        if vendor_id not in wanted:
            if row.responded_at is not None:
                raise ValidationError(
                    f"{row.vendor_name or vendor_id} has already quoted and cannot "
                    "be removed from this RFQ")
            await db.delete(row)
    for vendor_id in wanted:
        if vendor_id in current:
            continue
        vendor = await db.get(Vendor, vendor_id)
        if vendor is None:
            raise ValidationError(f"Vendor {vendor_id} does not exist")
        db.add(RFQVendor(
            rfq_id=rfq.id, vendor_id=vendor.id, vendor_name=vendor.name,
            vendor_email=getattr(vendor, "email", None),
            access_token=secrets.token_urlsafe(32),
        ))
    rfq.vendor_count = len(wanted)


async def get_rfq(db: AsyncSession, rfq_id: int, user=None) -> RFQ:
    rfq = (await db.execute(select(RFQ).where(
        RFQ.id == rfq_id,
        await scope_condition(db, user, owner_col=RFQ.created_by_id)
        if user is not None else true(),
    ))).scalar_one_or_none()
    if not rfq:
        raise NotFoundError(f"RFQ {rfq_id} not found")
    # The order this award already became, if it became one. Transient attributes off a
    # lookup rather than columns on pro_rfqs: the PO already points backward at the RFQ,
    # and a second copy of that link on the RFQ is a second thing that can go stale.
    #
    # Read here rather than derived in the screen because only the server knows — a
    # buyer coming back to an awarded RFQ was still being offered "Create purchase
    # order" for an order that exists, and only found out by pressing it.
    row = (await db.execute(
        select(PurchaseOrder.id, PurchaseOrder.po_no, PurchaseOrder.status)
        .where(PurchaseOrder.rfq_id == rfq.id,
               PurchaseOrder.status != POStatus.CANCELLED.value)
        .order_by(PurchaseOrder.id).limit(1)
    )).first()
    rfq.po_id, rfq.po_no, rfq.po_status = row if row else (None, None, None)
    return rfq


async def list_rfqs(db: AsyncSession, params: PageParams, status: str | None = None,
                    user=None) -> dict:
    stmt = select(RFQ)
    if user is not None:
        stmt = stmt.where(await scope_condition(db, user, owner_col=RFQ.created_by_id))
    if status:
        stmt = stmt.where(RFQ.status == status)
    return await paginate(db, stmt.order_by(RFQ.created_at.desc()), params)


async def update_rfq(db: AsyncSession, rfq_id: int, data: RFQUpdate, user) -> RFQ:
    rfq = await get_rfq(db, rfq_id, user)
    EDITABLE = (RFQStatus.DRAFT.value, RFQStatus.PENDING_APPROVAL.value)
    if rfq.status not in EDITABLE:
        raise ValidationError(f"Cannot edit an RFQ in {rfq.status} status")
    if data.evaluation_method is not None:
        if not evaluation.is_valid(data.evaluation_method):
            raise ValidationError(
                f"{data.evaluation_method!r} is not an evaluation method")
        rfq.evaluation_method = data.evaluation_method.upper()
    for field in ("title", "due_date", "terms", "warehouse_id", "project_id"):
        value = getattr(data, field)
        if value is not None:
            setattr(rfq, field, value)
    if data.lines is not None:
        for line in list(rfq.items):
            await db.delete(line)
        await db.flush()
        await _write_rfq_lines(db, rfq, data.lines)
    if data.vendor_ids is not None:
        await _set_rfq_vendors(db, rfq, data.vendor_ids)
    await db.commit()
    return await get_rfq(db, rfq_id)


async def submit_rfq(db: AsyncSession, rfq_id: int, user) -> RFQ:
    rfq = await get_rfq(db, rfq_id, user)
    if rfq.status != RFQStatus.DRAFT.value:
        raise ValidationError(f"Cannot submit an RFQ in {rfq.status} status")
    if not rfq.vendors:
        raise ValidationError("Add at least one vendor before sending an RFQ out")
    await engine.start(db, DocType.RFQ.value, rfq.id,
                       context={"vendor_count": rfq.vendor_count}, user=user)
    rfq.status = RFQStatus.PENDING_APPROVAL.value
    rfq.current_approver_name = await _approver_names(db, DocType.RFQ.value, rfq.id)
    await db.commit()
    return await get_rfq(db, rfq_id)


async def act_on_rfq(db: AsyncSession, rfq_id: int, action: str, comments: str,
                     user) -> RFQ:
    rfq = await get_rfq(db, rfq_id)
    if rfq.status != RFQStatus.PENDING_APPROVAL.value:
        raise ValidationError(f"RFQ is not awaiting approval (status {rfq.status})")
    instance = await engine.act(db, DocType.RFQ.value, rfq.id, action, user, comments)
    if instance.status == InstanceStatus.APPROVED.value:
        # Approved means published: the tokens go live and the vendors can quote.
        await _publish_rfq(db, rfq)
    elif instance.status == InstanceStatus.REJECTED.value:
        rfq.status = RFQStatus.CANCELLED.value
        rfq.current_approver_name = None
    else:
        rfq.current_approver_name = await _approver_names(db, DocType.RFQ.value, rfq.id)
    await db.commit()
    return await get_rfq(db, rfq_id)


async def _publish_rfq(db: AsyncSession, rfq: RFQ) -> None:
    """Open the RFQ to its vendors and give each one an empty quotation to fill in.

    The draft quotation is created here rather than on the vendor's first save so the
    portal always has a document to open — a vendor staring at "nothing to do" cannot
    tell an RFQ they were left off from one they simply have not started.
    """
    rfq.status = RFQStatus.PUBLISHED.value
    rfq.current_approver_name = None
    now = utcnow()
    for invited in rfq.vendors:
        invited.sent_at = now
        invited.status = QuotationStatus.DRAFT.value
        quote = Quotation(
            quotation_no=await next_number(db, DocType.QUOTATION.value),
            rfq_id=rfq.id, rfq_no=rfq.rfq_no,
            vendor_id=invited.vendor_id, vendor_name=invited.vendor_name,
            quotation_date=now.date(),
            status=QuotationStatus.DRAFT.value,
            currency="INR",
        )
        db.add(quote)
        await db.flush()
        for line in rfq.items:
            db.add(QuotationItem(
                quotation_id=quote.id, line_no=line.line_no,
                rfq_item_id=line.id, item_id=line.item_id,
                item_code=line.item_code, item_name=line.item_name,
                description=line.description, uom_code=line.uom_code,
                quantity=line.quantity,
            ))


async def close_rfq(db: AsyncSession, rfq_id: int, user) -> RFQ:
    rfq = await get_rfq(db, rfq_id, user)
    if rfq.status != RFQStatus.PUBLISHED.value:
        raise ValidationError(f"Only a published RFQ can be closed (status {rfq.status})")
    rfq.status = RFQStatus.CLOSED.value
    await db.commit()
    return await get_rfq(db, rfq_id)


async def cancel_rfq(db: AsyncSession, rfq_id: int, user) -> RFQ:
    rfq = await get_rfq(db, rfq_id, user)
    CLOSED = (RFQStatus.AWARDED.value, RFQStatus.CANCELLED.value)
    if rfq.status in CLOSED:
        raise ValidationError(f"RFQ is already {rfq.status}")
    rfq.status = RFQStatus.CANCELLED.value
    rfq.current_approver_name = None
    await db.commit()
    return await get_rfq(db, rfq_id)


async def rfq_invites(db: AsyncSession, rfq_id: int, user) -> list[dict]:
    """The vendor links, for a buyer to send by hand.

    SCM does not email vendors — there is no outbound mail configured — so the token
    has to be readable somewhere or the portal is unreachable for a vendor without an
    account. This is that somewhere, and it is behind `rfq.manage`.
    """
    rfq = await get_rfq(db, rfq_id, user)
    return [{
        "vendor_id": row.vendor_id, "vendor_name": row.vendor_name,
        "vendor_email": row.vendor_email,
        "invite_path": f"/supplier/rfq/{row.access_token}",
    } for row in rfq.vendors if row.access_token]


# =========================================================================== #
#  Quotations
# =========================================================================== #

def _quote_totals(quote: Quotation) -> None:
    """Recompute the header off the lines. The header is never written directly —
    a total that disagrees with its lines is the one number nobody can reconcile."""
    sub_total = tax_total = Decimal(0)
    for line in quote.items:
        gross = _d(line.quantity) * _d(line.rate)
        net = gross - (gross * _d(line.discount_percent) / 100)
        sub_total += net
        tax_total += net * _d(line.tax_percent) / 100
        line.amount = net
    quote.sub_total = sub_total
    quote.tax_amount = tax_total
    quote.grand_total = (sub_total + tax_total
                         + _d(quote.freight_amount) - _d(quote.discount_amount))


async def get_quotation(db: AsyncSession, quote_id: int) -> Quotation:
    quote = await db.get(Quotation, quote_id)
    if quote is None:
        raise NotFoundError(f"Quotation {quote_id} not found")
    return quote


async def list_quotations(db: AsyncSession, params: PageParams,
                          rfq_id: int | None = None,
                          vendor_id: int | None = None) -> dict:
    stmt = select(Quotation)
    if rfq_id is not None:
        stmt = stmt.where(Quotation.rfq_id == rfq_id)
    if vendor_id is not None:
        stmt = stmt.where(Quotation.vendor_id == vendor_id)
    return await paginate(db, stmt.order_by(Quotation.created_at.desc()), params)


async def comparison(db: AsyncSession, rfq_id: int, user,
                     method: str | None = None) -> dict:
    """Every submitted quote for an RFQ, best first, with the rank written back.

    Ranking is stored rather than computed on read because the award decision has to
    be auditable: "we took rank 2" must still mean something after a vendor revises.

    `method` overrides what the RFQ carries so a buyer can look at the same quotes
    under a different lens before committing — looking is not choosing, so the
    override is NOT written back to the RFQ. What is written back is the rank and
    score under the method actually applied, because that is what the award reads.

    Ordering falls back to `grand_total` for the quotes the scorer could not place
    (a zero-value quote), so an unscored row still appears rather than vanishing.
    """
    rfq = await get_rfq(db, rfq_id, user)
    if method and not evaluation.is_valid(method):
        raise ValidationError(f"{method!r} is not an evaluation method")
    chosen = evaluation.method_of(method or rfq.evaluation_method)

    quotes = (await db.execute(
        select(Quotation)
        .where(Quotation.rfq_id == rfq.id,
               Quotation.status != QuotationStatus.DRAFT.value)
        .order_by(Quotation.grand_total.asc())
    )).scalars().all()

    ranked = evaluation.rank([
        evaluation.Candidate(
            ref=quote.id,
            # `sub_total` is the headline the vendor named; `grand_total` is that plus
            # discount, tax and freight — which is exactly the landed/price split.
            price=_d(quote.sub_total) or _d(quote.grand_total),
            landed_cost=_d(quote.grand_total),
            lead_days=quote.delivery_days,
        ) for quote in quotes
    ], chosen)

    by_id = {quote.id: quote for quote in quotes}
    placed = set()
    for row in ranked:
        quote = by_id[row.ref]
        quote.rank_position = row.rank
        quote.evaluation_score = row.score
        placed.add(quote.id)
    # Anything the scorer could not place keeps a rank, after the placed ones, so the
    # column is never left holding a stale position from an earlier comparison.
    for offset, quote in enumerate(
            (q for q in quotes if q.id not in placed), start=len(ranked) + 1):
        quote.rank_position = offset
        quote.evaluation_score = None

    await db.commit()
    ordered = sorted(quotes, key=lambda q: q.rank_position or 0)
    return {
        "rfq": rfq,
        "quotations": ordered,
        "evaluation_method": chosen,
        "responded": len(ranked),
        "recommended_quotation_id": ranked[0].ref if ranked else None,
        # Stated, not enforced: three quotes is the standard (doc B8), but a
        # single-source item is real and blocking the award would stop the purchase.
        "meets_three_quote_norm": len(ranked) >= 3,
    }


async def award_rfq(db: AsyncSession, rfq_id: int, data: AwardIn, user) -> RFQ:
    """Pick a quotation. Does not raise the PO — that is a separate, approved act."""
    rfq = await get_rfq(db, rfq_id, user)
    OPEN = (RFQStatus.PUBLISHED.value, RFQStatus.CLOSED.value)
    if rfq.status not in OPEN:
        raise ValidationError(f"Cannot award an RFQ in {rfq.status} status")
    quote = await get_quotation(db, data.quotation_id)
    if quote.rfq_id != rfq.id:
        raise ValidationError("That quotation belongs to a different RFQ")
    if quote.status == QuotationStatus.DRAFT.value:
        raise ValidationError("That vendor has not submitted a quotation yet")

    for other in (await db.execute(
        select(Quotation).where(Quotation.rfq_id == rfq.id)
    )).scalars().all():
        if other.id == quote.id:
            other.status = QuotationStatus.ACCEPTED.value
        elif other.status != QuotationStatus.DRAFT.value:
            other.status = QuotationStatus.REJECTED.value
    rfq.status = RFQStatus.AWARDED.value
    rfq.awarded_vendor_id = quote.vendor_id
    rfq.awarded_vendor_name = quote.vendor_name
    if rfq.requisition_id:
        requisition = await db.get(Requisition, rfq.requisition_id)
        if requisition and requisition.status == RequisitionStatus.APPROVED.value:
            requisition.status = RequisitionStatus.RFQ_RAISED.value
    if rfq.consolidation_id:
        sheet = await db.get(PurchaseConsolidation, rfq.consolidation_id)
        # Not CLOSED: a sheet is tendered in parts, and more of it may still go out.
        if sheet and sheet.status == ConsolidationStatus.APPROVED.value:
            sheet.status = ConsolidationStatus.RFQ_RAISED.value
    await db.commit()
    return await get_rfq(db, rfq_id)


# =========================================================================== #
#  Vendor portal
# =========================================================================== #
#  Everything below is reached by somebody outside the company. There is no
#  `require_permission` on any of it — a vendor holds no RBAC role — so the guard is
#  that every function takes `vendor_id` from the verified token and filters on it.
#  No function here accepts a vendor id from the caller.

DEFAULT_VENDOR_PASSWORD = "Bavya@123"


async def _vendor_account(db: AsyncSession, vendor_id: int) -> VendorUser | None:
    return (await db.execute(
        select(VendorUser).where(VendorUser.vendor_id == vendor_id)
    )).scalars().first()


async def ensure_vendor_account(db: AsyncSession, data: VendorAccountIn,
                                user) -> VendorUser:
    """Give a vendor a login, or hand back the one they already have.

    Idempotent on purpose: a buyer pressing the button twice must not mint a second
    account, and must not silently reset a password the vendor has already changed.
    """
    vendor = await db.get(Vendor, data.vendor_id)
    if vendor is None:
        raise NotFoundError(f"Vendor {data.vendor_id} not found")
    account = await _vendor_account(db, vendor.id)
    if account is not None:
        return account
    username = (data.username or vendor.code or f"vendor{vendor.id}").strip().lower()
    clash = (await db.execute(
        select(VendorUser).where(VendorUser.username == username)
    )).scalars().first()
    if clash is not None:
        raise ValidationError(f"The username {username!r} is already in use")
    account = VendorUser(
        vendor_id=vendor.id, username=username,
        password_hash=hash_password(DEFAULT_VENDOR_PASSWORD),
        is_active=True, must_change_password=True,
    )
    db.add(account)
    await db.commit()
    await db.refresh(account)
    return account


async def list_vendor_accounts(db: AsyncSession, params: PageParams) -> dict:
    return await paginate(db, select(VendorUser).order_by(VendorUser.username), params)


async def set_vendor_account_active(db: AsyncSession, vendor_id: int,
                                    is_active: bool, user) -> VendorUser:
    account = await _vendor_account(db, vendor_id)
    if account is None:
        raise NotFoundError(f"Vendor {vendor_id} has no portal account")
    account.is_active = is_active
    await db.commit()
    await db.refresh(account)
    return account


async def reset_vendor_password(db: AsyncSession, vendor_id: int, user) -> VendorUser:
    """Back to the shared default, and forced to change on next sign-in."""
    account = await _vendor_account(db, vendor_id)
    if account is None:
        raise NotFoundError(f"Vendor {vendor_id} has no portal account")
    account.password_hash = hash_password(DEFAULT_VENDOR_PASSWORD)
    account.must_change_password = True
    await db.commit()
    await db.refresh(account)
    return account


async def vendor_login(db: AsyncSession, username: str, password: str) -> dict:
    account = (await db.execute(
        select(VendorUser).where(VendorUser.username == username.strip().lower())
    )).scalars().first()
    # One message for "no such account", "wrong password" and "disabled". Telling
    # them apart tells an outsider which vendor codes are real.
    if (account is None or not account.is_active
            or not verify_password(password, account.password_hash)):
        raise AuthenticationError("Incorrect username or password")
    vendor = await db.get(Vendor, account.vendor_id)
    account.last_login_at = utcnow()
    await db.commit()
    return {
        # `typ` is what keeps this token out of the internal API — see
        # core/dependencies.get_current_user, which refuses anything but an employee.
        "access_token": create_access_token(
            account.vendor_id, {"typ": "vendor", "username": account.username}),
        "vendor_id": account.vendor_id,
        "vendor_name": vendor.name if vendor else None,
        "must_change_password": account.must_change_password,
    }


async def vendor_change_password(db: AsyncSession, vendor_id: int,
                                 current: str, new: str) -> None:
    account = await _vendor_account(db, vendor_id)
    if account is None or not verify_password(current, account.password_hash):
        raise AuthenticationError("Current password is incorrect")
    if new == DEFAULT_VENDOR_PASSWORD:
        raise ValidationError("Choose a password that is not the shared default")
    account.password_hash = hash_password(new)
    account.must_change_password = False
    await db.commit()


async def vendor_profile(db: AsyncSession, vendor_id: int) -> Vendor:
    vendor = await db.get(Vendor, vendor_id)
    if vendor is None:
        raise NotFoundError("Vendor not found")
    return vendor


def _vendor_visible():
    """The statuses a vendor may see. A DRAFT or PENDING_APPROVAL RFQ is internal —
    the company has not decided to ask them yet."""
    return RFQ.status.in_([RFQStatus.PUBLISHED.value, RFQStatus.CLOSED.value,
                           RFQStatus.AWARDED.value])


async def vendor_list_rfqs(db: AsyncSession, vendor_id: int,
                           params: PageParams) -> dict:
    stmt = (
        select(RFQ)
        .join(RFQVendor, RFQVendor.rfq_id == RFQ.id)
        .where(RFQVendor.vendor_id == vendor_id, _vendor_visible())
        .order_by(RFQ.created_at.desc())
    )
    return await paginate(db, stmt, params)


async def vendor_get_rfq(db: AsyncSession, vendor_id: int, rfq_id: int) -> RFQ:
    rfq = (await db.execute(
        select(RFQ)
        .join(RFQVendor, RFQVendor.rfq_id == RFQ.id)
        .where(RFQ.id == rfq_id, RFQVendor.vendor_id == vendor_id, _vendor_visible())
    )).scalars().first()
    # Not "you are not invited": a vendor who guesses ids should not learn which ones
    # exist. Same 404 either way.
    if rfq is None:
        raise NotFoundError(f"RFQ {rfq_id} not found")
    return rfq


async def rfq_by_token(db: AsyncSession, token: str) -> tuple[RFQ, int]:
    """Open an RFQ from an invite link, with no account at all.

    The token is a bearer credential scoped to exactly one RFQ and one vendor, which
    is why it can be handed out: the worst it opens is the document its holder was
    already being asked to quote on.
    """
    invited = (await db.execute(
        select(RFQVendor).where(RFQVendor.access_token == token)
    )).scalars().first()
    if invited is None:
        raise NotFoundError("That invitation link is not valid")
    return await vendor_get_rfq(db, invited.vendor_id, invited.rfq_id), invited.vendor_id


async def vendor_get_quotation(db: AsyncSession, vendor_id: int,
                               rfq_id: int) -> Quotation:
    quote = (await db.execute(
        select(Quotation).where(Quotation.rfq_id == rfq_id,
                                Quotation.vendor_id == vendor_id)
    )).scalars().first()
    if quote is None:
        raise NotFoundError("No quotation has been opened for you on this RFQ")
    return quote


async def vendor_submit_quotation(db: AsyncSession, vendor_id: int, rfq_id: int,
                                  data: QuoteSubmit) -> Quotation:
    """Save the vendor's offer. Re-submitting before the deadline is allowed and
    bumps `revision_count` — a buyer must be able to see they moved."""
    rfq = await vendor_get_rfq(db, vendor_id, rfq_id)
    if rfq.status != RFQStatus.PUBLISHED.value:
        raise ValidationError("This RFQ is closed and no longer accepts quotations")
    if rfq.due_date and rfq.due_date < utcnow().date():
        raise ValidationError("The submission deadline for this RFQ has passed")

    quote = await vendor_get_quotation(db, vendor_id, rfq_id)
    lines_by_rfq_item = {line.rfq_item_id: line for line in quote.items}
    for index, incoming in enumerate(data.lines, start=1):
        line = lines_by_rfq_item.get(incoming.rfq_item_id)
        if line is None:
            raise ValidationError(
                f"Line {incoming.rfq_item_id} is not on this RFQ")
        line.line_no = index
        line.rate = _d(incoming.rate)
        line.discount_percent = _d(incoming.discount_percent)
        line.tax_percent = _d(incoming.tax_percent)
        line.cgst_rate = incoming.cgst_rate
        line.sgst_rate = incoming.sgst_rate
        line.igst_rate = incoming.igst_rate
        line.delivery_days = incoming.delivery_days

    quote.vendor_ref_no = data.vendor_ref_no
    quote.valid_till = data.valid_till
    quote.expected_delivery_date = data.expected_delivery_date
    quote.payment_terms = data.payment_terms
    quote.delivery_days = data.delivery_days
    quote.freight_amount = _d(data.freight_amount)
    quote.discount_amount = _d(data.discount_amount)
    quote.remarks = data.remarks
    _quote_totals(quote)

    first_time = quote.status == QuotationStatus.DRAFT.value
    quote.status = (QuotationStatus.SUBMITTED.value if first_time
                    else QuotationStatus.REVISED.value)
    if not first_time:
        quote.revision_count += 1
    quote.submitted_at = utcnow()

    invited = (await db.execute(
        select(RFQVendor).where(RFQVendor.rfq_id == rfq.id,
                                RFQVendor.vendor_id == vendor_id)
    )).scalars().first()
    if invited is not None:
        if invited.responded_at is None:
            # response_count counts VENDORS who answered, not submissions — a vendor
            # revising four times must not read as four responses.
            rfq.response_count = (rfq.response_count or 0) + 1
        invited.responded_at = utcnow()
        invited.status = quote.status
    await db.commit()
    await db.refresh(quote)
    return quote


# --------------------------------------------------------------------------- #
#  The consolidated buying sheet — re-exported from consolidation.py
# --------------------------------------------------------------------------- #
# The module itself is imported at the top (create_rfq validates a sheet against it);
# these names are lifted so the router has one import site, the same arrangement
# logistics uses for its transport surface.

evaluation_methods = evaluation.describe

act_on_consolidation = consolidation.act_on_consolidation
cancel_consolidation = consolidation.cancel_consolidation
consolidation_candidates = consolidation.candidates
consolidation_history = consolidation.history
consolidation_sources = consolidation.sources_of
create_consolidation = consolidation.create_consolidation
delete_consolidation = consolidation.delete_consolidation
get_consolidation = consolidation.get_consolidation
list_consolidations = consolidation.list_consolidations
rebuild_consolidation = consolidation.rebuild_consolidation
set_consolidation_lines = consolidation.set_line_quantities
submit_consolidation = consolidation.submit_consolidation


# =========================================================================== #
#  Despatch notes — the vendor's statement of what they sent
# =========================================================================== #
#  Same guard as everything above in the portal: `vendor_id` comes from the verified
#  token and every query filters on it. No function here accepts a vendor id from the
#  caller, and none of them writes to stock — a despatch note is a claim, and the GRN
#  is where the company agrees with it or does not.

#: An order a vendor may still despatch against. Not DRAFT or PENDING_APPROVAL — the
#: vendor has not been told about those and must not see them — and not RECEIVED, which
#: is finished.
_DESPATCHABLE = (POStatus.SENT_TO_VENDOR.value, POStatus.PARTIALLY_RECEIVED.value)


async def _vendor_po(db: AsyncSession, vendor_id: int, po_id: int) -> PurchaseOrder:
    """One order, only if it belongs to this vendor and they have been sent it."""
    po = (await db.execute(
        select(PurchaseOrder).where(
            PurchaseOrder.id == po_id,
            PurchaseOrder.vendor_id == vendor_id,
            PurchaseOrder.status.in_(_DESPATCHABLE),
        )
    )).scalars().first()
    if po is None:
        raise NotFoundError(f"Purchase order {po_id} not found")
    return po


async def _despatched_by_po_item(db: AsyncSession, po_id: int) -> dict[int, Decimal]:
    """How much of each line the vendor has already said they sent.

    Summed from the notes rather than kept as a column: a delivery goes out in parts,
    and a running total on the PO line would be a second place for the same fact to
    disagree with itself.
    """
    rows = (await db.execute(
        select(DespatchNoteItem.po_item_id,
               func.coalesce(func.sum(DespatchNoteItem.despatched_qty), 0))
        .join(DespatchNote, DespatchNote.id == DespatchNoteItem.despatch_note_id)
        .where(DespatchNote.po_id == po_id,
               DespatchNote.status == DespatchNoteStatus.SUBMITTED.value)
        .group_by(DespatchNoteItem.po_item_id)
    )).all()
    return {row[0]: _d(row[1]) for row in rows if row[0]}


async def vendor_list_pos(db: AsyncSession, vendor_id: int, params: PageParams) -> dict:
    """The orders this vendor has been sent. Never anyone else's, never a draft."""
    stmt = (select(PurchaseOrder)
            .where(PurchaseOrder.vendor_id == vendor_id,
                   PurchaseOrder.status.in_(_DESPATCHABLE))
            .order_by(PurchaseOrder.po_date.desc(), PurchaseOrder.id.desc()))
    page = await paginate(db, stmt, params)
    counts = dict((await db.execute(
        select(DespatchNote.po_id, func.count(DespatchNote.id))
        .where(DespatchNote.vendor_id == vendor_id,
               DespatchNote.status != DespatchNoteStatus.CANCELLED.value)
        .group_by(DespatchNote.po_id)
    )).all())
    for row in page["items"]:
        row.despatch_note_count = counts.get(row.id, 0)
    return page


async def vendor_get_po(db: AsyncSession, vendor_id: int, po_id: int) -> PurchaseOrder:
    """One order with what is still owed on each line, and the notes filed so far."""
    po = await _vendor_po(db, vendor_id, po_id)
    already = await _despatched_by_po_item(db, po.id)

    po.lines = [
        SimpleNamespace(
            po_item_id=line.id, item_id=line.item_id, item_code=line.item_code,
            item_name=line.item_name, uom_code=line.uom_code,
            ordered_qty=_d(line.quantity),
            despatched_qty=already.get(line.id, Decimal(0)),
            pending_qty=max(_d(line.quantity) - already.get(line.id, Decimal(0)),
                            Decimal(0)),
        )
        for line in po.items
    ]
    po.despatch_notes = list((await db.execute(
        select(DespatchNote)
        .options(selectinload(DespatchNote.items))
        .where(DespatchNote.po_id == po.id, DespatchNote.vendor_id == vendor_id)
        .order_by(DespatchNote.id.desc())
    )).scalars().all())
    return po


async def vendor_get_despatch_note(db: AsyncSession, vendor_id: int,
                                   note_id: int) -> DespatchNote:
    note = (await db.execute(
        select(DespatchNote)
        .options(selectinload(DespatchNote.items))
        .where(DespatchNote.id == note_id, DespatchNote.vendor_id == vendor_id)
    )).scalars().first()
    if note is None:
        raise NotFoundError(f"Despatch note {note_id} not found")
    return note


async def vendor_save_despatch_note(db: AsyncSession, vendor_id: int, po_id: int,
                                    data: DespatchNoteIn,
                                    note_id: int | None = None) -> DespatchNote:
    """Create or replace the vendor's draft note for an order.

    Lines are matched to the PO by `po_item_id`, and anything that is not on the order
    is refused: a despatch note answers a purchase order, so a vendor cannot use it to
    declare something nobody bought. Quantities are capped at what is still owed for
    the same reason.

    A SUBMITTED note is not editable. It is what the gate is about to receive against,
    and letting it change underneath a storekeeper who has already started counting is
    the one way this document could make things worse rather than better.
    """
    po = await _vendor_po(db, vendor_id, po_id)

    note = None
    if note_id is not None:
        note = await vendor_get_despatch_note(db, vendor_id, note_id)
        if note.po_id != po.id:
            raise ValidationError("That despatch note belongs to a different order")
        if note.status != DespatchNoteStatus.DRAFT.value:
            raise ValidationError(
                f"{note.dn_no} is {note.status} and can no longer be edited")

    po_items = {line.id: line for line in po.items}
    already = await _despatched_by_po_item(db, po.id)
    # This note's own quantities do not count against its own ceiling on a re-save.
    if note is not None:
        for line in note.items:
            if line.po_item_id in already:
                already[line.po_item_id] -= _d(line.despatched_qty)

    lines = [line for line in data.lines if _d(line.despatched_qty) > 0]
    if not lines:
        raise ValidationError("A despatch note needs at least one quantity")

    for line in lines:
        po_line = po_items.get(line.po_item_id)
        if po_line is None:
            raise ValidationError(f"Line {line.po_item_id} is not on {po.po_no}")
        pending = _d(po_line.quantity) - already.get(line.po_item_id, Decimal(0))
        if _d(line.despatched_qty) > pending:
            raise ValidationError(
                f"{po_line.item_code or po_line.item_name}: {line.despatched_qty} "
                f"exceeds the {pending} still owed on {po.po_no}")
        if line.expiry_date and line.mfg_date and line.expiry_date <= line.mfg_date:
            raise ValidationError(
                f"{po_line.item_code or po_line.item_name}: expiry must be after "
                "the manufacture date")

    if note is None:
        note = DespatchNote(
            dn_no=await next_number(db, DocType.DESPATCH_NOTE.value),
            po_id=po.id, po_no=po.po_no,
            vendor_id=vendor_id, vendor_name=po.vendor_name,
            status=DespatchNoteStatus.DRAFT.value,
        )
        db.add(note)
        await db.flush()

    note.dn_date = data.dn_date or utcnow().date()
    note.invoice_no = data.invoice_no
    note.invoice_date = data.invoice_date
    note.invoice_amount = data.invoice_amount
    note.eway_bill_no = data.eway_bill_no
    note.vehicle_no = data.vehicle_no
    note.transporter_name = data.transporter_name
    note.lr_no = data.lr_no
    note.expected_date = data.expected_date
    note.remarks = data.remarks

    # Only a re-saved draft has lines to clear. A note created a moment ago has an
    # unloaded `items` collection, and reading it here is a lazy load inside the async
    # session — which is a MissingGreenlet, not an empty list.
    if note_id is not None:
        for existing in list(note.items):
            await db.delete(existing)
        await db.flush()

    for index, line in enumerate(lines, start=1):
        po_line = po_items[line.po_item_id]
        db.add(DespatchNoteItem(
            despatch_note_id=note.id, line_no=index,
            po_item_id=line.po_item_id, item_id=po_line.item_id,
            item_code=po_line.item_code, item_name=po_line.item_name,
            uom_code=po_line.uom_code,
            despatched_qty=_d(line.despatched_qty),
            batch_no=line.batch_no, mfg_date=line.mfg_date,
            expiry_date=line.expiry_date, remarks=line.remarks,
        ))

    await db.commit()
    return await vendor_get_despatch_note(db, vendor_id, note.id)


async def vendor_submit_despatch_note(db: AsyncSession, vendor_id: int,
                                      note_id: int) -> DespatchNote:
    """File it. Invoice and e-way bill are required HERE, not on the draft.

    Doc B12 makes both mandatory before dispatch, and this is the moment the vendor
    says the vehicle has left. Checked at submit rather than at save so a note can be
    started while the invoice is still being raised.
    """
    note = await vendor_get_despatch_note(db, vendor_id, note_id)
    if note.status != DespatchNoteStatus.DRAFT.value:
        raise ValidationError(f"{note.dn_no} is already {note.status}")
    missing = [label for label, value in (
        ("invoice number", note.invoice_no),
        ("e-way bill number", note.eway_bill_no),
    ) if not (value or "").strip()]
    if missing:
        raise ValidationError(
            f"{' and '.join(missing).capitalize()} is required before despatch")

    note.status = DespatchNoteStatus.SUBMITTED.value
    note.submitted_at = utcnow()
    await db.commit()
    logger.info("despatch note %s submitted against %s", note.dn_no, note.po_no)
    return await vendor_get_despatch_note(db, vendor_id, note.id)


async def vendor_cancel_despatch_note(db: AsyncSession, vendor_id: int,
                                      note_id: int) -> DespatchNote:
    """Withdraw a note. Refused once a receipt points at it — by then the warehouse
    has begun receiving against what it says, and it is a record, not a plan."""
    note = await vendor_get_despatch_note(db, vendor_id, note_id)
    if note.status == DespatchNoteStatus.CANCELLED.value:
        raise ValidationError(f"{note.dn_no} is already cancelled")
    if await _despatch_note_is_received(db, note.id):
        raise ValidationError(
            f"{note.dn_no} has already been received against and cannot be cancelled")
    note.status = DespatchNoteStatus.CANCELLED.value
    await db.commit()
    return await vendor_get_despatch_note(db, vendor_id, note.id)


async def _despatch_note_is_received(db: AsyncSession, note_id: int) -> bool:
    """Whether the warehouse has booked anything in against this note.

    Imported here rather than at module scope: warehouse sits AFTER procurement in the
    import chain (rule 5), so procurement may only reach it from inside a function.
    """
    from app.modules.warehouse.models import Receipt

    return bool(await db.scalar(
        select(Receipt.id).where(Receipt.despatch_note_id == note_id).limit(1)))
