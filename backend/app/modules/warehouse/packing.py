"""Packs on the shelf — handling units (2026-10-08).

`stk_balance` counts an item in its base unit and always will (rule 7). This module is
the layer that says how those units are BAGGED: one `whs_handling_units` row per
physical pack — a strip, a box, a carton — nested by `parent_id`, so the stock screens
read "2 Carton + 3 Box + 14 loose TAB" instead of "2,744".

What it owns, in the order goods meet it:

  1. THE GATE      `receipt_line_packing` — the supplier's declared packing is fixed;
                   the gate counts it, and may only come up short.
  2. THE SHELF     `shelve` — confirming a putaway makes one row per pack, links each
                   unit row (`whs_serial_numbers.handling_unit_id`) to the pack it is
                   in, and names every pack. For a code-tracked item the pack's code IS
                   its identity and the pack is an ATOM: wrap it, never split it.
  3. THE READ      `pack_summary` / `lot_packs` — what a stock row is packed as.
  4. THE REPACK    `repack` — change pack levels on the shelf; never the quantity,
                   never the hierarchy, never below the level a code was minted at.
  5. THE ISSUE     `issue_line_packing`, `assert_issue_packs`, `settle_issue` — issue
                   in packs; a coded pack leaves whole unless the storekeeper holds
                   `issue.break_bulk`, which retires its code and mints new ones for
                   what stays behind.

LOOSE IS NEVER STORED. It is `total_qty` minus what the live packs hold, so any path
that moves stock without knowing about packs (an adjustment, a transfer) cannot leave a
stored "loose" figure disagreeing with the balance. Where packs claim MORE than the
balance holds, the read caps them and `reconcile_key` puts the rows right.
"""
from __future__ import annotations

import json
import logging
import re
from decimal import Decimal
from types import SimpleNamespace
from uuid import uuid4

from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.modules.inventory.models import Stock
from app.modules.warehouse import models as m
from app.modules.warehouse.enums import (
    LIVE_HANDLING_UNIT_STATUSES as LIVE, HandlingUnitStatus as HUS, SerialStatus,
)
from app.platform.rbac import permissions as perms
from app.platform.settings import codeformat
from app.platform.settings.service import write_audit
from app.shared import packing
from app.shared.enums import AuditAction
from app.shared.limits import MAX_PACKS_PER_REQUEST
from app.shared.masters import packs
from app.shared.models.base import utcnow
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse

logger = logging.getLogger(__name__)

ZERO = Decimal("0")


def _d(value) -> Decimal:
    return packing.dec(value)


def _fail(item, exc: Exception) -> ValidationError:
    prefix = getattr(item, "code", None) or getattr(item, "name", None) or "Item"
    return ValidationError(f"{prefix}: {exc}")


def _named(entries, ladder: packing.Ladder) -> list[dict]:
    for e in entries:
        e["hierarchy"] = ladder.hierarchy_name
    return entries


def held(hu) -> Decimal:
    """What one pack on the shelf REALLY holds: its `content_qty` when it is a part
    pack, else its full `pack_size`. Every sum of what packs hold reads this."""
    content = getattr(hu, "content_qty", None)
    return _d(content) if content is not None else _d(hu.pack_size)


def is_part(hu) -> bool:
    return held(hu) < _d(hu.pack_size)


def _set_held(hu, qty) -> None:
    """Record what a pack now holds — NULL again once it is back to full."""
    qty = _d(qty)
    hu.content_qty = None if qty >= _d(hu.pack_size) else qty


async def _floors(db: AsyncSession, rung_ids) -> dict[int, Decimal]:
    """{item_packaging_id: min_fill_qty} for the rungs that carry a floor."""
    from app.shared.models.master import ItemPackaging
    ids = {int(r) for r in rung_ids if r}
    if not ids:
        return {}
    rows = (await db.execute(select(ItemPackaging.id, ItemPackaging.min_fill_qty).where(
        ItemPackaging.id.in_(ids), ItemPackaging.min_fill_qty.is_not(None)))).all()
    return {r[0]: _d(r[1]) for r in rows if _d(r[1]) > ZERO}


def _below_floor(hu, floors: dict) -> bool:
    floor = floors.get(hu.item_packaging_id)
    return floor is not None and held(hu) < floor


# --------------------------------------------------------------------------- #
#  What kind of identity an item's packs carry
# --------------------------------------------------------------------------- #

def serialised(item) -> bool:
    return bool(getattr(item, "is_serial_tracked", False)
                or getattr(item, "is_imei_tracked", False))


async def codes_per_pack(db: AsyncSession, item, warehouse, config=None) -> bool:
    """Whether a pack of this item carries the item's own asset / consumable code.

    NEVER, since 2026-10-22. Codes belong to the BASE UNIT: every unit is coded at
    putaway (the unit coder), and a pack is only a labelled container around units,
    shown as packs but issued, counted and coded per unit. A coded pack used to be an
    ATOM — wrapped, never split — which refused most repacks of code-tracked stock and
    forced a break bulk at the issue desk for anything less than a whole pack.

    Kept as the one switch every caller asks, so nothing else decides it.
    `scripts.unatom_packs` turns the packs coded before this into plain packs.
    """
    return False


# --------------------------------------------------------------------------- #
#  1. The gate
# --------------------------------------------------------------------------- #

async def receipt_line_packing(db: AsyncSession, *, item, line_in, received) -> dict:
    """Resolve one receipt line's packing. Returns the columns to write and the
    `received` quantity the line must carry.

    * Against a despatch-note line that declared its packing, the DECLARED packing is
      copied from the note (never from the client) and fixed: the count may only come
      up short, level by level (`packing.assert_within`). A count given in packs sets
      `received` to its total; a bare quantity is read inside the declared packs.
    * Otherwise the storekeeper states the packing — in the order's hierarchy, else
      the item's default — or the quantity is described in whole packs of it.
    """
    from app.modules.procurement.models import DespatchNoteItem, POItem

    received = _d(received)
    entries = [e.model_dump() if hasattr(e, "model_dump") else dict(e)
               for e in (line_in.pack_breakdown or [])] or None
    dn = None
    if getattr(line_in, "despatch_note_item_id", None):
        dn = await db.get(DespatchNoteItem, line_in.despatch_note_item_id)
        if dn is None or dn.item_id != item.id:
            raise ValidationError(
                f"{item.code}: that despatch-note line is not for this item.")

    if dn is not None and dn.pack_breakdown:
        if line_in.pack_hierarchy_id and int(line_in.pack_hierarchy_id) != dn.pack_hierarchy_id:
            raise ValidationError(
                f"{item.code}: the supplier sent this as "
                f"\"{dn.pack_breakdown[0].get('hierarchy')}\". The packing on a despatch "
                "note is fixed at the gate.")
        ladder = await packs.ladder(db, item.id, dn.pack_hierarchy_id)
        declared = dn.pack_breakdown
        try:
            if entries:
                counted = packing.normalize(ladder, entries)
                packing.assert_within(ladder, counted, declared)
                received = packing.base_of(counted)
            elif received > packing.base_of(declared):
                raise packing.PackError(
                    f"{packing.fmt(received)} {item.uom_code or 'units'} is more than "
                    f"the despatch note declares "
                    f"({packing.describe(declared, item.uom_code)}).")
            else:
                counted = packing.shrink_snapshot(declared, received) if received else []
        except packing.PackError as exc:
            raise _fail(item, exc) from exc
        return {"pack_hierarchy_id": dn.pack_hierarchy_id,
                "declared_pack_breakdown": declared,
                "pack_breakdown": _named(counted, ladder) or None,
                "despatch_note_item_id": dn.id, "received": received}

    hierarchy_id = line_in.pack_hierarchy_id
    if not hierarchy_id and getattr(line_in, "po_item_id", None):
        hierarchy_id = await db.scalar(
            select(POItem.pack_hierarchy_id).where(POItem.id == line_in.po_item_id))
    ladder = await packs.ladder(db, item.id, hierarchy_id)
    base = {"declared_pack_breakdown": None,
            "despatch_note_item_id": dn.id if dn is not None else None}
    if ladder.top == 0 and not entries:
        return {**base, "pack_hierarchy_id": None, "pack_breakdown": None,
                "received": received}
    try:
        if entries:
            counted = packing.normalize(ladder, entries)
            received = packing.base_of(counted)
        else:
            counted = packing.greedy(ladder, received) if received > ZERO else []
    except packing.PackError as exc:
        raise _fail(item, exc) from exc
    return {**base, "pack_hierarchy_id": ladder.hierarchy_id,
            "pack_breakdown": _named(counted, ladder) or None, "received": received}


