"""Business logic for the approver's operational workspace."""
from collections import defaultdict
from collections.abc import Iterable
from datetime import datetime, timezone
from decimal import ROUND_DOWN, Decimal

from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.exceptions import (
    AppException, NotFoundError, PermissionError_, ValidationError,
)
from app.modules.indents import service as indent_service
from app.modules.indents.models import Indent
from app.modules.indents.enums import ApprovalAction, IndentStatus, IndentType
from app.platform.settings.models import AuditLog
from app.platform.settings.service import write_audit
from app.platform.notifications import service as notification_service
from app.platform.workflow import engine, service as workflow_service
from app.platform.workflow.models import Action, Instance, Pending
from app.shared.enums import AuditAction, DocType, InstanceStatus
from app.shared.time import now as ist_now, today as ist_today
from app.shared.uom import MAX_DECIMALS, decimals_by_code

from .schemas import (
    ApprovalIndentLineOut, ApprovalIndentOut, ApprovalQuantityIn,
    ConsolidatedItemAllocationOut, ConsolidatedItemOut,
    ConsolidationApprovalFailureOut, ConsolidationApprovalIn, ConsolidationApprovalOut,
    ConsolidationBatchOut, ConsolidationFilterOptionOut,
    ConsolidationFilterOptionsOut, ConsolidationFilters, ConsolidationIndentSummaryOut,
    ConsolidationOut,
)


async def _monthly_indent_ids(db: AsyncSession, indent_ids: list[int]) -> set[int]:
    """Which of these indent ids are Monthly.

    Used to keep Monthly indents out of the individual Waiting for Me queue, where
    they would duplicate the Consolidation tab (see consolidation_batches_for_user).
    Read-only — never used anywhere that changes an indent's state.
    """
    if not indent_ids:
        return set()
    rows = (await db.execute(
        select(Indent.id).where(
            Indent.id.in_(indent_ids), Indent.indent_type == IndentType.MONTHLY.value,
        )
    )).scalars().all()
    return set(rows)


async def pending_for_user(db: AsyncSession, user) -> list[dict]:
    rows = await engine.pending_for_user(db, user)
    monthly_ids = await _monthly_indent_ids(
        db, [row["doc_id"] for row in rows if row["doc_type"] == DocType.INDENT.value],
    )
    rows = [
        row for row in rows
        if not (row["doc_type"] == DocType.INDENT.value and row["doc_id"] in monthly_ids)
    ]
    for row in rows:
        row["approver_name"] = user.full_name
    return rows


async def pending_summary(db: AsyncSession, user) -> dict:
    """The tiles and the doc-type chips above the approval inbox, counted in SQL.

    The screen used to answer these by fetching its whole queue a second time (page 1
    at size 500, on top of the page it was already showing) and counting in the
    browser. That is two full reads per load, and it stops being possible the moment
    a queue passes 500 rows.
    """
    now = ist_now()
    base = (
        select(Pending.doc_type, Pending.doc_id, Pending.due_at, Pending.created_at)
        .join(Instance, Instance.id == Pending.instance_id)
        .where(
            Pending.approver_id == user.id,
            Instance.status == InstanceStatus.IN_PROGRESS.value,
        )
    )
    rows = (await db.execute(base)).all()

    # Monthly indents are approved as consolidated batches on another screen, so they
    # are not in this queue — the same exclusion pending_page applies to the list.
    monthly = await _monthly_indent_ids(
        db, [r.doc_id for r in rows if r.doc_type == DocType.INDENT.value],
    )
    rows = [
        r for r in rows
        if not (r.doc_type == DocType.INDENT.value and r.doc_id in monthly)
    ]

    by_doc_type: dict[str, int] = {}
    for row in rows:
        by_doc_type[row.doc_type] = by_doc_type.get(row.doc_type, 0) + 1
    waiting = [r.created_at for r in rows if r.created_at]
    return {
        "total": len(rows),
        "past_due": sum(1 for r in rows if r.due_at and r.due_at < now),
        "oldest_waiting_since": min(waiting).isoformat() if waiting else None,
        "by_doc_type": by_doc_type,
    }


