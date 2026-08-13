"""Procurement business logic. May import indents (backward in the chain);
never imports logistics. Approvals go only through the workflow engine.
"""
from decimal import Decimal

from sqlalchemy import select, true
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.modules.indents import service as indent_service
from app.modules.indents.models import IndentItem
from app.modules.inventory.models import MaterialRequest, MaterialRequestItem
from app.modules.procurement.models import POItem, PurchaseOrder
from app.modules.procurement.schemas import POCreate
from app.platform.workflow import engine
from app.shared.scope import scope_condition
from app.shared.enums import DocType, IndentStatus, InstanceStatus, MRStatus, POStatus
from app.shared.models.base import utcnow
from app.shared.models.master import Item, Vendor
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
