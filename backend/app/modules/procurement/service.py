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
from sqlalchemy import exists, false, func, select, true, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sqlalchemy.orm.attributes import set_committed_value

from app.core.config import settings
from app.core.exceptions import (
    AuthenticationError, NotFoundError, PermissionError_, ValidationError,
)
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
    PurchaseConsolidationItem, PurchaseConsolidationSource, PurchaseOrder, Quotation,
    QuotationComment, QuotationItem, QuoteChangeRequest, Requisition,
    POPaymentMilestone, PORevision, RequisitionItem, RequisitionSource, RFQ, RFQItem, RFQVendor,
    VendorNotification, VendorUser,
)
from app.modules.procurement.schemas import (
    AwardIn, DespatchNoteIn, POCreate, POFromQuotationIn, POHeaderUpdate, QuoteSubmit,
    ReqCreate, RFQCreate, RFQQuantitiesIn, RFQUpdate, VendorAccountIn,
)
from app.modules.procurement import consolidation, ledger, quote_otp, vendor_documents
from app.platform.hcm.models import HcmDepartment, HcmEmployee
from app.platform.mail import service as mail_service
from app.platform.mail import template as mail_template
from app.platform.mail.schemas import MailSendIn
from app.platform.notifications import service as notifications
from app.modules.procurement import packing as po_packing
from app.shared.masters import packs
from app.shared.masters.packs import pack_options
from app.shared.packing import base_of as base_of_packs
from app.platform.rbac import permissions as perms
from app.platform.rbac.service import get_user_permissions
from app.platform.settings.service import (
    get_company_letterhead, get_setting, write_audit,
)
from app.platform.workflow import engine
from app.platform.workflow.models import Action as WorkflowAction
from app.platform.workflow.models import Instance as WorkflowInstance
from app.shared import evaluation
from app.shared.models.warehouse import Warehouse
from app.shared.scope import scope_condition

logger = logging.getLogger(__name__)
from app.shared.enums import (
    CARRIER_VENDOR_TYPES, SHIPMENT_ADDRESS_WAREHOUSE_TYPES,
    AuditAction, ConsolidationStatus, DespatchNoteStatus, DocType, IndentStatus,
    InstanceStatus, MRStatus, POStatus, POVendorStatus, QuoteChangeStatus,
    QuotationStatus, RequisitionStatus, RFQStatus,
)
from app.shared.models.base import utcnow
from app.shared.time import today as ist_today
from app.shared.models.master import HsnCode, Item, Project, Vendor, VendorItem
from app.shared.numbering import next_number
from app.shared.masters import combinations


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
    term_id = getattr(data, "payment_term_id", None)
    if term_id is not None and term_id != po.payment_term_id:
        await _apply_payment_term(db, po, term_id)
    # Both columns are NOT NULL, so these are assigned only when the caller named a
    # number. Omitted, the order keeps what it had (or the column default on create).
    if getattr(data, "discount_amount", None) is not None:
        po.discount_amount = _d(data.discount_amount)
    if getattr(data, "freight_amount", None) is not None:
        po.freight_amount = _d(data.freight_amount)


async def _apply_payment_term(db: AsyncSession, po: PurchaseOrder, term_id: int) -> None:
    """Copy a payment-term master onto the order: its wording into `payment_terms` and
    its non-zero milestones into `pro_po_payment_milestones` (2026-10-06).

    Only before the order is approved. From then on accounts may have paid against
    those milestones, and swapping them would leave a payment pointing at a stage the
    order no longer has. A change after approval is an amendment conversation, not a
    dropdown.
    """
    from app.shared.enums import PAYMENT_MILESTONE_META
    from app.shared.models.master import PaymentTerm

    if po.id is not None:
        # Loaded explicitly: touching an unloaded collection is an implicit await
        # under asyncio, and replacing it needs the old rows to delete them.
        await db.refresh(po, attribute_names=["payment_milestones"])
    if po.status not in (None, POStatus.DRAFT.value, POStatus.REJECTED.value) \
            and po.payment_milestones:
        raise ValidationError(
            "Payment terms are fixed once the order is approved — accounts pays "
            "against them. Keep the current terms.")
    term = await db.get(PaymentTerm, term_id)
    if term is None or not term.is_active:
        raise ValidationError("Payment terms: pick an active payment term from the list.")
    po.payment_term_id = term.id
    from app.shared.masters.defs import term_instalments, term_wording

    # One milestone per instalment: a stage paid in four parts is four rows accounts
    # pays against, each on its own day. `term_instalments` is the same arithmetic the
    # master form previews, so the order holds exactly what the term promised.
    rows = []
    for stage in PAYMENT_MILESTONE_META:
        for part in term_instalments(term, stage["field"]):
            rows.append(POPaymentMilestone(seq=len(rows) + 1, stage=stage["value"],
                                           percent=part["order_pct"],
                                           due_days=part["days"]))
    po.payment_milestones = rows
    po.payment_terms = term_wording(term)


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


async def _attach_po_tax_context(db: AsyncSession, po) -> None:
    """Tell the order which tax applies and split each line's tax into it.

    The PO gap this closes: a quotation already derives `tax_region` the moment a
    vendor submits (`_attach_tax_context`), but nothing carried it onto the order
    raised from that quotation, and a PO raised cold never computed it at all — so
    `vendor_gstin` sat on the order with no CGST/SGST/IGST split to go with it, and
    the printed order showed a flat tax percent with no state-wise breakup at all.

    Transient, same as `_attach_tax_context`: the company's own GSTIN can be
    corrected on Settings > Company, and re-reading an old order should answer for
    the CURRENT GSTIN, not freeze whatever was true the day it was raised. Storing
    the region would be storing an answer that can go stale without anybody editing
    the order.
    """
    company_gstin = await _company_gstin(db)
    region = tax_region(company_gstin, po.vendor_gstin)
    po.tax_region = region
    po.company_gstin = company_gstin
    for line in po.items:
        tax_amount = _d(line.amount) * _d(line.tax_percent or 0) / _d(100)
        if region == "INTRA":
            half_percent = _d(line.tax_percent or 0) / _d(2)
            half_amount = tax_amount / _d(2)
            line.cgst_percent = line.sgst_percent = float(half_percent)
            line.cgst_amount = line.sgst_amount = float(half_amount)
            line.igst_percent = 0.0
            line.igst_amount = 0.0
        else:
            line.cgst_percent = 0.0
            line.sgst_percent = 0.0
            line.cgst_amount = 0.0
            line.sgst_amount = 0.0
            line.igst_percent = float(line.tax_percent or 0)
            line.igst_amount = float(tax_amount)


async def _hsn_ceilings(db: AsyncSession, item_ids: list[int]) -> dict[int, dict]:
    """Per item: the HSN code and the GST rate it notifies. The quote may not exceed it.

    Read through the item's `hsn_id` rather than its `hsn_code` snapshot — the snapshot
    is what the item was created with and the rate is whatever the code says today.
    An item with no HSN gets no ceiling: blocking it would stop the quote outright, and
    an unclassified item is a masters problem, not a vendor's.

    One rate covers both GST routes: the within-state CGST + SGST and the across-state
    IGST are the same number, so the ceiling is the same figure whichever way the goods
    are shipped.
    """
    if not item_ids:
        return {}
    rows = (await db.execute(
        select(Item.id, HsnCode.code, HsnCode.gst_rate)
        .join(HsnCode, HsnCode.id == Item.hsn_id)
        .where(Item.id.in_(item_ids))
    )).all()
    return {
        row[0]: {
            "hsn_code": row[1],
            "gst_rate": float(row[2] or 0),
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
        po_line = POItem(
            po_id=po.id, indent_item_id=line.indent_item_id, item_id=item.id,
            item_code=item.code, item_name=item.name, uom_code=item.uom_code,
            quantity=_d(line.quantity), rate=_d(line.rate),
            tax_percent=_d(line.tax_percent), amount=amount,
            **await _po_line_combination(db, item, line, line.indent_item_id),
        )
        db.add(po_line)
        await po_packing.stamp_line(db, po_line, hierarchy_id=line.pack_hierarchy_id,
                                    entries=line.pack_breakdown)
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
    await db.flush()
    await po_packing.sync_po_packing(db, po.id)

    indent.status = IndentStatus.ORDERED.value
    await indent_service.notify_indent_followers(db, indent, indent.status)
    await db.commit()
    await db.refresh(po)
    return po


def _assert_po_addresses(billing, shipping) -> None:
    """BUG_SCM_016: an order must say where it is invoiced and where the goods land.
    Checked on the hand-raised create and again on submit, which is the gate every
    order passes — one drafted from an indent or a quotation arrives with neither."""
    missing = [label for label, value in (("Billing address", billing),
                                          ("Shipping address", shipping))
               if not (value or "").strip()]
    if missing:
        raise ValidationError(f"{' and '.join(missing)} {'is' if len(missing) == 1 else 'are'} "
                              "required on a purchase order")


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
    _assert_po_addresses(getattr(data, "billing_address", None),
                         getattr(data, "shipping_address", None))

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
    if data.copied_from_po_id:
        source = await db.get(PurchaseOrder, data.copied_from_po_id)
        if source is None:
            raise ValidationError(f"Unknown purchase order {data.copied_from_po_id}")
        po.copied_from_po_id, po.copied_from_po_no = source.id, source.po_no
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
        po_line = POItem(
            po_id=po.id, item_id=item.id, item_code=item.code, item_name=item.name,
            uom_code=item.uom_code, quantity=_d(line.quantity), rate=_d(line.rate),
            tax_percent=_d(line.tax_percent), amount=amount,
            **await _po_line_combination(db, item, line, None),
        )
        db.add(po_line)
        await po_packing.stamp_line(db, po_line, hierarchy_id=line.pack_hierarchy_id,
                                    entries=line.pack_breakdown)

    _apply_po_totals(po, sub_total, tax_total)
    await db.flush()
    await po_packing.sync_po_packing(db, po.id)
    await db.commit()
    logger.info("purchase order %s raised directly by %s (%d line(s))",
                po.po_no, user.full_name, len(data.lines))
    return await get_po(db, po.id)


async def copy_po_template(db: AsyncSession, po_id: int, user) -> dict:
    """"Copy as new PO": an existing order's content as a New PO form, nothing saved.

    Nothing is written and no number is drawn — the form saves through `create_po`
    like any hand-raised order, so a copy opened and abandoned leaves no trace. What
    this decides is what the form may be pre-filled WITH, checked against today's
    masters so the save does not fail on something the buyer cannot see:

    - an inactive or blacklisted vendor, an inactive payment term or project is left
      blank (the term's wording stays — it is the buyer's text);
    - a line whose item is inactive is dropped; tax and unit come from the item master
      when it has them, since the old order's may be out of date;
    - the indent, requisition, RFQ and quotation links are never carried. That demand
      was already ordered, so the copy is a direct PO and orders nothing twice;
    - the expected date keeps its distance from the order date, counted from today.

    Any order the caller can open may be copied, whatever its status — only the
    content is taken, never its approvals, receipts, payments or attachments.
    """
    from app.shared.models.master import PaymentTerm

    if perms.PO_VIEW not in await get_user_permissions(
            db, user, getattr(user, "active_position_id", None)):
        raise PermissionError_(f"Missing permission: {perms.PO_VIEW}")
    source = await get_po(db, po_id, user, include_approver=True)
    warnings: list[str] = []

    vendor = await db.get(Vendor, source.vendor_id)
    vendor_ok = bool(vendor and vendor.is_active and not vendor.is_blacklisted)
    if not vendor_ok:
        warnings.append(f"Vendor {source.vendor_name or source.vendor_id} is no longer "
                        "active — pick the vendor again.")

    payment_term_id = source.payment_term_id
    if payment_term_id:
        term = await db.get(PaymentTerm, payment_term_id)
        if term is None or not term.is_active:
            payment_term_id = None
            warnings.append("The payment term on the original order is no longer active "
                            "— pick one again. Its wording has been kept.")

    project_id = source.project_id
    if project_id:
        project = await db.get(Project, project_id)
        if project is None or not project.is_active:
            project_id = None
            warnings.append(f"Project {source.project_name or project_id} is no longer "
                            "active — pick the project again.")

    items = {row.id: row for row in (await db.execute(
        select(Item).where(Item.id.in_([line.item_id for line in source.items]))
    )).scalars().all()} if source.items else {}
    lines, dropped = [], []
    for line in sorted(source.items, key=lambda row: row.id):
        item = items.get(line.item_id)
        if item is None or not item.is_active:
            dropped.append(line.item_name or line.item_code or str(line.item_id))
            continue
        lines.append({
            "item_id": item.id, "item_code": item.code, "item_name": item.name,
            "uom_code": item.uom_code or line.uom_code,
            "quantity": float(line.quantity), "rate": float(line.rate),
            "tax_percent": float(item.tax_percent if item.tax_percent is not None
                                 else line.tax_percent),
            **combinations.carry(line),
        })
    if dropped:
        warnings.append("Left out because the item is no longer active: "
                        + ", ".join(dropped) + ".")

    # The order-level discount was agreed on the full order; on fewer lines it may now
    # exceed what is left, which `create_po` would refuse.
    sub_total = sum(line["quantity"] * line["rate"] for line in lines)
    discount = float(source.discount_amount or 0)
    if discount > sub_total:
        discount = 0.0
        warnings.append("The discount was cleared: it is more than the copied lines "
                        "add up to.")

    expected_date = None
    if source.expected_date and source.po_date and source.expected_date > source.po_date:
        expected_date = ist_today() + (source.expected_date - source.po_date)

    return {
        "source_po_id": source.id, "source_po_no": source.po_no,
        "source_po_date": source.po_date,
        "vendor_id": source.vendor_id if vendor_ok else None,
        "vendor_name": source.vendor_name if vendor_ok else None,
        "expected_date": expected_date,
        "project_id": project_id,
        "remarks": source.remarks,
        "payment_term_id": payment_term_id,
        "payment_terms": source.payment_terms,
        "delivery_terms": source.delivery_terms,
        "material_terms": source.material_terms,
        "logistics_terms": source.logistics_terms,
        "billing_address": source.billing_address,
        "shipping_address": source.shipping_address,
        "discount_amount": discount,
        "freight_amount": float(source.freight_amount or 0),
        "lines": lines,
        "warnings": warnings,
    }


#: A purchase order that has stopped claiming anything — it never reaches a vendor and
#: nothing will ever be received against it. CANCELLED was always read this way; REJECTED
#: was not, so an order thrown out in approval went on holding its award: the RFQ kept
#: showing that dead order in the vendor's column, the "Create PO" button never came back,
#: and the awarded quantity could not be bought from anybody. The two statuses are the
#: same fact and must be tested together, or the next reader gets it wrong the same way.
_DEAD_PO_STATUSES = (POStatus.CANCELLED.value, POStatus.REJECTED.value)


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
    # Freeze Prices (2026-09-26): an order may only be raised off a tender whose
    # prices were locked before the award. WITHOUT this, a PO can be raised while
    # the suppliers' prices are still open to change — the one thing a PO cannot
    # survive, since it is an acceptance of a price that must not move.
    if not rfq.is_price_frozen:
        raise ValidationError(
            f"Prices on {rfq.rfq_no} are not frozen yet — freeze prices first; "
            "POs can only be raised from a frozen comparison")
    # And no order may be accepted while the price behind it is still being
    # negotiated: an open change request on this quote means the numbers on the
    # PO would be a version nobody has both agreed to.
    open_cr = (await db.execute(
        select(QuoteChangeRequest.id).where(
            QuoteChangeRequest.quotation_id == quote.id,
            QuoteChangeRequest.status == _CR_OPEN)
    )).scalars().first()
    if open_cr is not None:
        raise ValidationError(
            f"{quote.quotation_no} has a change request awaiting the supplier — "
            "resolve it before raising the purchase order")

    vendor = await db.get(Vendor, quote.vendor_id)
    if vendor is None:
        raise ValidationError(f"Unknown vendor {quote.vendor_id}")

    lines = [line for line in quote.items if _d(line.quantity) > 0]

    # A split award records the ceiling this supplier won beside the invitation.
    # Keep the quotation immutable and apply the ceiling only while building its PO.
    awarded = await db.scalar(select(RFQVendor.awarded_quantities).where(
        RFQVendor.rfq_id == rfq.id,
        RFQVendor.vendor_id == quote.vendor_id,
    ))
    share: dict[str, float] = awarded or {}
    order_qty: dict[int, Decimal] = {}

    # A complete-quote award is one order, full stop.  A split award is different:
    # it is a ceiling, and a buyer may later increase that ceiling after another
    # supplier's PO is rejected.  In that case retain the earlier live PO and raise a
    # second one for only the part not already ordered from this quotation.
    live_orders = list((await db.execute(
        select(PurchaseOrder)
        .options(selectinload(PurchaseOrder.items))
        .where(PurchaseOrder.quotation_id == quote.id,
               PurchaseOrder.status.notin_(_DEAD_PO_STATUSES))
        .order_by(PurchaseOrder.id)
    )).scalars().all())
    if not share and live_orders:
        raise ValidationError(
            f"{quote.quotation_no} already became {live_orders[0].po_no}")

    if share:
        already_ordered: dict[int, Decimal] = {}
        for prior_po in live_orders:
            for prior_line in prior_po.items:
                already_ordered[prior_line.item_id] = (
                    already_ordered.get(prior_line.item_id, Decimal("0"))
                    + _d(prior_line.quantity))
        kept = []
        for line in lines:
            won = _d(share.get(str(line.item_id), 0))
            # The saved award says how many this supplier may receive in total.
            # Existing live POs have already consumed part of it, so this PO contains
            # only the positive balance.  This is why a 6-unit PO followed by a
            # re-award of 10 produces a second 4-unit PO rather than duplicating 10.
            balance = won - already_ordered.get(line.item_id, Decimal("0"))
            if balance <= 0:
                continue
            # The award endpoint already rejects a share above the submitted offer.
            order_qty[line.id] = balance
            kept.append(line)
        lines = kept
    if not lines:
        prior = ", ".join(po.po_no for po in live_orders)
        suffix = f"; already covered by {prior}" if prior else ""
        raise ValidationError(
            f"{quote.quotation_no} has no remaining awarded quantities to order{suffix}")

    requisition = (await db.get(Requisition, rfq.requisition_id)
                   if rfq.requisition_id else None)
    requisitions = [requisition] if requisition else []
    if rfq.consolidation_id:
        requisitions = list((await db.execute(
            select(Requisition)
            .join(PurchaseConsolidationSource,
                  PurchaseConsolidationSource.requisition_id == Requisition.id)
            .where(PurchaseConsolidationSource.consolidation_id == rfq.consolidation_id)
            .order_by(Requisition.id)
        )).scalars().all())
    requisition_ids = [row.id for row in requisitions]
    req_items = list((await db.execute(
        select(RequisitionItem)
        .where(RequisitionItem.requisition_id.in_(requisition_ids))
        .order_by(RequisitionItem.requisition_id, RequisitionItem.line_no)
    )).scalars().all()) if requisition_ids else []

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
        # The raiser's office, as the direct-create path does. Left None, every PO
        # read below ALL as "only my own" and a buyer could not open a colleague's PO.
        office_id=getattr(user, "office_id", None),
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
        quantity = order_qty.get(line.id, _d(line.quantity))
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
            **combinations.carry(line),
        ))

    # The offer's own document-level money, carried across so the order comes to the
    # same figure as the quotation it accepts. Both are columns of their own now: the
    # freight used to be added into `sub_total`, which double-counted the moment the
    # buyer could also see and edit a freight field, and the discount was dropped
    # entirely, so the PO silently cost more than the quote that won.
    #
    # Only when the caller said nothing. A buyer who typed a figure on the create call
    # has negotiated it, and the quote must not overwrite them.
    # A document-level charge belongs to the whole quotation. For a split PO, carry
    # only the same proportion as the awarded taxable subtotal; copying the complete
    # freight/discount onto every winner would multiply the quoted commercial terms.
    quote_base = _d(quote.sub_total or 0)
    split_ratio = (min(Decimal("1"), sub_total / quote_base)
                   if share and quote_base > 0 else Decimal("1"))
    if not _d(po.freight_amount or 0):
        po.freight_amount = _d(quote.freight_amount or 0) * split_ratio
    if not _d(po.discount_amount or 0):
        po.discount_amount = _d(quote.discount_amount or 0) * split_ratio

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

    for source_requisition in requisitions:
        source_items = [row for row in req_items
                        if row.requisition_id == source_requisition.id]
        await _close_requisition_if_ordered(db, source_requisition, source_items)
    if rfq.consolidation_id:
        await _close_sheet_if_ordered(db, rfq.consolidation_id)

    # A quotation says nothing about packing; describe each line in the item's
    # default hierarchy so the supplier is told how to pack it (2026-10-08).
    await db.flush()
    await po_packing.sync_po_packing(db, po.id)
    await db.commit()
    logger.info("purchase order %s raised from %s (%s, %d line(s))",
                po.po_no, quote.quotation_no, rfq.rfq_no, len(lines))
    return await get_po(db, po.id)


