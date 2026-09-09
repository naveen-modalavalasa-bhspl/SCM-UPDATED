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

from datetime import date
from sqlalchemy import exists, func, select, true, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.exceptions import AuthenticationError, NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.core.security import (
    create_access_token, hash_password_async, verify_password_async,
)
from app.modules.indents import service as indent_service
from app.modules.indents.models import Indent, IndentItem
from app.modules.inventory import hooks as inventory_hooks
from app.modules.inventory.models import MaterialRequest, MaterialRequestItem
from app.modules.procurement.models import (
    DespatchNote, DespatchNoteItem, POComment, POItem, PurchaseConsolidation,
    PurchaseConsolidationSource, PurchaseOrder, Quotation, QuotationItem, Requisition,
    PORevision, RequisitionItem, RequisitionSource, RFQ, RFQItem, RFQVendor,
    VendorNotification, VendorUser,
)
from app.modules.procurement.schemas import (
    AwardIn, DespatchNoteIn, POCreate, POFromQuotationIn, POHeaderUpdate, QuoteSubmit,
    ReqCreate, RFQCreate, RFQQuantitiesIn, RFQUpdate, VendorAccountIn,
)
from app.modules.procurement import consolidation, ledger, quote_otp
from app.platform.hcm.models import HcmDepartment, HcmEmployee
from app.platform.mail import service as mail_service
from app.platform.mail import template as mail_template
from app.platform.mail.schemas import MailSendIn
from app.platform.rbac import permissions as perms
from app.platform.rbac.service import get_user_permissions
from app.platform.settings.service import (
    get_company_letterhead, get_setting, write_audit,
)
from app.platform.workflow import engine
from app.platform.workflow.models import Instance as WorkflowInstance
from app.shared import evaluation
from app.shared.models.warehouse import Warehouse
from app.shared.scope import scope_condition

logger = logging.getLogger(__name__)
from app.shared.enums import (
    SHIPMENT_ADDRESS_WAREHOUSE_TYPES,
    AuditAction, ConsolidationStatus, DespatchNoteStatus, DocType, IndentStatus,
    InstanceStatus, MRStatus, POStatus, POVendorStatus, QuotationStatus,
    RequisitionStatus, RFQStatus,
)
from app.shared.models.base import utcnow
from app.shared.time import today as ist_today
from app.shared.models.master import HsnCode, Item, Project, Vendor, VendorItem
from app.shared.numbering import next_number


def _d(value) -> Decimal:
    return Decimal(str(value))


# --------------------------------------------------------------------------- #
#  Document header context
# --------------------------------------------------------------------------- #
#  A requisition names five things a buyer needs before they can act on it:
#  department, warehouse, project, company, and — when the demand came off the field —
#  the indents behind it. Only two of them are columns.
#
#  Department belongs to the PERSON who raised the document and HCM owns it; the
#  company is one value for the whole install and settings owns it. Both are read here
#  rather than copied onto pro_ tables: neither can be edited on the document, so a
#  stored copy could only ever go stale, and reading them needs no migration.

async def _place_names(db: AsyncSession, warehouse_id: int | None,
                       project_id: int | None, *,
                       keep_id: int | None = None) -> tuple[str | None, str | None]:
    """Snapshot the two soft FKs a requisition and an RFQ both carry, and refuse a
    shipment address a purchase may not be sent to.

    Snapshotted, not joined, because renaming a master must not rewrite a document
    raised against the old name (rule 10).

    THE GUARD LIVES HERE because every path that stores a `warehouse_id` — a
    requisition by hand, a requisition off a consolidation, an edit of either, and an
    RFQ raised from any of them — already calls this to fill the snapshot. Hanging the
    check on the same call means a sixth path cannot be written that stores an address
    without validating it, which is exactly how the picker and the API came to
    disagree in the first place: narrowing a dropdown is a courtesy, and a hand-made
    POST never sees it (requirement 2, 2026-09-07).

    `keep_id` GRANDFATHERS what a document already holds. 13 live documents — 2
    requisitions on LIP, 2 on MDP and 9 RFQs on LIP — were raised before this rule
    existed, and an edit re-sends the stored id whether or not the user touched the
    field. Refusing it outright would make those documents uneditable forever over a
    value the editor never chose. So the rule is "you may not MOVE a purchase to a
    field point", not "this document must already be clean".
    """
    warehouse = await db.get(Warehouse, warehouse_id) if warehouse_id else None
    if warehouse is not None and warehouse_id != keep_id:
        kind = (warehouse.warehouse_type or "MAIN").upper()
        if kind not in SHIPMENT_ADDRESS_WAREHOUSE_TYPES:
            raise ValidationError(
                f"{warehouse.name} is a {kind} stocking point, not a warehouse. "
                f"A purchase can only be shipped to a warehouse.")
    project = await db.get(Project, project_id) if project_id else None
    return (warehouse.name if warehouse else None,
            project.name if project else None)


async def _apply_po_header(db: AsyncSession, po: PurchaseOrder, data) -> None:
    """Write the header a caller typed onto the order — terms, addresses, project.

    One place for all three ways of raising a PO (by hand, from an indent, from an
    award): a term agreed with a vendor must print the same whichever route the order
    came in by. Every field is optional and a blank one simply says nothing.

    The project is snapshotted like every other soft FK (rule 10). It is only
    overwritten when the caller actually chose one — the indent or the RFQ behind the
    order already put its own project on it, and an untouched field must not wipe that.
    """
    if getattr(data, "project_id", None):
        po.project_id = data.project_id
        _, po.project_name = await _place_names(db, None, data.project_id)
    # FIXED 2026-08-23 — this wrote all six unconditionally, so a caller that did not
    # mention a term BLANKED it. The PO detail screen opened its header form empty and
    # sent those blanks straight back, which meant opening a saved order and pressing
    # Save or Amend silently destroyed every term and address on it. The rule the
    # docstring above already claims for `project_id` now actually holds for all of
    # them: absent (None) leaves what is on the order, and an explicit "" clears it,
    # so a buyer can still take a term back off.
    for field in ("payment_terms", "delivery_terms", "material_terms",
                  "logistics_terms", "billing_address", "shipping_address"):
        value = getattr(data, field, None)
        if value is None:
            continue
        setattr(po, field, value.strip() or None)
    # Both columns are NOT NULL, so these are assigned only when the caller named a
    # number. Omitted, the order keeps what it had (or the column default on create).
    if getattr(data, "discount_amount", None) is not None:
        po.discount_amount = _d(data.discount_amount)
    if getattr(data, "freight_amount", None) is not None:
        po.freight_amount = _d(data.freight_amount)


def _apply_po_totals(po: PurchaseOrder, sub_total: Decimal, tax_total: Decimal) -> None:
    """The one place the order total is computed:

        total = sub_total - discount + tax + freight

    Discount comes off before tax is added because the lines were already taxed at
    their own rate; a document-level discount reduces what is payable, not what was
    quoted per line.
    """
    discount = _d(po.discount_amount or 0)
    freight = _d(po.freight_amount or 0)
    if discount > sub_total:
        raise ValidationError(
            f"Discount {discount} is more than the order sub-total {sub_total}")
    po.sub_total = sub_total
    po.tax_amount = tax_total
    po.total_amount = sub_total - discount + tax_total + freight


async def _header_context(db: AsyncSession, created_by_id: int | None) -> dict:
    """Department (from HCM, via the raiser) and company (from settings).

    The fallback, not the answer: a document that names its own department and company
    keeps them. This fills in the ones raised before those columns existed, and the
    ones where the form was left alone.
    """
    employee = await db.get(HcmEmployee, created_by_id) if created_by_id else None
    return {
        "department_id": employee.department_id if employee else None,
        "department_name": employee.department_name if employee else None,
        "company_name": (await get_setting(db, "company.name")) or None,
    }


async def _fill_header_context(db: AsyncSession, document) -> None:
    """Leave what the document says; supply what it does not."""
    fallback = await _header_context(db, document.created_by_id)
    for field, value in fallback.items():
        if getattr(document, field, None) in (None, ""):
            setattr(document, field, value)


async def _department_snapshot(db: AsyncSession, department_id: int | None) -> str | None:
    if not department_id:
        return None
    row = await db.get(HcmDepartment, department_id)
    return row.name if row else None


# --------------------------------------------------------------------------- #
#  GST on a quotation
# --------------------------------------------------------------------------- #
#  Two rules, and both belong to the company rather than to the vendor quoting.
#
#  WHICH TAX applies is decided by the two GSTINs: the first two digits are the state
#  code, so same state is CGST + SGST and any other state is IGST. That is the law, not
#  a preference — a vendor offered all three boxes will eventually tick the wrong pair,
#  and the resulting invoice cannot be reclaimed.
#
#  HOW MUCH is capped by the item's HSN, because the rate is a property of the
#  classification. A vendor may quote UNDER it (they may be absorbing part of it, or
#  under a composition scheme) but never over: above the notified rate the number is
#  either a mistake or a charge the company cannot claim back.

async def _company_gstin(db: AsyncSession) -> str | None:
    return (await get_setting(db, "company.gstin")) or None


def _state_code(gstin: str | None) -> str | None:
    """The first two digits of a GSTIN. Anything shorter is not a GSTIN."""
    cleaned = (gstin or "").strip()
    return cleaned[:2] if len(cleaned) >= 2 and cleaned[:2].isdigit() else None


def tax_region(company_gstin: str | None, vendor_gstin: str | None) -> str:
    """INTRA (CGST+SGST) or INTER (IGST).

    Falls back to INTER when either GSTIN is missing or malformed: IGST is the one
    that is merely wrong rather than unclaimable if the states later turn out to
    match, and an unregistered counterparty is by definition not an intra-state
    credit. The screen says which was chosen and why, so nobody has to guess.
    """
    company, vendor = _state_code(company_gstin), _state_code(vendor_gstin)
    if company and vendor and company == vendor:
        return "INTRA"
    return "INTER"


async def _hsn_ceilings(db: AsyncSession, item_ids: list[int]) -> dict[int, dict]:
    """Per item: the HSN code and the rates it notifies. The quote may not exceed them.

    Read through the item's `hsn_id` rather than its `hsn_code` snapshot — the snapshot
    is what the item was created with and the rate is whatever the code says today.
    An item with no HSN gets no ceiling: blocking it would stop the quote outright, and
    an unclassified item is a masters problem, not a vendor's.
    """
    if not item_ids:
        return {}
    rows = (await db.execute(
        select(Item.id, HsnCode.code, HsnCode.cgst_rate, HsnCode.sgst_rate,
               HsnCode.igst_rate)
        .join(HsnCode, HsnCode.id == Item.hsn_id)
        .where(Item.id.in_(item_ids))
    )).all()
    return {
        row[0]: {
            "hsn_code": row[1],
            "cgst_rate": float(row[2] or 0),
            "sgst_rate": float(row[3] or 0),
            "igst_rate": float(row[4] or 0),
        } for row in rows
    }


def _indent_numbers(rows) -> list[str]:
    """The indents a document is ultimately serving, deduplicated and in order.

    Read off the lines rather than held on the header: a requisition consolidated out
    of nine indents has nine, and the line is where the pointer already lives."""
    seen: list[str] = []
    for row in rows:
        number = getattr(row, "indent_no", None)
        if number and number not in seen:
            seen.append(number)
    return seen


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
        # The indent's project, unless the buyer picked another below.
        project_id=getattr(indent, "project_id", None),
        project_name=getattr(indent, "project_name", None),
        status=POStatus.DRAFT.value,
        remarks=data.remarks,
    )
    await _apply_po_header(db, po, data)
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

    _apply_po_totals(po, sub_total, tax_total)

    indent.status = IndentStatus.ORDERED.value
    await db.commit()
    await db.refresh(po)
    return po


async def create_po(db: AsyncSession, data: POCreate, user) -> PurchaseOrder:
    """Raise a purchase order directly — no indent, no quotation behind it.

    The chain normally decides what a PO says: an indent asks, a tender answers, and
    `create_po_from_indent` / `create_po_from_quotation` write the order from that
    answer. But not every purchase starts as a demand note — a repeat order against an
    agreed rate, an emergency buy, a service somebody is already performing — and until
    now the only way to enter one was to raise a fake indent for it.

    So this is the same document with nothing in front of it. It carries no backward
    pointer because there is nothing to point at, which is exactly what tells a reader
    later that it was raised by hand. Everything else is unchanged: DRAFT on arrival,
    the same PO ladder, the same permission.
    """
    if not data.lines:
        raise ValidationError("A purchase order must have at least one line")

    vendor = await db.get(Vendor, data.vendor_id)
    if vendor is None:
        raise ValidationError(f"Unknown vendor {data.vendor_id}")

    items = {row.id: row for row in (await db.execute(
        select(Item).where(Item.id.in_([line.item_id for line in data.lines]))
    )).scalars().all()}

    po = PurchaseOrder(
        po_no=await next_number(db, "po"),
        po_date=utcnow().date(),
        expected_date=data.expected_date,
        vendor_id=vendor.id,
        vendor_name=vendor.name,
        vendor_gstin=vendor.gstin,
        created_by_id=user.id,
        created_by_name=user.full_name,
        # The raiser's own office, so the same data scope that hides a PO raised off an
        # indent hides this one — `scope_condition` filters on it.
        office_id=getattr(user, "office_id", None),
        facility_id=None,
        facility_name=getattr(user, "office_name", None),
        status=POStatus.DRAFT.value,
        remarks=data.remarks,
    )
    await _apply_po_header(db, po, data)
    db.add(po)
    await db.flush()

    sub_total = tax_total = Decimal("0")
    for line in data.lines:
        item = items.get(line.item_id)
        if item is None:
            raise ValidationError(f"Unknown item id: {line.item_id}")
        amount = _d(line.quantity) * _d(line.rate)
        tax = amount * _d(line.tax_percent) / _d(100)
        sub_total += amount
        tax_total += tax
        db.add(POItem(
            po_id=po.id, item_id=item.id, item_code=item.code, item_name=item.name,
            uom_code=item.uom_code, quantity=_d(line.quantity), rate=_d(line.rate),
            tax_percent=_d(line.tax_percent), amount=amount,
        ))

    _apply_po_totals(po, sub_total, tax_total)
    await db.commit()
    logger.info("purchase order %s raised directly by %s (%d line(s))",
                po.po_no, user.full_name, len(data.lines))
    return await get_po(db, po.id)


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
        project_id=rfq.project_id,
        project_name=rfq.project_name,
        status=POStatus.DRAFT.value,
        remarks=data.remarks or f"Raised from {quote.quotation_no} against {rfq.rfq_no}",
    )
    await _apply_po_header(db, po, data)
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
            # What the vendor promised on this line, kept with the line rather than
            # summarised into the header date above.
            delivery_days=line.delivery_days,
        ))

    # The offer's own document-level money, carried across so the order comes to the
    # same figure as the quotation it accepts. Both are columns of their own now: the
    # freight used to be added into `sub_total`, which double-counted the moment the
    # buyer could also see and edit a freight field, and the discount was dropped
    # entirely, so the PO silently cost more than the quote that won.
    #
    # Only when the caller said nothing. A buyer who typed a figure on the create call
    # has negotiated it, and the quote must not overwrite them.
    if not _d(po.freight_amount or 0):
        po.freight_amount = _d(quote.freight_amount or 0)
    if not _d(po.discount_amount or 0):
        po.discount_amount = _d(quote.discount_amount or 0)

    # FIXED 2026-08-23 — the offer's PROMISES, carried across the same way its money
    # already was. The vendor states both on the portal quotation form, and neither
    # reached the order: a PO raised from an award came out with no payment terms and
    # no expected date, and the buyer retyped what the vendor had already committed to
    # — or, more often, did not, and the order went out silent on when it is due.
    #
    # `RFQDetailPage` raises the PO with an EMPTY body (`createFromQuotation(id)`), so
    # in practice the caller never says anything here and the quote always wins. The
    # "only if the caller stayed silent" guard is still the right rule: a buyer who
    # typed a figure has negotiated it, and an acceptance must not overwrite them.
    if not (po.payment_terms or "").strip():
        po.payment_terms = (quote.payment_terms or "").strip() or None
    if po.expected_date is None:
        # The date the vendor said they can deliver by. `delivery_days` is per line and
        # is a DURATION, not a date — rolling it up here would invent a promise the
        # quotation never made, so only the explicit date is used.
        po.expected_date = quote.expected_delivery_date

    _apply_po_totals(po, sub_total, tax_total)

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
    
    if not po.vendor_name and po.vendor_id:
        from app.modules.master.models import Vendor
        vendor_name = (await db.execute(select(Vendor.name).where(Vendor.id == po.vendor_id))).scalar_one_or_none()
        if vendor_name:
            po.vendor_name = vendor_name
            
    return po


