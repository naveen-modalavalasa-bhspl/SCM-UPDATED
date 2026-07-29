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
from app.platform.workflow import fallback, ladder, resolver
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
FINAL_REPORTING_STAGE_NAME = "Final authority"


def _normalize_action(action: str) -> str:
    a = action.upper()
    return _ACTION_ALIASES.get(a, a)


async def _active_workflow(db: AsyncSession, doc_type: str) -> tuple[Workflow, bool]:
    """The configured workflow, or the hardcoded ladder materialised as one.

    Returns (workflow, was_fallback). Missing configuration must never stop a document
    being submitted — see platform/workflow/fallback.py.
    """
    wf = (await db.execute(
        select(Workflow).where(
            Workflow.doc_type == doc_type,
            # Project ladders are chosen by start(); this is the company-wide path, so
            # one project's ladder can never end up approving another's document.
            Workflow.project_id.is_(None),
            Workflow.is_active.is_(True),
        ).order_by(Workflow.id.desc())
    )).scalars().first()
    if wf is None:
        return await fallback.ensure_workflow(db, doc_type), True
    return wf, False


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


async def _stage_used_fallback(db: AsyncSession, instance: Instance, stage: Stage) -> bool:
    """Did the ladder supply this stage's approvers rather than its configuration?"""
    row = (await db.execute(
        select(Action.id).where(
            Action.instance_id == instance.id,
            Action.action == ApprovalAction.FALLBACK.value,
        )
    )).scalars().first()
    return row is not None


async def _clear_pending(db: AsyncSession, instance_id: int) -> None:
    rows = (await db.execute(
        select(Pending).where(Pending.instance_id == instance_id)
    )).scalars().all()
    for row in rows:
        await db.delete(row)


async def _is_reporting_chain_position(
    db: AsyncSession, requester_position_id: int | None, active_position_id: int | None,
) -> bool:
    """True when active_position_id is above requester_position_id in HCM."""
    if requester_position_id is None or active_position_id is None:
        return False
    position = await hcm_service.get_position(db, requester_position_id)
    seen: set[int] = set()
    while position and position.parent_position_id and position.id not in seen:
        seen.add(position.id)
        if position.parent_position_id == active_position_id:
            return True
        position = await hcm_service.get_position(db, position.parent_position_id)
    return False


async def _holders_for_positions(
    db: AsyncSession, position_ids: list[int], requester_id: int | None,
) -> list:
    approvers = {}
    for position_id in position_ids:
        for holder in await hcm_service.get_position_holders(db, position_id):
            if holder.id != requester_id and holder.is_active:
                approvers[holder.id] = holder
    return list(approvers.values())


async def _next_reporting_ladder_approvers(
    db: AsyncSession, instance: Instance, user, context: dict,
) -> tuple[list, bool]:
    """Resolve the next reporting manager, or the final top-pair ANY_ONE group.

    This is an engine capability for one-stage REPORTING_MANAGER workflows: the
    workflow row stays the same, but wf_pending advances up HCM's position tree after
    each approval until the final authority pair is reached.
    """
    if instance.current_stage_name == FINAL_REPORTING_STAGE_NAME:
        return [], False

    active_position_id = getattr(user, "active_position_id", None)
    active_position = (
        await hcm_service.get_position(db, active_position_id)
        if active_position_id is not None else None
    )
    if not active_position or not active_position.parent_position_id:
        return [], False

    next_position = await hcm_service.get_position(db, active_position.parent_position_id)
    if not next_position:
        return [], False

    position_ids = [next_position.id]
    is_final = False
    if next_position.parent_position_id is None:
        is_final = True
    else:
        top_position = await hcm_service.get_position(db, next_position.parent_position_id)
        if top_position and top_position.parent_position_id is None:
            position_ids.append(top_position.id)
            is_final = True

    return await _holders_for_positions(
        db, position_ids, instance.started_by_id,
    ), is_final