def despatch_prefill_packing(dn_line, sent) -> dict:
    """The despatch-note packing as the receipt form shows it: declared in full, and
    the count it starts from — capped at what the order still owes."""
    declared = getattr(dn_line, "pack_breakdown", None)
    out = {"despatch_note_item_id": getattr(dn_line, "id", None),
           "pack_change_status": getattr(dn_line, "pack_change_status", None),
           "ordered_pack_hierarchy_name": getattr(dn_line, "ordered_pack_hierarchy_name", None),
           "pack_change_reason": getattr(dn_line, "pack_change_reason", None),
           "pack_change_note": getattr(dn_line, "pack_change_note", None)}
    if not declared:
        return out
    return {**out, "pack_hierarchy_id": dn_line.pack_hierarchy_id,
            "pack_breakdown": declared,
            "counted_pack_breakdown": packing.shrink_snapshot(declared, sent)}


# --------------------------------------------------------------------------- #
#  2. The shelf — packs are born at putaway
# --------------------------------------------------------------------------- #

def _tag(name: str | None) -> str:
    return (re.sub(r"[^A-Za-z0-9]", "", name or "PACK").upper() or "PACK")[:8]


async def _name_packs(db: AsyncSession, hus: list, item, warehouse, atoms: bool) -> None:
    """Give every new pack its label.

    An ATOM carries the item's own asset / consumable code, from the configured
    formula, with the pack level on the end (`…-BOX`) — the same formula the unit
    codes come from, kept apart from them by the tag, because the two are minted off
    different tables' ids. Any other pack gets a plain handling-unit number.
    """
    if not hus:
        return
    config = await codeformat.code_settings(db) if atoms else None
    names: dict[int, str] = {}
    for hu in hus:
        if atoms:
            stem = await codeformat.unit_code(
                db, item=item, is_asset=bool(getattr(item, "is_asset", False)),
                seq=hu.id, warehouse_code=getattr(warehouse, "code", None),
                config=config)
            names[hu.id] = f"{stem}-{_tag(hu.pack_name)}"[:120]
        else:
            names[hu.id] = f"PK-{getattr(warehouse, 'code', None) or 'WH'}-{hu.id:07d}"[:120]
    taken = set((await db.execute(
        select(m.HandlingUnit.hu_code).where(m.HandlingUnit.hu_code.in_(names.values()))
    )).scalars().all())
    seen: set[str] = set()
    for hu in hus:
        code = names[hu.id]
        if code in taken or code in seen:
            # The formula is a setting; a shape without {seq} renders one code twice.
            code = f"{code}-{hu.id}"[:120]
        seen.add(code)
        hu.hu_code = code
        hu.code_kind = (("ASSET" if getattr(item, "is_asset", False) else "CONSUMABLE")
                        if atoms else "PACK")
    await db.flush()


def _new_pack(*, key: dict, ladder: packing.Ladder, level: int, atom: bool,
              source: tuple, lot_no=None, user=None, parent_id=None,
              content=None) -> m.HandlingUnit:
    row = ladder.at(level)
    return m.HandlingUnit(
        content_qty=(_d(content) if content is not None and _d(content) < row.size
                     else None),
        hu_code=f"~PENDING-{uuid4().hex}", code_kind="PACK",
        item_id=key["item_id"], warehouse_id=key["warehouse_id"],
        bin_id=key["bin_id"] or m.NO_BIN, batch_id=key["batch_id"] or m.NO_BATCH,
        project_id=key["project_id"] or 0,
        pack_hierarchy_id=ladder.hierarchy_id, item_packaging_id=row.item_packaging_id,
        level=level, pack_name=row.name, pack_size=row.size,
        parent_id=parent_id, is_atom=atom,
        status=HUS.INSIDE.value if parent_id else HUS.SEALED.value,
        lot_no=lot_no, source_type=source[0], source_id=source[1], source_no=source[2],
        created_by_id=getattr(user, "id", None),
    )


def _unit_scope(stmt, key: dict):
    """Units standing at one stock key. A unit row says "no bin" / "no batch" with
    NULL where the balance says 0, so both spellings are matched."""
    stmt = stmt.where(m.SerialNumber.item_id == key["item_id"],
                      m.SerialNumber.warehouse_id == key["warehouse_id"],
                      m.SerialNumber.is_active.is_(True))
    for column, value in ((m.SerialNumber.bin_id, key["bin_id"]),
                          (m.SerialNumber.batch_id, key["batch_id"])):
        if value:
            stmt = stmt.where(column == value)
        else:
            stmt = stmt.where(or_(column.is_(None), column == 0))
    return stmt


async def _loose_units(db: AsyncSession, key: dict, *, lot_no=None, limit=None) -> list[int]:
    stmt = _unit_scope(select(m.SerialNumber.id), key).where(
        m.SerialNumber.handling_unit_id.is_(None),
        m.SerialNumber.status == SerialStatus.AVAILABLE.value)
    if lot_no:
        stmt = stmt.where(m.SerialNumber.lot_no == lot_no)
    stmt = stmt.order_by(m.SerialNumber.id)
    if limit is not None:
        stmt = stmt.limit(limit)
    return list((await db.execute(stmt)).scalars().all())


async def _link_units(db: AsyncSession, unit_ids: list[int], hu_id: int | None) -> None:
    for start in range(0, len(unit_ids), 1000):
        chunk = unit_ids[start:start + 1000]
        await db.execute(update(m.SerialNumber).where(m.SerialNumber.id.in_(chunk))
                         .values(handling_unit_id=hu_id))


