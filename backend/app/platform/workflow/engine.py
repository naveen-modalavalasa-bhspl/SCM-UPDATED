"""The approval engine. Modules use ONLY these five functions; they never touch
the wf_ tables directly.

Rules honoured:
- Fail loudly: no active workflow for a doc_type -> error at submit time.
- A running instance keeps its original workflow definition (workflow_id pinned;
  conditions evaluated against the instance's stored submit-time context).
- The engine owns the approval chain; the module owns the document status.
- approval_actions rows are append-only (never deleted).
Engine functions flush but do not commit — the calling module owns the transaction.
"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import PermissionError_, ValidationError
from app.platform.hcm import service as hcm_service
from app.platform.workflow import resolver
from app.platform.workflow.conditions import stage_applies
from app.platform.workflow.models import (
    Action, Instance, Pending, Stage, StageCondition, Workflow,
)
from app.shared.enums import ApprovalAction, ApprovalMode, ApproverType, InstanceStatus
from app.shared.models.base import utcnow

_ACTION_ALIASES = {
    "APPROVE": ApprovalAction.APPROVED.value,
    "REJECT": ApprovalAction.REJECTED.value,
    "RETURN": ApprovalAction.RETURNED.value,
}


def _normalize_action(action: str) -> str:
    a = action.upper()
    return _ACTION_ALIASES.get(a, a)


async def _active_workflow(db: AsyncSession, doc_type: str) -> Workflow:
    wf = (await db.execute(
        select(Workflow).where(Workflow.doc_type == doc_type, Workflow.is_active.is_(True))
        .order_by(Workflow.id.desc())
    )).scalars().first()
    if wf is None:
        raise ValidationError(f"No active approval workflow for doc type {doc_type}")
    return wf


async def _stages(db: AsyncSession, workflow_id: int) -> list[Stage]:
    return list((await db.execute(
        select(Stage).where(Stage.workflow_id == workflow_id).order_by(Stage.sequence)
    )).scalars().all())


async def _conditions(db: AsyncSession, stage_id: int) -> list[StageCondition]:
    return list((await db.execute(
        select(StageCondition).where(StageCondition.stage_id == stage_id)
    )).scalars().all())


async def _applicable_stages(db: AsyncSession, workflow_id: int, context: dict) -> list[Stage]:
    out = []
    for stage in await _stages(db, workflow_id):
        conds = await _conditions(db, stage.id)
        if stage_applies(conds, context):
            out.append(stage)
    return out


async def _get_stage(db: AsyncSession, workflow_id: int, sequence: int) -> Stage:
    stage = (await db.execute(
        select(Stage).where(Stage.workflow_id == workflow_id, Stage.sequence == sequence)
    )).scalars().first()
    if stage is None:
        raise ValidationError("Approval stage not found")
    return stage


async def _load_instance(db: AsyncSession, doc_type: str, doc_id: int) -> Instance | None:
    return (await db.execute(
        select(Instance).where(Instance.doc_type == doc_type, Instance.doc_id == doc_id)
        .order_by(Instance.id.desc())
    )).scalars().first()


async def _stage_satisfied(db, instance, stage, approver_ids: set[int]) -> bool:
    approved = (await db.execute(
        select(Action.actor_id).where(
            Action.instance_id == instance.id,
            Action.stage_sequence == stage.sequence,
            Action.action == ApprovalAction.APPROVED.value,
        )
    )).scalars().all()
    count = len({a for a in approved if a in approver_ids})
    total = len(approver_ids)
    mode = stage.approval_mode
    if mode == ApprovalMode.ALL.value:
        return total > 0 and count >= total
    if mode == ApprovalMode.MAJORITY.value:
        return total > 0 and count > total / 2
    return count >= 1   # ANY_ONE (default)


async def _clear_pending(db: AsyncSession, instance_id: int) -> None:
    rows = (await db.execute(
        select(Pending).where(Pending.instance_id == instance_id)
    )).scalars().all()
    for row in rows:
        await db.delete(row)


async def _materialize_pending(
    db: AsyncSession, instance: Instance, stage: Stage, context: dict,
) -> list:
    approvers = await resolver.resolve_approvers(db, stage, instance, context)
    if not approvers:
        raise ValidationError(f"No approver found for workflow stage {stage.name}")
    for approver in approvers:
        db.add(Pending(
            instance_id=instance.id,
            stage_sequence=stage.sequence,
            approver_id=approver.id,
            doc_type=instance.doc_type,
            doc_id=instance.doc_id,
            doc_no=instance.doc_no,
            doc_summary=context.get("doc_summary"),
            requested_by_name=instance.started_by_name,
            amount=context.get("amount"),
            due_at=instance.due_at,
        ))
    await db.flush()
    return approvers


# ---------------- public API (the only five) ----------------

async def start(db, doc_type: str, doc_id: int, context: dict, user) -> Instance:
    wf = await _active_workflow(db, doc_type)
    applicable = await _applicable_stages(db, wf.id, context)

    instance = Instance(
        doc_type=doc_type, doc_id=doc_id, workflow_id=wf.id,
        doc_no=context.get("doc_no"),
        started_by_id=user.id, started_by_name=user.full_name,
        status=InstanceStatus.IN_PROGRESS.value,
    )
    if applicable:
        instance.current_sequence = applicable[0].sequence
        instance.current_stage_name = applicable[0].name
    else:  # a workflow with no applicable stage is nothing to approve
        instance.status = InstanceStatus.APPROVED.value
        instance.completed_at = utcnow()
    db.add(instance)
    await db.flush()

    db.add(Action(
        instance_id=instance.id, stage_sequence=0, stage_name="Submitted",
        actor_id=user.id, actor_name=user.full_name,
        actor_position=context.get("requester_position_name"),
        action=ApprovalAction.SUBMITTED.value,
    ))
    await db.flush()
    if applicable:
        await _materialize_pending(db, instance, applicable[0], context)
    return instance


async def act(db, doc_type: str, doc_id: int, action: str, user, comments: str = "",
              context: dict | None = None) -> Instance:
    instance = await _load_instance(db, doc_type, doc_id)
    if instance is None or instance.status != InstanceStatus.IN_PROGRESS.value:
        raise ValidationError("No in-progress approval for this document")

    action = _normalize_action(action)
    context = context or {}
    stage = await _get_stage(db, instance.workflow_id, instance.current_sequence)
    pending = (await db.execute(
        select(Pending).where(
            Pending.instance_id == instance.id,
            Pending.stage_sequence == stage.sequence,
        )
    )).scalars().all()
    pending_ids = {row.approver_id for row in pending}
    previously_approved = set((await db.execute(
        select(Action.actor_id).where(
            Action.instance_id == instance.id,
            Action.stage_sequence == stage.sequence,
            Action.action == ApprovalAction.APPROVED.value,
        )
    )).scalars().all())
    approver_ids = pending_ids | previously_approved
    approvers = [
        employee for employee in [
            await hcm_service.get_employee(db, employee_id) for employee_id in approver_ids
        ] if employee is not None
    ]
    approver_ids = {a.id for a in approvers}
    if user.id not in pending_ids:
        raise PermissionError_("You are not a valid approver for the current stage")
    active_position_id = getattr(user, "active_position_id", None)
    if stage.approver_type == ApproverType.POSITION.value:
        if active_position_id != stage.position_id:
            raise PermissionError_("Switch to the approval position before acting")
    elif stage.approver_type == ApproverType.REPORTING_MANAGER.value:
        requester_position = await hcm_service.get_position(
            db, context.get("requester_position_id"),
        ) if context.get("requester_position_id") else None
        if not requester_position or active_position_id != requester_position.parent_position_id:
            raise PermissionError_("Switch to the reporting-manager position before acting")

    active_position = await hcm_service.get_position(
        db, active_position_id,
    ) if active_position_id else None
    db.add(Action(
        instance_id=instance.id, stage_sequence=stage.sequence, stage_name=stage.name,
        actor_id=user.id, actor_name=user.full_name,
        actor_position=active_position.name if active_position else None,
        action=action, comments=comments,
    ))
    await db.flush()

    if action == ApprovalAction.APPROVED.value:
        for row in pending:
            if row.approver_id == user.id:
                await db.delete(row)

    if action == ApprovalAction.REJECTED.value:
        instance.status = InstanceStatus.REJECTED.value
        instance.completed_at = utcnow()
        await _clear_pending(db, instance.id)
        await db.flush()
        return instance

    applicable = await _applicable_stages(db, instance.workflow_id, context)

    if action == ApprovalAction.RETURNED.value:
        prev = [s for s in applicable if s.sequence < stage.sequence]
        target = prev[-1] if prev else stage
        instance.current_sequence = target.sequence
        instance.current_stage_name = target.name
        await _clear_pending(db, instance.id)
        await _materialize_pending(db, instance, target, context)
        await db.flush()
        return instance

    # APPROVED
    if await _stage_satisfied(db, instance, stage, approver_ids):
        await _clear_pending(db, instance.id)
        nxt = [s for s in applicable if s.sequence > stage.sequence]
        if nxt:
            instance.current_sequence = nxt[0].sequence
            instance.current_stage_name = nxt[0].name
            await _materialize_pending(db, instance, nxt[0], context)
        else:
            instance.status = InstanceStatus.APPROVED.value
            instance.completed_at = utcnow()
            instance.current_stage_name = None
    await db.flush()
    return instance


async def current_approvers(db, doc_type: str, doc_id: int) -> list:
    instance = await _load_instance(db, doc_type, doc_id)
    if instance is None or instance.status != InstanceStatus.IN_PROGRESS.value:
        return []
    ids = (await db.execute(
        select(Pending.approver_id).where(Pending.instance_id == instance.id)
    )).scalars().all()
    employees = [await hcm_service.get_employee(db, employee_id) for employee_id in ids]
    return [employee for employee in employees if employee is not None]


async def pending_for_user(db, user) -> list[dict]:
    rows = (await db.execute(
        select(Pending).where(Pending.approver_id == user.id)
        .order_by(Pending.created_at.desc())
    )).scalars().all()
    return [{
        "instance_id": row.instance_id, "doc_type": row.doc_type,
        "doc_id": row.doc_id, "stage_sequence": row.stage_sequence,
        "doc_no": row.doc_no, "summary": row.doc_summary,
        "requested_by_name": row.requested_by_name,
    } for row in rows]


async def history(db, doc_type: str, doc_id: int) -> list[Action]:
    instance = await _load_instance(db, doc_type, doc_id)
    if instance is None:
        return []
    return list((await db.execute(
        select(Action).where(Action.instance_id == instance.id).order_by(Action.acted_at, Action.id)
    )).scalars().all())