async def update_po_header(db: AsyncSession, po_id: int,
                           data: POHeaderUpdate, user) -> PurchaseOrder:
    """Fill in a DRAFT order's header — terms, addresses, project, discount, freight.

    An order written by the chain arrives right on the money and silent on everything
    a buyer negotiates in words, because the quotation it came from never carried any
    of it. Until now only a hand-typed PO could say those things, so a PO raised from
    an award printed blank and the buyer had nowhere to put what was agreed.

    DRAFT only. Past that the order is in approval or has been sent to the vendor, and
    a term that changes after somebody signed it is a different agreement — the way
    back is reject and re-raise, which is the audit trail doing its job.

    The totals are recomputed from the stored lines, never from the caller: this route
    can move discount and freight and must never be able to move a rate.
    """
    po = await get_po(db, po_id, user)
    if po.status != POStatus.DRAFT.value:
        raise ValidationError(
            f"Only a draft purchase order can be edited (this one is {po.status})")

    if data.expected_date is not None:
        po.expected_date = data.expected_date
    if data.remarks is not None:
        po.remarks = data.remarks
    await _apply_po_header(db, po, data)

    sub_total = tax_total = Decimal("0")
    for line in po.items:
        amount = _d(line.amount)
        sub_total += amount
        tax_total += amount * _d(line.tax_percent or 0) / _d(100)
    _apply_po_totals(po, sub_total, tax_total)

    await db.commit()
    logger.info("purchase order %s header edited by %s", po.po_no, user.full_name)
    return await get_po(db, po_id, user)


async def list_pos(
    db: AsyncSession,
    params: PageParams,
    search: str | None = None,
    status: str | None = None,
    vendor_id: int | None = None,
    project_id: int | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    pending_for_me: bool = False,
    user=None
) -> dict:
    stmt = select(PurchaseOrder)
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user,
            owner_col=PurchaseOrder.created_by_id,
            office_col=PurchaseOrder.office_id,
        ))
    if search:
        search_term = f"%{search}%"
        stmt = stmt.where(
            or_(
                PurchaseOrder.po_no.ilike(search_term),
                PurchaseOrder.rfq_no.ilike(search_term),
                PurchaseOrder.quotation_no.ilike(search_term),
                PurchaseOrder.indent_no.ilike(search_term), # Fallback, still helpful
            )
        )
    stmt = _status_in(stmt, PurchaseOrder.status, status)
    if pending_for_me and user is not None:
        stmt = _only_ids(stmt, PurchaseOrder.id, await _pending_doc_ids(
            db, user, DocType.PO.value))
    if vendor_id is not None:
        stmt = stmt.where(PurchaseOrder.vendor_id == vendor_id)
    if project_id is not None:
        stmt = stmt.where(PurchaseOrder.project_id == project_id)
    if date_from:
        stmt = stmt.where(PurchaseOrder.po_date >= date_from)
    if date_to:
        stmt = stmt.where(PurchaseOrder.po_date <= date_to)

    return await _attach_pending_with(db, DocType.PO.value, await paginate(
        db, stmt.order_by(PurchaseOrder.created_at.desc()), params))

async def export_pos(
    db: AsyncSession,
    search: str | None = None,
    status: str | None = None,
    vendor_id: int | None = None,
    project_id: int | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    user=None
) -> str:
    import csv
    import io

    stmt = select(PurchaseOrder)
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user,
            owner_col=PurchaseOrder.created_by_id,
            office_col=PurchaseOrder.office_id,
        ))
    if search:
        search_term = f"%{search}%"
        stmt = stmt.where(
            or_(
                PurchaseOrder.po_no.ilike(search_term),
                PurchaseOrder.rfq_no.ilike(search_term),
                PurchaseOrder.quotation_no.ilike(search_term),
                PurchaseOrder.indent_no.ilike(search_term),
            )
        )
    if status:
        stmt = stmt.where(PurchaseOrder.status == status)
    if vendor_id is not None:
        stmt = stmt.where(PurchaseOrder.vendor_id == vendor_id)
    if project_id is not None:
        stmt = stmt.where(PurchaseOrder.project_id == project_id)
    if date_from:
        stmt = stmt.where(PurchaseOrder.po_date >= date_from)
    if date_to:
        stmt = stmt.where(PurchaseOrder.po_date <= date_to)

    result = await db.execute(stmt.order_by(PurchaseOrder.created_at.desc()))
    pos = result.scalars().all()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "PO No", "PO Date", "Vendor", "Project", "Status", "Vendor Status", 
        "Subtotal", "Tax", "Freight", "Discount", "Total Amount", 
        "RFQ No", "Quotation No", "Indent No"
    ])

    for po in pos:
        writer.writerow([
            po.po_no,
            po.po_date.isoformat() if po.po_date else "",
            po.vendor_name or "",
            po.project_name or "",
            po.status,
            po.vendor_status or "",
            float(po.sub_total),
            float(po.tax_amount),
            float(po.freight_amount),
            float(po.discount_amount),
            float(po.total_amount),
            po.rfq_no or "",
            po.quotation_no or "",
            po.indent_no or "",
        ])
    return output.getvalue()


async def submit_po(db: AsyncSession, po_id: int, user) -> PurchaseOrder:
    po = await get_po(db, po_id)
    if po.status != POStatus.DRAFT.value:
        raise ValidationError(f"Cannot submit a PO in {po.status} status")
    instance = await engine.start(db, DocType.PO.value, po.id,
                                  context={"total_amount": float(po.total_amount),
                                           # The ORDER's project, not the buyer's. The
                                           # procurement desk sits on its own project,
                                           # so reading it off the raiser sent every
                                           # order past its project's ladder.
                                           "project_id": po.project_id or None,
                                           "doc_no": po.po_no},
                                  user=user)
    # A ladder can finish AT submit — every rung switched off, NO_APPROVAL, or the
    # raiser is the top of it — and the engine hands back an already-approved
    # instance. Recording PENDING_APPROVAL anyway left the order waiting for an
    # approval that had already happened, with no pending row to make it happen and
    # no way out: `act_on_po` passed the status guard and then died on "No
    # in-progress approval for this document". Same rule the MR, the allocation, the
    # transport request and the consolidation sheet already follow (rule 8).
    if instance.status == InstanceStatus.APPROVED.value:
        po.status = POStatus.APPROVED.value
        po.approved_at = utcnow()
        po.current_approver_name = None
    else:
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
    # Sent is asked, not agreed. The vendor answers in their portal, and nothing may be
    # received against the order until they do — an order is an offer to buy, and a
    # delivery against an unanswered one is a surprise rather than a contract.
    po.vendor_status = POVendorStatus.PENDING.value
    po.vendor_responded_at = None
    po.vendor_response_note = None
    await db.commit()
    await db.refresh(po)

    # NEW 2026-08-23 — the supplier gets their COPY of the order, not just a row in a
    # portal they have to remember to open. Sent from here and nowhere else: this is
    # the one moment an approved order is committed to a vendor, so an amended order
    # is emailed again when it is re-sent, and a revision still sitting in our own
    # approval is never mailed out. Re-read first because the body prints the lines
    # and `refresh` above only reloads the header.
    #
    # Deliberately after the commit and unable to raise — the order HAS been sent, and
    # a mailbox being down must not roll that back or fail the request.
    sent = await get_po(db, po_id, user)
    await email_po_copy(db, sent, user)
    return sent


# --------------------------------------------------------------------------- #
#  Amendments
# --------------------------------------------------------------------------- #

#: Orders nobody can amend any more.
#:
#: REVISED 2026-08-21 — the line is now THE VENDOR'S DISPATCH, not the order's status.
#:
#: The business rule the buyers actually work to: once a vendor has accepted, the order
#: keeps being negotiated — quantities move, dates move, a second and third revision go
#: out — and every one of those is a version the vendor has to accept again. That is
#: what an amendment is FOR. It stops mattering the moment the goods are on a vehicle:
#: after that the paperwork has to describe what was actually sent, and rewriting the
#: order underneath a lorry in transit is how a GRN ends up unable to explain itself.
#:
#: So ACCEPTED_BY_SUPPLIER stays amendable (it always was), and PARTIALLY_RECEIVED —
#: which used to be amendable — no longer is: goods against it have already arrived, so
#: by definition the vendor dispatched. The real test is `_vendor_has_dispatched` below,
#: because a vendor can file a despatch note days before anything reaches the gate and
#: the order must lock at THAT moment, not at the receipt.
_UNAMENDABLE = (POStatus.RECEIVED.value, POStatus.CLOSED.value,
                POStatus.CANCELLED.value, POStatus.REJECTED.value,
                POStatus.PARTIALLY_RECEIVED.value)


async def _vendor_has_dispatched(db: AsyncSession, po_id: int) -> str | None:
    """The despatch note that closes this order to amendment, if the vendor filed one.

    SUBMITTED only. A DRAFT note is the vendor still typing and nothing has left their
    yard; a CANCELLED one was withdrawn, and withdrawing it must hand the order back to
    the buyer rather than leaving it frozen forever.

    Returns the note number so the refusal can name it — "PO/2026-27/00031 cannot be
    amended: the vendor despatched DN/2026-27/00007" tells a buyer what to do next
    (raise it with the vendor, or amend after the GRN), where a bare status does not.
    """
    return (await db.execute(
        select(DespatchNote.dn_no)
        .where(DespatchNote.po_id == po_id,
               DespatchNote.status == DespatchNoteStatus.SUBMITTED.value)
        .order_by(DespatchNote.id).limit(1)
    )).scalar_one_or_none()


def _po_snapshot(po: PurchaseOrder) -> dict:
    """The whole order as it stands, header and lines, ready to be filed away.

    A snapshot rather than a diff: the point of a revision is being able to show the
    vendor the exact paper they agreed to, and a diff can only be read against a
    version that still exists.
    """
    return {
        "po_no": po.po_no,
        "po_date": po.po_date.isoformat() if po.po_date else None,
        "expected_date": po.expected_date.isoformat() if po.expected_date else None,
        "vendor_id": po.vendor_id, "vendor_name": po.vendor_name,
        "project_id": po.project_id, "project_name": po.project_name,
        "remarks": po.remarks,
        "payment_terms": po.payment_terms, "delivery_terms": po.delivery_terms,
        "material_terms": po.material_terms, "logistics_terms": po.logistics_terms,
        "billing_address": po.billing_address, "shipping_address": po.shipping_address,
        "sub_total": float(po.sub_total or 0),
        "discount_amount": float(po.discount_amount or 0),
        "tax_amount": float(po.tax_amount or 0),
        "freight_amount": float(po.freight_amount or 0),
        "total_amount": float(po.total_amount or 0),
        "items": [{
            "item_id": line.item_id, "item_code": line.item_code,
            "item_name": line.item_name, "uom_code": line.uom_code,
            "quantity": float(line.quantity or 0), "rate": float(line.rate or 0),
            "tax_percent": float(line.tax_percent or 0),
            "amount": float(line.amount or 0),
            "received_quantity": float(line.received_quantity or 0),
        } for line in po.items],
    }


async def amend_po(db: AsyncSession, po_id: int, data, user) -> PurchaseOrder:
    """Change an order that has already left the building, as a new revision.

    Not an edit. `update_po_header` fills in a draft nobody outside has seen; this
    rewrites an order that has been approved, sent, and possibly agreed to. So it files
    the whole previous version away first, bumps the revision number, and puts the
    order back at the START of its own flow: re-approved by us and, where the vendor
    had accepted, re-accepted by them. A change one side makes alone is not an
    agreement.

    Two things it may never do, both refused rather than quietly clamped:

      * drop a line's quantity below what has already been received — the goods are
        physically here and the paperwork has to be able to explain them;
      * remove a line that has any receipt against it, for the same reason.
    """
    po = await get_po(db, po_id, user)
    if po.status in _UNAMENDABLE:
        raise ValidationError(
            f"{po.po_no} is {po.status} and can no longer be amended")
    # The real gate — see `_UNAMENDABLE`. Checked after the status so a finished order
    # still reports the plainer reason.
    despatched = await _vendor_has_dispatched(db, po.id)
    if despatched:
        raise ValidationError(
            f"{po.po_no} cannot be amended: the vendor has despatched against it "
            f"({despatched}). Amend after the goods are received, or ask the vendor to "
            "cancel that despatch note first."
        )
    # REVISED 2026-08-23 — amendment has a WINDOW, and it opens at the vendor's yes:
    #
    #     accepted  ->  ...amendable...  ->  first despatch (closed by the check above)
    #
    # Before the acceptance there is nothing to amend. An order still in our own
    # approval, or approved and not yet sent, has never been agreed by anybody, so
    # changing it is just EDITING it — the way to do that is reject and re-raise, which
    # is the audit trail doing its job. Offering Amend there produced a revision of a
    # document no counterparty had ever seen, and dropped it back to DRAFT to be
    # re-approved for a change nobody outside had been told about.
    #
    # And an order sitting unanswered with the supplier is not ours to rewrite
    # underneath them: they are being asked about THIS version, and changing it while
    # the question is open means their yes lands on something else.
    #
    # The one allowance is legacy: orders SENT before the acceptance rung existed carry
    # no answer at all (`vendor_status` NULL) and are genuinely out with a vendor, so
    # they stay amendable. The same allowance `_require_accepted` already makes, on the
    # same test, for the same reason.
    accepted = po.vendor_status == POVendorStatus.ACCEPTED.value
    legacy_sent = (po.vendor_status is None
                   and po.status == POStatus.SENT_TO_VENDOR.value)
    if not (accepted or legacy_sent):
        if po.vendor_status == POVendorStatus.PENDING.value:
            raise ValidationError(
                f"{po.po_no} is with {po.vendor_name or 'the supplier'} and has not "
                "been answered yet. Amend it once they accept it, or cancel the order "
                "and raise a new one.")
        if po.vendor_status == POVendorStatus.REJECTED.value:
            raise ValidationError(
                f"{po.po_no} was declined by {po.vendor_name or 'the supplier'}, so "
                "there is no agreement to amend. Raise a new order instead.")
        raise ValidationError(
            f"{po.po_no} has not been accepted by a supplier yet (it is {po.status}), "
            "so there is no agreement to amend. Change it while it is a draft, or "
            "reject it and raise it again.")
    if not (data.reason or "").strip():
        raise ValidationError("Say why the order is being amended")

    previous_status = po.status
    was_accepted = po.vendor_status == POVendorStatus.ACCEPTED.value

    db.add(PORevision(
        po_id=po.id, revision_no=po.revision_no or 0,
        reason=data.reason.strip(), status=po.status,
        vendor_status=po.vendor_status, snapshot=_po_snapshot(po),
        changed_by_id=getattr(user, "id", None),
        changed_by_name=getattr(user, "full_name", None),
    ))

    if data.lines is not None:
        if not data.lines:
            raise ValidationError("An order must keep at least one line")
        received = {line.id: _d(line.received_quantity or 0) for line in po.items}
        kept = {line.id for line in data.lines if line.id is not None}
        for line in po.items:
            if line.id not in kept and received.get(line.id, Decimal(0)) > 0:
                raise ValidationError(
                    f"{line.item_code or line.item_id} has already been received and "
                    "cannot be taken off the order")

        items = {row.id: row for row in (await db.execute(
            select(Item).where(Item.id.in_([l.item_id for l in data.lines]))
        )).scalars().all()}
        by_id = {line.id: line for line in po.items}
        for incoming in data.lines:
            existing = by_id.get(incoming.id) if incoming.id is not None else None
            item = items.get(incoming.item_id)
            if item is None:
                raise ValidationError(f"Unknown item id: {incoming.item_id}")
            amount = _d(incoming.quantity) * _d(incoming.rate)
            if existing is not None:
                already = received.get(existing.id, Decimal(0))
                if _d(incoming.quantity) < already:
                    raise ValidationError(
                        f"{existing.item_code or existing.item_id}: {already} has "
                        "already been received, so the quantity cannot go below that")
                existing.quantity = _d(incoming.quantity)
                existing.rate = _d(incoming.rate)
                existing.tax_percent = _d(incoming.tax_percent)
                existing.amount = amount
            else:
                db.add(POItem(
                    po_id=po.id, item_id=item.id, item_code=item.code,
                    item_name=item.name, uom_code=item.uom_code,
                    quantity=_d(incoming.quantity), rate=_d(incoming.rate),
                    tax_percent=_d(incoming.tax_percent), amount=amount,
                ))
        for line in list(po.items):
            if line.id is not None and line.id not in kept:
                await db.delete(line)
        await db.flush()

    if data.expected_date is not None:
        po.expected_date = data.expected_date
    if data.remarks is not None:
        po.remarks = data.remarks
    await _apply_po_header(db, po, data)

    lines = list((await db.execute(
        select(POItem).where(POItem.po_id == po.id)
    )).scalars().all())
    sub_total = tax_total = Decimal("0")
    for line in lines:
        amount = _d(line.amount)
        sub_total += amount
        tax_total += amount * _d(line.tax_percent or 0) / _d(100)
    _apply_po_totals(po, sub_total, tax_total)

    po.revision_no = (po.revision_no or 0) + 1
    po.amended_at = utcnow()
    po.amendment_reason = data.reason.strip()
    # Back to the start of its own flow. A price the vendor agreed to yesterday is not
    # a price they agreed to today, so the acceptance is cleared and asked for again.
    po.status = POStatus.DRAFT.value
    po.approved_at = None
    po.current_approver_name = None
    po.vendor_status = None
    po.vendor_responded_at = None
    po.vendor_response_note = None

    # Tell the vendor, in the same transaction. Before this, a buyer could revise an
    # order and the vendor was told nothing at all: the PO dropped back to DRAFT, left
    # their portal until somebody re-sent it, and returned later carrying different
    # numbers with no statement that it had changed or why. `notify_vendor` swallows
    # its own failures, so this cannot cost us the amendment.
    #
    # Sent whether or not they had accepted: an order still sitting unanswered in their
    # queue has also just changed under them, and the revision they are looking at is
    # no longer the one we are asking about.
    await notify_vendor(
        db, po.vendor_id,
        title=f"{po.po_no} amended — revision {po.revision_no}",
        body=(f"{po.amendment_reason} — the order has been revised and needs "
              f"your acceptance again. Total is now "
              f"{float(po.total_amount or 0):,.2f}."),
        entity_type="PO", entity_id=po.id,
        deep_link=f"/supplier/pos/{po.id}",
    )
    await db.commit()
    logger.info("%s amended to revision %s by %s (was %s%s): %s",
                po.po_no, po.revision_no, getattr(user, "full_name", user),
                previous_status, ", vendor had accepted" if was_accepted else "",
                po.amendment_reason)
    return await get_po(db, po.id, user)


