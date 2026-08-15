"""Put Settings > Approval Flow on the menu.

Targeted on purpose: `scripts.seed` prunes `rbac_pages` to its own PAGE_TREE and would
take real data with it, so a single new screen is added by its own idempotent script.
Sits directly above Approvals Config, which it is meant to replace once the SCM team
has signed off on it — both stay on the menu until then.

    .venv/Scripts/python -m scripts.provision_approval_flow
"""
import asyncio

from sqlalchemy import select

from app.core.database import SessionLocal
from app.platform.rbac.models import Page

CODE = "admin_approval_flow"
PARENT_CODE = "grp_settings"


async def main() -> None:
    async with SessionLocal() as db:
        parent = (await db.execute(
            select(Page).where(Page.code == PARENT_CODE)
        )).scalars().first()
        if parent is None:
            raise SystemExit(f"No {PARENT_CODE!r} menu group — run the bootstrap first.")

        page = (await db.execute(
            select(Page).where(Page.code == CODE))).scalars().first()
        if page is None:
            page = Page(code=CODE)
            db.add(page)

        page.path = "/admin/approval-flow"
        page.name = "Approval Flow"
        page.icon = "list-ordered"
        page.module = "admin"
        page.parent_id = parent.id
        # 94.5 is not available, so it takes 95 and Approvals Config moves down one.
        page.sort_order = 95
        page.required_permission = "admin.workflow.manage"
        page.show_on_mobile = True
        page.is_active = True

        old = (await db.execute(
            select(Page).where(Page.code == "admin_approvals_config")
        )).scalars().first()
        if old is not None and old.sort_order == 95:
            old.sort_order = 96

        await db.commit()
        print(f"Approval Flow is on the menu (page {page.id}).")


if __name__ == "__main__":
    asyncio.run(main())
