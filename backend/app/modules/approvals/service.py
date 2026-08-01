"""Business logic for the approver's operational workspace."""
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import delete, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.exceptions import NotFoundError, PermissionError_, ValidationError
from app.modules.indents import service as indent_service
from app.modules.indents.models import Indent
from app.modules.indents.enums import ApprovalAction, IndentStatus
from app.platform.settings.service import write_audit
from app.platform.notifications import service as notification_service
from app.platform.workflow import engine, service as workflow_service
from app.platform.workflow.models import Action, Instance, Pending
from app.shared.enums import AuditAction, DocType, InstanceStatus

from .schemas import ApprovalIndentLineOut, ApprovalIndentOut, ApprovalQuantityIn


async def pending_for_user(db: AsyncSession, user) -> list[dict]:
    rows = await engine.pending_for_user(db, user)
    for row in rows:
        row["approver_name"] = user.full_name
    return rows


async def pending_page(
    db: AsyncSession, user, page: int, size: int, *, search: str = "",
    doc_type: str = "", overdue_only: bool = False,
    raised_from: datetime | None = None, raised_to: datetime | None = None,
    sort: str = "oldest",
) -> dict:
    conditions = [Pending.approver_id == user.id]
    term = search.strip()
    if term:
        like = f"%{term}%"
        conditions.append(or_(
            Pending.doc_no.ilike(like), Pending.doc_summary.ilike(like),
            Pending.requested_by_name.ilike(like), Instance.current_stage_name.ilike(like),
        ))
    if doc_type:
        conditions.append(Pending.doc_type == doc_type)
    if overdue_only:
        conditions.append(Pending.due_at < datetime.now(timezone.utc).replace(tzinfo=None))
    if raised_from:
        conditions.append(Pending.created_at >= raised_from.replace(tzinfo=None))
    if raised_to:
        conditions.append(Pending.created_at < raised_to.replace(tzinfo=None))
    joined = select(Pending, Instance).join(Instance, Instance.id == Pending.instance_id)
    total = int(await db.scalar(
        select(func.count(Pending.id))
        .select_from(Pending).join(Instance, Instance.id == Pending.instance_id)
        .where(*conditions)
    ) or 0)
    order = {
        "newest": Pending.created_at.desc(),
        "due": Pending.due_at.asc(),
        "value": Pending.amount.desc(),
    }.get(sort, Pending.created_at.asc())
    rows = (await db.execute(
        joined.where(*conditions)
        .order_by(order, Pending.id.desc())
        .offset((page - 1) * size)
        .limit(size)
    )).all()
    items = [{
        "instance_id": pending.instance_id,
        "doc_type": pending.doc_type,
        "doc_id": pending.doc_id,
        "stage_sequence": pending.stage_sequence,
        "doc_no": pending.doc_no,
        "summary": pending.doc_summary,
        "requested_by_name": pending.requested_by_name,
        "amount": float(pending.amount) if pending.amount is not None else None,
        "waiting_since": pending.created_at.isoformat() if pending.created_at else None,
        "due_at": pending.due_at.isoformat() if pending.due_at else None,
        "current_stage_name": instance.current_stage_name,
        "approver_name": user.full_name,
    } for pending, instance in rows]
    return {"items": items, "total": total, "page": page, "size": size}


DECISION_VALUES = {
    ApprovalAction.APPROVED.value,
    ApprovalAction.REJECTED.value,
    ApprovalAction.RETURNED.value,
}


def _decision_output(action: Action, instance: Instance, user) -> dict:
    duration_hours = None
    if action.acted_at and instance.started_at:
        duration_hours = round(
            max(0, (action.acted_at - instance.started_at).total_seconds() / 3600), 1,
        )
    return {
        "id": action.id,
        "doc_type": instance.doc_type,
        "doc_id": instance.doc_id,
        "doc_no": instance.doc_no,
        "stage_sequence": action.stage_sequence,
        "stage_name": action.stage_name,
        "decision": action.action,
        "comments": action.comments,
        "decision_at": action.acted_at.isoformat() if action.acted_at else None,
        "started_at": instance.started_at.isoformat() if instance.started_at else None,
        "duration_hours": duration_hours,
        "within_sla": (
            action.acted_at <= instance.due_at
            if action.acted_at and instance.due_at else None
        ),
        "requester": instance.started_by_name,
        "approver_name": action.actor_name or user.full_name,
        "workflow_status": instance.status,
    }


def _decision_query(user):
    return (
        select(Action, Instance)
        .join(Instance, Instance.id == Action.instance_id)
        .where(Action.actor_id == user.id, Action.action.in_(DECISION_VALUES))
        .order_by(Action.acted_at.desc(), Action.id.desc())
    )