def _po_copy_parts(po: PurchaseOrder,
                   company: mail_template.Company) -> tuple[str, str]:
    """The order as the supplier's own copy of it: (plain text, html).

    Built from the stored document and nothing else, so the email cannot say something
    the PO does not. Not a PDF: there is no server-side renderer (the print view is a
    React route, `/pos/:id/print`, which only exists behind a login the vendor does not
    have) and the mail client attaches nothing today. A copy they can read in their
    inbox is the thing that was asked for; a PDF attachment can replace this body later
    without moving anything else.

    Both halves are returned, and the html rides inside `platform.mail.template` — the
    same letterhead a password reset carries. Before this the html was handed to
    `send_mail` as `body`, which the transport sent as `text/plain`: every supplier
    received the markup itself, tags and all. A bare fragment is easy to build and easy
    to send down the wrong pipe, so it is never built bare here.

    Every style attribute below is DOUBLE-quoted, deliberately: the font stack contains
    `'Segoe UI'`, so a single-quoted `style='...'` ends at that inner quote and the rest
    of the declaration is discarded — which renders the lines and the totals in the
    reader's serif default while every other block on the page is correct.
    """
    def esc(value) -> str:
        return (str(value if value is not None else "")
                .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))

    def money(value) -> str:
        return f"{float(value or 0):,.2f}"

    brand = mail_template.BRAND
    font = mail_template.FONT_STACK
    cell = (f'padding:9px 10px;border-bottom:1px solid {brand["line"]};'
            f'font-family:{font};font-size:12.5px;color:{brand["ink"]};')
    head = (f'padding:9px 10px;font-family:{font};font-size:10px;font-weight:700;'
            f'letter-spacing:0.7px;text-transform:uppercase;color:{brand["muted"]};'
            f'border-bottom:2px solid {brand["line"]};')

    rows = "".join(
        f'<tr>'
        f'<td style="{cell}white-space:nowrap;">{esc(item.item_code)}</td>'
        f'<td style="{cell}">{esc(item.item_name)}</td>'
        f'<td style="{cell}text-align:right;white-space:nowrap;">'
        f'{money(item.quantity)} {esc(item.uom_code)}</td>'
        f'<td style="{cell}text-align:right;">{money(item.rate)}</td>'
        f'<td style="{cell}text-align:right;font-weight:700;">{money(item.amount)}</td>'
        f'</tr>'
        for item in po.items
    )
    table = (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'border="0" style="border-collapse:collapse;margin:6px 0 14px;">'
        f'<thead><tr>'
        f'<th align="left" style="{head}">Code</th>'
        f'<th align="left" style="{head}">Item</th>'
        f'<th align="right" style="{head}">Qty</th>'
        f'<th align="right" style="{head}">Rate</th>'
        f'<th align="right" style="{head}">Amount</th>'
        f'</tr></thead><tbody>{rows}</tbody></table>'
    )

    # The money column, right-aligned in its own table. The total is the one number
    # the reader is looking for, so it is the one thing set larger than the body.
    money_row = (f'padding:3px 16px 3px 0;font-family:{font};font-size:12.5px;'
                 f'text-align:right;')
    totals = "".join(
        f'<tr><td style="{money_row}color:{brand["muted"]};">{label}</td>'
        f'<td style="{money_row}padding-right:0;color:{brand["ink"]};'
        f'white-space:nowrap;">{money(value)}</td></tr>'
        for label, value in (("Sub-total", po.sub_total),
                             ("Discount", po.discount_amount),
                             ("Tax", po.tax_amount),
                             ("Freight", po.freight_amount))
    ) + (
        f'<tr>'
        f'<td style="padding:10px 16px 0 0;font-family:{font};font-size:11px;'
        f'font-weight:700;text-transform:uppercase;letter-spacing:0.8px;'
        f'color:{brand["ink"]};text-align:right;border-top:1px solid {brand["line"]};">'
        f'Total</td>'
        f'<td style="padding:10px 0 0;font-family:{font};font-size:17px;'
        f'font-weight:800;color:{brand["brand"]};text-align:right;white-space:nowrap;'
        f'border-top:1px solid {brand["line"]};">{money(po.total_amount)}</td>'
        f'</tr>'
    )
    totals_block = (
        f'<table role="presentation" align="right" cellpadding="0" cellspacing="0" '
        f'border="0" style="margin:0 0 20px auto;">{totals}</table>'
        f'<div style="clear:both;font-size:0;line-height:0;">&nbsp;</div>'
    )

    terms = [(label, str(text)) for label, text in (
        ("Payment terms", po.payment_terms),
        ("Delivery terms", po.delivery_terms),
        ("Material terms", po.material_terms),
        ("Logistics terms", po.logistics_terms),
        ("Bill to", po.billing_address),
        ("Ship to", po.shipping_address),
    ) if text]

    heading = f"Purchase order {po.po_no}"
    revised = (po.revision_no or 0) > 0
    blocks = [mail_template.paragraph(f"Dear {po.vendor_name or 'Supplier'},")]
    if revised:
        blocks.append(mail_template.paragraph(
            f"This is revision {po.revision_no} of the order below"
            + (f" — {po.amendment_reason}" if po.amendment_reason else "")
            + ". It replaces every earlier copy."))
    else:
        blocks.append(mail_template.paragraph(
            "Your copy of the order below. Accept or decline it in your supplier "
            "portal."))
    blocks.append(mail_template.facts(
        [("Order no", str(po.po_no)), ("Order date", str(po.po_date or ""))]
        + ([("Expected", str(po.expected_date))] if po.expected_date else [])
        + ([("Revision", str(po.revision_no))] if revised else [])))
    blocks += [table, totals_block]
    if terms:
        blocks.append(mail_template.facts(terms))
    if po.remarks:
        blocks.append(mail_template.paragraph(f"Remarks: {po.remarks}", muted=True))

    html = mail_template.render(
        subject=heading,
        eyebrow="Revised purchase order" if revised else "Purchase order",
        heading=heading,
        preheader=f"{po.vendor_name or ''} — {len(po.items)} line(s), "
                  f"total {money(po.total_amount)}",
        blocks=blocks,
        company=company,
        footer_note="Accept or decline this order in your supplier portal.",
    )

    lines = [
        heading + (f" (revision {po.revision_no})" if revised else ""),
        f"Date: {po.po_date}" + (f"   Expected: {po.expected_date}"
                                 if po.expected_date else ""),
        f"To: {po.vendor_name}",
        "",
    ]
    lines += [
        f"  {item.item_code}  {item.item_name}  "
        f"{money(item.quantity)} {item.uom_code} x {money(item.rate)} "
        f"= {money(item.amount)}"
        for item in po.items
    ]
    lines += [
        "",
        f"Sub-total {money(po.sub_total)}   Discount {money(po.discount_amount)}   "
        f"Tax {money(po.tax_amount)}   Freight {money(po.freight_amount)}",
        f"TOTAL {money(po.total_amount)}",
        "",
    ]
    lines += [f"{label}: {text}" for label, text in terms]
    if po.remarks:
        lines.append(f"Remarks: {po.remarks}")
    lines += ["", "Accept or decline this order in your supplier portal.",
              f"— {company.legal_name or company.name}"]
    return "\n".join(lines), html


async def email_po_copy(db: AsyncSession, po: PurchaseOrder, user) -> bool:
    """Email the supplier their copy of the order. Returns whether it went.

    NEVER raises, for the same reason `notify_vendor` does not: the order has already
    been sent (or amended) and committed by the time this runs, and a mailbox that is
    down, unconfigured, or holds no address for this vendor must not undo that. Every
    failure is logged, and `platform.mail` writes its own row to the Sent log either
    way, so a buyer asking "did they get it?" has somewhere to look.

    No new permission: this is a side effect of `po.send` and `po.edit`, never its own
    route, so nothing here widens what anybody can do.
    """
    try:
        vendor = await db.get(Vendor, po.vendor_id) if po.vendor_id else None
        address = (getattr(vendor, "email", None) or "").strip()
        if not address:
            logger.info("no email on file for vendor %s; %s not sent",
                        po.vendor_name or po.vendor_id, po.po_no)
            return False
        subject = f"Purchase order {po.po_no}"
        if (po.revision_no or 0) > 0:
            subject += f" — revision {po.revision_no}"
        company = mail_template.Company.of(await get_company_letterhead(db))
        text, html = _po_copy_parts(po, company)
        await mail_service.send_mail(
            db, MailSendIn(to=[address], subject=subject, body=text, html=html), user)
        logger.info("%s emailed to %s", po.po_no, address)
        return True
    except Exception as exc:  # noqa: BLE001 - a courtesy must not cost the order
        logger.warning("could not email %s to the vendor: %s", po.po_no, exc)
        return False


async def notify_vendor(db: AsyncSession, vendor_id: int | None, *, title: str,
                        body: str | None = None, entity_type: str | None = None,
                        entity_id: int | None = None,
                        deep_link: str | None = None) -> int:
    """Tell a vendor something. Returns how many rows were written (0 or 1).

    NEVER raises. A notification is a courtesy on the side of a real transaction — an
    amendment, an award, a cancellation — and a failure to write one must not roll that
    transaction back. `platform/notifications.notify` takes the same position for
    employees and for the same reason; this is its vendor-side twin, and it exists
    because that one is keyed on `employee_id` and a vendor has none (see
    `VendorNotification`).

    Does NOT commit. The caller owns the transaction, so the notification lands or is
    rolled back with the thing it is announcing — a vendor must never be told about an
    amendment that then failed to save.
    """
    if not vendor_id:
        return 0
    try:
        db.add(VendorNotification(
            vendor_id=int(vendor_id), title=title[:200],
            body=body[:1000] if body else None,
            entity_type=entity_type, entity_id=entity_id,
            deep_link=deep_link, is_read=False,
        ))
        await db.flush()
        return 1
    except Exception:  # noqa: BLE001 — a courtesy must not fail the real work
        logger.exception("Could not notify vendor %s: %r", vendor_id, title)
        return 0


async def vendor_notifications(db: AsyncSession, vendor_id: int, params: PageParams,
                               unread_only: bool = False) -> dict:
    """This vendor's messages, newest first.

    Scoped on the vendor id taken from the TOKEN by the caller, never from a query
    parameter — the portal has no permissions to lean on, so the scope is the whole
    guard (see the router's module docstring).
    """
    stmt = select(VendorNotification).where(VendorNotification.vendor_id == vendor_id)
    if unread_only:
        stmt = stmt.where(VendorNotification.is_read.is_(False))
    return await paginate(db, stmt.order_by(VendorNotification.id.desc()), params)


async def mark_vendor_notification_read(db: AsyncSession, vendor_id: int,
                                        notification_id: int) -> None:
    """Mark one message read. Scoped to the caller's own vendor: a notification id
    belonging to somebody else must not be touchable, and 404 rather than 403 so an id
    that is not yours is not confirmed to exist."""
    row = (await db.execute(
        select(VendorNotification).where(
            VendorNotification.id == notification_id,
            VendorNotification.vendor_id == vendor_id,
        )
    )).scalars().first()
    if row is None:
        raise NotFoundError(f"Notification {notification_id} not found")
    row.is_read = True
    await db.commit()


async def po_comments(db: AsyncSession, po_id: int, user=None) -> list:
    """Discussion thread between the raiser and the approver."""
    await get_po(db, po_id, user)
    return list((await db.execute(
        select(POComment).where(POComment.po_id == po_id)
        .order_by(POComment.created_at.asc(), POComment.id.asc())
    )).scalars().all())


