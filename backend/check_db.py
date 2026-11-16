import asyncio
from app.core.database import SessionLocal
from sqlalchemy import text

async def main():
    async with SessionLocal() as db:
        res = await db.execute(text('SELECT id, serial_numbers, imei_numbers FROM inb_receipt_items WHERE receipt_id = (SELECT receipt_id FROM inb_inspections WHERE id=40)'))
        for row in res.mappings():
            print(f"Line ID: {row['id']}")
            try:
                import json
                ser = json.loads(row.get('serial_numbers')) if isinstance(row.get('serial_numbers'), str) else row.get('serial_numbers')
                im = json.loads(row.get('imei_numbers')) if isinstance(row.get('imei_numbers'), str) else row.get('imei_numbers')
                print(f"Serials: {len(ser) if ser else 0}")
                print(f"IMEIs: {len(im) if im else 0}")
            except Exception as e:
                print(e)
            print('-' * 40)

asyncio.run(main())
