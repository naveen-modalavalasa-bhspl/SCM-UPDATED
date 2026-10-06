import asyncio
from sqlalchemy import text
from app.core.database import SessionLocal
async def main():
    async with SessionLocal() as db:
        for t in ("inv_allocations","inv_allocation_items"):
            cols=[r[0] for r in (await db.execute(text(f"show columns from {t}"))).all()]
            print(t, cols)
        print((await db.execute(text("select * from inv_allocations where id=166"))).mappings().all())
        for r in (await db.execute(text("select * from inv_allocation_items where allocation_id=166"))).mappings().all(): print(dict(r))
asyncio.run(main())
