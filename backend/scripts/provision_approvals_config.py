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
        # Create the parent group rather than refuse without it.
        #
        # It used to raise, on the reasoning that a database with no page tree is one
        # somebody should look at by hand. That is true of an EXISTING server, which is
        # what this script was written for — but `scripts.bootstrap` runs it against a
        # brand new database, where the page tree does not exist yet: "Menu pages" is
        # the LAST of its nine steps, deliberately, so PAGE_TREE settles the ordering
        # the module provisioners each set for themselves. So bootstrap died here every
        # time on a genuinely fresh database, and the four steps after this one never
        # ran — leaving no menu at all and an app that looked deployed but had half a
        # left rail.
        #
        # `provision_workflow_ui` already mints this same row for the same reason; the
        # values match it and PAGE_TREE (seed.py) exactly. "Menu pages" still runs last
        # and still settles the row, so nothing about the ordering intent changes.
        parent = await _one(db, Page, code=PARENT_CODE)
        if parent is None:
            parent = Page(
                code=PARENT_CODE,
                path="/admin",
                name="Settings",
                icon="settings",
                sort_order=90,
                required_permission=P.ADMIN_ROLES_MANAGE,
                show_on_mobile=True,
                is_active=True,
            )
            db.add(parent)
            await db.flush()
            print(f"created the {PARENT_CODE!r} menu group")

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
