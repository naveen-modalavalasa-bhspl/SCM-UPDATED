"""Write this database's stocking-point coordinates to the committed snapshot.

A point's place on the Load Planner map is worked out per database — by the offline
gazetteer over that database's HCM mirror, or by a pin set by hand — so a colleague
pulling the same code saw a different count. `app/modules/warehouse/map_points.json`
carries the answer in git instead: `trips.prepare_map_network` fills every unplaced
point from it, never over a MANUAL pin or HCM's own GPS on the reading database.

Keyed by warehouse code (`LIP-<office_id>`, `MDP-<office_id>`, `WH-<office_id>`),
which every database synced from the same HCM derives identically. HCM coordinates
are left out — HCM supplies them to every database itself.

    .venv/Scripts/python -m scripts.export_map_points
"""
import asyncio
import json

from sqlalchemy import select

from app.core.database import SessionLocal
from app.modules.inventory.locations import HCM_COORDINATE_SOURCE
from app.modules.warehouse import geocoding
from app.shared.models.warehouse import Warehouse


async def main() -> None:
    async with SessionLocal() as db:
        rows = (await db.scalars(
            select(Warehouse)
            .where(Warehouse.is_active.is_(True),
                   Warehouse.latitude.is_not(None), Warehouse.longitude.is_not(None))
            .order_by(Warehouse.code)
        )).all()
    points = {
        row.code: {
            "latitude": float(row.latitude), "longitude": float(row.longitude),
            "source": row.coordinate_source, "label": row.coordinate_label,
            "confidence": (float(row.coordinate_confidence)
                           if row.coordinate_confidence is not None else None),
            "name": row.name,
        }
        for row in rows if row.coordinate_source != HCM_COORDINATE_SOURCE
    }
    geocoding.SNAPSHOT_FILE.write_text(json.dumps(
        {"gazetteer_version": geocoding.GAZETTEER_VERSION, "points": points},
        indent=1, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Wrote {len(points)} points to {geocoding.SNAPSHOT_FILE}")


if __name__ == "__main__":
    asyncio.run(main())
