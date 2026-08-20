import asyncio, os, sys
sys.path.insert(0, os.getcwd())
from app.core.database import SessionLocal
from app.modules.warehouse.service import issue_dispatch_source, get_outbound_inspection

async def run():
    async with SessionLocal() as db:
        try:
            inspection = await get_outbound_inspection(db, 4)
            res = await issue_dispatch_source(db, inspection.issue_id)
            print(res)
        except Exception as e:
            import traceback
            traceback.print_exc()

asyncio.run(run())
