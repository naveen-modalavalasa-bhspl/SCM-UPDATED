"""Indents business logic. THE reference module — copy this shape.

Every state change follows: load -> validate current status -> change -> commit.
Approvals go ONLY through the workflow engine; there is no approval logic here.
"""
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.platform.hcm.models import HcmDepartment, HcmFacility
from app.platform.workflow import engine
from app.shared.enums import DocType, IndentStatus, InstanceStatus
from app.shared.models.base import utcnow
from app.shared.models.master import Item
from app.shared.numbering import next_number
from app.modules.indents.models import Indent, IndentItem
from app.modules.indents.schemas import IndentCreate, IndentUpdate


async def _items_by_id(db: AsyncSession, item_ids: list[int]) -> dict[int, Item]:
    if not item_ids:
        return {}
    rows = (await db.execute(select(Item).where(Item.id.in_(item_ids)))).scalars().all()
    return {i.id: i for i in rows}


async def _name(db: AsyncSession, model, pk) -> str | None:
    if pk is None:
        return None
    row = await db.get(model, pk)
    return row.name if row else None


async def create_indent(db: AsyncSession, data: IndentCreate, user) -> Indent:
    if not data.items:
        raise ValidationError("Indent must have at least one item")

    items_map = await _items_by_id(db, [line.item_id for line in data.items])
    missing = {line.item_id for line in data.items} - set(items_map)
    if missing:
        raise ValidationError(f"Unknown item ids: {sorted(missing)}")

    indent = Indent(
        indent_no=await next_number(db, "indent"),
        indent_date=utcnow().date(),
        required_date=data.required_date,
        requested_by_id=user.id,
        requested_by_name=user.full_name,
        requested_by_code=user.emp_code,
        department_id=user.department_id,
        department_name=await _name(db, HcmDepartment, user.department_id),
        office_id=user.office_id,
        facility_id=data.facility_id,
        facility_name=await _name(db, HcmFacility, data.facility_id),
        status=IndentStatus.DRAFT.value,
        priority=data.priority,
        total_items=len(data.items),
        remarks=data.remarks,
    )
    db.add(indent)
    await db.flush()

    for line in data.items:
        item = items_map[line.item_id]
        db.add(IndentItem(
            indent_id=indent.id, item_id=item.id, item_code=item.code,
            item_name=item.name, uom_code=item.uom_code,
            quantity=line.quantity, remarks=line.remarks,
        ))
    await db.commit()
    await db.refresh(indent)
    return indent


async def get_indent(db: AsyncSession, indent_id: int) -> Indent:
    indent = (await db.execute(
        select(Indent).where(Indent.id == indent_id)
    )).scalar_one_or_none()
    if not indent:
        raise NotFoundError(f"Indent {indent_id} not found")
    return indent


async def list_indents(db: AsyncSession, params: PageParams,
                       status: str | None = None, department_id: int | None = None) -> dict:
    stmt = select(Indent)
    if status:
        stmt = stmt.where(Indent.status == status)
    if department_id is not None:
        stmt = stmt.where(Indent.department_id == department_id)
    stmt = stmt.order_by(Indent.created_at.desc())
    return await paginate(db, stmt, params)


async def update_indent(db: AsyncSession, indent_id: int, data: IndentUpdate, user) -> Indent:
    indent = await get_indent(db, indent_id)
    if indent.status != IndentStatus.DRAFT.value:
        raise ValidationError(f"Cannot edit an indent in {indent.status} status")

    if data.required_date is not None:
        indent.required_date = data.required_date
    if data.priority is not None:
        indent.priority = data.priority
    if data.remarks is not None:
        indent.remarks = data.remarks

    if data.items is not None:
        if not data.items:
            raise ValidationError("Indent must have at least one item")
        items_map = await _items_by_id(db, [l.item_id for l in data.items])
        indent.items.clear()
        for line in data.items:
            item = items_map.get(line.item_id)
            if not item:
                raise ValidationError(f"Unknown item id: {line.item_id}")
            indent.items.append(IndentItem(
                item_id=item.id, item_code=item.code, item_name=item.name,
                uom_code=item.uom_code, quantity=line.quantity, remarks=line.remarks,
            ))
        indent.total_items = len(data.items)

    await db.commit()
    await db.refresh(indent)
    return indent