async def _close_requisition_if_ordered(db: AsyncSession, requisition: Requisition,
                                        req_items: list[RequisitionItem],
                                        released: bool = False) -> None:
    """Move the requisition — and the material request behind it — forward.

    ORDERED only when every line is fully covered. A requisition bought in two tenders
    must keep reading RFQ_RAISED in between, or the second half looks already done.

    `released` says the caller has just HANDED quantity back (a dead order let go of what
    it was holding), and turns the same arithmetic around: ORDERED becomes a status this
    may step out of, and the material request's own figure is set rather than ratcheted.
    The ratchet is right on the way forward — two tenders must not undo each other — and
    wrong on the way back, where the whole point is that the number goes down.
    """
    fully = all(_d(row.ordered_qty or 0) >= _d(row.quantity) for row in req_items)
    movable = (RequisitionStatus.APPROVED.value,
               RequisitionStatus.CONSOLIDATED.value,
               RequisitionStatus.RFQ_RAISED.value)
    if released:
        movable += (RequisitionStatus.ORDERED.value,)
    if requisition.status in movable:
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
            # On the way back a line the requisition no longer covers reads zero, not
            # whatever it happened to read before — skipping it here is how a released
            # quantity would stay visible on the MR after the order holding it died.
            if released:
                row.ordered_quantity = Decimal("0")
            continue
        applied = min(claimable, _d(row.quantity))
        # The pool is spent whether or not this line moved: two MR lines for the same
        # item must not both claim the same ordered quantity.
        by_item[row.item_id] = claimable - applied
        if released or applied > _d(row.ordered_quantity or 0):
            row.ordered_quantity = applied

    covered = all(_d(row.ordered_quantity or 0) >= _d(row.quantity) for row in mr_items)
    if mr.status == MRStatus.APPROVED.value and covered:
        mr.status = MRStatus.ORDERED.value
    elif released and mr.status == MRStatus.ORDERED.value and not covered:
        mr.status = MRStatus.APPROVED.value


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


async def _release_po_claims(db: AsyncSession, po: PurchaseOrder) -> None:
    """Hand back the requisition quantity a now-dead order was holding.

    `create_po_from_quotation` adds every ordered quantity onto the requisition line it
    covers, and that running total is what stops a second tender buying the same thing
    twice. Nothing ever subtracted it again. So an order rejected in approval went on
    holding goods nobody will deliver: the requisition kept reading ORDERED, the material
    request behind it kept reading ORDERED, and the replacement order raised in its place
    found no free quantity left to claim — it came out pointing at no indent line at all.

    Matched back by ITEM, in line order, exactly as the claim was made: a purchase order
    line records the indent line it served but not the requisition line, and re-deriving
    the pairing the same way is what keeps the two halves in step.
    """
    lines = list((await db.execute(
        select(POItem).where(POItem.po_id == po.id).order_by(POItem.id)
    )).scalars().all())
    if not lines:
        return

    rfq = await db.get(RFQ, po.rfq_id) if po.rfq_id else None
    if rfq is not None and rfq.consolidation_id:
        requisitions = list((await db.execute(
            select(Requisition)
            .join(PurchaseConsolidationSource,
                  PurchaseConsolidationSource.requisition_id == Requisition.id)
            .where(PurchaseConsolidationSource.consolidation_id == rfq.consolidation_id)
            .order_by(Requisition.id)
        )).scalars().all())
    else:
        source_id = po.requisition_id or (rfq.requisition_id if rfq else None)
        requisition = await db.get(Requisition, source_id) if source_id else None
        requisitions = [requisition] if requisition else []
    if not requisitions:
        return

    req_items = list((await db.execute(
        select(RequisitionItem)
        .where(RequisitionItem.requisition_id.in_([row.id for row in requisitions]))
        .order_by(RequisitionItem.requisition_id, RequisitionItem.line_no)
    )).scalars().all())
    held: dict[int, list[RequisitionItem]] = {}
    for row in req_items:
        held.setdefault(row.item_id, []).append(row)

    for line in lines:
        remaining = _d(line.quantity)
        for req_line in held.get(line.item_id, []):
            if remaining <= 0:
                break
            # Never below zero: history holds orders raised before anything released,
            # and an over-release would read as quantity still to buy that was bought.
            taken = min(_d(req_line.ordered_qty or 0), remaining)
            if taken <= 0:
                continue
            req_line.ordered_qty = _d(req_line.ordered_qty or 0) - taken
            remaining -= taken

    for source_requisition in requisitions:
        source_items = [row for row in req_items
                        if row.requisition_id == source_requisition.id]
        await _close_requisition_if_ordered(db, source_requisition, source_items,
                                            released=True)
    logger.info("purchase order %s released its claim on %d requisition line(s)",
                po.po_no, len(req_items))


async def _po_approver_condition(db: AsyncSession, user):
    """POs this login is signing or has signed, whatever its scope rung says — the
    same rule `_rfq_approver_condition` applies. The queue is the engine's."""
    pending = await _pending_doc_ids(db, user, DocType.PO.value)
    signed = (
        select(WorkflowInstance.doc_id)
        .join(WorkflowAction, WorkflowAction.instance_id == WorkflowInstance.id)
        .where(WorkflowInstance.doc_type == DocType.PO.value,
               WorkflowAction.actor_id == user.id)
    )
    return or_(PurchaseOrder.id.in_(pending) if pending else false(),
               PurchaseOrder.id.in_(signed))


async def _po_scope(db: AsyncSession, user, *, include_approver: bool = False):
    condition = await scope_condition(
        db, user,
        owner_col=PurchaseOrder.created_by_id,
        office_col=PurchaseOrder.office_id,
        project_col=PurchaseOrder.project_id,
    )
    if include_approver:
        condition = or_(condition, await _po_approver_condition(db, user))
    return condition


async def get_po(db: AsyncSession, po_id: int, user=None, *,
                 include_approver: bool = False) -> PurchaseOrder:
    po = (await db.execute(select(PurchaseOrder).where(
            PurchaseOrder.id == po_id,
            # Same scope the list applies. A document hidden from the list must
            # not be readable by putting its id in the URL. Approvers read (and
            # sign) what is on their chain; edits keep the raiser's scope.
            await _po_scope(db, user, include_approver=include_approver)
            if user is not None else true(),
        ))).scalar_one_or_none()
    if not po:
        raise NotFoundError(f"PO {po_id} not found")
    
    if not po.vendor_name and po.vendor_id:
        vendor_name = (await db.execute(select(Vendor.name).where(Vendor.id == po.vendor_id))).scalar_one_or_none()
        if vendor_name:
            po.vendor_name = vendor_name

    await _attach_po_tax_context(db, po)
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
    po = await get_po(db, po_id, user, include_approver=True)
    if po.status == POStatus.DRAFT.value:
        # A draft keeps the raiser's own scope; this raises if it is outside it.
        await get_po(db, po_id, user)
    elif not (po.status == POStatus.RETURNED_FOR_CORRECTION.value
              and await _raiser_owns_correction(db, po, user)):
        raise ValidationError(
            "Only a draft purchase order, or one sent back to its raiser for "
            f"correction, can be edited (this one is {po.status})")

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
    return await get_po(db, po_id, user, include_approver=True)


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
        stmt = stmt.where(await _po_scope(db, user, include_approver=True))
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
        stmt = stmt.where(await _po_scope(db, user, include_approver=True))
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
    _assert_po_addresses(po.billing_address, po.shipping_address)
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
    # A rejection ends the order, so the raiser must be told why.
    if action.upper().startswith("REJECT") and not (comments or "").strip():
        raise ValidationError("A reason is required to reject this order")
    instance = await engine.act(db, DocType.PO.value, po.id, action, user, comments)
    if instance.status == InstanceStatus.APPROVED.value:
        po.status = POStatus.APPROVED.value
        po.approved_at = utcnow()
        po.current_approver_name = None
    elif instance.status == InstanceStatus.REJECTED.value:
        po.status = POStatus.REJECTED.value
        po.current_approver_name = None
        await _release_po_claims(db, po)
    else:
        await _refresh_current_approver(db, po)
    await db.commit()
    await db.refresh(po)
    return po


def _po_workflow_context(po: PurchaseOrder) -> dict:
    """The same context `submit_po` starts the ladder with, so a resubmitted rung
    resolves its conditions exactly as it did the first time."""
    return {"total_amount": float(po.total_amount),
            "project_id": po.project_id or None,
            "doc_no": po.po_no}


async def send_back_po(db: AsyncSession, po_id: int, comments: str, user) -> PurchaseOrder:
    """Send a PO back ONE rung for correction: to the approver who signed just below,
    or to the raiser when it is still at the first rung. The reason is compulsory —
    the person it lands with has to know what to fix."""
    reason = (comments or "").strip()
    if not reason:
        raise ValidationError("A reason is required to send this order back")
    po = await get_po(db, po_id, user, include_approver=True)
    if po.status != POStatus.PENDING_APPROVAL.value:
        raise ValidationError(f"PO is not awaiting approval (status {po.status})")
    await engine.return_for_correction(
        db, DocType.PO.value, po.id, user, reason, context=_po_workflow_context(po))
    correction = await engine.get_correction_state(db, DocType.PO.value, po.id) or {}
    before_status = po.status
    po.status = POStatus.RETURNED_FOR_CORRECTION.value
    po.current_approver_name = correction.get("correction_owner_name")
    await write_audit(
        db, entity="pro_purchase_orders", entity_id=po.id, entity_no=po.po_no,
        action=AuditAction.UPDATE, actor=user,
        before={"status": before_status}, after={"status": po.status},
        summary=f"Sent PO back to {po.current_approver_name or 'previous approver'}: {reason}",
    )
    owner_id = correction.get("correction_owner_employee_id")
    if owner_id:
        await notifications.notify(
            db, [int(owner_id)], title=f"{po.po_no} sent back to you",
            body=f"{user.full_name}: {reason}",
            entity_type="PO", entity_id=po.id, deep_link=f"/procurement/pos/{po.id}")
    await db.commit()
    await db.refresh(po)
    return await get_po_detail(db, po.id, user)


async def resubmit_po_correction(db: AsyncSession, po_id: int, user,
                                 comments: str = "") -> PurchaseOrder:
    """The person a PO was sent back to hands it up again; it reopens at the rung
    that sent it back, never at the bottom of the ladder. An optional comment goes
    on the PO's conversation so the approver sees what was done."""
    po = await get_po(db, po_id, user, include_approver=True)
    if po.status != POStatus.RETURNED_FOR_CORRECTION.value:
        raise ValidationError(f"PO is not sent back for correction (status {po.status})")
    await engine.resubmit_correction(
        db, DocType.PO.value, po.id, user, context=_po_workflow_context(po))
    before_status = po.status
    po.status = POStatus.PENDING_APPROVAL.value
    await _refresh_current_approver(db, po)
    await write_audit(
        db, entity="pro_purchase_orders", entity_id=po.id, entity_no=po.po_no,
        action=AuditAction.UPDATE, actor=user,
        before={"status": before_status}, after={"status": po.status},
        summary="Resubmitted PO after correction"
                + (f": {comments.strip()}" if (comments or "").strip() else ""),
    )
    if (comments or "").strip():
        db.add(POComment(po_id=po.id, author_id=user.id, author_name=user.full_name,
                         message=f"Resubmitted: {comments.strip()}"[:2000]))
    await db.commit()
    await db.refresh(po)
    return await get_po_detail(db, po.id, user)


async def correct_po(db: AsyncSession, po_id: int, data, user) -> PurchaseOrder:
    """The raiser's full edit of a PO sent back to them: vendor, expected date, lines
    (item, quantity, rate, tax — add and remove) and the whole header, exactly what the
    create form asks. Nothing has been sent or received on a sent-back order, so no
    receipt guard applies. The vendor is locked on an order written off a quotation."""
    po = await get_po(db, po_id, user, include_approver=True)
    if po.status != POStatus.RETURNED_FOR_CORRECTION.value:
        raise ValidationError(f"PO is not sent back for correction (status {po.status})")
    if not await _raiser_owns_correction(db, po, user):
        raise ValidationError("Only the raiser can edit a PO that was sent back")
    return await _rewrite_po(db, po, data, user, "Corrected PO after it was sent back")


async def edit_draft_po(db: AsyncSession, po_id: int, data, user) -> PurchaseOrder:
    """The full edit of a DRAFT order (2026-10-19): vendor, expected date, every line
    and the header — the same fields, rules and save as a sent-back correction.

    Before this a draft could only have its header filled in, so a wrong item or
    quantity on an order nobody had signed yet meant cancelling and raising it again.
    Nothing has been approved, sent or received on a draft, so nothing guards it but
    the raiser's own scope (`get_po` without the approver reach) and `po.edit`.
    """
    po = await get_po(db, po_id, user)
    if po.status != POStatus.DRAFT.value:
        raise ValidationError(
            f"Only a draft purchase order can be edited here (this one is {po.status})")
    return await _rewrite_po(db, po, data, user, "Edited draft PO")


async def _rewrite_po(db: AsyncSession, po: PurchaseOrder, data, user,
                      summary: str) -> PurchaseOrder:
    """Write a whole edit onto an order not yet signed — a draft, or one sent back.
    The caller has already decided this order may be edited by this login."""
    if not data.lines:
        raise ValidationError("A purchase order must have at least one line")
    _assert_po_addresses(
        data.billing_address if data.billing_address is not None else po.billing_address,
        data.shipping_address if data.shipping_address is not None else po.shipping_address)

    if data.vendor_id and data.vendor_id != po.vendor_id:
        if po.quotation_id:
            raise ValidationError(
                f"{po.po_no} was written off quotation {po.quotation_no or ''} — its "
                "vendor cannot be changed here. Reject it and raise a new order instead.")
        vendor = await db.get(Vendor, data.vendor_id)
        if vendor is None:
            raise ValidationError(f"Unknown vendor {data.vendor_id}")
        po.vendor_id = vendor.id
        po.vendor_name = vendor.name
        po.vendor_gstin = vendor.gstin

    items = {row.id: row for row in (await db.execute(
        select(Item).where(Item.id.in_([line.item_id for line in data.lines]))
    )).scalars().all()}
    by_id = {line.id: line for line in po.items}
    kept = {line.id for line in data.lines if line.id is not None}
    for incoming in data.lines:
        item = items.get(incoming.item_id)
        if item is None:
            raise ValidationError(f"Unknown item id: {incoming.item_id}")
        amount = _d(incoming.quantity) * _d(incoming.rate)
        existing = by_id.get(incoming.id) if incoming.id is not None else None
        if incoming.id is not None and existing is None:
            raise ValidationError(f"Unknown PO line id {incoming.id}")
        if existing is not None:
            if existing.item_id != item.id:
                existing.item_id = item.id
                existing.item_code = item.code
                existing.item_name = item.name
                existing.uom_code = item.uom_code
            existing.quantity = _d(incoming.quantity)
            existing.rate = _d(incoming.rate)
            existing.tax_percent = _d(incoming.tax_percent)
            existing.amount = amount
            for key, value in (await _po_line_combination(
                    db, item, incoming, existing.indent_item_id, keep=existing)).items():
                setattr(existing, key, value)
        else:
            db.add(POItem(
                po_id=po.id, item_id=item.id, item_code=item.code,
                item_name=item.name, uom_code=item.uom_code,
                quantity=_d(incoming.quantity), rate=_d(incoming.rate),
                tax_percent=_d(incoming.tax_percent), amount=amount,
                **await _po_line_combination(db, item, incoming, None),
            ))
    for line in list(po.items):
        if line.id not in kept:
            await db.delete(line)
    await db.flush()

    if data.expected_date is not None:
        po.expected_date = data.expected_date
    if data.remarks is not None:
        po.remarks = data.remarks
    await _apply_po_header(db, po, data)

    # Lines were added and quantities moved: their packing must follow (2026-10-08).
    await db.flush()
    await po_packing.sync_po_packing(db, po.id)
    lines = list((await db.execute(
        select(POItem).where(POItem.po_id == po.id))).scalars().all())
    sub_total = tax_total = Decimal("0")
    for line in lines:
        amount = _d(line.amount)
        sub_total += amount
        tax_total += amount * _d(line.tax_percent or 0) / _d(100)
    _apply_po_totals(po, sub_total, tax_total)

    await write_audit(
        db, entity="pro_purchase_orders", entity_id=po.id, entity_no=po.po_no,
        action=AuditAction.UPDATE, actor=user,
        after={"vendor_id": po.vendor_id, "lines": len(lines),
               "total_amount": float(po.total_amount or 0)},
        summary=summary,
    )
    # Expire only the order, so its lines are re-read. `expire_all` also expired the
    # signed-in employee, and the scope check then read `user.id` synchronously —
    # which an async session refuses (MissingGreenlet).
    po_id = po.id
    await db.commit()
    db.expire(po)
    return await get_po_detail(db, po_id, user)