async def decisions_for_user(db: AsyncSession, user) -> list[dict]:
    rows = (await db.execute(_decision_query(user))).all()
    return [_decision_output(action, instance, user) for action, instance in rows]


async def decisions_page(
    db: AsyncSession, user, page: int, size: int, *, search: str = "",
    decision: str = "",
) -> dict:
    conditions = [Action.actor_id == user.id, Action.action.in_(DECISION_VALUES)]
    if decision:
        conditions.append(Action.action == decision)
    term = search.strip()
    if term:
        like = f"%{term}%"
        conditions.append(or_(
            Instance.doc_no.ilike(like), Instance.started_by_name.ilike(like),
            Action.comments.ilike(like), Instance.doc_type.ilike(like),
        ))
    total = int(await db.scalar(
        select(func.count(Action.id)).select_from(Action)
        .join(Instance, Instance.id == Action.instance_id).where(*conditions)
    ) or 0)
    rows = (await db.execute(
        select(Action, Instance).join(Instance, Instance.id == Action.instance_id)
        .where(*conditions).order_by(Action.acted_at.desc(), Action.id.desc())
        .offset((page - 1) * size).limit(size)
    )).all()
    return {
        "items": [_decision_output(action, instance, user) for action, instance in rows],
        "total": total,
        "page": page,
        "size": size,
    }


async def team_queue(db: AsyncSession, user) -> list[dict]:
    return await workflow_service.team_queue(db, user)


async def approval_history(db: AsyncSession, doc_type: str, doc_id: int, user) -> list[dict]:
    instance_ids = list((await db.execute(
        select(Instance.id).where(
            Instance.doc_type == doc_type,
            Instance.doc_id == doc_id,
            or_(
                Instance.started_by_id == user.id,
                exists(select(Pending.id).where(
                    Pending.instance_id == Instance.id,
                    Pending.approver_id == user.id,
                )),
                exists(select(Action.id).where(
                    Action.instance_id == Instance.id,
                    Action.actor_id == user.id,
                )),
            ),
        ).order_by(Instance.id)
    )).scalars().all())
    if not instance_ids:
        return []
    actions = list((await db.execute(
        select(Action).where(Action.instance_id.in_(instance_ids))
        .order_by(Action.acted_at, Action.id)
    )).scalars().all())
    return [{
        "id": action.id,
        "stage_sequence": action.stage_sequence,
        "stage_name": action.stage_name,
        "actor_id": action.actor_id,
        "actor_name": action.actor_name,
        "actor_position": action.actor_position,
        "action": action.action,
        "comments": action.comments,
        "acted_at": action.acted_at.isoformat() if action.acted_at else None,
    } for action in actions]


async def act_on_document(
    db: AsyncSession, doc_type: str, doc_id: int, action: str, comments: str, user,
) -> dict:
    """Use each owning module's existing status-safe approval operation."""
    if action not in {ApprovalAction.APPROVED.value, ApprovalAction.REJECTED.value}:
        raise ValidationError("Only approve and reject are supported for this document")
    if action == ApprovalAction.REJECTED.value and not comments.strip():
        raise ValidationError("Rejection reason is required")

    normalized = doc_type.upper()
    if normalized == DocType.ALLOCATION.value:
        from app.modules.inventory import allocations
        await allocations.act(db, doc_id, action, user, comments)
    elif normalized == DocType.MR.value:
        from app.modules.inventory import service as inventory_service
        await inventory_service.act_on_mr(db, doc_id, action, user, comments)
    elif normalized == DocType.PO.value:
        from app.modules.procurement import service as procurement_service
        await procurement_service.act_on_po(db, doc_id, action, comments, user)
    elif normalized in {"ISSUE", "WH_ISSUE"}:
        from app.modules.warehouse import service as warehouse_service
        await warehouse_service.act_on_issue(db, doc_id, action, comments, user)
    elif normalized == "DISPATCH":
        from app.modules.warehouse import service as warehouse_service
        await warehouse_service.act_on_dispatch(db, doc_id, action, comments, user)
    elif normalized == "PURCHASE_RETURN":
        from app.modules.warehouse import service as warehouse_service
        await warehouse_service.act_on_return(db, doc_id, action, comments, user)
    else:
        raise ValidationError(f"Approval action is not supported for {normalized}")
    return {"doc_type": normalized, "doc_id": doc_id, "action": action}


