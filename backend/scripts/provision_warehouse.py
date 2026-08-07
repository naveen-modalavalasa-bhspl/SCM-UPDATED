"""Add the Warehouse module's permissions, role grants and menu rows to a live database.

`scripts.seed` rebuilds the whole page tree and prunes anything not in it, which
destroys real data on a live server. This only inserts (or repairs) the warehouse
rows and nothing else, so it is safe to run against production:

    .venv/Scripts/python -m scripts.provision_warehouse

It is idempotent — run it again after a code change and it repairs rather than
duplicates. It never deletes a page, so a screen the seed used to own (`wh_movement`)
is left alone rather than pruned; hide it in Settings if you no longer want it.
"""
import asyncio

from sqlalchemy import select

from app.core.database import SessionLocal
from app.platform.rbac import permissions as P
from app.platform.rbac.models import Page, Permission, Role, RolePermission
from app.shared.enums import UserRole

# The permission rows the module's endpoints check. Sourced from ALL_PERMISSIONS so
# this list cannot drift from permissions.py — that file stays the one definition.
WAREHOUSE_MODULE = "warehouse"

# Everything except the two decisions that cost money. Store runs the floor; approving
# a dispatch or a purchase return belongs to a role sitting above the storekeeper.
STORE_EXCLUDES = {P.DISPATCH_APPROVE, P.RETURN_APPROVE}

# (code, path, name, icon, required_permission, sort_order)
PAGES = [
    ("wh_dashboard", "/warehouse", "Dashboard", "layout-dashboard", P.STOCK_VIEW, 41),
    ("wh_inward", "/warehouse/material-inward", "Material Inward", "truck",
     P.RECEIPT_VIEW, 42),
    ("wh_grn", "/warehouse/grn", "Goods Receipt", "file-text", P.RECEIPT_VIEW, 43),
    ("wh_qc", "/warehouse/quality-inspection", "Quality Inspection", "check-circle",
     P.INSPECTION_VIEW, 44),
    ("wh_putaway", "/warehouse/putaway", "Put-away", "package", P.PUTAWAY_VIEW, 45),
    ("wh_stock_movements", "/warehouse/stock-movements", "Stock Movements", "arrow-right-left", P.STOCK_VIEW, 45),
    ("wh_picklist", "/warehouse/picklist", "Picklists", "list-checks", P.PICKING_VIEW, 46),
    ("wh_issues", "/warehouse/material-issues", "Material Issues", "send", P.ISSUE_VIEW, 47),
    # Packing sits between the issue and the vehicle, so it lists before Dispatch.
    ("wh_consignments", "/warehouse/dispatch/consignments", "Consignments", "boxes",
     P.DISPATCH_VIEW, 48),
    ("wh_dispatch", "/warehouse/dispatch", "Dispatch", "truck", P.DISPATCH_VIEW, 49),
    ("wh_returns", "/warehouse/purchase-returns", "Purchase Returns", "rotate-ccw",
     P.RETURN_VIEW, 50),
    ("wh_notifications", "/warehouse/notifications", "Notifications", "bell",
     P.STOCK_VIEW, 51),
    ("wh_reports", "/warehouse/reports", "Reports", "bar-chart",
     P.WAREHOUSE_REPORT_VIEW, 52),
    ("wh_masters", "/warehouse/masters", "Warehouse Masters", "settings",
     P.MASTER_LOCATION_MANAGE, 53),
]

GROUP = ("grp_warehouse", "/warehouse", "Warehouse", "truck", P.STOCK_VIEW, 40)


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
        wanted = [p for p in P.ALL_PERMISSIONS if p.module == WAREHOUSE_MODULE]
        if not wanted:
            raise RuntimeError(
                "No warehouse permissions in permissions.py — nothing to provision.")

        admin = await _one(db, Role, code=UserRole.ADMIN.value)
        store = await _one(db, Role, code=UserRole.STORE.value)

        added_perms = granted = 0
        for spec in wanted:
            row = await _one(db, Permission, code=spec.code)
            if row is None:
                row = Permission(code=spec.code, module=spec.module, resource=spec.resource,
                                 action=spec.action, description=spec.description)
                db.add(row)
                await db.flush()
                added_perms += 1

            if await _grant(db, admin, row):
                granted += 1
            if spec.code not in STORE_EXCLUDES and await _grant(db, store, row):
                granted += 1

        # Menu rows. The group must exist before its children can point at it.
        code, path, name, icon, perm, order = GROUP
        group = await _one(db, Page, code=code)
        if group is None:
            group = Page(code=code)
            db.add(group)
        group.path, group.name, group.icon = path, name, icon
        group.module, group.parent_id, group.sort_order = WAREHOUSE_MODULE, None, order
        group.required_permission, group.is_active = perm, True
        await db.flush()

        added_pages = 0
        for code, path, name, icon, perm, order in PAGES:
            page = await _one(db, Page, code=code)
            if page is None:
                page = Page(code=code)
                db.add(page)
                added_pages += 1
            page.path, page.name, page.icon = path, name, icon
            page.module, page.parent_id, page.sort_order = WAREHOUSE_MODULE, group.id, order
            page.required_permission, page.is_active = perm, True

        await db.commit()
        print(f"Permissions: {added_perms} added, {len(wanted) - added_perms} already present.")
        print(f"Role grants: {granted} added (admin = all, store = all but "
              f"{', '.join(sorted(STORE_EXCLUDES))}).")
        print(f"Menu: {added_pages} pages added, {len(PAGES) - added_pages} updated.")
        print("Restart the API so the new router and permissions are picked up.")


if __name__ == "__main__":
    asyncio.run(provision())