async def pass_po_correction_down(db: AsyncSession, po_id: int, comments: str,
                                  user) -> PurchaseOrder:
    """An approver a PO was sent back to passes it one rung further down — to the
    approver below, or to the raiser. Reason compulsory, as for any send-back."""
    reason = (comments or "").strip()
    if not reason:
        raise ValidationError("A reason is required to send this order back")
    po = await get_po(db, po_id, user, include_approver=True)
    if po.status != POStatus.RETURNED_FOR_CORRECTION.value:
        raise ValidationError(f"PO is not sent back for correction (status {po.status})")
    await engine.pass_correction_down(
        db, DocType.PO.value, po.id, user, reason, context=_po_workflow_context(po))
    correction = await engine.get_correction_state(db, DocType.PO.value, po.id) or {}
    po.current_approver_name = correction.get("correction_owner_name")
    await write_audit(
        db, entity="pro_purchase_orders", entity_id=po.id, entity_no=po.po_no,
        action=AuditAction.UPDATE, actor=user,
        before={"status": po.status}, after={"status": po.status},
        summary=f"Sent PO further back to {po.current_approver_name or 'previous approver'}: {reason}",
    )
    owner_id = correction.get("correction_owner_employee_id")
    if owner_id:
        await notifications.notify(
            db, [int(owner_id)], title=f"{po.po_no} sent back to you",
            body=f"{user.full_name}: {reason}",
            entity_type="PO", entity_id=po.id, deep_link=f"/procurement/pos/{po.id}")
    await db.commit()
    await db.refresh(po)
    return await get_po_detail(db, po.id, user)


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
    # A failed send can have rolled the session back (`_heal_session`), which expires
    # `sent`; it is about to be serialised, and an expired attribute cannot be re-read
    # on an async session. Re-read only in that case.
    from sqlalchemy import inspect as sa_inspect
    if sa_inspect(sent).expired_attributes:
        sent = await get_po(db, po_id, user)
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


async def _po_line_combination(db: AsyncSession, item, line, indent_item_id,
                               *, keep=None) -> dict:
    """Which brand / variant / model a PO line buys (2026-10-23).

    The buyer's pick, checked against the item's ON combinations — a buyer may change
    what the indent asked for (an alternative brand). Nothing picked: the line it was
    already (an edit), else the indent line's own, else none. An indent that said
    "Any" leaves the PO line without one until the buyer picks.
    """
    if getattr(line, "brand_id", None):
        return await combinations.resolve(db, item.id, line, label=item.code)
    if keep is not None:
        return combinations.carry(keep)
    if indent_item_id:
        source = await db.get(IndentItem, indent_item_id)
        if source is not None and source.brand_id:
            return combinations.carry(source)
    return dict(combinations.NONE)


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
            "pack_hierarchy_id": line.pack_hierarchy_id,
            "pack_breakdown": line.pack_breakdown,
            **combinations.carry(line),
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
                # An amendment MAY reprice - that is the point of it, and the new
                # total goes back up the ladder before it reaches the vendor. What it
                # may not do is reprice goods that are already on the shelf: the GRN
                # valued them at the rate on the order at the time, and moving that
                # rate afterwards leaves the stock and the paperwork disagreeing about
                # what the same delivery was worth. Same reason, same gate, as the
                # quantity check immediately above.
                if already > 0 and (_d(incoming.rate) != _d(existing.rate)
                                    or _d(incoming.tax_percent)
                                    != _d(existing.tax_percent)):
                    raise ValidationError(
                        f"{existing.item_code or existing.item_id}: {already} has "
                        "already been received at the current rate, so the rate and "
                        "tax cannot be changed. Amend the quantity, or raise a new "
                        "order for the rest at the new price.")
                existing.quantity = _d(incoming.quantity)
                existing.rate = _d(incoming.rate)
                existing.tax_percent = _d(incoming.tax_percent)
                existing.amount = amount
                for key, value in (await _po_line_combination(
                        db, item, incoming, existing.indent_item_id, keep=existing)).items():
                    setattr(existing, key, value)
                await po_packing.stamp_line(
                    db, existing, hierarchy_id=incoming.pack_hierarchy_id,
                    entries=incoming.pack_breakdown)
            else:
                po_line = POItem(
                    po_id=po.id, item_id=item.id, item_code=item.code,
                    item_name=item.name, uom_code=item.uom_code,
                    quantity=_d(incoming.quantity), rate=_d(incoming.rate),
                    tax_percent=_d(incoming.tax_percent), amount=amount,
                    **await _po_line_combination(db, item, incoming, None),
                )
                db.add(po_line)
                await po_packing.stamp_line(
                    db, po_line, hierarchy_id=incoming.pack_hierarchy_id,
                    entries=incoming.pack_breakdown)
        for line in list(po.items):
            if line.id is not None and line.id not in kept:
                await db.delete(line)
        await db.flush()

    if data.expected_date is not None:
        po.expected_date = data.expected_date
    if data.remarks is not None:
        po.remarks = data.remarks
    await _apply_po_header(db, po, data)

    await db.flush()
    await po_packing.sync_po_packing(db, po.id)
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


def _po_copy_parts(po: PurchaseOrder, company: mail_template.Company,
                   portal_url: str) -> tuple[str, str]:
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
    blocks += [table, totals_block, mail_template.button("Open Supplier Portal", portal_url)]
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
    lines.append(f"Supplier Portal: {portal_url}")
    return "\n".join(lines), html


async def _heal_session(db: AsyncSession, user) -> bool:
    """Make the session usable again after a courtesy email failed. Returns whether it
    had to roll back.

    A rollback is conditional on purpose. `platform.mail` already rolls back when
    recording its own FAILED row fails, and an ordinary SMTP failure leaves the
    session healthy — rolling back then expires EVERY object on it, and an expired
    attribute cannot be re-read on an async session (MissingGreenlet), so the "fix"
    turned a logged mail failure into a 500 on whatever touched the order next.
    Only a session actually left "pending rollback" needs it, and when that happens
    the caller must treat everything it loaded earlier as expired.
    """
    if db.sync_session.is_active:
        return False
    await db.rollback()
    try:
        await db.refresh(user)   # the acting user is expired by the rollback too
    except Exception:  # noqa: BLE001 - not every caller's user belongs to this session
        pass
    return True


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
    # Read into plain locals BEFORE anything that touches the session below: a
    # failed flush/commit inside `send_mail` can leave the session needing a
    # rollback, and `po` has `expire_on_commit` attributes that would then try
    # to re-fetch from that dead session — turning "the mail failed" into a
    # second, unrelated 500 from this very except block (SCM_0076/SCM_0072).
    po_no = po.po_no
    revision_no = po.revision_no or 0
    try:
        vendor = await db.get(Vendor, po.vendor_id) if po.vendor_id else None
        address = (getattr(vendor, "email", None) or "").strip()
        if not address:
            logger.info("no email on file for vendor %s; %s not sent",
                        po.vendor_name or po.vendor_id, po_no)
            return False
        subject = f"Purchase order {po_no}"
        if revision_no > 0:
            subject += f" — revision {revision_no}"
        company = mail_template.Company.of(await get_company_letterhead(db))
        portal_url = (f"{settings.APP_BASE_URL.rstrip('/')}/supplier/login"
                      f"?next=/supplier/pos/{po.id}")
        text, html = _po_copy_parts(po, company, portal_url)
        await mail_service.send_mail(
            db, MailSendIn(to=[address], subject=subject, body=text, html=html), user,
            attachments=[(f"{po_no}.pdf", vendor_documents.po_pdf(po, company), "application/pdf")])
        logger.info("%s emailed to %s", po_no, address)
        return True
    except Exception as exc:  # noqa: BLE001 - a courtesy must not cost the order
        # The real change (SENT_TO_VENDOR) is already committed by the caller. If the
        # failure left the session "pending rollback", heal it so it doesn't poison
        # whatever the caller reads next; `po` is expired if that happened.
        await _heal_session(db, user)
        logger.warning("could not email %s to the vendor: %s", po_no, exc)
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
    await get_po(db, po_id, user, include_approver=True)
    return list((await db.execute(
        select(POComment).where(POComment.po_id == po_id)
        .order_by(POComment.created_at.asc(), POComment.id.asc())
    )).scalars().all())


async def add_po_comment(db: AsyncSession, po_id: int, message: str, user) -> object:
    """Post a question or reply on a PO."""
    po = await get_po(db, po_id, user, include_approver=True)
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
    po = await get_po(db, po_id, user, include_approver=True)
    if po.status == POStatus.RETURNED_FOR_CORRECTION.value:
        # Sent back: the person it was sent back to fixes it, under the same
        # decrease-only rule an approver works to.
        if not await _raiser_owns_correction(db, po, user):
            raise ValidationError(
                "Only the raiser can edit a sent-back PO. An approver it was sent back "
                "to can resubmit it or send it further back.")
    elif po.status != POStatus.PENDING_APPROVAL.value:
        raise ValidationError(f"Only a PO awaiting approval can be edited (status {po.status})")
    else:
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

    # A trimmed quantity is rescaled in the same hierarchy (2 Carton -> 18 Box).
    await db.flush()
    await po_packing.sync_po_packing(db, po.id)
    await db.commit()
    logger.info("PO %s quantities trimmed during approval by %s: %s",
                po.po_no, getattr(user, "full_name", user), trimmed)
    return await get_po_detail(db, po.id, user)


async def po_revisions(db: AsyncSession, po_id: int, user=None) -> list:
    """Every version this order has been, newest first. Read-only, always."""
    await get_po(db, po_id, user, include_approver=True)
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
    po = await get_po(db, po_id, user, include_approver=True)
    # A submitted despatch locks the PO before a GRN necessarily changes its status.
    po.amendment_allowed = (
        po.status not in _UNAMENDABLE
        and not await _vendor_has_dispatched(db, po.id)
        and (
            po.vendor_status == POVendorStatus.ACCEPTED.value
            or (po.vendor_status is None and po.status == POStatus.SENT_TO_VENDOR.value)
        )
    )
    await _attach_correction(db, DocType.PO.value, po,
                             po.status == POStatus.RETURNED_FOR_CORRECTION.value, user,
                             raiser_id=po.created_by_id)
    return await _attach_pending_one(db, DocType.PO.value, po, user)


async def po_correction_in_reach(db: AsyncSession, request, user) -> bool:
    """`require_permission_or` hook: an approver without `po.edit` may still edit the
    header of a PO that was sent back to THEM — they are the one asked to fix it."""
    try:
        po_id = int(request.path_params.get("po_id"))
    except (TypeError, ValueError):
        return False
    po = await db.get(PurchaseOrder, po_id)
    return bool(po is not None
                and po.status == POStatus.RETURNED_FOR_CORRECTION.value
                and await _raiser_owns_correction(db, po, user))


async def _is_correction_owner(db: AsyncSession, doc_type: str, doc_id: int, user) -> bool:
    """Is THIS login the person a sent-back document was handed to?"""
    state = await engine.get_correction_state(db, doc_type, doc_id)
    return bool(state and user is not None
                and int(state.get("correction_owner_employee_id") or 0) == int(user.id))


async def _raiser_owns_correction(db: AsyncSession, po: PurchaseOrder, user) -> bool:
    """Editing a sent-back PO is the RAISER's job only. An approver it was handed back
    to may resubmit it or pass it further down, never change it."""
    return bool(user is not None and po.created_by_id == user.id
                and await _is_correction_owner(db, DocType.PO.value, po.id, user))


async def _attach_correction(db: AsyncSession, doc_type: str, doc, returned: bool, user,
                             raiser_id: int | None = None):
    """Who a sent-back document went to, by whom and why — and whether THIS login is
    the one who can hand it up again. Served so the screen never guesses ownership
    from a name."""
    doc.correction = None
    doc.can_resubmit_correction = False
    doc.can_edit_correction = False
    doc.can_pass_correction_down = False
    if not returned:
        return doc
    state = await engine.get_correction_state(db, doc_type, doc.id)
    if state:
        doc.correction = {
            "owner_name": state.get("correction_owner_name"),
            "returned_by_name": state.get("returned_by_name"),
            "returned_from_stage": state.get("returned_from_stage"),
            "returned_at": state.get("returned_at"),
            "reason": state.get("correction_comment"),
        }
        doc.can_resubmit_correction = bool(
            user is not None
            and int(state.get("correction_owner_employee_id") or 0) == int(user.id)
        )
        # Only the raiser edits. An approver holding it can only resubmit, or pass it
        # further down while there is a rung below them.
        doc.can_edit_correction = bool(
            doc.can_resubmit_correction and raiser_id is not None
            and int(raiser_id) == int(user.id))
        doc.can_pass_correction_down = bool(
            doc.can_resubmit_correction
            and int(state.get("returned_from_sequence") or 0) > 1)
    return doc


async def get_requisition_detail(db: AsyncSession, req_id: int, user=None):
    return await _attach_pending_one(
        db, DocType.REQUISITION.value, await get_requisition(db, req_id, user), user)


async def get_rfq_detail(db: AsyncSession, rfq_id: int, user=None):
    rfq = await get_rfq(db, rfq_id, user, include_approver=True)
    await _attach_correction(db, DocType.RFQ.value, rfq,
                             rfq.status == RFQStatus.RETURNED_FOR_CORRECTION.value, user,
                             raiser_id=rfq.created_by_id)
    return await _attach_pending_one(db, DocType.RFQ.value, rfq, user)


async def get_consolidation_detail(db: AsyncSession, cons_id: int, user=None):
    # FIXED — the rung is enforced inside `consolidation.get_consolidation`; this only
    # has to hand the user down. Same for `consolidation_approval_trail` below.
    doc = await consolidation.get_consolidation(db, cons_id, user=user)
    await consolidation._attach_caps(db, doc)
    return await _attach_pending_one(
        db, DocType.CONSOLIDATION.value, doc, user)


async def po_approval_trail(db: AsyncSession, po_id: int, user=None) -> dict:
    po = await get_po(db, po_id, user, include_approver=True)
    return await _approval_trail(db, DocType.PO.value, po.id)


async def requisition_approval_trail(db: AsyncSession, req_id: int, user=None) -> dict:
    req = await get_requisition(db, req_id, user)
    return await _approval_trail(db, DocType.REQUISITION.value, req.id)


async def rfq_approval_trail(db: AsyncSession, rfq_id: int, user=None) -> dict:
    rfq = await get_rfq(db, rfq_id, user, include_approver=True)
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
        combo = await _po_line_combination(
            db, item, line, getattr(line, "indent_item_id", None))
        key = (line.item_id, combo["brand_id"], combo["variant_id"], combo["model_id"])
        if key in seen_items:
            raise ValidationError(
                f"Item '{item.name or item.code}' is already added. "
                "An item cannot be added more than once in the same requisition "
                "in the same brand / variant / model."
            )
        seen_items.add(key)
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
            **combo,
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

async def _validate_rfq_source_quantities(db: AsyncSession, lines,
                                           requisition_id: int | None,
                                           consolidation_id: int | None) -> None:
    """Keep RFQ quantities within the document that authorised the purchase."""
    if not requisition_id and not consolidation_id:
        return
    if requisition_id:
        rows = (await db.execute(
            select(RequisitionItem.item_id, func.sum(RequisitionItem.quantity))
            .where(RequisitionItem.requisition_id == requisition_id)
            .group_by(RequisitionItem.item_id)
        )).all()
    else:
        rows = (await db.execute(
            select(PurchaseConsolidationItem.item_id,
                   func.sum(PurchaseConsolidationItem.approved_qty))
            .where(PurchaseConsolidationItem.consolidation_id == consolidation_id)
            .group_by(PurchaseConsolidationItem.item_id)
        )).all()
    ceilings = {int(item_id): _d(quantity) for item_id, quantity in rows}
    totals: dict[int, Decimal] = {}
    for line in lines:
        totals[line.item_id] = totals.get(line.item_id, Decimal(0)) + _d(line.quantity)
    for item_id, quantity in totals.items():
        maximum = ceilings.get(item_id, Decimal(0))
        if quantity > maximum:
            raise ValidationError(
                f"RFQ quantity for item {item_id} cannot exceed the previous "
                f"document quantity ({maximum})")


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

    await _validate_rfq_source_quantities(
        db, data.lines, data.requisition_id, data.consolidation_id)

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
    await _set_rfq_vendors(
        db, rfq, data.vendor_ids, data.vendor_allocations or None)
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
            **await _po_line_combination(
                db, item, line, getattr(line, "indent_item_id", None)),
        ))
    rfq.total_items = len(lines)


