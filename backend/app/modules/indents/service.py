"""Indents business logic. THE reference module — copy this shape.

Every state change follows: load -> validate current status -> change -> commit.
Approvals go ONLY through the workflow engine; there is no approval logic here.
"""
from datetime import date, datetime, timezone

from sqlalchemy import String, and_, cast, false, func, literal, or_, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.exceptions import NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
# inventory is the base module (imports nothing from app.modules), so calling it from
# here is the legal direction. This is the §3 stock-availability fork.
from app.modules.inventory import allocations
from app.modules.inventory import service as inventory_service
from app.platform.hcm.models import (
    HcmDepartment, HcmOffice, HcmPosition, HcmPositionAssignment,
)
from app.platform.rules import evaluator as rules
from app.platform.workflow import engine
from app.platform.workflow.models import Action, Instance
from app.platform.settings.service import write_audit
from app.shared.models.base import utcnow
from app.shared.models.master import Item
from app.shared.numbering import next_number
from app.modules.indents.enums import (
    AllocationStatus, ApprovalAction, AuditAction, DocType, IndentActivityType,
    IndentItemStatus, IndentStatus, InstanceStatus, MaterialDirection, RuleActionType,
)
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


async def _requester_context(db: AsyncSession, user) -> dict:
    position_id = getattr(user, "active_position_id", None)
    stmt = select(HcmPositionAssignment).where(
        HcmPositionAssignment.employee_id == user.id,
        HcmPositionAssignment.is_active.is_(True),
    )
    if position_id is not None:
        stmt = stmt.where(HcmPositionAssignment.position_id == position_id)
    else:
        stmt = stmt.order_by(HcmPositionAssignment.is_primary.desc())
    assignment = (await db.execute(stmt.limit(1))).scalar_one_or_none()
    position = (
        await db.get(HcmPosition, assignment.position_id) if assignment else None
    )
    department_id = (
        (assignment.department_id if assignment else None)
        or (position.department_id if position else None)
        or user.department_id
    )
    office_id = (
        (assignment.office_id if assignment else None)
        or (position.office_id if position else None)
        or user.office_id
    )
    project_id = (position.project_id if position else None) or user.project_id
    return {
        "position_id": position.id if position else None,
        "position_name": position.name if position else None,
        "department_id": department_id,
        "department_name": await _name(db, HcmDepartment, department_id),
        "office_id": office_id,
        "office_name": await _name(db, HcmOffice, office_id),
        "project_id": project_id,
        "project_name": (position.project_name if position else None) or user.project_name,
    }


async def create_indent(db: AsyncSession, data: IndentCreate, user) -> Indent:
    if not data.items:
        raise ValidationError("Indent must have at least one item")

    items_map = await _items_by_id(db, [line.item_id for line in data.items])
    missing = {line.item_id for line in data.items} - set(items_map)
    if missing:
        raise ValidationError(f"Unknown item ids: {sorted(missing)}")

    context = await _requester_context(db, user)
    total_qty = sum(line.quantity for line in data.items)
    indent = Indent(
        indent_no=await next_number(db, "indent"),
        indent_date=utcnow().date(),
        required_date=data.required_date,
        requested_by_id=user.id,
        requested_by_name=user.full_name,
        requested_by_code=user.emp_code,
        position_id=context["position_id"],
        position_name=context["position_name"],
        department_id=context["department_id"],
        department_name=context["department_name"],
        office_id=context["office_id"],
        office_name=context["office_name"],
        project_id=context["project_id"],
        project_name=context["project_name"],
        status=IndentStatus.DRAFT.value,
        priority=data.priority,
        total_items=len(data.items),
        total_qty=total_qty,
        remarks=data.remarks,
    )
    db.add(indent)
    await db.flush()

    for line_no, line in enumerate(data.items, start=1):
        item = items_map[line.item_id]
        db.add(IndentItem(
            indent_id=indent.id, line_no=line_no, item_id=item.id, item_code=item.code,
            item_name=item.name, uom_code=item.uom_code,
            quantity=line.quantity, remarks=line.remarks,
        ))
    await write_audit(
        db, entity="ind_indents", entity_id=indent.id, entity_no=indent.indent_no,
        action=AuditAction.CREATE, actor=user,
        after={"status": indent.status, "total_items": indent.total_items},
    )
    await db.commit()
    await db.refresh(indent)
    return indent


