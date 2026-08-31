import asyncio
from app.core.database import SessionLocal
from app.modules.warehouse import service
from app.core.pagination import PageParams

async def test():
    async with SessionLocal() as db:
        params = PageParams(page=1, size=20)
        try:
            res = await service.list_putaways(db, params)
            print("Success")
        except Exception as e:
            import traceback
            traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(test())
