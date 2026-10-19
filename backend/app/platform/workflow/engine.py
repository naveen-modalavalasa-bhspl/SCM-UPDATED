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
import logging
from types import SimpleNamespace

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import PermissionError_, ValidationError
from app.platform.hcm import service as hcm_service
from app.platform.hcm.models import HcmEmployee, HcmPositionAssignment
from app.platform.notifications import service as notifications
from app.platform.settings.service import write_audit
from app.shared.enums import AuditAction
from app.platform.workflow import custom_ladder, fallback, ladder, resolver
from app.platform.workflow.conditions import stage_applies
from app.platform.workflow import doc_registry
from app.platform.workflow.models import (
    Action, Instance, Pending, Stage, StageCondition, Workflow,
)
from app.shared.enums import ApprovalAction, ApprovalMode, ApproverType, InstanceStatus
from app.shared.models.base import utcnow

logger = logging.getLogger(__name__)

_ACTION_ALIASES = {
    "APPROVE": ApprovalAction.APPROVED.value,
    "REJECT": ApprovalAction.REJECTED.value,
    "RETURN": ApprovalAction.RETURNED.value,
}
FINAL_REPORTING_STAGE_NAME = "Final authority"
# A return-for-correction is parked *inside* the rung it was raised from, so the
# instance stays IN_PROGRESS and resumes at the same rung. Storing it as its own
# chain entry would make it look like an extra approval level to everything that
# walks resolved_chain.
CORRECTION_KEY = "_correction"

#: Context key letting a module route a document up ANOTHER document type's ladder.
#:
#: ADDED 2026-09-07 for stock returns. Approving the return of material is approving the
#: undoing of the indent that asked for it, and those are the same people — so a return
#: naming an indent is resolved against the INDENT ladder configured for the raiser's
#: rank, rather than against a second ladder an admin would have to keep in step by hand.
#:
#: It is deliberately a LOOKUP override and NOTHING more. Everything that identifies the
#: document keeps the document's real `doc_type` — `wf_instances.doc_type`, its audit
#: rows, and every later `act`, `history`, `current_approvers` and `pending_for_user`
#: call — or the module would lose track of its own approval. Absent from the context
#: (every caller but returns) the ladder is the document's own, exactly as before.
LADDER_DOC_TYPE_KEY = "ladder_doc_type"


def _ladder_doc_type(doc_type: str, context: dict | None) -> str:
    """Which ladder to look up: the one the caller named, else the document's own."""
    return (context or {}).get(LADDER_DOC_TYPE_KEY) or doc_type


#: What a second press on an approval that has already been decided says.
#:
#: "No in-progress approval for this document" is a statement about a row in
#: wf_instances. The person pressing Approve wants to know that somebody got there
#: first and that nothing they just did was lost — the workflow ENGINE is the only
#: place that knows it, and every module's approve/reject/return path comes through
#: here, so saying it once covers all of them.
ALREADY_DECIDED = (
    "This request has already been decided — somebody acted on it before you did. "
    "Refresh the screen to see where it stands now."
)


def _normalize_action(action: str) -> str:
    a = action.upper()
    return _ACTION_ALIASES.get(a, a)


async def _active_workflow(db: AsyncSession, doc_type: str) -> tuple[Workflow, bool]:
    """The configured workflow, or the hardcoded ladder materialised as one.

    Returns (workflow, was_fallback). Missing configuration must never stop a document
    being submitted — see platform/workflow/fallback.py.
    """
    rows = (await db.execute(
        select(Workflow).where(
            Workflow.doc_type == doc_type,
            # Project ladders are chosen by start(); this is the company-wide path, so
            # one project's ladder can never end up approving another's document.
            Workflow.project_id.is_(None),
            Workflow.is_active.is_(True),
        ).order_by(Workflow.id.desc())
    )).scalars().all()
    for wf in rows:
        # A rank ladder (or a hand-built / per-rank one) is NOT a stage workflow.
        # `ladder.find_ladder` already declined it for this raiser; running it here as
        # plain stages named the first rung ("District Manager") while its rank stages
        # resolved to nobody and fell to the raiser's own manager (SCM_0016).
        if wf.raiser_role_id is not None or ladder.is_custom_ladder(wf):
            continue
        stages = (await db.execute(
            select(Stage).where(Stage.workflow_id == wf.id))).scalars().all()
        if ladder.is_ladder(list(stages)):
            continue
        return wf, False
    return await fallback.ensure_workflow(db, doc_type), True


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


async def _load_active_instance_for_update(
    db: AsyncSession, doc_type: str, doc_id: int,
) -> Instance:
    """Row-lock the live instance. Return and resubmit both rewrite `resolved_chain`,
    so two concurrent callers must not read the same chain and write it back."""
    instance = (await db.execute(
        select(Instance)
        .where(Instance.doc_type == doc_type, Instance.doc_id == doc_id)
        .order_by(Instance.id.desc())
        .with_for_update()
    )).scalars().first()
    if instance is None or instance.status != InstanceStatus.IN_PROGRESS.value:
        raise ValidationError(ALREADY_DECIDED)
    return instance


async def _open_instance(db: AsyncSession, doc_type: str, doc_id: int,
                         **fields) -> Instance:
    """The document's instance row, restarted in place if it already has one.

    `wf_instances` is UNIQUE on (doc_type, doc_id) — one row per document, for the
    life of the document. Any second submit therefore cannot INSERT: it dies with an
    IntegrityError halfway through, leaving the module's status changed and no
    approval behind it. That is not a rare path — a rejected document raised again,
    or one whose workflow was cancelled, comes back here.

    So a finished cycle is reopened rather than duplicated. Its `wf_actions` stay
    exactly where they are (rule 9): the history reads as one document with two
    cycles, and the new cycle's SUBMITTED row is appended under the same instance.
    Only the pending queue is cleared — those rows name approvers of a cycle that is
    over, and leaving them would show the document on their screens forever.
    """
    instance = await _load_instance(db, doc_type, doc_id)
    if instance is None:
        instance = Instance(doc_type=doc_type, doc_id=doc_id, **fields)
        db.add(instance)
        return instance
    if instance.status == InstanceStatus.IN_PROGRESS.value:
        raise ValidationError("This document is already awaiting approval")

    await _clear_pending(db, instance.id)
    for key, value in fields.items():
        setattr(instance, key, value)
    instance.current_sequence = 1
    instance.current_stage_name = None
    instance.completed_at = None
    instance.started_at = utcnow()
    return instance


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


async def _requester_position_ids(
    db: AsyncSession, instance: Instance, context: dict,
) -> list[int]:
    """The post(s) the document was raised from, for the reporting-manager check.

    act() is normally handed `requester_position_id` in the context, but not every
    module has it: an allocation records who allocated, not the post they sat in. With
    nothing to compare against, the check below failed closed and refused EVERY
    approver — no allocation raised by someone with a real reporting line could be
    approved at all. So fall back to the posts the raiser actually holds, which is the
    same question asked a different way.
    """
    explicit = context.get("requester_position_id")
    if explicit:
        return [int(explicit)]
    if instance.started_by_id is None:
        return []
    return list((await db.execute(
        select(HcmPositionAssignment.position_id).where(
            HcmPositionAssignment.employee_id == instance.started_by_id,
            HcmPositionAssignment.is_active.is_(True),
        )
    )).scalars().all())


async def _approver_is_above_requester(
    db: AsyncSession, instance: Instance, context: dict, active_position_id: int | None,
) -> bool:
    positions = await _requester_position_ids(db, instance, context)
    if not positions:
        # Nothing to compare against. Authority is still enforced — the caller has
        # already checked the actor is one of this stage's pending approvers.
        return True
    for position_id in positions:
        if await _is_reporting_chain_position(db, position_id, active_position_id):
            return True
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


