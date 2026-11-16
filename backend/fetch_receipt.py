import asyncio
from app.core.database import SessionLocal
from app.modules.warehouse.service import get_receipt
from app.modules.warehouse.schemas import ReceiptDetail
import json

async def main():
    async with SessionLocal() as db:
        # Get receipt ID for inspection 40
        from sqlalchemy import text
        res = await db.execute(text('SELECT receipt_id FROM inb_inspections WHERE id=40'))
        receipt_id = res.scalar()
        
        receipt = await get_receipt(db, receipt_id=receipt_id)
        rd = ReceiptDetail.model_validate(receipt)
        for item in rd.items:
            print(f"Line {item.id} - is_imei_tracked: {item.is_imei_tracked}, imei_numbers length: {len(item.imei_numbers) if item.imei_numbers else 0}")
            if item.imei_numbers:
                 print(f"First 2 IMEIs: {item.imei_numbers[:2]}")

asyncio.run(main())