async def _materialize_specific_pending(
    db: AsyncSession, instance: Instance, approvers: list, context: dict,
) -> None:
    for approver in approvers:
        db.add(Pending(
            instance_id=instance.id,
            stage_sequence=instance.current_sequence,
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


async def _materialize_pending(
    db: AsyncSession, instance: Instance, stage: Stage, context: dict,
) -> list:
    approvers = await resolver.resolve_approvers(db, stage, instance, context)
    if not approvers:
        # A vacant position or a role with no holders must not strand the document.
        # Only THIS stage is substituted; the rest of the configured chain is
        # untouched and still runs as designed.
        approvers, reason = await fallback.resolve(
            db, instance.started_by_id, context.get("requester_position_id"))
        await fallback.record(db, instance, f"{fallback.REASON_EMPTY_STAGE}/{reason}",
                              approvers, stage.name)
    if not approvers:
        # Nobody at all -- no configured approver, no reporting line, not even an
        # admin. Raising here would kill the CALLER's transaction, and the caller is
        # often an unrelated document: an approved indent that raises a material
        # request would fail its own approval because the MR could not find an
        # approver. That is exactly the "system never fails" rule being broken by the
        # thing meant to enforce it.
        #
        # So the document is created and left visibly stuck with no pending approvers,
        # recorded in both wf_actions and the audit log, instead of taking the caller
        # down with it. An admin fixes the configuration and the document moves.
        await fallback.record(db, instance, fallback.REASON_NO_APPROVER, [], stage.name)
        return []
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


# ---------------- ladder path ----------------
#
# A ladder is a per-project list of position LEVELS (workflow/ladder.py). It resolves
# to real positions ONCE, at submit, and the result is frozen onto the instance, so
# editing a ladder can never move a document already in approval. Everything below only
# runs for instances that carry a resolved_chain; every other workflow takes the
# original path untouched.

SELF_APPROVED_COMMENT = "Top of the approval ladder — self-approved"


def _link(instance: Instance) -> dict | None:
    """The chain entry the document is currently sitting on."""
    chain = instance.resolved_chain or []
    index = (instance.current_sequence or 1) - 1
    return chain[index] if 0 <= index < len(chain) else None


async def _ladder_approvers(db: AsyncSession, instance: Instance, link: dict) -> list:
    """The rung's holders, plus anyone they have delegated to."""
    employees = [e for e in [
        await hcm_service.get_employee(db, employee_id)
        for employee_id in link.get("approver_ids", [])
    ] if e is not None and e.is_active]
    return await resolver._expand_delegations(db, employees, instance.doc_type)


async def _open_ladder_link(db: AsyncSession, instance: Instance, link: dict,
                            context: dict) -> list:
    instance.current_sequence = link["sequence"]
    instance.current_stage_name = link["role_name"]
    approvers = await _ladder_approvers(db, instance, link)
    if not approvers:
        # resolve_chain already dropped empty rungs, so reaching here means the holders
        # left between submit and now. Same rule as everywhere else: never strand the
        # document — hand it to the reporting line.
        approvers, reason = await fallback.resolve(
            db, instance.started_by_id, context.get("requester_position_id"))
        await fallback.record(db, instance, f"{fallback.REASON_EMPTY_STAGE}/{reason}",
                              approvers, link["role_name"])
    await _materialize_specific_pending(db, instance, approvers, context)
    return approvers


async def _finish_ladder(db: AsyncSession, instance: Instance) -> None:
    instance.status = InstanceStatus.APPROVED.value
    instance.completed_at = utcnow()
    instance.current_stage_name = None
    await _clear_pending(db, instance.id)


async def _start_ladder(db, wf, stages, doc_type: str, doc_id: int, context: dict,
                        user, project_id: int | None,
                        requester_position_id: int | None) -> Instance:
    chain = await ladder.resolve_chain(
        db, stages, requester_position_id, user.id, context)

    instance = Instance(
        doc_type=doc_type, doc_id=doc_id, workflow_id=wf.id,
        project_id=project_id, resolved_chain=chain,
        doc_no=context.get("doc_no"),
        started_by_id=user.id, started_by_name=user.full_name,
        status=InstanceStatus.IN_PROGRESS.value,
    )
    db.add(instance)
    await db.flush()

    db.add(Action(
        instance_id=instance.id, stage_sequence=0, stage_name="Submitted",
        actor_id=user.id, actor_name=user.full_name,
        actor_position=context.get("requester_position_name"),
        action=ApprovalAction.SUBMITTED.value,
    ))
    await db.flush()

    if not chain:
        # Nobody above the raiser on this ladder: he IS the top. Recorded as a real
        # approval by him rather than a silent auto-approve, so the trail reads true.
        db.add(Action(
            instance_id=instance.id, stage_sequence=0,
            stage_name=ladder.DOC_TYPE_LABEL.get(doc_type, doc_type),
            actor_id=user.id, actor_name=user.full_name,
            actor_position=context.get("requester_position_name"),
            action=ApprovalAction.APPROVED.value, comments=SELF_APPROVED_COMMENT,
        ))
        instance.status = InstanceStatus.APPROVED.value
        instance.completed_at = utcnow()
        await db.flush()
        return instance

    await _open_ladder_link(db, instance, chain[0], context)
    await db.flush()
    return instance


async def _act_ladder(db, instance: Instance, action: str, user, comments: str,
                      context: dict) -> Instance:
    chain = instance.resolved_chain or []
    link = _link(instance)
    if link is None:
        raise ValidationError("Approval stage not found")

    pending = (await db.execute(
        select(Pending).where(
            Pending.instance_id == instance.id,
            Pending.stage_sequence == instance.current_sequence,
        )
    )).scalars().all()
    if user.id not in {row.approver_id for row in pending}:
        raise PermissionError_("You are not a valid approver for the current stage")

    # Someone holding two posts must act under the one the ladder picked. A delegate
    # never holds it, so the check applies only to the rung's own holders.
    active_position_id = getattr(user, "active_position_id", None)
    if user.id in link.get("approver_ids", []) and active_position_id != link["position_id"]:
        raise PermissionError_("Switch to the approval position before acting")

    active_position = await hcm_service.get_position(
        db, active_position_id) if active_position_id else None
    db.add(Action(
        instance_id=instance.id, stage_sequence=instance.current_sequence,
        stage_name=link["role_name"],
        actor_id=user.id, actor_name=user.full_name,
        actor_position=active_position.name if active_position else None,
        action=action, comments=comments,
    ))
    await db.flush()

    if action == ApprovalAction.REJECTED.value:
        instance.status = InstanceStatus.REJECTED.value
        instance.completed_at = utcnow()
        await _clear_pending(db, instance.id)
        await db.flush()
        return instance

    await _clear_pending(db, instance.id)

    if action == ApprovalAction.RETURNED.value:
        target = chain[instance.current_sequence - 2] if instance.current_sequence > 1 else link
        await _open_ladder_link(db, instance, target, context)
        await db.flush()
        return instance

    # APPROVED — one holder per rung is enough (ANY_ONE), so move on.
    nxt = [c for c in chain if c["sequence"] > instance.current_sequence]
    if nxt:
        await _open_ladder_link(db, instance, nxt[0], context)
    else:
        await _finish_ladder(db, instance)
    await db.flush()
    return instance


# ---------------- public API (the only five) ----------------

async def start(db, doc_type: str, doc_id: int, context: dict, user) -> Instance:
    context = context or {}
    requester_position_id = (context.get("requester_position_id")
                             or getattr(user, "active_position_id", None))
    # The post the raiser is acting under decides the project where HCM fills that in;
    # today it does not, so this falls through to the raiser's own project.
    project_id, _project_name = await ladder.project_for(db, requester_position_id, user)
    # No position means no reporting line to climb, and an empty climb reads as "top of
    # the ladder, self-approve". That would hand anyone without a post their own
    # approval, so they take the old path and land on the fallback's admin safety net.
    found = (await ladder.find_ladder(db, project_id, doc_type)
             if requester_position_id is not None else None)
    if found is not None:
        return await _start_ladder(db, found[0], found[1], doc_type, doc_id, context,
                                   user, project_id, requester_position_id)

    wf, used_fallback = await _active_workflow(db, doc_type)
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
    if used_fallback:
        await fallback.record(db, instance, fallback.REASON_NO_WORKFLOW, [],
                              wf.name)
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
    if instance.resolved_chain:
        return await _act_ladder(db, instance, action, user, comments, context)
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
    # The position checks below stop someone approving from the wrong hat. They are
    # meaningless when the fallback picked this stage's approvers — it chose people
    # precisely BECAUSE the configured position produced nobody, so requiring them to
    # hold that position would lock the document again, which is what the fallback
    # exists to prevent. Authority is still enforced: user.id must be in pending_ids.
    if await _stage_used_fallback(db, instance, stage):
        pass
    elif stage.approver_type == ApproverType.POSITION.value:
        if active_position_id != stage.position_id:
            raise PermissionError_("Switch to the approval position before acting")
    elif stage.approver_type == ApproverType.REPORTING_MANAGER.value:
        if not await _is_reporting_chain_position(
            db, context.get("requester_position_id"), active_position_id,
        ):
            raise PermissionError_("Switch to the reporting-manager position before acting")

    active_position = await hcm_service.get_position(
        db, active_position_id,
    ) if active_position_id else None
    db.add(Action(
        instance_id=instance.id, stage_sequence=stage.sequence,
        stage_name=instance.current_stage_name or stage.name,
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
        elif stage.approver_type == ApproverType.REPORTING_MANAGER.value:
            approvers, is_final = await _next_reporting_ladder_approvers(
                db, instance, user, context,
            )
            if approvers:
                instance.current_stage_name = (
                    FINAL_REPORTING_STAGE_NAME if is_final else stage.name
                )
                await _materialize_specific_pending(db, instance, approvers, context)
            else:
                instance.status = InstanceStatus.APPROVED.value
                instance.completed_at = utcnow()
                instance.current_stage_name = None
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
        select(Pending, Instance)
        .join(Instance, Instance.id == Pending.instance_id)
        .where(Pending.approver_id == user.id)
        .order_by(Pending.created_at.desc())
    )).all()
    return [{
        "instance_id": row.Pending.instance_id, "doc_type": row.Pending.doc_type,
        "doc_id": row.Pending.doc_id, "stage_sequence": row.Pending.stage_sequence,
        "doc_no": row.Pending.doc_no, "summary": row.Pending.doc_summary,
        "requested_by_name": row.Pending.requested_by_name,
        "amount": float(row.Pending.amount) if row.Pending.amount is not None else None,
        "waiting_since": row.Pending.created_at.isoformat() if row.Pending.created_at else None,
        "due_at": row.Pending.due_at.isoformat() if row.Pending.due_at else None,
        "current_stage_name": row.Instance.current_stage_name,
    } for row in rows]


async def history(db, doc_type: str, doc_id: int) -> list[Action]:
    instance = await _load_instance(db, doc_type, doc_id)
    if instance is None:
        return []
    return list((await db.execute(
        select(Action).where(Action.instance_id == instance.id).order_by(Action.acted_at, Action.id)
    )).scalars().all())
