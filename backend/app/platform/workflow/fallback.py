"""The floor underneath the two engines.

Both the approval engine and the rules engine are configuration-driven, so a row
nobody created — or a position nobody filled — could strand a document forever. This
module is the guarantee that it cannot: when configuration fails to produce an
approver, the document climbs the plain reporting line instead.

    requester -> reporting manager -> their manager -> theirs   (three levels)

The chain is defined HERE, in code, not in a table. A database-driven fallback would
share the failure mode it exists to protect against.

Two triggers, both handled:
  * no active workflow for the document type at all
  * a stage inside a real workflow that resolves to nobody (vacant position,
    deactivated employee, role with no holders)

Every activation is recorded twice — a wf_actions row and a warning-level audit entry
— because a fallback that fires silently is a misconfiguration nobody ever fixes.
"""
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.hcm import service as hcm_service
from app.platform.hcm.models import HcmEmployee
from app.platform.rbac.models import Role, UserRole
from app.platform.workflow.models import Action, Stage, Workflow
from app.shared.enums import (
    ApprovalAction, ApprovalMode, ApproverType, AuditAction, UserRole as RoleCode,
)
from app.shared.models.base import utcnow

logger = logging.getLogger(__name__)

# How far up the reporting line to go before giving up. Three is deep enough to clear
# a vacant post or two without turning a stationery request into a board matter.
MAX_LEVELS = 3

REASON_NO_WORKFLOW = "NO_WORKFLOW"
REASON_EMPTY_STAGE = "EMPTY_STAGE"
REASON_LADDER = "REPORTING_LADDER"
REASON_ADMIN = "ADMIN_SAFETY_NET"
# Every floor gave way: no configured approver, no reporting line, no admin. The
# document is left stuck rather than failing the caller -- see engine._materialize_pending.
REASON_NO_APPROVER = "NO_APPROVER_STUCK"


async def ladder_approvers(db: AsyncSession, requester_id: int | None,
                           requester_position_id: int | None,
                           levels: int = MAX_LEVELS) -> list[HcmEmployee]:
    """Walk up hcm_positions.parent_position_id, collecting holders at each level.

    Stops early at the top of the tree. The requester is never returned as their own
    approver, and a manager who holds two of the positions walked is returned once.
    """
    if requester_id is None or requester_position_id is None:
        return []

    approvers: list[HcmEmployee] = []
    seen: set[int] = {requester_id}
    position_id = requester_position_id

    for _ in range(levels):
        position = await hcm_service.get_position(db, position_id)
        if not position or not position.parent_position_id:
            break
        for holder in await hcm_service.get_position_holders(db,
                                                             position.parent_position_id):
            if holder.id not in seen and holder.is_active:
                approvers.append(holder)
                seen.add(holder.id)
        position_id = position.parent_position_id

    return approvers


async def admin_approvers(db: AsyncSession) -> list[HcmEmployee]:
    """The terminal safety net: holders of the ADMIN role.

    Reached when the requester has no position, or sits at the top of the tree. A
    document is never left with zero approvers.
    """
    stmt = (select(HcmEmployee)
            .join(UserRole, UserRole.employee_id == HcmEmployee.id)
            .join(Role, Role.id == UserRole.role_id)
            .where(Role.code == RoleCode.ADMIN.value, HcmEmployee.is_active.is_(True)))
    return list((await db.execute(stmt)).scalars().unique().all())


async def resolve(db: AsyncSession, requester_id: int | None,
                  requester_position_id: int | None) -> tuple[list[HcmEmployee], str]:
    """Returns (approvers, reason). The reason names which floor caught the document."""
    approvers = await ladder_approvers(db, requester_id, requester_position_id)
    if approvers:
        return approvers, REASON_LADDER
    return await admin_approvers(db), REASON_ADMIN


async def ensure_workflow(db: AsyncSession, doc_type: str) -> Workflow:
    """Materialise the ladder as a real one-stage workflow for this doc type.

    Creating the rows rather than special-casing the engine means act(), history() and
    current_approvers() all keep working unchanged, and the approval stays fully
    auditable in wf_actions. The definition still comes from code — this only writes
    down what code decided, and an admin can edit it afterwards.
    """
    wf = Workflow(
        code=f"WF-FALLBACK-{doc_type}",
        name=f"{doc_type.title()} approval (auto-created fallback)",
        doc_type=doc_type, is_active=True, effective_from=utcnow().date(),
    )
    db.add(wf)
    await db.flush()
    db.add(Stage(
        workflow_id=wf.id, sequence=1, name="Reporting Manager (fallback)",
        approver_type=ApproverType.REPORTING_MANAGER.value,
        approval_mode=ApprovalMode.ANY_ONE.value,
    ))
    await db.flush()
    logger.warning(
        "No active approval workflow for %r; created %s from the hardcoded reporting "
        "ladder. Configure a real one under Settings > Workflows.", doc_type, wf.code)
    return wf


async def record(db: AsyncSession, instance, reason: str, approvers: list,
                 stage_name: str | None = None) -> None:
    """Log one fallback activation, in both places.

    wf_actions so it shows in the document's own approval history, and the audit log
    so somebody can find every fallback across every document on one screen.
    """
    names = ", ".join(a.full_name for a in approvers) or "nobody"
    db.add(Action(
        instance_id=instance.id,
        stage_sequence=instance.current_sequence or 0,
        stage_name=stage_name or "Fallback",
        actor_id=None, actor_name="System",
        action=ApprovalAction.FALLBACK.value,
        comments=f"{reason}: routed to {names}",
    ))
    logger.warning("Approval fallback (%s) on %s %s -> %s",
                   reason, instance.doc_type, instance.doc_no or instance.doc_id, names)

    # Imported here, not at module import time: settings imports workflow models, so a
    # top-level import would close a cycle.
    from app.platform.settings.service import write_audit
    await write_audit(
        db, entity="wf_instances", entity_id=instance.id,
        # Always an explicit short value: write_audit falls back to `summary` for
        # entity_no, and sys_audit_log.entity_no is only 50 chars.
        entity_no=(instance.doc_no or f"{instance.doc_type}-{instance.doc_id}")[:50],
        action=AuditAction.UPDATE,
        after={"fallback": reason, "approvers": names},
        summary=f"Approval fallback ({reason})",
    )
    await db.flush()