async def pending_page(
    db: AsyncSession, user, page: int, size: int, *, search: str = "",
    doc_type: str = "", overdue_only: bool = False,
    raised_from: datetime | None = None, raised_to: datetime | None = None,
    sort: str = "oldest",
) -> dict:
    # Same rule the engine applies in pending_for_user: a task whose workflow has
    # finished is not work, whatever the row says. Without it a cancelled document
    # kept a live-looking task in the queue and in every count above it.
    conditions = [
        Pending.approver_id == user.id,
        Instance.status == InstanceStatus.IN_PROGRESS.value,
    ]
    now = ist_now()
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
        conditions.append(Pending.due_at < now)
    if raised_from:
        conditions.append(Pending.created_at >= raised_from.replace(tzinfo=None))
    if raised_to:
        conditions.append(Pending.created_at < raised_to.replace(tzinfo=None))
    # Monthly indents are consolidated into batches (see consolidation_batches_for_user)
    # and must not also show up here individually. Every other doc type, and REGULAR
    # indents, are unaffected — the OR only bites when doc_type is INDENT.
    indent_join = and_(
        Pending.doc_type == DocType.INDENT.value, Indent.id == Pending.doc_id,
    )
    conditions.append(or_(
        Pending.doc_type != DocType.INDENT.value,
        Indent.indent_type != IndentType.MONTHLY.value,
    ))
    joined = (
        select(Pending, Instance)
        .join(Instance, Instance.id == Pending.instance_id)
        .outerjoin(Indent, indent_join)
    )
    total = int(await db.scalar(
        select(func.count(Pending.id))
        .select_from(Pending).join(Instance, Instance.id == Pending.instance_id)
        .outerjoin(Indent, indent_join)
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
        # Decided here, against the same clock the `overdue_only` filter uses. These
        # timestamps go out naive, so a browser reading them as local time answered a
        # different question: "Past due 0" above a filter that returned a row.
        "overdue": bool(pending.due_at and pending.due_at < now),
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
    if normalized in (DocType.ALLOCATION.value,
                      DocType.OWN_STOCK_ALLOCATION.value):
        # Through indents, not inventory.allocations directly: only this path hands
        # inventory the indent's project, generates the warehouse fulfilment drafts,
        # and pushes the indent's own status/allocated quantities forward. Calling
        # allocations.act() here approved the allocation and left the indent standing
        # still with nothing for the warehouse to pick against.
        from app.modules.indents import service as indent_service
        await indent_service.act_on_allocation(db, doc_id, action, user, comments)
    elif normalized == DocType.MR.value:
        from app.modules.inventory import service as inventory_service
        await inventory_service.act_on_mr(db, doc_id, action, user, comments)
    elif normalized == DocType.PO.value:
        from app.modules.procurement import service as procurement_service
        await procurement_service.act_on_po(db, doc_id, action, comments, user)
    elif normalized in {"ISSUE", "WH_ISSUE", DocType.OWN_STOCK_ISSUE.value}:
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
        return due < ist_now()

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


#: The audit entity `approve_indent` writes its per-line quantities under. Its presence
#: is the proof that an approval RECORDED numbers, which a row of zeros cannot give on
#: its own — see `_recorded_quantities`.
QUANTITY_AUDIT_ENTITY = "ind_indent_items"


async def _indents_with_recorded_quantities(
    db: AsyncSession, indent_ids: Iterable[int],
) -> set[int]:
    """Which of these indents have had quantities written by an approver.

    `approve_indent` logs every line's before/after under `ind_indent_items` (nothing
    else writes that entity), so one row of that audit is the durable record that a
    rung below actually entered numbers — including a deliberate zero, which the
    quantities themselves cannot distinguish from "never touched".
    """
    ids = {int(i) for i in indent_ids}
    if not ids:
        return set()
    rows = (await db.execute(
        select(AuditLog.entity_id)
        .where(AuditLog.entity_type == QUANTITY_AUDIT_ENTITY, AuditLog.entity_id.in_(ids))
        .distinct()
    )).scalars().all()
    return {int(row) for row in rows}


def _recorded_quantities(indent: Indent, audited: bool) -> bool:
    """Did the rung below actually record quantities on this indent.

    An approval only lowers the ceiling if it recorded something. An indent submitted
    before submit-time seeding existed, and approved through the plain
    `POST /indents/{id}/approve` (the indent screen's Approve button, or an API
    client), carries approved_qty 0 on every line — it recorded nothing. Reading that
    as "the level below approved none of it" collapsed the next approver's ceiling to
    zero: a number nobody entered, which silently wipes out the whole request.

    A quantity above zero says so by itself. Zeros need the audit trail, because an
    approver who deliberately cut a line to nothing writes exactly the same row as the
    legacy path that wrote nothing at all — and getting that backwards is how an indent
    cut to zero at one rung reappeared at the next asking for its full original
    quantity again.
    """
    if any(Decimal(str(line.approved_quantity or 0)) > 0 for line in indent.items):
        return True
    return audited


async def _has_previous_approval(db: AsyncSession, instance: Instance, indent: Indent) -> bool:
    """Has a level below this one actually recorded quantities on this indent.

    Shared by _load_indent_task (single-indent review) and the Consolidation batch
    builder, so the two screens can never disagree about whether a ceiling reads as
    the request or as what the previous level approved.
    """
    previous_approval = await db.scalar(select(func.count(Action.id)).where(
        Action.instance_id == instance.id,
        Action.action == ApprovalAction.APPROVED.value,
    ))
    if not previous_approval:
        return False
    audited = await _indents_with_recorded_quantities(db, [indent.id])
    return _recorded_quantities(indent, indent.id in audited)


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

    has_previous = await _has_previous_approval(db, instance, indent)
    return indent, instance, has_previous


def _plain(value: Decimal) -> str:
    """5.000 reads as 5 in a message an approver has to act on."""
    trimmed = value.normalize()
    return f"{trimmed:f}"


QUANTITY_STEP = Decimal("0.001")


def _quantize(value: Decimal) -> Decimal:
    """Round to what `ind_indent_items.approved_qty` (NUMERIC(16,3)) can hold.

    Rounding at write time instead would let 4.9995 clear a ceiling of 4.999 and then
    be stored as 5.000 — an increase, through the one door that must only reduce. We
    round down so what was validated is exactly what is stored.
    """
    return value.quantize(QUANTITY_STEP, rounding=ROUND_DOWN)


def _approval_ceiling(line, has_previous_approval: bool) -> Decimal:
    """The most this approver may pass on.

    Quantities only ever come down the ladder: the first approver is capped by the
    requested quantity, every later one by what the level below them approved.
    `has_previous_approval` is false until an approval has actually recorded
    quantities (see _load_indent_task), so an uninitialised line reads as the request
    rather than as zero.

    Never above the request, whatever `approved_qty` holds. A row written before this
    rule existed can carry more than was asked for, and the ceiling is the one number
    on this screen that must not be able to grow.
    """
    requested = _quantize(Decimal(str(line.quantity)))
    if not has_previous_approval:
        return requested
    return min(_quantize(Decimal(str(line.approved_quantity or 0))), requested)


def _approval_out(
    indent: Indent, instance: Instance, has_previous_approval: bool,
    *, can_return_for_correction: bool = False,
) -> ApprovalIndentOut:
    items = [
        ApprovalIndentLineOut(
            id=line.id,
            item_id=line.item_id,
            item_code=line.item_code,
            item_name=line.item_name,
            uom_code=line.uom_code,
            requested_quantity=float(line.quantity),
            approved_quantity=float(_approval_ceiling(line, has_previous_approval)),
            max_quantity=float(_approval_ceiling(line, has_previous_approval)),
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
        can_return_for_correction=can_return_for_correction,
        created_at=indent.created_at,
        items=items,
    )


async def get_indent_for_approval(
    db: AsyncSession, indent_id: int, user,
) -> ApprovalIndentOut:
    indent, instance, has_previous = await _load_indent_task(db, indent_id, user)
    can_return = await indent_service.can_return_indent_for_correction(db, indent, user)
    return _approval_out(
        indent, instance, has_previous, can_return_for_correction=can_return,
    )


# ---------------- Monthly indent consolidation ----------------
#
# A consolidation batch stores nothing: it is a GROUP BY, computed fresh on every
# request, over exactly the same wf_pending/wf_instances/ind_indents rows that
# Waiting for Me reads. Every original indent keeps its own row, its own wf_instances
# chain and its own wf_actions history untouched — this is a read-only view over
# them, never a merge. See memory: indent-consolidation-no-new-table.
#
# Why this needs no new hierarchy logic: the ladder already resolves each Monthly
# indent's next approver independently (platform/workflow/engine.py), so "every
# Monthly indent currently pending with approver X" is already sitting in wf_pending
# with approver_id = X. Grouping those rows by (cycle, region, project) reproduces
# "ST-1..4 report to OE-1" -> one batch for OE-1, and once each is approved and the
# ladder climbs a rung, the same query run as DM-1 reproduces the next level — with
# no code that knows about OE/DM/RM/SPH/COO by name.

async def _monthly_pending_indents(
    db: AsyncSession, user,
) -> list[tuple[Indent, Instance, bool]]:
    """Monthly indents currently pending at this approver's stage.

    Two queries rather than one join-and-selectinload: wf_pending/wf_instances name
    the doc_ids in play, ind_indents needs its items eager-loaded to sum quantities,
    and doing that through a join would re-fetch the instance per line.
    """
    pending_rows = (await db.execute(
        select(Pending.doc_id, Instance)
        .join(Instance, Instance.id == Pending.instance_id)
        .where(
            Pending.approver_id == user.id,
            Pending.doc_type == DocType.INDENT.value,
            Instance.status == InstanceStatus.IN_PROGRESS.value,
        )
    )).all()
    if not pending_rows:
        return []
    instance_by_doc_id = {doc_id: instance for doc_id, instance in pending_rows}

    indents = (await db.execute(
        select(Indent)
        .options(selectinload(Indent.items))
        .where(
            Indent.id.in_(instance_by_doc_id),
            Indent.indent_type == IndentType.MONTHLY.value,
        )
    )).scalars().all()

    # One grouped COUNT for the whole queue instead of `_has_previous_approval` per
    # indent: the same answer, but a consolidation with 200 Monthly indents costs three
    # queries rather than 401. The Python half of the rule stays identical to the
    # single-indent screen's — both go through `_recorded_quantities`.
    approved_counts = dict((await db.execute(
        select(Action.instance_id, func.count(Action.id))
        .where(
            Action.instance_id.in_([i.id for i in instance_by_doc_id.values()]),
            Action.action == ApprovalAction.APPROVED.value,
        )
        .group_by(Action.instance_id)
    )).all())
    audited = await _indents_with_recorded_quantities(db, [i.id for i in indents])

    out = []
    for indent in indents:
        instance = instance_by_doc_id[indent.id]
        has_previous = bool(approved_counts.get(instance.id)) and _recorded_quantities(
            indent, indent.id in audited,
        )
        out.append((indent, instance, has_previous))
    return out


# The cycle key lives in indents, which owns the concept. It was duplicated here and
# the two copies had to agree forever or "approve the March lot" and "issue the March
# lot" would quietly mean different sets of indents.
from app.modules.indents.service import cycle_key as _cycle_key   # noqa: E402
# The consolidation DOCUMENT the indents belong to. Monthly indents join it at submit,
# so this screen can name the batch the same way the Fulfilment Queue and Allocation
# Approvals name it — `CON/2026-27/00001`, not a made-up `CONS-2026-08`. Same reason
# the cycle key is imported rather than copied: one concept, one owner.
from app.modules.indents.service import (  # noqa: E402
    _consolidations_by_key as _consolidation_docs,
    consolidation_key as _consolidation_key,
)


_MONTH_NAMES = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)


def _month_label(cycle: str) -> str:
    if cycle == "UNDATED":
        return "Undated"
    year, _, month = cycle.partition("-")
    try:
        return f"{_MONTH_NAMES[int(month) - 1]} {year}"
    except (ValueError, IndexError):
        return cycle


# ---------------- Filter dimensions ----------------
#
# Every dimension below is an EXISTING snapshot column on ind_indents (region_id,
# project_id, vehicle_id, office_id, requested_by_id) or an existing line column
# (ind_indent_items.item_id). Nothing here needs a join, a migration or a new column.
#
# "Phase" was asked for and is NOT here: neither ind_indents nor the hcm_ mirror has a
# phase / sub-project / stage-of-project column, and inventing one would mean a
# migration. The screen therefore never offers a Phase control. (`phases` in
# indents/schemas.py is the document's own journey — Draft/Submitted/Allocation/… —
# not an organisational dimension, and is not it.)

_DIMENSIONS = {
    "region": (lambda i: i.region_id, lambda i: i.region_name),
    "project": (lambda i: i.project_id, lambda i: i.project_name),
    "vehicle": (lambda i: i.vehicle_id, lambda i: i.vehicle_number),
    "office": (lambda i: i.office_id, lambda i: i.office_name),
    "requester": (lambda i: i.requested_by_id, lambda i: i.requested_by_name),
}


def _matches(indent: Indent, filters: ConsolidationFilters) -> bool:
    """AND across dimensions — picking Region A then Project 2 narrows, never widens.

    A filter on a dimension the indent has no value for excludes it: asking for
    Region A is asking for Region A, and an indent whose requester HCM has no
    location for is not in Region A.
    """
    # Either key: the month (what the cycle dropdown offers) or the consolidation
    # document (what a batch is now keyed and linked by). One filter, both spellings,
    # so a bookmarked `?cycle=2026-08` keeps working next to a `?cycle=C2` batch link.
    if filters.cycle and filters.cycle not in (
            _cycle_key(indent),
            _consolidation_key(getattr(indent, "consolidation_id", None), indent)):
        return False
    if filters.region_id is not None and indent.region_id != filters.region_id:
        return False
    if filters.project_id is not None and indent.project_id != filters.project_id:
        return False
    if filters.vehicle_id is not None and indent.vehicle_id != filters.vehicle_id:
        return False
    if filters.office_id is not None and indent.office_id != filters.office_id:
        return False
    if filters.requester_id is not None and indent.requested_by_id != filters.requester_id:
        return False
    if filters.item_id is not None and not any(
        line.item_id == filters.item_id for line in indent.items
    ):
        return False
    # Raised-on window, inclusive at both ends. Compared as dates: the filter is a
    # day, and an indent raised at 18:00 belongs to that day, not to the one after.
    raised = getattr(indent, "created_at", None)
    raised_day = raised.date() if raised is not None else None
    if filters.raised_from and (raised_day is None or raised_day < filters.raised_from):
        return False
    if filters.raised_to and (raised_day is None or raised_day > filters.raised_to):
        return False
    if filters.search:
        needle = filters.search.lower()
        haystack = [
            indent.indent_no, indent.requested_by_name, indent.requested_by_code,
            indent.region_name, indent.project_name, indent.office_name,
            indent.vehicle_number,
        ]
        haystack += [line.item_name for line in indent.items]
        haystack += [line.item_code for line in indent.items]
        if not any(value and needle in value.lower() for value in haystack):
            return False
    return True


def _lines(indent: Indent, filters: ConsolidationFilters) -> list:
    """The lines a total is built from. Only the Item filter narrows them: filtering
    to Helmet must show Helmet's quantity, not the whole indent's."""
    if filters.item_id is None:
        return list(indent.items)
    return [line for line in indent.items if line.item_id == filters.item_id]


def _filter_options(members: list) -> ConsolidationFilterOptionsOut:
    """Dropdown contents, counted over the approver's UNFILTERED pending set.

    Unfiltered on purpose: options built from the filtered set would empty out the
    moment a filter is applied and leave no way back except Clear Filters. A
    dimension no indent carries a value for yields an empty list, and the screen
    hides that control entirely.
    """
    counts: dict[str, dict[str, tuple[str, int]]] = {name: {} for name in _DIMENSIONS}
    counts["cycle"] = {}
    counts["item"] = {}

    for indent, _instance, _has_previous in members:
        for name, (get_id, get_label) in _DIMENSIONS.items():
            value = get_id(indent)
            if value is None:
                continue
            label, count = counts[name].get(str(value), (get_label(indent) or str(value), 0))
            counts[name][str(value)] = (label, count + 1)

        cycle = _cycle_key(indent)
        label, count = counts["cycle"].get(cycle, (_month_label(cycle), 0))
        counts["cycle"][cycle] = (label, count + 1)

        # Once per indent per item, not once per line: "how many indents ask for
        # Helmet" is the number the dropdown means.
        for item_id in {line.item_id for line in indent.items}:
            sample = next(l for l in indent.items if l.item_id == item_id)
            label, count = counts["item"].get(
                str(item_id), (sample.item_name or sample.item_code or str(item_id), 0))
            counts["item"][str(item_id)] = (label, count + 1)

    def options(name: str) -> list[ConsolidationFilterOptionOut]:
        return [
            ConsolidationFilterOptionOut(value=value, label=label, indent_count=count)
            for value, (label, count) in sorted(counts[name].items(), key=lambda kv: kv[1][0])
        ]

    return ConsolidationFilterOptionsOut(
        cycle=sorted(options("cycle"), key=lambda o: o.value, reverse=True),
        region=options("region"), project=options("project"), vehicle=options("vehicle"),
        office=options("office"), requester=options("requester"), item=options("item"),
    )


def _only(values: set):
    """The single distinct value, or None when the set spans more than one."""
    real = {v for v in values if v is not None}
    return next(iter(real)) if len(real) == 1 else None


def _build_batch(
    cycle: str, group: list, filters: ConsolidationFilters,
    decimals_by_uom: dict[str, int] | None = None,
    doc=None,
) -> ConsolidationBatchOut:
    items_totals: dict[int, dict] = {}
    for indent, _instance, has_previous in group:
        for line in _lines(indent, filters):
            bucket = items_totals.setdefault(line.item_id, {
                "item_id": line.item_id, "item_code": line.item_code,
                "item_name": line.item_name, "uom_code": line.uom_code,
                "total_requested_quantity": Decimal("0"),
                "total_ceiling_quantity": Decimal("0"),
                "indent_count": 0,
                "allocations": [],
            })
            requested = _quantize(Decimal(str(line.quantity)))
            ceiling = _approval_ceiling(line, has_previous)
            bucket["total_requested_quantity"] += requested
            bucket["total_ceiling_quantity"] += ceiling
            bucket["indent_count"] += 1
            bucket["allocations"].append(ConsolidatedItemAllocationOut(
                indent_id=indent.id,
                indent_no=indent.indent_no,
                line_id=line.id,
                requested_by_name=indent.requested_by_name,
                requested_quantity=float(requested),
                ceiling_quantity=float(ceiling),
            ))

    indent_summaries = []
    for indent, instance, has_previous in sorted(group, key=lambda m: m[0].indent_no):
        lines = _lines(indent, filters)
        indent_summaries.append(ConsolidationIndentSummaryOut(
            id=indent.id,
            indent_no=indent.indent_no,
            status=indent.status,
            requested_by_id=indent.requested_by_id,
            requested_by_name=indent.requested_by_name,
            requested_by_code=indent.requested_by_code,
            region_id=indent.region_id,
            region_name=indent.region_name,
            project_id=indent.project_id,
            project_name=indent.project_name,
            office_id=indent.office_id,
            office_name=indent.office_name,
            vehicle_id=indent.vehicle_id,
            vehicle_number=indent.vehicle_number,
            current_stage_name=instance.current_stage_name,
            line_count=len(lines),
            total_requested_quantity=float(
                sum((_quantize(Decimal(str(l.quantity))) for l in lines), Decimal("0")),
            ),
            previous_approved_quantity=(
                float(sum(
                    (_approval_ceiling(l, has_previous) for l in lines), Decimal("0"),
                )) if has_previous else None
            ),
            current_ceiling_quantity=float(
                sum((_approval_ceiling(l, has_previous) for l in lines), Decimal("0")),
            ),
        ))

    indents = [i for i, _, _ in group]
    # The month the DOCUMENT is for, not the key it is filed under: once indents group
    # by consolidation the key reads `C2`, which is nobody's idea of a month.
    month = doc.cycle if doc is not None else cycle
    return ConsolidationBatchOut(
        batch_key=cycle,
        cycle=cycle,
        consolidation_no=getattr(doc, "consolidation_no", None),
        consolidation_status=getattr(doc, "status", None),
        month_label=_month_label(month),
        region_id=_only({i.region_id for i in indents}),
        region_name=_only({i.region_name for i in indents}),
        project_id=_only({i.project_id for i in indents}),
        project_name=_only({i.project_name for i in indents}),
        current_stage_name=group[0][1].current_stage_name,
        indent_count=len(group),
        requester_count=len({i.requested_by_id for i in indents}),
        project_count=len({i.project_id for i in indents if i.project_id is not None}),
        region_count=len({i.region_id for i in indents if i.region_id is not None}),
        requesters=sorted({i.requested_by_name for i in indents if i.requested_by_name}),
        consolidated_items=[
            ConsolidatedItemOut(
                item_id=v["item_id"], item_code=v["item_code"], item_name=v["item_name"],
                uom_code=v["uom_code"],
                # How finely this unit may be split, so the screen's proportional share
                # cannot offer somebody 5.7 of something counted in whole numbers. An
                # unknown code keeps the old three decimals.
                uom_decimals=(decimals_by_uom or {}).get(v["uom_code"], MAX_DECIMALS),
                total_requested_quantity=float(v["total_requested_quantity"]),
                total_ceiling_quantity=float(v["total_ceiling_quantity"]),
                indent_count=v["indent_count"],
                allocations=sorted(v["allocations"], key=lambda a: a.indent_no),
            )
            for v in sorted(items_totals.values(), key=lambda v: v["item_code"] or "")
        ],
        indents=indent_summaries,
    )


async def consolidation_batches_for_user(
    db: AsyncSession, user, filters: ConsolidationFilters | None = None,
) -> list[ConsolidationBatchOut]:
    """One batch per monthly cycle, holding the indents that survive `filters`.

    Region/project/vehicle/office/requester/item narrow what is inside a cycle; they
    never split it into more cycles. An empty cycle is dropped rather than returned
    with zero indents.
    """
    filters = filters or ConsolidationFilters()
    members = await _monthly_pending_indents(db, user)
    return _batches_from(members, filters, await _member_uom_decimals(db, members),
                         await _docs_for(db, members))


async def _docs_for(db: AsyncSession, members: list) -> dict:
    """{key: Consolidation} for the batches these indents form, in one query."""
    return await _consolidation_docs(db, {
        _consolidation_key(getattr(indent, "consolidation_id", None), indent)
        for indent, _instance, _has_previous in members
    })


async def _member_uom_decimals(db: AsyncSession, members: list) -> dict[str, int]:
    """{uom_code: decimals} for every unit in this queue, in one query."""
    return await decimals_by_code(db, {
        line.uom_code for indent, _instance, _has_previous in members
        for line in indent.items
    })


def _batches_from(
    members: list, filters: ConsolidationFilters,
    decimals_by_uom: dict[str, int] | None = None,
    docs: dict | None = None,
) -> list[ConsolidationBatchOut]:
    """Grouped by the consolidation DOCUMENT, falling back to the month for indents
    raised before documents existed. Grouping on the month alone put every August
    indent in one heap and named it `CONS-2026-08`, while the fulfilment and allocation
    screens were already calling the same set `CON/2026-27/00001`. Same set, three
    names — and once a document is sealed, the month is no longer even the same set."""
    groups: dict[str, list] = defaultdict(list)
    for indent, instance, has_previous in members:
        if _matches(indent, filters):
            key = _consolidation_key(getattr(indent, "consolidation_id", None), indent)
            groups[key].append((indent, instance, has_previous))

    batches = [_build_batch(cycle, group, filters, decimals_by_uom,
                            (docs or {}).get(cycle))
               for cycle, group in groups.items()]
    batches.sort(key=lambda b: b.cycle, reverse=True)
    return batches


async def consolidation_workspace(
    db: AsyncSession, user, filters: ConsolidationFilters | None = None,
) -> ConsolidationOut:
    """The whole screen in one round trip: filtered batches + the dropdown contents.

    The approver's Monthly pending set is read ONCE and both halves are derived from
    it in memory — the filter bar costs no extra query, and adding a filter costs one
    request, not one per dropdown.
    """
    filters = filters or ConsolidationFilters()
    members = await _monthly_pending_indents(db, user)
    batches = _batches_from(members, filters, await _member_uom_decimals(db, members),
                            await _docs_for(db, members))
    return ConsolidationOut(
        items=batches,
        filter_options=_filter_options(members),
        applied={k: v for k, v in filters.as_dict().items() if v is not None},
        total_indent_count=sum(b.indent_count for b in batches),
        total_requester_count=len({
            row.requested_by_id for b in batches for row in b.indents
            if row.requested_by_id is not None
        }),
        unfiltered_indent_count=len(members),
    )


def _validated_quantities(
    indent: Indent, submitted: list[ApprovalQuantityIn],
    has_previous_approval: bool = False,
) -> dict[int, Decimal]:
    by_id: dict[int, Decimal] = {}
    for item in submitted:
        if item.line_id in by_id:
            raise ValidationError(f"Quantity for line {item.line_id} was submitted twice")
        by_id[item.line_id] = _quantize(Decimal(str(item.approved_quantity)))

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
        ceiling = _approval_ceiling(line, has_previous_approval)
        label = line.item_name or line.item_code or line.id
        if approved < 0:
            raise ValidationError(f"Approved quantity for {label} cannot be negative")
        if approved > ceiling:
            source = (
                "the quantity approved at the previous level"
                if has_previous_approval else "the requested quantity"
            )
            raise ValidationError(
                f"Approved quantity for {label} cannot exceed {source} "
                f"({_plain(ceiling)}). An approver may only reduce it."
            )
    return by_id


async def _nothing_owed(db: AsyncSession, indent) -> bool:
    """Every line already covered, and something actually covers it.

    Covered means approved-and-allocated OR promised by a live allocation somebody has
    raised but nobody has signed yet — an approver who commits their whole stock has
    finished the indent even though `allocated_quantity` will not move until the
    allocation clears its own ladder.

    The "and something actually covers it" half matters: a fresh indent has 0
    allocated against 0 approved on every line until this very call sets the
    quantities, and reading that as "fully served" would end every ladder at the
    first rung.
    """
    from .fulfilment import committed_by_line, remainder_of

    committed = await committed_by_line(db, indent.id)
    owed = sum(
        max(remainder_of(line) - committed.get(line.id, Decimal("0")), Decimal("0"))
        for line in indent.items
    )
    covered = sum(
        Decimal(str(line.allocated_quantity or 0)) + committed.get(line.id, Decimal("0"))
        for line in indent.items
    )
    return covered > 0 and owed == 0


async def approve_indent(
    db: AsyncSession, indent_id: int, quantities: list[ApprovalQuantityIn],
    comments: str, user, task: tuple[Indent, Instance, bool] | None = None,
) -> ApprovalIndentOut:
    """`task` is the already-loaded (indent, instance, has_previous) for callers that
    have just validated it — the consolidated approval, which would otherwise pay for
    the same three-query load twice per indent, 900 times over. Loaded here when it is
    not supplied, so the single-indent route is unchanged."""
    indent, instance, has_previous = task or await _load_indent_task(db, indent_id, user)
    approved_by_line = _validated_quantities(indent, quantities, has_previous)

    before: dict[str, float] = {}
    after: dict[str, float] = {}
    for line in indent.items:
        before[f"line_{line.id}_approved_qty"] = float(
            _approval_ceiling(line, has_previous)
        )
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

    # Nothing left owed on any line: everything has been allocated already, so the
    # rungs above have nothing to decide. Ending the ladder here is what stops a
    # fully-served indent travelling to the DM for goods that are already committed.
    updated = await indent_service.act_on_indent(
        db, indent_id, ApprovalAction.APPROVED, comments, user,
        final=await _nothing_owed(db, indent),
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


async def approve_consolidation(
    db: AsyncSession, body: ConsolidationApprovalIn, user,
) -> ConsolidationApprovalOut:
    """Approve every indent the Consolidation screen currently shows, in one act.

    The screen sends the per-line quantities its split produced; any line it does not
    mention keeps this approver's ceiling, so approving without touching a quantity
    passes the request on unchanged. Each indent still goes through
    `approve_indent` — the engine owns the chain (rule 8) and every document gets its
    own `wf_actions` row, exactly as if the approver had opened each one.

    Not atomic across indents by design: one indent that has moved on since the
    screen loaded must not block the rest. Its id comes back under `failed` with the
    reason, and the caller refreshes.
    """
    quantities_by_indent: dict[int, list[ApprovalQuantityIn]] = defaultdict(list)
    for line in body.lines:
        quantities_by_indent[line.indent_id].append(
            ApprovalQuantityIn(line_id=line.line_id, approved_quantity=line.approved_quantity),
        )

    approved: list[int] = []
    failed: list[ConsolidationApprovalFailureOut] = []
    for indent_id in body.indent_ids:
        try:
            quantities = quantities_by_indent.get(indent_id)
            # ONE load per indent for the whole approval. This used to read the indent
            # three times over — `db.get` for the served check, `_load_indent_task` for
            # the ceilings, and `_load_indent_task` again inside `approve_indent` — plus
            # their instance and pending lookups. On a 900-indent cycle that is thousands
            # of round trips spent re-reading rows already in hand, and it is most of why
            # signing a month took minutes. The task is handed down instead.
            task = await _load_indent_task(db, indent_id, user)
            indent, _instance, has_previous = task
            # Already served in full — approving it again would only push a settled
            # document up the ladder. Reported rather than silently dropped so the
            # screen can say why it is not in the approved count.
            if await _nothing_owed(db, indent):
                failed.append(ConsolidationApprovalFailureOut(
                    indent_id=indent_id,
                    reason="Already served in full — nothing left to send on.",
                    skipped=True,
                ))
                continue
            if not quantities:
                # Nothing edited for this indent: hand on what it is already entitled
                # to rather than sending an empty list, which approve_indent rejects.
                quantities = [
                    ApprovalQuantityIn(
                        line_id=line.id,
                        approved_quantity=float(_approval_ceiling(line, has_previous)),
                    )
                    for line in indent.items
                ]
            await approve_indent(db, indent_id, quantities, body.comments, user, task=task)
            approved.append(indent_id)
        except AppException as exc:
            # One document's problem is not the batch's: record it and carry on.
            await db.rollback()
            # The rollback expires `user` too; without this the NEXT indent dies on a
            # lazy reload outside async context and 500s the whole consolidation.
            await db.refresh(user)
            failed.append(ConsolidationApprovalFailureOut(
                indent_id=indent_id, reason=str(getattr(exc, "message", None) or exc),
            ))

    return ConsolidationApprovalOut(
        approved_count=len(approved), approved_indent_ids=approved, failed=failed,
    )


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
    """Return for correction: same engine-backed flow as `/api/indents/{id}/
    return-for-correction` (`indent_service.return_indent_for_correction`), which
    the frontend actually calls. This route must not carry its own divergent
    implementation — a second "return" that cancelled the instance and dropped the
    indent to DRAFT used to live here, which silently reset the approval chain and
    disagreed with RETURNED_FOR_CORRECTION on resubmit (fresh instance instead of
    resuming the same rung). Delegating keeps exactly one return-for-correction
    behavior regardless of which endpoint a caller uses.
    """
    indent, instance, has_previous = await _load_indent_task(db, indent_id, user)
    updated = await indent_service.return_indent_for_correction(db, indent_id, comments, user)
    return _approval_out(updated, instance, has_previous)


# ---------------- Monthly allocation cycles in the approval inbox ----------------
#
# A monthly cycle's allocations were only reachable from Inventory > Allocation
# Approvals. Somebody living in the Approvals module — which is where every other
# approval lands — had no way to see or sign them, so a cycle sat waiting while the
# approver's inbox said there was nothing to do.
#
# Delegated rather than reimplemented: `indents.service.allocation_approval_batches`
# already builds these, already applies `_indent_visibility` (the rung), and already
# marks which ones the caller's ACTIVE position may sign. Writing a second query here
# would be a second scope rule to keep in step with the first.

async def allocation_cycles_for_user(db: AsyncSession, user) -> list[dict]:
    """Monthly allocation cycles awaiting this approver, for the approval inbox."""
    from app.modules.indents.service import allocation_approval_batches

    batches = await allocation_approval_batches(db, user)
    return [{
        "cycle": batch["cycle"],
        "month_label": batch["month_label"],
        # The document number, so the inbox names the same thing the cycle screen
        # does when a month holds more than one consolidation.
        "consolidation_no": batch["consolidation_no"],
        "allocation_count": batch["allocation_count"],
        "actionable_count": batch["actionable_count"],
        "indent_count": batch["indent_count"],
        "item_count": batch["item_count"],
        "total_qty": batch["total_qty"],
        # Where the inbox sends them. The same screen Inventory links to, so a cycle
        # is signed in one place however it was reached.
        "href": f"/inventory/allocation-approvals/cycle/{batch['cycle']}",
        "doc_type": DocType.ALLOCATION.value,
    } for batch in batches]