async def get_indent(db: AsyncSession, indent_id: int) -> Indent:
    indent = (await db.execute(
        select(Indent).options(selectinload(Indent.items)).where(Indent.id == indent_id)
    )).scalar_one_or_none()
    if not indent:
        raise NotFoundError(f"Indent {indent_id} not found")
    return indent


async def list_indents(db: AsyncSession, params: PageParams,
                       status: str | None = None, department_id: int | None = None) -> dict:
    stmt = select(Indent).options(selectinload(Indent.items))
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

    before = {
        "required_date": indent.required_date,
        "priority": indent.priority,
        "remarks": indent.remarks,
        "total_items": indent.total_items,
        "total_qty": indent.total_qty,
    }
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
        for line_no, line in enumerate(data.items, start=1):
            item = items_map.get(line.item_id)
            if not item:
                raise ValidationError(f"Unknown item id: {line.item_id}")
            indent.items.append(IndentItem(
                line_no=line_no, item_id=item.id, item_code=item.code, item_name=item.name,
                uom_code=item.uom_code, quantity=line.quantity, remarks=line.remarks,
            ))
        indent.total_items = len(data.items)
        indent.total_qty = sum(line.quantity for line in data.items)

    await write_audit(
        db, entity="ind_indents", entity_id=indent.id, entity_no=indent.indent_no,
        action=AuditAction.UPDATE, actor=user, before=before,
        after={
            "required_date": indent.required_date,
            "priority": indent.priority,
            "remarks": indent.remarks,
            "total_items": indent.total_items,
            "total_qty": indent.total_qty,
        },
    )
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
            "doc_no": indent.indent_no,
            "doc_summary": f"Material request {indent.indent_no}",
            "department_id": indent.department_id,
            "requester_position_id": indent.position_id,
            "requester_position_name": indent.position_name,
            "total_quantity": float(sum(i.quantity for i in indent.items)),
        },
        user=user,
    )
    indent.status = IndentStatus.PENDING_APPROVAL.value
    await _refresh_current_approver(db, indent)
    await write_audit(
        db, entity="ind_indents", entity_id=indent.id, entity_no=indent.indent_no,
        action=AuditAction.UPDATE, actor=user,
        before={"status": IndentStatus.DRAFT.value},
        after={"status": indent.status},
    )
    await db.commit()
    await db.refresh(indent)
    return indent


async def act_on_indent(db: AsyncSession, indent_id: int, action: ApprovalAction,
                        comments: str, user) -> Indent:
    """APPROVE / REJECT / RETURN. Engine owns the chain; the module owns the status."""
    indent = await get_indent(db, indent_id)
    if indent.status != IndentStatus.PENDING_APPROVAL.value:
        raise ValidationError(f"Indent is not awaiting approval (status {indent.status})")

    before_status = indent.status
    context = {
        "doc_no": indent.indent_no,
        "doc_summary": f"Material request {indent.indent_no}",
        "department_id": indent.department_id,
        "requester_position_id": indent.position_id,
        "requester_position_name": indent.position_name,
        "total_quantity": float(indent.total_qty),
    }
    instance = await engine.act(
        db, DocType.INDENT.value, indent.id, action.value, user, comments,
        context=context,
    )

    if instance.status == InstanceStatus.APPROVED.value:
        indent.status = IndentStatus.APPROVED.value
        indent.approved_at = utcnow()
        indent.current_approver_name = None
        await _fulfil(db, indent, user)
    elif instance.status == InstanceStatus.REJECTED.value:
        indent.status = IndentStatus.REJECTED.value
        indent.current_approver_name = None
        # Whatever this indent was holding goes back on the shelf immediately —
        # otherwise a rejected request quietly keeps stock out of everyone's reach.
        await inventory_service.release_for_indent(db, indent.id)
    else:
        await _refresh_current_approver(db, indent)

    await write_audit(
        db, entity="ind_indents", entity_id=indent.id, entity_no=indent.indent_no,
        action=AuditAction.UPDATE, actor=user,
        before={"status": before_status}, after={"status": indent.status},
        summary=f"{action.value.title()} material request",
    )
    await db.commit()
    await db.refresh(indent)
    return indent