async def _notify_pending(db: AsyncSession, instance: Instance, approvers: list,
                          context: dict) -> None:
    """Tell the people a document has just landed on.

    Every route that creates a wf_pending row comes through here, so an approver is
    told once per stage no matter which path put it in front of them. Before this,
    nothing anywhere wrote sys_notifications for an approval: the queue filled up and
    the only way to find out was to go and look.
    """
    await notifications.notify(
        db,
        [a.id for a in approvers],
        title=f"{instance.doc_no or instance.doc_type} needs your approval",
        body=(context.get("doc_summary")
              or f"Raised by {instance.started_by_name or 'a colleague'}"),
        deep_link=notifications.link_for(instance.doc_type, instance.doc_id),
        entity_type=instance.doc_type,
        entity_id=instance.doc_id,
    )


async def _notify_outcome(db: AsyncSession, instance: Instance, approved: bool,
                          actor, comments: str = "") -> None:
    """Tell the raiser how it went. They started this and never hear back otherwise."""
    verdict = "approved" if approved else "rejected"
    await notifications.notify(
        db,
        [instance.started_by_id],
        title=f"{instance.doc_no or instance.doc_type} {verdict}",
        body=(f"{getattr(actor, 'full_name', 'An approver')} {verdict} it."
              + (f" “{comments}”" if comments else "")),
        deep_link=notifications.link_for(instance.doc_type, instance.doc_id),
        entity_type=instance.doc_type,
        entity_id=instance.doc_id,
    )


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
    await _notify_pending(db, instance, approvers, context)


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
    await _notify_pending(db, instance, approvers, context)
    return approvers


# ---------------- ladder path ----------------
#
# A ladder is a per-project list of position LEVELS (workflow/ladder.py). It resolves
# to real positions ONCE, at submit, and the result is frozen onto the instance, so
# editing a ladder can never move a document already in approval. Everything below only
# runs for instances that carry a resolved_chain; every other workflow takes the
# original path untouched.

SELF_APPROVED_COMMENT = "Top of the approval ladder — self-approved"


def _chain_employees(link: dict) -> list:
    """Just enough of an employee for fallback.record() to name them in the log."""
    return [SimpleNamespace(id=employee_id, full_name=name)
            for employee_id, name in zip(link.get("approver_ids") or [],
                                         link.get("approver_names") or [])]


def _link(instance: Instance) -> dict | None:
    """The chain entry the document is currently sitting on."""
    chain = instance.resolved_chain or []
    index = (instance.current_sequence or 1) - 1
    return chain[index] if 0 <= index < len(chain) else None


def _chain_links(instance: Instance) -> list[dict]:
    """Return only real ladder rungs; metadata lives inside a rung, never as one."""
    return [
        link for link in (instance.resolved_chain or [])
        if isinstance(link, dict) and "sequence" in link
    ]


def _with_correction(instance: Instance, sequence: int, correction: dict | None) -> None:
    chain = []
    updated = False
    for link in _chain_links(instance):
        row = dict(link)
        if int(row.get("sequence", 0)) == int(sequence):
            if correction is None:
                row.pop(CORRECTION_KEY, None)
            else:
                row[CORRECTION_KEY] = dict(correction)
            updated = True
        chain.append(row)
    if not updated:
        raise ValidationError("Approval stage not found")
    instance.resolved_chain = chain


def _correction_from_instance(instance: Instance) -> dict | None:
    for link in _chain_links(instance):
        correction = link.get(CORRECTION_KEY)
        if isinstance(correction, dict):
            return dict(correction)
    return None


def _link_by_sequence(instance: Instance, sequence: int) -> dict | None:
    for link in _chain_links(instance):
        if int(link.get("sequence", 0)) == int(sequence):
            return link
    return None


async def _log_ladder_denial(db: AsyncSession, instance: Instance, user,
                             role_name: str | None, approver_names: list | None,
                             approver_ids) -> None:
    """One `sys_audit_log` row for "you are not a valid approver" — the ladder's own
    counterpart to `core.dependencies._log_permission_denial`. Holding the RBAC
    permission to act on a doc type is not holding the SEAT the resolved chain froze
    at submit time, and that second refusal used to leave no trace an admin could use
    to tell the two apart — "permission issue" and "wrong person entirely" read as the
    same blank screen.

    `entity_no` carries `doc_type:doc_id` (fits String(50) for any real document
    number) so a search for one document surfaces every refusal against it; who the
    chain actually wants goes in `changed_fields`, since that is the one fact that
    lets an admin fix this from Job Profiles / Approvals Config instead of guessing.

    Commits on its own for the same reason as the RBAC twin: `act`/`_act_ladder`/
    `return_for_correction` are about to abort via the exception this precedes, with
    nothing else written yet in this request, so there is no later commit to join and
    no partial document state to protect. Never raises: a denial that could not be
    logged must still deny.
    """
    try:
        await write_audit(
            db, entity="workflow",
            entity_no=f"{instance.doc_type}:{instance.doc_id}"[:50],
            action=AuditAction.PERMISSION_DENIED, actor=user,
            after={
                "reason": "not a valid approver for the current stage",
                "stage_role": role_name,
                "expected_approver_ids": list(approver_ids or []),
                "expected_approver_names": approver_names or [],
            },
        )
        await db.commit()
    except Exception:  # noqa: BLE001 — logging the refusal must never replace it
        await db.rollback()


def _single_allowed_position(link: dict | None) -> int | None:
    if not link:
        return None
    allowed = ladder.allowed_position_ids(link)
    return allowed[0] if len(allowed) == 1 else None


async def _position_name(db: AsyncSession, position_id: int | None) -> str | None:
    """An HCM position's name, or None when there is not one to give.

    Never raises and never blocks a submit: this is the label on a history row, and a
    document must not fail to start because a position could not be read.
    """
    if position_id is None:
        return None
    try:
        position = await hcm_service.get_position(db, position_id)
    except Exception:  # noqa: BLE001 - a display label is not worth failing a submit
        return None
    return getattr(position, "name", None)


def _reliable_actor_position(link: dict | None, actor_id: int | None) -> int | None:
    """Only pin a correction to a position when the rung leaves no doubt which one.

    A rung held by several positions cannot say which of them the actor was wearing,
    and guessing would lock the correction owner out of their own document."""
    if not link or actor_id is None:
        return None
    if int(actor_id) not in {int(value) for value in link.get("approver_ids", [])}:
        return None
    return _single_allowed_position(link)


async def _latest_approved_action(
    db: AsyncSession, instance: Instance, sequence: int,
) -> Action | None:
    return (await db.execute(
        select(Action)
        .where(
            Action.instance_id == instance.id,
            Action.stage_sequence == sequence,
            Action.action == ApprovalAction.APPROVED.value,
        )
        .order_by(Action.acted_at.desc(), Action.id.desc())
    )).scalars().first()


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


