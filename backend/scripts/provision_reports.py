"""Add the Reports module's permissions, Admin grants and menu rows to a live database.

`scripts.seed` rebuilds the whole page tree and prunes anything not in it, which
destroys real data on a live server. This only inserts (or repairs) the reports rows
and nothing else, so it is safe to run against production:

    .venv/Scripts/python -m scripts.provision_reports

Both lists are derived, not retyped: the permissions come from `permissions.py`
(module == "reports") and the pages from `seed.PAGE_TREE` (codes under
`grp_reports`), so this script cannot drift from the definitions the app reads.

Granted to Admin only, on purpose. A ledger shows every indent, every approval
decision and every stock movement in the company regardless of who raised them, so
it widens visibility further than any single module screen does — an admin ticks
`report.view` on for the roles that should have it. Idempotent: run it again after a
code change and it repairs rather than duplicates, and it never deletes a page.
"""
import asyncio

from sqlalchemy import select

from app.core.database import SessionLocal
from app.platform.rbac import permissions as P
from app.platform.rbac.models import Page, Permission, Role, RolePermission
from app.shared.enums import UserRole
from scripts.seed import PAGE_TREE

REPORTS_MODULE = "reports"
GROUP_CODE = "grp_reports"


async def _one(db, model, **filters):
    return (await db.execute(select(model).filter_by(**filters))).scalar_one_or_none()


async def _grant(db, role, permission) -> bool:
    if role is None:
        return False
    if await _one(db, RolePermission, role_id=role.id, permission_id=permission.id):
        return False
    db.add(RolePermission(role_id=role.id, permission_id=permission.id))
    return True


async def provision() -> None:
    async with SessionLocal() as db:
        wanted = [p for p in P.ALL_PERMISSIONS if p.module == REPORTS_MODULE]
        if not wanted:
            raise RuntimeError(
                "No reports permissions in permissions.py — nothing to provision.")

        admin = await _one(db, Role, code=UserRole.ADMIN.value)

        added_perms = granted = 0
        for spec in wanted:
            row = await _one(db, Permission, code=spec.code)
            if row is None:
                row = Permission(code=spec.code, module=spec.module,
                                 resource=spec.resource, action=spec.action,
                                 description=spec.description)
                db.add(row)
                await db.flush()
                added_perms += 1
            if await _grant(db, admin, row):
                granted += 1

        # Menu rows. The group must exist before its children can point at it.
        tree = {code: row for row in PAGE_TREE for code in (row[0],)}
        group_spec = tree.get(GROUP_CODE)
        if group_spec is None:
            raise RuntimeError(f"{GROUP_CODE} is missing from seed.PAGE_TREE.")

        code, path, name, icon, perm, order, _parent = group_spec
        group = await _one(db, Page, code=code)
        if group is None:
            group = Page(code=code)
            db.add(group)
        group.path, group.name, group.icon = path, name, icon
        group.module, group.parent_id, group.sort_order = REPORTS_MODULE, None, order
        group.required_permission, group.is_active = perm, True
        await db.flush()

        children = [row for row in PAGE_TREE if row[6] == GROUP_CODE]
        added_pages = 0
        for code, path, name, icon, perm, order, _parent in children:
            page = await _one(db, Page, code=code)
            if page is None:
                page = Page(code=code)
                db.add(page)
                added_pages += 1
            page.path, page.name, page.icon = path, name, icon
            page.module, page.parent_id, page.sort_order = REPORTS_MODULE, group.id, order
            page.required_permission, page.is_active = perm, True

        await db.commit()
        print(f"Permissions: {added_perms} added, "
              f"{len(wanted) - added_perms} already present.")
        print(f"Role grants: {granted} added (admin only — grant report.view to other "
              f"roles from Settings once you want them to see it).")
        print(f"Menu: {added_pages} pages added, "
              f"{len(children) - added_pages} updated.")
        print("Restart the API so the new routers and permissions are picked up.")


if __name__ == "__main__":
    asyncio.run(provision())
