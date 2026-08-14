"""Credit consignments that were acknowledged but never landed on a shelf.

`acknowledge_dispatch` used to post the destination receipt only when
`dispatch_type == 'TRANSFER'`. Every other consignment between two of our own points —
PROJECT above all, which is what the consignment form defaults to on an indent
delivery — left the source warehouse and landed NOWHERE: `stk_ledger` kept the OUT row
written at gate-out and no IN row was ever written. The goods are physically at the
destination and absent from the books, which shows up one step later as
"Insufficient stock for this movement: 0 available" on a perfectly valid forward.

The code no longer does this (`_lands_on_internal_shelf`). This repairs the rows that
were already written, by posting the movement acknowledgement should have posted, with
the same DISPATCH ref so the ledger reads as if it had happened at the right moment.

Only touches consignments that:
  * are ACKNOWLEDGED, and land on one of our stocking points, and
  * were never inwarded on a GRN (that GRN is the stock event — nothing owed), and
  * whose destination does not run a receiving desk (there the GRN is still awaited), and
  * have NO `stk_ledger` IN row against the dispatch already.

Idempotent: the last condition is what makes a second run report 0.

    .venv/Scripts/python -m scripts.repair_uncredited_dispatches            # dry run
    .venv/Scripts/python -m scripts.repair_uncredited_dispatches --apply    # write
"""
import argparse
import asyncio

from sqlalchemy import select

from app.core.database import SessionLocal
from app.modules.inventory.models import StockMovement
from app.modules.inventory.service import move_stock
from app.modules.warehouse import models as m, service as svc
from app.modules.warehouse.enums import DispatchStatus
from app.shared.enums import RefType as InventoryRefType, StockDirection

ZERO = svc.ZERO


class _Actor:
    """`move_stock` only reads a name and an id off the actor for the audit row."""
    id = None
    name = "stock repair"
    full_name = "stock repair"
    employee_code = None


async def main(apply: bool) -> None:
    async with SessionLocal() as db:
        dispatches = (await db.execute(
            select(m.Dispatch)
            .where(m.Dispatch.status == DispatchStatus.ACKNOWLEDGED.value,
                   m.Dispatch.to_warehouse_id.is_not(None))
            .order_by(m.Dispatch.id)
        )).scalars().all()

        repaired = skipped = 0
        for dispatch in dispatches:
            if not svc._lands_on_internal_shelf(dispatch):
                continue
            if await svc._inward_receipt_for_dispatch(db, dispatch.id) is not None:
                continue
            if await svc.requires_inward(db, dispatch.to_warehouse_id):
                continue

            already = await db.scalar(
                select(StockMovement.id).where(
                    StockMovement.ref_type == InventoryRefType.DISPATCH.value,
                    StockMovement.ref_id == dispatch.id,
                    StockMovement.direction == StockDirection.IN.value,
                ).limit(1)
            )
            if already:
                skipped += 1
                continue

            lines = (await db.execute(
                select(m.DispatchItem).where(m.DispatchItem.dispatch_id == dispatch.id)
            )).scalars().all()
            posted = []
            for line in lines:
                delivered = svc._d(line.delivered_qty)
                if delivered <= ZERO:
                    continue
                posted.append((line.item_id, delivered))
                if apply:
                    await move_stock(
                        db, item_id=line.item_id, qty=delivered,
                        direction=StockDirection.IN.value,
                        ref_type=InventoryRefType.DISPATCH.value, ref_id=dispatch.id,
                        ref_no=dispatch.dispatch_no, user=_Actor(),
                        warehouse_id=dispatch.to_warehouse_id,
                        bin_id=m.NO_BIN, batch_id=line.batch_id or m.NO_BATCH,
                        project_id=dispatch.project_id or 0,
                    )
            if not posted:
                continue
            repaired += 1
            print(f"{'CREDIT' if apply else 'WOULD CREDIT'} {dispatch.dispatch_no} "
                  f"({dispatch.dispatch_type}) -> warehouse {dispatch.to_warehouse_id} "
                  f"({dispatch.to_warehouse_name})")
            for item_id, qty in posted:
                print(f"    item {item_id}  qty {qty}")

        if apply:
            await db.commit()
        print(f"\n{repaired} consignment(s) {'credited' if apply else 'to credit'}; "
              f"{skipped} already had their inward movement.")
        if not apply and repaired:
            print("Dry run — nothing was written. Re-run with --apply.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true",
                        help="write the movements (default is a dry run)")
    asyncio.run(main(parser.parse_args().apply))
