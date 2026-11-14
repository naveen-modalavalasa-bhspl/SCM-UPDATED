"""Pack hierarchies, read from the master (2026-10-08).

The DB half of `app/shared/packing.py`. Every module that writes a document line
saying how goods are packed — a PO, a despatch note, a GRN, a putaway, an issue —
asks THIS module for the ladder and validates the line against it, so the PO screen
and the GRN save can never disagree about what "1 Box" is.

Two queries for any number of items, never one per item: a GRN of forty lines must
not cost eighty round trips to say how each one is packed.
"""
from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError
from app.shared import packing
from app.shared.enums import ContainerUsage
from app.shared.models.master import (
    Item, ItemContainerUsage, ItemPackaging, Packaging, PackHierarchy,
)

#: The loose base unit's `package_id` in `mst_item_container_usage`.
LOOSE_PACKAGE = 0

#: Called as `await fn(db, item_id) -> dict` when an item's ISSUE containers change
#: (2026-10-23). The warehouse registers the re-code of the packs already on the
#: shelf; shared code may not import a module (rule 5), so it announces instead.
ON_ISSUE_USAGE_CHANGED: list = []
USAGES = [u.value for u in ContainerUsage]


async def ladders(db: AsyncSession, item_ids: Iterable[int]) -> dict[int, list[packing.Ladder]]:
    """`{item_id: [Ladder, ...]}`, default hierarchy first, then by name.

    An item with rungs but no hierarchy (a database the 2026-10-08 migration has not
    reached, or rungs written by an old client) reads them as one "Standard" ladder,
    so nothing that worked yesterday stops reading a ladder today.
    """
    ids = {int(i) for i in item_ids if i}
    if not ids:
        return {}
    items = dict((await db.execute(
        select(Item.id, Item.uom_code).where(Item.id.in_(ids)))).all())
    hierarchies = (await db.execute(
        select(PackHierarchy)
        .where(PackHierarchy.item_id.in_(ids), PackHierarchy.is_active.is_(True))
        .order_by(PackHierarchy.item_id, PackHierarchy.is_default.desc(),
                  PackHierarchy.name)
    )).scalars().all()
    rungs = (await db.execute(
        select(ItemPackaging)
        .where(ItemPackaging.item_id.in_(ids), ItemPackaging.is_active.is_(True))
        .order_by(ItemPackaging.item_id, ItemPackaging.level)
    )).scalars().all()

    by_hierarchy: dict[int | None, list] = {}
    for rung in rungs:
        by_hierarchy.setdefault(rung.hierarchy_id, []).append(rung)

    out: dict[int, list[packing.Ladder]] = {item_id: [] for item_id in ids}
    for h in hierarchies:
        out[h.item_id].append(packing.build_ladder(
            hierarchy_id=h.id, hierarchy_name=h.name, base_uom=items.get(h.item_id),
            rungs=by_hierarchy.get(h.id, [])))
    orphans: dict[int, list] = {}
    for rung in by_hierarchy.get(None, []):
        orphans.setdefault(rung.item_id, []).append(rung)
    for item_id, rows in orphans.items():
        if not out[item_id]:
            out[item_id].append(packing.build_ladder(
                hierarchy_id=None, hierarchy_name="Standard",
                base_uom=items.get(item_id), rungs=rows))
    return out