async def _set_rfq_vendors(db: AsyncSession, rfq: RFQ, vendor_ids,
                           allocations=None) -> None:
    """Reconcile the invited list. Existing rows are KEPT, not rewritten — dropping
    and re-adding would mint a new access token and break a link already emailed.

    The current rows are SELECTed rather than read off `rfq.vendors`: on a freshly
    flushed RFQ that collection has never been loaded, and touching it here raises
    MissingGreenlet instead of quietly returning the empty list it looks like.
    """
    wanted = list(dict.fromkeys(
        [row.vendor_id for row in allocations] if allocations is not None
        else (vendor_ids or [])))
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
    # Snapshot exactly which RFQ items each selected vendor is mapped to supply.
    # Publication, the portal and the emailed PDF all consume this same scope.
    rfq_lines = (await db.execute(
        select(RFQItem).where(RFQItem.rfq_id == rfq.id)
    )).scalars().all()
    item_ids = {line.item_id for line in rfq_lines}
    line_quantities = {line.item_id: _d(line.quantity) for line in rfq_lines}
    mapped: dict[int, set[int]] = {vendor_id: set() for vendor_id in wanted}
    if wanted and item_ids:
        for vendor_id, item_id in (await db.execute(
            select(VendorItem.vendor_id, VendorItem.item_id).where(
                VendorItem.vendor_id.in_(wanted), VendorItem.item_id.in_(item_ids))
        )).all():
            mapped[vendor_id].add(item_id)

    quantities: dict[int, dict[int, Decimal]] = {vendor_id: {} for vendor_id in wanted}
    if allocations is not None:
        allocated_totals: dict[int, Decimal] = {}
        for allocation in allocations:
            item_id, vendor_id = allocation.item_id, allocation.vendor_id
            if item_id not in item_ids:
                raise ValidationError(f"Item {item_id} is not on this RFQ")
            if item_id in quantities[vendor_id]:
                raise ValidationError(
                    f"Vendor {vendor_id} is allocated item {item_id} more than once")
            quantity = _d(allocation.quantity)
            if quantity <= 0:
                raise ValidationError("Vendor allocation quantity must be greater than zero")
            quantities[vendor_id][item_id] = quantity
            allocated_totals[item_id] = allocated_totals.get(item_id, Decimal(0)) + quantity
        for item_id in item_ids:
            total = allocated_totals.get(item_id, Decimal(0))
            if total <= 0:
                raise ValidationError(f"Select at least one vendor for item {item_id}")
            if total > line_quantities[item_id]:
                raise ValidationError(
                    f"Vendor allocations for item {item_id} total {total}, but the "
                    f"RFQ/source quantity is only {line_quantities[item_id]}")
    else:
        # Backward compatibility for older clients: every compatible selected vendor
        # is asked for the complete RFQ line, which was the original behaviour.
        for vendor_id in wanted:
            quantities[vendor_id] = {
                item_id: line_quantities[item_id] for item_id in mapped[vendor_id]}

    for vendor_id in wanted:
        vendor = await db.get(Vendor, vendor_id)
        if vendor is None:
            raise ValidationError(f"Vendor {vendor_id} does not exist")
        # The picker already narrows to these, so reaching this is either a hand-made
        # request or an item whose vendors were unmapped after the tender was drafted.
        # Named rather than counted: "not mapped to supply any of these items" is a
        # sentence somebody can act on in the item master, which is where the fix is.
        assigned = sorted(mapped[vendor_id])
        requested = quantities[vendor_id]
        invalid = set(requested) - mapped[vendor_id]
        if invalid:
            raise ValidationError(
                f"{vendor.name} is not mapped to supply item {sorted(invalid)[0]}")
        assigned = sorted(requested)
        if not assigned:
            raise ValidationError(
                f"{vendor.name} is not mapped to supply any of the items on this RFQ. "
                f"Map them on the item's vendor list first.")
        if vendor_id in current:
            current[vendor_id].mapped_item_ids = assigned
            current[vendor_id].item_quantities = {
                str(item_id): float(quantity) for item_id, quantity in requested.items()}
            continue
        db.add(RFQVendor(
            rfq_id=rfq.id, vendor_id=vendor.id, vendor_name=vendor.name,
            vendor_email=getattr(vendor, "email", None),
            access_token=secrets.token_urlsafe(32),
            mapped_item_ids=assigned,
            item_quantities={
                str(item_id): float(quantity) for item_id, quantity in requested.items()},
        ))
    rfq.vendor_count = len(wanted)


async def _rfq_approver_condition(db: AsyncSession, user):
    """RFQs this login is signing, or has signed — whatever its scope rung says.

    `pro_rfqs` has only an owner column, so below ALL the rung collapses to "mine" and
    an approver was shown "RFQ 13 not found" for the very document sitting in their
    queue (BUG_SCM_0002). Being on the chain is its own reason to read a document, as
    indents already treat it. The queue comes from `engine.pending_for_user`, so
    delegation and the other-hat rule are decided in the engine, not here.

    Read-and-sign only: callers that edit, submit, close, cancel or award keep the
    raiser's scope, and every route still holds its own permission check.
    """
    pending = await _pending_doc_ids(db, user, DocType.RFQ.value)
    signed = (
        select(WorkflowInstance.doc_id)
        .join(WorkflowAction, WorkflowAction.instance_id == WorkflowInstance.id)
        .where(WorkflowInstance.doc_type == DocType.RFQ.value,
               WorkflowAction.actor_id == user.id)
    )
    return or_(RFQ.id.in_(pending) if pending else false(), RFQ.id.in_(signed))


async def _rfq_scope(db: AsyncSession, user, *, include_approver: bool = False):
    condition = await scope_condition(db, user, owner_col=RFQ.created_by_id)
    if include_approver:
        condition = or_(condition, await _rfq_approver_condition(db, user))
    return condition


async def get_rfq(db: AsyncSession, rfq_id: int, user=None, *,
                  include_approver: bool = False) -> RFQ:
    rfq = (await db.execute(select(RFQ).where(
        RFQ.id == rfq_id,
        await _rfq_scope(db, user, include_approver=include_approver)
        if user is not None else true(),
    ))).scalar_one_or_none()
    if not rfq:
        raise NotFoundError(f"RFQ {rfq_id} not found")
    # This enrichment is read-only context for the response — never the reason an
    # action that already committed gets reported as failed. `act_on_rfq` calls this
    # AFTER its own `db.commit()`, purely to build the reply; a buyer who pressed
    # Approve and watched it error, then pressed it again and was told the RFQ was
    # "not awaiting approval" (SCM_0071/SCM_0072), had their approval go through both
    # times — it was THIS lookup that failed, after the state change it was reporting
    # on had already succeeded. Same rule as `email_rfq_copies`: a secondary failure
    # must never undo, or look like it undid, the primary one.
    try:
        await _attach_rfq_context(db, rfq)
    except Exception:
        logger.exception(
            "Could not attach PO/requisition context to RFQ %s; returning the bare "
            "document rather than reporting the caller's own action as failed.",
            rfq.rfq_no)
        rfq.po_id = rfq.po_no = rfq.po_status = None
        rfq.purchase_orders = []
        for invitation in rfq.vendors:
            invitation.live_allocated_quantities = None
        rfq.priority = rfq.requisition_status = None
        rfq.source_indent_nos = []
    return rfq


async def _attach_rfq_context(db: AsyncSession, rfq: RFQ) -> None:
    # The order this award already became, if it became one. Transient attributes off a
    # lookup rather than columns on pro_rfqs: the PO already points backward at the RFQ,
    # and a second copy of that link on the RFQ is a second thing that can go stale.
    #
    # Read here rather than derived in the screen because only the server knows — a
    # buyer coming back to an awarded RFQ was still being offered "Create purchase
    # order" for an order that exists, and only found out by pressing it.
    po_rows = (await db.execute(
        select(PurchaseOrder.id, PurchaseOrder.po_no, PurchaseOrder.status,
               PurchaseOrder.quotation_id, PurchaseOrder.vendor_id,
               PurchaseOrder.vendor_name)
        .where(PurchaseOrder.rfq_id == rfq.id,
               PurchaseOrder.status.notin_(_DEAD_PO_STATUSES))
        .order_by(PurchaseOrder.id)
    )).all()
    first_po = po_rows[0] if po_rows else None
    rfq.po_id, rfq.po_no, rfq.po_status = (
        first_po[0:3] if first_po else (None, None, None))
    # Keep the live PO history at item level as well as at header level.  The
    # comparison screen needs to say *which* earlier PO carried (say) six batteries,
    # before the buyer enters the new total award.  A header-only reference cannot
    # explain why the next PO will contain only the remaining quantity.
    po_item_rows = (await db.execute(
        select(POItem.po_id, POItem.item_id, func.sum(POItem.quantity))
        .where(POItem.po_id.in_([row.id for row in po_rows]))
        .group_by(POItem.po_id, POItem.item_id)
    )).all() if po_rows else []
    quantities_by_po: dict[int, dict[str, float]] = {}
    for po_id, item_id, quantity in po_item_rows:
        quantities_by_po.setdefault(po_id, {})[str(item_id)] = float(_d(quantity))
    rfq.purchase_orders = [SimpleNamespace(
        id=row.id, po_no=row.po_no, status=row.status,
        quotation_id=row.quotation_id, vendor_id=row.vendor_id,
        vendor_name=row.vendor_name,
        item_quantities=quantities_by_po.get(row.id, {}),
    ) for row in po_rows]

    # The split award is the buyer's decision; this separate, derived view is the
    # quantity still backed by an order.  Do not copy it into `awarded_quantities`:
    # a rejected or cancelled PO must make its share available again without erasing
    # the audit record of who was originally awarded it.  Reading live PO lines also
    # keeps this figure correct if an approver trims a pending order's quantity.
    live_rows = (await db.execute(
        select(PurchaseOrder.vendor_id, POItem.item_id, func.sum(POItem.quantity))
        .select_from(PurchaseOrder)
        .join(POItem, POItem.po_id == PurchaseOrder.id)
        .where(PurchaseOrder.rfq_id == rfq.id,
               PurchaseOrder.status.notin_(_DEAD_PO_STATUSES))
        .group_by(PurchaseOrder.vendor_id, POItem.item_id)
    )).all()
    live_by_vendor: dict[int, dict[str, float]] = {}
    for vendor_id, item_id, quantity in live_rows:
        live_by_vendor.setdefault(vendor_id, {})[str(item_id)] = float(_d(quantity))
    for invitation in rfq.vendors:
        invitation.live_allocated_quantities = live_by_vendor.get(invitation.vendor_id) or None

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


# --------------------------------------------------------------------------- #
#  The Approved Requisitions tab (SCM_0058) — what the RFQ screen offers before
#  anybody has pressed Create RFQ
# --------------------------------------------------------------------------- #
#  An approved requisition used to be invisible from the RFQ screen until a buyer
#  opened it from the Requisitions register and pressed Create RFQ there — the one
#  press this tab is a second doorway onto. Same shape as `consolidation.candidates`,
#  for the same reason: filtered in the query, not in Python, because the register is
#  thousands of rows on a live database and loading them all to drop the converted
#  ones puts the whole history through the app for a screen that shows twenty.

async def rfq_candidates(db: AsyncSession, params: PageParams,
                         project_id: int | None = None) -> dict:
    """Approved requisitions with neither a live RFQ nor a live consolidation sheet
    against them yet — what the Approved Requisitions tab offers.

    Not CONSOLIDATED: once a requisition is folded into a sheet it is bought through
    the sheet's own tender, not tendered again on its own, so it drops off this list
    the same way it drops off the consolidation candidates list.
    """
    taken_by_sheet = select(PurchaseConsolidationSource.requisition_id).join(
        PurchaseConsolidation,
        PurchaseConsolidation.id == PurchaseConsolidationSource.consolidation_id
    ).where(PurchaseConsolidation.status.notin_([
        ConsolidationStatus.CANCELLED.value, ConsolidationStatus.REJECTED.value]))
    taken_by_rfq = select(RFQ.requisition_id).where(
        RFQ.requisition_id.isnot(None), RFQ.status != RFQStatus.CANCELLED.value)
    stmt = (select(Requisition)
            .where(Requisition.status == RequisitionStatus.APPROVED.value,
                   Requisition.id.notin_(taken_by_sheet),
                   Requisition.id.notin_(taken_by_rfq))
            .order_by(Requisition.created_at.desc()))
    if project_id:
        stmt = stmt.where(Requisition.project_id == project_id)
    return await paginate(db, stmt, params)


async def list_rfqs(db: AsyncSession, params: PageParams, status: str | None = None,
                    search: str | None = None, pending_for_me: bool = False,
                    ready_to_award: bool = False, user=None) -> dict:
    stmt = select(RFQ)
    if user is not None:
        stmt = stmt.where(await _rfq_scope(db, user, include_approver=True))
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
    if rfq.status == RFQStatus.RETURNED_FOR_CORRECTION.value:
        # Sent back: only its raiser edits it, and only once it has reached them.
        if not await _rfq_raiser_owns_correction(db, rfq, user):
            raise ValidationError(
                "Only the raiser can edit an RFQ that was sent back. An approver it was "
                "sent back to can resubmit it or send it further back.")
    elif rfq.status not in EDITABLE:
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
        await _validate_rfq_source_quantities(
            db, data.lines, rfq.requisition_id, rfq.consolidation_id)
        for line in list(rfq.items):
            await db.delete(line)
        await db.flush()
        await _write_rfq_lines(db, rfq, data.lines)
    if data.vendor_allocations is not None:
        await _set_rfq_vendors(
            db, rfq, data.vendor_ids or [], data.vendor_allocations)
    elif data.vendor_ids is not None:
        await _set_rfq_vendors(db, rfq, data.vendor_ids)
    elif data.lines is not None:
        invited = (await db.execute(
            select(RFQVendor).where(RFQVendor.rfq_id == rfq.id)
        )).scalars().all()
        if any(row.item_quantities is not None for row in invited):
            raise ValidationError(
                "Vendor allocations are required when changing RFQ lines")
        await _set_rfq_vendors(db, rfq, [row.vendor_id for row in invited])
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
    here trims what the vendor is asked to price. The originating requisition or
    consolidation remains the ceiling, allowing correction of an earlier saved trim
    without exceeding the demand. 0 removes the line; removing the last line is
    refused so the RFQ never publishes empty.
    """
    # The approver's own edit, so the approver's own reach (BUG_SCM_0002).
    rfq = await get_rfq(db, rfq_id, user, include_approver=True)
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

    # The source document is the ceiling. Comparing with RFQItem.quantity made an
    # approver's first save irreversible: 1000 -> 500 was accepted, then correcting
    # 500 -> 600 was rejected even though the originating demand was still 1000.
    # Aggregate by item so duplicate RFQ lines cannot each claim the full source qty.
    source_ceilings: dict[int, Decimal] = {}
    if rfq.requisition_id:
        rows = (await db.execute(
            select(RequisitionItem.item_id, func.sum(RequisitionItem.quantity))
            .where(RequisitionItem.requisition_id == rfq.requisition_id)
            .group_by(RequisitionItem.item_id)
        )).all()
        source_ceilings = {int(item_id): _d(qty) for item_id, qty in rows}
    elif rfq.consolidation_id:
        rows = (await db.execute(
            select(PurchaseConsolidationItem.item_id,
                   func.sum(PurchaseConsolidationItem.approved_qty))
            .where(PurchaseConsolidationItem.consolidation_id == rfq.consolidation_id)
            .group_by(PurchaseConsolidationItem.item_id)
        )).all()
        source_ceilings = {int(item_id): _d(qty) for item_id, qty in rows}

    current_totals: dict[int, Decimal] = {}
    proposed = {line.id: _d(line.quantity) for line in rfq.items}
    for line in rfq.items:
        current_totals[line.item_id] = (
            current_totals.get(line.item_id, Decimal("0")) + _d(line.quantity))
    for incoming in data.lines:
        now = _d(incoming.quantity)
        line = by_id[incoming.id]
        if now < 0:
            raise ValidationError(
                f"Quantity cannot be negative (item {line.item_code or line.item_id})")
        proposed[incoming.id] = now

    proposed_totals: dict[int, Decimal] = {}
    for line in rfq.items:
        proposed_totals[line.item_id] = (
            proposed_totals.get(line.item_id, Decimal("0")) + proposed[line.id])
    for item_id, total in proposed_totals.items():
        ceiling = source_ceilings.get(item_id, current_totals[item_id])
        if total > ceiling:
            line = next(row for row in rfq.items if row.item_id == item_id)
            raise ValidationError(
                f"Quantity cannot exceed the source document quantity "
                f"(item {line.item_code or item_id}: maximum {ceiling}, entered {total})")

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

        # Sync vendor invitation allocations and existing draft quotations with new line quantities
        rfq_vendors = (await db.execute(
            select(RFQVendor).where(RFQVendor.rfq_id == rfq.id)
        )).scalars().all()
        for invited in rfq_vendors:
            iq = dict(invited.item_quantities or {})
            for incoming in data.lines:
                line = by_id.get(incoming.id)
                if line:
                    iq[str(line.item_id)] = float(_d(incoming.quantity))
            invited.item_quantities = iq

        quotations = (await db.execute(
            select(Quotation).options(selectinload(Quotation.items)).where(Quotation.rfq_id == rfq.id)
        )).scalars().all()
        for quote in quotations:
            for q_item in quote.items:
                matched_line = next(
                    (by_id[l_id] for l_id in by_id if (q_item.rfq_item_id and q_item.rfq_item_id == l_id) or (q_item.item_id == by_id[l_id].item_id)),
                    None
                )
                if matched_line:
                    new_qty = _d(matched_line.quantity)
                    q_item.requested_quantity = float(new_qty)
                    if quote.status == QuotationStatus.DRAFT.value:
                        q_item.quantity = new_qty
            _quote_totals(quote)

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
    if rfq.status == RFQStatus.PUBLISHED.value:
        await email_rfq_copies(db, rfq, user)
    return await get_rfq(db, rfq_id)


async def act_on_rfq(db: AsyncSession, rfq_id: int, action: str, comments: str,
                     user) -> RFQ:
    rfq = await get_rfq(db, rfq_id)
    if rfq.status != RFQStatus.PENDING_APPROVAL.value:
        raise ValidationError(f"RFQ is not awaiting approval (status {rfq.status})")
    # A rejection cancels the RFQ, so the raiser must be told why.
    if action.upper().startswith("REJECT") and not (comments or "").strip():
        raise ValidationError("A reason is required to reject this RFQ")
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
    if rfq.status == RFQStatus.PUBLISHED.value:
        await email_rfq_copies(db, rfq, user)
    return await get_rfq(db, rfq_id)


def _rfq_workflow_context(rfq: RFQ) -> dict:
    """The same context `submit_rfq` starts the ladder with."""
    return {"vendor_count": rfq.vendor_count,
            "project_id": rfq.project_id or None,
            "doc_no": rfq.rfq_no}


async def send_back_rfq(db: AsyncSession, rfq_id: int, comments: str, user):
    """Send an RFQ back ONE rung for correction (previous approver, or the raiser at
    the first rung). Reason compulsory. It stays unpublished: vendors see nothing."""
    reason = (comments or "").strip()
    if not reason:
        raise ValidationError("A reason is required to send this RFQ back")
    rfq = await get_rfq(db, rfq_id, user, include_approver=True)
    if rfq.status != RFQStatus.PENDING_APPROVAL.value:
        raise ValidationError(f"RFQ is not awaiting approval (status {rfq.status})")
    await engine.return_for_correction(
        db, DocType.RFQ.value, rfq.id, user, reason, context=_rfq_workflow_context(rfq))
    correction = await engine.get_correction_state(db, DocType.RFQ.value, rfq.id) or {}
    before_status = rfq.status
    rfq.status = RFQStatus.RETURNED_FOR_CORRECTION.value
    rfq.current_approver_name = correction.get("correction_owner_name")
    await write_audit(
        db, entity="pro_rfqs", entity_id=rfq.id, entity_no=rfq.rfq_no,
        action=AuditAction.UPDATE, actor=user,
        before={"status": before_status}, after={"status": rfq.status},
        summary=f"Sent RFQ back to {rfq.current_approver_name or 'previous approver'}: {reason}",
    )
    owner_id = correction.get("correction_owner_employee_id")
    if owner_id:
        await notifications.notify(
            db, [int(owner_id)], title=f"{rfq.rfq_no} sent back to you",
            body=f"{user.full_name}: {reason}",
            entity_type="RFQ", entity_id=rfq.id, deep_link=f"/procurement/rfqs/{rfq.id}")
    await db.commit()
    return await get_rfq_detail(db, rfq.id, user)


async def _rfq_raiser_owns_correction(db: AsyncSession, rfq: RFQ, user) -> bool:
    """Editing a sent-back RFQ is the RAISER's job only (see _raiser_owns_correction)."""
    return bool(user is not None and rfq.created_by_id == user.id
                and await _is_correction_owner(db, DocType.RFQ.value, rfq.id, user))


