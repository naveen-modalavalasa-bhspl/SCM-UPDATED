"""Provision only the Workflow administration screen and its Admin permission.

Safe to run repeatedly:
    .venv/Scripts/python -m scripts.provision_workflow_ui
"""
import asyncio

from sqlalchemy import select

from app.core.database import SessionLocal, engine
from app.platform.rbac import permissions as P
from app.platform.rbac.models import Page, Permission, Role, RolePermission
from app.shared.enums import UserRole


async def _one(db, model, **filters):
    return (await db.execute(select(model).filter_by(**filters))).scalar_one_or_none()


async def provision() -> None:
    async with SessionLocal() as db:
        permission = await _one(db, Permission, code=P.ADMIN_WORKFLOW_MANAGE)
        if permission is None:
            permission = Permission(
                code=P.ADMIN_WORKFLOW_MANAGE,
                module="admin",
                resource="workflow",
                action="manage",
                description="Manage approval workflows",
            )
            db.add(permission)
            await db.flush()

        admin_role = await _one(db, Role, code=UserRole.ADMIN.value)
        if admin_role is None:
            raise RuntimeError("ADMIN role is missing; run the normal foundation seed first")

        role_permission = await _one(
            db,
            RolePermission,
            role_id=admin_role.id,
            permission_id=permission.id,
        )
        if role_permission is None:
            db.add(RolePermission(role_id=admin_role.id, permission_id=permission.id))

        settings = await _one(db, Page, code="grp_settings")
        if settings is None:
            settings = Page(
                code="grp_settings",
                path="/admin",
                name="Settings",
                icon="settings",
                sort_order=90,
                required_permission=P.ADMIN_ROLES_MANAGE,
                show_on_mobile=True,
                is_active=True,
            )
            db.add(settings)
            await db.flush()

        page = await _one(db, Page, code="admin_workflows")
        if page is None:
            page = Page(code="admin_workflows", path="/admin/workflows",
                        name="Approval Workflows")
            db.add(page)

        page.path = "/admin/workflows"
        page.name = "Approval Workflows"
        page.icon = "route"
        page.module = "admin"
        page.parent_id = settings.id
        page.sort_order = 94
        page.required_permission = P.ADMIN_WORKFLOW_MANAGE
        page.show_on_mobile = True
        page.is_active = True

        policies_page = await _one(db, Page, code="admin_policies")
        if policies_page is None:
            policies_page = Page(
                code="admin_policies",
                path="/admin/policies",
                name="Approval & Automation",
            )
            db.add(policies_page)

        policies_page.path = "/admin/policies"
        policies_page.name = "Approval & Automation"
        policies_page.icon = "sparkles"
        policies_page.module = "admin"
        policies_page.parent_id = settings.id
        policies_page.sort_order = 93
        policies_page.required_permission = P.ADMIN_WORKFLOW_MANAGE
        policies_page.show_on_mobile = True
        policies_page.is_active = True

        await db.commit()
        print(
            "Provisioned /admin/policies, /admin/workflows and granted "
            f"{P.ADMIN_WORKFLOW_MANAGE} to {admin_role.code}."
        )


if __name__ == "__main__":
    async def main() -> None:
        try:
            await provision()
        finally:
            await engine.dispose()

    asyncio.run(main())
