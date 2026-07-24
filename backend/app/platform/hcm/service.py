"""Read helpers over the HCM mirror. Used by the workflow resolver and modules.
These read hcm_* tables; they never write them.
"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.hcm.models import (
    HcmDepartment, HcmEmployee, HcmPosition, HcmPositionAssignment,
)


async def get_employee(db: AsyncSession, employee_id: int) -> HcmEmployee | None:
    return await db.get(HcmEmployee, employee_id)


async def get_position_holders(db: AsyncSession, position_id: int,
                               department_id: int | None = None) -> list[HcmEmployee]:
    """Active employees holding a position, optionally scoped to a department."""
    stmt = select(HcmPositionAssignment.employee_id).where(
        HcmPositionAssignment.position_id == position_id,
        HcmPositionAssignment.is_active.is_(True),
    )
    if department_id is not None:
        stmt = stmt.where(HcmPositionAssignment.department_id == department_id)
    emp_ids = [r for r in (await db.execute(stmt)).scalars().all() if r is not None]

    if not emp_ids:
        # fallback: employees whose primary position is this one
        emp_ids = [
            r for r in (await db.execute(
                select(HcmEmployee.id).where(HcmEmployee.position_id == position_id)
            )).scalars().all()
        ]
    if not emp_ids:
        return []
    rows = await db.execute(
        select(HcmEmployee).where(HcmEmployee.id.in_(emp_ids), HcmEmployee.is_active.is_(True))
    )
    return list(rows.scalars().all())


async def get_department_head(db: AsyncSession, department_id: int) -> HcmEmployee | None:
    dept = await db.get(HcmDepartment, department_id)
    if dept is None or dept.head_employee_id is None:
        return None
    return await get_employee(db, dept.head_employee_id)


async def get_position(db: AsyncSession, position_id: int) -> HcmPosition | None:
    return await db.get(HcmPosition, position_id)