async def ladder(db: AsyncSession, item_id: int,
                 hierarchy_id: int | None) -> packing.Ladder:
    """The ladder a document line names — refused if it is not this item's.

    No hierarchy named means the item's default one; an item with no packing at all
    gets a ladder of one rung, loose units, so a line can always be described.
    """
    found = (await ladders(db, [item_id])).get(int(item_id), [])
    if hierarchy_id:
        for row in found:
            if row.hierarchy_id == int(hierarchy_id):
                return row
        # A hierarchy that was retired in master data after an order or despatch note
        # was already raised still describes goods that physically arrived in that packing.
        # Fall back to reading the retired hierarchy if it belongs to this item.
        h = await db.scalar(
            select(PackHierarchy).where(
                PackHierarchy.id == int(hierarchy_id),
                PackHierarchy.item_id == int(item_id),
            )
        )
        if h is not None:
            uom = await db.scalar(select(Item.uom_code).where(Item.id == item_id))
            rungs = (await db.execute(
                select(ItemPackaging)
                .where(ItemPackaging.hierarchy_id == h.id)
                .order_by(ItemPackaging.level)
            )).scalars().all()
            return packing.build_ladder(
                hierarchy_id=h.id, hierarchy_name=h.name,
                base_uom=uom, rungs=rungs
            )
        raise ValidationError(
            "That pack hierarchy does not belong to this item (or is no longer "
            "active). Pick one of the item's own hierarchies.")
    if found:
        return found[0]
    uom = await db.scalar(select(Item.uom_code).where(Item.id == item_id))
    return packing.build_ladder(hierarchy_id=None, hierarchy_name="Loose",
                                base_uom=uom, rungs=[])


def ladder_out(row: packing.Ladder, *, default_putaway: set[int] | None = None) -> dict:
    """One hierarchy as every document screen reads it — the options of the pack
    picker, with the sentence for each level already written."""
    default_putaway = default_putaway or set()
    return {
        "hierarchy_id": row.hierarchy_id,
        "name": row.hierarchy_name,
        "base_uom": row.base_uom,
        "levels": [{
            "item_packaging_id": lv.item_packaging_id,
            "level": lv.level,
            "name": lv.name if lv.level else f"Loose {row.base_uom or 'units'}",
            "size": float(lv.size),
            "ratio": float(lv.ratio),
            "label": row.label(lv.level),
            "min_fill": float(lv.min_fill) if lv.min_fill is not None else None,
            "is_default_putaway_unit": bool(lv.item_packaging_id
                                            and lv.item_packaging_id in default_putaway),
        } for lv in row.levels],
    }


async def usage_map(db: AsyncSession, item_ids: Iterable[int]) -> dict[int, dict[int, list[str]]]:
    """`{item_id: {package_id: [usage, ...]}}` — package 0 is the loose base unit."""
    ids = {int(i) for i in item_ids if i}
    out: dict[int, dict[int, list[str]]] = {i: {} for i in ids}
    if not ids:
        return out
    for item_id, package_id, usage in (await db.execute(
            select(ItemContainerUsage.item_id, ItemContainerUsage.package_id,
                   ItemContainerUsage.usage)
            .where(ItemContainerUsage.item_id.in_(ids))
            .order_by(ItemContainerUsage.id))).all():
        out[item_id].setdefault(int(package_id or 0), []).append(usage)
    # Always Indent, Purchase, Storage, Issue, Consumption — the order screens read.
    rank = {u: i for i, u in enumerate(USAGES)}
    for per_item in out.values():
        for key in per_item:
            per_item[key].sort(key=lambda u: rank.get(u, 99))
    return out


def level_usages(level, usages: dict[int, list[str]]) -> list[str]:
    """The usages one ladder level serves, off the item's usage map."""
    return list(usages.get(int(level.package_id or 0) if level.level else LOOSE_PACKAGE, []))


def levels_for(ladder_row: packing.Ladder, usages: dict[int, list[str]],
               usage: str) -> list[int]:
    """The level numbers of a ladder that serve `usage`. An item with nothing mapped
    for it answers the loose base unit, which is how every item worked before."""
    if not any(usage in v for v in usages.values()):
        return [0]
    return [lv.level for lv in ladder_row.levels if usage in level_usages(lv, usages)]


async def usage_levels(db: AsyncSession, item_id: int, ladder_row: packing.Ladder,
                       usage: str) -> list[int] | None:
    """The levels of THIS ladder that serve `usage` for the item, or None when the
    item has nothing mapped for it — the caller then keeps its old behaviour."""
    mapped = (await usage_map(db, [item_id])).get(int(item_id), {})
    if not any(usage in v for v in mapped.values()):
        return None
    return [lv.level for lv in ladder_row.levels if usage in level_usages(lv, mapped)]