async def _resolve_ladder_chain(db, wf, stages, context: dict, user,
                                requester_position_id: int | None,
                                ) -> tuple[list[dict], str]:
    """Work out WHO signs a document travelling this ladder. Reads only; writes nothing.

    Split out of `_start_ladder` on 2026-09-07 so `preview_chain` can show a raiser the
    route ahead by running the very resolution the submit runs. A preview that
    re-implemented this would be a second opinion about who approves, free to drift from
    the real one the moment either side changed.

    Returns `(chain, independent_fallback_reason)`. An empty chain means nobody above the
    raiser has to sign. The reason is empty unless the independent-approver safety net
    below is what produced the chain, and only `_start_ladder` has an instance to record
    it against.
    """
    # Who may approve a document this person raised is a property of the ladder, not of
    # a role or a person, so it is read here and applied to whichever resolution runs.
    policy, fallback_position_id = await ladder.read_policy(db, stages)
    # A hand-built ladder names its posts outright, so there is nothing to climb — and
    # for Inventory and Warehouse there is nothing above the raiser to reach anyway.
    # NO_APPROVAL skips resolution outright: an admin who said this step needs no
    # signature must not have the empty chain read as a broken ladder and sent to the
    # fallback below. It falls through to the self-approved close, which still writes a
    # real wf_actions row.
    chain = [] if policy == ladder.POLICY_NONE else (
        await custom_ladder.resolve_fixed_chain(
            db, stages, user.id, policy, requester_position_id, context)
        if ladder.is_custom_ladder(wf)
        else await ladder.resolve_chain(
            db, stages, requester_position_id, user.id, context, policy)
    )

    # Every rung resolved to the raiser himself, and this ladder demands somebody else.
    # Self-approving here is exactly what the setting forbids, so the document goes to
    # the post the project nominated — and if none was nominated, to the reporting line
    # and then the admin safety net. Recorded loudly either way; never silent.
    independent_fallback = ""
    if not chain and policy == ladder.POLICY_INDEPENDENT:
        chain = await ladder.fallback_chain(db, fallback_position_id, user.id)
        independent_fallback = fallback.REASON_INDEPENDENT_FALLBACK if chain else ""
        if not chain:
            approvers, reason = await fallback.resolve(
                db, user.id, requester_position_id)
            approvers = [a for a in approvers if a.id != user.id]
            if approvers:
                chain = [{
                    "sequence": 1, "position_id": None,
                    "position_name": None, "role_id": None,
                    "role_name": "Independent approver (fallback)",
                    "approver_ids": [a.id for a in approvers],
                    "approver_names": [a.full_name for a in approvers],
                }]
                independent_fallback = f"{fallback.REASON_INDEPENDENT_FALLBACK}/{reason}"
    return chain, independent_fallback


async def _start_ladder(db, wf, stages, doc_type: str, doc_id: int, context: dict,
                        user, project_id: int | None,
                        requester_position_id: int | None) -> Instance:
    chain, independent_fallback = await _resolve_ladder_chain(
        db, wf, stages, context, user, requester_position_id)

    instance = await _open_instance(
        db, doc_type, doc_id, workflow_id=wf.id,
        project_id=project_id, resolved_chain=chain,
        doc_no=context.get("doc_no"),
        started_by_id=user.id, started_by_name=user.full_name,
        status=InstanceStatus.IN_PROGRESS.value,
    )
    await db.flush()

    # FIXED 2026-08-23 — this read ONLY `requester_position_name`, and indents are the
    # only caller that passes it (`indents/service.py`). Material requests and stock
    # allocations pass `requester_position_id` and no name, so every one of their
    # submit rows rendered as "Position unavailable" on the approval history — a
    # document that plainly HAS a raiser, reported as though the record were damaged.
    #
    # Resolved here rather than patched into each caller: the position is already
    # loaded from the id a few lines down for the same purpose on `act`, so the engine
    # can answer this itself and any future doc type gets it without knowing to ask.
    # A caller that DOES pass a name still wins — an indent snapshots the position the
    # raiser held at submit, which is the truer answer once somebody moves posts.
    submitted_position = context.get("requester_position_name")
    if not submitted_position:
        submitted_position = await _position_name(
            db, context.get("requester_position_id")
            or getattr(user, "active_position_id", None))
    db.add(Action(
        instance_id=instance.id, stage_sequence=0, stage_name="Submitted",
        actor_id=user.id, actor_name=user.full_name,
        actor_position=submitted_position,
        action=ApprovalAction.SUBMITTED.value,
    ))
    await db.flush()

    if independent_fallback:
        await fallback.record(db, instance, independent_fallback,
                              _chain_employees(chain[0]), chain[0]["role_name"])

    if not chain:
        # Nobody above the raiser on this ladder: he IS the top. Recorded as a real
        # approval by him rather than a silent auto-approve, so the trail reads true.
        db.add(Action(
            instance_id=instance.id, stage_sequence=0,
            stage_name=ladder.DOC_TYPE_LABEL.get(doc_type, doc_type),
            actor_id=user.id, actor_name=user.full_name,
            actor_position=submitted_position,
            action=ApprovalAction.APPROVED.value, comments=SELF_APPROVED_COMMENT,
        ))
        instance.status = InstanceStatus.APPROVED.value
        instance.completed_at = utcnow()
        await db.flush()
        return instance

    await _open_ladder_link(db, instance, chain[0], context)
    await db.flush()
    return instance


async def start_resolved_chain(db, doc_type: str, doc_id: int, chain: list[dict],
                               context: dict, user,
                               project_id: int | None = None) -> Instance:
    """Open an instance on a chain the caller has already worked out.

    Used where the approvers do not come from a configured workflow at all — the
    point-owner default for SELF_OWNED_DOC_TYPES. It still needs a workflow row to
    hang off, so it borrows the doc type's fallback one; the chain on the instance is
    what actually decides who approves, exactly as with a ladder.
    """
    context = context or {}
    resolved = [{**link, "sequence": index + 1}
                for index, link in enumerate(chain or [])
                if isinstance(link, dict)]
    wf = await fallback.ensure_workflow(db, doc_type)
    instance = await _open_instance(
        db, doc_type, doc_id, workflow_id=wf.id,
        project_id=project_id, resolved_chain=resolved,
        doc_no=context.get("doc_no"),
        started_by_id=user.id, started_by_name=user.full_name,
        status=InstanceStatus.IN_PROGRESS.value,
    )
    await db.flush()
    db.add(Action(
        instance_id=instance.id, stage_sequence=0, stage_name="Submitted",
        actor_id=user.id, actor_name=user.full_name,
        actor_position=context.get("requester_position_name"),
        action=ApprovalAction.SUBMITTED.value,
    ))
    await db.flush()
    if not resolved:
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
    await _open_ladder_link(db, instance, resolved[0], context)
    await db.flush()
    return instance


async def _start_resolved(db, doc_type: str, doc_id: int, chain: list[dict],
                          context: dict, user, project_id: int | None) -> Instance:
    return await start_resolved_chain(db, doc_type, doc_id, chain, context, user,
                                      project_id)


async def _act_ladder(db, instance: Instance, action: str, user, comments: str,
                      context: dict, final: bool = False) -> Instance:
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
        await _log_ladder_denial(
            db, instance, user, link.get("role_name"),
            link.get("approver_names"), {row.approver_id for row in pending},
        )
        raise PermissionError_("You are not a valid approver for the current stage")

    # Someone holding two posts must act under one the ladder picked. A delegate never
    # holds one, so the check applies only to the rung's own holders. Any post the
    # ladder named counts: when two rungs collapsed into this one because the same
    # person fills both, both posts are still authorised (see ladder.dedupe_chain).
    # A fallback rung names people, not a post, so it has no position to switch to —
    # requiring one would lock the document again, which is the exact thing the
    # fallback exists to prevent.
    active_position_id = getattr(user, "active_position_id", None)
    allowed_positions = ladder.allowed_position_ids(link)
    if (allowed_positions
            and user.id in link.get("approver_ids", [])
            and active_position_id not in allowed_positions):
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
        await _notify_outcome(db, instance, False, user, comments)
        await db.flush()
        return instance

    await _clear_pending(db, instance.id)

    if action == ApprovalAction.RETURNED.value:
        target = chain[instance.current_sequence - 2] if instance.current_sequence > 1 else link
        await _open_ladder_link(db, instance, target, context)
        await db.flush()
        return instance

    # APPROVED — one holder per rung is enough (ANY_ONE), so move on.
    #
    # `final` ends the ladder here even though rungs remain. The module asks for it
    # when there is nothing left for the rungs above to decide — an approver who
    # served the whole indent out of their own stock has finished it, and sending it
    # on asked the DM to approve goods already committed.
    nxt = [] if final else [c for c in chain if c["sequence"] > instance.current_sequence]
    if nxt:
        await _open_ladder_link(db, instance, nxt[0], context)
    else:
        await _finish_ladder(db, instance)
        await _notify_outcome(db, instance, True, user, comments)
    await db.flush()
    return instance


