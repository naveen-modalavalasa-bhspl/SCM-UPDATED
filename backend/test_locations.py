import asyncio
from app.core.database import SessionLocal as async_session_maker
from app.modules.inventory.service import get_item_locations

async def main():
    async with async_session_maker() as db:
        # F1-A1-R1-B2 has item 4 from previous investigation
        try:
            res = await get_item_locations(db, 4, 1)
            print("Locations:")
            for loc in res["locations"]:
                print(loc["location_path"])
        except Exception as e:
            print(f"Error: {e}")

if __name__ == "__main__":
    asyncio.run(main())
