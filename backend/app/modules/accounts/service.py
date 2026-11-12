"""Accounts — what each purchase order owes its vendor, and the payments against it.

The flow (2026-10-06):

  PO team picks a payment term on the PO  ->  its milestones are frozen on the order
  ->  the order is approved  ->  it appears on the accounts desk, milestone by milestone
  ->  accounts records a payment against one milestone (amount, date, mode, UTR)
  ->  VENDOR_PAYMENT ladder (Settings > Approvals Config, per project)
  ->  on the final approval the payment is PAID and the milestone reads it at once,
      on this desk and on the PO itself.

What is owed is READ, never stored: a milestone is `percent x total_amount`, less what
was paid. A pending payment still holds its amount, so two people cannot each record
the whole balance. With no ladder configured, one holder of `accounts.approve` who is
not the person who recorded it signs it — the same rule as the stock audit.

Chain position: last (after returns). It reads procurement, warehouse and logistics
tables and nothing reads it back except the approvals dispatcher, which imports it
lazily like every other module it dispatches to.
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, PermissionError_, ValidationError
from app.core.pagination import PageParams
from app.modules.accounts.models import VendorPayment
from app.modules.logistics.models import TransportRequest
from app.modules.procurement import po_documents
from app.modules.procurement.models import POPaymentMilestone, PurchaseOrder
from app.platform.rbac import permissions as perms
from app.platform.rbac.service import get_user_permissions
from app.platform.settings import attachments
from app.platform.settings.models import Attachment
from app.platform.settings.service import write_audit
from app.platform.workflow import engine
from app.platform.workflow import ladder as wf_ladder
from app.platform.workflow.models import Instance
from app.shared.enums import (
    PAYMENT_MILESTONE_META, ApprovalAction, AuditAction, DocType, InstanceStatus,
    PaymentMilestoneStage, PaymentMode, POStatus, VendorDocCategory, VendorPaymentStatus,
)
from app.shared.models.base import utcnow
from app.shared.numbering import next_number
from app.shared.time import today as ist_today

DOC = DocType.VENDOR_PAYMENT.value
_CENT = Decimal("0.01")
_META = {m["value"]: m for m in PAYMENT_MILESTONE_META}

#: An order is payable once it is approved. Before that its value can still change
#: and its terms can still be swapped.
PAYABLE_PO_STATUSES = (
    POStatus.APPROVED.value, POStatus.SENT_TO_VENDOR.value,
    POStatus.ACCEPTED_BY_SUPPLIER.value, POStatus.PARTIALLY_RECEIVED.value,
    POStatus.RECEIVED.value, POStatus.CLOSED.value,
)
_DELIVERED = (POStatus.PARTIALLY_RECEIVED.value, POStatus.RECEIVED.value,
              POStatus.CLOSED.value)
_HELD = (VendorPaymentStatus.PAID.value, VendorPaymentStatus.PENDING_APPROVAL.value)
#: The payer's own proof — bank advice, UTR screenshot, cheque scan — filed against the
#: payment in the platform's attachment store, never against the order.
PROOF_ENTITY = "VENDOR_PAYMENT"
PROOF_CATEGORY = "PAYMENT_PROOF"


def _d(value) -> Decimal:
    return Decimal(str(value or 0)).quantize(_CENT, rounding=ROUND_HALF_UP)


# --------------------------------------------------------------------------- #
# The arithmetic — pure, so it is tested without a database
# --------------------------------------------------------------------------- #

def split_amounts(total, percents: list) -> list[Decimal]:
    """Each milestone's share of the order value, in rupees. The LAST takes the
    rounding remainder, so the shares always add up to the order total exactly."""
    total = _d(total)
    shares = [_d(total * Decimal(str(p)) / 100) for p in percents]
    if shares and sum(Decimal(str(p)) for p in percents) == 100:
        shares[-1] = total - sum(shares[:-1])
    return shares


def milestone_state(amount: Decimal, paid: Decimal, trigger_met: bool | None,
                    due_date: date | None, today: date) -> str:
    if amount > 0 and paid >= amount:
        return "PAID"
    if paid > 0:
        return "PART_PAID"
    if trigger_met is None:
        return "CONFIRM"
    if not trigger_met:
        return "NOT_DUE"
    if due_date is not None and today > due_date:
        return "OVERDUE"
    return "DUE"


# --------------------------------------------------------------------------- #
# Reads
# --------------------------------------------------------------------------- #

async def _payment_sums(db: AsyncSession, po_ids: list[int]) -> dict:
    """{milestone_id: (paid, pending)} for these orders."""
    if not po_ids:
        return {}
    rows = (await db.execute(
        select(VendorPayment.milestone_id, VendorPayment.status,
               func.sum(VendorPayment.amount))
        .where(VendorPayment.po_id.in_(po_ids), VendorPayment.status.in_(_HELD))
        .group_by(VendorPayment.milestone_id, VendorPayment.status))).all()
    out: dict[int, list[Decimal]] = {}
    for mid, status, amount in rows:
        slot = out.setdefault(mid, [Decimal(0), Decimal(0)])
        slot[0 if status == VendorPaymentStatus.PAID.value else 1] += _d(amount)
    return out


async def _delivery_dates(db: AsyncSession, po_ids: list[int]) -> dict[int, date]:
    """The first goods receipt against each order — when "against delivery" starts."""
    if not po_ids:
        return {}
    from app.modules.warehouse.models import Receipt
    from app.modules.warehouse.service import RECEIVED_RECEIPT_STATUSES
    rows = (await db.execute(
        select(Receipt.po_id, func.min(Receipt.grn_date))
        .where(Receipt.po_id.in_(po_ids), Receipt.status.in_(RECEIVED_RECEIPT_STATUSES))
        .group_by(Receipt.po_id))).all()
    return {po_id: first for po_id, first in rows if first}


def _milestones(po: PurchaseOrder, sums: dict, delivered_on: date | None,
                today: date) -> list[dict]:
    rows = list(po.payment_milestones or [])
    amounts = split_amounts(po.total_amount, [r.percent for r in rows])
    approved_on = po.approved_at.date() if po.approved_at else None
    per_stage: dict[str, int] = {}
    for row in rows:
        per_stage[row.stage] = per_stage.get(row.stage, 0) + 1
    nth: dict[str, int] = {}
    out = []
    for row, amount in zip(rows, amounts):
        meta = dict(_META.get(row.stage, {"label": row.stage, "trigger": "",
                                          "short": row.stage[:3]}))
        # Every milestone carries a code -- ADV 1/1, DLV 2/4 -- so a payment, a
        # remittance advice and the printed order can all name the same instalment.
        nth[row.stage] = nth.get(row.stage, 0) + 1
        code = f"{meta['short']} {nth[row.stage]}/{per_stage[row.stage]}"
        if per_stage[row.stage] > 1:
            # Instalments of one stage (50% against delivery in 30/60/90 days).
            meta["label"] = (f"{meta['label']} — instalment {nth[row.stage]} of "
                             f"{per_stage[row.stage]}")
        paid, pending = sums.get(row.id, (Decimal(0), Decimal(0)))
        if row.stage == PaymentMilestoneStage.ADVANCE.value:
            trigger_met, start = po.status in PAYABLE_PO_STATUSES, approved_on
        elif row.stage == PaymentMilestoneStage.AGAINST_DELIVERY.value:
            trigger_met = po.status in _DELIVERED or delivered_on is not None
            start = delivered_on
        else:
            # Commissioning and the end of a warranty are not events the system sees.
            trigger_met, start = None, None
        due = start + timedelta(days=row.due_days or 0) if start else None
        out.append({
            "id": row.id, "seq": row.seq, "stage": row.stage, "code": code,
            "label": meta["label"],
            "trigger": meta["trigger"], "percent": float(row.percent),
            "due_days": row.due_days or 0, "amount": float(amount),
            "paid": float(paid), "pending": float(pending),
            "balance": float(max(amount - paid - pending, Decimal(0))),
            "trigger_met": trigger_met, "due_date": due,
            "state": milestone_state(amount, paid, trigger_met, due, today),
        })
    return out


async def _load_po(db: AsyncSession, po_id: int, *, lock: bool = False) -> PurchaseOrder:
    stmt = select(PurchaseOrder).where(PurchaseOrder.id == po_id)
    if lock:
        stmt = stmt.with_for_update()
    po = (await db.execute(stmt)).scalars().first()
    if po is None:
        raise NotFoundError(f"Purchase order {po_id} not found")
    return po


async def _can_act(db: AsyncSession, payment: VendorPayment, user,
                   granted: set | None = None) -> bool:
    if user is None or payment.status != VendorPaymentStatus.PENDING_APPROVAL.value:
        return False
    from app.platform.workflow.engine import is_workflow_admin
    if await is_workflow_admin(db, user):
        return True
    instance = await _instance(db, payment.id)
    if instance is not None and instance.status == InstanceStatus.IN_PROGRESS.value:
        return await engine.can_act_now(db, DOC, payment.id, user)
    if getattr(user, "id", None) == payment.created_by_id:
        return False
    if granted is None:
        granted = await get_user_permissions(db, user, getattr(user, "active_position_id", None))
    return perms.ACCOUNTS_APPROVE in granted


async def _proofs(db: AsyncSession, payment_ids: list[int]) -> dict[int, list]:
    """{payment_id: [Attachment]}, newest first, in one read for a whole page."""
    if not payment_ids:
        return {}
    rows = (await db.execute(
        select(Attachment)
        .where(Attachment.entity_type == PROOF_ENTITY,
               Attachment.entity_id.in_(payment_ids))
        .order_by(Attachment.id.desc()))).scalars().all()
    out: dict[int, list] = {}
    for row in rows:
        out.setdefault(int(row.entity_id), []).append(row)
    return out


def _payment_out(p: VendorPayment, can_act: bool = False, proofs: list | None = None) -> dict:
    approver = p.current_approver_name
    if p.status == VendorPaymentStatus.PENDING_APPROVAL.value and not approver:
        # No ladder: any holder of accounts.approve except the person who recorded it.
        approver = (f"any payment approver other than {p.created_by_name}"
                    if p.created_by_name else "any payment approver")
    return {**{c.name: getattr(p, c.name) for c in VendorPayment.__table__.columns},
            "amount": float(p.amount or 0),
            "stage_label": _META.get(p.stage, {}).get("label", p.stage),
            "current_approver_name": approver,
            "proofs": proofs or [],
            "can_act": can_act}


async def po_payments(db: AsyncSession, po_id: int, user=None) -> dict:
    """One order's money: milestones with what is due, payments, and the supplier's
    invoices and challans. Read by the accounts desk and by the PO screen."""
    po = await _load_po(db, po_id)
    sums = await _payment_sums(db, [po.id])
    delivered = (await _delivery_dates(db, [po.id])).get(po.id)
    milestones = _milestones(po, sums, delivered, ist_today())
    payments = list((await db.execute(
        select(VendorPayment).where(VendorPayment.po_id == po.id)
        .order_by(VendorPayment.id.desc()))).scalars().all())
    granted = (await get_user_permissions(db, user, getattr(user, "active_position_id", None))
               if user is not None else set())
    proofs = await _proofs(db, [p.id for p in payments])
    paid = sum(Decimal(str(m["paid"])) for m in milestones)
    pending = sum(Decimal(str(m["pending"])) for m in milestones)
    return {
        "po_id": po.id, "po_no": po.po_no, "po_status": po.status,
        "vendor_id": po.vendor_id, "vendor_name": po.vendor_name,
        "project_name": po.project_name, "po_date": po.po_date,
        # Whose paper a payment against it is on (2026-11-12): copied from the order,
        # shown locked on the Record payment card. Null on an older order.
        "project_id": po.project_id,
        "organization_id": po.organization_id, "organization_name": po.organization_name,
        "org_department_id": po.org_department_id,
        "org_department_name": po.org_department_name,
        "approved_at": po.approved_at, "payment_terms": po.payment_terms,
        "total_amount": float(po.total_amount or 0),
        "paid": float(paid), "pending": float(pending),
        "outstanding": float(max(_d(po.total_amount) - paid, Decimal(0))),
        "milestones": milestones,
        "payments": [_payment_out(p, await _can_act(db, p, user, granted), proofs.get(p.id))
                     for p in payments],
        "documents": await po_documents.list_po_documents(db, po.id),
    }


async def po_payments_for_buyer(db: AsyncSession, po_id: int, user) -> dict:
    """The PO desk's read: the order's own visibility rule first, then the same answer."""
    from app.modules.procurement.service import get_po_detail
    await get_po_detail(db, po_id, user=user)
    return await po_payments(db, po_id, user)


async def list_payables(db: AsyncSession, params: PageParams, *, tab: str = "open",
                        search: str | None = None, vendor_id: int | None = None,
                        project_id: int | None = None) -> dict:
    """Approved orders that carry payment terms, with what is paid and outstanding.

    `tab`: open (anything left to pay), paid (settled), all. Ordered by PO id, newest
    first — an indexed key, so the page never needs a filesort."""
    paid_col = func.coalesce(func.sum(case(
        (VendorPayment.status == VendorPaymentStatus.PAID.value, VendorPayment.amount),
        else_=0)), 0)
    pending_col = func.coalesce(func.sum(case(
        (VendorPayment.status == VendorPaymentStatus.PENDING_APPROVAL.value,
         VendorPayment.amount), else_=0)), 0)
    sums = (select(VendorPayment.po_id.label("po_id"), paid_col.label("paid"),
                   pending_col.label("pending"))
            .group_by(VendorPayment.po_id).subquery())
    paid = func.coalesce(sums.c.paid, 0)
    stmt = (select(PurchaseOrder, paid, func.coalesce(sums.c.pending, 0))
            .outerjoin(sums, sums.c.po_id == PurchaseOrder.id)
            .where(PurchaseOrder.status.in_(PAYABLE_PO_STATUSES),
                   select(POPaymentMilestone.id)
                   .where(POPaymentMilestone.po_id == PurchaseOrder.id).exists()))
    if tab == "open":
        stmt = stmt.where(PurchaseOrder.total_amount - paid > Decimal("0.005"))
    elif tab == "paid":
        stmt = stmt.where(PurchaseOrder.total_amount - paid <= Decimal("0.005"))
    if search:
        like = f"%{search.strip()}%"
        stmt = stmt.where(or_(PurchaseOrder.po_no.like(like),
                              PurchaseOrder.vendor_name.like(like)))
    if vendor_id:
        stmt = stmt.where(PurchaseOrder.vendor_id == vendor_id)
    if project_id:
        stmt = stmt.where(PurchaseOrder.project_id == project_id)

    total = await db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = (await db.execute(stmt.order_by(PurchaseOrder.id.desc())
                             .offset(params.offset).limit(params.size))).all()
    pos = [r[0] for r in rows]
    ids = [p.id for p in pos]
    msums = await _payment_sums(db, ids)
    delivered = await _delivery_dates(db, ids)
    invoices = dict((await db.execute(
        select(Attachment.entity_id, func.count())
        .where(Attachment.entity_type == po_documents.PO_ATTACHMENT_ENTITY,
               Attachment.entity_id.in_(ids),
               Attachment.doc_category == VendorDocCategory.INVOICE.value)
        .group_by(Attachment.entity_id))).all()) if ids else {}
    today = ist_today()
    items = []
    for po, paid_amt, pending_amt in rows:
        stages = _milestones(po, msums, delivered.get(po.id), today)
        nxt = next((m for m in stages if m["state"] != "PAID"), None)
        items.append({
            "po_id": po.id, "po_no": po.po_no, "po_status": po.status,
            "vendor_name": po.vendor_name, "project_name": po.project_name,
            "po_date": po.po_date, "payment_terms": po.payment_terms,
            "total_amount": float(po.total_amount or 0),
            "paid": float(paid_amt or 0), "pending": float(pending_amt or 0),
            "outstanding": float(max(_d(po.total_amount) - _d(paid_amt), Decimal(0))),
            "invoices": invoices.get(po.id, 0),
            "next_stage": nxt["label"] if nxt else None,
            "next_due_date": nxt["due_date"] if nxt else None,
            "next_state": nxt["state"] if nxt else None,
        })
    return {"items": items, "total": total or 0, "page": params.page, "size": params.size}


async def list_payments(db: AsyncSession, params: PageParams, user, *,
                        status: str | None = None, search: str | None = None,
                        po_id: int | None = None) -> dict:
    stmt = select(VendorPayment)
    if status:
        stmt = stmt.where(VendorPayment.status == status)
    if po_id:
        stmt = stmt.where(VendorPayment.po_id == po_id)
    if search:
        like = f"%{search.strip()}%"
        stmt = stmt.where(or_(VendorPayment.payment_no.like(like),
                              VendorPayment.po_no.like(like),
                              VendorPayment.vendor_name.like(like),
                              VendorPayment.reference_no.like(like)))
    total = await db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = (await db.execute(stmt.order_by(VendorPayment.id.desc())
                             .offset(params.offset).limit(params.size))).scalars().all()
    granted = await get_user_permissions(db, user, getattr(user, "active_position_id", None))
    proofs = await _proofs(db, [p.id for p in rows])
    return {"items": [_payment_out(p, await _can_act(db, p, user, granted), proofs.get(p.id))
                      for p in rows],
            "total": total or 0, "page": params.page, "size": params.size}


async def get_payment(db: AsyncSession, payment_id: int, user) -> dict:
    payment = await db.get(VendorPayment, payment_id)
    if payment is None:
        raise NotFoundError(f"Payment {payment_id} not found")
    proofs = await _proofs(db, [payment.id])
    return _payment_out(payment, await _can_act(db, payment, user), proofs.get(payment.id))


async def add_payment_proof(db: AsyncSession, payment_id: int, upload, user) -> dict:
    """Attach the bank advice / UTR screenshot / cheque scan. Several are allowed; a
    rejected payment is closed and takes none."""
    payment = await db.get(VendorPayment, payment_id)
    if payment is None:
        raise NotFoundError(f"Payment {payment_id} not found")
    if payment.status == VendorPaymentStatus.REJECTED.value:
        raise ValidationError(f"{payment.payment_no} was rejected; record a new payment instead.")
    await attachments.add_attachment(db, entity_type=PROOF_ENTITY, entity_id=payment.id,
                                     upload=upload, doc_category=PROOF_CATEGORY, user=user)
    return await get_payment(db, payment.id, user)


async def payment_proof_file(db: AsyncSession, payment_id: int, attachment_id: int):
    await attachments.require_attachment(db, attachment_id, entity_type=PROOF_ENTITY,
                                         entity_id=payment_id)
    return await attachments.attachment_file(db, attachment_id)


async def payment_proof_file_for_buyer(db: AsyncSession, po_id: int, payment_id: int,
                                       attachment_id: int, user):
    """The PO desk's download: the order's visibility rule, then the payment must be
    one of THIS order's."""
    from app.modules.procurement.service import get_po_detail
    await get_po_detail(db, po_id, user=user)
    payment = await db.get(VendorPayment, payment_id)
    if payment is None or payment.po_id != po_id:
        raise NotFoundError(f"Payment {payment_id} not found")
    return await payment_proof_file(db, payment_id, attachment_id)


