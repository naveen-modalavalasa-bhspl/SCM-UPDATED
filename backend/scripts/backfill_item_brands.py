"""Copy every item's older single brand into Item Brand Mapping (2026-10-23).

Items saved before the Brand Item Mapping screen carry their brand on
`mst_items.brand_id` only, so the mapping screen and the item's Brands tab did not
show it. This adds the missing mapping row for each. A bare run only reports how many
it would add; `--apply` writes them. Idempotent.

    .venv/Scripts/python -m scripts.backfill_item_brands
    .venv/Scripts/python -m scripts.backfill_item_brands --apply
"""
import asyncio
import sys

import app.all_models  # noqa: F401
from app.core.database import SessionLocal, engine
from app.shared.masters.combinations import backfill_item_brands


async def main(apply: bool) -> None:
    async with SessionLocal() as db:
        n = await backfill_item_brands(db, apply=apply)
    await engine.dispose()
    if apply:
        print(f"Done: {n} item brand(s) added to Item Brand Mapping.")
    else:
        print(f"{n} item brand(s) would be added. Run with --apply to write them.")


if __name__ == "__main__":
    asyncio.run(main("--apply" in sys.argv))