async def report_summary(db: AsyncSession, user) -> dict:
    decision_values = {
        ApprovalAction.APPROVED.value,
        ApprovalAction.REJECTED.value,
        ApprovalAction.RETURNED.value,
    }
    decided = (await db.execute(
        select(Action, Instance.started_at)
        .join(Instance, Instance.id == Action.instance_id)
        .where(Action.actor_id == user.id, Action.action.in_(decision_values))
    )).all()
    counts = {value: 0 for value in decision_values}
    elapsed_hours: list[float] = []
    for action, started_at in decided:
        counts[action.action] += 1
        if action.acted_at and started_at:
            elapsed_hours.append(max(0, (action.acted_at - started_at).total_seconds() / 3600))

    pending_rows = await engine.pending_for_user(db, user)

    def is_overdue(row: dict) -> bool:
        value = row.get("due_at")
        if not value:
            return False
        due = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if due.tzinfo is None:
            due = due.replace(tzinfo=timezone.utc)
        return due < datetime.now(timezone.utc)

    return {
        "total_decisions": len(decided),
        "approved": counts[ApprovalAction.APPROVED.value],
        "rejected": counts[ApprovalAction.REJECTED.value],
        "returned": counts[ApprovalAction.RETURNED.value],
        "pending": len(pending_rows),
        "overdue": sum(1 for row in pending_rows if is_overdue(row)),
        "average_decision_hours": round(sum(elapsed_hours) / len(elapsed_hours), 1) if elapsed_hours else 0,
    }


async def remind_team_approver(db: AsyncSession, approver_id: int, user) -> dict:
    visible_team = await workflow_service.team_queue(db, user)
    allowed = {int(row["approver_id"]): row for row in visible_team}
    if approver_id not in allowed:
        raise PermissionError_("You can remind only an approver in your reporting team")
    row = allowed[approver_id]
    pending_count = int(row.get("pending_count") or 0)
    created = await notification_service.notify(
        db,
        [approver_id],
        title="Approval reminder",
        body=f"You have {pending_count} approval{'s' if pending_count != 1 else ''} waiting for your decision.",
        deep_link="/approvals",
        entity_type="APPROVAL_QUEUE",
        entity_id=approver_id,
    )
    await db.commit()
    return {
        "approver_id": approver_id,
        "pending_count": pending_count,
        "notifications_created": created,
    }


async def _load_indent_task(
    db: AsyncSession, indent_id: int, user,
) -> tuple[Indent, Instance, bool]:
    indent = (await db.execute(
        select(Indent)
        .options(selectinload(Indent.items))
        .where(Indent.id == indent_id)
    )).scalar_one_or_none()
    if indent is None:
        raise NotFoundError(f"Indent {indent_id} not found")
    if indent.status != IndentStatus.PENDING_APPROVAL.value:
        raise ValidationError(f"Indent is not awaiting approval (status {indent.status})")

    instance = (await db.execute(
        select(Instance).where(
            Instance.doc_type == DocType.INDENT.value,
            Instance.doc_id == indent_id,
            Instance.status == InstanceStatus.IN_PROGRESS.value,
        )
    )).scalar_one_or_none()
    if instance is None:
        raise ValidationError("No in-progress approval exists for this indent")

    assigned = await db.scalar(select(func.count(Pending.id)).where(
        Pending.instance_id == instance.id,
        Pending.stage_sequence == instance.current_sequence,
        Pending.approver_id == user.id,
    ))
    if not assigned:
        raise PermissionError_("This indent is not assigned to you at the current stage")
    if indent.requested_by_id == user.id:
        raise ValidationError("Requester cannot approve or reject their own indent")

    previous_approval = await db.scalar(select(func.count(Action.id)).where(
        Action.instance_id == instance.id,
        Action.action == ApprovalAction.APPROVED.value,
    ))
    return indent, instance, bool(previous_approval)


def _approval_out(
    indent: Indent, instance: Instance, has_previous_approval: bool,
) -> ApprovalIndentOut:
    items = [
        ApprovalIndentLineOut(
            id=line.id,
            item_id=line.item_id,
            item_code=line.item_code,
            item_name=line.item_name,
            uom_code=line.uom_code,
            requested_quantity=float(line.quantity),
            # Existing rows start at zero. Until someone has approved, zero means the
            # approval quantity has not been initialized, so begin with the request.
            approved_quantity=float(
                line.approved_quantity if has_previous_approval else line.quantity
            ),
            remarks=line.remarks,
        )
        for line in sorted(indent.items, key=lambda item: (item.line_no, item.id))
    ]
    return ApprovalIndentOut(
        id=indent.id,
        indent_no=indent.indent_no,
        status=indent.status,
        priority=indent.priority,
        requested_by_name=indent.requested_by_name,
        position_name=indent.position_name,
        department_name=indent.department_name,
        office_name=indent.office_name,
        current_stage_name=instance.current_stage_name,
        current_approver_name=indent.current_approver_name,
        created_at=indent.created_at,
        items=items,
    )


async def get_indent_for_approval(
    db: AsyncSession, indent_id: int, user,
) -> ApprovalIndentOut:
    indent, instance, has_previous = await _load_indent_task(db, indent_id, user)
    return _approval_out(indent, instance, has_previous)


