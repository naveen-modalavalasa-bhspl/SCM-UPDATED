import asyncio
from app.core.database import engine
from sqlalchemy import text

async def main():
    async with engine.begin() as conn:
        await conn.execute(text('DROP TABLE IF EXISTS whs_inspection_items'))
        await conn.execute(text('DROP TABLE IF EXISTS whs_inspections'))
        try:
            await conn.execute(text('ALTER TABLE out_issues DROP COLUMN qc_status'))
        except Exception as e:
            print(e)

if __name__ == "__main__":
    asyncio.run(main())
