"""Position-aware RBAC read logic: effective roles, permissions, and menu."""
from sqlalchemy import exists, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.hcm.models import (
    HcmDepartment, HcmOffice, HcmPosition, HcmPositionAssignment,
)
from app.platform.rbac.models import Page, Permission, Role, RolePermission, UserRole


async def get_user_roles(
    db: AsyncSession, employee_id: int, position_id: int | None = None,
) -> list[Role]:
    stmt = (
        select(Role)
        .join(UserRole, UserRole.role_id == Role.id)
        .where(
            UserRole.employee_id == employee_id,
            Role.is_active.is_(True),
            Role.code.notin_(["REQUESTER", "APPROVER"]),
        )
    )
    roles = {row.id: row for row in (await db.execute(stmt)).scalars().all()}

    automatic_codes = {"REQUESTER"}
    if position_id is not None:
        manages_people = await db.scalar(select(exists().where(
            HcmPosition.parent_position_id == position_id,
            HcmPosition.is_active.is_(True),
        )))
        if manages_people:
            automatic_codes.add("APPROVER")
    automatic = (await db.execute(
        select(Role).where(Role.code.in_(automatic_codes), Role.is_active.is_(True))
    )).scalars().all()
    roles.update({row.id: row for row in automatic})
    return sorted(roles.values(), key=lambda row: row.id)


async def get_user_permissions(
    db: AsyncSession, user, position_id: int | None = None,
) -> set[str]:
    roles = await get_user_roles(db, user.id, position_id)
    role_ids = [role.id for role in roles]
    if not role_ids:
        return set()
    stmt = (
        select(Permission.code)
        .join(RolePermission, RolePermission.permission_id == Permission.id)
        .where(RolePermission.role_id.in_(role_ids))
    )
    return set((await db.execute(stmt)).scalars().all())


async def get_user_positions(db: AsyncSession, employee_id: int) -> list[dict]:
    stmt = (
        select(
            HcmPosition.id, HcmPosition.name,
            func.coalesce(
                HcmPositionAssignment.department_id, HcmPosition.department_id,
            ).label("department_id"),
            HcmDepartment.name.label("department_name"),
            func.coalesce(
                HcmPositionAssignment.office_id, HcmPosition.office_id,
            ).label("office_id"),
            HcmOffice.name.label("office_name"),
            HcmPositionAssignment.is_primary,
        )
        .join(HcmPositionAssignment, HcmPositionAssignment.position_id == HcmPosition.id)
        .outerjoin(HcmDepartment, HcmDepartment.id == func.coalesce(
            HcmPositionAssignment.department_id, HcmPosition.department_id,
        ))
        .outerjoin(HcmOffice, HcmOffice.id == func.coalesce(
            HcmPositionAssignment.office_id, HcmPosition.office_id,
        ))
        .where(
            HcmPositionAssignment.employee_id == employee_id,
            HcmPositionAssignment.is_active.is_(True),
        )
        .order_by(HcmPositionAssignment.is_primary.desc(), HcmPosition.name)
    )
    rows = (await db.execute(stmt)).all()
    return [{
        "id": r.id, "name": r.name, "department_id": r.department_id,
        "department_name": r.department_name, "office_id": r.office_id,
        "office_name": r.office_name, "is_primary": r.is_primary,
    } for r in rows]


async def get_assigned_position(
    db: AsyncSession, employee_id: int, position_id: int,
) -> dict | None:
    return next(
        (row for row in await get_user_positions(db, employee_id)
         if row["id"] == position_id),
        None,
    )


async def get_default_position(db: AsyncSession, employee_id: int) -> dict | None:
    positions = await get_user_positions(db, employee_id)
    return positions[0] if positions else None


async def get_user_menu(db: AsyncSession, permissions: set[str]) -> list[dict]:
    """Pages the user may see (required_permission null or held), built into a tree."""
    rows = (await db.execute(
        select(Page).where(Page.is_active.is_(True)).order_by(Page.sort_order)
    )).scalars().all()

    visible = [p for p in rows if not p.required_permission or p.required_permission in permissions]

    def node(p: Page) -> dict:
        return {"code": p.code, "path": p.path, "name": p.name, "icon": p.icon,
                "module": p.module, "show_on_mobile": p.show_on_mobile, "children": []}

    by_id = {p.id: node(p) for p in visible}
    roots: list[dict] = []
    for p in visible:
        n = by_id[p.id]
        if p.parent_id and p.parent_id in by_id:
            by_id[p.parent_id]["children"].append(n)
        else:
            roots.append(n)
    return roots
