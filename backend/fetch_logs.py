import asyncio
from app.core.database import SessionLocal
from sqlalchemy import text

async def main():
    async with SessionLocal() as db:
        res = await db.execute(text('SELECT * FROM sys_app_logs ORDER BY id DESC LIMIT 5'))
        for row in res.mappings():
            print(f"Log ID: {row.get('id')}")
            print(f"Level: {row.get('level')}")
            print(f"Code: {row.get('status_code')}")
            print(f"Message: {row.get('message')}")
            print(f"Path: {row.get('request_path')}")
            stack = row.get("stack_trace")
            print(f"Stack: {stack[:500] if stack else None}")
            print('-' * 80)

asyncio.run(main())
