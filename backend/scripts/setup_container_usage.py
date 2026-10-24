"""Seed Masters › Packaging for existing data (2026-10-23). Run once after deploying
the packaging-by-usage change, after `alembic upgrade head`:

    .venv/Scripts/python -m scripts.setup_container_usage            # preview
    .venv/Scripts/python -m scripts.setup_container_usage --apply    # save

What it does, per item:

* **Storage** = the container of the item's default putaway rung, so putaway keeps
  shelving exactly what it shelved yesterday — now fixed by the master.
* **Brand on ladders**: an item with exactly ONE brand gets that brand on its
  ladders that have none. An item with several keeps them as "All brands".

Indent, Purchase, Issue and Consumption are deliberately left unmapped: unmapped means
today's behaviour (any level on a PO, biggest packs on an issue, quantity on an
indent), and changing those is a decision for whoever owns the item, on
Masters › Packaging › Container Usage.

Idempotent: an item that already has any usage row is skipped; a ladder that already
has a brand is left alone. Nothing is deleted.
"""
from __future__ import annotations

import argparse
import asyncio

from sqlalchemy import select

from app.core.database import SessionLocal
from app.shared.masters import combinations
from app.shared.models.master import (
    Item, ItemContainerUsage, ItemPackaging, PackHierarchy,
)


async def run(apply: bool) -> None:
    seeded, branded, skipped = [], [], 0
    async with SessionLocal() as db:
        mapped = set((await db.execute(select(ItemContainerUsage.item_id).distinct())).scalars())
        putaway = (await db.execute(
            select(ItemPackaging.item_id, ItemPackaging.package_id, ItemPackaging.package_name)
            .where(ItemPackaging.is_default_putaway_unit.is_(True),
                   ItemPackaging.is_active.is_(True)))).all()
        codes = dict((await db.execute(select(Item.id, Item.code))).all())
        for item_id, package_id, name in putaway:
            if item_id in mapped:
                skipped += 1
                continue
            db.add(ItemContainerUsage(item_id=item_id, package_id=package_id, usage="STORAGE"))
            mapped.add(item_id)
            seeded.append(f"{codes.get(item_id)}: Storage = {name}")

        ladders = (await db.execute(select(PackHierarchy).where(
            PackHierarchy.brand_id.is_(None), PackHierarchy.is_active.is_(True)))).scalars().all()
        for ladder in ladders:
            brands = {c.brand_id: c.brand_name
                      for c in await combinations.sync_item(db, ladder.item_id)}
            if len(brands) == 1:
                (brand_id, brand_name), = brands.items()
                ladder.brand_id, ladder.brand_name = brand_id, brand_name
                branded.append(f"{codes.get(ladder.item_id)}: '{ladder.name}' -> {brand_name}")

        if apply:
            await db.commit()
        else:
            await db.rollback()

    print(f"\n{'APPLY' if apply else 'PREVIEW'} - storage seeded for {len(seeded)} items, "
          f"{len(branded)} ladders given their brand, {skipped} items already mapped")
    for line in seeded + branded:
        print("  " + line)
    if not apply:
        print("\nNothing was saved. Run again with --apply to save.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--apply", action="store_true")
    asyncio.run(run(parser.parse_args().apply))


if __name__ == "__main__":
    main()
