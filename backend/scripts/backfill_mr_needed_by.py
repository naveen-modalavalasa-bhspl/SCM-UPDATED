"""Give every material request raised from an indent the indent's "Needed by" (SCM_0155).

A one-off for the requests raised BEFORE 2026-11-12. The automatic path — an approved
allocation that could not cover an indent line — handed the request the indent's
project and department but never its required date or its priority, so every one of
those requests read "Needed by —" on Inventory > Material Requests. New ones carry
both (`allocations.apply_to_stock`, `indents.create_allocation_for_indent`).

Only fills what is EMPTY: a date somebody typed on a hand-raised request is theirs and
is never overwritten, and a priority already marked URGENT is never lowered. Requests
with no indent behind them are left alone — there is nothing to copy. Idempotent: the
second run finds nothing to do.

    .venv/Scripts/python -m scripts.backfill_mr_needed_by          # say what would change
    .venv/Scripts/python -m scripts.backfill_mr_needed_by --apply  # and write it
"""
import asyncio
import sys

from sqlalchemy import select

from app.core.database import SessionLocal
from app.modules.indents.models import Indent
from app.modules.inventory.models import MaterialRequest
from app.shared.enums import Priority


async def main(apply: bool) -> None:
    async with SessionLocal() as db:
        rows = (await db.execute(
            select(MaterialRequest, Indent.required_date, Indent.priority)
            .join(Indent, Indent.id == MaterialRequest.indent_id)
            .where(MaterialRequest.required_by.is_(None),
                   Indent.required_date.is_not(None))
            .order_by(MaterialRequest.id)
        )).all()
        print(f"{len(rows)} material request(s) raised from an indent have no Needed by.\n")

        urgent = 0
        for mr, needed_by, priority in rows:
            mr.required_by = needed_by
            note = ""
            if (priority == Priority.URGENT.value
                    and mr.priority != Priority.URGENT.value):
                mr.priority = Priority.URGENT.value
                urgent += 1
                note = "  (and marked URGENT, as its indent is)"
            print(f"  {mr.mr_no}: Needed by {needed_by:%d %b %Y}"
                  f"  ← {mr.indent_no or mr.indent_id}{note}")

        if apply:
            await db.commit()
            print(f"\n{len(rows)} request(s) given a Needed by; {urgent} marked URGENT.")
        else:
            await db.rollback()
            print(f"\n{len(rows)} request(s) would change. Nothing written — pass --apply.")


if __name__ == "__main__":
    asyncio.run(main("--apply" in sys.argv))
