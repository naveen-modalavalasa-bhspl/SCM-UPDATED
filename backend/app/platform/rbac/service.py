"""RBAC read logic (canonical schema): flat permission set, roles/positions, menu."""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.hcm.models import HcmPosition, HcmPositionAssignment
from app.platform.rbac.models import Page, Permission, Role, RolePermission, UserRole


async def get_user_roles(db: AsyncSession, employee_id: int) -> list[Role]:
    stmt = (
        select(Role)
        .join(UserRole, UserRole.role_id == Role.id)
        .where(UserRole.employee_id == employee_id, Role.is_active.is_(True))
    )
    return list((await db.execute(stmt)).scalars().all())


async def get_user_permissions(db: AsyncSession, user) -> set[str]:
    stmt = (
        select(Permission.code)
        .join(RolePermission, RolePermission.permission_id == Permission.id)
        .join(UserRole, UserRole.role_id == RolePermission.role_id)
        .where(UserRole.employee_id == user.id)
    )
    return set((await db.execute(stmt)).scalars().all())


async def get_user_positions(db: AsyncSession, employee_id: int) -> list[dict]:
    stmt = (
        select(HcmPosition.id, HcmPosition.name)
        .join(HcmPositionAssignment, HcmPositionAssignment.position_id == HcmPosition.id)
        .where(
            HcmPositionAssignment.employee_id == employee_id,
            HcmPositionAssignment.is_active.is_(True),
        )
    )
    rows = (await db.execute(stmt)).all()
    return [{"id": r.id, "name": r.name} for r in rows]


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