async def list_carrier_invoices(db: AsyncSession, params: PageParams,
                                search: str | None = None) -> dict:
    """Freight invoices carriers filed from their portal, newest first."""
    stmt = (select(Attachment, TransportRequest)
            .join(TransportRequest, and_(
                Attachment.entity_type == "TRANSPORT_REQUEST",
                Attachment.entity_id == TransportRequest.id))
            .where(Attachment.doc_category == VendorDocCategory.INVOICE.value))
    if search:
        like = f"%{search.strip()}%"
        stmt = stmt.where(or_(TransportRequest.tr_no.like(like),
                              TransportRequest.carrier_name.like(like)))
    total = await db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = (await db.execute(stmt.order_by(Attachment.id.desc())
                             .offset(params.offset).limit(params.size))).all()
    return {"items": [{
        "attachment_id": a.id, "tr_id": tr.id, "tr_no": tr.tr_no, "tr_status": tr.status,
        "carrier_name": tr.carrier_name,
        "freight_amount": float(tr.freight_amount) if tr.freight_amount is not None else None,
        "file_name": a.file_name, "uploaded_at": a.created_at,
    } for a, tr in rows], "total": total or 0, "page": params.page, "size": params.size}


async def carrier_invoice_file(db: AsyncSession, tr_id: int, attachment_id: int):
    from app.modules.logistics import carrier_invoices
    return await carrier_invoices.invoice_file(db, tr_id, attachment_id)


