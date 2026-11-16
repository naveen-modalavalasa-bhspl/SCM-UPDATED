import asyncio
from app.core.database import SessionLocal
from sqlalchemy import text
from app.modules.warehouse.service import get_receipt
from app.modules.warehouse.schemas import ReceiptDetail

async def main():
    async with SessionLocal() as db:
        res = await db.execute(text('SELECT receipt_id FROM inb_inspections WHERE id=40'))
        receipt_id = res.scalar()
        
        receipt = await get_receipt(db, receipt_id=receipt_id)
        rd = ReceiptDetail.model_validate(receipt)
        for item in rd.items:
            print(f"Line {item.id} - is_serial_tracked: {item.is_serial_tracked}, serials length: {len(item.serial_numbers) if item.serial_numbers else 0}")

asyncio.run(main())
