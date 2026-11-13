"""Give material issues the project of the STO / indent they copied their organisation
from (2026-11-13).

An issue raised against an organised STO or indent copied the organisation and was
NUMBERED under the source's project — but the project itself was not copied, so its
number card read "Project: Not chosen here" over a number that printed it. New issues
carry it (`warehouse.service._issue_scope`); this brings the saved ones into line.

Only an issue that carries an organisation and NO project, whose STO / indent names
one, is touched. Nothing else is: an older issue, an issue with its own project, and a
source filed under a department are all left exactly as they are. Idempotent.

    .venv/Scripts/python -m scripts.carry_project_onto_issues          # say what would change
    .venv/Scripts/python -m scripts.carry_project_onto_issues --apply  # and write it
"""
import asyncio
import sys

from sqlalchemy import select

from app.core.database import SessionLocal
from app.modules.indents.models import Indent
from app.modules.inventory.models import StockTransferOrder
from app.modules.warehouse import models as m


async def main(apply: bool) -> None:
    async with SessionLocal() as db:
        issues = (await db.execute(
            select(m.MaterialIssue).where(
                m.MaterialIssue.organization_id.is_not(None),
                m.MaterialIssue.project_id.is_(None),
            ).order_by(m.MaterialIssue.id)
        )).scalars().all()
        changed = 0
        for issue in issues:
            source = await db.get(Indent, issue.indent_id) if issue.indent_id else None
            if source is None:
                source = await db.scalar(select(StockTransferOrder).where(
                    StockTransferOrder.issue_id == issue.id).limit(1))
            if source is None or not (source.project_id or source.project_name):
                continue
            issue.project_id = source.project_id
            issue.project_name = source.project_name
            changed += 1
            label = getattr(source, "indent_no", None) or getattr(source, "sto_no", None)
            print(f"  {issue.issue_no}: project {source.project_name} ← {label}")
        if apply:
            await db.commit()
            print(f"\n{changed} issue(s) given their source's project.")
        else:
            await db.rollback()
            print(f"\n{changed} issue(s) would change. Nothing written — pass --apply.")


if __name__ == "__main__":
    asyncio.run(main("--apply" in sys.argv))
