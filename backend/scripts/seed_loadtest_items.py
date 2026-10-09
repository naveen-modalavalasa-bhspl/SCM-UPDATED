"""Grow the item master in the CLONE, to expose a cost that today's data hides.

`inventory.get_stock_replenishment` issues one `SUM(available_qty)` query PER ITEM
that is active and carries a reorder level, and `home.summary` calls it on every
dashboard load. There is no pagination and no limit.

Today that loop does nothing at all: not one of the 87 items has a reorder level set,
so the dashboard answers in ~60 ms and the defect is invisible. It is not fixed — it
is dormant, and what wakes it is an ordinary administrator filling in reorder levels
on the item master, which is a data change nobody would think to load test.

This script makes both halves of that visible: it can switch reorder levels on for the
items that exist, and it can grow the catalogue to a realistic size. CLONE ONLY.

Usage (from backend/):
    .venv/Scripts/python -m scripts.seed_loadtest_items 5000
"""
import asyncio
import re
import sys

import aiomysql

from app.core.config import settings


def _dsn():
    match = re.match(r"mysql\+aiomysql://([^:]+):([^@]*)@([^:]+):(\d+)/(\S+)",
                     settings.DATABASE_URL)
    return (match.group(1), match.group(2), match.group(3),
            int(match.group(4)), match.group(5))


async def main(target_count: int) -> None:
    user, password, host, port, db = _dsn()
    if "loadtest" not in db.lower():
        raise SystemExit(f"Refusing to seed items into {db!r} — clone first.")

    conn = await aiomysql.connect(host=host, port=port, user=user, password=password,
                                  db=db, autocommit=True)
    cur = await conn.cursor()

    await cur.execute("SELECT COUNT(*) FROM mst_items")
    existing = (await cur.fetchone())[0]

    # Duplicate whole rows, renaming only the two unique columns. Cloning the real
    # rows rather than inventing them keeps every FK pointing somewhere valid, so the
    # dashboard does the same joins on them that it does on the originals.
    await cur.execute("SHOW COLUMNS FROM mst_items")
    columns = [row[0] for row in await cur.fetchall()]
    copyable = [c for c in columns if c != "id"]

    made = 0
    batch = 0
    while existing + made < target_count:
        batch += 1
        picks = ", ".join(
            f"CONCAT(`{c}`, '-LT{batch}')" if c in ("code", "name") else f"`{c}`"
            for c in copyable)
        await cur.execute(
            f"INSERT INTO mst_items ({', '.join(f'`{c}`' for c in copyable)}) "
            f"SELECT {picks} FROM mst_items WHERE code NOT LIKE '%-LT%'")
        made += cur.rowcount
        print(f"  batch {batch}: +{cur.rowcount}", flush=True)

    # The switch that wakes the loop. An administrator does this from the item form,
    # one item at a time, without any idea it is a performance decision.
    await cur.execute(
        "UPDATE mst_items SET reorder_level = 10 WHERE is_active = 1 AND "
        "(reorder_level IS NULL OR reorder_level = 0)")
    print(f"reorder levels set on {cur.rowcount} items")

    await cur.execute(
        "SELECT COUNT(*) FROM mst_items WHERE is_active = 1 AND reorder_level > 0")
    print(f"items now driving the per-item loop: {(await cur.fetchone())[0]}")
    conn.close()


if __name__ == "__main__":
    asyncio.run(main(int(sys.argv[1]) if len(sys.argv) > 1 else 5000))