async def pass_rfq_correction_down(db: AsyncSession, rfq_id: int, comments: str, user):
    """An approver an RFQ was sent back to passes it one rung further down. Reason
    compulsory."""
    reason = (comments or "").strip()
    if not reason:
        raise ValidationError("A reason is required to send this RFQ back")
    rfq = await get_rfq(db, rfq_id, user, include_approver=True)
    if rfq.status != RFQStatus.RETURNED_FOR_CORRECTION.value:
        raise ValidationError(f"RFQ is not sent back for correction (status {rfq.status})")
    await engine.pass_correction_down(
        db, DocType.RFQ.value, rfq.id, user, reason, context=_rfq_workflow_context(rfq))
    correction = await engine.get_correction_state(db, DocType.RFQ.value, rfq.id) or {}
    rfq.current_approver_name = correction.get("correction_owner_name")
    await write_audit(
        db, entity="pro_rfqs", entity_id=rfq.id, entity_no=rfq.rfq_no,
        action=AuditAction.UPDATE, actor=user,
        before={"status": rfq.status}, after={"status": rfq.status},
        summary=f"Sent RFQ further back to {rfq.current_approver_name or 'previous approver'}: {reason}",
    )
    owner_id = correction.get("correction_owner_employee_id")
    if owner_id:
        await notifications.notify(
            db, [int(owner_id)], title=f"{rfq.rfq_no} sent back to you",
            body=f"{user.full_name}: {reason}",
            entity_type="RFQ", entity_id=rfq.id, deep_link=f"/procurement/rfqs/{rfq.id}")
    await db.commit()
    return await get_rfq_detail(db, rfq.id, user)


async def resubmit_rfq_correction(db: AsyncSession, rfq_id: int, user, comments: str = ""):
    """Hand a sent-back RFQ up again; it reopens at the rung that sent it back."""
    rfq = await get_rfq(db, rfq_id, user, include_approver=True)
    if rfq.status != RFQStatus.RETURNED_FOR_CORRECTION.value:
        raise ValidationError(f"RFQ is not sent back for correction (status {rfq.status})")
    await engine.resubmit_correction(
        db, DocType.RFQ.value, rfq.id, user, context=_rfq_workflow_context(rfq))
    before_status = rfq.status
    rfq.status = RFQStatus.PENDING_APPROVAL.value
    rfq.current_approver_name = await _approver_names(db, DocType.RFQ.value, rfq.id)
    await write_audit(
        db, entity="pro_rfqs", entity_id=rfq.id, entity_no=rfq.rfq_no,
        action=AuditAction.UPDATE, actor=user,
        before={"status": before_status}, after={"status": rfq.status},
        summary="Resubmitted RFQ after correction"
                + (f": {comments.strip()}" if (comments or "").strip() else ""),
    )
    await db.commit()
    return await get_rfq_detail(db, rfq.id, user)


async def _publish_rfq(db: AsyncSession, rfq: RFQ) -> None:
    """Open the RFQ to its vendors and give each one an empty quotation to fill in.

    The draft quotation is created here rather than on the vendor's first save so the
    portal always has a document to open — a vendor staring at "nothing to do" cannot
    tell an RFQ they were left off from one they simply have not started.
    """
    rfq.status = RFQStatus.PUBLISHED.value
    rfq.current_approver_name = None
    now = utcnow()
    rfq_item_ids = {line.item_id for line in rfq.items}
    for invited in rfq.vendors:
        mapped_item_ids = set(invited.mapped_item_ids or [])
        if invited.mapped_item_ids is None:
            mapped_item_ids = set((await db.execute(
                select(VendorItem.item_id).where(
                    VendorItem.vendor_id == invited.vendor_id,
                    VendorItem.item_id.in_(rfq_item_ids),
                )
            )).scalars().all()) if rfq_item_ids else set()
            invited.mapped_item_ids = sorted(mapped_item_ids)
        item_quantities = invited.item_quantities
        if item_quantities is None:
            item_quantities = {
                str(line.item_id): float(line.quantity)
                for line in rfq.items if line.item_id in mapped_item_ids}
            invited.item_quantities = item_quantities
        if not mapped_item_ids:
            raise ValidationError(
                f"{invited.vendor_name or invited.vendor_id} is not mapped to any "
                "item on this RFQ")
        missing_quantities = [item_id for item_id in mapped_item_ids
                              if str(item_id) not in item_quantities]
        if missing_quantities:
            raise ValidationError(
                f"No vendor quantity was allocated for item {missing_quantities[0]}")
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
            if line.item_id not in mapped_item_ids:
                continue
            db.add(QuotationItem(
                quotation_id=quote.id, line_no=line.line_no,
                rfq_item_id=line.id, item_id=line.item_id,
                item_code=line.item_code, item_name=line.item_name,
                description=line.description, uom_code=line.uom_code,
                quantity=_d(item_quantities[str(line.item_id)]),
                **combinations.carry(line),
            ))


async def email_rfq_copies(db: AsyncSession, rfq: RFQ, user) -> None:
    """Email each vendor's RFQ after its approved publication is committed."""
    # Plain locals, read before any vendor's send can leave the session needing a
    # rollback (SCM_0087). A rollback expires every object on the session, and an
    # expired attribute cannot be re-read on an async session, so the loop must not
    # walk `rfq.vendors` — one failed vendor would break the ones after it.
    rfq_id = rfq.id
    rfq_no = rfq.rfq_no
    due_date = str(rfq.due_date or "")
    recipients = [
        (v.vendor_id, v.vendor_name, (v.vendor_email or "").strip(),
         list(v.mapped_item_ids or []), dict(v.item_quantities or {}))
        for v in rfq.vendors
    ]
    for vendor_id, vendor_name, address, mapped_item_ids, item_quantities in recipients:
        if not address:
            logger.warning("%s not emailed to %s: no vendor email", rfq_no,
                           vendor_name or vendor_id)
            continue
        try:
            portal_url = (f"{settings.APP_BASE_URL.rstrip('/')}/supplier/login"
                          f"?next=/supplier/rfqs/{rfq_id}")
            subject = f"Request for quotation {rfq_no}"
            text = (f"Hello {vendor_name or 'Supplier'},\n\n"
                    f"Your RFQ copy is attached. Sign in with your supplier username and "
                    f"password to submit your quotation.\n\nSupplier Portal: {portal_url}")
            company = await mail_service._company(db)
            html = mail_template.render(
                subject=subject, eyebrow="Request for quotation", heading=subject,
                preheader=f"Quotation requested from {vendor_name or 'supplier'}.",
                blocks=[
                    mail_template.paragraph(f"Hello {vendor_name or 'Supplier'},"),
                    mail_template.paragraph(
                        "Your RFQ copy is attached. Sign in with your supplier username "
                        "and password to submit your quotation."),
                    mail_template.facts([("RFQ", rfq_no), ("Due date", due_date)]),
                    mail_template.button("Open Supplier Portal", portal_url),
                ], company=company,
                footer_note="Use your existing supplier username and password to sign in.")
            await mail_service.send_mail(
                db, MailSendIn(to=[address], subject=subject, body=text, html=html), user,
                attachments=[(f"{rfq_no}.pdf",
                              vendor_documents.rfq_pdf(
                                  rfq, vendor_name or "Supplier", company,
                                  mapped_item_ids, item_quantities),
                              "application/pdf")])
        except Exception as exc:  # delivery cannot unpublish an approved RFQ
            # The publish/approval is already committed; a dead session from a
            # failed send must not poison the next vendor's send or the caller's
            # next statement. After a heal `rfq` is expired, so read it afresh.
            if await _heal_session(db, user):
                rfq = await get_rfq(db, rfq_id)
            logger.warning("could not email %s to %s: %s", rfq_no, address, exc)


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


async def _vendor_item_scope(db: AsyncSession, rfq_id: int, vendor_id: int,
                             snapshot) -> set[int]:
    """Return the invitation snapshot, with a live-map fallback for old RFQs."""
    if snapshot is not None:
        return set(snapshot)
    return set((await db.execute(
        select(VendorItem.item_id)
        .join(RFQItem, RFQItem.item_id == VendorItem.item_id)
        .where(RFQItem.rfq_id == rfq_id, VendorItem.vendor_id == vendor_id)
    )).scalars().all())


def _apply_vendor_quote_scope(quote: Quotation, allowed: set[int]) -> None:
    """Hide legacy quotation lines that were never assigned to this vendor."""
    visible = [line for line in quote.items if line.item_id in allowed]
    set_committed_value(quote, "items", visible)
    sub_total = tax_total = Decimal(0)
    for line in visible:
        gross = _d(line.quantity) * _d(line.rate)
        net = gross - (gross * _d(line.discount_percent) / 100)
        sub_total += net
        tax_total += net * _d(line.tax_percent) / 100
    set_committed_value(quote, "sub_total", sub_total)
    set_committed_value(quote, "tax_amount", tax_total)
    set_committed_value(
        quote, "grand_total",
        sub_total + tax_total + _d(quote.freight_amount) - _d(quote.discount_amount))


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
    invited = (await db.execute(select(RFQVendor).where(
        RFQVendor.rfq_id == quote.rfq_id,
        RFQVendor.vendor_id == quote.vendor_id,
    ))).scalar_one_or_none()
    allowed = await _vendor_item_scope(
        db, quote.rfq_id, quote.vendor_id,
        invited.mapped_item_ids if invited is not None else None)
    _apply_vendor_quote_scope(quote, allowed)
    # FIXED: `tax_region`/`company_gstin` are derived, never stored (see
    # `_attach_tax_context`) — the supplier portal's own reads already call it, but
    # the buyer's Quotation Detail screen never did, so it showed the tax split only
    # in the instant right after a vendor submitted and blank on every later reload.
    await _attach_tax_context(db, quote)
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


# --------------------------------------------------------------------------- #
#  Freeze Prices (2026-09-26) — the lock before comparison, award and PO
# --------------------------------------------------------------------------- #

async def _assert_rfq_unfrozen(rfq: RFQ, doing: str) -> None:
    """Refuse `doing` on a frozen tender, naming the lock and the way out.

    Every price-changing door in this module walks through here, so the wording
    of the refusal is written once and reads the same from every screen. The
    message names the NEXT ACTION for whoever is reading it: a buyer can reopen
    bidding, a supplier can only take it up with the buyer.
    """
    if rfq.is_price_frozen:
        raise ValidationError(
            f"{rfq.rfq_no} is closed for pricing — prices were frozen on "
            f"{rfq.frozen_at.date() if rfq.frozen_at else 'an earlier date'} "
            f"by {rfq.frozen_by_name or 'a buyer'}. {doing} is no longer "
            "possible on this tender; contact the buyer, or the buyer may "
            "reopen bidding.")


async def freeze_rfq(db: AsyncSession, rfq_id: int, user) -> RFQ:
    """Close the tender to pricing. Suppliers may no longer quote, re-quote or
    accept a change request; the buyer may award and raise POs.

    Not a status — a flag. A tender is "open but frozen" while the buyer reads
    the sheet, and that state is exactly what a NEW status value would have made
    every existing filter, KPI and report invent a meaning for. The freeze is
    audited here rather than left to the route (rule 9: the state change and its
    audit line are one act).
    """
    rfq = await get_rfq(db, rfq_id, user)
    if rfq.is_price_frozen:
        raise ValidationError(f"{rfq.rfq_no} is already frozen")
    rfq.is_price_frozen = True
    rfq.frozen_at = utcnow()
    rfq.frozen_by_id = getattr(user, "id", None)
    rfq.frozen_by_name = getattr(user, "full_name", None)
    # The quotes-in count at the moment the door closed.
    rfq.frozen_at_revision = await db.scalar(
        select(func.count(Quotation.id)).where(
            Quotation.rfq_id == rfq.id,
            Quotation.status != QuotationStatus.DRAFT.value))
    await db.commit()
    await write_audit(
        db, entity="pro_rfqs", action=AuditAction.UPDATE, entity_id=rfq.id,
        entity_no=rfq.rfq_no, actor=user,
        before={"is_price_frozen": False},
        after={"is_price_frozen": True,
               "frozen_at_revision": rfq.frozen_at_revision},
        summary=f"Prices frozen on {rfq.rfq_no} ({rfq.frozen_at_revision or 0} "
                "quotes in)")
    await notifications.notify(
        db, [rfq.created_by_id], title=f"{rfq.rfq_no} — prices frozen",
        body="Suppliers can no longer quote or change prices. POs can now be "
             "raised against its quotations.",
        entity_type="RFQ", entity_id=rfq.id, deep_link=f"/procurement/rfqs/{rfq.id}")
    await db.commit()
    return await get_rfq(db, rfq_id)


async def unfreeze_rfq(db: AsyncSession, rfq_id: int, reason: str, user) -> RFQ:
    """Reopen bidding. The reason is REQUIRED — unfreezing after people were told
    prices are settled is the one freeze action that can surprise a supplier, and
    a reopen with no recorded why is the trail answering no questions later.
    """
    if not (reason or "").strip():
        raise ValidationError("Say why bidding is being reopened")
    rfq = await get_rfq(db, rfq_id, user)
    if not rfq.is_price_frozen:
        raise ValidationError(f"{rfq.rfq_no} is not frozen")
    rfq.is_price_frozen = False
    rfq.frozen_at = None
    rfq.frozen_by_id = None
    rfq.frozen_by_name = None
    rfq.frozen_at_revision = None
    await db.commit()
    await write_audit(
        db, entity="pro_rfqs", action=AuditAction.UPDATE, entity_id=rfq.id,
        entity_no=rfq.rfq_no, actor=user,
        before={"is_price_frozen": True},
        after={"is_price_frozen": False},
        summary=f"Bidding reopened on {rfq.rfq_no}: {reason.strip()}")
    return await get_rfq(db, rfq_id)


# --------------------------------------------------------------------------- #
#  Quotation change requests — the buyer asks, the supplier decides
# --------------------------------------------------------------------------- #

_CR_OPEN = QuoteChangeStatus.AWAITING_SUPPLIER.value


def _quote_snapshot(quote: Quotation) -> dict:
    """The whole quotation as it stands, header and lines, ready to be filed away.

    Shaped exactly as `_po_snapshot` is, for the same reason: a revision trail is
    read against a version that still exists, and a diff can only be read against
    one. `snapshot_before` on every change request holds this.
    """
    return {
        "quotation_no": quote.quotation_no,
        "vendor_id": quote.vendor_id, "vendor_name": quote.vendor_name,
        "payment_terms": quote.payment_terms,
        "freight_amount": float(_d(quote.freight_amount)),
        "discount_amount": float(_d(quote.discount_amount)),
        "sub_total": float(_d(quote.sub_total)),
        "tax_amount": float(_d(quote.tax_amount)),
        "grand_total": float(_d(quote.grand_total)),
        "revision_count": quote.revision_count,
        "items": [{
            "quotation_item_id": line.id,
            "item_id": line.item_id, "item_code": line.item_code,
            "item_name": line.item_name, "uom_code": line.uom_code,
            "quantity": float(_d(line.quantity)), "rate": float(_d(line.rate)),
            "discount_percent": float(_d(line.discount_percent)),
            "tax_percent": float(_d(line.tax_percent)),
            "amount": float(_d(line.amount)),
        } for line in quote.items],
    }


async def _load_quotation_locked(db: AsyncSession, quotation_id: int) -> Quotation:
    """The quotation with its lines, for writing."""
    quote = (await db.execute(
        select(Quotation)
        .options(selectinload(Quotation.items))
        .where(Quotation.id == quotation_id)
    )).scalars().first()
    if quote is None:
        raise NotFoundError(f"Quotation {quotation_id} not found")
    return quote


