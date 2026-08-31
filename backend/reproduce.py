import asyncio
import sys
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from app.modules.warehouse.service import confirm_putaway
from app.modules.warehouse.schemas import PutawayConfirm
from app.database import engine, async_session_maker

async def main():
    try:
        async with async_session_maker() as db:
            # Let's create a dummy user with an id
            class DummyUser:
                id = 1
                name = "Admin"
            
            # Putaway task id 38, from the screenshot/error.
            # We don't know the actual payload, but the schema PutawayConfirm takes actual_bin_id, qty, serial_numbers.
            # We can try to get the putaway task first to get its actual bin.
            from app.modules.warehouse.models import PutawayTask
            task = await db.get(PutawayTask, 38)
            if not task:
                print("Task 38 not found")
                return
            
            # Let's see what target bin to use. Bin 31?
            from app.modules.warehouse.models import Bin
            from sqlalchemy import select
            bin_obj = (await db.execute(select(Bin).where(Bin.warehouse_id == task.warehouse_id).limit(1))).scalars().first()
            if not bin_obj:
                print("No bin found")
                return
            
            data = PutawayConfirm(actual_bin_id=bin_obj.id, qty=task.qty)
            await confirm_putaway(db, 38, data, DummyUser())
            print("Success")
    except Exception as e:
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(main())