async def issues_in_containers(db: AsyncSession, item_id: int) -> bool:
    """Is the item ISSUED in a container (a strip, a box) rather than loose units?
    Then its codes are the containers' (one per strip, made at putaway) and no code
    is minted per base unit (2026-10-23)."""
    mapped = (await usage_map(db, [item_id])).get(int(item_id), {})
    return any("ISSUE" in usages for package_id, usages in mapped.items() if package_id)


async def describe_in(db: AsyncSession, rows: list[dict], usage: str) -> list[str | None]:
    """Each row's quantity said in the item's containers of `usage` (2026-10-23):
    `rows` carry item_id, brand_id and qty; the answer is "15 Strip" or None where the
    item has no container mapped for that usage (then a screen shows the quantity
    alone). The ladder is the row's brand's, else the "all brands" one, else the
    item's default. Two queries for the whole list."""
    ids = {int(r["item_id"]) for r in rows if r.get("item_id")}
    found = await ladders(db, ids)
    usages = await usage_map(db, ids)
    brand_of = dict((await db.execute(
        select(PackHierarchy.id, PackHierarchy.brand_id)
        .where(PackHierarchy.item_id.in_(ids)))).all()) if ids else {}
    out: list[str | None] = []
    for row in rows:
        item_id = int(row.get("item_id") or 0)
        mapped = usages.get(item_id, {})
        candidates = found.get(item_id) or []
        if not item_id or not candidates or not any(usage in v for v in mapped.values()):
            out.append(None)
            continue
        brand = int(row.get("brand_id") or 0)
        ladder_row = (next((l for l in candidates if brand and brand_of.get(l.hierarchy_id) == brand), None)
                      or next((l for l in candidates if not brand_of.get(l.hierarchy_id)), None)
                      or candidates[0])
        levels = [lv.level for lv in ladder_row.levels if usage in level_usages(lv, mapped)]
        qty = packing.dec(row.get("qty") or 0)
        if not levels or qty <= 0:
            out.append(None)
            continue
        out.append(packing.describe(packing.greedy_in(ladder_row, qty, levels),
                                    ladder_row.base_uom, with_total=False))
    return out


async def container_usage(db: AsyncSession, item_id: int) -> dict:
    """Masters › Packaging › Container Usage: every container type used in ANY ladder
    of the item, once, with the ladders it sits in and the usages ticked for it."""
    item = await db.get(Item, item_id)
    if item is None:
        raise ValidationError("Item not found")
    found = (await ladders(db, [item_id])).get(item_id, [])
    brands = dict((await db.execute(
        select(PackHierarchy.id, PackHierarchy.brand_name)
        .where(PackHierarchy.item_id == item_id))).all())
    containers: dict[int, dict] = {LOOSE_PACKAGE: {
        "package_id": LOOSE_PACKAGE, "code": None,
        "name": f"Loose {item.uom_code or 'units'}", "is_loose": True, "used_in": []}}
    for row in found:
        for lv in row.levels:
            key = int(lv.package_id or 0) if lv.level else LOOSE_PACKAGE
            entry = containers.setdefault(key, {
                "package_id": key, "code": None, "name": lv.name, "is_loose": False,
                "used_in": []})
            if lv.level:
                entry["used_in"].append({
                    "hierarchy_id": row.hierarchy_id, "hierarchy": row.hierarchy_name,
                    "brand_name": brands.get(row.hierarchy_id), "level": lv.level,
                    "size": float(lv.size)})
    codes = dict((await db.execute(select(Packaging.id, Packaging.code).where(
        Packaging.id.in_([k for k in containers if k])))).all()) if len(containers) > 1 else {}
    for key, entry in containers.items():
        entry["code"] = codes.get(key)
    usages = (await usage_map(db, [item_id]))[item_id]
    rows = sorted(containers.values(),
                  key=lambda e: (min([u["size"] for u in e["used_in"]] or [0]), e["name"]))
    for entry in rows:
        entry["usages"] = usages.get(entry["package_id"], [])
    return {"item_id": item.id, "item_code": item.code, "item_name": item.name,
            "base_uom": item.uom_code, "usages": USAGES, "containers": rows,
            "unmapped": [u for u in USAGES if not any(u in v for v in usages.values())]}


