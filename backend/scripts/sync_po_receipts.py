"""Bring every purchase order's receipt status up to date with its receipts.

A one-off for the orders received BEFORE `_sync_po_receipt_status` learned to run when
a GRN is submitted. Until 2026-09-08 it ran only when stock was posted, so an order
whose delivery was booked in and sitting in QC — BHS/104/2026-27/PO0013, with all
nineteen of its lines on a receipt — still read ACCEPTED_BY_SUPPLIER, and
`pro_po_items.received_quantity` still read 0.000 on every line of it.

Both figures are DERIVED from the receipts (see `_sync_po_receipt_status`), so this is
idempotent: run it twice and the second run reports nothing. It never invents a status
for an order nothing has arrived against, and never moves one a person cancelled or
closed.

    .venv/Scripts/python -m scripts.sync_po_receipts          # say what would change
    .venv/Scripts/python -m scripts.sync_po_receipts --apply  # and write it
"""
import asyncio
import sys

from sqlalchemy import select

from app.core.database import SessionLocal
# Every mapper, so the foreign keys between modules resolve.
from app.modules.indents import models as _indents  # noqa: F401
from app.modules.inventory import models as _inventory  # noqa: F401
from app.modules.procurement.models import PurchaseOrder
from app.modules.warehouse import models as m
from app.modules.warehouse import service


async def main(apply: bool) -> None:
    async with SessionLocal() as db:
        po_ids = [row for row in (await db.execute(
            select(m.Receipt.po_id)
            .where(m.Receipt.po_id.is_not(None))
            .distinct()
        )).scalars().all() if row]
        print(f"{len(po_ids)} purchase orders have receipts against them.\n")

        changed = 0
        for po_id in sorted(po_ids):
            po = await db.get(PurchaseOrder, po_id)
            if po is None:
                continue
            before = po.status
            await service._sync_po_receipt_status(db, po_id)
            if po.status != before:
                changed += 1
                print(f"  {po.po_no or po_id}: {before} -> {po.status}")

        if apply:
            await db.commit()
            print(f"\n{changed} order(s) moved. Receipt quantities written.")
        else:
            await db.rollback()
            print(f"\n{changed} order(s) would move. Nothing written — pass --apply.")


if __name__ == "__main__":
    asyncio.run(main("--apply" in sys.argv))
