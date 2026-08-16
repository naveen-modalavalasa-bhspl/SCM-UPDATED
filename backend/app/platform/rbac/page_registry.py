"""Keeps rbac_pages in step with the screens that actually exist.

Adding a screen used to mean editing `scripts/seed.py` PAGE_TREE and reseeding —
and seed PRUNES, so on the live database that deletes real rows. In practice
nobody reseeds, so new screens either never appear in the menu or get bolted on
with a hand-written INSERT.

This module syncs instead of seeding:

  * a page in the catalogue but not in the database is INSERTED, with its own
    `page.<code>.view` permission granted to Admin and nobody else
  * a page in both has its title/parent/order refreshed
  * a page in the database but NOT in the catalogue is LEFT ALONE

That last rule is the important one. It is the difference between a sync and a
seed: this can add and update, it can never delete. A screen someone added
directly, or one from a branch not merged yet, survives untouched.

New pages are Admin-only on purpose — the same fail-closed rule that governs a
job profile HCM invents tomorrow. A new screen must never widen access for
everyone in its module the moment it is deployed; an admin ticks it on when it is
ready to be used.

Runs on startup, so deploying a new screen is enough to register it.
"""
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.rbac import permissions as perms
from app.platform.rbac.models import Page, Permission, Role, RolePermission

ADMIN_ROLE_CODE = "ADMIN"


@dataclass(frozen=True)
class PageDef:
    code: str
    path: str
    name: str
    parent: str | None = None
    icon: str | None = None
    module: str | None = None
    sort_order: int = 0
    show_on_mobile: bool = True
    # A page with no permission is visible to everyone — only Home should be that.
    always_on: bool = False


