"""Grant whole modules to the field job profiles in one shot. Idempotent.

Run:  .venv/Scripts/python -m scripts.grant_profile_access

Settings > Job Profiles does this a tick-box at a time, which is the right shape for
one considered change and the wrong shape for standing up a test org. Same code path
as the screen (`profiles.set_profile_access`), so what lands here is exactly what the
screen would have written — grants, scope rung and audit row alike.

Access is stated as MODULES, not as permission codes: "Store Keeper gets Inventory"
should keep meaning that after someone adds a permission to the inventory module.
Every permission in the named modules is granted, plus every page belonging to them.

Scope is the other half and does not come from the modules: it is the rung on
`ScopeRung` that decides WHOSE rows the profile sees, SELF for a store keeper who
only ever handles their own vehicle, SUBTREE for the managers above them.
"""
import asyncio

from sqlalchemy import select

from app.core.database import SessionLocal
from app.platform.hcm.models import HcmEmployee
from app.platform.rbac import profiles
from app.platform.rbac.models import Page, Permission
from app.shared.enums import ScopeRung

ADMIN_ID = 900001          # the actor on the audit row; see scripts.create_admin_login

# Pages carry no module of their own for the older screens, so the ones that belong to
# a module by URL rather than by column are named here. Everything else is picked up
# from Page.module.
EXTRA_PAGES = {
    "indents": ["home", "grp_indents", "ind_dashboard", "ind_list", "ind_board",
                "ind_deliveries", "ind_ack", "ind_reports", "ind_notifications"],
    "approvals": ["approval_waiting", "approval_consolidation", "approval_decisions",
                  "approval_team"],
    "inventory": ["inv_overview", "inv_allocation_approvals", "inv_stocking_points",
                  "inv_adjustments", "inv_valuation", "inv_labels"],
    "warehouse": [],
}

FIELD = ["indents", "inventory", "warehouse"]
MANAGER = ["approvals"] + FIELD

# Profiles that do the work but approve none of it. Granting Inventory and Warehouse
# whole hands over their `*.approve` codes too, and Home's approvals tile keys off
# exactly those — so a store keeper who was never meant to approve anything still saw
# an approvals KPI. Approving is a manager's act; strip it from the field profiles.
NO_APPROVALS = {"21:STORE KEEPER", "22:STORE KEEPER"}

# profile key -> (modules, how far it sees)
GRANTS = {
    "22:STORE KEEPER":    (FIELD, ScopeRung.SELF),
    "22:OE":              (MANAGER, ScopeRung.SUBTREE),
    "22:DISTRICT MANAGER": (MANAGER, ScopeRung.SUBTREE),
    "22:REGIONAL MANAGER": (MANAGER, ScopeRung.SUBTREE),
}


async def main() -> None:
    async with SessionLocal() as db:
        actor = await db.get(HcmEmployee, ADMIN_ID)
        if actor is None:
            raise RuntimeError("No admin employee — run scripts.create_admin_login first")

        for key, (modules, scope) in GRANTS.items():
            permission_codes = [c for c in (await db.execute(
                select(Permission.code).where(Permission.module.in_(modules))
            )).scalars().all()
                if not (key in NO_APPROVALS and c.endswith(".approve"))]
            active = set((await db.execute(
                select(Page.code).where(Page.is_active.is_(True))
            )).scalars().all())
            page_codes = set((await db.execute(
                select(Page.code).where(Page.module.in_(modules),
                                        Page.is_active.is_(True))
            )).scalars().all())
            for module in modules:
                # Intersected with what is actually registered: a screen named here
                # that the deployment never seeded is a page nobody can open, not an
                # error worth failing the whole grant over.
                page_codes.update(set(EXTRA_PAGES.get(module, [])) & active)

            await profiles.set_profile_access(
                db, key, sorted(page_codes), sorted(permission_codes),
                scope.value, None, actor,
            )
            print(f"{key:22} {scope.value:8} {len(permission_codes):>3} permissions, "
                  f"{len(page_codes):>2} pages  ({', '.join(modules)})")


if __name__ == "__main__":
    asyncio.run(main())
