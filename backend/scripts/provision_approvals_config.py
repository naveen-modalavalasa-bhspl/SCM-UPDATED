"""Add the Settings > Approvals Config screen to an existing database.

`scripts.seed` rebuilds the whole page tree and prunes anything not in it, which
destroys real data on a live server. This only inserts (or repairs) the one row and
nothing else, so it is safe to run against production.

    .venv/Scripts/python -m scripts.provision_approvals_config
"""
import asyncio

from sqlalchemy import select

from app.core.database import SessionLocal
from app.platform.rbac import permissions as P
from app.platform.rbac.models import Page, Permission, Role, RolePermission
from app.shared.enums import UserRole

CODE = "admin_approvals_config"
PATH = "/admin/approvals-config"
NAME = "Approvals Config"
PARENT_CODE = "grp_settings"
SORT_ORDER = 95


async def _one(db, model, **filters):
    return (await db.execute(select(model).filter_by(**filters))).scalar_one_or_none()


async def provision() -> None:
    async with SessionLocal() as db:
        parent = await _one(db, Page, code=PARENT_CODE)
        if parent is None:
            raise RuntimeError(
                f"The {PARENT_CODE!r} menu group is missing — this database has not been "
                "seeded with the page tree.")

        permission = await _one(db, Permission, code=P.ADMIN_WORKFLOW_MANAGE)
        if permission is None:
            permission = Permission(code=P.ADMIN_WORKFLOW_MANAGE, module="admin",
                                    resource="workflow", action="manage",
                                    description="Manage approval workflows")
            db.add(permission)
            await db.flush()

        admin = await _one(db, Role, code=UserRole.ADMIN.value)
        if admin is not None and await _one(
            db, RolePermission, role_id=admin.id, permission_id=permission.id
        ) is None:
            db.add(RolePermission(role_id=admin.id, permission_id=permission.id))

        page = await _one(db, Page, code=CODE)
        if page is None:
            page = Page(code=CODE)
            db.add(page)
        page.path = PATH
        page.name = NAME
        page.icon = "list-ordered"
        page.parent_id = parent.id
        page.sort_order = SORT_ORDER
        page.required_permission = P.ADMIN_WORKFLOW_MANAGE
        page.is_active = True

        # The pages that used to sit at 95..99 shift down one so the new screen lands
        # directly under Approval Workflows instead of on top of the Rules Engine.
        moved = {"admin_rules": 96, "admin_numbering": 97, "admin_notifications": 98,
                 "admin_audit": 99, "admin_fallback": 100}
        for code, order in moved.items():
            row = await _one(db, Page, code=code)
            if row is not None:
                row.sort_order = order

        await db.commit()
        print(f"Provisioned {NAME} at {PATH} (permission {P.ADMIN_WORKFLOW_MANAGE}).")


if __name__ == "__main__":
    asyncio.run(provision())