# The catalogue. A developer adding a screen adds one line here and deploys; the
# row, its permission and the Admin grant appear on the next start.
#
# Only pages this file knows about are managed. Everything already in rbac_pages
# stays exactly as it is, which is why this list does not have to be exhaustive.
PAGES: list[PageDef] = [
    # Sorts AFTER the existing RBAC screens (81, 82) on purpose. The left rail sends
    # a module to its FIRST child, so a new page that sorts first silently becomes
    # the module's front door — and on a backend that predates its endpoint, opening
    # the whole module then 404s. New screens go at the end of their group.
    PageDef("rbac_job_profiles", "/rbac/job-profiles", "Job Profiles",
            parent="grp_rbac", module="rbac", sort_order=83),
    # The asset / consumable code formula. Last in Settings for the reason above.
    PageDef("admin_code_formats", "/admin/code-formats", "Code Formats",
            parent="grp_settings", module="admin", icon="hash", sort_order=102),
    # The API console. Under Settings, last, for the same reason as Code Formats —
    # a new screen must never become a module's front door.
    PageDef("admin_integrations", "/admin/integrations", "Integrations",
            parent="grp_settings", module="integrations", icon="plug",
            sort_order=103),
    # Returns — a module of its own, so the group row comes first and the screens
    # hang off it. sort_order 60 puts it after Warehouse and before Reports.
    PageDef("grp_returns", "/returns", "Returns", module="returns",
            icon="corner-up-left", sort_order=60),
    PageDef("returns_overview", "/returns/dashboard", "Overview",
            parent="grp_returns", module="returns", sort_order=1),
    PageDef("returns_register", "/returns", "All Returns",
            parent="grp_returns", module="returns", sort_order=2),
    PageDef("returns_mine", "/returns/mine", "My Returns",
            parent="grp_returns", module="returns", sort_order=3),
    PageDef("returns_approvals", "/returns/approvals", "Approvals",
            parent="grp_returns", module="returns", sort_order=4),
    # The two desks. Separate rows because they are separate backlogs held by
    # different people, even though one component serves both.
    PageDef("returns_decisions", "/returns/decisions", "Decision Desk",
            parent="grp_returns", module="returns", sort_order=5),
    PageDef("returns_sign_off", "/returns/sign-off", "Sign-off",
            parent="grp_returns", module="returns", sort_order=6),
    PageDef("returns_purchase", "/returns/purchase", "Purchase Returns",
            parent="grp_returns", module="returns", sort_order=7),
    PageDef("returns_receiving_config", "/returns/settings/receiving",
            "Receiving Points", parent="grp_returns", module="returns",
            sort_order=8),
    # The module row itself, listed only to rename it: the menu said "Purchasing"
    # while the permission catalogue, the backend package and the table prefix all
    # said procurement, and the RBAC screen needed a hard-coded alias to reconcile
    # them. The CODE stays `grp_purchasing` — a code is an identity and `sync_pages`
    # can rename a page but never move one. `always_on` keeps `required_permission`
    # untouched (it is `po.view` on the live row) instead of minting an unused
    # `page.grp_purchasing.view` beside it.
    PageDef("grp_purchasing", "/pos", "Procurement", icon="shopping-cart",
            module="procurement", sort_order=30, always_on=True),
    # Procurement's buying chain, under the group that already carries the PO screens.
    # `grp_purchasing`, not `grp_procurement` — the menu row predates the module name
    # and `sync_pages` can add a page but never move one, so the code follows the row.
    # Sorted AFTER po_list (31) so Purchase Orders stays the module's front door: the
    # left rail opens a module on its FIRST child.
    PageDef("pro_requisitions", "/procurement/requisitions", "Requisitions",
            parent="grp_purchasing", module="procurement", sort_order=32),
    PageDef("pro_rfqs", "/procurement/rfqs", "RFQs",
            parent="grp_purchasing", module="procurement", sort_order=33),
    PageDef("pro_quotations", "/procurement/quotations", "Quotations",
            parent="grp_purchasing", module="procurement", sort_order=34),
    # Who outside the company can sign in. Under Settings, not Procurement: it mints
    # an identity, which is an administrator's act rather than a buyer's. Carriers
    # ride on this screen too — a transport provider is a vendor row, so it is the
    # same account and the same button.
    PageDef("admin_supplier_accounts", "/admin/supplier-accounts",
            "Supplier & Carrier Logins", parent="grp_settings",
            module="procurement", icon="key", sort_order=104),
    # The consolidated buying sheet. Last in Procurement so Purchase Orders stays the
    # module's front door — the left rail opens a module on its FIRST child.
    PageDef("pro_consolidations", "/procurement/consolidations", "Consolidation",
            parent="grp_purchasing", module="procurement", sort_order=35),

    # ------------------------------------------------------------------ #
    #  Logistics — the outward transport leg
    # ------------------------------------------------------------------ #
    # A module row of its own. sort_order 55 puts it after Warehouse (which the live
    # rows have in the 40s) and before Returns at 60, which is the order the material
    # actually moves in: warehouse packs it, logistics ships it, returns bring it back.
    PageDef("grp_logistics", "/logistics", "Logistics", module="logistics",
            icon="truck", sort_order=55),
    PageDef("logistics_transport", "/logistics/transport", "Transport Requests",
            parent="grp_logistics", module="logistics", sort_order=1),
    PageDef("logistics_providers", "/logistics/providers", "Provider Selection",
            parent="grp_logistics", module="logistics", sort_order=2),
    PageDef("logistics_tracking", "/logistics/tracking", "Shipment Tracking",
            parent="grp_logistics", module="logistics", sort_order=3),
    PageDef("logistics_exceptions", "/logistics/exceptions", "Exceptions",
            parent="grp_logistics", module="logistics", sort_order=4),
    # Consignments and Dispatch, reached from Logistics as well as from Warehouse.
    # The warehouse rows are NOT touched — they keep their codes, their paths and
    # their permissions, and these are separate rbac_pages rows pointing at the same
    # screens. That is what lets the warehouse copies be retired later by switching
    # them off, with nothing here to change.
    PageDef("logistics_consignments", "/logistics/consignments", "Consignments",
            parent="grp_logistics", module="logistics", sort_order=5),
    PageDef("logistics_dispatch", "/logistics/dispatch", "Dispatch",
            parent="grp_logistics", module="logistics", sort_order=6),
]


