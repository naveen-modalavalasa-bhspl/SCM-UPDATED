"""The storage-type master: what kinds of location a warehouse is built out of.

A location's KIND used to be an enum in three places at once — `shared.enums.BinType`,
a `STORAGE_TYPES` tuple the write schema validated against, and a hardcoded array in
the location form — with a fourth hardcode (`defaultChildType`) in the browser deciding
what a floor's children were called. None of them agreed for long: the live data has
always contained STAGING locations, which the write schema rejected, so those rows
could be read and never saved from the form that owns them.

They are rows now. `whs_warehouse_storage_types` says what the kinds ARE, and
`whs_storage_type_parents` says which kinds each one may sit inside — the shape of the
building, stated once, read by the form and enforced by the service.

Two things follow that used to be hardcoded elsewhere:

* **Pickability is a property of the KIND.** `is_pickable` replaces the `BIN_TYPES`
  tuple. Every query that filters on it reads the master (`pickable_codes`), and the
  answer is pushed into the registry `WarehouseLocation.is_pickable` reads, so a row
  already loaded decorates correctly without a join it cannot do.
* **Cold chain is a property of the KIND.** `is_temperature_controlled` replaces the
  browser's "does the code contain COLD" test, so a site can call a chilled bay
  whatever it likes and still be asked for a temperature band.

`DEFAULTS` is the ladder as this system has always described it (flow doc section 1),
seeded on bootstrap and by `f1a2c3d4e5b6`. It is a STARTING POINT, not the truth: an
admin adds, renames, reorders and re-parents from Warehouse > Masters > Storage types,
and nothing here reaches back and corrects them.
"""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError
from app.shared.models.warehouse import (
    BIN_TYPES,
    Bin,
    set_pickable_storage_types,
)

from app.modules.warehouse import models as m


#: The rungs a warehouse is born with: code, name, description, order, and which kinds
#: each may sit inside. `top` marks a kind that may also stand at the root of a
#: warehouse — a floor hangs off a block where there is one and stands on its own where
#: there is not, and both are true at the same site.
DEFAULTS: tuple[dict, ...] = (
    {"code": "BLOCK", "name": "Block", "order": 10, "top": True, "parents": (),
     "description": "A building or a whole shed on the site."},
    {"code": "FLOOR", "name": "Floor", "order": 20, "top": True, "parents": ("BLOCK",),
     "description": "One level of a block."},
    {"code": "ZONE", "name": "Zone", "order": 25, "top": True,
     "parents": ("BLOCK", "FLOOR"),
     "description": "A named area of a floor — fast movers, bonded, returns."},
    {"code": "STAGING", "name": "Staging area", "order": 26, "top": True,
     "parents": ("BLOCK", "FLOOR", "ZONE"),
     "description": "Where goods stand between the gate and their bay."},
    {"code": "LANE", "name": "Lane / aisle", "order": 30,
     "parents": ("BLOCK", "FLOOR", "ZONE"),
     "description": "A run of racking you walk down."},
    {"code": "COLD_ROOM", "name": "Cold room", "order": 35, "top": True, "cold": True,
     "parents": ("BLOCK", "FLOOR", "ZONE"),
     "description": "A temperature-controlled room, racked inside like any other."},
    {"code": "RACK", "name": "Rack", "order": 40,
     "parents": ("LANE", "ZONE", "FLOOR", "COLD_ROOM"),
     "description": "One bay of racking, shelved or not."},
    {"code": "REFRIGERATOR", "name": "Refrigerator", "order": 45, "cold": True,
     "parents": ("COLD_ROOM", "FLOOR", "ZONE", "LANE"),
     "description": "A standing chiller or freezer unit."},
    {"code": "SHELF", "name": "Shelf", "order": 50, "parents": ("RACK",),
     "description": "One level of a rack."},
    {"code": "PALLET", "name": "Pallet position", "order": 55, "pickable": True,
     "parents": ("LANE", "ZONE", "FLOOR", "RACK"),
     "description": "A marked pallet footprint on the floor or in a rack."},
    {"code": "BIN", "name": "Storage bin", "order": 60, "pickable": True,
     "parents": ("SHELF", "RACK", "LANE", "ZONE", "FLOOR"),
     "description": "Where stock is counted and picked from."},
    {"code": "COLD_STORAGE_BIN", "name": "Cold storage bin", "order": 65,
     "pickable": True, "cold": True,
     "parents": ("REFRIGERATOR", "COLD_ROOM", "SHELF", "RACK"),
     "description": "A bin inside a chiller, freezer or cold room."},
    {"code": "LOT", "name": "Lot", "order": 70, "pickable": True,
     "parents": ("BIN", "SHELF", "RACK", "ZONE", "FLOOR"),
     "description": "A marked-off part of a bay holding one lot."},
    {"code": "STORAGE", "name": "General storage", "order": 80, "pickable": True,
     "top": True, "parents": ("BLOCK", "FLOOR", "ZONE", "LANE", "RACK", "SHELF"),
     "description": "Somewhere stock is kept that is none of the above."},
)


