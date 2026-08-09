"""Given a stage + document, work out which real users may approve.

This is where routing bugs hide, so it is tested directly. Handles all five
approver types and expands through active delegations.
"""
from datetime import date

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.hcm import service as hcm_service
from app.platform.hcm.models import HcmEmployee
from app.platform.rbac.models import UserRole
from app.platform.workflow.models import Delegation
from app.shared.enums import ApproverType
from app.shared.time import now as ist_now, today as ist_today


async def _role_holders(db: AsyncSession, role_id: int | None) -> list[HcmEmployee]:
    if role_id is None:
        return []
    stmt = (
        select(HcmEmployee)
        .join(UserRole, UserRole.employee_id == HcmEmployee.id)
        .where(UserRole.role_id == role_id, HcmEmployee.is_active.is_(True))
    )
    return list((await db.execute(stmt)).scalars().all())


async def _reporting_manager(
    db: AsyncSession, requester_id: int | None, requester_position_id: int | None,
) -> list[HcmEmployee]:
    """Walk one level up from the position selected when the document was raised."""
    if requester_id is None or requester_position_id is None:
        return []
    position = await hcm_service.get_position(db, requester_position_id)
    if not position or not position.parent_position_id:
        return []
    return await hcm_service.get_position_holders(db, position.parent_position_id)


async def _expand_delegations(
    db: AsyncSession, approvers: list[HcmEmployee], doc_type: str | None,
) -> list[HcmEmployee]:
    if not approvers:
        return approvers
    today = ist_today()
    ids = {a.id for a in approvers}
    rows = (await db.execute(
        select(Delegation).where(
            Delegation.is_active.is_(True),
            Delegation.from_employee_id.in_(ids),
            or_(Delegation.doc_type.is_(None), Delegation.doc_type == doc_type),
        )
    )).scalars().all()
    result = {a.id: a for a in approvers}
    for d in rows:
        if d.valid_from and d.valid_from > today:
            continue
        if d.valid_to and d.valid_to < today:
            continue
        delegate = await hcm_service.get_employee(db, d.to_employee_id)
        if delegate and delegate.is_active:
            result[delegate.id] = delegate
    return list(result.values())

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
        emp = await hcm_service.get_employee(db, stage.employee_id) if stage.employee_id else None
        approvers = [emp] if emp and emp.is_active else []
    elif t == ApproverType.DEPT_HEAD.value:
        head = await hcm_service.get_department_head(db, dept_id) if dept_id else None
        approvers = [head] if head and head.is_active else []
    elif t == ApproverType.REPORTING_MANAGER.value:
        approvers = await _reporting_manager(
            db, instance.started_by_id, (doc_context or {}).get("requester_position_id"),
        )

    return await _expand_delegations(db, approvers, instance.doc_type)
