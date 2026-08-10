"""Put opening stock in the central warehouse so the flows have something to move.

Run:  .venv/Scripts/python -m scripts.seed_test_stock

Goes through `inventory.service.move_stock`, never at `stk_balance` directly (rule 7),
so every unit seeded here has a `stk_ledger` row behind it and the warehouse screens
add up. Idempotent by reference: a second run finds the same opening reference already
in the ledger and adds nothing.
"""
import asyncio
import os

from sqlalchemy import select

from app.core.database import SessionLocal
from app.modules.inventory import service as inventory
from app.modules.inventory.models import StockMovement
from app.platform.hcm.models import HcmEmployee
from app.shared.enums import RefType, StockDirection
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse

WAREHOUSE_CODE = os.getenv("SEED_WAREHOUSE", "WH-1549")   # default: CENTRAL WAREHOUSE-1
ITEM_COUNT = 10
QTY_EACH = 500
RATE = 100
OPENING_REF = f"OPENING-{WAREHOUSE_CODE}"


async def main() -> None:
    async with SessionLocal() as db:
        warehouse = (await db.execute(
            select(Warehouse).where(Warehouse.code == WAREHOUSE_CODE)
        )).scalars().first()
        if warehouse is None:
            raise RuntimeError(f"No warehouse {WAREHOUSE_CODE}")

        already = (await db.execute(
            select(StockMovement.id).where(StockMovement.ref_no == OPENING_REF).limit(1)
        )).scalars().first()
        if already:
            print(f"{OPENING_REF} already in the ledger — nothing to do")
            return

        actor = await db.get(HcmEmployee, 900001)      # the admin account
        items = (await db.execute(
            select(Item).where(Item.is_active.is_(True))
            .order_by(Item.id).limit(ITEM_COUNT)
        )).scalars().all()

        for index, item in enumerate(items, start=1):
            await inventory.move_stock(
                db, item_id=item.id, qty=QTY_EACH, direction=StockDirection.IN.value,
                ref_type=RefType.GRN.value, ref_id=index, ref_no=OPENING_REF,
                user=actor, warehouse_id=warehouse.id, rate=RATE,
            )
            print(f"  +{QTY_EACH} {item.code} {item.name[:40]}")
        await db.commit()
        print(f"seeded {len(items)} items into {warehouse.code} ({warehouse.name})")


if __name__ == "__main__":
    asyncio.run(main())