async def shelve(db: AsyncSession, *, item, key: dict, qty, hierarchy_id, entries_in,
                 default_entries=None, lot_no=None, source: tuple, user) -> list[dict] | None:
    """Make the packs one putaway (or a bulk receipt) puts on the shelf.

    `entries_in` is what the storekeeper chose; `default_entries` what arrived (the
    receipt's count); failing both, whole packs of the hierarchy. The hierarchy itself
    is never the storekeeper's to change here — it is the receipt's.

    One row per pack, smallest packs first, so pack ids climb with pack size and an
    automatic pick (loose units first, then pack by pack) opens as few as it can. The
    units this putaway placed are linked to their packs in the same order: loose ones
    stay loose, the rest fill each pack with exactly what it holds.

    A PART pack ("1 Carton (500 of 600)") is shelved holding what it holds. This is
    where packs are MADE, so a part pack under its level's minimum is refused when the
    storekeeper names it; when it only came from the receipt's count (a short carton
    at the gate), the putaway falls back to whole packs and loose rather than refuse.
    """
    ladder = await packs.ladder(db, item.id, hierarchy_id)
    if ladder.top == 0:
        return None
    qty = _d(qty)
    try:
        if entries_in:
            entries = packing.normalize(ladder, [
                e.model_dump() if hasattr(e, "model_dump") else dict(e)
                for e in entries_in], enforce_min=True)
        elif default_entries:
            try:
                entries = packing.normalize(ladder, default_entries, enforce_min=True)
            except packing.PackError:
                entries = packing.greedy(ladder, qty)
            if packing.base_of(entries) != qty:
                entries = packing.shrink_snapshot(entries, qty) \
                    if packing.base_of(entries) > qty else packing.greedy(ladder, qty)
        else:
            entries = packing.greedy(ladder, qty)
    except packing.PackError as exc:
        raise _fail(item, exc) from exc
    if packing.base_of(entries) != qty:
        raise ValidationError(
            f"{item.code}: the packing ({packing.describe(entries, item.uom_code)}) does "
            f"not add up to the {packing.fmt(qty)} {item.uom_code or 'units'} being put "
            "away. Repacking changes how goods are bagged, never how many there are.")
    count = sum(int(_d(e["qty"])) for e in entries if int(e["level"]))
    if count > MAX_PACKS_PER_REQUEST:
        raise ValidationError(
            f"{item.code}: that is {count:,} separate packs, and one press may make at "
            f"most {MAX_PACKS_PER_REQUEST:,}. Put it away in a bigger pack level.")

    warehouse = await db.get(Warehouse, key["warehouse_id"])
    atom = await codes_per_pack(db, item, warehouse)
    made: list[m.HandlingUnit] = []
    for e in sorted(entries, key=lambda x: int(x["level"])):
        level = int(e["level"])
        if level == 0:
            continue
        for _ in range(int(_d(e["qty"]))):
            hu = _new_pack(key=key, ladder=ladder, level=level, atom=atom,
                           source=source, lot_no=lot_no, user=user,
                           content=packing.held(e) if packing.is_partial(e) else None)
            db.add(hu)
            made.append(hu)
    await db.flush()
    await _name_packs(db, made, item, warehouse, atom)

    # Link the units this putaway placed: the loose ones first (they stay loose), then
    # pack by pack in id order, each taking exactly what it holds.
    loose = int(_d(next((e["qty"] for e in entries if int(e["level"]) == 0), 0)))
    units = await _loose_units(db, key, lot_no=lot_no)
    cursor = min(loose, len(units))
    for hu in made:
        size = int(held(hu))
        take = units[cursor:cursor + size]
        cursor += len(take)
        if take:
            await _link_units(db, take, hu.id)
    return _named(entries, ladder)


async def putaway_packing(db: AsyncSession, task) -> dict:
    """What the putaway screen needs to offer a re-pack: the receipt's hierarchy, what
    arrived, how it was shelved and the hierarchy's levels."""
    item = await db.get(Item, task.item_id)
    receipt_line = await db.get(m.ReceiptItem, task.grn_item_id) if task.grn_item_id else None
    hid = task.pack_hierarchy_id or (receipt_line.pack_hierarchy_id if receipt_line else None)
    ladder = await packs.ladder(db, task.item_id, hid)
    if ladder.top == 0:
        return {"pack_levels": [], "pack_breakdown": task.pack_breakdown}
    counted = receipt_line.pack_breakdown if receipt_line is not None else None
    if counted and packing.base_of(counted) != _d(task.qty):
        counted = packing.shrink_snapshot(counted, task.qty) \
            if packing.base_of(counted) > _d(task.qty) else None
    arriving = counted or _named(packing.greedy(ladder, task.qty), ladder)
    warehouse = await db.get(Warehouse, task.warehouse_id)
    return {
        "pack_hierarchy_id": ladder.hierarchy_id,
        "pack_hierarchy_name": ladder.hierarchy_name,
        "received_pack_breakdown": arriving,
        "pack_breakdown": task.pack_breakdown,
        "pack_levels": packs.ladder_out(ladder)["levels"],
        "codes_per_pack": await codes_per_pack(db, item, warehouse),
    }


# --------------------------------------------------------------------------- #
#  3. The read — what a stock row is packed as
# --------------------------------------------------------------------------- #

def _key_of(row) -> tuple:
    get = row.get if isinstance(row, dict) else (lambda k: getattr(row, k, None))
    return (int(get("item_id")), int(get("warehouse_id")), int(get("bin_id") or 0),
            int(get("batch_id") or 0), int(get("project_id") or 0))


async def pack_summary(db: AsyncSession, keys: list[dict]) -> list[dict]:
    """For each stock row: its outermost packs per hierarchy, the loose remainder and
    the sentence. Three queries for any number of rows.

    A PART pack is its own entry ("1 Carton (350 of 500)"), counted at what it really
    holds, and `below_min` counts the packs under their level's minimum — allowed (an
    issue took from them), but flagged until somebody repacks them.

    Packs claiming more than the balance holds (stock left by a path that does not
    know about packs) are capped on the way out — biggest kept, smallest dropped — and
    the row is flagged `unreconciled` rather than shown impossible.
    """
    if not keys:
        return []
    item_ids = {int(k["item_id"]) for k in keys}
    wh_ids = {int(k["warehouse_id"]) for k in keys}
    holds = func.coalesce(m.HandlingUnit.content_qty, m.HandlingUnit.pack_size)
    rows = (await db.execute(
        select(m.HandlingUnit.item_id, m.HandlingUnit.warehouse_id, m.HandlingUnit.bin_id,
               m.HandlingUnit.batch_id, m.HandlingUnit.project_id,
               m.HandlingUnit.pack_hierarchy_id, m.HandlingUnit.level,
               m.HandlingUnit.pack_name, m.HandlingUnit.pack_size,
               m.HandlingUnit.item_packaging_id, func.count(), holds)
        .where(m.HandlingUnit.item_id.in_(item_ids),
               m.HandlingUnit.warehouse_id.in_(wh_ids),
               m.HandlingUnit.status == HUS.SEALED.value)
        .group_by(m.HandlingUnit.item_id, m.HandlingUnit.warehouse_id,
                  m.HandlingUnit.bin_id, m.HandlingUnit.batch_id,
                  m.HandlingUnit.project_id, m.HandlingUnit.pack_hierarchy_id,
                  m.HandlingUnit.level, m.HandlingUnit.pack_name,
                  m.HandlingUnit.pack_size, m.HandlingUnit.item_packaging_id, holds)
    )).all()
    names = {}
    hids = {r[5] for r in rows}
    if hids:
        from app.shared.models.master import PackHierarchy
        names = dict((await db.execute(
            select(PackHierarchy.id, PackHierarchy.name).where(PackHierarchy.id.in_(hids))
        )).all())
    floors = await _floors(db, {r[9] for r in rows})
    grouped: dict[tuple, list] = {}
    for r in rows:
        grouped.setdefault((r[0], r[1], r[2] or 0, r[3] or 0, r[4] or 0), []).append(r)

    out = []
    for key in keys:
        total = _d(key.get("total_qty"))
        uom = key.get("uom_code")
        # Biggest pack first, full before part, so a cap drops the smallest.
        found = sorted(grouped.get(_key_of(key), []),
                       key=lambda r: (-_d(r[8]), -_d(r[11]), r[5]))
        remaining, entries, capped, below = total, [], False, 0
        for r in found:
            size, count, inside = _d(r[8]), int(r[10]), _d(r[11])
            fit = min(count, int((remaining / inside).to_integral_value(rounding="ROUND_FLOOR"))
                      if inside > ZERO else 0)
            if fit < count:
                capped = True
            if fit:
                entry = {"item_packaging_id": r[9], "level": r[6],
                         "name": r[7], "size": packing.plain(size),
                         "qty": str(fit), "hierarchy": names.get(r[5]),
                         "hierarchy_id": r[5]}
                if inside < size:
                    entry["fill"] = packing.plain(inside)
                    floor = floors.get(r[9])
                    if floor is not None and inside < floor:
                        entry["below_min"] = True
                        entry["min_fill"] = packing.plain(floor)
                        below += fit
                entries.append(entry)
                remaining -= inside * fit
        hierarchies = {e["hierarchy"] for e in entries}
        if len(hierarchies) > 1:
            for e in entries:
                e["name"] = f"{e['name']} ({e['hierarchy']})"
        if remaining > ZERO and entries:
            entries.append({"item_packaging_id": None, "level": 0, "name": packing.LOOSE,
                            "size": "1", "qty": packing.plain(remaining)})
        out.append({
            **{k: key.get(k) for k in ("item_id", "warehouse_id", "bin_id", "batch_id",
                                       "project_id", "stock_id")},
            "packs": entries,
            "loose_qty": float(remaining) if entries else float(total),
            "pack_text": packing.describe(entries, uom) if entries else None,
            "unreconciled": capped,
            "part_packs": sum(int(_d(e["qty"])) for e in entries if e.get("fill")),
            "below_min": below,
        })
    return out


