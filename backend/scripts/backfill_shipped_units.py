"""Re-home the unit rows of stock that was shipped before units learned to travel.

`whs_serial_numbers` holds one row per physical unit — its serial, its IMEI, its
asset or consumable code. The row is minted once, at the warehouse that first
receives the goods, and until now nothing ever moved it. Quantity shipped on to an
MDP or a LIP and the identity stayed behind, so a stocking point showed five units of
stock and a dash where their codes belong, while the source warehouse still listed
those same codes as available to issue again.

The code fix (`_claim_units` / `_land_units` in the warehouse service) only affects
consignments from here on. This backfill settles the history.

RECONCILES, IT DOES NOT REPLAY. Rather than walking `stk_ledger` and re-enacting every
movement — which would need every leg to have been recorded perfectly, and one of them
was a hand-written transfer script — it compares two counts per item and batch:

    what `stk_balance` says is at each warehouse   vs.   how many unit rows sit there

A warehouse holding more unit rows than stock has units that should have left. A
warehouse holding less has stock whose units never arrived. The surplus is moved to
the shortfall, oldest row first, and the two counts agree afterwards.

That makes it IDEMPOTENT: a second run finds nothing out of place and moves nothing.
It is also safe to run before the code fix is deployed, and again after.

Only `available` units are moved. A unit that is genuinely in flight — claimed by an
open issue or consignment and sitting at `issued` — is left exactly where it is, so
this can be run on a live database without disturbing documents in progress.

    cd backend && .venv/Scripts/python -m scripts.backfill_shipped_units          # report
    cd backend && .venv/Scripts/python -m scripts.backfill_shipped_units --apply  # write
"""
import asyncio
import sys
from collections import defaultdict

from sqlalchemy import select, text

from app.core.database import SessionLocal
from app.modules.warehouse import models as m
from app.modules.warehouse.enums import SerialStatus

REMARK = "Backfilled to match stock balance"


async def main(apply: bool) -> None:
    async with SessionLocal() as db:
        # What the books say is where. Batch is part of the key: the balance rows are
        # batch-tracked and so are the unit rows, and matching without it would move a
        # unit out of the batch whose expiry it was received under.
        balances = (await db.execute(text("""
            SELECT b.item_id, b.batch_id, b.warehouse_id, w.name AS warehouse_name,
                   SUM(b.total_qty) AS qty
              FROM stk_balance b
              JOIN whs_warehouses w ON w.id = b.warehouse_id
             GROUP BY b.item_id, b.batch_id, b.warehouse_id, w.name
            HAVING SUM(b.total_qty) <> 0
        """))).mappings().all()

        counts = (await db.execute(text("""
            SELECT item_id, batch_id, warehouse_id, COUNT(*) AS units
              FROM whs_serial_numbers
             WHERE is_active = 1 AND status = 'available'
             GROUP BY item_id, batch_id, warehouse_id
        """))).mappings().all()

        held = {(r["item_id"], r["batch_id"], r["warehouse_id"]): int(r["units"])
                for r in counts}
        names = {r["warehouse_id"]: r["warehouse_name"] for r in balances}

        # Per (item, batch): who is short of units, and who is holding spares.
        short: dict[tuple, list[tuple[int, int]]] = defaultdict(list)
        spare: dict[tuple, list[tuple[int, int]]] = defaultdict(list)
        seen: set[tuple] = set()

        for row in balances:
            key = (row["item_id"], row["batch_id"])
            wh = row["warehouse_id"]
            seen.add((*key, wh))
            gap = int(row["qty"]) - held.get((*key, wh), 0)
            if gap > 0:
                short[key].append((wh, gap))

        # A warehouse with units and no balance row at all is the pure case: every one
        # of them has left. Counted here because the loop above only sees warehouses
        # that still hold stock.
        for (item_id, batch_id, wh), units in held.items():
            key = (item_id, batch_id)
            if (item_id, batch_id, wh) not in seen:
                spare[key].append((wh, units))

        for row in balances:
            key = (row["item_id"], row["batch_id"])
            wh = row["warehouse_id"]
            surplus = held.get((*key, wh), 0) - int(row["qty"])
            if surplus > 0:
                spare[key].append((wh, surplus))

        moves = 0
        for key, wanted in sorted(short.items()):
            donors = spare.get(key)
            if not donors:
                continue
            item_id, batch_id = key
            for dest_wh, gap in wanted:
                while gap > 0 and donors:
                    src_wh, available = donors[0]
                    take = min(gap, available)
                    rows = (await db.execute(
                        select(m.SerialNumber).where(
                            m.SerialNumber.item_id == item_id,
                            m.SerialNumber.batch_id == batch_id,
                            m.SerialNumber.warehouse_id == src_wh,
                            m.SerialNumber.status == SerialStatus.AVAILABLE.value,
                            m.SerialNumber.is_active.is_(True),
                        ).order_by(m.SerialNumber.id).limit(take)
                    )).scalars().all()
                    if not rows:
                        donors.pop(0)
                        continue
                    for unit in rows:
                        unit.warehouse_id = dest_wh
                        unit.bin_id = None
                        unit.remarks = REMARK
                    moved = len(rows)
                    print(f"  item {item_id} batch {batch_id}: {moved:>5} units  "
                          f"{names.get(src_wh, src_wh)} -> {names.get(dest_wh, dest_wh)}")
                    moves += moved
                    gap -= moved
                    remaining = available - moved
                    if remaining > 0:
                        donors[0] = (src_wh, remaining)
                    else:
                        donors.pop(0)

        if not moves:
            print("Nothing to move — every warehouse's unit rows already match its stock.")
        elif apply:
            await db.commit()
            print(f"\ncommitted: {moves} units re-homed")
        else:
            await db.rollback()
            print(f"\nDRY RUN: {moves} units would be re-homed. "
                  f"Re-run with --apply to write.")


if __name__ == "__main__":
    asyncio.run(main("--apply" in sys.argv))