async def approved_pending_po(db: AsyncSession, params: PageParams) -> dict:
    """Approved indents not yet fully converted to POs — the procurement screen.

    Includes the allocation outcomes: an indent inventory could not fill is precisely
    the one procurement needs to see. Filtering on APPROVED alone would leave this
    screen permanently empty now that approval hands off to allocation.
    """
    stmt = (
        select(Indent).options(selectinload(Indent.items))
        .where(Indent.status.in_([
            IndentStatus.APPROVED.value,
            IndentStatus.PENDING_PROCUREMENT.value,
            IndentStatus.PARTIALLY_FULFILLED.value,
            IndentStatus.PARTIALLY_ORDERED.value,
        ]))
        .order_by(Indent.created_at.desc())
    )
    return await paginate(db, stmt, params)


def _fulfilment_warehouse_types(actions) -> list[str] | None:
    """Which warehouse types may fulfil this indent. None means "any".

    A routing event that matches no rule must not strand the document: we fall through
    to "any warehouse", and the no-match row rules.fire() already wrote to
    rule_executions records that we did. Configuration failing is not the document's
    problem.
    """
    routes = rules.actions_of_type(actions, RuleActionType.ROUTE_FULFILLMENT.value)
    for action in routes:
        types = (action.params or {}).get("warehouse_types")
        if types:
            return list(types)
    return None


async def _fulfil(db: AsyncSession, indent: Indent, user) -> None:
    """Flow doc §3 step 3: hand the approved indent to inventory. Reserve NOTHING.

    An earlier version allocated here automatically — it reserved everything available
    and raised an MR for the rest. That was wrong. Sixty bags of cement with four
    projects wanting it is a judgement somebody makes: how much this project gets, out
    of which warehouse, and what waits. Doing it by rule makes the system a queue.

    So this only records where the indent should go (the rule engine's routing) and
    parks it in the Fulfilment Queue for a person. Stock moves when that person's
    allocation is approved — see modules/inventory/allocations.py.
    """
    ctx = {
        "indent_id": indent.id,
        "department_id": indent.department_id,
        "department_name": indent.department_name,
        "facility_id": indent.office_id,
        "project_id": indent.project_id,
        "project_name": indent.project_name,
        "priority": indent.priority,
        "required_by": indent.required_date,
        "requester_position_id": indent.position_id,
        "total_qty": float(indent.total_qty or 0),
    }
    actions = await rules.fire(db, "INDENT_APPROVED", ctx,
                               doc_type=DocType.INDENT.value, doc_id=indent.id)

    # The routing decision is still worth recording even though nothing acts on it
    # yet: it is what will pre-filter the warehouses the allocator is offered.
    _fulfilment_warehouse_types(actions)

    for line in indent.items:
        line.allocated_quantity = 0
        line.status = IndentItemStatus.PENDING.value
    indent.status = IndentStatus.AWAITING_ALLOCATION.value


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
    # "Cleared its approval chain and is still moving." An indent no longer rests at
    # APPROVED -- it goes to AWAITING_ALLOCATION and on through the allocation
    # outcomes -- so counting only APPROVED would report zero approvals forever.
    approved_active = sum(counts.get(v, 0) for v in (
        S.APPROVED.value, S.AWAITING_ALLOCATION.value, S.ALLOCATED.value,
        S.PARTIALLY_FULFILLED.value, S.PENDING_PROCUREMENT.value,
        S.ORDERED.value, S.PARTIALLY_ORDERED.value,
    ))
    line_totals = (
        select(func.count(IndentItem.id), func.coalesce(func.sum(IndentItem.quantity), 0))
        .join(Indent, Indent.id == IndentItem.indent_id)
    )
    if department_id is not None:
        line_totals = line_totals.where(Indent.department_id == department_id)
    total_items, total_qty = (await db.execute(line_totals)).one()
    decided = approved_active + counts.get(S.REJECTED.value, 0)
    return {
        "total": sum(counts.values()),
        "draft": counts.get(S.DRAFT.value, 0),
        "awaiting_approval": counts.get(S.PENDING_APPROVAL.value, 0),
        "approved_active": approved_active,
        "rejected": counts.get(S.REJECTED.value, 0),
        "ordered": counts.get(S.ORDERED.value, 0),
        "this_month": this_month or 0,
        "total_items": total_items or 0,
        "total_qty": float(total_qty or 0),
        "approval_rate": round((approved_active / decided) * 100, 1) if decided else 0,
        "by_status": counts,
    }


