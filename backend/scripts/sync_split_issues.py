"""Roll every split material issue's status up from its floor issues.

A one-off for parents split BEFORE `_sync_split_parent` existed. Until 2026-10-05 a
split left the parent APPROVED for good — BHS/104/2026-27/WHI0051 stayed open after
its floor issue WHI0015 was worked — and it went on counting toward the indent next
to the children carrying the same goods.

The status is DERIVED from the children (see `_sync_split_parent`), so this is
idempotent: run it twice and the second run reports nothing.

    .venv/Scripts/python -m scripts.sync_split_issues          # say what would change
    .venv/Scripts/python -m scripts.sync_split_issues --apply  # and write it
"""
import asyncio
import sys

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.core.database import SessionLocal
# Every mapper, so the foreign keys between modules resolve.
from app.modules.indents import models as _indents  # noqa: F401
from app.modules.inventory import models as _inventory  # noqa: F401
from app.modules.warehouse import models as m
from app.modules.warehouse import service


async def main(apply: bool) -> None:
    async with SessionLocal() as db:
        parent_ids = sorted({row for row in (await db.execute(
            select(m.MaterialIssue.parent_issue_id)
            .where(m.MaterialIssue.parent_issue_id.is_not(None))
        )).scalars().all() if row})
        print(f"{len(parent_ids)} issues have been split.\n")

        # Children written before the split copied the parent's rate listed at Rs 0.
        valued = 0
        children = (await db.execute(
            select(m.MaterialIssue).options(selectinload(m.MaterialIssue.items))
            .where(m.MaterialIssue.parent_issue_id.is_not(None))
        )).scalars().all()
        for child in children:
            parent = (await db.execute(
                select(m.MaterialIssue).options(selectinload(m.MaterialIssue.items))
                .where(m.MaterialIssue.id == child.parent_issue_id)
            )).scalar_one_or_none()
            if parent is None:
                continue
            rates = {(line.indent_item_id, line.item_id): line.rate
                     for line in parent.items if line.rate}
            touched = False
            for line in child.items:
                rate = rates.get((line.indent_item_id, line.item_id))
                if line.rate is None and rate:
                    line.rate = rate
                    line.amount = service._d(line.issued_qty) * service._d(rate)
                    touched = True
            if touched:
                service._issue_totals(child)
                valued += 1
                print(f"  {child.issue_no}: valued at {child.total_value}")
        print(f"{valued} floor issue(s) valued from their parent.\n")

        changed = 0
        for parent_id in parent_ids:
            parent = await db.get(m.MaterialIssue, parent_id)
            if parent is None:
                continue
            before = parent.status
            await service._sync_split_parent(db, parent_id, None)
            if parent.status != before:
                changed += 1
                print(f"  {parent.issue_no}: {before} -> {parent.status}")

        if apply:
            await db.commit()
            print(f"\n{changed} issue(s) moved.")
        else:
            await db.rollback()
            print(f"\n{changed} issue(s) would move. Nothing written — pass --apply.")


if __name__ == "__main__":
    asyncio.run(main("--apply" in sys.argv))