async def propose_quote_change(db: AsyncSession, quotation_id: int,
                               data, user) -> QuoteChangeRequest:
    """The buyer asks the supplier for better numbers. Nothing is applied yet —
    a change request is a QUESTION, and applying its numbers before the answer
    would mean the buyer negotiating with themselves."""
    quote = await _load_quotation_locked(db, quotation_id)
    rfq = await db.get(RFQ, quote.rfq_id)
    if rfq is None:
        raise NotFoundError(f"RFQ {quote.rfq_id} not found")
    if quote.status not in (QuotationStatus.SUBMITTED.value,
                            QuotationStatus.REVISED.value):
        raise ValidationError(
            f"{quote.quotation_no} is {quote.status}; a change can only be "
            "asked of a submitted quotation")
    await _assert_rfq_unfrozen(
        rfq, "asking the supplier for changed prices")
    open_cr = (await db.execute(
        select(QuoteChangeRequest).where(
            QuoteChangeRequest.quotation_id == quote.id,
            QuoteChangeRequest.status == _CR_OPEN)
    )).scalars().first()
    if open_cr is not None:
        raise ValidationError(
            f"{open_cr.cr_no} is already awaiting the supplier's answer on "
            f"{quote.quotation_no}. Withdraw it or wait before asking again.")
    if not (data.reason or "").strip():
        raise ValidationError("Say why the supplier is being asked to change prices")

    by_id = {line.id: line for line in quote.items}
    for incoming in data.lines:
        if incoming.quotation_item_id not in by_id:
            raise ValidationError(
                f"Line {incoming.quotation_item_id} is not on this quotation")

    cr = QuoteChangeRequest(
        quotation_id=quote.id, rfq_id=rfq.id,
        cr_no=await next_number(db, "quote_change_request"),
        status=_CR_OPEN,
        reason=data.reason.strip(),
        proposed_lines=[{
            "quotation_item_id": line.quotation_item_id,
            "proposed_quantity": float(_d(line.proposed_quantity)),
            "proposed_rate": float(_d(line.proposed_rate)),
            "proposed_discount_percent": float(_d(line.proposed_discount_percent)),
            "note": line.note,
        } for line in data.lines],
        snapshot_before=_quote_snapshot(quote),
        proposed_by_id=getattr(user, "id", None),
        proposed_by_name=getattr(user, "full_name", None),
    )
    db.add(cr)
    quote.under_negotiation = True
    await db.commit()
    await db.refresh(cr)

    await notifications.notify(
        db, [quote.vendor_id], title=f"{quote.quotation_no} — the buyer proposed changes",
        body=f"{cr.proposed_by_name or 'The buyer'} asked for changes on "
             f"{rfq.rfq_no} ({cr.cr_no}). Review and respond on your portal.",
        entity_type="QUOTATION", entity_id=quote.id,
        deep_link=f"/supplier/rfqs/{rfq.id}")
    await db.commit()
    return cr


async def withdraw_quote_change(db: AsyncSession, quotation_id: int, cr_id: int,
                                user) -> QuoteChangeRequest:
    """The buyer takes their own ask back before an answer. A withdrawn request
    is history (rule 9), not a deletion — the quote simply stops reading as
    under negotiation, because nothing is pending any more."""
    cr = (await db.execute(
        select(QuoteChangeRequest).where(
            QuoteChangeRequest.id == cr_id,
            QuoteChangeRequest.quotation_id == quotation_id)
    )).scalars().first()
    if cr is None:
        raise NotFoundError(f"Change request {cr_id} not found")
    if cr.status != _CR_OPEN:
        raise ValidationError(
            f"{cr.cr_no} is {cr.status} and can no longer be withdrawn")
    cr.status = QuoteChangeStatus.WITHDRAWN.value
    cr.supplier_decided_at = utcnow()
    quote = await _load_quotation_locked(db, quotation_id)
    quote.under_negotiation = False
    await db.commit()
    await db.refresh(cr)
    return cr


def _apply_proposed_lines(quote: Quotation, cr: QuoteChangeRequest) -> None:
    """Write the accepted proposal onto the quotation and re-derive every total
    through `_quote_totals` — the same arithmetic that priced the original offer.
    A proposed line asking for zero quantity stands for "drop this line from the
    offer"; its rate is kept, the quantity is what speaks."""
    by_id = {line.id: line for line in quote.items}
    for proposed in cr.proposed_lines:
        line = by_id.get(proposed.get("quotation_item_id"))
        if line is None:
            continue
        line.quantity = _d(proposed.get("proposed_quantity", line.quantity))
        line.rate = _d(proposed.get("proposed_rate", line.rate))
        line.discount_percent = _d(proposed.get("proposed_discount_percent",
                                                line.discount_percent))
    _quote_totals(quote)


async def accept_quote_change(db: AsyncSession, vendor_id: int, cr_id: int,
                              note: str, counter_lines: list | None = None) -> Quotation:
    """The supplier takes the buyer's numbers (or counter-proposes). THIS is the moment
    the quotation re-prices: the proposal/counter is applied, the totals re-derived through
    `_quote_totals`, the quote bumps to REVISED (the same rung a vendor's own
    re-quote uses, so a buyer sees movement either way) and every other open
    request on this quote is marked SUPERSEDED — one price, one truth."""
    cr = (await db.execute(
        select(QuoteChangeRequest).where(QuoteChangeRequest.id == cr_id)
    )).scalars().first()
    if cr is None:
        raise NotFoundError(f"Change request {cr_id} not found")
    quote = await _load_quotation_locked(db, cr.quotation_id)
    if quote.vendor_id != vendor_id:
        raise NotFoundError(f"Change request {cr_id} not found")
    rfq = await db.get(RFQ, cr.rfq_id)
    if rfq is None:
        raise NotFoundError(f"RFQ {cr.rfq_id} not found")
    await _assert_rfq_unfrozen(
        rfq, "accepting changed prices on your quotation")
    if cr.status != _CR_OPEN:
        raise ValidationError(
            f"{cr.cr_no} is {cr.status} and can no longer be answered")

    if counter_lines:
        parsed_counter = [c.model_dump() if hasattr(c, "model_dump") else dict(c) for c in counter_lines]
        cr.supplier_counter_lines = parsed_counter
        by_id = {line.id: line for line in quote.items}
        for item_data in parsed_counter:
            line = by_id.get(item_data.get("quotation_item_id"))
            if line is None:
                continue
            if "proposed_quantity" in item_data:
                line.quantity = _d(item_data["proposed_quantity"])
            if "proposed_rate" in item_data:
                line.rate = _d(item_data["proposed_rate"])
            if "proposed_discount_percent" in item_data:
                line.discount_percent = _d(item_data["proposed_discount_percent"])
        _quote_totals(quote)
    else:
        _apply_proposed_lines(quote, cr)

    quote.status = QuotationStatus.REVISED.value
    quote.revision_count += 1
    quote.accepted_revision = (quote.accepted_revision or 0) + 1
    quote.under_negotiation = False
    quote.submitted_at = utcnow()
    cr.status = QuoteChangeStatus.ACCEPTED.value
    cr.supplier_decision_note = (note or "").strip() or None
    cr.supplier_decided_at = utcnow()
    for other in (await db.execute(
            select(QuoteChangeRequest).where(
                QuoteChangeRequest.quotation_id == quote.id,
                QuoteChangeRequest.status == _CR_OPEN,
                QuoteChangeRequest.id != cr.id)
    )).scalars().all():
        other.status = QuoteChangeStatus.SUPERSEDED.value
        other.supplier_decided_at = utcnow()
    await db.commit()
    await db.refresh(quote)

    await notifications.notify(
        db, [cr.proposed_by_id],
        title=f"{quote.quotation_no} — {cr.cr_no} accepted",
        body=f"{quote.vendor_name or 'The supplier'} accepted the change request. "
             f"The quotation now reads {quote.grand_total} ({rfq.rfq_no}).",
        entity_type="QUOTATION", entity_id=quote.id,
        deep_link=f"/procurement/quotations/{quote.id}")
    await db.commit()
    await _attach_tax_context(db, quote)
    return quote


async def decline_quote_change(db: AsyncSession, vendor_id: int, cr_id: int,
                               note: str) -> Quotation:
    """The supplier says no. The quotation was never rewritten — the proposal
    only ever lived on the request — so there is nothing to revert, unlike the
    PO decline which must restore a snapshot. The quote stands exactly as the
    supplier priced it."""
    cr = (await db.execute(
        select(QuoteChangeRequest).where(QuoteChangeRequest.id == cr_id)
    )).scalars().first()
    if cr is None:
        raise NotFoundError(f"Change request {cr_id} not found")
    quote = await _load_quotation_locked(db, cr.quotation_id)
    if quote.vendor_id != vendor_id:
        raise NotFoundError(f"Change request {cr_id} not found")
    if cr.status != _CR_OPEN:
        raise ValidationError(
            f"{cr.cr_no} is {cr.status} and can no longer be answered")
    cr.status = QuoteChangeStatus.DECLINED.value
    cr.supplier_decision_note = (note or "").strip() or None
    cr.supplier_decided_at = utcnow()
    quote.under_negotiation = False
    await db.commit()
    await db.refresh(quote)

    await notifications.notify(
        db, [cr.proposed_by_id],
        title=f"{quote.quotation_no} — {cr.cr_no} declined",
        body=f"{quote.vendor_name or 'The supplier'} declined the change request"
             + (f": {note.strip()}" if (note or "").strip() else ".")
             + " The quotation stands as quoted.",
        entity_type="QUOTATION", entity_id=quote.id,
        deep_link=f"/procurement/quotations/{quote.id}")
    await db.commit()
    return quote


def _cr_out_lines(cr: QuoteChangeRequest) -> list[dict]:
    """Decorate the proposed lines with their "before" figures, read off the
    snapshot — the diff a screen draws is SERVED, never recomputed there."""
    before = {row.get("quotation_item_id"): row
              for row in (cr.snapshot_before or {}).get("items", [])}
    out = []
    for proposed in cr.proposed_lines:
        row = before.get(proposed.get("quotation_item_id"), {})
        out.append({
            **proposed,
            "item_id": row.get("item_id"),
            "item_code": row.get("item_code"),
            "item_name": row.get("item_name"),
            "uom_code": row.get("uom_code"),
            "current_quantity": row.get("quantity", 0),
            "current_rate": row.get("rate", 0),
            "current_discount_percent": row.get("discount_percent", 0),
            "current_amount": row.get("amount", 0),
        })
    return out


def _cr_out(cr: QuoteChangeRequest) -> dict:
    return {
        "id": cr.id, "quotation_id": cr.quotation_id, "rfq_id": cr.rfq_id,
        "cr_no": cr.cr_no, "status": cr.status, "reason": cr.reason,
        "proposed_by_name": cr.proposed_by_name,
        "supplier_decision_note": cr.supplier_decision_note,
        "supplier_decided_at": cr.supplier_decided_at,
        "created_at": cr.created_at,
        "lines": _cr_out_lines(cr),
        "supplier_counter_lines": cr.supplier_counter_lines,
    }


async def list_quote_change_requests(db: AsyncSession, quotation_id: int,
                                     user=None) -> list[dict]:
    """The price trail's requests, oldest last. Buyer-facing — bounded through the
    quotation's RFQ scope exactly as `get_quotation` is."""
    stmt = select(QuoteChangeRequest).where(
        QuoteChangeRequest.quotation_id == quotation_id)
    if user is not None:
        stmt = stmt.where(QuoteChangeRequest.rfq_id.in_(
            select(RFQ.id).where(
                await scope_condition(db, user, owner_col=RFQ.created_by_id))))
    rows = (await db.execute(stmt.order_by(QuoteChangeRequest.id))).scalars().all()
    return [_cr_out(cr) for cr in rows]


async def vendor_list_quote_change_requests(db: AsyncSession, vendor_id: int,
                                            rfq_id: int) -> list[dict]:
    """The supplier's own trail, scoped to their RFQ."""
    quote = await vendor_get_quotation(db, vendor_id, rfq_id)
    rows = (await db.execute(
        select(QuoteChangeRequest)
        .where(QuoteChangeRequest.quotation_id == quote.id)
        .order_by(QuoteChangeRequest.id)
    )).scalars().all()
    return [_cr_out(cr) for cr in rows]


async def quote_price_trail(db: AsyncSession, quotation_id: int,
                            user=None) -> list[dict]:
    """One version line per change to this quotation, oldest first.

    ONE function, ONE answer: the buyer screen, the comparison sheet and the
    supplier portal all read this, so two readers can never disagree about what
    version a price belongs to. Sources today: the original offer and every
    accepted change request (the trail rows live on the requests themselves —
    the snapshot_before of each carries its "from", its applied lines carry its
    "to"). A supplier's own re-quote rides `revision_count` and is visible in
    the same counter, not re-narrated here.
    """
    quote = await _load_quotation_locked(db, quotation_id)
    if user is not None:
        await get_quotation(db, quotation_id, user)  # scope check, then discard
    crs = (await db.execute(
        select(QuoteChangeRequest)
        .where(QuoteChangeRequest.quotation_id == quotation_id,
               QuoteChangeRequest.status == QuoteChangeStatus.ACCEPTED.value)
        .order_by(QuoteChangeRequest.id)
    )).scalars().all()

    trail: list[dict] = []
    first = crs[0].snapshot_before if crs else _quote_snapshot(quote)
    trail.append({
        "version": 1,
        "source": "ORIGINAL",
        "effective_at": quote.created_at,
        "changed_by": quote.vendor_name or f"Vendor {quote.vendor_id}",
        "totals": {"sub_total": first.get("sub_total", 0),
                   "tax_amount": first.get("tax_amount", 0),
                   "freight_amount": first.get("freight_amount", 0),
                   "discount_amount": first.get("discount_amount", 0),
                   "grand_total": first.get("grand_total", 0)},
        "lines": first.get("items", []),
        "buyer_requested_lines": first.get("items", []),
        "cr_no": None, "reason": None, "note": None,
    })
    for idx, cr in enumerate(crs):
        version_num = idx + 2
        if idx + 1 < len(crs):
            accepted_snap = crs[idx + 1].snapshot_before
        else:
            accepted_snap = _quote_snapshot(quote)

        buyer_req_lines = _cr_out_lines(cr)
        buyer_sub = sum(
            float(_d(l.get("proposed_quantity", 0)) * _d(l.get("proposed_rate", 0)) * (1 - _d(l.get("proposed_discount_percent", 0)) / 100))
            for l in buyer_req_lines
        )
        buyer_tax = sum(
            float(_d(l.get("proposed_quantity", 0)) * _d(l.get("proposed_rate", 0)) * (1 - _d(l.get("proposed_discount_percent", 0)) / 100) * (_d(l.get("tax_percent", 0)) / 100))
            for l in buyer_req_lines
        )
        freight = float(_d((cr.snapshot_before or {}).get("freight_amount", 0)))
        discount = float(_d((cr.snapshot_before or {}).get("discount_amount", 0)))
        buyer_grand = buyer_sub + buyer_tax + freight - discount

        trail.append({
            "version": version_num,
            "source": "CHANGE_REQUEST",
            "effective_at": cr.supplier_decided_at,
            "changed_by": cr.proposed_by_name or quote.vendor_name or f"Vendor {quote.vendor_id}",
            "totals": {"sub_total": accepted_snap.get("sub_total", 0),
                       "tax_amount": accepted_snap.get("tax_amount", 0),
                       "freight_amount": accepted_snap.get("freight_amount", 0),
                       "discount_amount": accepted_snap.get("discount_amount", 0),
                       "grand_total": accepted_snap.get("grand_total", 0)},
            "lines": accepted_snap.get("items", []),
            "buyer_requested_lines": buyer_req_lines,
            "buyer_requested_totals": {"sub_total": buyer_sub, "tax_amount": buyer_tax,
                                       "freight_amount": freight, "discount_amount": discount,
                                       "grand_total": buyer_grand},
            "cr_no": cr.cr_no, "reason": cr.reason,
            "note": cr.supplier_decision_note,
        })
    return trail


# --------------------------------------------------------------------------- #
#  Quotation chat — buyer <-> supplier, one thread per quotation
# --------------------------------------------------------------------------- #

async def quotation_comments(db: AsyncSession, quotation_id: int,
                             user=None) -> list:
    """The thread beside the paper. Bounded through the quotation's RFQ scope
    exactly as the quotation itself is."""
    stmt = select(QuotationComment).where(
        QuotationComment.quotation_id == quotation_id)
    if user is not None:
        stmt = stmt.where(QuotationComment.quotation_id.in_(
            select(Quotation.id).where(Quotation.rfq_id.in_(
                select(RFQ.id).where(
                    await scope_condition(db, user, owner_col=RFQ.created_by_id))))))
    return list((await db.execute(
        stmt.order_by(QuotationComment.id))).scalars().all())


