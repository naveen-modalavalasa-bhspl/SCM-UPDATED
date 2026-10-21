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
from app.shared.models.master import Item, ItemPackaging, PackHierarchy


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


async def pack_options(db: AsyncSession, item_ids: Iterable[int]) -> dict[int, list[dict]]:
    """`{item_id: [hierarchy, ...]}` for the pack pickers on every document."""
    ids = {int(i) for i in item_ids if i}
    found = await ladders(db, ids)
    default_putaway = set((await db.execute(
        select(ItemPackaging.id).where(
            ItemPackaging.item_id.in_(ids),
            ItemPackaging.is_default_putaway_unit.is_(True),
            ItemPackaging.is_active.is_(True)))).scalars().all()) if ids else set()
    defaults = set((await db.execute(
        select(PackHierarchy.id).where(PackHierarchy.item_id.in_(ids),
                                       PackHierarchy.is_default.is_(True))
    )).scalars().all()) if ids else set()
    return {item_id: [{**ladder_out(row, default_putaway=default_putaway),
                       "is_default": row.hierarchy_id in defaults or index == 0}
                      for index, row in enumerate(rows)]
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