async def add_po_comment(db: AsyncSession, po_id: int, message: str, user) -> object:
    """Post a question or reply on a PO."""
    po = await get_po(db, po_id, user)
    clean = (message or "").strip()
    if not clean:
        raise ValidationError("Message cannot be empty")
    if len(clean) > 2000:
        raise ValidationError("Message too long (max 2000 characters)")
    row = POComment(
        po_id=po.id,
        author_id=getattr(user, "id", None),
        author_name=getattr(user, "full_name", None) or getattr(user, "username", None) or "Unknown",
        message=clean,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def update_po_approval_quantities(
    db: AsyncSession, po_id: int, data, user
) -> PurchaseOrder:
    """Approver trims quantities — only DOWN — while the order is in approval.

    The edited numbers are what the vendor receives; nothing is re-typed after
    approval. An increase is refused — the approver can only trim a request,
    never inflate it.
    """
    po = await get_po(db, po_id, user)
    if po.status != POStatus.PENDING_APPROVAL.value:
        raise ValidationError(f"Only a PO awaiting approval can be edited (status {po.status})")
    actionable = await engine.actionable_doc_ids(db, DocType.PO.value, [po.id], user)
    if po.id not in actionable:
        raise ValidationError("Only the current approver can edit quantities during approval")

    by_id = {line.id: line for line in po.items}
    if not by_id:
        raise ValidationError("PO has no lines to edit")
    incoming = {line.id: _d(line.quantity) for line in data.lines}
    if set(incoming.keys()) != set(by_id.keys()) and len(incoming) != len(by_id):
        # allow partial payload: require every sent id exists; missing ones stay as-is
        for pid in incoming:
            if pid not in by_id:
                raise ValidationError(f"Unknown PO line id {pid}")
    # also ensure no duplicate ids
    if len(incoming) != len(set(incoming.keys())):
        raise ValidationError("Duplicate line ids")

    for pid, new_qty in incoming.items():
        original = by_id[pid]
        old_qty = _d(original.quantity)
        if new_qty > old_qty:
            raise ValidationError(
                f"{original.item_code or original.item_name or pid}: "
                f"quantity can only be decreased ({old_qty} → {new_qty} not allowed)"
            )
        if new_qty <= 0:
            raise ValidationError(f"{original.item_code or pid}: quantity must be > 0")
        received = _d(original.received_quantity or 0)
        if new_qty < received:
            raise ValidationError(
                f"{original.item_code or pid}: quantity cannot go below already received {received}"
            )

    trimmed = {pid: qty for pid, qty in incoming.items()
               if qty != _d(by_id[pid].quantity)}
    if not trimmed:
        return await get_po_detail(db, po.id, user)

    # File what the numbers were BEFORE the approver touched them. Rule 9: a state
    # change writes an audit row, and here the module already owns the right one —
    # `pro_po_revisions` is what `amend_po` files and what `/pos/{id}/revisions`
    # already serves, so a trim shows up on the same trail the screen already draws.
    # `revision_no` is NOT bumped: that number means "a new version went to the
    # vendor", and this order has not left the building yet.
    db.add(PORevision(
        po_id=po.id, revision_no=po.revision_no or 0,
        reason="Quantities trimmed during approval",
        status=po.status, vendor_status=po.vendor_status,
        snapshot=_po_snapshot(po),
        changed_by_id=getattr(user, "id", None),
        changed_by_name=getattr(user, "full_name", None),
    ))

    # apply
    for pid, new_qty in incoming.items():
        line = by_id[pid]
        line.quantity = new_qty
        line.amount = new_qty * _d(line.rate)
    # lines not in payload stay unchanged

    # recompute totals from stored lines (same math as amend/create)
    sub_total = tax_total = Decimal("0")
    for line in by_id.values():
        amount = _d(line.amount)
        sub_total += amount
        tax_total += amount * _d(line.tax_percent or 0) / _d(100)
    _apply_po_totals(po, sub_total, tax_total)

    await db.commit()
    logger.info("PO %s quantities trimmed during approval by %s: %s",
                po.po_no, getattr(user, "full_name", user), trimmed)
    return await get_po_detail(db, po.id, user)


async def po_revisions(db: AsyncSession, po_id: int, user=None) -> list:
    """Every version this order has been, newest first. Read-only, always."""
    await get_po(db, po_id, user)
    return list((await db.execute(
        select(PORevision).where(PORevision.po_id == po_id)
        .order_by(PORevision.revision_no.desc(), PORevision.id.desc())
    )).scalars().all())


async def open_for_grn(db: AsyncSession, params: PageParams) -> dict:
    stmt = (
        select(PurchaseOrder)
        .where(PurchaseOrder.status.in_([POStatus.SENT_TO_VENDOR.value,
                                         POStatus.ACCEPTED_BY_SUPPLIER.value,
                                         POStatus.PARTIALLY_RECEIVED.value]))
        .order_by(PurchaseOrder.created_at.desc())
    )
    return await paginate(db, stmt, params)


async def _attach_pending_with(db: AsyncSession, doc_type: str, page: dict) -> dict:
    """Hang "who is it waiting on" on a whole screenful, in ONE query.

    `engine.pending_approver_names` exists for exactly this: asking
    `current_approvers` once per row would be a query per document. The names are set
    on the ORM rows themselves — not a mapped column, so nothing is persisted; the
    response schema reads it off the attribute, the same trick the indent register
    uses for `office_sac`.
    """
    rows = page.get("items") or []
    if not rows:
        return page
    waiting = await engine.pending_approver_names(
        db, doc_type, [row.id for row in rows])
    for row in rows:
        row.pending_with = waiting.get(row.id, [])
    return page


async def _refresh_current_approver(db: AsyncSession, po: PurchaseOrder) -> None:
    # Name AND rung, from the engine's one builder — see `current_approver_label`.
    po.current_approver_name = await engine.current_approver_label(
        db, DocType.PO.value, po.id)


# =========================================================================== #
#  Requisitions
# =========================================================================== #

async def _approver_names(db: AsyncSession, doc_type: str, doc_id: int) -> str | None:
    """Who the document is with, and on which rung.

    Was `", ".join(full_name)`. Now the engine's shared builder, so a requisition, an
    RFQ and a PO all read "Mahendra Kumar (Warehouse Manager)" rather than three
    modules each inventing their own phrasing. Kept as a wrapper because five call
    sites in this file use it and the name is the clearer one to read here.
    """
    return await engine.current_approver_label(db, doc_type, doc_id)


# =========================================================================== #
#  Where a document is waiting, and everything that has happened to it
# =========================================================================== #

async def _approval_trail(db: AsyncSession, doc_type: str, doc_id: int) -> dict:
    """Who holds this document right now, and every rung it has already passed.

    Read LIVE from the engine rather than from the document's own
    `current_approver_name`: that column is a snapshot written at submit and at each
    decision, so a ladder edited afterwards, a delegation, or a post retired under it
    leaves the stored name pointing at somebody who can no longer sign. The engine is
    the only thing that knows who is actually in `wf_pending` today (rule 8).

    Nothing here decides anything. It reads, and the caller has already loaded the
    document through its own getter, so the reader's scope has been applied before we
    get here — the trail can never be a way to read a document you cannot open.
    """
    instance = (await db.execute(
        select(WorkflowInstance).where(
            WorkflowInstance.doc_type == doc_type,
            WorkflowInstance.doc_id == doc_id,
        )
    )).scalars().first()
    approvers = await engine.current_approvers(db, doc_type, doc_id)
    actions = await engine.history(db, doc_type, doc_id)
    return {
        "doc_type": doc_type,
        "doc_id": doc_id,
        "instance_status": instance.status if instance else None,
        "stage_name": instance.current_stage_name if instance else None,
        # Names only. Who MAY press the button is `engine.actionable_doc_ids`, and
        # showing a name here must never be mistaken for granting one.
        "pending_with": [{
            "id": a.id, "name": a.full_name,
        } for a in approvers],
        "history": [{
            "stage_sequence": a.stage_sequence,
            "stage_name": a.stage_name,
            "actor_id": a.actor_id,
            "actor_name": a.actor_name,
            "actor_position": a.actor_position,
            "action": a.action,
            "comments": a.comments,
            "acted_at": a.acted_at.isoformat() if a.acted_at else None,
        } for a in actions],
    }


async def _attach_pending_one(db: AsyncSession, doc_type: str, doc, user=None):
    """The list helper, for a single document, so a detail response never carries an
    empty `pending_with` that a reader would mistake for "nobody is holding it".

    FIXED 2026-08-20 — also answers whether THIS login can sign it right now.
    `pending_with` is names, and a screen cannot derive permission from a name: every
    procurement detail page gated its Approve/Reject buttons on the document being
    PENDING_APPROVAL plus the caller holding `rfq.approve` / `po.approve`, which is a
    statement about the person and not about the document. So the PO clerk who raised
    RFQ/2026-27/00028 was shown "Approve & publish" on a document sitting with the CPO,
    and the only thing that stopped him was a 403 after the press.

    WITHOUT this the buttons are decoration: they appear for every holder of the
    approve permission on every pending document in the company, including ones that
    belong to somebody else entirely, and they also fail to disappear between two rungs
    held by the SAME person under two different hats.

    `actionable_doc_ids` is the answer because it mirrors `_act_ladder`'s own two
    checks — on the current stage's pending list, and wearing a position the ladder
    named. So the button appears exactly when the press would succeed. The backend
    check is unchanged and remains the real gate; this only stops offering a button
    that cannot work.
    """
    waiting = await engine.pending_approver_names(db, doc_type, [doc.id])
    doc.pending_with = waiting.get(doc.id, [])
    doc.awaiting_me = bool(
        user is not None
        and doc.id in await engine.actionable_doc_ids(db, doc_type, [doc.id], user)
    )
    return doc


async def get_po_detail(db: AsyncSession, po_id: int, user=None):
    po = await get_po(db, po_id, user)
    # A submitted despatch locks the PO before a GRN necessarily changes its status.
    po.amendment_allowed = (
        po.status not in _UNAMENDABLE
        and not await _vendor_has_dispatched(db, po.id)
        and (
            po.vendor_status == POVendorStatus.ACCEPTED.value
            or (po.vendor_status is None and po.status == POStatus.SENT_TO_VENDOR.value)
        )
    )
    return await _attach_pending_one(db, DocType.PO.value, po, user)


async def get_requisition_detail(db: AsyncSession, req_id: int, user=None):
    return await _attach_pending_one(
        db, DocType.REQUISITION.value, await get_requisition(db, req_id, user), user)


async def get_rfq_detail(db: AsyncSession, rfq_id: int, user=None):
    return await _attach_pending_one(
        db, DocType.RFQ.value, await get_rfq(db, rfq_id, user), user)


async def get_consolidation_detail(db: AsyncSession, cons_id: int, user=None):
    # FIXED — the rung is enforced inside `consolidation.get_consolidation`; this only
    # has to hand the user down. Same for `consolidation_approval_trail` below.
    return await _attach_pending_one(
        db, DocType.CONSOLIDATION.value,
        await consolidation.get_consolidation(db, cons_id, user=user), user)


async def po_approval_trail(db: AsyncSession, po_id: int, user=None) -> dict:
    po = await get_po(db, po_id, user)
    return await _approval_trail(db, DocType.PO.value, po.id)


async def requisition_approval_trail(db: AsyncSession, req_id: int, user=None) -> dict:
    req = await get_requisition(db, req_id, user)
    return await _approval_trail(db, DocType.REQUISITION.value, req.id)


async def rfq_approval_trail(db: AsyncSession, rfq_id: int, user=None) -> dict:
    rfq = await get_rfq(db, rfq_id, user)
    return await _approval_trail(db, DocType.RFQ.value, rfq.id)


async def consolidation_approval_trail(db: AsyncSession, cons_id: int, user=None) -> dict:
    doc = await consolidation.get_consolidation(db, cons_id, user=user)
    return await _approval_trail(db, DocType.CONSOLIDATION.value, doc.id)


async def _item_snapshot(db: AsyncSession, item_id: int) -> Item | None:
    """Read once, snapshot onto the line. Renaming a master must not rewrite a
    document that was raised against the old name (rule 10)."""
    return await db.get(Item, item_id)


async def create_requisition(db: AsyncSession, data: ReqCreate, user) -> Requisition:
    warehouse_name, project_name = await _place_names(
        db, data.warehouse_id, data.project_id)
    req = Requisition(
        # The project goes into the number (2026-08-21): a requisition now reads
        # BHS/MMU/2026-27/REQ0001. Same `project_name` the snapshot column below
        # uses, so the number and the document can never disagree.
        req_no=await next_number(db, DocType.REQUISITION.value,
                                 project=project_name),
        req_date=utcnow().date(),
        warehouse_id=data.warehouse_id,
        warehouse_name=warehouse_name,
        project_id=data.project_id,
        project_name=project_name,
        department_id=data.department_id,
        department_name=await _department_snapshot(db, data.department_id),
        company_name=data.company_name,
        required_date=data.required_date,
        priority=data.priority,
        remarks=data.remarks,
        status=RequisitionStatus.DRAFT.value,
        created_by_id=user.id,
        created_by_name=user.full_name,
    )
    db.add(req)
    await db.flush()
    await _write_requisition_lines(db, req, data.lines,
                                   default_date=data.required_date)
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
            indent_no=mr.indent_no,
            indent_item_id=line.indent_item_id,
        )
        for line in mr.items
        if _d(line.quantity) - _d(line.ordered_quantity) > 0
    ]
    if not lines:
        raise ValidationError(f"Every line on {mr.mr_no} is already ordered")

    # The MR names a project but no stocking point; the buyer picks one on the edit.
    _, project_name = await _place_names(db, None, mr.project_id)
    req = Requisition(
        # The project goes into the number (2026-08-21): a requisition now reads
        # BHS/MMU/2026-27/REQ0001. Same `project_name` the snapshot column below
        # uses, so the number and the document can never disagree.
        req_no=await next_number(db, DocType.REQUISITION.value,
                                 project=project_name
                                 or getattr(mr, "project_name", None)),
        req_date=utcnow().date(),
        warehouse_id=None,
        project_id=mr.project_id,
        project_name=project_name or getattr(mr, "project_name", None),
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


# --------------------------------------------------------------------------- #
#  Consolidating material requests into one requisition
# --------------------------------------------------------------------------- #
#  Inventory raises an MR whenever an approved indent runs short, and it raises one per
#  shortage — so the same item arrives on five of them in a week, each too small to
#  tender. Purchase's actual job is to gather those into ONE demand and go to market
#  once, which is what this does.
#
#  Item-wise, like the consolidated buying sheet: five MRs for the same bandage are one
#  line with one quantity. Every MR that fed it stays on `pro_requisition_sources`, so
#  the trail runs indent -> MR -> requisition -> RFQ -> PO without a guess.
#
#  Two rules, both copied from the indents consolidation because buyers already know
#  them: an MR that is on one sheet never appears in the picker again, and the
#  requisition that comes out does not climb an approval ladder — the MRs were approved
#  in Inventory and asking the same people again is theatre. It is still audited.

async def _consolidated_mr_ids(db: AsyncSession) -> set[int]:
    """Every MR already claimed by a live requisition, by either route.

    Both routes, because the one-MR path wrote `source_mr_id` long before the sources
    table existed and those requisitions are still open.
    """
    claimed = set((await db.execute(
        select(RequisitionSource.mr_id)
        .join(Requisition, Requisition.id == RequisitionSource.requisition_id)
        .where(Requisition.status != RequisitionStatus.CANCELLED.value)
    )).scalars().all())
    claimed |= set((await db.execute(
        select(Requisition.source_mr_id).where(
            Requisition.source_mr_id.isnot(None),
            Requisition.status != RequisitionStatus.CANCELLED.value)
    )).scalars().all())
    return {mr_id for mr_id in claimed if mr_id}


async def mr_candidates(db: AsyncSession, params: PageParams,
                        project_id: int | None = None) -> dict:
    """Approved material requests not already on a requisition — what the buyer picks
    from. A cancelled requisition releases its MRs back into the list."""
    stmt = (
        select(MaterialRequest)
        .where(MaterialRequest.status == MRStatus.APPROVED.value)
        .order_by(MaterialRequest.created_at.desc())
    )
    claimed = await _consolidated_mr_ids(db)
    if claimed:
        stmt = stmt.where(MaterialRequest.id.notin_(claimed))
    if project_id is not None:
        stmt = stmt.where(MaterialRequest.project_id == project_id)
    return await paginate(db, stmt, params)


async def mr_candidate_ids(db: AsyncSession,
                           project_id: int | None = None) -> list[int]:
    """Every material request `mr_candidates` would offer, as bare ids.

    NEW 2026-08-21, for "select all" — see `consolidation.candidate_ids` for the full
    reasoning. In short: the screen pages twenty at a time, so a select-all built from
    the loaded rows would tick twenty of a hundred and quietly mean something other than
    what it says.
    """
    stmt = (
        select(MaterialRequest.id)
        .where(MaterialRequest.status == MRStatus.APPROVED.value)
        .order_by(MaterialRequest.created_at.desc())
    )
    claimed = await _consolidated_mr_ids(db)
    if claimed:
        stmt = stmt.where(MaterialRequest.id.notin_(claimed))
    if project_id is not None:
        stmt = stmt.where(MaterialRequest.project_id == project_id)
    return list((await db.execute(stmt)).scalars().all())


consolidation_candidate_ids = consolidation.candidate_ids


async def create_requisition_from_mrs(db: AsyncSession, data, user) -> Requisition:
    """Fold a batch of approved material requests into one requisition.

    Only what is still owed is carried over — `quantity - ordered_quantity` per line —
    so an MR half-bought in an earlier pass contributes only its remainder, and lines
    for the same item across different MRs become one line with the sum.

    Approved on arrival, deliberately. The demand was approved once already, in
    Inventory, by the people who own the stock; sending the same quantities back up a
    second ladder delays a purchase without anybody deciding anything. The audit row
    still records who consolidated what, and the RFQ and the PO both keep their own
    approvals — this skips one rung, not the chain.
    """
    if not data.mr_ids:
        raise ValidationError("Pick at least one material request")

    requests = list((await db.execute(
        select(MaterialRequest)
        .options(selectinload(MaterialRequest.items))
        .where(MaterialRequest.id.in_(data.mr_ids))
        .order_by(MaterialRequest.id)
    )).scalars().all())
    missing = set(data.mr_ids) - {mr.id for mr in requests}
    if missing:
        raise NotFoundError(f"Material request {sorted(missing)[0]} not found")

    not_approved = [mr.mr_no for mr in requests if mr.status != MRStatus.APPROVED.value]
    if not_approved:
        raise ValidationError(
            f"{', '.join(not_approved)} is not approved — only an approved material "
            "request can be consolidated")

    claimed = await _consolidated_mr_ids(db)
    already = [mr.mr_no for mr in requests if mr.id in claimed]
    if already:
        raise ValidationError(
            f"{', '.join(already)} is already on a requisition. An MR is consolidated "
            "once; cancel that requisition to release it.")

    # item -> the merged line. Keyed on (item, uom) like the buying sheet: two requests
    # for the same item in the same unit are one thing to buy.
    merged: dict[tuple[int, str | None], SimpleNamespace] = {}
    for mr in requests:
        for line in mr.items:
            owed = _d(line.quantity) - _d(line.ordered_quantity or 0)
            if owed <= 0:
                continue
            key = (line.item_id, line.uom_code)
            existing = merged.get(key)
            if existing is None:
                merged[key] = SimpleNamespace(
                    item_id=line.item_id, quantity=owed, uom_code=line.uom_code,
                    estimated_rate=0, required_date=data.required_date,
                    indent_id=mr.indent_id, indent_no=mr.indent_no,
                    indent_item_id=line.indent_item_id,
                )
            else:
                existing.quantity += owed
                # The first indent named on the line stays: a merged line can serve
                # several, and the sources list is where the full answer lives.

    if not merged:
        raise ValidationError(
            "Every line on the selected material requests is already ordered")

    project_id = data.project_id or next(
        (mr.project_id for mr in requests if mr.project_id), None)
    warehouse_name, project_name = await _place_names(
        db, data.warehouse_id, project_id)
    numbers = ", ".join(mr.mr_no for mr in requests)

    req = Requisition(
        # The project goes into the number (2026-08-21): a requisition now reads
        # BHS/MMU/2026-27/REQ0001. Same `project_name` the snapshot column below
        # uses, so the number and the document can never disagree.
        req_no=await next_number(db, DocType.REQUISITION.value,
                                 project=project_name or next(
                                     (mr.project_name for mr in requests
                                      if mr.project_name), None)),
        req_date=utcnow().date(),
        warehouse_id=data.warehouse_id,
        warehouse_name=warehouse_name,
        project_id=project_id,
        project_name=project_name or next(
            (mr.project_name for mr in requests if mr.project_name), None),
        department_id=data.department_id,
        department_name=await _department_snapshot(db, data.department_id),
        company_name=data.company_name,
        required_date=data.required_date,
        priority=data.priority,
        remarks=data.remarks or f"Consolidated from {numbers}",
        # Approved, not DRAFT — see the docstring.
        status=RequisitionStatus.APPROVED.value,
        approved_by_name=user.full_name,
        approved_at=utcnow(),
        # The first MR, so anything reading the old single pointer still works.
        source_mr_id=requests[0].id,
        source_mr_no=requests[0].mr_no,
        created_by_id=user.id,
        created_by_name=user.full_name,
    )
    db.add(req)
    await db.flush()
    await _write_requisition_lines(db, req, list(merged.values()),
                                   default_date=data.required_date)

    for mr in requests:
        db.add(RequisitionSource(
            requisition_id=req.id, mr_id=mr.id, mr_no=mr.mr_no,
            indent_no=mr.indent_no, item_count=len(mr.items),
        ))

    # Approved without an approver, so the audit row is the only record that it
    # happened. Written before the commit so it lands in the same transaction.
    await write_audit(
        db, entity="pro_requisitions", entity_id=req.id, entity_no=req.req_no,
        action=AuditAction.CREATE, actor=user,
        summary=f"Consolidated {len(requests)} material request(s) into {req.req_no}",
        after={"req_no": req.req_no, "consolidated_from": numbers,
               "material_requests": len(requests), "lines": len(merged),
               "approval": "auto — the material requests were approved in Inventory"},
    )
    await db.commit()
    logger.info("requisition %s consolidated from %d material request(s): %s",
                req.req_no, len(requests), numbers)
    return await get_requisition(db, req.id)


async def requisition_sources(db: AsyncSession, req_id: int, user) -> list[dict]:
    """The material requests behind a requisition, for the detail screen."""
    await get_requisition(db, req_id, user)
    rows = (await db.execute(
        select(RequisitionSource)
        .where(RequisitionSource.requisition_id == req_id)
        .order_by(RequisitionSource.id)
    )).scalars().all()
    return [{"mr_id": row.mr_id, "mr_no": row.mr_no, "indent_no": row.indent_no,
             "item_count": row.item_count} for row in rows]


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


async def _write_requisition_lines(db: AsyncSession, req: Requisition, lines,
                                   default_date=None) -> None:
    """`default_date` is the header's "needed by", applied to every line that does not
    name its own. The date was being asked per line, which meant typing one date forty
    times to say something true of the whole document."""
    total = Decimal(0)
    # Only consulted for lines that came in at zero — a buyer who typed a rate meant it.
    fallback = await _last_known_rates(
        db, [line.item_id for line in lines if not _d(line.estimated_rate)])
    # The indent number behind each line. The column was always there and never
    # written, so a requisition raised off the field could not say which indents it
    # was serving — the header read "raised directly" over lines that were anything
    # but. One lookup for the whole document, snapshotted like every other name.
    indent_ids = {line.indent_id for line in lines if getattr(line, "indent_id", None)}
    indent_nos = dict((await db.execute(
        select(Indent.id, Indent.indent_no).where(Indent.id.in_(indent_ids))
    )).all()) if indent_ids else {}
    seen_items = set()
    for index, line in enumerate(lines, start=1):
        item = await _item_snapshot(db, line.item_id)
        if item is None:
            raise ValidationError(f"Item {line.item_id} does not exist")
        if line.item_id in seen_items:
            raise ValidationError(
                f"Item '{item.name or item.code}' is already added. "
                "An item cannot be added more than once in the same requisition."
            )
        seen_items.add(line.item_id)
        rate = _d(line.estimated_rate) or fallback.get(line.item_id, Decimal(0))
        amount = _d(line.quantity) * rate
        total += amount
        db.add(RequisitionItem(
            requisition_id=req.id, line_no=index,
            indent_id=line.indent_id, indent_item_id=line.indent_item_id,
            indent_no=getattr(line, "indent_no", None) or indent_nos.get(line.indent_id),
            item_id=item.id, item_code=item.code, item_name=item.name,
            uom_code=line.uom_code or getattr(item, "uom_code", None),
            quantity=_d(line.quantity), estimated_rate=rate,
            estimated_amount=amount,
            required_date=line.required_date or default_date,
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
    # What the document says stands; the raiser's HCM record and the settings only fill
    # in what it left blank — see `_fill_header_context`.
    await _fill_header_context(db, req)
    req.source_indent_nos = _indent_numbers(req.items)
    # Every material request folded into this one, not just the first. `source_mr_id`
    # still holds that first one, so a requisition raised before consolidation existed
    # reads exactly as it always did.
    sources = list((await db.execute(
        select(RequisitionSource)
        .where(RequisitionSource.requisition_id == req.id)
        .order_by(RequisitionSource.id)
    )).scalars().all())
    req.source_mr_nos = ([row.mr_no for row in sources if row.mr_no]
                         or ([req.source_mr_no] if req.source_mr_no else []))

    existing_rfq = await db.scalar(
        select(RFQ.id)
        .where(RFQ.requisition_id == req.id,
               RFQ.status != RFQStatus.CANCELLED.value)
        .limit(1)
    )
    req.has_rfq = bool(existing_rfq)

    # If it is on a consolidation sheet, it should not be allowed to raise an RFQ individually.
    existing_cons = await db.scalar(
        select(PurchaseConsolidationSource.id)
        .join(PurchaseConsolidation, PurchaseConsolidation.id == PurchaseConsolidationSource.consolidation_id)
        .where(PurchaseConsolidationSource.requisition_id == req.id,
               PurchaseConsolidation.status.notin_([ConsolidationStatus.CANCELLED.value, ConsolidationStatus.REJECTED.value]))
        .limit(1)
    )
    req.has_consolidation = bool(existing_cons)
    return req


async def ensure_mr_drafts(db: AsyncSession, user) -> int:
    """Give every approved, unclaimed material request a DRAFT requisition.

    §3.3 step 2-3 says Purchase picks the approved MR up; until now "picks up" meant
    remembering that the demand exists, walking to a second screen and consolidating it
    by hand. A buyer who opened the requisition list saw their own material requests
    sitting there with nothing to press, because the only thing that turned one into a
    requisition was a button on another page. The draft is now waiting for them: fill
    in the stocking point and the estimated rates, then submit it up the ladder like
    any other requisition.

    Lazy rather than a hook on MR approval: inventory sits BEFORE procurement in the
    import chain (rule 5) and may not reach forward to raise this document. Idempotent
    — `create_requisition_from_mr` refuses an MR that already has a live requisition,
    which is exactly the guard this needs, and `_consolidated_mr_ids` keeps the
    consolidated route's MRs out too.

    One bad MR never blocks the list: a request whose lines are all already ordered is
    logged and skipped, and the buyer still gets their screen.
    """
    # Reading the list needs REQUISITION_VIEW; raising a document needs
    # REQUISITION_CREATE (rule 6). An auditor who may only look must not leave a trail
    # of drafts behind them just by opening the screen.
    if perms.REQUISITION_CREATE not in await get_user_permissions(db, user):
        return 0
    claimed = await _consolidated_mr_ids(db)
    stmt = select(MaterialRequest.id).where(
        MaterialRequest.status == MRStatus.APPROVED.value)
    if claimed:
        stmt = stmt.where(MaterialRequest.id.notin_(claimed))
    made = 0
    for mr_id in (await db.execute(stmt)).scalars().all():
        try:
            await create_requisition_from_mr(db, mr_id, user)
            made += 1
        except (ValidationError, NotFoundError) as exc:
            await db.rollback()
            logger.info("no draft requisition for MR %s: %s", mr_id, exc)
    if made:
        logger.info("raised %d draft requisition(s) from approved material requests",
                    made)
    return made


async def _pending_doc_ids(db: AsyncSession, user, doc_type: str) -> list[int]:
    """The ids of one document type sitting in THIS login's approval queue.

    Off `engine.pending_for_user`, never off the document's status: PENDING_APPROVAL
    says somebody has to sign, and only `wf_pending` says who. A register filtered on
    the status would show every approver the whole queue and call all of it theirs.

    Read-only use of the engine — the module owns its status, the engine owns the
    chain (rule 8), and this asks the chain a question rather than answering one.
    """
    return [row["doc_id"] for row in
            await engine.pending_for_user(db, user, doc_types=[doc_type])]


def _status_in(stmt, status_col, status: str | None):
    """`?status=` as one value or as a comma-separated set.

    A KPI tile counts a BUCKET — "with vendor" is three statuses — and the tile has to
    open a list holding exactly what it counted. One value still works unchanged, so
    every existing link and every screen that sends one is untouched.
    """
    if not status:
        return stmt
    wanted = [part.strip().upper() for part in status.split(",") if part.strip()]
    return stmt.where(status_col.in_(wanted)) if wanted else stmt


def _only_ids(stmt, id_col, ids: list[int]):
    """Narrow to `ids`, and to nothing at all when the list is empty.

    `in_([])` is what we want and what MySQL warns about; the explicit `[0]` keeps the
    meaning ("no rows") without relying on how an empty IN is compiled.
    """
    return stmt.where(id_col.in_(ids or [0]))


async def list_requisitions(db: AsyncSession, params: PageParams,
                            status: str | None = None, search: str | None = None,
                            pending_for_me: bool = False,
                            user=None) -> dict:
    if user is not None:
        await ensure_mr_drafts(db, user)
    stmt = select(Requisition)
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user, owner_col=Requisition.created_by_id))
    stmt = _status_in(stmt, Requisition.status, status)
    if pending_for_me and user is not None:
        stmt = _only_ids(stmt, Requisition.id, await _pending_doc_ids(
            db, user, DocType.REQUISITION.value))
    
    # Apply real-time search filtering if a search query is provided.
    # We search across requisition number, project name, and warehouse name.
    if search:
        stmt = stmt.where(
            or_(
                Requisition.req_no.ilike(f"%{search}%"),
                Requisition.project_name.ilike(f"%{search}%"),
                Requisition.warehouse_name.ilike(f"%{search}%")
            )
        )
    return await _attach_pending_with(db, DocType.REQUISITION.value, await paginate(
        db, stmt.order_by(Requisition.created_at.desc()), params))


async def update_requisition(db: AsyncSession, req_id: int, data: ReqCreate,
                             user) -> Requisition:
    req = await get_requisition(db, req_id, user)
    if req.status != RequisitionStatus.DRAFT.value:
        raise ValidationError(f"Cannot edit a requisition in {req.status} status")
    for line in list(req.items):
        await db.delete(line)
    await db.flush()
    # Read before it is overwritten: an edit that never touched the address still
    # re-sends it, and this requisition may predate the warehouse-only rule.
    kept_warehouse_id = req.warehouse_id
    req.warehouse_id = data.warehouse_id
    req.project_id = data.project_id
    req.warehouse_name, req.project_name = await _place_names(
        db, data.warehouse_id, data.project_id, keep_id=kept_warehouse_id)
    req.department_id = data.department_id
    req.department_name = await _department_snapshot(db, data.department_id)
    req.company_name = data.company_name
    req.required_date = data.required_date
    req.priority = data.priority
    req.remarks = data.remarks
    await _write_requisition_lines(db, req, data.lines,
                                   default_date=data.required_date)
    await db.commit()
    return await get_requisition(db, req_id)


async def submit_requisition(db: AsyncSession, req_id: int, user) -> Requisition:
    req = await get_requisition(db, req_id, user)
    if req.status != RequisitionStatus.DRAFT.value:
        raise ValidationError(f"Cannot submit a requisition in {req.status} status")
    instance = await engine.start(
        db, DocType.REQUISITION.value, req.id,
        context={"total_amount": float(req.estimated_value),
                 # The REQUISITION's project, not the raiser's — see submit_po.
                 "project_id": req.project_id or None,
                 "doc_no": req.req_no}, user=user)
    # See submit_po: a ladder that resolves to nobody comes back APPROVED, and
    # parking the requisition at PENDING_APPROVAL strands it for good.
    if instance.status == InstanceStatus.APPROVED.value:
        req.status = RequisitionStatus.APPROVED.value
        req.approved_at = utcnow()
        req.approved_by_name = user.full_name
        req.current_approver_name = None
    else:
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

        existing_rfq = await db.scalar(
            select(RFQ.id)
            .where(RFQ.requisition_id == requisition.id,
                   RFQ.status != RFQStatus.CANCELLED.value)
            .limit(1)
        )
        if existing_rfq:
            raise ValidationError(
                f"Requisition {requisition.req_no} has already been converted to an RFQ"
            )

    sheet = None
    if data.consolidation_id:
        sheet = await consolidation.get_consolidation(db, data.consolidation_id)
        if sheet.status not in (ConsolidationStatus.APPROVED.value,
                                ConsolidationStatus.RFQ_RAISED.value):
            raise ValidationError(
                "Only an approved consolidated sheet can go out for quotation "
                f"(status {sheet.status})")

        existing_rfq = await db.scalar(
            select(RFQ.id)
            .where(RFQ.consolidation_id == sheet.id,
                   RFQ.status != RFQStatus.CANCELLED.value)
            .limit(1)
        )
        if existing_rfq:
            raise ValidationError(
                f"Consolidated sheet {sheet.cons_no} has already been converted to an RFQ"
            )

    if data.evaluation_method and not evaluation.is_valid(data.evaluation_method):
        raise ValidationError(
            f"{data.evaluation_method!r} is not an evaluation method")

    # Everything the source document already said, carried across rather than retyped:
    # a tender that loses the warehouse and the project it is buying for cannot be
    # read on its own, and the buyer was filling those in a second time by hand. The
    # caller still wins where it sent a value — an RFQ may deliberately be raised for
    # a different stocking point than the one that asked.
    source = requisition or sheet
    warehouse_id = data.warehouse_id or (getattr(source, "warehouse_id", None))
    project_id = data.project_id or (getattr(source, "project_id", None))
    # An address CARRIED ACROSS from the source is grandfathered; one the caller typed
    # is not. The buyer raising this tender did not choose the requisition's address
    # and cannot fix it from here, and two live requisitions still sit on field points
    # — refusing would strand them. Sending the tender somewhere else is a choice, and
    # that choice is checked.
    inherited = None if data.warehouse_id else getattr(source, "warehouse_id", None)
    warehouse_name, project_name = await _place_names(
        db, warehouse_id, project_id, keep_id=inherited)

    rfq = RFQ(
        # The project goes into the number (2026-08-21): a requisition now reads
        # BHS/MMU/2026-27/REQ0001. Same `project_name` the snapshot column below
        # uses, so the number and the document can never disagree.
        rfq_no=await next_number(db, DocType.RFQ.value,
                                 project=project_name
                                 or getattr(source, "project_name", None)),
        rfq_date=utcnow().date(),
        title=data.title or (f"Quotation for {requisition.req_no}" if requisition
                             else f"Quotation for {sheet.cons_no}" if sheet else None),
        requisition_id=requisition.id if requisition else None,
        requisition_no=requisition.req_no if requisition else None,
        consolidation_id=sheet.id if sheet else None,
        consolidation_no=sheet.cons_no if sheet else None,
        warehouse_id=warehouse_id,
        warehouse_name=warehouse_name or getattr(source, "warehouse_name", None),
        project_id=project_id,
        project_name=project_name or getattr(source, "project_name", None),
        # Carried from the source, or typed on the form when the RFQ is raised cold —
        # a tender with no requisition behind it still has to say who is buying.
        department_id=data.department_id or getattr(source, "department_id", None),
        department_name=(await _department_snapshot(db, data.department_id)
                         or getattr(source, "department_name", None)),
        company_name=data.company_name or getattr(source, "company_name", None),
        due_date=data.due_date,
        terms=data.terms or (getattr(source, "remarks", None) if source else None),
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
    # Who is allowed to be asked for THESE items. Read once, and only when somebody is
    # actually being added — an edit that touches nothing but the due date must not pay
    # for this query, and must not fail on an invitation that predates the rule.
    eligible: set[int] | None = None
    if any(vendor_id not in current for vendor_id in wanted):
        item_ids = (await db.execute(
            select(RFQItem.item_id).where(RFQItem.rfq_id == rfq.id)
        )).scalars().all()
        eligible = set((await db.execute(
            select(VendorItem.vendor_id).where(VendorItem.item_id.in_(item_ids))
        )).scalars().all()) if item_ids else set()

    for vendor_id in wanted:
        if vendor_id in current:
            continue
        vendor = await db.get(Vendor, vendor_id)
        if vendor is None:
            raise ValidationError(f"Vendor {vendor_id} does not exist")
        # The picker already narrows to these, so reaching this is either a hand-made
        # request or an item whose vendors were unmapped after the tender was drafted.
        # Named rather than counted: "not mapped to supply any of these items" is a
        # sentence somebody can act on in the item master, which is where the fix is.
        if eligible is not None and vendor_id not in eligible:
            raise ValidationError(
                f"{vendor.name} is not mapped to supply any of the items on this RFQ. "
                f"Map them on the item's vendor list first.")
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

    # What the RFQ itself says stands. Where it says nothing, the requisition behind it
    # answers — and failing that, the raiser's own HCM record. Department follows the
    # REQUISITION's raiser rather than the buyer's: Purchase raises the tender, but the
    # department that asked is the useful fact.
    requisition = (await db.get(Requisition, rfq.requisition_id)
                   if rfq.requisition_id else None)
    if requisition is not None:
        for field in ("department_id", "department_name", "company_name"):
            if getattr(rfq, field, None) in (None, ""):
                setattr(rfq, field, getattr(requisition, field, None))
    # Still blank on both documents: fall back to whoever asked — the requisition's
    # raiser where there is one, the buyer otherwise.
    fallback = await _header_context(
        db, requisition.created_by_id if requisition else rfq.created_by_id)
    for field, value in fallback.items():
        if getattr(rfq, field, None) in (None, ""):
            setattr(rfq, field, value)
    rfq.priority = requisition.priority if requisition else None
    rfq.requisition_status = requisition.status if requisition else None
    rfq.source_indent_nos = _indent_numbers(
        (await db.execute(
            select(RequisitionItem)
            .where(RequisitionItem.requisition_id == requisition.id)
            .order_by(RequisitionItem.line_no)
        )).scalars().all()
    ) if requisition else []
    return rfq


async def list_rfqs(db: AsyncSession, params: PageParams, status: str | None = None,
                    search: str | None = None, pending_for_me: bool = False,
                    ready_to_award: bool = False, user=None) -> dict:
    stmt = select(RFQ)
    if user is not None:
        stmt = stmt.where(await scope_condition(db, user, owner_col=RFQ.created_by_id))
    stmt = _status_in(stmt, RFQ.status, status)
    if pending_for_me and user is not None:
        stmt = _only_ids(stmt, RFQ.id, await _pending_doc_ids(
            db, user, DocType.RFQ.value))
    if ready_to_award:
        # The same predicate `stats.rfq_stats` counts, written once here and once
        # there because the two live in different files — a tender that is open or
        # closed, has replies, and has no winner. If one moves, move both.
        stmt = stmt.where(
            RFQ.status.in_((RFQStatus.PUBLISHED.value, RFQStatus.CLOSED.value)),
            RFQ.response_count > 0,
            RFQ.awarded_vendor_id.is_(None),
        )
    
    # Apply real-time search filtering if a search query is provided.
    # We search across RFQ number, title, project name, and warehouse name.
    if search:
        stmt = stmt.where(
            or_(
                RFQ.rfq_no.ilike(f"%{search}%"),
                RFQ.title.ilike(f"%{search}%"),
                RFQ.project_name.ilike(f"%{search}%"),
                RFQ.warehouse_name.ilike(f"%{search}%")
            )
        )
    return await _attach_pending_with(db, DocType.RFQ.value, await paginate(
        db, stmt.order_by(RFQ.created_at.desc()), params))


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
    # Read before the loop overwrites it, for the reason `_place_names` gives about
    # grandfathering: 9 live RFQs sit on an LIP address they were raised with.
    kept_warehouse_id = rfq.warehouse_id
    for field in ("title", "due_date", "terms", "warehouse_id", "project_id"):
        value = getattr(data, field)
        if value is not None:
            setattr(rfq, field, value)
    if data.warehouse_id is not None or data.project_id is not None:
        rfq.warehouse_name, rfq.project_name = await _place_names(
            db, rfq.warehouse_id, rfq.project_id, keep_id=kept_warehouse_id)
    if data.department_id is not None:
        rfq.department_id = data.department_id
        rfq.department_name = await _department_snapshot(db, data.department_id)
    if data.company_name is not None:
        rfq.company_name = data.company_name
    if data.lines is not None:
        for line in list(rfq.items):
            await db.delete(line)
        await db.flush()
        await _write_rfq_lines(db, rfq, data.lines)
    if data.vendor_ids is not None:
        await _set_rfq_vendors(db, rfq, data.vendor_ids)
    await db.commit()
    return await get_rfq(db, rfq_id)


async def set_rfq_quantities(db: AsyncSession, rfq_id: int,
                             data: RFQQuantitiesIn, user) -> RFQ:
    """Trim the quantities on a tender that is waiting to be signed.

    The approver's own edit. `update_rfq` cannot be it: that route needs `rfq.create`,
    which an approver does not hold, and it rewrites the whole document — deadline,
    vendors, item list — none of which is theirs to change. Approving is a decision
    about HOW MUCH, so how much is the one thing that moves here.

    Allowed while the RFQ is still DRAFT or PENDING_APPROVAL, and never once it is
    PUBLISHED: past that a vendor has been shown the quantity and may already have
    quoted against it. Every change is logged with who made it.

    The edited numbers are what the supplier receives — `_publish_rfq` copies
    `RFQItem.quantity` into the draft `QuotationItem` at publish time, so trimming
    here trims what the vendor is asked to price. Increase is refused: an approval
    can trim a request, never inflate it. 0 removes the line; removing the last
    line is refused so the RFQ never publishes empty.
    """
    rfq = await get_rfq(db, rfq_id, user)
    EDITABLE = (RFQStatus.DRAFT.value, RFQStatus.PENDING_APPROVAL.value)
    if rfq.status not in EDITABLE:
        raise ValidationError(
            f"Quantities can only be changed before an RFQ is published "
            f"(this one is {rfq.status})")
    # PENDING_APPROVAL may only be edited by the current approver — same check
    # `update_po_approval_quantities` makes. DRAFT is the buyer's own document.
    if rfq.status == RFQStatus.PENDING_APPROVAL.value:
        actionable = await engine.actionable_doc_ids(db, DocType.RFQ.value, [rfq.id], user)
        if rfq.id not in actionable:
            raise ValidationError("Only the current approver can edit quantities while awaiting approval")

    if not data.lines:
        raise ValidationError("No quantities supplied")

    by_id = {line.id: line for line in rfq.items}
    if not by_id:
        raise ValidationError("RFQ has no lines to edit")
    # Guard unknown ids before mutating anything
    for incoming in data.lines:
        if incoming.id not in by_id:
            raise ValidationError(f"Line {incoming.id} is not on {rfq.rfq_no}")

    changes: list[str] = []
    to_delete: list[int] = []
    for incoming in data.lines:
        line = by_id.get(incoming.id)
        if line is None:
            raise ValidationError(f"Line {incoming.id} is not on {rfq.rfq_no}")
        was = _d(line.quantity)
        now = _d(incoming.quantity)
        if was == now:
            continue
        if now > was:
            raise ValidationError(f"Quantities can only be decreased (item {line.item_code or line.item_id}: {was} -> {now})")
        if now < 0:
            raise ValidationError(f"Quantity cannot be negative (item {line.item_code or line.item_id})")
        if now == 0:
            to_delete.append(line.id)
            changes.append(f"{line.item_code or line.item_id}: {was} -> Removed")
            continue
        line.quantity = now
        changes.append(f"{line.item_code or line.item_id}: {was} -> {now}")

    # Deleting — ensure at least one line remains
    if to_delete:
        if len(to_delete) >= len(by_id):
            raise ValidationError("Cannot remove all lines — an RFQ must keep at least one item")
        for line_id in to_delete:
            await db.delete(by_id[line_id])

    if changes:
        # keep header count in sync — the RFQ form and the vendor portal both read it
        remaining = len(by_id) - len(to_delete)
        rfq.total_items = remaining
        logger.info("%s quantities changed by %s (%s)",
                    rfq.rfq_no, user.full_name, "; ".join(changes))
        await db.flush()
    await db.commit()
    return await get_rfq(db, rfq_id, user)


async def submit_rfq(db: AsyncSession, rfq_id: int, user) -> RFQ:
    rfq = await get_rfq(db, rfq_id, user)
    if rfq.status != RFQStatus.DRAFT.value:
        raise ValidationError(f"Cannot submit an RFQ in {rfq.status} status")
    if not rfq.vendors:
        raise ValidationError("Add at least one vendor before sending an RFQ out")
    instance = await engine.start(db, DocType.RFQ.value, rfq.id,
                                  context={"vendor_count": rfq.vendor_count,
                                           # The RFQ's project, not the buyer's — see
                                           # submit_po.
                                           "project_id": rfq.project_id or None,
                                           "doc_no": rfq.rfq_no}, user=user)
    # See submit_po: a ladder that resolves to nobody comes back APPROVED, and
    # parking the RFQ at PENDING_APPROVAL strands it for good. Approved means
    # PUBLISHED for an RFQ — `_publish_rfq` is the same call `act_on_rfq` makes, so a
    # ladder-free project opens the RFQ to its vendors exactly as an approved one
    # does, rather than inventing a status the enum does not have.
    if instance.status == InstanceStatus.APPROVED.value:
        await _publish_rfq(db, rfq)
    else:
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
            # The RFQ's project: a quote answers one enquiry and belongs to whatever
            # that enquiry was raised for.
            quotation_no=await next_number(db, DocType.QUOTATION.value,
                                           project=rfq.project_name),
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


async def get_quotation(db: AsyncSession, quote_id: int, user=None) -> Quotation:
    """FIXED 2026-08-20 — the list is bounded by the RFQ's rung and this was not, so a
    quotation hidden from the register opened by id and gave up the vendor's price.
    WITHOUT this, scoping `list_quotations` only hides the row from the grid.

    Bounded exactly as the list is — through the RFQ it answers. 404, not 403.
    """
    stmt = select(Quotation).where(Quotation.id == quote_id)
    if user is not None:
        stmt = stmt.where(Quotation.rfq_id.in_(
            select(RFQ.id).where(
                await scope_condition(db, user, owner_col=RFQ.created_by_id))))
    quote = (await db.execute(stmt)).scalar_one_or_none()
    if quote is None:
        raise NotFoundError(f"Quotation {quote_id} not found")
    return quote


async def list_quotations(db: AsyncSession, params: PageParams,
                          rfq_id: int | None = None,
                          vendor_id: int | None = None,
                          search: str | None = None,
                          status: str | None = None,
                          user=None) -> dict:
    """FIXED 2026-08-20 — the quotation register was the one procurement list with no
    rung on it, while `list_rfqs`, `list_pos` and `list_requisitions` all carry one.

    A quotation is a vendor's PRICE. Unscoped, `rfq.compare` handed every buyer in the
    company every supplier's rates on every tender — including tenders raised by
    another region, for projects they have nothing to do with. WITHOUT this, commercial
    terms are readable network-wide from a permission meant to compare one RFQ.

    Bounded through the RFQ it answers, because `pro_quotations` carries no project or
    warehouse of its own: if the login may see the tender, they may see its replies.
    That keeps this list and the comparison sheet on the same rung by construction.
    """
    stmt = select(Quotation)
    if user is not None:
        stmt = stmt.where(Quotation.rfq_id.in_(
            select(RFQ.id).where(
                await scope_condition(db, user, owner_col=RFQ.created_by_id))))
    if rfq_id is not None:
        stmt = stmt.where(Quotation.rfq_id == rfq_id)
    if vendor_id is not None:
        stmt = stmt.where(Quotation.vendor_id == vendor_id)
    stmt = _status_in(stmt, Quotation.status, status)
        
    # Apply real-time search filtering if a search query is provided.
    # We search across quotation number and vendor name.
    if search:
        stmt = stmt.where(
            or_(
                Quotation.quotation_no.ilike(f"%{search}%"),
                Quotation.vendor_name.ilike(f"%{search}%")
            )
        )
    return await paginate(db, stmt.order_by(Quotation.created_at.desc()), params)


def _line_breakup(line) -> dict:
    """One quoted line, split the way a buyer reads it.

    Computed here rather than in the screen for the reason every other total is: the
    arithmetic that decides a winner must be the same arithmetic that wrote
    `quotation.sub_total`, and two implementations of it will disagree eventually.

    Discount comes off before tax, exactly as `_quote_totals` does it. The GST split
    is the vendor's own where they gave one; where they only named a single
    `tax_percent`, that is what is charged and the split is left empty rather than
    invented — an offer says what it says.
    """
    quantity = _d(line.quantity)
    gross = quantity * _d(line.rate)
    discount = gross * _d(line.discount_percent or 0) / 100
    taxable = gross - discount
    cgst = taxable * _d(line.cgst_rate or 0) / 100
    sgst = taxable * _d(line.sgst_rate or 0) / 100
    igst = taxable * _d(line.igst_rate or 0) / 100
    split = cgst + sgst + igst
    tax = split if split else taxable * _d(line.tax_percent or 0) / 100
    return {
        "quantity": float(quantity),
        "rate": float(_d(line.rate)),
        "discount_percent": float(_d(line.discount_percent or 0)),
        "discount_amount": float(discount),
        "taxable_amount": float(taxable),
        "tax_percent": float(_d(line.tax_percent or 0)),
        "cgst_rate": float(line.cgst_rate) if line.cgst_rate is not None else None,
        "cgst_amount": float(cgst) if line.cgst_rate is not None else None,
        "sgst_rate": float(line.sgst_rate) if line.sgst_rate is not None else None,
        "sgst_amount": float(sgst) if line.sgst_rate is not None else None,
        "igst_rate": float(line.igst_rate) if line.igst_rate is not None else None,
        "igst_amount": float(igst) if line.igst_rate is not None else None,
        "tax_amount": float(tax),
        "line_total": float(taxable + tax),
        "delivery_days": line.delivery_days,
    }


def _comparison_grid(rfq: RFQ, quotes) -> list[dict]:
    """The sheet itself: one row per RFQ line, one cell per vendor.

    Keyed on `rfq_item_id` so a vendor who quoted the lines in a different order still
    lands in the right row, falling back to the item id for an older quotation whose
    lines never carried the pointer.

    `is_best` marks the cheapest LANDED cell on that row — the lowest total for that
    item, tax included, which is the number a buyer is actually comparing. It is a
    label, not a rule: nothing here refuses an award to any other cell.
    """
    rows: list[dict] = []
    for item in sorted(rfq.items, key=lambda line: line.line_no):
        cells = []
        for quote in quotes:
            line = next(
                (l for l in quote.items
                 if (l.rfq_item_id and l.rfq_item_id == item.id)
                 or (not l.rfq_item_id and l.item_id == item.item_id)),
                None,
            )
            if line is None or not _d(line.rate):
                continue
            cells.append({"quotation_id": quote.id, "vendor_id": quote.vendor_id,
                          "vendor_name": quote.vendor_name, **_line_breakup(line)})
        def _unit_cost(c):
            return c["line_total"] / c["quantity"] if c["quantity"] else c["line_total"]

        best = min(cells, key=_unit_cost, default=None)
        for cell in cells:
            cell["is_best"] = best is not None and _unit_cost(cell) == _unit_cost(best)
        rows.append({
            "rfq_item_id": item.id,
            "item_id": item.item_id,
            "item_code": item.item_code,
            "item_name": item.item_name,
            "uom_code": item.uom_code,
            "quantity": float(_d(item.quantity)),
            "required_date": item.required_date,
            "best_quotation_id": best["quotation_id"] if best else None,
            "cells": cells,
        })
    return rows


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

    candidates = []
    for quote in quotes:
        normalized_price = Decimal("0")
        normalized_landed_cost = Decimal("0")
        for item in rfq.items:
            line = next(
                (l for l in quote.items
                 if (l.rfq_item_id and l.rfq_item_id == item.id)
                 or (not l.rfq_item_id and l.item_id == item.item_id)),
                None,
            )
            if line and _d(line.quantity) > 0:
                breakup = _line_breakup(line)
                unit_price = Decimal(str(breakup["taxable_amount"])) / _d(line.quantity)
                unit_landed = Decimal(str(breakup["line_total"])) / _d(line.quantity)
                normalized_price += unit_price * _d(item.quantity)
                normalized_landed_cost += unit_landed * _d(item.quantity)
        
        # Add freight only once, as it is a document-level charge
        normalized_landed_cost += _d(quote.freight_amount)

        candidates.append(
            evaluation.Candidate(
                ref=quote.id,
                price=normalized_price or _d(quote.sub_total) or _d(quote.grand_total),
                landed_cost=normalized_landed_cost or _d(quote.grand_total),
                lead_days=quote.delivery_days,
                expected_delivery_date=quote.expected_delivery_date,
            )
        )

    ranked = evaluation.rank(candidates, chosen)

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

    # The sheet, and the column footers under it. Both are built from the same lines
    # the ranking read, so what the screen shows and what the award accepts cannot
    # drift apart. `best_line_count` answers the question a buyer asks out loud —
    # "who is cheapest on the most items" — which is not always who is cheapest overall.
    grid = _comparison_grid(rfq, ordered)
    best_lines: dict[int, int] = {}
    for row in grid:
        for cell in row["cells"]:
            if cell["is_best"]:
                best_lines[cell["quotation_id"]] = best_lines.get(cell["quotation_id"], 0) + 1
    champion = ranked[0].ref if ranked else None
    totals = [{
        "quotation_id": quote.id,
        "quotation_no": quote.quotation_no,
        "vendor_id": quote.vendor_id,
        "vendor_name": quote.vendor_name,
        "status": quote.status,
        "rank_position": quote.rank_position,
        "evaluation_score": float(quote.evaluation_score)
                            if quote.evaluation_score is not None else None,
        "sub_total": float(_d(quote.sub_total)),
        "discount_amount": float(_d(quote.discount_amount)),
        "tax_amount": float(_d(quote.tax_amount)),
        "freight_amount": float(_d(quote.freight_amount)),
        "grand_total": float(_d(quote.grand_total)),
        "expected_delivery_date": quote.expected_delivery_date,
        "delivery_days": quote.delivery_days,
        "payment_terms": quote.payment_terms,
        "valid_till": quote.valid_till,
        "submitted_at": quote.submitted_at,
        "revision_count": quote.revision_count,
        "best_line_count": best_lines.get(quote.id, 0),
        # A suggestion and nothing more: it is the top of the ranking under the method
        # in force, and the buyer may award any column on the sheet.
        "is_recommended": quote.id == champion,
    } for quote in ordered]

    return {
        "rfq": rfq,
        "quotations": ordered,
        "items": grid,
        "totals": totals,
        "evaluation_method": chosen,
        "responded": len(ranked),
        "recommended_quotation_id": champion,
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
        password_hash=await hash_password_async(DEFAULT_VENDOR_PASSWORD),
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
    account.password_hash = await hash_password_async(DEFAULT_VENDOR_PASSWORD)
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
            or not await verify_password_async(password, account.password_hash)):
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
    if account is None or not await verify_password_async(current, account.password_hash):
        raise AuthenticationError("Current password is incorrect")
    if new == DEFAULT_VENDOR_PASSWORD:
        raise ValidationError("Choose a password that is not the shared default")
    account.password_hash = await hash_password_async(new)
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
                           params: PageParams, search: str | None = None,
                           status: str | None = None) -> dict:
    stmt = (
        select(RFQ, RFQVendor.status)
        .join(RFQVendor, RFQVendor.rfq_id == RFQ.id)
        .where(RFQVendor.vendor_id == vendor_id, _vendor_visible())
    )
    
    # Apply real-time search filtering for the supplier portal if a search query is provided.
    # We search across RFQ number and title.
    if search:
        stmt = stmt.where(
            or_(
                RFQ.rfq_no.ilike(f"%{search}%"),
                RFQ.title.ilike(f"%{search}%")
            )
        )
    # Narrowing only, and only within `_vendor_visible()` — a vendor asking for DRAFT
    # gets an empty page, never an internal RFQ.
    if status:
        stmt = stmt.where(RFQ.status == status, _vendor_visible())
    stmt = stmt.order_by(RFQ.created_at.desc())
    
    total = await db.scalar(select(func.count()).select_from(stmt.subquery()))
    result = await db.execute(stmt.offset(params.offset).limit(params.size))
    items = []
    for rfq, vendor_status in result.all():
        rfq.vendor_status = vendor_status
        items.append(rfq)
    return {"items": items, "total": total or 0, "page": params.page, "size": params.size}


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
    
    if quote.status == QuotationStatus.DRAFT.value and not quote.payment_terms:
        vendor = await db.get(Vendor, vendor_id)
        if vendor and vendor.payment_terms_days is not None:
            quote.payment_terms = f"Net {vendor.payment_terms_days} days"

    await _attach_tax_context(db, quote)
    return quote


async def _attach_tax_context(db: AsyncSession, quote: Quotation) -> dict[int, dict]:
    """Tell the quote form which tax applies and how much of it is allowed.

    Transient, like every other derived header field here: the ceiling is whatever the
    HSN says at the moment the form is opened, and the region is a fact about two
    GSTINs. Storing either would be storing an answer that can change without anybody
    editing the quotation.

    Returns the per-item ceilings so the submit path can validate against exactly what
    the form was shown, rather than looking them up a second way.
    """
    vendor = await db.get(Vendor, quote.vendor_id)
    company_gstin = await _company_gstin(db)
    region = tax_region(company_gstin, getattr(vendor, "gstin", None))
    ceilings = await _hsn_ceilings(db, [line.item_id for line in quote.items])
    # What the tender actually asked for. Read here rather than trusted off the quote:
    # `QuotationItem.quantity` is the vendor's answer and may be short of the request.
    asked = {row.id: row for row in (await db.execute(
        select(RFQItem).where(RFQItem.rfq_id == quote.rfq_id)
    )).scalars().all()}

    quote.tax_region = region
    quote.company_gstin = company_gstin
    quote.vendor_gstin = getattr(vendor, "gstin", None)
    for line in quote.items:
        source = asked.get(line.rfq_item_id)
        line.requested_quantity = float(source.quantity if source else line.quantity)
        line.required_date = source.required_date if source else None
        limits = ceilings.get(line.item_id)
        line.hsn_code = limits["hsn_code"] if limits else None
        # No HSN means no ceiling — the field stays open rather than closing to zero.
        line.max_cgst_rate = limits["cgst_rate"] if limits else None
        line.max_sgst_rate = limits["sgst_rate"] if limits else None
        line.max_igst_rate = limits["igst_rate"] if limits else None
    return ceilings


def _checked_gst(incoming, interstate: bool, limits: dict | None,
                 label: str) -> tuple[float, float, float]:
    """The GST split for one quoted line: which halves apply, and capped at the HSN.

    A rate sent for the wrong side of the split is REJECTED rather than dropped. A
    vendor who typed 9 + 9 on an interstate order meant to charge 18%, and silently
    zeroing it would accept an offer they did not make.

    `tax_percent` is honoured as a whole-rate shorthand for a vendor (or a screen) that
    sends only one number: it is spread across whichever halves apply, so the same
    payload works both ways.
    """
    cgst, sgst, igst = incoming.cgst_rate, incoming.sgst_rate, incoming.igst_rate
    whole = float(incoming.tax_percent or 0)

    if interstate:
        if cgst or sgst:
            raise ValidationError(
                f"{label}: this is an inter-state supply — quote IGST only, not CGST/SGST")
        igst = float(igst) if igst is not None else whole
        cgst = sgst = 0.0
    else:
        if igst:
            raise ValidationError(
                f"{label}: this is an intra-state supply — quote CGST and SGST, not IGST")
        if cgst is None and sgst is None:
            cgst = sgst = whole / 2
        else:
            cgst, sgst = float(cgst or 0), float(sgst or 0)
        igst = 0.0

    if limits:
        ceiling = ("igst_rate", igst) if interstate else None
        for field, value in ([ceiling] if ceiling else
                             [("cgst_rate", cgst), ("sgst_rate", sgst)]):
            allowed = limits[field]
            if value > allowed + 1e-9:
                raise ValidationError(
                    f"{label}: {field[:4].upper()} may not exceed {allowed}% — the rate "
                    f"notified for HSN {limits['hsn_code']}. Quote at or below it."
                )
    return cgst, sgst, igst


async def vendor_submit_quotation(db: AsyncSession, vendor_id: int, rfq_id: int,
                                  data: QuoteSubmit) -> Quotation:
    """Save the vendor's offer. Re-submitting before the deadline is allowed and
    bumps `revision_count` — a buyer must be able to see they moved."""
    rfq = await vendor_get_rfq(db, vendor_id, rfq_id)
    if rfq.status != RFQStatus.PUBLISHED.value:
        raise ValidationError("This RFQ is closed and no longer accepts quotations")
    if rfq.due_date and rfq.due_date < utcnow().date():
        raise ValidationError("The submission deadline for this RFQ has passed")

    # The emailed code, checked BEFORE anything is written. Whoever holds the portal
    # link can reach this endpoint; the code is what proves they are also reading the
    # address the vendor is registered under. Spending it here rather than after the
    # save means a replay cannot ride in behind a submission that failed validation.
    await quote_otp.verify(db, rfq_id, vendor_id, data.otp_code)

    quote = await vendor_get_quotation(db, vendor_id, rfq_id)
    # The same two rules the form was drawn with, enforced here because the form is not
    # the guard: this endpoint is reachable by anyone holding a vendor token.
    ceilings = await _attach_tax_context(db, quote)
    interstate = quote.tax_region == "INTER"

    lines_by_rfq_item = {line.rfq_item_id: line for line in quote.items}
    for index, incoming in enumerate(data.lines, start=1):
        line = lines_by_rfq_item.get(incoming.rfq_item_id)
        if line is None:
            raise ValidationError(
                f"Line {incoming.rfq_item_id} is not on this RFQ")
        label = line.item_name or line.item_code or f"line {index}"
        cgst, sgst, igst = _checked_gst(
            incoming, interstate, ceilings.get(line.item_id), label)
        # What they can supply. Short is an ordinary answer — a vendor with 6 of the 10
        # asked for should be able to say so instead of promising 10 — but more is not:
        # the PO rolls its quantities back onto the requisition and the material
        # request behind it, and an offer larger than the request would over-order both.
        if incoming.quantity is not None:
            offered = _d(incoming.quantity)
            requested = _d(getattr(line, "requested_quantity", None) or line.quantity)
            if offered > requested:
                raise ValidationError(
                    f"{label}: {offered} is more than the {requested} asked for. "
                    "Quote for that quantity or less.")
            line.quantity = offered
        line.line_no = index
        line.rate = _d(incoming.rate)
        line.discount_percent = _d(incoming.discount_percent)
        line.cgst_rate = cgst
        line.sgst_rate = sgst
        line.igst_rate = igst
        # The headline rate is the sum of the split that actually applies, never a
        # third number typed alongside it — `_quote_totals` charges tax_percent, and a
        # split that disagrees with it is a total nobody can reconcile.
        line.tax_percent = _d((cgst or 0) + (sgst or 0) + (igst or 0))
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
    # The derived fields are transient and a refresh drops them. Re-read, so the reply
    # to a submission says the same thing a fresh GET would — including what was asked
    # for, which the screen draws the vendor's own quantity against.
    await _attach_tax_context(db, quote)
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
_DESPATCHABLE = (
    POStatus.SENT_TO_VENDOR.value,
    POStatus.ACCEPTED_BY_SUPPLIER.value,
    POStatus.PARTIALLY_RECEIVED.value,
)

# What a vendor may READ, which is wider than what they may still despatch against.
# An order they filled and we closed used to vanish off their portal the moment the
# last GRN landed, so a supplier could not look up what they had delivered, on which
# order, at what price — the record of their own completed work. Closing an order ends
# the WORK, not the vendor's right to see it.
#
# Kept separate from `_DESPATCHABLE` deliberately: the despatch-note guard still tests
# that tuple, so a vendor can read a CLOSED order and still cannot file against it.
# Nothing before SENT_TO_VENDOR is here — a draft or an unapproved PO is internal.
_VENDOR_READABLE = _DESPATCHABLE + (
    POStatus.RECEIVED.value,
    POStatus.CLOSED.value,
    POStatus.CANCELLED.value,
)


def _was_issued_to_vendor():
    """Has this order ever been shown to the vendor?

    True when a filed revision was taken at a vendor-readable status — proof the order
    left the building at least once. That is what separates an order being REVISED
    from an internal draft the vendor was never told about, and it is read off
    `pro_po_revisions`, which `amend_po` writes before it touches anything.
    """
    return exists().where(
        PORevision.po_id == PurchaseOrder.id,
        PORevision.status.in_(_VENDOR_READABLE),
    )


def _vendor_visible_po():
    """What a vendor may SEE: an order they hold, or one being revised on them.

    NAMED `_vendor_visible_po`, not `_vendor_visible`: an RFQ predicate of that exact
    name already exists earlier in this module, and a second module-level def silently
    REPLACED it. Every vendor RFQ query then filtered on purchase-order status against
    an unjoined `pro_purchase_orders`, which cross-joined the RFQ list (836 rows where
    34 were owed, one copy per matching PO) and dropped the RFQ status filter
    altogether, so DRAFT RFQs the company had not decided to send reached the portal.
    Keep the two names distinct.

    NEW 2026-08-23. `amend_po` drops an order back to DRAFT and clears the answer, and
    DRAFT is not vendor-readable — so an amendment made the order VANISH off the
    supplier's portal until somebody internally re-approved and re-sent it, at which
    point it reappeared and read as a brand new order. Worse, `amend_po` notifies the
    vendor with a deep link to the very order they could no longer open, so the one
    message telling them anything had changed led to a 404. That is the whole of
    "the supplier isn't told their order was amended".

    Widened for READS ONLY. `_vendor_po` below is unchanged and still guards every
    write, so a vendor can watch a revision happen and can neither answer it nor
    despatch against it until we re-issue it.
    """
    return or_(PurchaseOrder.status.in_(_VENDOR_READABLE), _was_issued_to_vendor())


async def _vendor_po_visible(db: AsyncSession, vendor_id: int,
                             po_id: int) -> PurchaseOrder:
    """One order a vendor may READ. Never a write path — see `_vendor_po`."""
    po = (await db.execute(
        select(PurchaseOrder).where(
            PurchaseOrder.id == po_id,
            PurchaseOrder.vendor_id == vendor_id,
            _vendor_visible_po(),
        )
    )).scalars().first()
    if po is None:
        raise NotFoundError(f"Purchase order {po_id} not found")
    return po


async def _vendor_po(db: AsyncSession, vendor_id: int, po_id: int) -> PurchaseOrder:
    """One order a vendor may ACT on — belongs to them, and is currently issued.

    Deliberately NOT widened to orders under revision: answering or despatching
    against a version we have taken back into approval is exactly what must not
    happen. Reads go through `_vendor_po_visible`.
    """
    po = (await db.execute(
        select(PurchaseOrder).where(
            PurchaseOrder.id == po_id,
            PurchaseOrder.vendor_id == vendor_id,
            PurchaseOrder.status.in_(_VENDOR_READABLE),
        )
    )).scalars().first()
    if po is None:
        raise NotFoundError(f"Purchase order {po_id} not found")
    return po


async def vendor_respond_to_po(db: AsyncSession, vendor_id: int, po_id: int,
                               accept: bool, note: str = "", lines: list | None = None) -> PurchaseOrder:
    """The vendor's answer to an order: yes, or no with a reason.

    This is the step that turns an order into an agreement. Until it is given, the
    vendor cannot despatch against the order and the buyer cannot receive against it —
    and after it is given, the buyer can only change the order by amending it, which
    asks the question again.

    Answering twice is refused rather than ignored: a vendor who has accepted and then
    wants out is a conversation with the buyer, not a button. Their only way back is
    the buyer amending or cancelling the order.
    """
    po = await _vendor_po(db, vendor_id, po_id)
    if po.vendor_status in (POVendorStatus.ACCEPTED.value,
                            POVendorStatus.REJECTED.value):
        raise ValidationError(
            f"{po.po_no} has already been {po.vendor_status.lower()}. "
            "Ask the buyer to amend it if something needs to change.")
    if not accept and not (note or "").strip():
        raise ValidationError("Say why the order is being declined")

    po.vendor_status = (POVendorStatus.ACCEPTED.value if accept
                        else POVendorStatus.REJECTED.value)
    po.vendor_responded_at = utcnow()
    po.vendor_response_note = (note or "").strip() or None
    
    if accept:
        if lines:
            # Vendor has provided updated rates for the items
            po = (await db.execute(
                select(PurchaseOrder).options(selectinload(PurchaseOrder.items))
                .where(PurchaseOrder.id == po.id)
            )).scalars().first()
            
            sub_total = Decimal(0)
            tax_total = Decimal(0)
            lines_by_id = {line.id: line for line in lines}
            
            for item in po.items:
                if item.id in lines_by_id:
                    item.rate = _d(lines_by_id[item.id].rate)
                
                amount = _d(item.quantity) * item.rate
                item.amount = amount
                sub_total += amount
                tax_total += amount * _d(item.tax_percent or 0) / Decimal(100)
                
            _apply_po_totals(po, sub_total, tax_total)
            
            # If the supplier changed the rates, the PO needs internal re-approval
            from app.platform.hcm.models import HcmEmployee, HcmPositionAssignment
            from app.platform.workflow import engine
            from app.shared.enums import DocType, InstanceStatus
            
            creator = await db.get(HcmEmployee, po.created_by_id)
            if not creator:
                raise ValidationError("Cannot route for approval: order creator not found")
                
            # Get the creator's active position to resolve the correct ladder
            assignment = (await db.execute(
                select(HcmPositionAssignment).where(
                    HcmPositionAssignment.employee_id == creator.id,
                    HcmPositionAssignment.is_active == True
                )
            )).scalars().first()
            position_id = assignment.position_id if assignment else None
            
            # Monkeypatch the active_position_id onto the creator object for the engine
            creator.active_position_id = position_id
                
            instance = await engine.start(
                db, DocType.PO.value, po.id,
                context={"total_amount": float(po.total_amount),
                         "project_id": po.project_id or None,
                         "requester_position_id": position_id,
                         "doc_no": po.po_no},
                user=creator
            )
            
            if instance.status == InstanceStatus.APPROVED.value:
                po.status = POStatus.APPROVED.value
            else:
                po.status = POStatus.PENDING_APPROVAL.value
        else:
            po.status = POStatus.ACCEPTED_BY_SUPPLIER.value

    await db.commit()
    await db.refresh(po)
    logger.info("%s %s by vendor %s", po.po_no, po.vendor_status, vendor_id)
    return po


def _require_accepted(po: PurchaseOrder) -> None:
    """A despatch note is a claim against an agreement, so there has to be one.

    Orders sent before acceptance existed carry no answer at all; those are let
    through, because refusing them would strand deliveries that were already agreed
    by phone. Only an order explicitly still PENDING or REJECTED is blocked.
    """
    if po.vendor_status == POVendorStatus.PENDING.value:
        raise ValidationError(
            f"Accept {po.po_no} before despatching against it")
    if po.vendor_status == POVendorStatus.REJECTED.value:
        raise ValidationError(
            f"{po.po_no} was declined, so nothing can be despatched against it")


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


async def vendor_list_pos(db: AsyncSession, vendor_id: int, params: PageParams,
                          search: str | None = None,
                          status: str | None = None) -> dict:
    """The orders this vendor has been sent. Never anyone else's, never a draft."""
    stmt = (select(PurchaseOrder)
            .where(PurchaseOrder.vendor_id == vendor_id, _vendor_visible_po()))

    # Apply real-time search filtering for the supplier portal if a search query is
    # provided. Over the order number and the RFQ/quotation numbers snapshotted on it
    # — the references a supplier actually has written on their own paperwork.
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(PurchaseOrder.po_no.ilike(like),
                              PurchaseOrder.rfq_no.ilike(like),
                              PurchaseOrder.quotation_no.ilike(like)))
    # Narrowing only, and only WITHIN what this vendor may already read: an unknown or
    # internal status filters to nothing rather than widening the scope.
    if status:
        stmt = stmt.where(PurchaseOrder.status == status, _vendor_visible_po())
    stmt = stmt.order_by(PurchaseOrder.po_date.desc(), PurchaseOrder.id.desc())
    page = await paginate(db, stmt, params)
    counts = dict((await db.execute(
        select(DespatchNote.po_id, func.count(DespatchNote.id))
        .where(DespatchNote.vendor_id == vendor_id,
               DespatchNote.status != DespatchNoteStatus.CANCELLED.value)
        .group_by(DespatchNote.po_id)
    )).all())
    for row in page["items"]:
        row.despatch_note_count = counts.get(row.id, 0)
        # Derived, never stored: the row is on the board because it was issued once,
        # but its CURRENT status is not one the vendor holds — it is back with us
        # being revised, and nothing may be done against it until we re-issue it.
        row.under_revision = row.status not in _VENDOR_READABLE
    return page


