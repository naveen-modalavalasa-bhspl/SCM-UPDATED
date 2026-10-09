"""Rebuild the navigation menu on a live database without pruning anything.

`scripts.seed` deletes every `rbac_pages` row that is not in its own `PAGE_TREE`
(seed.py, "prune pages no longer in the tree"). Run it from a branch whose PAGE_TREE
is older than the database and it silently removes the newer screens — which is how
the Settings menu lost Company Settings, Approval Workflows, Approvals Config and
Approval & Automation.

This script does the same upsert seed does — same PAGE_TREE, so the two cannot drift —
and then stops. It never issues a delete. A page that exists but is not in PAGE_TREE is
left exactly as it is.

    .venv/Scripts/python -m scripts.provision_pages            # apply
    .venv/Scripts/python -m scripts.provision_pages --dry-run  # show what would change

Safe to re-run: it is an upsert, so a second run reports nothing to do.
"""
import asyncio
import sys

from sqlalchemy import select

from app.core.database import SessionLocal
from app.platform.rbac.models import Page
from scripts.seed import PAGE_TREE


async def provision(dry_run: bool = False) -> None:
    async with SessionLocal() as db:
        existing = {
            p.code: p
            for p in (await db.execute(select(Page))).scalars().all()
        }
        added, updated = [], []

        code_to_id: dict[str, int] = {}
        for code, path, name, icon, perm, order, _parent in PAGE_TREE:
            page = existing.get(code)
            if page is None:
                page = Page(code=code)
                db.add(page)
                added.append(f"{code:<24} {path}")
            elif (page.path, page.name, page.icon, page.required_permission,
                  page.sort_order, page.is_active) != (path, name, icon, perm, order, True):
                updated.append(f"{code:<24} {path}")

            page.path, page.name, page.icon = path, name, icon
            page.required_permission = perm
            page.sort_order = order
            page.is_active = True
            await db.flush()
            code_to_id[code] = page.id

        for code, *_rest, parent in PAGE_TREE:
            page = await db.get(Page, code_to_id[code])
            page.parent_id = code_to_id[parent] if parent else None

        # Anything already in the database that PAGE_TREE does not mention. Reported so
        # it is visible, never deleted — that deletion is the bug this script exists for.
        untouched = sorted(set(existing) - {c for c, *_ in PAGE_TREE})

        if dry_run:
            await db.rollback()
        else:
            await db.commit()

        verb = "would add" if dry_run else "added"
        print(f"{verb} {len(added)} page(s):")
        for line in added:
            print("   ", line)
        print(f"{'would update' if dry_run else 'updated'} {len(updated)} page(s).")
        if untouched:
            print(f"left alone ({len(untouched)} not in PAGE_TREE): {', '.join(untouched)}")
        if not dry_run:
            print("Users see the change on their next /api/auth/me — a reload is enough.")


if __name__ == "__main__":
    asyncio.run(provision(dry_run="--dry-run" in sys.argv))
