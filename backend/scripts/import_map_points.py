"""Place this database's stocking points from the committed snapshot, and say why not.

The Load Planner does the same fill on every map read (`trips._apply_snapshot`); this
is the same rule run by hand, for when the map still shows fewer points than the
snapshot holds and somebody needs to know which of the reasons it is:

* the code is not in this database (a different HCM sync, so different offices);
* the point is inactive here;
* the point is already placed here — pinned by hand, from HCM's GPS, or matched by
  this machine's gazetteer — which the snapshot never overwrites.

    .venv/Scripts/python -m scripts.import_map_points          # report only
    .venv/Scripts/python -m scripts.import_map_points --apply  # and write it
"""
import asyncio
import sys
from collections import Counter

from sqlalchemy import select

from app.core.database import SessionLocal
from app.modules.inventory.locations import HCM_COORDINATE_SOURCE
from app.modules.warehouse import geocoding
from app.modules.warehouse import trips
from app.shared.models.warehouse import Warehouse


def _placed(row: Warehouse) -> bool:
    return row.latitude is not None and row.longitude is not None


async def main(apply: bool) -> None:
    snapshot = geocoding.load_snapshot()
    print(f"Snapshot {geocoding.SNAPSHOT_FILE.name}: {len(snapshot)} points\n")
    async with SessionLocal() as db:
        rows = list((await db.scalars(select(Warehouse))).all())
        by_code = {row.code: row for row in rows}
        active = [row for row in rows if row.is_active]
        before = sum(1 for row in active if _placed(row))

        reasons = Counter()
        for code in snapshot:
            row = by_code.get(code)
            if row is None:
                reasons["not in this database"] += 1
            elif not row.is_active:
                reasons["inactive here"] += 1
            elif row.coordinate_source in ("MANUAL", HCM_COORDINATE_SOURCE):
                reasons[f"already placed here ({row.coordinate_source})"] += 1
            elif _placed(row):
                reasons["already placed here (gazetteer)"] += 1
            else:
                reasons["WILL BE PLACED from the snapshot"] += 1
        for reason, count in reasons.most_common():
            print(f"  {count:5}  {reason}")

        missing = [code for code in snapshot if code not in by_code][:10]
        if missing:
            print(f"\n  e.g. not here: {', '.join(missing)}")
            print(f"  this database has e.g.: "
                  f"{', '.join(sorted(row.code for row in active)[:10])}")

        placed = trips._apply_snapshot(active)
        after = sum(1 for row in active if _placed(row))
        print(f"\nOn the map: {before} of {len(active)} now, {after} of {len(active)} "
              f"after the snapshot ({placed} placed).")
        if apply and placed:
            await db.commit()
            print("Written. Reload the Load Planner page.")
        elif placed:
            await db.rollback()
            print("Nothing written — run again with --apply.")


if __name__ == "__main__":
    asyncio.run(main("--apply" in sys.argv))