async def ensure_defaults(db: AsyncSession) -> int:
    """Seed the rungs above, and their parent links. Idempotent, and never destructive.

    A code that is already there is left exactly as the admin has it — this only fills
    in what is MISSING, so re-running it after somebody has renamed "Lane / aisle" to
    "Aisle" does not rename it back. Returns how many types it created.
    """
    rows = {r.code.upper(): r for r in (
        await db.execute(select(m.StorageType))).scalars().all()}

    created = 0
    for spec in DEFAULTS:
        if spec["code"] in rows:
            continue
        row = m.StorageType(
            code=spec["code"],
            name=spec["name"],
            description=spec.get("description"),
            sort_order=spec["order"],
            is_pickable=bool(spec.get("pickable")),
            is_temperature_controlled=bool(spec.get("cold")),
            allow_top_level=bool(spec.get("top")) or not spec["parents"],
            is_active=True,
        )
        db.add(row)
        rows[spec["code"]] = row
        created += 1
    await db.flush()

    links = {(int(l.storage_type_id), int(l.parent_storage_type_id)) for l in (
        await db.execute(select(m.StorageTypeParent))).scalars().all()}
    for spec in DEFAULTS:
        child = rows.get(spec["code"])
        for parent_code in spec["parents"]:
            parent = rows.get(parent_code)
            if child is None or parent is None:
                continue
            if (child.id, parent.id) in links:
                continue
            db.add(m.StorageTypeParent(storage_type_id=child.id,
                                       parent_storage_type_id=parent.id))
            links.add((child.id, parent.id))
    await db.flush()
    return created


async def pickable_codes(db: AsyncSession) -> tuple[str, ...]:
    """The storage type codes stock is held in, off the master.

    Falls back to `BIN_TYPES` while the master is empty — a database created but not
    yet seeded must behave the way it did before this table carried the answer, not
    report that nowhere in the building holds stock.
    """
    codes = tuple((await db.execute(
        select(m.StorageType.code).where(
            m.StorageType.is_pickable.is_(True), m.StorageType.is_active.is_(True))
    )).scalars().all())
    codes = tuple(sorted({(c or "").upper() for c in codes if c}))
    if not codes:
        return BIN_TYPES
    set_pickable_storage_types(codes)
    return codes


async def parents_by_type(db: AsyncSession) -> dict[int, list[int]]:
    """`{storage type id: [ids it may sit inside]}`, for every type at once."""
    out: dict[int, list[int]] = {}
    for child, parent in (await db.execute(
        select(m.StorageTypeParent.storage_type_id,
               m.StorageTypeParent.parent_storage_type_id)
    )).all():
        out.setdefault(int(child), []).append(int(parent))
    return out