async def _live_tree(db: AsyncSession, key: dict, *,
                     lock: bool = False) -> list[m.HandlingUnit]:
    stmt = (
        select(m.HandlingUnit).where(
            m.HandlingUnit.item_id == key["item_id"],
            m.HandlingUnit.warehouse_id == key["warehouse_id"],
            m.HandlingUnit.bin_id == (key["bin_id"] or 0),
            m.HandlingUnit.batch_id == (key["batch_id"] or 0),
            m.HandlingUnit.project_id == (key["project_id"] or 0),
            m.HandlingUnit.status.in_(LIVE))
        .order_by(m.HandlingUnit.id))
    if lock:
        stmt = stmt.with_for_update()
    return list((await db.execute(stmt)).scalars().all())


async def _balance(db: AsyncSession, key: dict, *, lock: bool = False) -> Stock | None:
    stmt = select(Stock).where(
        Stock.item_id == key["item_id"], Stock.warehouse_id == key["warehouse_id"],
        Stock.bin_id == (key["bin_id"] or 0), Stock.batch_id == (key["batch_id"] or 0),
        Stock.project_id == (key["project_id"] or 0))
    if lock:
        stmt = stmt.with_for_update()
    return (await db.execute(stmt)).scalars().first()


def _hu_out(hu: m.HandlingUnit, children: dict, floors: dict | None = None) -> dict:
    kids = children.get(hu.id, [])
    floors = floors or {}
    floor = floors.get(hu.item_packaging_id)
    return {"id": hu.id, "hu_code": hu.hu_code, "code_kind": hu.code_kind,
            "level": hu.level, "pack_name": hu.pack_name,
            "pack_size": float(hu.pack_size), "content_qty": float(held(hu)),
            "is_part": is_part(hu),
            "min_fill": float(floor) if floor is not None else None,
            "below_min": _below_floor(hu, floors),
            "is_atom": bool(hu.is_atom),
            "status": hu.status, "source_no": hu.source_no,
            "contents": [_hu_out(k, children, floors) for k in kids]}


async def lot_packs(db: AsyncSession, key: dict) -> dict:
    """One stock row, pack by pack — what the repack screen draws."""
    stock = await _balance(db, key)
    if stock is None:
        raise NotFoundError("That stock row no longer exists.")
    item = await db.get(Item, key["item_id"])
    tree = await _live_tree(db, key)
    children: dict[int, list] = {}
    for hu in tree:
        if hu.parent_id:
            children.setdefault(hu.parent_id, []).append(hu)
    top = [hu for hu in tree if hu.status == HUS.SEALED.value]
    total = _d(stock.total_qty)
    packed = sum((held(hu) for hu in top), ZERO)
    loose = max(total - packed, ZERO)
    floors = await _floors(db, {hu.item_packaging_id for hu in tree})

    found = await packs.ladders(db, [item.id])
    ladders = {lad.hierarchy_id: lad for lad in found.get(item.id, [])}
    used = {hu.pack_hierarchy_id for hu in tree}
    hierarchies = []
    for hid, lad in ladders.items():
        if lad.top == 0:
            continue
        own = [hu for hu in top if hu.pack_hierarchy_id == hid]
        atom_levels = [hu.level for hu in tree if hu.pack_hierarchy_id == hid and hu.is_atom]
        hierarchies.append({
            **packs.ladder_out(lad),
            "in_use": hid in used,
            # The smallest level a repack may choose here: a code cannot be split.
            "coded_floor": min(atom_levels) if atom_levels else 0,
            # Full packs per level; the part packs are listed one by one, because a
            # repack keeps one only where the target names what it holds.
            "top_counts": {str(level): sum(1 for hu in own
                                           if hu.level == level and not is_part(hu))
                           for level in range(1, lad.top + 1)},
            "top_parts": [{"level": hu.level, "fill": float(held(hu)),
                           "below_min": _below_floor(hu, floors)}
                          for hu in sorted(own, key=lambda h: (-h.level, h.id))
                          if is_part(hu)],
            "packs": [_hu_out(hu, children, floors) for hu in sorted(
                own, key=lambda h: (-h.level, h.id))],
        })
    warehouse = await db.get(Warehouse, key["warehouse_id"])
    summary = (await pack_summary(db, [{**key, "total_qty": total,
                                        "uom_code": item.uom_code}]))[0]
    return {
        **{k: key.get(k) for k in ("item_id", "warehouse_id", "bin_id", "batch_id",
                                   "project_id")},
        "item_code": item.code, "item_name": item.name, "uom_code": item.uom_code,
        "bin_code": stock.bin_code, "batch_no": stock.batch_no,
        "total_qty": float(total), "available_qty": float(_d(stock.available_qty)),
        "reserved_qty": float(_d(stock.reserved_qty)),
        "loose_qty": float(loose),
        "pack_text": summary["pack_text"],
        "below_min": summary["below_min"],
        "part_packs": summary["part_packs"],
        "codes_per_pack": await codes_per_pack(db, item, warehouse),
        "serialised": serialised(item),
        "hierarchies": hierarchies,
    }


# --------------------------------------------------------------------------- #
#  4. Repack
# --------------------------------------------------------------------------- #

def _planner_nodes(top: list, children: dict) -> list[packing.Node]:
    def node(hu):
        return packing.Node(id=hu.id, level=hu.level, atom=bool(hu.is_atom),
                            children=[node(k) for k in children.get(hu.id, [])],
                            content=held(hu) if is_part(hu) else None)
    return [node(hu) for hu in top]


async def _apply_plan(db: AsyncSession, *, key: dict, item, ladder: packing.Ladder,
                      plan: packing.RepackPlan, tree: list, reason: str,
                      source: tuple, user) -> list:
    """Carry out a `packing.RepackPlan` on the rows.

    Opened packs retire — status OPENED, code never reused — and whatever stood
    inside them stands on its own again. Carved packs are cut out of an opened pack
    that was shelved whole (the ten strips inside a box nobody had opened). New packs
    wrap what the plan says, and get codes of their own; the packs they wrap keep
    theirs. A new PART pack holds what the plan says it holds, straight from loose.
    Units follow their packs.
    """
    by_id = {hu.id: hu for hu in tree}
    now, who = utcnow(), getattr(user, "full_name", None)
    refs: dict = {}
    made: list[m.HandlingUnit] = []

    for pid in plan.opened:
        hu = by_id.get(pid)
        if hu is None:
            continue                       # a carved ref that was opened in turn
        hu.status, hu.parent_id = HUS.OPENED.value, None
        hu.closed_reason, hu.closed_by_name, hu.closed_at = reason[:300], who, now
        for kid in tree:
            if kid.parent_id == pid and kid.status == HUS.INSIDE.value:
                kid.status, kid.parent_id = HUS.SEALED.value, None

    for ref, level, _parent in plan.carved:
        hu = _new_pack(key=key, ladder=ladder, level=level, atom=False,
                       source=source, user=user)
        db.add(hu)
        refs[ref] = hu
        made.append(hu)
    await db.flush()

    carved_by_parent: dict = {}
    for ref, _level, parent in plan.carved:
        carved_by_parent.setdefault(parent, []).append(ref)
    level_of = {ref: level for ref, level, _parent in plan.carved}
    opened_refs = {p for p in plan.opened if isinstance(p, str)}
    for pid in plan.opened:
        if isinstance(pid, str) or pid not in by_id:
            continue
        units = list((await db.execute(
            select(m.SerialNumber.id).where(
                m.SerialNumber.handling_unit_id == pid,
                m.SerialNumber.status == SerialStatus.AVAILABLE.value)
            .order_by(m.SerialNumber.id))).scalars().all())
        if units:
            await _hand_down(db, pid, units, carved_by_parent=carved_by_parent,
                             refs=refs, level_of=level_of, opened_refs=opened_refs,
                             ladder=ladder)

    for creation in sorted(plan.created, key=lambda c: c.level):
        hu = _new_pack(key=key, ladder=ladder, level=creation.level, atom=False,
                       source=source, user=user, content=creation.fill)
        db.add(hu)
        refs[creation.ref] = hu
        made.append(hu)
    await db.flush()
    for creation in sorted(plan.created, key=lambda c: c.level):
        parent = refs[creation.ref]
        for child_ref in creation.children:
            child = refs.get(child_ref) or by_id.get(child_ref)
            if child is not None:
                child.parent_id, child.status = parent.id, HUS.INSIDE.value
        if creation.loose_units:
            take = await _loose_units(db, key, limit=int(creation.loose_units))
            await _link_units(db, take, parent.id)

    warehouse = await db.get(Warehouse, key["warehouse_id"])
    await _name_packs(db, made, item, warehouse,
                      await codes_per_pack(db, item, warehouse))
    return made


