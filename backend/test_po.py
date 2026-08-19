import asyncio
from app.core.database import SessionLocal
from app.modules.procurement.models import PurchaseOrder
from sqlalchemy import select

async def f():
    async with SessionLocal() as db:
        res = (await db.execute(select(PurchaseOrder).where(PurchaseOrder.id == 9))).scalars().first()
        if res:
            print(f"PO 9: status={res.status} vendor={res.vendor_id}")
        else:
            print("PO 9 not found")

if __name__ == "__main__":
    asyncio.run(f())