async def sync_permission_labels(db: AsyncSession) -> list[str]:
    """Insert catalogue permissions that are missing, and refresh the labels of the rest.

    Inserting is safe and it is the only way a new permission ever becomes grantable:
    the seed is the only thing that ever wrote rbac_permissions, and the seed must not
    run against a live database. Without this, an endpoint added with a new permission
    code checks a permission that exists nowhere, so it 403s for everybody forever and
    no admin can even see it on the Job Profiles screen to tick it on.

    A new permission is granted to Admin and to nobody else, the same fail-closed rule
    `sync_pages` applies to a new screen: inserting the row alone left even the
    administrator 403ing on the endpoint that had just shipped, which is not
    "fail-closed", it is "unreachable". Only on first insert — re-granting on every
    start would undo an admin who deliberately took it off Admin.

    Then, the labels.

    `seed_permissions` inserts through `get_or_create`, whose defaults only apply on
    INSERT. So a permission's module/description is frozen at whatever it was the day
    the row was first created, and every later correction in `permissions.py` is
    silently ignored on any database that already has the row — which is all of them.

    That is how `stock.view` and `stock.adjust` stayed tagged `logistics` long after
    the catalogue moved them to `inventory`, and why the RBAC screens file their
    buttons under a module the screen left. The grouping was never the bug; the label
    was, and nothing was refreshing it.

    `code` is the identity and is never touched, and no grant on an EXISTING permission
    is read or written, so a relabel cannot widen or narrow anyone's access.
    """
    catalogue = {p.code: p for p in perms.ALL_PERMISSIONS}
    rows = (await db.execute(select(Permission))).scalars().all()
    admin_role = (await db.execute(
        select(Role).where(Role.code == ADMIN_ROLE_CODE)
    )).scalars().first()
    changed = []

    by_code = {row.code: row for row in rows}
    for code in sorted(catalogue.keys() - set(by_code)):
        spec = catalogue[code]
        permission = Permission(code=spec.code, module=spec.module,
                                resource=spec.resource, action=spec.action,
                                description=spec.description)
        db.add(permission)
        changed.append(f"{code}: added")
        await db.flush()

        # Admin, plus — for a permission carved out of one already in use — everyone
        # who holds the source (perms.INHERITS_GRANTS_FROM). Fail-closed is right for
        # a new capability and wrong for a split: the split would revoke a button the
        # holder has been pressing since before the deploy.
        role_ids = {admin_role.id} if admin_role is not None else set()
        source = by_code.get(perms.INHERITS_GRANTS_FROM.get(code, ""))
        if source is not None:
            inherited = (await db.execute(
                select(RolePermission.role_id)
                .where(RolePermission.permission_id == source.id)
            )).scalars().all()
            role_ids.update(inherited)
            changed.append(f"{code}: inherited {len(inherited)} grants "
                           f"from {source.code}")
        for role_id in sorted(role_ids):
            db.add(RolePermission(role_id=role_id, permission_id=permission.id))

    for row in rows:
        spec = catalogue.get(row.code)
        if spec is None:
            continue  # not ours: left alone, same rule as an unknown page
        if (row.module, row.resource, row.action) == (
                spec.module, spec.resource, spec.action):
            continue
        changed.append(f"{row.code}: {row.module} -> {spec.module}")
        row.module, row.resource, row.action = spec.module, spec.resource, spec.action
    if changed:
        await db.commit()
    return changed


async def sync_pages(db: AsyncSession) -> dict:
    """Insert missing pages, refresh known ones, delete nothing."""
    existing = {
        page.code: page
        for page in (await db.execute(select(Page))).scalars().all()
    }
    permission_by_code = {
        p.code: p for p in (await db.execute(select(Permission))).scalars().all()
    }
    admin_role = (await db.execute(
        select(Role).where(Role.code == ADMIN_ROLE_CODE)
    )).scalars().first()

    added, updated = [], []
    for spec in PAGES:
        parent = existing.get(spec.parent) if spec.parent else None
        if spec.parent and parent is None:
            # Parent not deployed yet: skip rather than orphan the child into the
            # top-level rail, which get_user_menu would then have to prune anyway.
            continue

        required = None if spec.always_on else perms.page_view_code(spec.code)
        if required and required not in permission_by_code:
            permission = Permission(
                code=required, module=spec.module or "admin",
                resource=perms.PAGE_RESOURCE, action="view",
                description=f"See the {spec.name} page",
            )
            db.add(permission)
            await db.flush()
            permission_by_code[required] = permission

        page = existing.get(spec.code)
        if page is None:
            page = Page(
                code=spec.code, path=spec.path, name=spec.name,
                icon=spec.icon, module=spec.module,
                parent_id=parent.id if parent else None,
                sort_order=spec.sort_order, required_permission=required,
                show_on_mobile=spec.show_on_mobile, is_active=True,
            )
            db.add(page)
            await db.flush()
            existing[spec.code] = page
            added.append(spec.code)
        else:
            # Refresh presentation only. is_active is NOT forced back on: an admin
            # who retired a screen should not have it reappear on every restart.
            #
            # sort_order is refreshed too: it decides which child a module opens on,
            # so a wrong one is a broken module, not a cosmetic detail — and it has
            # to be correctable by deploying rather than by hand-editing the row.
            changed = (
                page.path != spec.path or page.name != spec.name
                or page.sort_order != spec.sort_order
                or page.parent_id != (parent.id if parent else None)
            )
            page.path = spec.path
            page.name = spec.name
            page.module = spec.module
            page.sort_order = spec.sort_order
            page.parent_id = parent.id if parent else None
            if changed:
                updated.append(spec.code)

        # Fail closed: Admin only, and only on first registration. Re-granting on
        # every start would undo an admin who deliberately took it off Admin.
        if required and admin_role is not None and spec.code in added:
            permission = permission_by_code[required]
            held = (await db.execute(select(RolePermission).where(
                RolePermission.role_id == admin_role.id,
                RolePermission.permission_id == permission.id,
            ))).scalars().first()
            if held is None:
                db.add(RolePermission(role_id=admin_role.id,
                                      permission_id=permission.id))

    await db.commit()
    return {"added": added, "updated": updated}