async def _hand_down(db: AsyncSession, owner, units: list[int], *, carved_by_parent: dict,
                     refs: dict, level_of: dict, opened_refs: set,
                     ladder: packing.Ladder) -> None:
    """Give an opened pack's units to the packs carved out of it, in order —
    following the chain down when a carved pack was itself opened. What is not
    handed on is loose."""
    cursor = 0
    for ref in carved_by_parent.get(owner, []):
        size = int(ladder.at(level_of[ref]).size)
        share = units[cursor:cursor + size]
        cursor += len(share)
        if not share:
            break
        if ref in opened_refs:
            await _hand_down(db, ref, share, carved_by_parent=carved_by_parent,
                             refs=refs, level_of=level_of, opened_refs=opened_refs,
                             ladder=ladder)
        elif ref in refs:
            await _link_units(db, share, refs[ref].id)
    await _link_units(db, units[cursor:], None)


def _key(data) -> dict:
    get = data.get if isinstance(data, dict) else (lambda k: getattr(data, k, None))
    return {"item_id": int(get("item_id")), "warehouse_id": int(get("warehouse_id")),
            "bin_id": int(get("bin_id") or 0), "batch_id": int(get("batch_id") or 0),
            "project_id": int(get("project_id") or 0)}


async def repack(db: AsyncSession, data, user) -> dict:
    """Change how one stock row is packed: twelve boxes into a carton, a carton back
    into its boxes, loose strips boxed.

    Never the quantity (the target must hold exactly what the row holds), never the
    hierarchy (a pack never changes family), and never below the level a code was
    minted at — a coded box may be wrapped in a carton and the carton opened again,
    but the box itself only opens at the issue desk, as a break bulk.

    Not a stock movement: `stk_balance` and `stk_ledger` are untouched (rule 7). The
    audit row is the record.
    """
    key = _key(data)
    stock = await _balance(db, key, lock=True)
    if stock is None:
        raise NotFoundError("That stock row no longer exists.")
    item = await db.get(Item, key["item_id"])
    ladder = await packs.ladder(db, item.id, data.pack_hierarchy_id)
    if ladder.top == 0:
        raise ValidationError(
            f"{item.code} has no pack levels in that hierarchy. Add them on the item "
            "master's Packaging tab first.")
    if not serialised(item):
        await reconcile_key(db, key, reason="Brought into line before a repack",
                            user=user)
    tree = await _live_tree(db, key, lock=True)
    children: dict[int, list] = {}
    for hu in tree:
        if hu.parent_id:
            children.setdefault(hu.parent_id, []).append(hu)
    top = [hu for hu in tree if hu.status == HUS.SEALED.value]
    total = _d(stock.total_qty)
    loose = total - sum((held(hu) for hu in top), ZERO)
    if loose < ZERO:
        raise ValidationError(
            "The packs recorded here hold more than the balance does. Count the "
            "location, then repack.")
    own = [hu for hu in top if hu.pack_hierarchy_id == ladder.hierarchy_id]
    try:
        target = packing.normalize(ladder, [
            e.model_dump() if hasattr(e, "model_dump") else dict(e)
            for e in data.target])
        full_counts, part_packs = packing.split_target(target)
        plan = packing.plan_repack(ladder, _planner_nodes(own, children), loose,
                                   full_counts, partial=part_packs)
        # A repack MAKES the part packs it creates, so they meet the floor. One it
        # merely keeps — a carton an issue left short — stays, still flagged.
        for creation in plan.created:
            floor = ladder.at(creation.level).min_fill
            if creation.fill is not None and floor is not None and creation.fill < floor:
                row = ladder.at(creation.level)
                raise packing.PackError(
                    f"A new {row.name} must hold at least {packing.fmt(floor)} "
                    f"{item.uom_code or 'units'}; {packing.fmt(creation.fill)} is below "
                    "that. Pack it in a smaller level, or leave it loose.")
    except packing.PackError as exc:
        raise _fail(item, exc) from exc
    if not (plan.opened or plan.created or plan.carved):
        raise ValidationError("That is already how this stock is packed.")

    before = (await pack_summary(db, [{**key, "total_qty": total,
                                       "uom_code": item.uom_code}]))[0]["pack_text"]
    reason = (getattr(data, "reason", None) or "").strip() or "Repacked on the shelf"
    made = await _apply_plan(db, key=key, item=item, ladder=ladder, plan=plan, tree=tree,
                             reason=f"Repack: {reason}",
                             source=("REPACK", stock.id, None), user=user)
    await db.flush()
    after = (await pack_summary(db, [{**key, "total_qty": total,
                                      "uom_code": item.uom_code}]))[0]["pack_text"]
    await write_audit(
        db, entity="whs_handling_units", entity_id=stock.id,
        entity_no=f"{item.code} @ {stock.bin_code or 'bulk'}",
        action=AuditAction.UPDATE, actor=user,
        before={"packing": before}, after={"packing": after, "reason": reason,
                                           "opened": len(plan.opened),
                                           "made": len(made)},
        summary=f"Repacked {item.code}: {before or 'loose'} -> {after or 'loose'}")
    await db.commit()
    logger.info("repack %s at %s: %s -> %s by %s", item.code, stock.bin_code, before,
                after, getattr(user, "full_name", "?"))
    return await lot_packs(db, key)


# --------------------------------------------------------------------------- #
#  5. The issue
# --------------------------------------------------------------------------- #

async def issue_line_packing(db: AsyncSession, *, item, line_in):
    """`(hierarchy_id, breakdown, None)` — how an issue pick is packed (2026-10-22).

    The pick's QUANTITY, in the item's base unit, is the truth: stock, unit codes and
    every guard read it, and this never changes it (the third value stays None for the
    caller that used to take the quantity from the packs). The packs only describe it
    and travel downstream: kept when they add up to the quantity, worked out again in
    the SAME hierarchy when they do not, and stated in the item's default hierarchy for
    a pick that named none. An item with no pack levels gives `(None, None, None)`.
    """
    qty = getattr(line_in, "issued_qty", None)
    if qty is None:
        qty = getattr(line_in, "requested_qty", None)
    qty = _d(qty)
    if qty <= ZERO:
        return None, None, None
    entries = [e.model_dump() if hasattr(e, "model_dump") else dict(e)
               for e in (getattr(line_in, "pack_breakdown", None) or [])]
    hierarchy_id = getattr(line_in, "pack_hierarchy_id", None)
    ladder = await packs.ladder(db, item.id, hierarchy_id)
    if ladder.top == 0:
        return None, None, None
    if entries:
        try:
            hid, out = await packs.snapshot(db, item_id=item.id, hierarchy_id=hierarchy_id,
                                            entries=entries)
            if packing.base_of(out) == qty:
                return hid, out, None
        except ValidationError:
            pass                       # stale packs: say the quantity again below
    hid, out = await packs.snapshot(db, item_id=item.id, hierarchy_id=ladder.hierarchy_id,
                                    entries=None, base_qty=qty)
    return hid, out, None