def _indent_filters(stmt, *, search: str | None, date_from: date | None,
                    date_to: date | None, status: IndentStatus | None):
    if search:
        term = f"%{search.strip()}%"
        stmt = stmt.where(or_(
            Indent.indent_no.ilike(term),
            Indent.requested_by_name.ilike(term),
            Indent.department_name.ilike(term),
        ))
    if date_from:
        stmt = stmt.where(func.date(Indent.created_at) >= date_from)
    if date_to:
        stmt = stmt.where(func.date(Indent.created_at) <= date_to)
    if status:
        stmt = stmt.where(Indent.status == status.value)
    return stmt


async def activity_ledger(
    db: AsyncSession,
    params: PageParams,
    *,
    search: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    item_id: int | None = None,
    status: IndentStatus | None = None,
    transaction_type: IndentActivityType | None = None,
    direction: MaterialDirection | None = None,
) -> dict:
    """Read-only material-request ledger built from frozen indent/workflow tables."""
    raised = select(
        (literal("line:") + cast(IndentItem.id, String)).label("event_id"),
        Indent.created_at.label("event_at"),
        literal(IndentActivityType.RAISED.value).label("transaction_type"),
        literal(MaterialDirection.OUTWARD.value).label("direction"),
        Indent.id.label("indent_id"), Indent.indent_no, Indent.status,
        Indent.requested_by_name, Indent.department_name,
        IndentItem.item_id, IndentItem.item_code, IndentItem.item_name,
        IndentItem.uom_code, IndentItem.quantity,
        literal(None, String).label("actor_name"),
        IndentItem.remarks.label("comments"),
    ).join(IndentItem, IndentItem.indent_id == Indent.id)
    raised = _indent_filters(
        raised, search=search, date_from=date_from, date_to=date_to, status=status,
    )
    if item_id is not None:
        raised = raised.where(IndentItem.item_id == item_id)
    if direction == MaterialDirection.INWARD:
        raised = raised.where(false())

    acknowledged = select(
        (literal("action:") + cast(Action.id, String)).label("event_id"),
        Action.acted_at.label("event_at"),
        literal(IndentActivityType.ACKNOWLEDGED.value).label("transaction_type"),
        literal(None, String).label("direction"),
        Indent.id.label("indent_id"), Indent.indent_no, Indent.status,
        Indent.requested_by_name, Indent.department_name,
        literal(None).label("item_id"), literal(None, String).label("item_code"),
        literal(None, String).label("item_name"), literal(None, String).label("uom_code"),
        literal(0).label("quantity"), Action.actor_name, Action.comments,
    ).join(
        Instance,
        and_(Instance.doc_id == Indent.id, Instance.doc_type == DocType.INDENT.value),
    ).join(Action, Action.instance_id == Instance.id)
    acknowledged = _indent_filters(
        acknowledged, search=search, date_from=None, date_to=None, status=status,
    )
    if date_from:
        acknowledged = acknowledged.where(func.date(Action.acted_at) >= date_from)
    if date_to:
        acknowledged = acknowledged.where(func.date(Action.acted_at) <= date_to)

    include_raised = (
        transaction_type != IndentActivityType.ACKNOWLEDGED
        and direction != MaterialDirection.INWARD
    )
    include_acknowledged = (
        transaction_type != IndentActivityType.RAISED
        and direction is None
        and item_id is None
    )
    if include_raised and include_acknowledged:
        combined = union_all(raised, acknowledged)
    elif include_acknowledged:
        combined = acknowledged
    elif include_raised:
        combined = raised
    else:
        combined = raised.where(false())

    rows = combined.subquery()
    stmt = select(rows).order_by(rows.c.event_at.desc())
    total = await db.scalar(select(func.count()).select_from(stmt.subquery()))
    result = (await db.execute(stmt.offset(params.offset).limit(params.size))).mappings().all()
    return {
        "items": [dict(row) for row in result],
        "total": total or 0,
        "page": params.page,
        "size": params.size,
    }