async def po_document_file(db: AsyncSession, po_id: int, attachment_id: int):
    return await po_documents.po_document_file(db, po_id, attachment_id)


# --------------------------------------------------------------------------- #
# Record, decide
# --------------------------------------------------------------------------- #

async def _instance(db: AsyncSession, payment_id: int):
    return (await db.execute(
        select(Instance).where(Instance.doc_type == DOC, Instance.doc_id == payment_id)
        .order_by(Instance.id.desc()))).scalars().first()


def _mark_paid(payment: VendorPayment, user) -> None:
    payment.status = VendorPaymentStatus.PAID.value
    payment.approved_by_id = getattr(user, "id", None)
    payment.approved_by_name = getattr(user, "full_name", None)
    payment.approved_at = utcnow()
    payment.current_approver_name = None


async def record_payment(db: AsyncSession, data, user) -> dict:
    mode = (data.mode or "").strip().upper()
    if mode not in {m.value for m in PaymentMode}:
        raise ValidationError(f"Payment mode {data.mode!r} is not one of "
                              + ", ".join(m.value for m in PaymentMode))
    if mode != PaymentMode.CASH.value and not (data.reference_no or "").strip():
        raise ValidationError("Enter the UTR / cheque / transaction reference.")
    if data.paid_on > ist_today():
        raise ValidationError("The payment date cannot be in the future.")

    # Locked, so two people recording against the same order queue behind each other
    # and the second one sees the first one's amount held.
    po = await _load_po(db, data.po_id, lock=True)
    if po.status not in PAYABLE_PO_STATUSES:
        raise ValidationError(f"{po.po_no} is {po.status}; only an approved order can be paid.")
    milestone = next((m for m in po.payment_milestones if m.id == data.milestone_id), None)
    if milestone is None:
        raise ValidationError("That milestone is not on this order's payment terms.")
    if data.invoice_attachment_id:
        await po_documents.po_document_file(db, po.id, data.invoice_attachment_id)

    sums = await _payment_sums(db, [po.id])
    stage = next(m for m in _milestones(po, sums, None, ist_today())
                 if m["id"] == milestone.id)
    amount = _d(data.amount)
    if amount > _d(stage["balance"]):
        raise ValidationError(
            f"{stage['label']} on {po.po_no} has ₹{stage['balance']:,.2f} left to pay "
            f"(₹{stage['amount']:,.2f} due, ₹{stage['paid']:,.2f} paid, "
            f"₹{stage['pending']:,.2f} awaiting approval).")

    # Whose paper it is on (2026-11-12): COPIED from the order when the order carries an
    # organisation — the money is the PO's — else selected on the number card.
    from app.platform.doc_numbering import scope as org_scope
    scope_values, scope_args = await org_scope.carry_or_select(db, data, po)

    payment = VendorPayment(
        payment_no=await next_number(db, "vendor_payment", **(scope_args or {})),
        po_id=po.id, po_no=po.po_no, milestone_id=milestone.id, stage=milestone.stage,
        vendor_id=po.vendor_id, vendor_name=po.vendor_name, project_id=po.project_id,
        amount=amount, paid_on=data.paid_on, mode=mode,
        reference_no=(data.reference_no or "").strip() or None,
        invoice_attachment_id=data.invoice_attachment_id,
        remarks=(data.remarks or "").strip() or None,
        status=VendorPaymentStatus.PENDING_APPROVAL.value,
        created_by_id=getattr(user, "id", None),
        created_by_name=getattr(user, "full_name", None),
    )
    if scope_values:
        org_scope.stamp_with_project(payment, scope_values)
    else:
        payment.project_name = getattr(po, "project_name", None)
    db.add(payment)
    await db.flush()

    outcome = "for approval"
    position_id = getattr(user, "active_position_id", None)
    raiser_role = await wf_ladder.role_of_position(db, position_id)
    if await wf_ladder.find_ladder(db, po.project_id, DOC, raiser_role) is not None:
        instance = await engine.start(db, DOC, payment.id, {
            "doc_no": payment.payment_no,
            "doc_summary": f"Payment ₹{amount:,.2f} to {po.vendor_name} — "
                           f"{stage['label']} on {po.po_no}",
            "requester_position_id": position_id,
            "project_id": po.project_id,
            "total_amount": float(amount),
        }, user)
        if instance.status == InstanceStatus.APPROVED.value:
            _mark_paid(payment, user)
            outcome = "and approved by its chain"
        else:
            payment.current_approver_name = await engine.current_approver_label(
                db, DOC, payment.id)

    await write_audit(
        db, entity="acc_vendor_payments", entity_id=payment.id,
        entity_no=payment.payment_no, action=AuditAction.CREATE, actor=user,
        after={"po_no": po.po_no, "stage": milestone.stage, "amount": float(amount),
               "status": payment.status},
        summary=f"Payment {payment.payment_no} recorded {outcome}")
    await db.commit()
    return await get_payment(db, payment.id, user)


