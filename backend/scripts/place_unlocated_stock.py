"""Give every bin-managed warehouse's location-less stock its Unlocated location.

For a database where warehouses were switched to keeping locations BEFORE
`warehouse/unlocated.py` existed: their old GRN stock still stands at bin 0, where no
issue or movement screen can reach it. The screens heal a warehouse on its first pick
anyway; this does every warehouse at once so nobody meets the delay, and says what
it moved.

Idempotent — a second run finds nothing at bin 0 and reports nothing. Warehouses that
keep no locations are never touched: bin 0 is where their stock belongs.

    .venv/Scripts/python -m scripts.place_unlocated_stock          # say what would move
    .venv/Scripts/python -m scripts.place_unlocated_stock --apply  # and move it
"""
import asyncio
import sys

from sqlalchemy import select

from app.core.database import SessionLocal
# Every mapper, so the foreign keys between modules resolve.
from app.modules.indents import models as _indents  # noqa: F401
from app.modules.inventory import models as _inventory  # noqa: F401
from app.modules.inventory.models import NO_BIN, Stock
from app.modules.warehouse import models as _warehouse  # noqa: F401
from app.modules.warehouse import unlocated
from app.shared.models.warehouse import Warehouse


async def main(apply: bool) -> None:
    async with SessionLocal() as db:
        ids = (await db.execute(
            select(Warehouse.id).where(
                Warehouse.is_bin_managed.is_(True),
                Warehouse.id.in_(select(Stock.warehouse_id).where(
                    Stock.bin_id == NO_BIN,
                    (Stock.available_qty + Stock.reserved_qty) > 0)))
            .order_by(Warehouse.id))).scalars().all()
        print(f"{len(ids)} bin-managed warehouse(s) hold stock with no location.\n")

        for warehouse_id in ids:
            summary = await unlocated.place(db, warehouse_id, unlocated.SYSTEM)
            print(f"  {summary['warehouse_code']}: {summary['quantity']} in "
                  f"{summary['rows']} stock row(s), {summary['units']} unit(s) "
                  f"-> {summary['location_code']}")
            if apply:
                await db.commit()
            else:
                await db.rollback()

        print("\nMoved." if apply else "\nNothing written — pass --apply.")


if __name__ == "__main__":
    asyncio.run(main("--apply" in sys.argv))
