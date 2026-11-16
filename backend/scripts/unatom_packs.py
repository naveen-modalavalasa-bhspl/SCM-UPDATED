"""Turn every coded pack (an "atom") into a plain pack (2026-10-22).

Codes belong to the base unit now (`packing.codes_per_pack` is always False): every
unit was already coded at putaway, and the pack around it is only a container. A pack
minted as an atom before this still refuses to be opened by a repack and forces a
break bulk at the issue desk. This clears `is_atom` on every live pack and marks its
code kind PACK. The pack's own code is KEPT, so a label already stuck on a carton
still scans; the units inside keep theirs.

A bare run only reports what it would change; `--apply` writes it. Idempotent.

    .venv/Scripts/python -m scripts.unatom_packs
    .venv/Scripts/python -m scripts.unatom_packs --apply
"""
import asyncio
import sys

from sqlalchemy import func, select, update

import app.all_models  # noqa: F401
from app.core.database import SessionLocal, engine
from app.modules.warehouse import models as m
from app.modules.warehouse.enums import HandlingUnitStatus as HUS

LIVE = (HUS.SEALED.value, HUS.INSIDE.value)


async def main(apply: bool) -> None:
    async with SessionLocal() as db:
        rows = (await db.execute(
            select(m.HandlingUnit.item_id, m.HandlingUnit.warehouse_id,
                   m.HandlingUnit.pack_name, func.count())
            .where(m.HandlingUnit.is_atom.is_(True), m.HandlingUnit.status.in_(LIVE))
            .group_by(m.HandlingUnit.item_id, m.HandlingUnit.warehouse_id,
                      m.HandlingUnit.pack_name)
            .order_by(m.HandlingUnit.item_id))).all()
        total = sum(row[3] for row in rows)
        for item_id, warehouse_id, pack_name, count in rows:
            print(f"item {item_id:>6}  warehouse {warehouse_id:>6}  "
                  f"{pack_name or 'pack':20} {count:>6} coded pack(s)")
        if apply and total:
            await db.execute(
                update(m.HandlingUnit)
                .where(m.HandlingUnit.is_atom.is_(True), m.HandlingUnit.status.in_(LIVE))
                .values(is_atom=False, code_kind="PACK"))
            await db.commit()
            print(f"\nDone: {total} pack(s) are plain packs now; their units keep their codes.")
        elif total:
            print(f"\n{total} pack(s) would become plain packs. Run with --apply to write it.")
        else:
            print("Nothing to do: no live coded packs.")
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main("--apply" in sys.argv))