async def issue_line_packs(db: AsyncSession, wanted: dict) -> dict[int, dict]:
    """How a quantity of each issue line is packed, read back off the issue line
    (2026-10-22): `{issue_item_id: {pack_breakdown, pack_text}}`.

    The consignment, outward QC, dispatch and acknowledgement all carry an issue
    line's goods without packing columns of their own; they show the line's packs —
    the line's own when the quantity is all of it, else that quantity in whole packs
    of the SAME hierarchy, biggest first. Derived on read, so there is no copy to
    drift. A line issued loose, or an item with no packing, is left out.
    """
    ids = [int(i) for i in wanted if i]
    if not ids:
        return {}
    rows = (await db.execute(select(
        m.MaterialIssueLine.id, m.MaterialIssueLine.item_id,
        m.MaterialIssueLine.pack_hierarchy_id, m.MaterialIssueLine.pack_breakdown,
        m.MaterialIssueLine.uom_code).where(m.MaterialIssueLine.id.in_(ids)))).all()
    out: dict[int, dict] = {}
    for line_id, item_id, hierarchy_id, breakdown, uom in rows:
        if isinstance(breakdown, str):
            breakdown = json.loads(breakdown or "null")
        if not breakdown:
            continue
        qty = _d(wanted.get(line_id))
        if qty <= ZERO:
            continue
        if packing.base_of(breakdown) == qty:
            entries = breakdown
        else:
            try:
                _hid, entries = await packs.snapshot(db, item_id=item_id,
                                                     hierarchy_id=hierarchy_id,
                                                     entries=None, base_qty=qty)
            except ValidationError:      # the hierarchy has since been retired
                entries = packing.shrink_snapshot(breakdown, qty)
        out[line_id] = {"pack_breakdown": entries,
                        "pack_text": packing.describe(entries, uom)}
    return out


def merge_breakdowns(parts: list[list[dict]], uom: str | None = None) -> dict | None:
    """Several issue lines' packs, as one line's: "1 Box" + "1 Box + 5 loose" reads
    "2 Box + 5 loose". Added level by level within each hierarchy (a part pack keeps
    its fill); `None` when none of them was packed."""
    merged: dict[tuple, dict] = {}
    for entries in parts:
        for e in entries or []:
            key = (e.get("hierarchy"), int(e.get("level") or 0), str(e.get("fill") or ""))
            had = merged.get(key)
            if had:
                had["qty"] = packing.plain(_d(had["qty"]) + _d(e.get("qty")))
            else:
                merged[key] = dict(e)
    if not merged:
        return None
    out = sorted(merged.values(), key=lambda e: (str(e.get("hierarchy") or ""),
                                                 -int(e.get("level") or 0)))
    return {"pack_breakdown": out, "pack_text": packing.describe(out, uom)}


async def assert_issue_packs(db: AsyncSession, issue, units_by_line: dict, user) -> None:
    """A coded pack leaves WHOLE, unless the line says break bulk and the person
    saving it may.

    Read off the units the issue actually holds (`_issue_units_by_line`), summed
    across the WHOLE issue — two lines each taking half a box take all of it. A pack
    from which only some units are held is being opened; that is refused without
    `break_bulk` on a line that draws from it, and refused without the
    `issue.break_bulk` permission even then.
    """
    taking: dict[int, int] = {}
    lines_of: dict[int, list] = {}
    for line in issue.items:
        for unit in units_by_line.get(line.id) or []:
            if unit.handling_unit_id:
                taking[unit.handling_unit_id] = taking.get(unit.handling_unit_id, 0) + 1
                lines_of.setdefault(unit.handling_unit_id, []).append(line)
    if not taking:
        return
    atoms = (await db.execute(select(m.HandlingUnit).where(
        m.HandlingUnit.id.in_(taking), m.HandlingUnit.is_atom.is_(True),
        m.HandlingUnit.status.in_(LIVE)))).scalars().all()
    if not atoms:
        return
    held = dict((await db.execute(
        select(m.SerialNumber.handling_unit_id, func.count())
        .where(m.SerialNumber.handling_unit_id.in_([hu.id for hu in atoms]),
               m.SerialNumber.status == SerialStatus.AVAILABLE.value,
               m.SerialNumber.is_active.is_(True))
        .group_by(m.SerialNumber.handling_unit_id))).all())
    granted = None
    for hu in atoms:
        whole, took = int(held.get(hu.id, 0)), taking.get(hu.id, 0)
        if took >= whole:
            continue
        line = lines_of[hu.id][0]
        if not any(getattr(l, "break_bulk", False) for l in lines_of[hu.id]):
            raise ValidationError(
                f"{line.item_code or line.item_name}: {hu.pack_name} {hu.hu_code} holds "
                f"{whole} and this issue takes {took} of them. A coded {hu.pack_name} "
                f"leaves whole — issue the whole {hu.pack_name}, or tick \"Break bulk\" "
                f"on the line to open it (needs the Break bulk permission).")
        if granted is None:
            from app.platform.rbac.service import get_user_permissions
            granted = await get_user_permissions(db, user)
        if perms.ISSUE_BREAK_BULK not in granted:
            raise ValidationError(
                f"Opening {hu.pack_name} {hu.hu_code} is a break bulk: its code retires "
                "and what stays behind is given new ones. That needs the Break bulk "
                "permission (issue.break_bulk) — ask whoever manages job profiles.")


async def _repack_remainder(db: AsyncSession, hu: m.HandlingUnit, unit_ids: list[int], *,
                            source: tuple, user) -> list:
    """What stays behind in an opened pack, packed again as whole smaller packs —
    each a new ATOM with a new code when the opened pack was one — and the rest
    loose. The opened pack's code is never reused."""
    ladder = await packs.ladder(db, hu.item_id, hu.pack_hierarchy_id)
    key = {"item_id": hu.item_id, "warehouse_id": hu.warehouse_id, "bin_id": hu.bin_id,
           "batch_id": hu.batch_id, "project_id": hu.project_id}
    level = min(max(hu.level - 1, 0), ladder.top)
    entries = packing.greedy(ladder, len(unit_ids), max_level=level) if level else []
    made: list[m.HandlingUnit] = []
    for e in sorted(entries, key=lambda x: int(x["level"])):
        if int(e["level"]) == 0:
            continue
        for _ in range(int(_d(e["qty"]))):
            new = _new_pack(key=key, ladder=ladder, level=int(e["level"]),
                            atom=bool(hu.is_atom), source=source, lot_no=hu.lot_no,
                            user=user)
            db.add(new)
            made.append(new)
    await db.flush()
    warehouse = await db.get(Warehouse, hu.warehouse_id)
    item = await db.get(Item, hu.item_id)
    await _name_packs(db, made, item, warehouse, bool(hu.is_atom))
    loose = int(_d(next((e["qty"] for e in entries if int(e["level"]) == 0), 0))) \
        if entries else len(unit_ids)
    await _link_units(db, unit_ids[:loose], None)
    cursor = loose
    for new in made:
        size = int(_d(new.pack_size))
        await _link_units(db, unit_ids[cursor:cursor + size], new.id)
        cursor += size
    return made


def _close(hu, status: str, reason: str, who, now) -> None:
    hu.status, hu.closed_reason = status, reason[:300]
    hu.closed_by_name, hu.closed_at, hu.parent_id = who, now, None


