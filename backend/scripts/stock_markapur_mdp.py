"""Stock CENTRAL WAREHOUSE-1 -> Markapur MDP, the OE / DM stocking point.

Office 14985 (104 - BRANCH OFFICE - Markapur) has exactly one warehouse, MDP-14985
(id 962), and all four positions held by the two people below resolve to it:

    OE  HR-EMP-10260  S Gireesh Maruthi Sai  - OE-104-MARKAPUR-1, STORE KEEPER MDP ...
    DM  HR-EMP-07279  Sk Md Rasool Jilani    - DM-104-MARKAPUR,   STORE KEEPER MDP ...

So "the OE's place" and "the DM's place" are one destination, not two.

Every leg goes through `inventory.service.move_stock`, the one function allowed to
change stock (rule 7), so each writes its own `stk_ledger` row. Two balanced legs per
item — exactly what `transfer_stock` does. It is spelled out here rather than calling
`transfer_stock` because that function takes no `batch_id` and defaults to NO_BATCH,
while every balance row at MAIN is batch-tracked; sending through it would look for a
NO_BATCH bucket that does not exist and fail on "Insufficient stock".

NOT IDEMPOTENT. This posts real movements; running it twice sends the quantities
twice. Run with:

    cd backend && .venv/Scripts/python -m scripts.stock_markapur_mdp
"""
import asyncio
from decimal import Decimal

import sqlalchemy as sa
from sqlalchemy import select

from app.core.database import SessionLocal
from app.modules.inventory import service as inv
from app.platform.hcm.models import HcmEmployee
from app.shared.enums import RefType, StockDirection

SOURCE_WH = 982          # CENTRAL WAREHOUSE-1 - MAIN
DEST_WH = 962            # 104 - BRANCH OFFICE - Markapur - MDP
ACTOR_EMP_CODE = "HR-EMP-07279"   # the DM who runs this stocking point
REF_NO = "TRF/MAIN-MARKAPUR/001"

# item_id -> quantity to send. Consumables in working counts, reagents and devices in
# the small numbers a branch actually holds.
SEND = {
    4: Decimal("200"),    # Syringe 5 ml with 24 G Needle
    7: Decimal("300"),    # K2 EDTA Vacutainer Lavender 2 ml
    40: Decimal("1"),     # Cholesterol Reagent 10 x 44 ml
    52: Decimal("1"),     # Glucose GOD-POD Reagent 10 x 44 ml
    61: Decimal("1"),     # Haematology Diluent 20 L
    80: Decimal("1"),     # Pulse Oximeter
}


async def main() -> None:
    async with SessionLocal() as db:
        actor = (await db.execute(
            select(HcmEmployee).where(HcmEmployee.emp_code == ACTOR_EMP_CODE)
        )).scalar_one()
        print(f"actor: {actor.id} {actor.full_name}")

        source_rows = (await db.execute(sa.text("""
            SELECT item_id, item_code, item_name, bin_id, batch_id, batch_no,
                   available_qty, valuation_rate
            FROM stk_balance
            WHERE warehouse_id = :wh AND item_id IN :ids AND available_qty > 0
        """), {"wh": SOURCE_WH, "ids": tuple(SEND)})).all()

        for row in source_rows:
            qty = SEND[row.item_id]
            if row.available_qty < qty:
                print(f"  SKIP {row.item_code}: only {row.available_qty} on hand")
                continue

            # OUT first: a short source raises before anything has been credited.
            await inv.move_stock(
                db, item_id=row.item_id, qty=qty,
                direction=StockDirection.OUT.value, ref_type=RefType.TRANSFER.value,
                ref_id=DEST_WH, ref_no=REF_NO, user=actor,
                warehouse_id=SOURCE_WH, bin_id=row.bin_id, batch_id=row.batch_id,
            )
            await inv.move_stock(
                db, item_id=row.item_id, qty=qty,
                direction=StockDirection.IN.value, ref_type=RefType.TRANSFER.value,
                ref_id=SOURCE_WH, ref_no=REF_NO, user=actor,
                warehouse_id=DEST_WH, batch_id=row.batch_id,
                rate=row.valuation_rate,
            )
            print(f"  sent {qty} of {row.item_code} ({row.item_name})")

        await db.commit()
        print("committed")


if __name__ == "__main__":
    asyncio.run(main())