# ---------------- return for correction (ladder only) ----------------
#
# Not `act()`: a return for correction is a pause, not a decision that ends the
# approval. The instance stays IN_PROGRESS and resumes at the rung it left, so the
# ladder resolved at submit time is never re-resolved and no approver below is asked
# to decide the same thing twice.

async def return_for_correction(
    db, doc_type: str, doc_id: int, user, comments: str = "",
    context: dict | None = None,
) -> Instance:
    """Pause a ladder approval on the same instance and hand correction to one owner."""
    context = context or {}
    instance = await _load_active_instance_for_update(db, doc_type, doc_id)
    if not instance.resolved_chain:
        raise ValidationError("Return for correction requires a resolved approval ladder")
    if _correction_from_instance(instance):
        raise ValidationError("This document is already returned for correction")

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
        await _log_ladder_denial(
            db, instance, user, link.get("role_name"),
            link.get("approver_names"), {row.approver_id for row in pending},
        )
        raise PermissionError_("You are not a valid approver for the current stage")

    active_position_id = getattr(user, "active_position_id", None)
    allowed_positions = ladder.allowed_position_ids(link)
    if (allowed_positions
            and user.id in link.get("approver_ids", [])
            and active_position_id not in allowed_positions):
        raise PermissionError_("Switch to the approval position before acting")

    # The correction goes back one rung, not to the raiser every time: at the first
    # rung that is the requester, above it the person who approved just below.
    if int(instance.current_sequence or 0) <= 1:
        correction_owner_employee_id = instance.started_by_id
        correction_owner_position_id = context.get("requester_position_id")
        correction_owner_name = instance.started_by_name
    else:
        previous_sequence = int(instance.current_sequence) - 1
        previous_action = await _latest_approved_action(db, instance, previous_sequence)
        if previous_action is None or previous_action.actor_id is None:
            raise ValidationError("Previous approval actor not found")
        previous_link = _link_by_sequence(instance, previous_sequence)
        correction_owner_employee_id = previous_action.actor_id
        correction_owner_position_id = _reliable_actor_position(
            previous_link, previous_action.actor_id,
        )
        correction_owner_name = previous_action.actor_name

    if correction_owner_employee_id is None:
        raise ValidationError("Correction owner not found")

    # The position is snapshotted exactly as `act()` does it for every other action.
    # It is not decoration: indent visibility for a workflow participant matches
    # Action.actor_position against the viewer's active position, so a RETURNED row
    # written without one leaves the returning approver unable to open the document
    # they just acted on.
    active_position = await hcm_service.get_position(
        db, active_position_id) if active_position_id else None
    action_row = Action(
        instance_id=instance.id,
        stage_sequence=instance.current_sequence,
        stage_name=link["role_name"],
        actor_id=user.id,
        actor_name=user.full_name,
        actor_position=active_position.name if active_position else None,
        action=ApprovalAction.RETURNED.value,
        comments=comments,
    )
    db.add(action_row)
    await db.flush()

    returned_at = action_row.acted_at.isoformat() if action_row.acted_at else None
    correction = {
        "correction_owner_employee_id": int(correction_owner_employee_id),
        "correction_owner_position_id": (
            int(correction_owner_position_id)
            if correction_owner_position_id is not None else None
        ),
        "correction_owner_name": correction_owner_name,
        "returned_from_sequence": int(instance.current_sequence),
        "returned_from_stage": link.get("role_name"),
        "resubmit_target_sequence": int(instance.current_sequence),
        "resubmit_target_stage": link.get("role_name"),
        "returned_by_employee_id": user.id,
        "returned_by_position_id": active_position_id,
        "returned_by_name": user.full_name,
        "return_action_id": int(action_row.id),
        "returned_at": returned_at,
    }
    _with_correction(instance, int(instance.current_sequence), correction)
    await _clear_pending(db, instance.id)
    await db.flush()
    return instance


async def get_correction_state(db, doc_type: str, doc_id: int) -> dict | None:
    instance = await _load_instance(db, doc_type, doc_id)
    if instance is None or instance.status != InstanceStatus.IN_PROGRESS.value:
        return None
    correction = _correction_from_instance(instance)
    if not correction:
        return None
    action_id = correction.get("return_action_id")
    action = await db.get(Action, action_id) if action_id is not None else None
    return {
        **correction,
        "instance_id": instance.id,
        "doc_type": instance.doc_type,
        "doc_id": instance.doc_id,
        "correction_comment": action.comments if action else None,
    }


async def resubmit_correction(
    db, doc_type: str, doc_id: int, user, context: dict | None = None,
) -> Instance:
    context = context or {}
    instance = await _load_active_instance_for_update(db, doc_type, doc_id)
    correction = _correction_from_instance(instance)
    if not correction:
        raise ValidationError("This document is not returned for correction")

    if int(correction.get("correction_owner_employee_id") or 0) != int(user.id):
        raise PermissionError_("Only the correction owner can resubmit this document")
    owner_position_id = correction.get("correction_owner_position_id")
    if (
        owner_position_id is not None
        and getattr(user, "active_position_id", None) != int(owner_position_id)
    ):
        raise PermissionError_("Switch to the correction owner position before resubmitting")

    # Pending rows are cleared on return, so any that exist mean a resubmit already
    # landed. Without this a double-click reopens the rung twice.
    pending_count = await db.scalar(
        select(Pending.id)
        .where(Pending.instance_id == instance.id)
        .limit(1)
    )
    if pending_count is not None:
        raise ValidationError("This correction has already been resubmitted")

    target_sequence = int(correction["resubmit_target_sequence"])
    target = _link_by_sequence(instance, target_sequence)
    if target is None:
        raise ValidationError("Resubmit target stage not found")
    _with_correction(instance, target_sequence, None)
    await _clear_pending(db, instance.id)
    await _open_ladder_link(db, instance, target, context)
    await db.flush()
    return instance


# ---------------- public API (the only five) ----------------