def _assert_issue_within_storage(current: dict, wanted: set[tuple[int, str]]) -> None:
    """An item is never ISSUED in a container bigger than the one it is STORED in
    (2026-10-27): a box can be cut out of a carton on the shelf, a carton cannot be
    made out of boxes at the issue desk. Per hierarchy, every Issue level must sit at
    or below the SMALLEST Storage level, so every pack on the shelf can be broken down
    to it. A hierarchy with no Storage container mapped constrains nothing."""
    storage = {p for p, u in wanted if u == "STORAGE"}
    issue = {p for p, u in wanted if u == "ISSUE"}
    if not storage or not issue:
        return
    by_ladder: dict[int | None, dict] = {}
    for c in current["containers"]:
        for use in c.get("used_in") or []:
            row = by_ladder.setdefault(use["hierarchy_id"], {"name": use["hierarchy"],
                                                             "storage": [], "issue": []})
            if c["package_id"] in storage:
                row["storage"].append((use["level"], c["name"]))
            if c["package_id"] in issue:
                row["issue"].append((use["level"], c["name"]))
    for row in by_ladder.values():
        if not row["storage"] or not row["issue"]:
            continue
        smallest = min(row["storage"])
        too_big = sorted(n for lv, n in row["issue"] if lv > smallest[0])
        if too_big:
            raise ValidationError(
                f"{', '.join(too_big)} cannot be an Issue container in {row['name']}: it "
                f"is bigger than {smallest[1]}, the smallest container it is stored in. "
                "Issue in the storage container or a smaller one, so every pack on the "
                "shelf can be broken down to it.")


async def save_container_usage(db: AsyncSession, item_id: int, rows: list[dict]) -> dict:
    """Replace the item's usage mapping. Every container named must be one of the
    item's own (loose, or in one of its ladders); an unknown usage is refused."""
    current = await container_usage(db, item_id)
    allowed = {c["package_id"] for c in current["containers"]}
    wanted: set[tuple[int, str]] = set()
    for row in rows:
        package_id = int(row.get("package_id") or 0)
        if package_id not in allowed:
            raise ValidationError(
                "That container is not in any pack hierarchy of this item. Add it to a "
                "hierarchy under Item Packaging Variants first.")
        for usage in row.get("usages") or []:
            if usage not in USAGES:
                raise ValidationError(f"Unknown usage {usage}")
            wanted.add((package_id, usage))
    _assert_issue_within_storage(current, wanted)
    have = {(int(p or 0), u): i for i, p, u in (await db.execute(
        select(ItemContainerUsage.id, ItemContainerUsage.package_id,
               ItemContainerUsage.usage)
        .where(ItemContainerUsage.item_id == item_id))).all()}
    issue_before = {p for (p, u) in have if u == "ISSUE"}
    issue_after = {p for (p, u) in wanted if u == "ISSUE"}
    for key, row_id in have.items():
        if key not in wanted:
            await db.delete(await db.get(ItemContainerUsage, row_id))
    for package_id, usage in wanted - set(have):
        db.add(ItemContainerUsage(item_id=item_id, package_id=package_id, usage=usage))
    await db.flush()
    out = await container_usage(db, item_id)
    # The Issue container changed: the codes on the shelf follow it.
    if issue_before != issue_after:
        recoded: dict = {}
        for fn in ON_ISSUE_USAGE_CHANGED:
            for key, value in ((await fn(db, item_id)) or {}).items():
                recoded[key] = recoded.get(key, 0) + value if isinstance(value, int) else value
        out["recoded"] = recoded
    return out