def _consume(hu, children: dict, reason: str, who, now) -> None:
    """A pack and everything inside it have all left."""
    for kid in children.get(hu.id, []):
        if kid.status in LIVE:
            _consume(kid, children, reason, who, now)
    _close(hu, HUS.CONSUMED.value, reason, who, now)


def _take_inside(hu, qty: Decimal, children: dict, reason: str, who, now) -> None:
    """Take `qty` (less than it holds) out of one pack, which STAYS the pack it was
    (2026-10-11). What sits loose inside it goes first, then the packs inside it —
    part ones first, then the smallest — each shrinking the same way."""
    kids = [k for k in children.get(hu.id, []) if k.status in LIVE]
    direct = held(hu) - sum((held(k) for k in kids), ZERO)
    rest = qty - min(max(direct, ZERO), qty)
    for kid in sorted(kids, key=lambda k: (not is_part(k), held(k), -k.id)):
        if rest <= ZERO:
            break
        part = min(rest, held(kid))
        if part >= held(kid):
            _consume(kid, children, reason, who, now)
        else:
            _take_inside(kid, part, children, reason, who, now)
        rest -= part
    _set_held(hu, held(hu) - qty)


async def _shrink_ancestors(db: AsyncSession, parent_id: int | None, qty: Decimal, *,
                            reason: str, who, now) -> None:
    """Every pack around a pack that lost `qty` lost it too — it still stands, holding
    that much less, and is consumed only once nothing at all is left inside."""
    while parent_id:
        parent = (await db.execute(select(m.HandlingUnit).where(
            m.HandlingUnit.id == parent_id).with_for_update())).scalars().first()
        if parent is None or parent.status not in LIVE:
            return
        next_id = parent.parent_id
        left = held(parent) - qty
        if left <= ZERO:
            _close(parent, HUS.CONSUMED.value, reason, who, now)
        else:
            _set_held(parent, left)
        parent_id = next_id


async def settle_issue(db: AsyncSession, issue, units_by_line: dict, user) -> None:
    """After an issue is posted, make the packs say what is left on the shelf.

    Unit-backed lines (serials, IMEIs, coded units) settle EXACTLY off the units that
    left. A plain pack partly taken STAYS the pack it was, holding that much less
    (2026-10-11) — "1 Carton (350 of 500)" — and so does every pack around it; one
    that falls under its level's minimum is flagged for a repack, never broken up on
    its own. A pack whose every unit went is CONSUMED.

    A CODED pack (an atom) is the exception and keeps its rule: its code names
    everything inside it, so a partly taken one is OPENED (a break bulk, authorised
    at save), what stays behind is packed again as smaller whole packs under new codes,
    and every pack around it opens. Lines with no unit rows settle by quantity
    (`reconcile_key`), taking from the packs the line named first.
    """
    now, who = utcnow(), getattr(user, "full_name", None)
    source = ("BREAK_BULK", issue.id, getattr(issue, "issue_no", None))
    reason = f"Issued on {issue.issue_no}"
    took: dict[int, int] = {}
    for line in issue.items:
        for unit in units_by_line.get(line.id) or []:
            if unit.handling_unit_id:
                took[unit.handling_unit_id] = took.get(unit.handling_unit_id, 0) + 1
    reconcile_after = [line for line in issue.items if _d(line.issued_qty) > ZERO]
    atom_ancestors: set[int] = set()
    for hu_id in sorted(took):
        hu = (await db.execute(select(m.HandlingUnit).where(
            m.HandlingUnit.id == hu_id).with_for_update())).scalars().first()
        if hu is None or hu.status not in LIVE:
            continue
        remaining = list((await db.execute(
            select(m.SerialNumber.id).where(
                m.SerialNumber.handling_unit_id == hu.id,
                m.SerialNumber.status == SerialStatus.AVAILABLE.value,
                m.SerialNumber.is_active.is_(True))
            .order_by(m.SerialNumber.id))).scalars().all())
        if hu.is_atom:
            if hu.parent_id:
                atom_ancestors.add(hu.parent_id)
            if not remaining:
                _close(hu, HUS.CONSUMED.value, reason, who, now)
            else:
                _close(hu, HUS.OPENED.value, f"Break bulk on {issue.issue_no}", who, now)
                await _repack_remainder(db, hu, remaining, source=source, user=user)
            continue
        taken = _d(took[hu_id])
        live_kids = await db.scalar(select(func.count()).select_from(m.HandlingUnit).where(
            m.HandlingUnit.parent_id == hu.id, m.HandlingUnit.status.in_(LIVE)))
        parent_id = hu.parent_id
        left = held(hu) - taken
        if not live_kids:
            left = max(left, _d(len(remaining)))
        if left <= ZERO and not live_kids:
            _close(hu, HUS.CONSUMED.value, reason, who, now)
        else:
            _set_held(hu, left)
        await _shrink_ancestors(db, parent_id, taken, reason=reason, who=who, now=now)
    await _settle_ancestors(db, atom_ancestors, reason=f"Opened on {issue.issue_no}",
                            user=user)
    await db.flush()
    # Then by quantity, for every row a line drew on. A no-op where the units settled
    # the packs exactly; where they could not — an untracked item has no units, and a
    # unit that arrived at an MDP or LIP was never linked to the pack it came in — this
    # is what keeps the packs from claiming stock that has left.
    for line in reconcile_after:
        for project_id in {getattr(issue, "project_id", None) or 0, 0}:
            await reconcile_key(db, {
                "item_id": line.item_id, "warehouse_id": issue.warehouse_id,
                "bin_id": line.bin_id or 0, "batch_id": line.batch_id or 0,
                "project_id": project_id},
                prefer=getattr(line, "pack_breakdown", None),
                reason=reason, user=user)


async def _settle_ancestors(db: AsyncSession, start: set[int], *, reason: str, user) -> None:
    """Every pack around a broken CODED pack no longer holds what its code says: it
    opens, and what is still inside stands on its own — or, if nothing is, it is
    consumed. Innermost first, so a carton is judged after the boxes inside it."""
    now, who = utcnow(), getattr(user, "full_name", None)
    queue = set(start)
    seen: set[int] = set()
    while queue:
        rows = (await db.execute(select(m.HandlingUnit).where(
            m.HandlingUnit.id.in_(queue)).with_for_update())).scalars().all()
        seen |= queue
        queue = set()
        for hu in sorted(rows, key=lambda h: h.level):
            if hu.status not in LIVE:
                continue
            kids = (await db.execute(select(m.HandlingUnit).where(
                m.HandlingUnit.parent_id == hu.id,
                m.HandlingUnit.status.in_(LIVE)))).scalars().all()
            direct = await db.scalar(select(func.count()).select_from(m.SerialNumber).where(
                m.SerialNumber.handling_unit_id == hu.id,
                m.SerialNumber.status == SerialStatus.AVAILABLE.value))
            hu.status = (HUS.OPENED if (kids or direct) else HUS.CONSUMED).value
            hu.closed_reason, hu.closed_by_name, hu.closed_at = reason[:300], who, now
            for kid in kids:
                kid.status, kid.parent_id = HUS.SEALED.value, None
            if hu.parent_id and hu.parent_id not in seen:
                queue.add(hu.parent_id)
            hu.parent_id = None