async def vendor_get_po(db: AsyncSession, vendor_id: int, po_id: int) -> PurchaseOrder:
    """One order with what is still owed on each line, and the notes filed so far.

    Read scope, so an order being revised still opens — that is where the amendment
    notification points, and `revision_no` / `amendment_reason` on the payload say what
    changed and why. `under_revision` tells the portal to show it read-only.
    """
    po = await _vendor_po_visible(db, vendor_id, po_id)
    po.under_revision = po.status not in _VENDOR_READABLE
    already = await _despatched_by_po_item(db, po.id)

    po.lines = [
        SimpleNamespace(
            po_item_id=line.id, item_id=line.item_id, item_code=line.item_code,
            item_name=line.item_name, uom_code=line.uom_code,
            ordered_qty=_d(line.quantity),
            despatched_qty=already.get(line.id, Decimal(0)),
            pending_qty=max(_d(line.quantity) - already.get(line.id, Decimal(0)),
                            Decimal(0)),
            rate=float(line.rate),
            amount=float(line.amount),
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


async def vendor_po_revisions(db: AsyncSession, vendor_id: int, po_id: int) -> list:
    """The vendor gets to see the revisions for an order sent to them."""
    await _vendor_po_visible(db, vendor_id, po_id)  # Auth check (read scope)
    return list((await db.execute(
        select(PORevision).where(PORevision.po_id == po_id)
        .order_by(PORevision.revision_no.desc(), PORevision.id.desc())
    )).scalars().all())


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
    # An order the vendor has not answered yet is not an agreement to deliver against.
    _require_accepted(po)

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

    today = ist_today()
    # WITHOUT this a vendor could promise delivery before the day they wrote the note.
    # The receiving desk chases against `expected_date`, so a date already gone reads
    # as an overdue shipment the moment it is filed — the document arrives late.
    if data.expected_date and data.expected_date < today:
        raise ValidationError(
            f"Expected delivery {data.expected_date} is in the past")
    # The other direction, and the same class of error: an invoice cannot be raised
    # for a day that has not happened.
    if data.invoice_date and data.invoice_date > today:
        raise ValidationError(f"Invoice date {data.invoice_date} is in the future")

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
        # FIXED 2026-08-20 — the dates were unbounded in both directions. The form now
        # sets min/max on the pickers, but an attribute on an <input> stops a mouse and
        # nothing else: the same payload posted by hand went straight in. Checked here
        # too, which is the only place it is actually enforced.
        if line.mfg_date and line.mfg_date > today:
            raise ValidationError(
                f"{po_line.item_code or po_line.item_name}: nothing is manufactured "
                "in the future")
        if line.expiry_date and line.expiry_date < today:
            raise ValidationError(
                f"{po_line.item_code or po_line.item_name}: that stock expired on "
                f"{line.expiry_date} and cannot be despatched")

    if note is None:
        note = DespatchNote(
            # The order's project: a despatch note is the vendor's statement about one
            # purchase order and belongs wherever that order does.
            dn_no=await next_number(db, DocType.DESPATCH_NOTE.value,
                                    project=po.project_name),
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


def _assert_eway_bill_format(value: str | None) -> None:
    """An e-way bill number is TWELVE DIGITS. Checked only when one is given.

    This is the other half of making the field optional. Leaving it out entirely is
    now fine; what must not happen is the box being used as somewhere to park a word.
    Before this, "NA" and a copy of the invoice number were the two commonest ways
    past a mandatory field, and the gate then read a number that is not an e-way bill
    and cannot be looked up on the portal — worse than an empty column, because an
    empty column is honest about not knowing.

    Digits only, and exactly twelve: that is the format the NIC portal issues, so
    anything else is a typo or a stand-in, and the vendor is told which.
    """
    text = (value or "").strip()
    if not text:
        return
    if not (text.isdigit() and len(text) == 12):
        raise ValidationError(
            f"{text!r} is not an e-way bill number — those are 12 digits. Leave it "
            f"empty if there is no e-way bill for this consignment, and give the "
            f"vehicle or LR number instead.")


async def vendor_submit_despatch_note(db: AsyncSession, vendor_id: int,
                                      note_id: int) -> DespatchNote:
    """File it. The invoice is required HERE, not on the draft — checked at submit so a
    note can be started while the invoice is still being raised.

    THE E-WAY BILL IS NO LONGER MANDATORY (requirement 8, 2026-09-07). Doc B12 made it
    so, and that was wrong for a large part of the supply base: an e-way bill is only
    raised above a consignment value threshold, and for an intra-state delivery of a
    few boxes of gloves there is no bill to quote. Vendors were typing "NA", "0" and
    their own invoice number into the box to get past it — which is worse than leaving
    it empty, because the gate then reads a number that is not an e-way bill.

    WHAT IS STILL REQUIRED is that the note says HOW the goods travel, in one of two
    ways: the e-way bill, or an ordinary transport reference — a vehicle number, an LR
    number, or the transporter's name. That is not the old rule wearing a hat: the
    warehouse has to be able to match an arriving lorry to a document, and a note
    carrying an invoice and nothing else cannot be matched to anything at the gate.
    """
    note = await vendor_get_despatch_note(db, vendor_id, note_id)
    if note.status != DespatchNoteStatus.DRAFT.value:
        raise ValidationError(f"{note.dn_no} is already {note.status}")
    if not (note.invoice_no or "").strip():
        raise ValidationError("Invoice number is required before despatch")

    _assert_eway_bill_format(note.eway_bill_no)

    # Either mode satisfies this. Named in the order a vendor would reach for them.
    if not any((value or "").strip() for value in (
        note.eway_bill_no, note.vehicle_no, note.lr_no, note.transporter_name,
    )):
        raise ValidationError(
            "Say how this consignment travels before despatching it: an e-way bill "
            "number, or a vehicle number, LR number or transporter name.")

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


# =========================================================================== #
#  The buying trail — see `procurement/ledger.py` for what it is and why here
# =========================================================================== #

async def procurement_ledger(
    db: AsyncSession, params: PageParams, *,
    doc_kind: str | None = None, status: str | None = None,
    project: str | None = None, vendor: str | None = None,
    date_from=None, date_to=None, search: str | None = None,
) -> dict:
    """Every procurement document, filtered, newest first.

    The union is wrapped in a subquery and the FILTERS are applied to the subquery, not
    to each branch. Four branches filtered separately is four chances to get one wrong,
    and a filter that silently means something different on the PO branch than on the
    requisition branch is worse than no filter at all.

    Read-only. Nothing here writes, and the register cannot show an event the documents
    do not already carry.
    """
    trail = ledger.source().subquery("trail")
    stmt = select(trail)

    if doc_kind:
        stmt = stmt.where(trail.c.doc_kind == doc_kind)
    if status:
        stmt = stmt.where(trail.c.status == status)
    if project:
        stmt = stmt.where(trail.c.project_name == project)
    if vendor:
        stmt = stmt.where(trail.c.party == vendor)
    if date_from is not None:
        stmt = stmt.where(trail.c.doc_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(trail.c.doc_date <= date_to)
    if search and search.strip():
        like = f"%{search.strip()}%"
        stmt = stmt.where(or_(*[
            trail.c[name].ilike(like) for name in ledger.SEARCH_COLUMNS
        ]))

    # Date descending, then the id, so two documents raised on one day keep a stable
    # order instead of shuffling between pages.
    #
    # No `.nullslast()`: that emits Postgres's NULLS LAST, which MySQL rejects outright
    # (1064). MySQL already sorts NULL as the lowest value, so DESC puts an undated
    # document at the bottom, which is where it belongs anyway.
    stmt = stmt.order_by(trail.c.doc_date.desc(), trail.c.doc_id.desc())

    # Paged by hand, NOT through `core.pagination.paginate`: that helper ends in
    # `.scalars()`, which keeps only the FIRST column of each row — so every row of this
    # eleven-column register came back as the bare string "QUOTATION". `.mappings()` is
    # what a multi-column SELECT needs, and it is what `reports.service` uses for the
    # same reason on the same shape of query. The response is the same
    # {items, total, page, size} contract (rule 11).
    total = await db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    page = max(1, params.page)
    size = max(1, params.size)
    rows = await db.execute(stmt.limit(size).offset((page - 1) * size))
    return {"items": [dict(row) for row in rows.mappings()],
            "total": total, "page": page, "size": size}


async def procurement_ledger_filters(db: AsyncSession) -> dict:
    """What the filter dropdowns offer: the values actually present, never a
    hand-written list that drifts from the data."""
    trail = ledger.source().subquery("trail")

    async def distinct(column) -> list[str]:
        rows = (await db.execute(
            select(column).where(column.is_not(None)).distinct().order_by(column)
        )).scalars().all()
        return [value for value in rows if value]

    return {
        "doc_kinds": ledger.DOC_KINDS,
        "columns": ledger.COLUMNS,
        "statuses": await distinct(trail.c.status),
        "projects": await distinct(trail.c.project_name),
        "vendors": await distinct(trail.c.party),
    }


# --------------------------------------------------------------------------- #
#  Picking an approved material request up, the moment it is approved
# --------------------------------------------------------------------------- #

async def _draft_requisition_on_mr_approval(db: AsyncSession, mr, user) -> None:
    """Raise the draft requisition for a material request that has just been signed.

    The eager half of `ensure_mr_drafts`, and deliberately the SAME writer: both doors
    call `create_requisition_from_mr`, which refuses an MR that already has a live
    requisition, so whichever fires first wins and the second is a no-op. That guard is
    what makes registering this safe rather than a source of duplicates.

    Registered on inventory's hook list rather than called from inventory, because
    inventory sits BEFORE procurement in the import chain (rule 5) and may not reach a
    `pro_` document. See `app/modules/inventory/hooks.py`.

    A request this cannot turn into a requisition — every line already ordered, a
    consolidation sheet holding it — is logged and left alone. It is still picked up
    later by `ensure_mr_drafts` if it becomes eligible.
    """
    try:
        await create_requisition_from_mr(db, mr.id, user)
    except (ValidationError, NotFoundError) as exc:
        await db.rollback()
        logger.info("no draft requisition for %s: %s", mr.mr_no, exc)


# Guarded so a module reload cannot register the same hook twice and raise two drafts.
if _draft_requisition_on_mr_approval not in inventory_hooks.ON_MR_APPROVED:
    inventory_hooks.ON_MR_APPROVED.append(_draft_requisition_on_mr_approval)
