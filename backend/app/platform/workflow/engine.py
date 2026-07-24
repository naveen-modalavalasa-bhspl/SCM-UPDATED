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
from app.platform.workflow import resolver
from app.platform.workflow.conditions import stage_applies
from app.platform.workflow.models import (
    Action, Instance, Stage, StageCondition, Workflow,
)
from app.shared.enums import ApprovalAction, ApprovalMode, InstanceStatus
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
        select(Action.actor_user_id).where(
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


# ---------------- public API (the only five) ----------------

async def start(db, doc_type: str, doc_id: int, context: dict, user) -> Instance:
    wf = await _active_workflow(db, doc_type)
    applicable = await _applicable_stages(db, wf.id, context)

    instance = Instance(
        doc_type=doc_type, doc_id=doc_id, workflow_id=wf.id,
        context=context or {}, started_by=user.id,
        status=InstanceStatus.IN_PROGRESS.value,
    )
    if applicable:
        instance.current_stage_sequence = applicable[0].sequence
    else:  # a workflow with no applicable stage is nothing to approve
        instance.status = InstanceStatus.APPROVED.value
        instance.completed_at = utcnow()
    db.add(instance)
    await db.flush()

    db.add(Action(instance_id=instance.id, stage_sequence=None,
                  actor_user_id=user.id, action=ApprovalAction.SUBMITTED.value))
    await db.flush()
    return instance


async def act(db, doc_type: str, doc_id: int, action: str, user, comments: str = "") -> Instance:
    instance = await _load_instance(db, doc_type, doc_id)
    if instance is None or instance.status != InstanceStatus.IN_PROGRESS.value:
        raise ValidationError("No in-progress approval for this document")

    action = _normalize_action(action)
    stage = await _get_stage(db, instance.workflow_id, instance.current_stage_sequence)
    approvers = await resolver.resolve_approvers(db, stage, instance, instance.context or {})
    approver_ids = {a.id for a in approvers}
    if user.id not in approver_ids:
        raise PermissionError_("You are not a valid approver for the current stage")

    db.add(Action(instance_id=instance.id, stage_sequence=stage.sequence,
                  actor_user_id=user.id, action=action, comments=comments))
    await db.flush()

    if action == ApprovalAction.REJECTED.value:
        instance.status = InstanceStatus.REJECTED.value
        instance.completed_at = utcnow()
        await db.flush()
        return instance

    applicable = await _applicable_stages(db, instance.workflow_id, instance.context or {})

    if action == ApprovalAction.RETURNED.value:
        prev = [s for s in applicable if s.sequence < stage.sequence]
        instance.current_stage_sequence = prev[-1].sequence if prev else stage.sequence
        await db.flush()
        return instance

    # APPROVED
    if await _stage_satisfied(db, instance, stage, approver_ids):
        nxt = [s for s in applicable if s.sequence > stage.sequence]
        if nxt:
            instance.current_stage_sequence = nxt[0].sequence
        else:
            instance.status = InstanceStatus.APPROVED.value
            instance.completed_at = utcnow()
    await db.flush()
    return instance


async def current_approvers(db, doc_type: str, doc_id: int) -> list:
    instance = await _load_instance(db, doc_type, doc_id)
    if instance is None or instance.status != InstanceStatus.IN_PROGRESS.value:
        return []
    stage = await _get_stage(db, instance.workflow_id, instance.current_stage_sequence)
    return await resolver.resolve_approvers(db, stage, instance, instance.context or {})


async def pending_for_user(db, user) -> list[dict]:
    instances = (await db.execute(
        select(Instance).where(Instance.status == InstanceStatus.IN_PROGRESS.value)
    )).scalars().all()
    out = []
    for instance in instances:
        stage = await _get_stage(db, instance.workflow_id, instance.current_stage_sequence)
        approvers = await resolver.resolve_approvers(db, stage, instance, instance.context or {})
        if any(a.id == user.id for a in approvers):
            out.append({
                "instance_id": instance.id, "doc_type": instance.doc_type,
                "doc_id": instance.doc_id, "stage_sequence": stage.sequence,
                "stage_name": stage.name,
            })
    return out


async def history(db, doc_type: str, doc_id: int) -> list[Action]:
    instance = await _load_instance(db, doc_type, doc_id)
    if instance is None:
        return []
    return list((await db.execute(
        select(Action).where(Action.instance_id == instance.id).order_by(Action.acted_at, Action.id)
    )).scalars().all())