async def start(db, doc_type: str, doc_id: int, context: dict, user) -> Instance:
    context = context or {}
    requester_position_id = (context.get("requester_position_id")
                             or getattr(user, "active_position_id", None))
    # The DOCUMENT's project chooses the ladder when the module knows it. An allocation
    # is raised by inventory against somebody else's indent, and the person pressing the
    # button belongs to another project or to none — reading the project off them sent
    # every such document past its project's ladder and into the fallback.
    project_id = context.get("project_id")
    if project_id is None:
        # The post the raiser is acting under decides the project where HCM fills that
        # in; today it does not, so this falls through to the raiser's own project.
        project_id, _project_name = await ladder.project_for(
            db, requester_position_id, user)
    # No position means no reporting line to climb, and an empty climb reads as "top of
    # the ladder, self-approve". That would hand anyone without a post their own
    # approval, so they take the old path and land on the fallback's admin safety net.
    # The rank the raiser holds, so a document can travel a chain built for people at
    # that height. A raiser with no post has no rank, which simply means the chain
    # everybody shares — the same answer as before this existed.
    raiser_role_id = await ladder.role_of_position(db, requester_position_id)
    # Normally the document's own type; a module may name another (LADDER_DOC_TYPE_KEY).
    # Only the LOOKUP moves — `_start_ladder` is still handed the real `doc_type`, so the
    # instance and its trail stay keyed on the document that is actually being approved.
    found = await ladder.find_ladder(db, project_id,
                                     _ladder_doc_type(doc_type, context), raiser_role_id)
    if (found is not None and requester_position_id is None
            and not ladder.is_custom_ladder(found[0])):
        found = None
    if found is not None:
        return await _start_ladder(db, found[0], found[1], doc_type, doc_id, context,
                                   user, project_id, requester_position_id)

    # Nobody has configured this event, and its authority comes from holding the stock
    # rather than from rank: the point owner approves. Climbing to his manager would
    # ask the wrong person about a shelf he does not hold.
    if doc_type in ladder.SELF_OWNED_DOC_TYPES:
        chain = await ladder.own_post_chain(db, requester_position_id, user.id)
        if chain:
            return await _start_resolved(db, doc_type, doc_id, chain, context, user,
                                         project_id)

    # The same type the ladder was looked up under: an STR (an INDENT row) with no STR
    # ladder must fall back to the STR policy, never borrow the INDENT workflow
    # (SCM_0015). Without an override the two are the same type.
    wf, used_fallback = await _active_workflow(db, _ladder_doc_type(doc_type, context))
    applicable = await _applicable_stages(db, wf.id, context)

    instance = await _open_instance(
        db, doc_type, doc_id, workflow_id=wf.id,
        doc_no=context.get("doc_no"),
        started_by_id=user.id, started_by_name=user.full_name,
        status=InstanceStatus.IN_PROGRESS.value,
        resolved_chain=None,
    )
    if applicable:
        instance.current_sequence = applicable[0].sequence
        instance.current_stage_name = applicable[0].name
    else:  # a workflow with no applicable stage is nothing to approve
        instance.status = InstanceStatus.APPROVED.value
        instance.completed_at = utcnow()
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


async def preview_chain(db, doc_type: str, context: dict, user) -> list[dict] | None:
    """Who WILL sign, resolved exactly as `start` resolves it. Nothing is written.

    ADDED 2026-09-07 so a screen can show a raiser the route ahead — on a form, before
    the document exists at all. It repeats the same four steps `start` takes (the
    raiser's post, the document's project, his rank, the ladder found for that
    combination) and then calls the same `_resolve_ladder_chain`, so what a form promises
    and what the submit does cannot disagree.

    THREE answers, and a caller must keep them apart:

      * `None`  — no ladder is configured for this project, doc type and rank. `start`
                  would fall through to the reporting line and then the admin safety net,
                  neither of which can be resolved without a document to hang them on.
      * `[]`    — configured, and nobody has to sign: NO_APPROVAL, or the raiser is
                  himself the top of the ladder.
      * a list  — the rungs in order, each carrying the people who may sign it.

    "Nobody is configured" and "configured to need no signature" are different answers
    and the second is a real choice an admin makes, which is why they are not both `[]`.

    One limit worth knowing: a rung gated by a CONDITION is evaluated against the context
    it is given, so a preview built from a thinner context than the submit will send can
    differ on exactly those rungs. Pass the same keys and the answers match.
    """
    context = context or {}
    requester_position_id = (context.get("requester_position_id")
                             or getattr(user, "active_position_id", None))
    project_id = context.get("project_id")
    if project_id is None:
        project_id, _project_name = await ladder.project_for(
            db, requester_position_id, user)
    raiser_role_id = await ladder.role_of_position(db, requester_position_id)
    found = await ladder.find_ladder(db, project_id,
                                     _ladder_doc_type(doc_type, context), raiser_role_id)
    # The same guard `start` applies: with no post there is no reporting line to climb,
    # so a rank-based ladder cannot resolve and is not the route the document takes.
    if (found is not None and requester_position_id is None
            and not ladder.is_custom_ladder(found[0])):
        found = None
    if found is None:
        return None
    chain, _independent_fallback = await _resolve_ladder_chain(
        db, found[0], found[1], context, user, requester_position_id)
    return chain