async def submit_indent(db: AsyncSession, indent_id: int, user) -> Indent:
    indent = await get_indent(db, indent_id)
    if indent.status != IndentStatus.DRAFT.value:
        raise ValidationError(f"Cannot submit an indent in {indent.status} status")

    await engine.start(
        db, doc_type=DocType.INDENT.value, doc_id=indent.id,
        context={
            "department_id": indent.department_id,
            "total_quantity": float(sum(i.quantity for i in indent.items)),
        },
        user=user,
    )
    indent.status = IndentStatus.PENDING_APPROVAL.value
    await _refresh_current_approver(db, indent)
    await db.commit()
    await db.refresh(indent)
    return indent


async def act_on_indent(db: AsyncSession, indent_id: int, action: str,
                        comments: str, user) -> Indent:
    """APPROVE / REJECT / RETURN. Engine owns the chain; the module owns the status."""
    indent = await get_indent(db, indent_id)
    if indent.status != IndentStatus.PENDING_APPROVAL.value:
        raise ValidationError(f"Indent is not awaiting approval (status {indent.status})")

    instance = await engine.act(db, DocType.INDENT.value, indent.id, action, user, comments)

    if instance.status == InstanceStatus.APPROVED.value:
        indent.status = IndentStatus.APPROVED.value
        indent.approved_at = utcnow()
        indent.current_approver_name = None
    elif instance.status == InstanceStatus.REJECTED.value:
        indent.status = IndentStatus.REJECTED.value
        indent.current_approver_name = None
    else:
        await _refresh_current_approver(db, indent)

    await db.commit()
    await db.refresh(indent)
    return indent


async def approved_pending_po(db: AsyncSession, params: PageParams) -> dict:
    """Approved indents not yet fully converted to POs — the procurement screen."""
    stmt = (
        select(Indent)
        .where(Indent.status.in_([IndentStatus.APPROVED.value,
                                  IndentStatus.PARTIALLY_ORDERED.value]))
        .order_by(Indent.created_at.desc())
    )
    return await paginate(db, stmt, params)


async def _refresh_current_approver(db: AsyncSession, indent: Indent) -> None:
    approvers = await engine.current_approvers(db, DocType.INDENT.value, indent.id)
    indent.current_approver_name = ", ".join(a.full_name for a in approvers) or None


async def indent_stats(db: AsyncSession, department_id: int | None = None) -> dict:
    """KPIs for the indent dashboard: counts by status + a few derived numbers."""
    stmt = select(Indent.status, func.count()).group_by(Indent.status)
    if department_id is not None:
        stmt = stmt.where(Indent.department_id == department_id)
    counts = {status: n for status, n in (await db.execute(stmt)).all()}

    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    month_stmt = select(func.count()).select_from(Indent).where(Indent.created_at >= month_start)
    if department_id is not None:
        month_stmt = month_stmt.where(Indent.department_id == department_id)
    this_month = await db.scalar(month_stmt)

    S = IndentStatus
    approved_active = (counts.get(S.APPROVED.value, 0)
                       + counts.get(S.ORDERED.value, 0)
                       + counts.get(S.PARTIALLY_ORDERED.value, 0))
    return {
        "total": sum(counts.values()),
        "draft": counts.get(S.DRAFT.value, 0),
        "awaiting_approval": counts.get(S.PENDING_APPROVAL.value, 0),
        "approved_active": approved_active,
        "rejected": counts.get(S.REJECTED.value, 0),
        "ordered": counts.get(S.ORDERED.value, 0),
        "this_month": this_month or 0,
        "by_status": counts,
    }
