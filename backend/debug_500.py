import asyncio, os, sys
sys.path.insert(0, os.getcwd())
from app.core.database import SessionLocal
from app.modules.warehouse.service import complete_outbound_inspection

async def run():
    async with SessionLocal() as db:
        try:
            await complete_outbound_inspection(db, 4, "test_user")
        except Exception as e:
            import traceback
            traceback.print_exc()

asyncio.run(run())