async def pack_options(db: AsyncSession, item_ids: Iterable[int]) -> dict[int, list[dict]]:
    """`{item_id: [hierarchy, ...]}` for the pack pickers on every document — each
    hierarchy with its brand, and each level with the usages it serves (2026-10-23),
    so every screen offers and defaults to the containers of its own usage."""
    ids = {int(i) for i in item_ids if i}
    found = await ladders(db, ids)
    usages = await usage_map(db, ids)
    brands = {hid: (bid, name) for hid, bid, name in (await db.execute(
        select(PackHierarchy.id, PackHierarchy.brand_id, PackHierarchy.brand_name)
        .where(PackHierarchy.item_id.in_(ids)))).all()} if ids else {}
    default_putaway = set((await db.execute(
        select(ItemPackaging.id).where(
            ItemPackaging.item_id.in_(ids),
            ItemPackaging.is_default_putaway_unit.is_(True),
            ItemPackaging.is_active.is_(True)))).scalars().all()) if ids else set()
    defaults = set((await db.execute(
        select(PackHierarchy.id).where(PackHierarchy.item_id.in_(ids),
                                       PackHierarchy.is_default.is_(True))
    )).scalars().all()) if ids else set()
    def decorate(item_id: int, row: packing.Ladder, index: int) -> dict:
        out = {**ladder_out(row, default_putaway=default_putaway),
               "is_default": row.hierarchy_id in defaults or index == 0,
               "brand_id": brands.get(row.hierarchy_id, (None, None))[0],
               "brand_name": brands.get(row.hierarchy_id, (None, None))[1]}
        mapped = usages.get(item_id, {})
        for lv, level in zip(out["levels"], row.levels):
            lv["package_id"] = int(level.package_id or 0) if level.level else LOOSE_PACKAGE
            lv["usages"] = level_usages(level, mapped)
        # The usages nothing is mapped for — those fall back to loose units.
        out["unmapped_usages"] = [u for u in USAGES
                                  if not any(u in v for v in mapped.values())]
        return out

    return {item_id: [decorate(item_id, row, index) for index, row in enumerate(rows)]
            for item_id, rows in found.items()}


async def snapshot(db: AsyncSession, *, item_id: int, hierarchy_id: int | None,
                   entries, base_qty=None, min_level: int = 0,
                   allow_fraction_loose: bool = True,
                   enforce_min: bool = False) -> tuple[int | None, list[dict]]:
    """Validate and freeze a line's breakdown. Returns (hierarchy_id, entries).

    With no entries but a base quantity, the line is described in its hierarchy's
    biggest whole packs (so a line written without a pack still reads as packs).
    With entries AND a base quantity, they must agree — the server never lets the
    breakdown and the number on the line say two different things.
    """
    row = await ladder(db, item_id, hierarchy_id)
    try:
        if entries:
            out = packing.normalize(row, entries, min_level=min_level,
                                    allow_fraction_loose=allow_fraction_loose,
                                    enforce_min=enforce_min)
        elif base_qty is not None:
            out = packing.greedy(row, base_qty)
        else:
            out = []
    except packing.PackError as exc:
        raise ValidationError(str(exc)) from exc
    # The hierarchy's NAME rides on every entry, frozen with the sizes: a document
    # must keep reading "Strip of 10" even if the master is renamed tomorrow.
    for row_entry in out:
        row_entry["hierarchy"] = row.hierarchy_name
    if entries and base_qty is not None and packing.base_of(out) != packing.dec(base_qty):
        raise ValidationError(
            f"The packing ({packing.describe(out, row.base_uom)}) does not add up to "
            f"the quantity on the line ({packing.fmt(base_qty)} {row.base_uom or 'units'}).")
    return row.hierarchy_id, out
