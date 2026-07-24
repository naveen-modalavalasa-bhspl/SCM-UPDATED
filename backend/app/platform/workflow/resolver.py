"""Given a stage + document, work out which real users may approve.

This is where routing bugs hide, so it is tested directly. Handles all five
approver types and expands through active delegations.
"""
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.hcm import service as hcm_service
from app.platform.hcm.models import HcmEmployee
from app.platform.rbac.models import UserRole
from app.platform.workflow.models import Delegation
from app.shared.enums import ApproverType


async def _role_holders(db: AsyncSession, role_id: int | None) -> list[HcmEmployee]:
    if role_id is None:
        return []
    stmt = (
        select(HcmEmployee)
        .join(UserRole, UserRole.employee_id == HcmEmployee.id)
        .where(UserRole.role_id == role_id, HcmEmployee.is_active.is_(True))
    )
    return list((await db.execute(stmt)).scalars().all())


async def _reporting_manager(db: AsyncSession, requester_id: int | None) -> list[HcmEmployee]:
    """Walk one level up the position tree from the requester's position."""
    if requester_id is None:
        return []
    requester = await hcm_service.get_employee(db, requester_id)
    if not requester or not requester.position_id:
        return []
    position = await hcm_service.get_position(db, requester.position_id)
    if not position or not position.parent_position_id:
        return []
    return await hcm_service.get_position_holders(db, position.parent_position_id)


async def _expand_delegations(db: AsyncSession, approvers: list[HcmEmployee]) -> list[HcmEmployee]:
    if not approvers:
        return approvers
    now = datetime.now(timezone.utc)
    ids = {a.id for a in approvers}
    rows = (await db.execute(
        select(Delegation).where(Delegation.is_active.is_(True),
                                 Delegation.from_user_id.in_(ids))
    )).scalars().all()
    result = {a.id: a for a in approvers}
    for d in rows:
        if d.valid_from and _aware(d.valid_from) > now:
            continue
        if d.valid_to and _aware(d.valid_to) < now:
            continue
        delegate = await hcm_service.get_employee(db, d.to_user_id)
        if delegate and delegate.is_active:
            result[delegate.id] = delegate
    return list(result.values())


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def resolve_approvers(db: AsyncSession, stage, instance, doc_context: dict) -> list[HcmEmployee]:
    t = stage.approver_type
    dept_id = (doc_context or {}).get("department_id")
    approvers: list[HcmEmployee] = []

    if t == ApproverType.POSITION.value:
        approvers = await hcm_service.get_position_holders(db, stage.position_id, department_id=dept_id) \
            or await hcm_service.get_position_holders(db, stage.position_id)
    elif t == ApproverType.ROLE.value:
        approvers = await _role_holders(db, stage.role_id)
    elif t == ApproverType.SPECIFIC_USER.value:
        emp = await hcm_service.get_employee(db, stage.user_id) if stage.user_id else None
        approvers = [emp] if emp and emp.is_active else []
    elif t == ApproverType.DEPT_HEAD.value:
        head = await hcm_service.get_department_head(db, dept_id) if dept_id else None
        approvers = [head] if head and head.is_active else []
    elif t == ApproverType.REPORTING_MANAGER.value:
        approvers = await _reporting_manager(db, instance.started_by)

    return await _expand_delegations(db, approvers)