async def add_quotation_comment(db: AsyncSession, quotation_id: int,
                                message: str, user) -> QuotationComment:
    """The buyer posts. Append-only: no edit, no delete (rule 9)."""
    quote = await get_quotation(db, quotation_id, user)
    row = QuotationComment(
        quotation_id=quote.id,
        author_id=getattr(user, "id", None),
        author_name=getattr(user, "full_name", None),
        author_side="BUYER",
        message=message.strip(),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def vendor_quotation_comments(db: AsyncSession, vendor_id: int,
                                    rfq_id: int) -> list:
    """The supplier's view of the same thread."""
    quote = await vendor_get_quotation(db, vendor_id, rfq_id)
    return list((await db.execute(
        select(QuotationComment)
        .where(QuotationComment.quotation_id == quote.id)
        .order_by(QuotationComment.id)
    )).scalars().all())


async def add_vendor_quotation_comment(db: AsyncSession, vendor_id: int,
                                       rfq_id: int, message: str) -> QuotationComment:
    """The supplier posts into the same thread. The vendor id comes from the
    token, so a supplier can never write beside another supplier's paper."""
    quote = await vendor_get_quotation(db, vendor_id, rfq_id)
    row = QuotationComment(
        quotation_id=quote.id,
        author_id=None,
        author_name=quote.vendor_name or f"Vendor {vendor_id}",
        author_side="SUPPLIER",
        message=message.strip(),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


def _line_breakup(line) -> dict:
    """One quoted line, split the way a buyer reads it.

    Computed here rather than in the screen for the reason every other total is: the
    arithmetic that decides a winner must be the same arithmetic that wrote
    `quotation.sub_total`, and two implementations of it will disagree eventually.

    Discount comes off before tax, exactly as `_quote_totals` does it. `tax_percent`
    is the vendor's whole GST figure; which half of it applies is decided by the two
    GSTINs and shown on the quotation, not recomputed into the line's total here.
    """
    quantity = _d(line.quantity)
    gross = quantity * _d(line.rate)
    discount = gross * _d(line.discount_percent or 0) / 100
    taxable = gross - discount
    tax = taxable * _d(line.tax_percent or 0) / 100
    return {
        "quantity": float(quantity),
        "rate": float(_d(line.rate)),
        "discount_percent": float(_d(line.discount_percent or 0)),
        "discount_amount": float(discount),
        "taxable_amount": float(taxable),
        "tax_percent": float(_d(line.tax_percent or 0)),
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

    invitations = {row.vendor_id: row for row in (await db.execute(
        select(RFQVendor).where(RFQVendor.rfq_id == rfq.id)
    )).scalars().all()}
    for quote in quotes:
        invited = invitations.get(quote.vendor_id)
        allowed = await _vendor_item_scope(
            db, rfq.id, quote.vendor_id,
            invited.mapped_item_ids if invited is not None else None)
        _apply_vendor_quote_scope(quote, allowed)

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


def _same_share(before, after) -> bool:
    """Do two awarded-quantity maps say the same thing?

    Compared as numbers, never as dicts: the column is JSON, so what went in as a
    Decimal comes back as a float and an untouched share would otherwise read as changed.
    """
    left = {key: _d(value) for key, value in (before or {}).items() if _d(value) > 0}
    right = {key: _d(value) for key, value in (after or {}).items() if _d(value) > 0}
    return left == right


async def _live_po_awards(db: AsyncSession, rfq_id: int) -> tuple[
        dict[int, dict[str, Decimal]], dict[int, str]]:
    """Return live PO quantities by vendor, plus a PO reference for each vendor.

    The RFQ award may grow after it was first ordered, but it must never shrink below
    quantity on a PO that has not been rejected or cancelled. Reading PO lines, not
    saved award JSON, makes that floor correct if a draft PO was edited before sending.
    """
    rows = list((await db.execute(
        select(PurchaseOrder)
        .options(selectinload(PurchaseOrder.items))
        .where(PurchaseOrder.rfq_id == rfq_id,
               PurchaseOrder.status.notin_(_DEAD_PO_STATUSES))
        .order_by(PurchaseOrder.id)
    )).scalars().all())
    quantities: dict[int, dict[str, Decimal]] = {}
    po_nos: dict[int, str] = {}
    for po in rows:
        po_nos.setdefault(po.vendor_id, po.po_no)
        vendor_quantities = quantities.setdefault(po.vendor_id, {})
        for line in po.items:
            key = str(line.item_id)
            vendor_quantities[key] = (
                vendor_quantities.get(key, Decimal("0")) + _d(line.quantity))
    return quantities, po_nos


async def _split_award_winners(db: AsyncSession, rfq: RFQ, allocations,
                               locked_quantities: dict[int, dict[str, Decimal]] | None = None,
                               locked_po_nos: dict[int, str] | None = None,
                               ) -> tuple[set[int], list[Quotation]]:
    """Validate and persist item-level shares, returning winning quote ids/rows.

    `locked` names the vendors whose share is already on a live purchase order. Their
    numbers may be restated but never changed — the order has been placed, and moving
    the award under it would leave the RFQ saying one thing and the PO another.
    """
    locked_quantities = locked_quantities or {}
    locked_po_nos = locked_po_nos or {}
    rfq_quantities = {line.item_id: _d(line.quantity) for line in rfq.items}
    invited_rows = list((await db.execute(
        select(RFQVendor).where(RFQVendor.rfq_id == rfq.id)
    )).scalars().all())
    invited = {row.vendor_id: row for row in invited_rows}
    quotations = list((await db.execute(
        select(Quotation).where(Quotation.rfq_id == rfq.id)
    )).scalars().all())
    submitted = {
        quote.vendor_id: quote for quote in quotations
        if quote.status != QuotationStatus.DRAFT.value
    }

    shares: dict[int, dict[str, float]] = {}
    totals: dict[int, Decimal] = {}
    for allocation in allocations:
        item_id, vendor_id = allocation.item_id, allocation.vendor_id
        quantity = _d(allocation.quantity)
        if item_id not in rfq_quantities:
            raise ValidationError(f"Item {item_id} is not on {rfq.rfq_no}")
        invitation = invited.get(vendor_id)
        if invitation is None:
            raise ValidationError(f"Vendor {vendor_id} was not invited to {rfq.rfq_no}")
        quote = submitted.get(vendor_id)
        if quote is None:
            raise ValidationError(
                f"{invitation.vendor_name or f'Vendor {vendor_id}'} has not "
                "submitted a quotation")
        quote_line = next((line for line in quote.items if line.item_id == item_id), None)
        if quote_line is None or _d(quote_line.quantity) <= 0:
            raise ValidationError(
                f"{quote.vendor_name or vendor_id} did not quote item {item_id}")

        vendor_shares = shares.setdefault(vendor_id, {})
        key = str(item_id)
        combined = _d(vendor_shares.get(key, 0)) + quantity
        if combined > _d(quote_line.quantity):
            raise ValidationError(
                f"{quote.vendor_name or vendor_id} quoted {_d(quote_line.quantity)} "
                f"of item {item_id}, but {combined} was awarded")
        vendor_shares[key] = float(combined)
        totals[item_id] = totals.get(item_id, Decimal("0")) + quantity

    for item_id, total in totals.items():
        if total > rfq_quantities[item_id]:
            raise ValidationError(
                f"{total} allocated for item {item_id}, but the RFQ quantity is "
                f"{rfq_quantities[item_id]}")

    for invitation in invited_rows:
        fresh = shares.get(invitation.vendor_id)
        # An earlier sent/approved PO is a minimum, not a lock on the whole award.
        # Increasing the total is safe: the PO generator creates only the balance.
        # Reducing below the live line would make the RFQ contradict an order that
        # still exists, so that is the one case that needs a cancellation/rejection.
        for item_id, ordered_quantity in locked_quantities.get(
                invitation.vendor_id, {}).items():
            fresh_quantity = _d((fresh or {}).get(item_id, 0))
            if fresh_quantity < ordered_quantity:
                po_no = locked_po_nos.get(invitation.vendor_id, "a live purchase order")
                raise ValidationError(
                    f"{invitation.vendor_name or f'Vendor {invitation.vendor_id}'} "
                    f"already has {ordered_quantity} of item {item_id} on {po_no}. "
                    "Keep at least that quantity, or cancel/reject the PO first.")
        invitation.awarded_quantities = fresh
    winning_quotes = [submitted[vendor_id] for vendor_id in shares]
    return {quote.id for quote in winning_quotes}, winning_quotes


async def award_rfq(db: AsyncSession, rfq_id: int, data: AwardIn, user) -> RFQ:
    """Pick a quotation. Does not raise the PO — that is a separate, approved act.

    An AWARDED tender may be awarded AGAIN, because a purchase order can die: rejected in
    approval, or cancelled. What that order was carrying has to be buyable by somebody,
    and the only prices anybody ever quoted for it are the ones on this RFQ — so the
    re-award is closed to the vendors already invited here, who already priced the work.
    An outside vendor would be an award resting on no offer at all.

    A live PO fixes the quantity already ordered, but does not prevent a larger total
    award to that vendor. The PO generator turns only that newly added balance into the
    next PO, leaving the earlier order intact.
    """
    rfq = await get_rfq(db, rfq_id, user)
    OPEN = (RFQStatus.PUBLISHED.value, RFQStatus.CLOSED.value)
    locked_quantities: dict[int, dict[str, Decimal]] = {}
    locked_po_nos: dict[int, str] = {}
    if rfq.status == RFQStatus.AWARDED.value:
        locked_quantities, locked_po_nos = await _live_po_awards(db, rfq.id)
        if locked_po_nos and not data.allocations:
            raise ValidationError(
                "Part of this RFQ is already on a purchase order. Re-award it by "
                "entering item quantities, so the vendors already ordered from keep "
                "what they won.")
        whole = next((invitation for invitation in rfq.vendors
                      if invitation.vendor_id in locked_po_nos
                      and not (invitation.awarded_quantities or {})), None)
        if whole is not None:
            raise ValidationError(
                f"{locked_po_nos[whole.vendor_id]} covers the whole of {rfq.rfq_no}. Cancel or "
                "reject that order before awarding this tender again.")
    elif rfq.status not in OPEN:
        raise ValidationError(f"Cannot award an RFQ in {rfq.status} status")
    # Freeze Prices (2026-09-26): you compare frozen prices and you award from the
    # same sheet. Awarding from an unfrozen tender is picking a winner while the
    # race is still open to re-pricing — every loser's number was moving.
    if not rfq.is_price_frozen:
        raise ValidationError(
            f"Freeze prices on {rfq.rfq_no} before awarding — the award must "
            "rest on prices no supplier can still change")
    quotations = (await db.execute(
        select(Quotation).where(Quotation.rfq_id == rfq.id)
    )).scalars().all()
    if data.allocations:
        selected_ids, winners = await _split_award_winners(
            db, rfq, data.allocations, locked_quantities, locked_po_nos)
    else:
        requested = list(dict.fromkeys(
            data.quotation_ids or ([data.quotation_id] if data.quotation_id else [])))
        if len(requested) != 1:
            raise ValidationError(
                "Select one complete quotation, or enter item quantities to split the award")
        by_id = {quote.id: quote for quote in quotations}
        quote = by_id.get(requested[0])
        if quote is None:
            raise ValidationError("The selected quotation belongs to a different RFQ")
        if quote.status == QuotationStatus.DRAFT.value:
            raise ValidationError(
                f"{quote.vendor_name or 'The selected vendor'} has not submitted a quotation")
        selected_ids, winners = {quote.id}, [quote]
        for invitation in rfq.vendors:
            invitation.awarded_quantities = None
    for quote in quotations:
        if quote.id in selected_ids:
            quote.status = QuotationStatus.ACCEPTED.value
        elif quote.status != QuotationStatus.DRAFT.value:
            quote.status = QuotationStatus.REJECTED.value
    rfq.status = RFQStatus.AWARDED.value
    rfq.awarded_vendor_id = winners[0].vendor_id if len(winners) == 1 else None
    rfq.awarded_vendor_name = ", ".join(
        quote.vendor_name or f"Vendor {quote.vendor_id}" for quote in winners)
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
    if data.generate_pos:
        for quote in winners:
            try:
                await create_po_from_quotation(db, quote.id, POFromQuotationIn(), user)
            except ValidationError as err:
                if "no remaining awarded quantities" in str(err):
                    continue
                raise
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
    portal = "carrier" if vendor.vendor_type in CARRIER_VENDOR_TYPES else "supplier"
    await email_vendor_credentials(
        db, vendor.id, account.username, portal, "issued", user)
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
    vendor = await db.get(Vendor, vendor_id)
    portal = ("carrier" if vendor and vendor.vendor_type in CARRIER_VENDOR_TYPES
              else "supplier")
    await email_vendor_credentials(
        db, vendor_id, account.username, portal, "reset", user)
    return account


async def email_vendor_credentials(db: AsyncSession, vendor_id: int,
                                   username: str, portal: str, action: str,
                                   user) -> bool:
    """Send issued/reset portal credentials without making account creation fail."""
    try:
        vendor = await db.get(Vendor, vendor_id)
        address = (getattr(vendor, "email", None) or "").strip()
        if not address:
            logger.warning("login credentials not emailed to vendor %s: no email",
                           getattr(vendor, "name", None) or vendor_id)
            return False
        portal_name = "Carrier Portal" if portal == "carrier" else "Supplier Portal"
        portal_url = f"{settings.APP_BASE_URL.rstrip('/')}/{portal}/login"
        verb = "reset" if action == "reset" else "issued"
        subject = f"Your Bavya SCM {portal_name} login"
        company = await mail_service._company(db)
        html = mail_template.render(
            subject=subject,
            eyebrow="Portal access",
            heading=f"Your login has been {verb}",
            preheader=f"Sign-in details for the Bavya SCM {portal_name}.",
            blocks=[
                mail_template.paragraph(
                    f"Hello {getattr(vendor, 'name', None) or 'Partner'},"),
                mail_template.paragraph(
                    f"Use the credentials below to sign in to the {portal_name}."),
                mail_template.facts([
                    ("Username", username),
                    ("Temporary password", DEFAULT_VENDOR_PASSWORD),
                ]),
                mail_template.button(f"Open {portal_name}", portal_url),
                mail_template.link_fallback(portal_url),
                mail_template.paragraph(
                    "For security, you must change this password after signing in.",
                    muted=True),
            ],
            company=company,
            footer_note="Do not forward this email or share these credentials.",
        )
        text = (
            f"Hello {getattr(vendor, 'name', None) or 'Partner'},\n\n"
            f"Your Bavya SCM {portal_name} login has been {verb}.\n"
            f"Username: {username}\n"
            f"Temporary password: {DEFAULT_VENDOR_PASSWORD}\n"
            f"Portal: {portal_url}\n\n"
            "You must change this password after signing in."
        )
        await mail_service.send_mail(
            db, MailSendIn(to=[address], subject=subject, body=text, html=html), user)
        logger.info("%s credentials emailed to %s", portal_name, address)
        return True
    except Exception as exc:  # credentials already exist; mail is a side effect
        logger.warning("could not email portal credentials for vendor %s: %s",
                       vendor_id, exc)
        return False


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


async def vendor_item_combinations(db: AsyncSession, vendor_id: int,
                                   item_ids: list[int]) -> dict:
    """The ON brand / variant / model combinations of items THIS vendor deals in
    (2026-10-23) — what the portal's quote and despatch-note lines may switch to.

    Only items the vendor is mapped to, has been asked to quote, or has been ordered;
    any other id in the request is dropped, so the portal never lists another
    supplier's catalogue.
    """
    if not item_ids:
        return {}
    wanted = set(item_ids)
    allowed = set((await db.execute(
        select(VendorItem.item_id).where(VendorItem.vendor_id == vendor_id,
                                         VendorItem.item_id.in_(wanted)))).scalars())
    allowed |= set((await db.execute(
        select(POItem.item_id).join(PurchaseOrder, PurchaseOrder.id == POItem.po_id)
        .where(PurchaseOrder.vendor_id == vendor_id, POItem.item_id.in_(wanted))
    )).scalars())
    allowed |= set((await db.execute(
        select(RFQItem.item_id).join(RFQVendor, RFQVendor.rfq_id == RFQItem.rfq_id)
        .where(RFQVendor.vendor_id == vendor_id, RFQItem.item_id.in_(wanted))
    )).scalars())
    rows = await combinations.combination_options(db, sorted(allowed))
    return {str(k): v for k, v in rows.items()}


async def vendor_item_packing(db: AsyncSession, vendor_id: int) -> dict:
    """The pack hierarchies of the items mapped to THIS vendor, every level with its
    size and minimum fill (2026-10-11) — what the portal's Packing tab shows, so a
    supplier knows how each item is to be packed before an order arrives.

    Scoped by the vendor id from the token: only rows of `mst_vendor_items` naming
    this vendor are read, so no supplier ever sees another's items.
    """
    rows = (await db.execute(
        select(VendorItem.item_id, VendorItem.vendor_item_code, Item.code, Item.name,
               Item.uom_code)
        .join(Item, Item.id == VendorItem.item_id)
        .where(VendorItem.vendor_id == vendor_id, Item.is_active.is_(True))
        .order_by(Item.name)
    )).all()
    options = await pack_options(db, {r[0] for r in rows})
    seen: set[int] = set()
    items = []
    for item_id, vendor_code, code, name, uom in rows:
        if item_id in seen:
            continue
        seen.add(item_id)
        hierarchies = [h for h in options.get(item_id, []) if len(h["levels"]) > 1]
        items.append({"item_id": item_id, "item_code": code, "item_name": name,
                      "uom_code": uom, "vendor_item_code": vendor_code,
                      "hierarchies": hierarchies})
    return {"items": items}


def _vendor_visible():
    """The statuses a vendor may see. A DRAFT or PENDING_APPROVAL RFQ is internal —
    the company has not decided to ask them yet."""
    return RFQ.status.in_([RFQStatus.PUBLISHED.value, RFQStatus.CLOSED.value,
                           RFQStatus.AWARDED.value])


async def vendor_list_rfqs(db: AsyncSession, vendor_id: int,
                           params: PageParams, search: str | None = None,
                           status: str | None = None) -> dict:
    # Find all RFQs where this vendor has a quotation with an open change request awaiting supplier response
    pending_cr_rfq_ids = set(
        (await db.execute(
            select(QuoteChangeRequest.rfq_id)
            .join(Quotation, Quotation.id == QuoteChangeRequest.quotation_id)
            .where(
                Quotation.vendor_id == vendor_id,
                QuoteChangeRequest.status == QuoteChangeStatus.AWAITING_SUPPLIER.value
            )
        )).scalars().all()
    )

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
    # Narrowing only: handle CHANGE_PROPOSED / AWAITING_SUPPLIER filter specifically
    if status in ("CHANGE_PROPOSED", "CHANGE_REQUESTED", "AWAITING_SUPPLIER"):
        stmt = stmt.where(RFQ.id.in_(pending_cr_rfq_ids or {0}))
    elif status:
        stmt = stmt.where(RFQ.status == status, _vendor_visible())
    stmt = stmt.order_by(RFQ.created_at.desc())
    
    total = await db.scalar(select(func.count()).select_from(stmt.subquery()))
    result = await db.execute(stmt.offset(params.offset).limit(params.size))
    items = []
    for rfq, vendor_status in result.all():
        if rfq.id in pending_cr_rfq_ids:
            rfq.has_pending_change_request = True
            rfq.vendor_status = "CHANGE_PROPOSED"
        else:
            rfq.has_pending_change_request = False
            rfq.vendor_status = vendor_status
        items.append(rfq)
    return {"items": items, "total": total or 0, "page": params.page, "size": params.size}


async def vendor_get_rfq(db: AsyncSession, vendor_id: int, rfq_id: int) -> RFQ:
    row = (await db.execute(
        select(RFQ, RFQVendor)
        .join(RFQVendor, RFQVendor.rfq_id == RFQ.id)
        .where(RFQ.id == rfq_id, RFQVendor.vendor_id == vendor_id, _vendor_visible())
    )).first()
    # Not "you are not invited": a vendor who guesses ids should not learn which ones
    # exist. Same 404 either way.
    if row is None:
        raise NotFoundError(f"RFQ {rfq_id} not found")
    rfq, invited = row
    allowed = await _vendor_item_scope(
        db, rfq.id, vendor_id, invited.mapped_item_ids)
    visible_items = [line for line in rfq.items if line.item_id in allowed]
    quantities = invited.item_quantities or {}
    for line in visible_items:
        if str(line.item_id) in quantities:
            set_committed_value(line, "quantity", _d(quantities[str(line.item_id)]))
    set_committed_value(rfq, "items", visible_items)
    set_committed_value(rfq, "total_items", len(visible_items))
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
        invited = (await db.execute(select(RFQVendor).where(
            RFQVendor.rfq_id == rfq_id, RFQVendor.vendor_id == vendor_id
        ))).scalar_one_or_none()
        if invited is None:
            raise NotFoundError("No quotation has been opened for you on this RFQ")

        rfq = await db.get(RFQ, rfq_id)
        if rfq is None:
            raise NotFoundError(f"RFQ {rfq_id} not found")

        vendor = await db.get(Vendor, vendor_id)
        now = utcnow()
        quote = Quotation(
            quotation_no=await next_number(db, DocType.QUOTATION.value, project=rfq.project_name),
            rfq_id=rfq.id,
            rfq_no=rfq.rfq_no,
            vendor_id=vendor_id,
            vendor_name=vendor.name if vendor else (invited.vendor_name or f"Vendor {vendor_id}"),
            quotation_date=now.date(),
            status=QuotationStatus.DRAFT.value,
            currency="INR",
        )
        db.add(quote)
        await db.flush()

        mapped_item_ids = invited.mapped_item_ids or [i.item_id for i in rfq.items]
        item_quantities = invited.item_quantities or {}
        for line in rfq.items:
            if line.item_id not in mapped_item_ids:
                continue
            qty = _d(item_quantities.get(str(line.item_id), line.quantity))
            db.add(QuotationItem(
                quotation_id=quote.id,
                line_no=line.line_no,
                rfq_item_id=line.id,
                item_id=line.item_id,
                item_code=line.item_code,
                item_name=line.item_name,
                description=line.description,
                uom_code=line.uom_code,
                quantity=qty,
                requested_quantity=qty,
                **combinations.carry(line),
                rate=0,
                discount_percent=0,
                tax_percent=line.tax_percent or 0,
            ))
        await db.commit()
        await db.refresh(quote)

    invited = (await db.execute(select(RFQVendor).where(
        RFQVendor.rfq_id == rfq_id, RFQVendor.vendor_id == vendor_id
    ))).scalar_one_or_none()
    allowed = await _vendor_item_scope(
        db, rfq_id, vendor_id,
        invited.mapped_item_ids if invited is not None else None)
    _apply_vendor_quote_scope(quote, allowed)
    
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
        if not source:
            source = next((r for r in asked.values() if r.item_id == line.item_id), None)
        req_qty = float(source.quantity if source else line.quantity)
        line.requested_quantity = req_qty
        if quote.status == QuotationStatus.DRAFT.value and (quote.revision_count or 0) == 0:
            line.quantity = req_qty
        line.required_date = source.required_date if source else None
        limits = ceilings.get(line.item_id)
        line.hsn_code = limits["hsn_code"] if limits else None
        # No HSN means no ceiling — the field stays open rather than closing to zero.
        line.max_gst_rate = limits["gst_rate"] if limits else None
    return ceilings


def _checked_gst_percent(incoming, limits: dict | None, label: str) -> float:
    """The GST for one quoted line, capped at the rate its HSN notifies.

    One rate, not a split: the vendor states the GST they are charging and the two
    GSTINs decide whether it is charged as CGST + SGST or as IGST. The ceiling is the
    same figure on either route, so there is nothing to reject on the wrong side.
    """
    whole = float(incoming.tax_percent or 0)
    if limits:
        allowed = limits["gst_rate"]
        if whole > allowed + 1e-9:
            raise ValidationError(
                f"{label}: GST may not exceed {allowed}% — the rate notified for HSN "
                f"{limits['hsn_code']}. Quote at or below it."
            )
    return whole


async def vendor_submit_quotation(db: AsyncSession, vendor_id: int, rfq_id: int,
                                  data: QuoteSubmit) -> Quotation:
    """Save the vendor's offer. Re-submitting before the deadline is allowed and
    bumps `revision_count` — a buyer must be able to see they moved."""
    rfq = await vendor_get_rfq(db, vendor_id, rfq_id)
    if rfq.status != RFQStatus.PUBLISHED.value:
        raise ValidationError("This RFQ is closed and no longer accepts quotations")
    if rfq.due_date and rfq.due_date < utcnow().date():
        raise ValidationError("The submission deadline for this RFQ has passed")
    # Freeze Prices (2026-09-26): the buyer's lock, not the deadline's. A tender
    # can be open past-due (no quotes yet) or frozen early for comparison — both
    # close pricing, and this is the third lock after the status and the date.
    await _assert_rfq_unfrozen(
        rfq, "quoting or re-quoting on this tender")

    # The emailed code, checked BEFORE anything is written. Whoever holds the portal
    # link can reach this endpoint; the code is what proves they are also reading the
    # address the vendor is registered under. Spending it here rather than after the
    # save means a replay cannot ride in behind a submission that failed validation.
    await quote_otp.verify(db, rfq_id, vendor_id, data.otp_code)

    quote = await vendor_get_quotation(db, vendor_id, rfq_id)
    # The same two rules the form was drawn with, enforced here because the form is not
    # the guard: this endpoint is reachable by anyone holding a vendor token.
    ceilings = await _attach_tax_context(db, quote)
    # Whether the supply is within a state or across one decides HOW the rate below is
    # charged (CGST + SGST, or IGST) — not what the rate is, and not what is stored.

    lines_by_rfq_item = {line.rfq_item_id: line for line in quote.items}
    for index, incoming in enumerate(data.lines, start=1):
        line = lines_by_rfq_item.get(incoming.rfq_item_id)
        if line is None:
            raise ValidationError(
                f"Line {incoming.rfq_item_id} is not on this RFQ")
        label = line.item_name or line.item_code or f"line {index}"
        gst = _checked_gst_percent(
            incoming, ceilings.get(line.item_id), label)
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
        # The one rate that is charged, and the one `_quote_totals` reads. It is the
        # vendor's whole GST figure, capped at the HSN above; which half of it applies
        # is a fact about the two GSTINs and never rewrites the number.
        line.tax_percent = _d(gst)
        line.delivery_days = incoming.delivery_days
        # The supplier may offer another brand / variant / model of the item
        # (2026-10-23) — checked against the item's ON combinations.
        if getattr(incoming, "brand_id", None):
            for key, value in (await combinations.resolve(
                    db, line.item_id, incoming, label=label)).items():
                setattr(line, key, value)

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


async def _revert_rejected_amendment(db: AsyncSession, po: PurchaseOrder,
                                     note: str) -> bool:
    """Put an amended order back to the version the supplier had already agreed to.

    An amendment is a question, and no is one of its two answers. Before this, a
    declined revision simply sat there REJECTED: the order on file carried numbers
    nobody had ever agreed to, the version the supplier HAD accepted survived only
    inside a `pro_po_revisions` snapshot, and the buyer's way back was to raise a fresh
    order and leave the receipt history behind on the old one.

    Only a REVISION can be reverted - `revision_no > 0`, with a filed snapshot of the
    revision below it. A first-issue order that is declined is simply declined; there
    is nothing behind it to go back to, so this returns False and the caller records
    the plain rejection it always did.

    NOTHING IS DELETED. `pro_po_revisions` is append-only (rule 9, and the model says
    so): the declined revision is filed like any other BEFORE the older one is put
    back, or a revert would erase the only record of what the supplier was asked.
    That is also why the snapshot to restore is found by `revision_no` and then by
    `id` - one revision number can carry several rows once reverts are in play, and
    the newest of them is the one that describes the order.

    `received_quantity` is the one figure NOT taken from the snapshot: it is what is
    physically on the shelf, `_sync_po_receipt_status` is its writer, and no filed
    snapshot outranks either.
    """
    declined = po.revision_no or 0
    if declined <= 0:
        return False
    previous = (await db.execute(
        select(PORevision)
        .where(PORevision.po_id == po.id, PORevision.revision_no == declined - 1)
        .order_by(PORevision.id.desc()).limit(1)
    )).scalars().first()
    if previous is None or not previous.snapshot:
        return False

    po = (await db.execute(
        select(PurchaseOrder).options(selectinload(PurchaseOrder.items))
        .where(PurchaseOrder.id == po.id)
    )).scalars().first()

    reason = (f"Declined by {po.vendor_name or 'the supplier'} - reverted to revision "
              f"{previous.revision_no}")
    if (note or "").strip():
        reason += f": {note.strip()}"
    db.add(PORevision(
        po_id=po.id, revision_no=declined, reason=reason, status=po.status,
        vendor_status=POVendorStatus.REJECTED.value, snapshot=_po_snapshot(po),
    ))

    snap = previous.snapshot
    po.expected_date = (date.fromisoformat(snap["expected_date"])
                        if snap.get("expected_date") else None)
    for field in ("remarks", "payment_terms", "delivery_terms", "material_terms",
                  "logistics_terms", "billing_address", "shipping_address"):
        setattr(po, field, snap.get(field))
    po.sub_total = _d(snap.get("sub_total", 0))
    po.discount_amount = _d(snap.get("discount_amount", 0))
    po.tax_amount = _d(snap.get("tax_amount", 0))
    po.freight_amount = _d(snap.get("freight_amount", 0))
    po.total_amount = _d(snap.get("total_amount", 0))

    # Lines are matched on the ITEM, because that is all a snapshot carries - and as a
    # LIST per item, since one order may legitimately name the same item twice and a
    # plain dict would drop one of them.
    wanted: dict[int, list[dict]] = {}
    for row in snap.get("items", []):
        wanted.setdefault(row["item_id"], []).append(row)
    for line in list(po.items):
        rows = wanted.get(line.item_id) or []
        if rows:
            row = rows.pop(0)
            line.quantity = _d(row.get("quantity", 0))
            line.rate = _d(row.get("rate", 0))
            line.tax_percent = _d(row.get("tax_percent", 0))
            line.amount = _d(row.get("amount", 0))
            if "pack_breakdown" in row:
                line.pack_hierarchy_id = row.get("pack_hierarchy_id")
                line.pack_breakdown = row.get("pack_breakdown")
        else:
            # Added by the amendment the supplier has just refused. It can only be a
            # line nothing has been received against: amendment is closed once the
            # vendor has despatched, and an order back at DRAFT cannot be received.
            await db.delete(line)
    for rows in wanted.values():
        for row in rows:
            db.add(POItem(
                po_id=po.id, item_id=row["item_id"], item_code=row.get("item_code"),
                item_name=row.get("item_name"), uom_code=row.get("uom_code"),
                quantity=_d(row.get("quantity", 0)), rate=_d(row.get("rate", 0)),
                tax_percent=_d(row.get("tax_percent", 0)),
                amount=_d(row.get("amount", 0)),
                received_quantity=_d(row.get("received_quantity", 0)),
                pack_hierarchy_id=row.get("pack_hierarchy_id"),
                pack_breakdown=row.get("pack_breakdown"),
                **combinations.carry(row),
            ))
    await db.flush()
    await po_packing.sync_po_packing(db, po.id)

    # Standing where it stood, including the supplier's own yes - which the amendment
    # cleared and which this puts back. No workflow is started: the agreement being
    # restored was approved once already, and re-approving an unchanged order would
    # put a decision nobody took into somebody's queue.
    po.revision_no = previous.revision_no
    po.status = previous.status or POStatus.ACCEPTED_BY_SUPPLIER.value
    po.vendor_status = previous.vendor_status
    po.vendor_responded_at = utcnow() if previous.vendor_status else None
    po.vendor_response_note = None
    po.amended_at = utcnow()
    po.amendment_reason = None

    body = f"{po.vendor_name or 'The supplier'} declined revision {declined}"
    if (note or "").strip():
        body += f": {note.strip()}"
    body += f". The order is back to revision {po.revision_no}."
    await notifications.notify(
        db, [po.created_by_id], title=f"{po.po_no} - amendment declined", body=body,
        entity_type="PO", entity_id=po.id, deep_link=f"/procurement/pos/{po.id}")
    logger.info("%s revision %s declined by vendor; reverted to revision %s",
                po.po_no, declined, po.revision_no)
    return True


async def vendor_respond_to_po(db: AsyncSession, vendor_id: int, po_id: int,
                               accept: bool, note: str = "") -> PurchaseOrder:
    """The vendor's answer to an order: yes, or no with a reason.

    Yes means yes TO THIS ORDER. It took a list of rates once, so a supplier could
    accept at their own prices and the order went back up our own ladder carrying
    them; that is a counter-offer, not an acceptance, and it is gone. A price that has
    to move is the buyer amending the order - their decision, with a reason on it, and
    approved before it reaches the supplier.

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

    if not accept and await _revert_rejected_amendment(db, po, note):
        # The order went back to the revision they had already accepted, and that
        # revision's own answer went back with it - so the REJECTED stamp below, which
        # describes a version that is no longer the order, is deliberately not applied.
        await db.commit()
        await db.refresh(po)
        logger.info("%s amendment declined by vendor %s", po.po_no, vendor_id)
        return po

    po.vendor_status = (POVendorStatus.ACCEPTED.value if accept
                        else POVendorStatus.REJECTED.value)
    po.vendor_responded_at = utcnow()
    po.vendor_response_note = (note or "").strip() or None

    if accept:
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
    options = await pack_options(db, {line.item_id for line in po.items})

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
            pack_hierarchy_id=line.pack_hierarchy_id,
            pack_breakdown=line.pack_breakdown,
            pack_options=options.get(line.item_id, []),
            **combinations.carry(line),
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

    # A line stated in packs carries its own total; work it out before the ceiling
    # check below, so "1 Carton" is capped exactly as "1,200 TAB" would be.
    for line in data.lines:
        po_line = po_items.get(line.po_item_id)
        if line.pack_breakdown and po_line is not None:
            _hid, packed = await packs.snapshot(
                db, item_id=po_line.item_id,
                hierarchy_id=line.pack_hierarchy_id or po_line.pack_hierarchy_id,
                entries=[e.model_dump() for e in line.pack_breakdown])
            line.despatched_qty = float(base_of_packs(packed))
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

    # REQ_111 — one PO line may be sent in several batches, one note line per batch.
    # The ceiling is therefore checked on the SUM of this note's lines per PO line:
    # two batches each under the remainder can still add up to more than is owed.
    claimed: dict[int, Decimal] = {}
    for line in lines:
        po_line = po_items.get(line.po_item_id)
        if po_line is None:
            raise ValidationError(f"Line {line.po_item_id} is not on {po.po_no}")
        pending = _d(po_line.quantity) - already.get(line.po_item_id, Decimal(0))
        claimed[line.po_item_id] = claimed.get(line.po_item_id, Decimal(0)) \
            + _d(line.despatched_qty)
        if claimed[line.po_item_id] > pending:
            raise ValidationError(
                f"{po_line.item_code or po_line.item_name}: {claimed[line.po_item_id]} "
                f"across its batches exceeds the {pending} still owed on {po.po_no}")
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
        note_line = DespatchNoteItem(
            despatch_note_id=note.id, line_no=index,
            po_item_id=line.po_item_id, item_id=po_line.item_id,
            item_code=po_line.item_code, item_name=po_line.item_name,
            uom_code=po_line.uom_code,
            despatched_qty=_d(line.despatched_qty),
            batch_no=line.batch_no, mfg_date=line.mfg_date,
            expiry_date=line.expiry_date, remarks=line.remarks,
            # What was ordered, unless the supplier says they are sending another
            # brand / variant / model of the item (2026-10-23) — checked against the
            # item's ON combinations; the receipt then books what actually came.
            **(await combinations.resolve(db, po_line.item_id, line,
                                          label=po_line.item_code or "A line")
               if getattr(line, "brand_id", None) else combinations.carry(po_line)),
        )
        # How it is packed; a hierarchy other than the order's goes to the buyer.
        await po_packing.stamp_despatch_line(
            db, note_line, po_line, hierarchy_id=line.pack_hierarchy_id,
            entries=line.pack_breakdown, reason=line.pack_change_reason)
        db.add(note_line)

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

    # The invoice and the delivery challan must be ON FILE, not just quoted: accounts
    # pays against the invoice and the gate checks the vehicle against the DC. They
    # are filed per order (po_documents), so the order must hold at least one of each.
    from app.modules.procurement.po_documents import list_po_documents
    filed = {(a.doc_category or "").upper()
             for a in await list_po_documents(db, note.po_id)}
    missing = [label for code, label in (("INVOICE", "invoice"),
                                         ("DC", "delivery challan (DC)"))
               if code not in filed]
    if missing:
        raise ValidationError(
            f"Upload the {' and the '.join(missing)} under Invoices & delivery "
            "challans before submitting this dispatch note.")

    note.status = DespatchNoteStatus.SUBMITTED.value
    note.submitted_at = utcnow()
    # A changed packing is never silent: the buyer is told the moment the note is
    # filed, which is when the goods are actually on their way.
    po = await db.get(PurchaseOrder, note.po_id)
    if po is not None:
        await po_packing.notify_buyer_of_changes(db, note, po)
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


# =========================================================================== #
#  Supplier changes of packing — see `procurement/packing.py`
# =========================================================================== #

async def list_po_pack_changes(db: AsyncSession, po_id: int, user) -> list[dict]:
    await get_po(db, po_id, user, include_approver=True)   # the scope check
    return await po_packing.list_pack_changes(db, po_id)


async def decide_po_pack_change(db: AsyncSession, po_id: int, line_id: int,
                                accept: bool, data, user) -> dict:
    await get_po(db, po_id, user)                          # the raiser's scope
    return await po_packing.decide_pack_change(db, po_id, line_id, accept=accept,
                                               note=data.note, user=user)


async def repack_po_line(db: AsyncSession, po_id: int, line_id: int, data, user):
    """See `procurement/packing.repack_po_line`. Scoped like every PO edit."""
    po = await get_po(db, po_id, user)
    line = next((row for row in po.items if row.id == line_id), None)
    if line is None:
        raise NotFoundError("That line is not on this order.")
    await po_packing.repack_po_line(
        db, po, line, hierarchy_id=data.pack_hierarchy_id, entries=data.pack_breakdown,
        user=user, closed_statuses=_UNAMENDABLE,
        despatched_no=await _vendor_has_dispatched(db, po.id))
    sub_total = tax_total = Decimal("0")
    for row in po.items:
        amount = _d(row.amount)
        sub_total += amount
        tax_total += amount * _d(row.tax_percent or 0) / _d(100)
    _apply_po_totals(po, sub_total, tax_total)
    await db.commit()
    return await get_po_detail(db, po.id, user)