async def list_acknowledgments(db: AsyncSession, params: PageParams) -> dict:
    stmt = (
        select(
            Action.id, Indent.id.label("indent_id"), Indent.indent_no, Action.action,
            Action.stage_name, Action.actor_name, Action.comments, Action.acted_at,
        )
        .join(Instance, Action.instance_id == Instance.id)
        .join(Indent, and_(
            Instance.doc_id == Indent.id,
            Instance.doc_type == DocType.INDENT.value,
        ))
        .order_by(Action.acted_at.desc())
    )
    total = await db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = (await db.execute(stmt.offset(params.offset).limit(params.size))).mappings().all()
    return {"items": [dict(row) for row in rows], "total": total or 0,
            "page": params.page, "size": params.size}


async def list_notifications(db: AsyncSession, params: PageParams, user) -> dict:
    stmt = (
        select(Indent)
        .options(selectinload(Indent.items))
        .where(Indent.requested_by_id == user.id)
        .where(Indent.status.in_([
            IndentStatus.PENDING_APPROVAL.value, IndentStatus.APPROVED.value,
            IndentStatus.AWAITING_ALLOCATION.value, IndentStatus.ALLOCATED.value,
            IndentStatus.PARTIALLY_FULFILLED.value,
            IndentStatus.PENDING_PROCUREMENT.value,
            IndentStatus.REJECTED.value, IndentStatus.PARTIALLY_ORDERED.value,
            IndentStatus.ORDERED.value, IndentStatus.CLOSED.value,
        ]))
        .order_by(Indent.updated_at.desc())
    )
    page = await paginate(db, stmt, params)
    messages = {
        IndentStatus.PENDING_APPROVAL: (
            "Awaiting approval",
            lambda row: f"{row.indent_no} is awaiting approval"
            + (f" from {row.current_approver_name}." if row.current_approver_name else "."),
        ),
        IndentStatus.APPROVED: (
            "Request approved", lambda row: f"{row.indent_no} has been approved."
        ),
        IndentStatus.AWAITING_ALLOCATION: (
            "Request approved",
            lambda row: f"{row.indent_no} is approved and with inventory.",
        ),
        IndentStatus.ALLOCATED: (
            "Stock set aside",
            lambda row: f"Stock for {row.indent_no} has been set aside.",
        ),
        IndentStatus.PARTIALLY_FULFILLED: (
            "Part of it is coming from stock",
            lambda row: f"Some of {row.indent_no} is from stock; the rest is on order.",
        ),
        IndentStatus.PENDING_PROCUREMENT: (
            "Going to procurement",
            lambda row: f"{row.indent_no} is being bought in.",
        ),
        IndentStatus.REJECTED: (
            "Request rejected", lambda row: f"{row.indent_no} has been rejected."
        ),
        IndentStatus.PARTIALLY_ORDERED: (
            "Ordering started", lambda row: f"Items for {row.indent_no} are being ordered."
        ),
        IndentStatus.ORDERED: (
            "Items ordered", lambda row: f"All items for {row.indent_no} have been ordered."
        ),
        IndentStatus.CLOSED: (
            "Request completed", lambda row: f"{row.indent_no} is complete."
        ),
    }
    items = []
    for row in page["items"]:
        config = messages.get(IndentStatus(row.status))
        if not config:
            continue
        title, message = config
        items.append({
            "id": f"indent:{row.id}:{row.status}",
            "indent_id": row.id,
            "indent_no": row.indent_no,
            "title": title,
            "message": message(row),
            "status": row.status,
            "created_at": row.updated_at,
        })
    page["items"] = items
    return page


# ---------------- allocation endpoints' service layer ----------------
#
# Allocation is a decision ABOUT an indent, so it lives here. The mechanics --
# proposing, reserving, raising the MR -- live in modules/inventory/allocations.py.
# Indents may import inventory (the base module); inventory must never import indents.


