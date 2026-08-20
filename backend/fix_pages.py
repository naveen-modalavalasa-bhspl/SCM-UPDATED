import asyncio, os, sys
sys.path.insert(0, os.getcwd())
from sqlalchemy import text
from app.core.database import SessionLocal

async def fix():
    async with SessionLocal() as db:
        await db.execute(text("UPDATE job_profile_pages SET pages = JSON_ARRAY_APPEND(pages, '$', 'wh_qc_outward') WHERE JSON_CONTAINS(pages, '\"wh_qc\"') AND NOT JSON_CONTAINS(pages, '\"wh_qc_outward\"')"))
        await db.commit()
    print("done")

asyncio.run(fix())