async def act(db, doc_type: str, doc_id: int, action: str, user, comments: str = "",
              context: dict | None = None, final: bool = False) -> Instance:
    instance = await _load_instance(db, doc_type, doc_id)
    if instance is None or instance.status != InstanceStatus.IN_PROGRESS.value:
        raise ValidationError(ALREADY_DECIDED)

    action = _normalize_action(action)
    context = context or {}
    if instance.resolved_chain:
        return await _act_ladder(db, instance, action, user, comments, context, final)
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
        await _log_ladder_denial(
            db, instance, user, getattr(stage, "name", None),
            [a.full_name for a in approvers], pending_ids,
        )
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
        if not await _approver_is_above_requester(
            db, instance, context, active_position_id,
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
        await _notify_outcome(db, instance, False, user, comments)
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
                await _notify_outcome(db, instance, True, user, comments)
        else:
            instance.status = InstanceStatus.APPROVED.value
            instance.completed_at = utcnow()
            instance.current_stage_name = None
            await _notify_outcome(db, instance, True, user, comments)
    await db.flush()
    return instance


async def abandon(db, doc_type: str, doc_id: int, user, reason: str = "") -> Instance | None:
    """Close the approval behind a document that has been withdrawn.

    A module that cancels its own document has to tell the engine, or the task
    outlives the thing it was about: the approver keeps seeing it in "Waiting on
    you", clicking through to a cancelled document with no decision left to make,
    and every count fed by the queue stays overstated. Cancelling WHI/2026-27/00027
    left exactly that behind.

    Not `act()`: this is not a decision anybody made about the request, so it must
    not be recorded as an approval or a rejection. The audit trail keeps its own
    CANCELLED action row, and no `wf_actions` row is ever deleted (rule 9).
    """
    instance = await _load_instance(db, doc_type, doc_id)
    if instance is None or instance.status != InstanceStatus.IN_PROGRESS.value:
        return instance
    db.add(Action(
        instance_id=instance.id, stage_sequence=instance.current_sequence,
        stage_name=instance.current_stage_name,
        actor_id=getattr(user, "id", None), actor_name=getattr(user, "full_name", None),
        actor_position=None, action=ApprovalAction.CANCELLED.value, comments=reason,
    ))
    await _clear_pending(db, instance.id)
    instance.status = InstanceStatus.CANCELLED.value
    instance.completed_at = utcnow()
    instance.current_stage_name = None
    await db.flush()
    return instance


async def settle(db, doc_type: str, doc_id: int, user, reason: str = "") -> Instance | None:
    """End an approval because the request it was about has been satisfied.

    Not `abandon()` — nothing was withdrawn; and not `act()` — the person calling this
    is not necessarily an approver on the chain. An indent served in full out of
    somebody's own stock has nothing left for the rungs above to decide, so the task
    must stop existing. Leaving it open kept a settled request sitting in the
    approver's queue and in every count fed by it.

    Recorded as a real APPROVED action so the history reads honestly rather than the
    instance silently changing state.
    """
    instance = await _load_instance(db, doc_type, doc_id)
    if instance is None or instance.status != InstanceStatus.IN_PROGRESS.value:
        return instance
    db.add(Action(
        instance_id=instance.id, stage_sequence=instance.current_sequence,
        stage_name=instance.current_stage_name,
        actor_id=getattr(user, "id", None), actor_name=getattr(user, "full_name", None),
        actor_position=None, action=ApprovalAction.APPROVED.value, comments=reason,
    ))
    await _clear_pending(db, instance.id)
    instance.status = InstanceStatus.APPROVED.value
    instance.completed_at = utcnow()
    instance.current_stage_name = None
    await db.flush()
    return instance


async def move_to_workflow(db, instance_id: int, workflow_id: int, user,
                           reason: str = "") -> Instance:
    """Re-point a document already in approval at another chain, and re-resolve it.

    An admin who fixes a wrong ladder has, until now, fixed it only for the documents
    raised *after* the fix: `resolved_chain` is frozen at submit precisely so editing a
    ladder cannot move a document mid-flight (rule 8). That freeze is right as a
    default and wrong as an absolute — a chain saved with the wrong rung strands real
    documents in a stranger's queue, and the only remedy was to reject and re-raise
    them, which throws away the trail.

    So this is the one deliberate door through the freeze, and it stays narrow:

      * it is the ADMIN's action, never the module's — nothing in app.modules calls it;
      * it only moves LADDER instances. A legacy stage-walking workflow decides its
        approvers from `wf_stages` as it goes, so there is no frozen chain to swap and
        re-pointing one would silently change how it resolves. Refused outright.
      * it re-resolves from scratch against the target's rungs, using the RAISER's
        reporting line and the target ladder's own self-approval policy — the same
        resolution `start()` runs, so a moved document lands exactly where it would
        have had it been raised on this chain in the first place;
      * an empty resolution is refused rather than auto-approved. `start()` may close a
        document the raiser sits at the top of; an admin pressing Move must never be
        able to approve somebody else's document by choosing an empty ladder.
      * the document restarts at rung 1 of the new chain. Approvals already given were
        given by a chain that no longer governs it, and carrying them across by name
        would silently skip rungs on the new one. The old actions stay (rule 9) — the
        trail reads as one document that changed chains, with a MOVED row saying when,
        by whom and why.
    """
    instance = (await db.execute(
        select(Instance).where(Instance.id == instance_id).with_for_update()
    )).scalars().first()
    if instance is None:
        raise ValidationError("Approval not found")
    if instance.status != InstanceStatus.IN_PROGRESS.value:
        raise ValidationError("Only a document still in approval can be moved")
    if not _chain_links(instance):
        raise ValidationError(
            "This document is on a stage-by-stage workflow, not a ladder, and cannot "
            "be moved")
    if int(instance.workflow_id or 0) == int(workflow_id):
        raise ValidationError("This document is already on that version")

    wf = await db.get(Workflow, workflow_id)
    # The target must be the SAME chain family as the one the document rides today.
    # An STR's instance is keyed INDENT while its ladder is STOCK_TRANSFER_REQUEST
    # (`LADDER_DOC_TYPE_KEY`), so the instance's own type alone refused every move of
    # an STR onto a newer STR version.
    current = (await db.get(Workflow, instance.workflow_id)
               if instance.workflow_id else None)
    family = {instance.doc_type, getattr(current, "doc_type", None)}
    if wf is None or wf.doc_type not in family:
        raise ValidationError(f"No {instance.doc_type} chain with id {workflow_id}")

    stages = await _stages(db, wf.id)
    policy, _fallback_position_id = await ladder.read_policy(db, stages)
    if policy == ladder.POLICY_NONE:
        raise ValidationError(
            "That chain needs no approval, so a document cannot be moved onto it")

    # The raiser's post, not the admin's: the target ladder is climbed from whoever
    # raised the document, exactly as it would have been at submit.
    position_ids = await _requester_position_ids(db, instance, {})
    requester_position_id = position_ids[0] if position_ids else None
    context = {"requester_position_id": requester_position_id,
               "doc_no": instance.doc_no}
    chain = (
        await custom_ladder.resolve_fixed_chain(
            db, stages, instance.started_by_id, policy, requester_position_id, context)
        if ladder.is_custom_ladder(wf)
        else await ladder.resolve_chain(
            db, stages, requester_position_id, instance.started_by_id, context, policy)
    )
    if not chain:
        raise ValidationError(
            "That chain resolves to nobody for this document's raiser — pick another "
            "version, or fill its rungs first")

    from_workflow_id = instance.workflow_id
    await _clear_pending(db, instance.id)
    instance.workflow_id = wf.id
    instance.project_id = wf.project_id
    instance.resolved_chain = chain
    instance.current_sequence = 1

    db.add(Action(
        instance_id=instance.id, stage_sequence=0, stage_name="Moved",
        actor_id=user.id, actor_name=getattr(user, "full_name", None),
        action=ApprovalAction.MOVED.value,
        comments=(f"Moved to {wf.code} v{wf.version}"
                  + (f" — {reason}" if reason else "")),
    ))
    await db.flush()
    await _open_ladder_link(db, instance, chain[0], context)
    await db.flush()

    # FIXED 2026-08-23 — the move used to stop here, and the DOCUMENT never learned
    # about it. Every ordinary transition updates `current_approver_name` because the
    # MODULE calls the engine and then writes its own row (rule 8); a move is the one
    # transition with no module on the other end, so the snapshot was left naming the
    # approver from the version the document had just been taken off.
    #
    # Measured on live data before the fix: instance 457 moved 106 -> 94 and its rung
    # went SCM HEAD -> OE, `wf_pending` went 16070 -> 7703, and `ind_indents` still
    # read "MAHENDRA (SCM HEAD)". The new approver held it, the old one did not, and
    # every screen named the old one — which is what "the move does not actually
    # migrate the document" meant.
    #
    # Written through `doc_registry` rather than by importing the module's model,
    # because platform may not import app.modules (rule 5). An unregistered doc type
    # is a no-op, exactly as before, so this can never make a Move fail.
    label = await current_approver_label(db, instance.doc_type, instance.doc_id)
    updated = await doc_registry.sync_approver(
        db, instance.doc_type, instance.doc_id, label)
    await db.flush()

    logger.info("Approval %s (%s %s) moved from workflow %s to %s by %s "
                "(document snapshot %s)",
                instance.id, instance.doc_type, instance.doc_no,
                from_workflow_id, wf.id, getattr(user, "full_name", user),
                "updated" if updated else "not registered")
    return instance


async def current_stage_rank(db, doc_type: str, doc_id: int) -> str | None:
    """The RUNG a document is sitting on, as a person would name it.

    `role_name` is the HCM org role an admin picked on Approvals Config — "Warehouse
    Manager" — and is what a reader recognises. `position_name` is the specific post and
    is the fallback for a chain built from a pinned POSITION stage, which carries no
    rank. Read off the frozen chain, never from the approver's own record: see
    `current_approver_label`.
    """
    instance = await _load_instance(db, doc_type, doc_id)
    if instance is None or instance.status != InstanceStatus.IN_PROGRESS.value:
        return None
    link = _link(instance) or {}
    return (link.get("role_name") or link.get("position_name") or "").strip() or None


async def can_act_now(db, doc_type: str, doc_id: int, user) -> bool:
    """Is it THIS login's turn on this document, under the position they are wearing?

    NEW 2026-08-23, and deliberately the same two tests `act` performs before it
    accepts a decision — read them together, because a screen that disagrees with the
    gate is worse than one that does not ask:

      1. the login is among the current approvers, and
      2. where the rung pins positions, the ACTIVE position is one of them.

    Test 2 is the one that matters here. One person commonly holds two rungs of the
    same ladder — an inventory manager who is also the SCM head — so being named as
    the approver is not the same as being able to sign right now. Approve and Reject
    were rendered off the document's STATUS alone, so that person was shown live
    buttons that could only ever answer "Switch to the approval position before
    acting": the screen invited a press it already knew it would refuse.

    Never raises. A screen asking "may I?" must degrade to hiding the buttons, never
    to failing the page — the server is still the gate either way (rule 6).
    """
    try:
        instance = await _load_instance(db, doc_type, doc_id)
        # Only a ladder document can answer this: `_link` reads the frozen
        # `resolved_chain`, which is what `_act_ladder` guards against. A stage-based
        # instance has no position pinning to check, so it falls through to the
        # permission the route already carries.
        if (instance is None
                or instance.status != InstanceStatus.IN_PROGRESS.value
                or not instance.resolved_chain):
            return False
        link = _link(instance)
    except Exception:  # noqa: BLE001 - a UI hint is not worth failing a read
        return False
    if not link:
        return False
    if getattr(user, "id", None) not in link.get("approver_ids", []):
        return False
    allowed_positions = ladder.allowed_position_ids(link)
    if not allowed_positions:
        return True
    return getattr(user, "active_position_id", None) in allowed_positions


async def current_approver_label(db, doc_type: str, doc_id: int) -> str | None:
    """Who a document is waiting on, AND the rung they are sitting on.

    NEW 2026-08-21. Every module built this string the same way — `", ".join(full_name)`
    — nine copies of one line, and all nine said only the person. "Pending approval:
    Mahendra Kumar" tells a requester nothing about WHY it is with him or how far up the
    ladder the document has climbed, and where one person holds two posts it is actively
    misleading. "Mahendra Kumar (Warehouse Manager)" answers both.

    The rank is READ, never inferred. `wf_instances.resolved_chain` already froze which
    rung the document is on at submit time, and each link carries `role_name` (the HCM
    org role — the RANK an admin picked on Approvals Config) and `position_name` (the
    specific post that rank resolved to). Deriving it from the approver's own HCM record
    instead would pick whichever hat they happen to be wearing, which is the wrong one
    as often as not.

    `wf_pending` has no position column (see the note on the Pending model), so this is
    the only place the answer exists without a migration — and it is the better source
    anyway, because the chain is what the ladder actually decided rather than what the
    org tree says today.

    Falls back gracefully: the rank alone when nobody holds the post, the names alone
    when a chain predates `role_name`, and None when the document is not in approval —
    so a caller can assign the result straight onto `current_approver_name`.
    """
    instance = await _load_instance(db, doc_type, doc_id)
    if instance is None or instance.status != InstanceStatus.IN_PROGRESS.value:
        return None
    approvers = await current_approvers(db, doc_type, doc_id)
    # Collapsed, not joined. `current_approver_name` is String(200) on every document
    # that stores this, and a rung with eight holders plus a rank overruns it — the
    # warehouse's own builder has collapsed to "first +N" since it was written for
    # exactly that reason, and this replaces it, so the ceiling has to come along.
    # Truncated hard at the end too, because a single very long name plus a long rank
    # can still reach 200 on its own.
    full = [a.full_name for a in approvers if a.full_name]
    names = (full[0] if len(full) == 1
             else f"{full[0]} +{len(full) - 1}" if full else "")
    link = _link(instance) or {}
    rank = (link.get("role_name") or link.get("position_name") or "").strip()
    label = f"{names} ({rank})" if names and rank else (names or rank)
    return label[:200] if label else None


async def current_approvers(db, doc_type: str, doc_id: int) -> list:
    instance = await _load_instance(db, doc_type, doc_id)
    if instance is None or instance.status != InstanceStatus.IN_PROGRESS.value:
        return []
    ids = (await db.execute(
        select(Pending.approver_id).where(Pending.instance_id == instance.id)
    )).scalars().all()
    employees = [await hcm_service.get_employee(db, employee_id) for employee_id in ids]
    return [employee for employee in employees if employee is not None]


# ---------------- the queue belongs to a HAT, not just to a person ----------------
#
# `wf_pending` is keyed on the EMPLOYEE, because that is who signs. But the ladder
# resolves to a POST, and one person can hold several: Kolli Venkata Surya Srikant
# holds DM-104-PADERU and DM-104-VIZIANAGARAM at once. A Vizianagaram storekeeper's
# indent resolves to the Vizianagaram post — one chain, one pending row, correctly
# routed — and the queue then showed it under BOTH hats, because it never asked which
# one was being worn.
#
# That is not only cosmetic. Acting on it from the wrong hat half-succeeded: the
# allocation was written and committed, and the settle step behind it then failed the
# profile's SUBTREE rung (`shared/scope.py` keys the rung to the active position too),
# so `IND/2026-27/00639` came back "Indent 640 not found" with 5.612 already promised
# and the ladder still sitting on the District Manager.
#
# The predicate below is exactly the one `_act_ladder` and `actionable_doc_ids`
# already enforce — the ladder's own `allowed_position_ids`, which is the approval
# CONFIG speaking, not a rule invented here. So the queue can now only show what the
# current hat may actually sign, and it agrees with the RBAC rung by construction:
# both are keyed on `active_position_id`.
#
# Every gate below is a reason to KEEP the row. Nothing is hidden unless the ladder
# positively says another post owns it:
#   * no active position (System Admin, an unmapped login)      -> hide nothing
#   * the login holds one post                                  -> hide nothing
#   * a non-ladder instance, or a chain with no rung to read     -> keep
#   * a fallback rung, which names people and not a post         -> keep
#   * a delegate, who holds none of the rung's posts             -> keep


async def _active_position_count(db, employee_id: int) -> int:
    return int(await db.scalar(
        select(func.count(HcmPositionAssignment.id)).where(
            HcmPositionAssignment.employee_id == employee_id,
            HcmPositionAssignment.is_active.is_(True),
        )
    ) or 0)


def _chain_link_at(chain, sequence) -> dict | None:
    """The rung at `sequence` in a raw resolved_chain — no Instance needed."""
    for link in chain or []:
        if isinstance(link, dict) and link.get("sequence") == sequence:
            return link
    return None


async def instances_for_other_hats(db, user,
                                   doc_types: list[str] | None = None) -> set[int]:
    """Instances waiting on a post this login holds but is NOT currently wearing.

    One extra read, and only for a login that holds more than one post — a single-hat
    approver takes the same path they always did, and pays for nothing.

    Three columns, not Instance objects: a monthly cycle can put several hundred
    documents in one approver's queue, and this needs the chain and nothing else.
    Memoised on the session, which `get_db` gives out one per request — the queue, its
    tiles and the consolidation tab all ask the same question of the same hat, and it
    cannot change inside one call.
    """
    active_position_id = getattr(user, "active_position_id", None)
    if active_position_id is None:
        return set()

    key = (user.id, active_position_id, tuple(sorted(doc_types)) if doc_types else None)
    memo = db.info.setdefault("workflow_other_hats", {})
    if key in memo:
        return memo[key]

    if await _active_position_count(db, user.id) < 2:
        memo[key] = set()
        return memo[key]

    conditions = [
        Pending.approver_id == user.id,
        Instance.status == InstanceStatus.IN_PROGRESS.value,
    ]
    if doc_types:
        conditions.append(Pending.doc_type.in_(doc_types))
    rows = (await db.execute(
        select(Pending.instance_id, Pending.stage_sequence, Instance.resolved_chain)
        .join(Instance, Instance.id == Pending.instance_id)
        .where(*conditions)
    )).all()

    hidden: set[int] = set()
    for instance_id, stage_sequence, chain in rows:
        # The rung the ROW is about, not whatever the instance has since moved to.
        link = _chain_link_at(chain, stage_sequence)
        if link is None:
            continue
        allowed = ladder.allowed_position_ids(link)
        if not allowed:
            continue
        if int(user.id) not in {int(value) for value in link.get("approver_ids", [])}:
            continue
        if int(active_position_id) in allowed:
            continue
        hidden.add(instance_id)
    memo[key] = hidden
    return hidden


async def other_hat_condition(db, user, doc_types: list[str] | None = None):
    """The WHERE clause that keeps another hat's work out of this queue, or None.

    None means "add nothing" — the overwhelmingly common case, and the one where the
    query must stay byte-for-byte what it was.
    """
    hidden = await instances_for_other_hats(db, user, doc_types)
    return Pending.instance_id.notin_(hidden) if hidden else None


def _pending_row(row) -> dict:
    due_at = row.Pending.due_at
    return {
        "instance_id": row.Pending.instance_id, "doc_type": row.Pending.doc_type,
        "doc_id": row.Pending.doc_id, "stage_sequence": row.Pending.stage_sequence,
        "doc_no": row.Pending.doc_no, "summary": row.Pending.doc_summary,
        "requested_by_name": row.Pending.requested_by_name,
        "amount": float(row.Pending.amount) if row.Pending.amount is not None else None,
        "waiting_since": row.Pending.created_at.isoformat() if row.Pending.created_at else None,
        "due_at": due_at.isoformat() if due_at else None,
        # Decided here, not in the browser. These timestamps are naive UTC, so a
        # client parsing them as local time got a different answer to the server's
        # own `overdue_only` filter — the tile said 0 while the filter returned a row.
        "overdue": bool(due_at and due_at < utcnow()),
        "current_stage_name": row.Instance.current_stage_name,
    }


def _pending_conditions(user, doc_types: list[str] | None = None) -> list:
    conditions = [
        Pending.approver_id == user.id,
        # A pending row on a finished instance is stale by definition — every
        # terminal transition already calls _clear_pending. Reading through the
        # instance status costs nothing for healthy data and stops rows that
        # escaped an earlier code path from being handed out as live work.
        Instance.status == InstanceStatus.IN_PROGRESS.value,
    ]
    if doc_types:
        conditions.append(Pending.doc_type.in_(doc_types))
    return conditions


async def pending_for_user(db, user, doc_types: list[str] | None = None) -> list[dict]:
    conditions = _pending_conditions(user, doc_types)
    other_hat = await other_hat_condition(db, user, doc_types)
    if other_hat is not None:
        conditions.append(other_hat)
    rows = (await db.execute(
        select(Pending, Instance)
        .join(Instance, Instance.id == Pending.instance_id)
        .where(*conditions)
        .order_by(Pending.created_at.desc())
    )).all()
    return [_pending_row(row) for row in rows]


async def pending_counts_for_user(db, user,
                                  doc_types: list[str] | None = None) -> tuple[int, int]:
    """How many are waiting on this login, and how many of those are overdue.

    Two COUNTs, where the Home dashboard used to call `pending_for_user` and take
    `len()` of the result. That materialised EVERY pending row and built a Python dict
    per row on the single most frequently hit endpoint in the system — an approver with
    a backlog of a few thousand pulled all of them to render one number.

    The conditions come from `_pending_conditions` and `other_hat_condition`, the same
    two the list uses, so who a document is waiting on is decided in exactly one place
    and this can never drift from the queue it counts.

    Overdue is `due_at < utcnow()` in SQL rather than parsed per row in Python —
    matching `_pending_row`'s own `overdue` flag, which is naive UTC for the same
    reason.
    """
    conditions = _pending_conditions(user, doc_types)
    other_hat = await other_hat_condition(db, user, doc_types)
    if other_hat is not None:
        conditions.append(other_hat)

    base = (
        select(func.count(Pending.id))
        .select_from(Pending)
        .join(Instance, Instance.id == Pending.instance_id)
        .where(*conditions)
    )
    total = int(await db.scalar(base) or 0)
    overdue = int(await db.scalar(
        base.where(Pending.due_at.isnot(None), Pending.due_at < utcnow())
    ) or 0)
    return total, overdue


async def pending_page(db, user, page: int, size: int,
                       doc_types: list[str] | None = None) -> dict:
    """`pending_for_user` as a page. Rule 11: every list answers {items,total,page,size}."""
    conditions = _pending_conditions(user, doc_types)
    other_hat = await other_hat_condition(db, user, doc_types)
    if other_hat is not None:
        conditions.append(other_hat)
    total = int(await db.scalar(
        select(func.count(Pending.id))
        .select_from(Pending)
        .join(Instance, Instance.id == Pending.instance_id)
        .where(*conditions)
    ) or 0)
    rows = (await db.execute(
        select(Pending, Instance)
        .join(Instance, Instance.id == Pending.instance_id)
        .where(*conditions)
        .order_by(Pending.created_at.desc())
        .offset((page - 1) * size).limit(size)
    )).all()
    return {"items": [_pending_row(row) for row in rows],
            "total": total, "page": page, "size": size}


async def history(db, doc_type: str, doc_id: int) -> list[Action]:
    instance = await _load_instance(db, doc_type, doc_id)
    if instance is None:
        return []
    return list((await db.execute(
        select(Action).where(Action.instance_id == instance.id).order_by(Action.acted_at, Action.id)
    )).scalars().all())


async def actionable_doc_ids(db, doc_type, doc_ids: list[int], user) -> set[int]:
    """Of these documents, which can this login sign RIGHT NOW.

    `doc_type` takes one type or several — an allocation is raised as ALLOCATION or
    OWN_STOCK_ALLOCATION depending on whose stock it draws on, and a batch holds both.

    Mirrors the two checks `_act_ladder` makes — is the user on the current stage's
    pending list, and is their ACTIVE position one the ladder named — so a screen can
    grey out what it cannot sign instead of offering a button that errors.

    The active position matters because one person often wears two hats: an Assistant
    Manager who is also the Inventory Manager approves level 1 under one post and
    level 2 under the other, and the batch screen kept offering level 2 while they
    were still wearing the level-1 hat.
    """
    if not doc_ids:
        return set()

    rows = (await db.execute(
        select(Pending.doc_id, Instance)
        .join(Instance, Instance.id == Pending.instance_id)
        .where(
            Pending.doc_type.in_(
                [doc_type] if isinstance(doc_type, str) else list(doc_type)),
            Pending.doc_id.in_(doc_ids),
            Pending.approver_id == user.id,
            Pending.stage_sequence == Instance.current_sequence,
            Instance.status == InstanceStatus.IN_PROGRESS.value,
        )
    )).all()

    active_position_id = getattr(user, "active_position_id", None)
    out: set[int] = set()
    for doc_id, instance in rows:
        link = _link(instance)
        if link is None:
            continue
        allowed = ladder.allowed_position_ids(link)
        # Same exemption as the guard: a fallback rung names people, not a post, so
        # there is no position to switch to and the holder may act under any hat.
        if (allowed
                and user.id in link.get("approver_ids", [])
                and active_position_id not in allowed):
            continue
        out.add(doc_id)
    return out


async def pending_approver_names(db, doc_type, doc_ids: list[int]) -> dict[int, list[str]]:
    """{doc_id: who it is waiting on} for a whole screenful, in one query.

    `current_approvers` answers this one document at a time and loads an employee per
    approver; a 900-allocation cycle cannot ask it 900 times. Names only — a screen
    saying "waiting on someone else" tells the reader nothing they can act on.

    Reads `wf_pending` and the HCM mirror. Writes nothing, and decides nothing about
    who MAY approve: that is `actionable_doc_ids`, which stays the only answer the
    buttons are allowed to use.
    """
    if not doc_ids:
        return {}
    rows = (await db.execute(
        select(Pending.doc_id, HcmEmployee.full_name)
        .join(Instance, Instance.id == Pending.instance_id)
        .join(HcmEmployee, HcmEmployee.id == Pending.approver_id)
        .where(
            Pending.doc_type.in_(
                [doc_type] if isinstance(doc_type, str) else list(doc_type)),
            Pending.doc_id.in_(doc_ids),
            Pending.stage_sequence == Instance.current_sequence,
            Instance.status == InstanceStatus.IN_PROGRESS.value,
        )
    )).all()
    out: dict[int, list[str]] = {}
    for doc_id, name in rows:
        if name and name not in out.setdefault(doc_id, []):
            out[doc_id].append(name)
    return out