async def allocation_proposal(db: AsyncSession, indent_id: int) -> dict:
    """What the allocation screen needs: the indent lines, what is on the shelf for
    each, split by warehouse, and how much other indents are already waiting on.

    Read-only. Reserves nothing.
    """
    stmt = select(Indent).options(selectinload(Indent.items)).where(
        Indent.id == indent_id)
    indent = (await db.execute(stmt)).scalar_one_or_none()
    if indent is None:
        raise NotFoundError(f"Indent {indent_id} not found")

    lines = [{
        "indent_item_id": line.id,
        "item_id": line.item_id,
        "item_code": line.item_code,
        "item_name": line.item_name,
        "uom_code": line.uom_code,
        "requested_qty": float(line.approved_quantity or line.quantity or 0),
        "already_allocated": float(line.allocated_quantity or 0),
        "project_id": indent.project_id,
    } for line in indent.items]

    proposal = await allocations.propose(db, indent_id, lines)
    return {
        "indent_id": indent.id,
        "indent_no": indent.indent_no,
        "department_name": indent.department_name,
        "requested_by_name": indent.requested_by_name,
        "status": indent.status,
        "lines": [{**p, "available_total": float(p["available_total"]),
                   "competing_demand": float(p["competing_demand"]),
                   "warehouses": [{**w, "available_qty": float(w["available_qty"])}
                                  for w in p["warehouses"]]}
                  for p in proposal],
    }


async def decide_allocation(db: AsyncSession, body, user):
    """A person has decided how much to give. Record it and send it for approval."""
    indent = await db.get(Indent, body.indent_id)
    if indent is None:
        raise NotFoundError(f"Indent {body.indent_id} not found")

    return await allocations.create(
        db, indent.id, indent.indent_no,
        [d.model_dump() for d in body.decisions], user,
        ctx={"department_id": indent.department_id, "remarks": body.remarks},
    )


async def act_on_allocation(db: AsyncSession, allocation_id: int, action: str, user,
                            comments: str = ""):
    """Approve or reject. Approval reserves the stock and updates the indent."""
    alloc = await allocations.act(db, allocation_id, action, user, comments)

    if alloc.status == AllocationStatus.APPROVED.value:
        indent = await db.get(Indent, alloc.indent_id)
        if indent is not None:
            requested = sum(float(i.requested_qty or 0) for i in alloc.items)
            given = sum(float(i.quantity or 0) for i in alloc.items)
            for line in alloc.items:
                item_line = await db.get(IndentItem, line.indent_item_id)
                if item_line is not None:
                    item_line.allocated_quantity = line.quantity
                    item_line.status = (IndentItemStatus.ALLOCATED.value
                                        if line.quantity and line.quantity > 0
                                        else IndentItemStatus.SHORT.value)
            if given <= 0:
                indent.status = IndentStatus.PENDING_PROCUREMENT.value
            elif given >= requested:
                indent.status = IndentStatus.ALLOCATED.value
            else:
                indent.status = IndentStatus.PARTIALLY_FULFILLED.value
            await db.commit()
            await db.refresh(alloc)
    return alloc


async def item_demand(db: AsyncSession, item_id: int) -> dict:
    """Every indent still waiting on this item, plus what is on the shelf for it.

    This is the view Balu described: 60 bags of cement, four projects want it, split
    it. Deciding one indent at a time hides the competition, which is exactly the
    information the allocator needs.
    """
    from app.modules.inventory import allocations

    stmt = (
        select(Indent, IndentItem)
        .join(IndentItem, IndentItem.indent_id == Indent.id)
        .where(IndentItem.item_id == item_id,
               Indent.status == IndentStatus.AWAITING_ALLOCATION.value)
        .order_by(Indent.created_at)
    )
    rows = (await db.execute(stmt)).all()

    item = await db.get(Item, item_id)
    proposal = await allocations.propose(db, 0, [
        {"indent_item_id": 0, "item_id": item_id, "project_id": None}])
    stock = proposal[0] if proposal else {"available_total": 0, "warehouses": []}

    return {
        "item_id": item_id,
        "item_code": item.code if item else None,
        "item_name": item.name if item else None,
        "uom_code": item.uom_code if item else None,
        "available_total": float(stock["available_total"]),
        "warehouses": [{**w, "available_qty": float(w["available_qty"])}
                       for w in stock["warehouses"]],
        "demand": [{
            "indent_id": ind.id,
            "indent_no": ind.indent_no,
            "indent_item_id": line.id,
            "requested_by_name": ind.requested_by_name,
            "department_name": ind.department_name,
            "project_name": ind.project_name,
            "priority": ind.priority,
            "required_date": ind.required_date.isoformat() if ind.required_date else None,
            "requested_qty": float(line.approved_quantity or line.quantity or 0),
            "raised_at": ind.created_at.isoformat() if ind.created_at else None,
        } for ind, line in rows],
    }
