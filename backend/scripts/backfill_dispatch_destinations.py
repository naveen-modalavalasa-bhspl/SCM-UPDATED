"""Fill `to_warehouse_id` on consignments that went out before it was derived.

`incoming_dispatch_options` matches on `to_warehouse_id` and nothing else, so a
consignment dispatched with it blank can never be inwarded: the goods arrive and the
receiving point has no consignment to raise a GRN against. `create_consignment` now
derives it from the indent that asked for the goods; the rows already in flight do
not benefit from that, so this fills them the same way.

Only NULLs are touched, and only where the derived point differs from the origin —
a consignment issued at the point that raised the indent has no journey to record and
is left alone (the same case `create_consignment` now refuses up front).

Idempotent: a second run reports 0.

    .venv/Scripts/python -m scripts.backfill_dispatch_destinations
"""
import asyncio

from sqlalchemy import select

from app.core.database import SessionLocal
from app.modules.warehouse import models as m
from app.modules.warehouse import service


OPEN_STATUSES = ("DISPATCHED", "IN_TRANSIT", "DELIVERED", "ACKNOWLEDGED")


async def main() -> None:
    filled, skipped = [], []
    async with SessionLocal() as db:
        rows = (await db.execute(
            select(m.Dispatch).where(
                m.Dispatch.to_warehouse_id.is_(None),
                m.Dispatch.status.in_(OPEN_STATUSES),
            ).order_by(m.Dispatch.id)
        )).scalars().all()

        for dispatch in rows:
            issue = await db.get(m.MaterialIssue, dispatch.ref_id) if dispatch.ref_id else None
            destination = (
                await service._destination_warehouse(db, issue, dispatch.warehouse_id)
                if issue is not None else None
            )
            if destination is None:
                skipped.append(dispatch.dispatch_no)
                continue
            dispatch.to_warehouse_id = destination.id
            dispatch.to_warehouse_name = destination.name
            filled.append((dispatch.dispatch_no, destination.name))
        await db.commit()

    for dispatch_no, name in filled:
        print(f"  {dispatch_no} -> {name}")
    print(f"filled {len(filled)}, left alone {len(skipped)}")
    for dispatch_no in skipped:
        print(f"  {dispatch_no}: no destination other than its own point")


if __name__ == "__main__":
    asyncio.run(main())
