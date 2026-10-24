"""Give every OPEN direct material issue the stock hold it would get if saved today.

A direct issue (no indent behind it) reserves its picks under ISSUE_HOLD from the
moment it is saved (2026-10-06). Issues saved before that hold nothing, so another
document can still take their stock while they wait for approval. This takes the hold
for each one — draft, pending approval or approved, not yet posted — exactly as
`_hold_direct_issue_stock` would on a save.

A bare run only reports what it would reserve and where the shelf is already short;
`--apply` writes it. Idempotent: an issue's hold is released and re-taken, never added
to.

    .venv/Scripts/python -m scripts.hold_open_direct_issues
    .venv/Scripts/python -m scripts.hold_open_direct_issues --apply
"""
import asyncio
import sys
from decimal import Decimal

from sqlalchemy import func, select

import app.all_models  # noqa: F401
from app.core.database import SessionLocal, engine
from app.modules.inventory.models import Reservation
from app.modules.warehouse import models as m
from app.modules.warehouse import service
from app.modules.warehouse.enums import IssueDirection, IssueStatus
from app.shared.enums import RefType, ReservationStatus

OPEN = (IssueStatus.DRAFT.value, IssueStatus.PENDING_APPROVAL.value,
        IssueStatus.APPROVED.value)


async def main(apply: bool) -> None:
    async with SessionLocal() as db:
        ids = (await db.execute(
            select(m.MaterialIssue.id).where(
                m.MaterialIssue.direction == IssueDirection.OUT.value,
                m.MaterialIssue.is_stock_posted.is_(False),
                m.MaterialIssue.status.in_(OPEN))
            .order_by(m.MaterialIssue.id))).scalars().all()
        touched = short = 0
        for issue_id in ids:
            issue = await service.get_issue(db, issue_id)
            lines = await service._direct_issue_lines(db, issue)
            if not lines:
                continue
            wanted = sum((Decimal(str(line.issued_qty)) for line in lines), Decimal(0))
            await service._hold_direct_issue_stock(db, issue, None, strict=False)
            held = Decimal(str(await db.scalar(
                select(func.coalesce(func.sum(Reservation.quantity), 0)).where(
                    Reservation.ref_type == RefType.ISSUE_HOLD.value,
                    Reservation.ref_id == issue.id,
                    Reservation.status == ReservationStatus.ACTIVE.value)) or 0))
            touched += 1
            flag = "" if held >= wanted else "   << SHORT: the shelf no longer has it"
            short += held < wanted
            print(f"{issue.issue_no:32} {issue.status:18} wants {wanted:>10}  "
                  f"held {held:>10}{flag}")
        if apply:
            await db.commit()
        else:
            await db.rollback()
        print(f"\n{touched} open direct issue(s), {short} short of stock. "
              + ("Holds written." if apply else "Dry run — nothing written; add --apply."))
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main("--apply" in sys.argv))