async def labeller(db: AsyncSession):
    """One query, then a function that names any location's kind.

    Falls back through id, then code, then the raw code itself, because a location
    written before the master existed carries only the code — and a row whose kind
    has since been deleted still has to render as something rather than as blank.
    """
    rows = (await db.execute(select(m.StorageType))).scalars().all()
    by_id = {int(r.id): r.name for r in rows}
    by_code = {(r.code or "").upper(): r.name for r in rows}

    def label(storage_type_id, code) -> str | None:
        if storage_type_id and int(storage_type_id) in by_id:
            return by_id[int(storage_type_id)]
        return by_code.get((code or "").upper()) or (code or None)

    return label


async def names_by_id(db: AsyncSession) -> dict[int, str]:
    """`{id: display name}`, so a list of locations can be labelled with its kinds in
    one query rather than one per row."""
    return {int(i): n for i, n in (
        await db.execute(select(m.StorageType.id, m.StorageType.name))).all()}


async def resolve(db: AsyncSession, *, storage_type_id: int | None,
                  code: str | None) -> m.StorageType | None:
    """The master row a write means, by id if it named one and by code otherwise.

    Returns None only while the master is EMPTY, which is the one case a location may
    still be saved with a bare code: a database that has been created but never seeded
    must not have its location master bricked by its own type master being missing.
    """
    if storage_type_id:
        row = await db.get(m.StorageType, int(storage_type_id))
        if row is None:
            raise ValidationError("That storage type no longer exists. "
                                  "Pick one from Warehouse > Masters > Storage types.")
        return row

    wanted = (code or "").strip().upper()
    rows = (await db.execute(
        select(m.StorageType).order_by(m.StorageType.sort_order, m.StorageType.name)
    )).scalars().all()
    if not rows:
        return None
    if not wanted:
        raise ValidationError("Choose a storage type for this location.")
    for row in rows:
        if (row.code or "").upper() == wanted:
            return row
    known = ", ".join(r.code for r in rows if r.is_active)
    raise ValidationError(
        f"{wanted} is not a storage type. Use one of: {known} — or add it on "
        f"Warehouse > Masters > Storage types.")


async def assert_can_sit_under(db: AsyncSession, child: m.StorageType,
                               parent: Bin | None) -> None:
    """Refuse a location filed under a kind that cannot hold it.

    The allowed kinds are the master's, so the dropdown the storekeeper picks from and
    the rule the save enforces are the same list — a screen that offers only racks and
    a server that accepts anything is a screen nobody trusts twice.

    An UNCONFIGURED child (no parent rows and not marked top level) is left alone: the
    master starts empty for a kind somebody has just added, and refusing everything
    until they remember to fill the list in would make a new rung unusable.
    """
    allowed = set((await parents_by_type(db)).get(int(child.id), []))

    if parent is None:
        if allowed and not child.allow_top_level:
            names = await names_by_id(db)
            inside = ", ".join(sorted(names.get(i, str(i)) for i in allowed))
            raise ValidationError(
                f"A {child.name.lower()} cannot stand on its own — it sits inside "
                f"{inside}. Pick a parent location, or allow {child.name} at the top "
                f"level on Warehouse > Masters > Storage types.")
        return

    if not allowed:
        return

    # The PARENT's kind is read tolerantly, not through `resolve`: a location whose kind
    # has since been deleted from the master would otherwise raise "that storage type no
    # longer exists" while somebody is saving a different row, which names the wrong
    # document. A parent nobody can classify is a parent this rule cannot judge.
    parent_type = None
    if parent.storage_type_id:
        parent_type = await db.get(m.StorageType, int(parent.storage_type_id))
    if parent_type is None and parent.bin_type:
        parent_type = await db.scalar(select(m.StorageType).where(
            func.upper(m.StorageType.code) == parent.bin_type.upper()))
    if parent_type is None or int(parent_type.id) in allowed:
        return

    names = await names_by_id(db)
    inside = ", ".join(sorted(names.get(i, str(i)) for i in allowed))
    raise ValidationError(
        f"A {child.name.lower()} cannot sit inside {parent.code}, which is a "
        f"{parent_type.name.lower()}. A {child.name.lower()} goes inside: {inside}.")