def _validated_quantities(
    indent: Indent, submitted: list[ApprovalQuantityIn],
) -> dict[int, Decimal]:
    by_id: dict[int, Decimal] = {}
    for item in submitted:
        if item.line_id in by_id:
            raise ValidationError(f"Quantity for line {item.line_id} was submitted twice")
        by_id[item.line_id] = Decimal(str(item.approved_quantity))

    expected = {line.id for line in indent.items}
    received = set(by_id)
    if received != expected:
        missing = sorted(expected - received)
        unknown = sorted(received - expected)
        details = []
        if missing:
            details.append(f"missing lines: {missing}")
        if unknown:
            details.append(f"unknown lines: {unknown}")
        raise ValidationError("Submit one quantity for every indent line (" + "; ".join(details) + ")")

    for line in indent.items:
        approved = by_id[line.id]
        requested = Decimal(str(line.quantity))
        if approved < 0:
            raise ValidationError("Approved quantity cannot be negative")
        if approved > requested:
            raise ValidationError(
                f"Approved quantity for {line.item_name or line.item_code or line.id} "
                f"cannot exceed requested quantity {requested}"
            )
    return by_id


async def approve_indent(
    db: AsyncSession, indent_id: int, quantities: list[ApprovalQuantityIn],
    comments: str, user,
) -> ApprovalIndentOut:
    indent, instance, has_previous = await _load_indent_task(db, indent_id, user)
    approved_by_line = _validated_quantities(indent, quantities)

    before: dict[str, float] = {}
    after: dict[str, float] = {}
    for line in indent.items:
        current = line.approved_quantity if has_previous else line.quantity
        before[f"line_{line.id}_approved_qty"] = float(current)
        line.approved_quantity = approved_by_line[line.id]
        after[f"line_{line.id}_approved_qty"] = float(line.approved_quantity)

    await write_audit(
        db,
        entity="ind_indent_items",
        entity_id=indent.id,
        entity_no=indent.indent_no,
        action=AuditAction.UPDATE,
        actor=user,
        before=before,
        after=after,
        summary=f"Updated quantities at {instance.current_stage_name or 'approval stage'}",
    )

    updated = await indent_service.act_on_indent(
        db, indent_id, ApprovalAction.APPROVED, comments, user,
    )

    # The action may advance to another stage or complete the workflow. Return the
    # latest document with the quantities just persisted.
    next_instance = (await db.execute(select(Instance).where(
        Instance.doc_type == DocType.INDENT.value,
        Instance.doc_id == indent_id,
    ).order_by(Instance.id.desc()))).scalars().first()
    if next_instance is None:
        next_instance = instance
    return _approval_out(updated, next_instance, True)


async def reject_indent(
    db: AsyncSession, indent_id: int, comments: str, user,
) -> ApprovalIndentOut:
    indent, instance, has_previous = await _load_indent_task(db, indent_id, user)
    updated = await indent_service.act_on_indent(
        db, indent_id, ApprovalAction.REJECTED, comments, user,
    )
    return _approval_out(updated, instance, has_previous)


async def return_indent(
    db: AsyncSession, indent_id: int, comments: str, user,
) -> ApprovalIndentOut:
    indent, instance, has_previous = await _load_indent_task(db, indent_id, user)
    before_status = indent.status
    # This requester-return behaviour is intentionally owned here so the shared
    # workflow engine and every other document flow remain unchanged.
    db.add(Action(
        instance_id=instance.id,
        stage_sequence=instance.current_sequence,
        stage_name=instance.current_stage_name,
        actor_id=user.id,
        actor_name=user.full_name,
        actor_position=None,
        action=ApprovalAction.RETURNED.value,
        comments=comments,
    ))
    await db.execute(delete(Pending).where(Pending.instance_id == instance.id))
    instance.status = InstanceStatus.CANCELLED.value
    instance.completed_at = datetime.now(timezone.utc)
    instance.current_stage_name = None
    indent.status = IndentStatus.DRAFT.value
    indent.current_approver_name = None
    indent.approved_at = None
    await write_audit(
        db,
        entity="ind_indents",
        entity_id=indent.id,
        entity_no=indent.indent_no,
        action=AuditAction.UPDATE,
        actor=user,
        before={"status": before_status},
        after={"status": indent.status},
        summary="Returned indent to requester for correction",
    )
    await notification_service.notify(
        db,
        [indent.requested_by_id],
        title=f"{indent.indent_no} returned for correction",
        body=comments,
        deep_link=f"/approvals?correction={indent.id}",
        entity_type=DocType.INDENT.value,
        entity_id=indent.id,
    )
    await db.commit()
    await db.refresh(indent)
    return _approval_out(indent, instance, has_previous)