async def act_on_payment(db: AsyncSession, payment_id: int, action: str, user,
                         remarks: str | None = None) -> dict:
    action = (action or "").upper()
    if action in (ApprovalAction.APPROVED.value, "APPROVE"):
        action = "APPROVE"
    elif action in (ApprovalAction.REJECTED.value, "REJECT"):
        action = "REJECT"
    else:
        raise ValidationError(f"Invalid action {action}")
    payment = (await db.execute(select(VendorPayment).where(
        VendorPayment.id == payment_id).with_for_update())).scalars().first()
    if payment is None:
        raise NotFoundError(f"Payment {payment_id} not found")
    if payment.status != VendorPaymentStatus.PENDING_APPROVAL.value:
        raise ValidationError(f"{payment.payment_no} is {payment.status}; it cannot change.")
    if action == "REJECT" and not (remarks or "").strip():
        raise ValidationError("Say why the payment is rejected.")

    before = {"status": payment.status}
    instance = await _instance(db, payment.id)
    if instance is not None and instance.status == InstanceStatus.IN_PROGRESS.value:
        instance = await engine.act(
            db, DOC, payment.id,
            ApprovalAction.APPROVED.value if action == "APPROVE"
            else ApprovalAction.REJECTED.value,
            user, remarks or "", {"doc_no": payment.payment_no})
        if instance.status == InstanceStatus.APPROVED.value:
            _mark_paid(payment, user)
        elif instance.status == InstanceStatus.REJECTED.value:
            payment.status = VendorPaymentStatus.REJECTED.value
            payment.current_approver_name = None
        else:
            payment.current_approver_name = await engine.current_approver_label(
                db, DOC, payment.id)
    else:
        from app.platform.workflow.engine import is_workflow_admin
        is_admin = await is_workflow_admin(db, user)
        if not is_admin and getattr(user, "id", None) == payment.created_by_id:
            raise PermissionError_(
                "You recorded this payment, so you cannot approve or reject it. "
                "Ask another holder of payment approval to action it.")
        granted = await get_user_permissions(db, user, getattr(user, "active_position_id", None))
        if not is_admin and perms.ACCOUNTS_APPROVE not in granted:
            raise PermissionError_("You cannot approve vendor payments.")
        if action == "APPROVE":
            _mark_paid(payment, user)
        else:
            payment.status = VendorPaymentStatus.REJECTED.value

    if payment.status == VendorPaymentStatus.REJECTED.value and remarks:
        who = getattr(user, "full_name", None) or "approver"
        note = f"[Rejected by {who}] {remarks}"
        payment.remarks = f"{payment.remarks}\n{note}" if payment.remarks else note

    await write_audit(
        db, entity="acc_vendor_payments", entity_id=payment.id,
        entity_no=payment.payment_no, action=AuditAction.UPDATE, actor=user,
        before=before, after={"status": payment.status},
        summary=f"Payment {payment.payment_no} {payment.status.lower()}")
    await db.commit()
    return await get_payment(db, payment.id, user)


def meta() -> dict:
    """The stages and modes, served so every screen words them the same."""
    return {"stages": PAYMENT_MILESTONE_META,
            "modes": [m.value for m in PaymentMode]}