async def reconcile_key(db: AsyncSession, key: dict, *, prefer=None, reason: str,
                        user) -> None:
    """Make the packs at one stock row hold no more than the balance — for stock
    that left by quantity alone (an untracked item's issue, an adjustment).

    The packs the caller names (`prefer`, the issue line's breakdown) go first; then
    part packs, then the smallest. A pack bigger than what is left to take is NOT
    broken up (2026-10-11): it stays the pack it was, holding that much less, and is
    flagged for a repack if that puts it under its level's minimum. Never touches an
    item whose units carry identities — those settle off the units (`settle_issue`).
    """
    stock = await _balance(db, key)
    total = _d(stock.total_qty) if stock is not None else ZERO
    tree = await _live_tree(db, key, lock=True)
    top = [hu for hu in tree if hu.status == HUS.SEALED.value]
    excess = sum((held(hu) for hu in top), ZERO) - total
    if excess <= ZERO:
        return
    children: dict[int, list] = {}
    for hu in tree:
        if hu.parent_id:
            children.setdefault(hu.parent_id, []).append(hu)
    want = {int(e.get("level") or 0): int(_d(e.get("qty")))
            for e in (prefer or []) if int(e.get("level") or 0)}
    now, who = utcnow(), getattr(user, "full_name", None)
    guard = 0
    while excess > ZERO and top and guard < MAX_PACKS_PER_REQUEST:
        guard += 1
        top.sort(key=lambda h: (want.get(h.level, 0) <= 0, not is_part(h), held(h), -h.id))
        hu = top.pop(0)
        take = min(excess, held(hu))
        if take >= held(hu):
            _consume(hu, children, reason, who, now)
            if want.get(hu.level):
                want[hu.level] -= 1
        else:
            _take_inside(hu, take, children, reason, who, now)
        excess -= take
    await db.flush()


# --------------------------------------------------------------------------- #
#  6. Entry points, by stock row
# --------------------------------------------------------------------------- #

def _stock_key(stock: Stock) -> dict:
    return {"item_id": stock.item_id, "warehouse_id": stock.warehouse_id,
            "bin_id": stock.bin_id or 0, "batch_id": stock.batch_id or 0,
            "project_id": stock.project_id or 0}


async def summary_for_stock(db: AsyncSession, stock_ids: list[int]) -> list[dict]:
    """The packing of each `stk_balance` row a screen is showing, in two queries.
    The quantity is read here, never taken from the client."""
    if not stock_ids:
        return []
    rows = (await db.execute(select(Stock).where(Stock.id.in_(stock_ids)))).scalars().all()
    keys = [{**_stock_key(r), "total_qty": r.total_qty, "uom_code": r.uom_code,
             "stock_id": r.id} for r in rows]
    out = await pack_summary(db, keys)
    for key, row in zip(keys, out):
        row["stock_id"] = key["stock_id"]
    return out


async def lot_packs_by_stock(db: AsyncSession, stock_id: int) -> dict:
    stock = await db.get(Stock, stock_id)
    if stock is None:
        raise NotFoundError("That stock row no longer exists.")
    return {"stock_id": stock.id, **await lot_packs(db, _stock_key(stock))}


async def repack_stock(db: AsyncSession, stock_id: int, data, user) -> dict:
    stock = await db.get(Stock, stock_id)
    if stock is None:
        raise NotFoundError("That stock row no longer exists.")

    request = SimpleNamespace(**_stock_key(stock), pack_hierarchy_id=data.pack_hierarchy_id,
                              target=data.target, reason=data.reason)
    return {"stock_id": stock.id, **await repack(db, request, user)}


async def pack_by_code(db: AsyncSession, code: str) -> dict:
    """A scanned pack code: the pack, and every unit inside it at any depth — so the
    issue screen can tick a whole carton with one scan."""
    hu = (await db.execute(select(m.HandlingUnit).where(
        m.HandlingUnit.hu_code == (code or "").strip()))).scalars().first()
    if hu is None:
        raise NotFoundError(f"No pack carries the code {code!r}.")
    ids, frontier = [hu.id], [hu.id]
    while frontier:
        frontier = list((await db.execute(select(m.HandlingUnit.id).where(
            m.HandlingUnit.parent_id.in_(frontier),
            m.HandlingUnit.status.in_(LIVE)))).scalars().all())
        ids.extend(frontier)
    units = (await db.execute(
        select(m.SerialNumber.serial_number, m.SerialNumber.imei,
               m.SerialNumber.asset_code, m.SerialNumber.consumable_code)
        .where(m.SerialNumber.handling_unit_id.in_(ids),
               m.SerialNumber.status == SerialStatus.AVAILABLE.value,
               m.SerialNumber.is_active.is_(True))
        .order_by(m.SerialNumber.id))).all()
    return {
        "id": hu.id, "hu_code": hu.hu_code, "status": hu.status,
        "item_id": hu.item_id, "warehouse_id": hu.warehouse_id, "bin_id": hu.bin_id,
        "batch_id": hu.batch_id, "level": hu.level, "pack_name": hu.pack_name,
        "pack_size": float(hu.pack_size), "content_qty": float(held(hu)),
        "is_atom": bool(hu.is_atom),
        "units": [{"serial_number": u[0], "imei": u[1],
                   "code": u[2] or u[3] or u[0]} for u in units],
    }


async def reserve_named_packs(db: AsyncSession, *, warehouse_id: int, line, marker: str,
                              claimed_prefixes: tuple) -> int:
    """Stamp the units of the packs an issue line NAMES, before codes are auto-filled.

    A line issued as "1 Box" must take a box. The automatic top-up reads loose units
    first and then pack by pack in id order, so on a shelf holding strips as well as
    boxes it would fill "1 Box" with ten strips' worth of units — whole packs, so no
    guard objects, and the storekeeper walks to the box while the document names
    strips. Here, for each level the line names, that many outermost packs of that
    level (sealed, at the line's own batch and location) have their free units stamped
    with the line's marker; `_claim_units` counts its own marker first, so the top-up
    only covers what the named packs do not. Loose entries are left to the top-up,
    which takes loose units first anyway. Returns how many units were stamped.
    """
    entries = [e for e in (getattr(line, "pack_breakdown", None) or [])
               if int(e.get("level") or 0) > 0]
    if not entries:
        return 0
    stmt = select(m.HandlingUnit).where(
        m.HandlingUnit.item_id == line.item_id,
        m.HandlingUnit.warehouse_id == warehouse_id,
        m.HandlingUnit.status == HUS.SEALED.value)
    if line.bin_id:
        stmt = stmt.where(m.HandlingUnit.bin_id == line.bin_id)
    if line.batch_id:
        stmt = stmt.where(m.HandlingUnit.batch_id == line.batch_id)
    standing = (await db.execute(stmt.order_by(m.HandlingUnit.id))).scalars().all()
    chosen: list[int] = []
    for e in entries:
        want = int(_d(e.get("qty")))
        # A part pack named on the line ("1 Carton (350 of 500)") is THAT carton:
        # the packs holding what the entry says come first, then part packs, so a
        # short carton is the one picked before a full one is broken into.
        candidates = sorted(
            (hu for hu in standing if hu.level == int(e["level"]) and hu.id not in chosen),
            key=lambda hu: (held(hu) != packing.held(e), not is_part(hu), hu.id))
        chosen += [hu.id for hu in candidates][:want]
    if not chosen:
        return 0
    # Every pack inside the chosen ones, at any depth.
    ids, frontier = list(chosen), list(chosen)
    while frontier:
        frontier = list((await db.execute(select(m.HandlingUnit.id).where(
            m.HandlingUnit.parent_id.in_(frontier),
            m.HandlingUnit.status.in_(LIVE)))).scalars().all())
        ids += frontier
    rows = (await db.execute(
        select(m.SerialNumber.id, m.SerialNumber.remarks).where(
            m.SerialNumber.handling_unit_id.in_(ids),
            m.SerialNumber.status == SerialStatus.AVAILABLE.value,
            m.SerialNumber.is_active.is_(True))
        .order_by(m.SerialNumber.id).with_for_update())).all()
    take = [row[0] for row in rows
            if row[1] is None or row[1] == marker
            or not any(row[1].startswith(p) for p in claimed_prefixes)]
    take = take[:int(_d(line.issued_qty))]
    if take:
        await db.execute(update(m.SerialNumber).where(m.SerialNumber.id.in_(take))
                         .values(remarks=marker))
    return len(take)
