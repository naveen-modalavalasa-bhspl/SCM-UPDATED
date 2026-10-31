"""Stock audit write-offs: what a shortfall takes off the shelf, by code (2026-10-31).

A stock audit only ever TAKES stock off (`inventory.service.AUDIT_REASONS`). When the
lot a line names carries identities, the write-off must name them — exactly as many as
the shortfall — so the units and packs the issue desk is offered stay the units and
packs actually on the shelf. Each lot is in one of three modes:

  UNITS     a serial / IMEI item whose lot holds recorded units: exactly N serials or
            IMEIs, picked by hand. The packs around them shrink by one per unit.
  CODES     an asset / consumable item whose lot carries codes: whole packs (carton,
            box, strip — any level the item's ladder made at putaway) plus single unit
            codes for whatever is smaller than a pack, totalling exactly N. A pack
            written off takes everything inside it; the packs around it shrink.
  QUANTITY  a lot carrying no identities: the count alone, and any packs are trimmed
            to the balance by `packing.reconcile_key`.

The mode is per LOT, not per item, for the reason `_lot_has_units` gives: one item can
hold coded stock beside stock that never had a code recorded, and demanding codes from
a lot that has none asks for something that does not exist.

Inventory owns the audit and calls in through two hooks (rule 5): `validate_write_off`
when the audit is RAISED, so a wrong pick never reaches an approver's queue, and
`write_off` when it POSTS, inside the posting transaction — the codes go with the stock
or the posting does not happen. Both resolve the picks through `_resolve`, so the two
can never disagree about what a pick means.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, PermissionError_, ValidationError
from app.modules.inventory.models import Stock
from app.modules.inventory.service import warehouse_ids_for_user
from app.modules.warehouse import box_codes
from app.modules.warehouse import models as m
from app.modules.warehouse import packing as wh_packing
from app.modules.warehouse.enums import (
    LIVE_HANDLING_UNIT_STATUSES as LIVE, HandlingUnitStatus as HUS, SerialStatus,
)
from app.shared.masters import combinations, packs
from app.shared.models.base import utcnow
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse

ZERO = Decimal("0")
ONE = Decimal("1")

MODE_UNITS = "UNITS"
MODE_CODES = "CODES"
MODE_QUANTITY = "QUANTITY"

#: The most units one lot's picker is served. The same ceiling as one request's serial
#: budget (`shared.limits`): a write-off naming more than that could not be submitted
#: anyway, and the list says when it was cut.
MAX_UNITS_SERVED = 5000

HU = m.HandlingUnit
SN = m.SerialNumber


def _d(value) -> Decimal:
    return Decimal(str(value or 0))


def _fmt(qty: Decimal) -> str:
    return f"{qty.normalize():f}" if qty == qty.to_integral_value() else f"{qty:g}"


# --------------------------------------------------------------------------- #
#  The lot
# --------------------------------------------------------------------------- #

def _key(item_id: int, warehouse_id: int, batch_id, bin_id) -> dict:
    return {"item_id": int(item_id), "warehouse_id": int(warehouse_id),
            "batch_id": int(batch_id or 0), "bin_id": int(bin_id or 0)}


def _units_in(stmt, key: dict):
    """Available units of one lot. A unit stores "no batch / no location" as NULL where
    a pack and a balance row store 0, so both read as the same lot."""
    return stmt.where(
        SN.item_id == key["item_id"], SN.warehouse_id == key["warehouse_id"],
        func.coalesce(SN.batch_id, 0) == key["batch_id"],
        func.coalesce(SN.bin_id, 0) == key["bin_id"],
        SN.status == SerialStatus.AVAILABLE.value, SN.is_active.is_(True))


def _packs_in(stmt, key: dict):
    """Live packs of one lot that still hold something — an empty shell is not a pack
    anybody can count off a shelf (2026-10-28)."""
    return stmt.where(
        HU.item_id == key["item_id"], HU.warehouse_id == key["warehouse_id"],
        HU.batch_id == key["batch_id"], HU.bin_id == key["bin_id"],
        HU.status.in_(LIVE), or_(HU.content_qty.is_(None), HU.content_qty > 0))


async def _combos_at(db: AsyncSession, key: dict) -> int:
    """How many brand / variant / model balances stand at this batch and location.
    More than one is a MIXED lot: its units and packs (which carry no brand) are one
    shared pool, and the balance-based pack trim cannot tell the brands apart."""
    total = func.sum(Stock.total_qty)
    rows = (await db.execute(
        select(Stock.brand_id, Stock.variant_id, Stock.model_id)
        .where(Stock.item_id == key["item_id"], Stock.warehouse_id == key["warehouse_id"],
               Stock.batch_id == key["batch_id"], Stock.bin_id == key["bin_id"])
        .group_by(Stock.brand_id, Stock.variant_id, Stock.model_id)
        .having(total > 0))).all()
    return len(rows)


def _identified(item) -> bool:
    return bool(getattr(item, "is_serial_tracked", False)
                or getattr(item, "is_imei_tracked", False))


async def lot_mode(db: AsyncSession, item, key: dict) -> str:
    """UNITS, CODES or QUANTITY for one lot — bounded EXISTS probes, never a COUNT."""
    has_units = await db.scalar(_units_in(select(SN.id), key).limit(1)) is not None
    if has_units:
        return MODE_UNITS if _identified(item) else MODE_CODES
    # A box-only lot (2026-10-26/27): an item issued in containers whose stock was coded
    # before units were — the packs ARE its codes, and there is nothing else to name.
    if (not _identified(item) and await packs.issues_in_containers(db, item.id)
            and await db.scalar(_packs_in(select(HU.id), key).limit(1)) is not None):
        return MODE_CODES
    return MODE_QUANTITY


def _tracking(item, mode: str) -> str:
    if mode == MODE_QUANTITY:
        return "NONE"
    if getattr(item, "is_serial_tracked", False):
        return "SERIAL"
    if getattr(item, "is_imei_tracked", False):
        return "IMEI"
    return "ASSET" if getattr(item, "is_asset", False) else "CONSUMABLE"


def _unit_code(unit, item) -> str:
    """The code a storekeeper reads off this unit for this item."""
    if getattr(item, "is_serial_tracked", False):
        return unit.serial_number
    if getattr(item, "is_imei_tracked", False):
        return unit.imei or unit.serial_number
    return unit.asset_code or unit.consumable_code or unit.serial_number


def _unit_keys(unit) -> set[str]:
    return {c for c in (unit.serial_number, unit.imei, unit.asset_code,
                        unit.consumable_code) if c}


def _unit_holder(unit) -> str | None:
    """The document holding this unit, if one does (its remarks say so)."""
    from app.modules.warehouse.service import _CLAIMED_REMARK_PREFIXES
    remarks = unit.remarks or ""
    return remarks if any(remarks.startswith(p) for p in _CLAIMED_REMARK_PREFIXES) else None


async def _lot_packs(db: AsyncSession, key: dict, *, lock: bool = False) -> dict[int, object]:
    stmt = _packs_in(select(HU), key).order_by(HU.id)
    if lock:
        stmt = stmt.with_for_update()
    return {hu.id: hu for hu in (await db.execute(stmt)).scalars().all()}


async def _held_unit_packs(db: AsyncSession, key: dict) -> set[int]:
    """The packs that directly hold a unit some document has claimed."""
    from app.modules.warehouse.service import _CLAIMED_REMARK_PREFIXES
    stmt = _units_in(select(SN.handling_unit_id), key).where(
        SN.handling_unit_id.is_not(None),
        or_(*(SN.remarks.like(f"{p}%") for p in _CLAIMED_REMARK_PREFIXES)))
    return {hid for hid in (await db.execute(stmt)).scalars().all() if hid}


def _blocked(lot_packs: dict, held_unit_packs: set[int]) -> set[int]:
    """Packs that cannot be written off whole: held by a document themselves, or with
    anything inside them that is. Writing those off would leave the document naming
    goods that no longer exist, and it would fail when it posts."""
    blocked: set[int] = set()
    seeds = {hu.id for hu in lot_packs.values() if hu.held_by} | set(held_unit_packs)
    for hid in seeds:
        while hid and hid not in blocked:
            blocked.add(hid)
            parent = lot_packs.get(hid)
            hid = parent.parent_id if parent is not None else None
    return blocked


def _chain(hid, lot_packs: dict):
    """Every pack from `hid` outwards, `hid` included."""
    while hid:
        yield hid
        hu = lot_packs.get(hid)
        hid = hu.parent_id if hu is not None else None


# --------------------------------------------------------------------------- #
#  Resolving a pick — one definition for the raise and the post
# --------------------------------------------------------------------------- #

@dataclass
class _Picks:
    packs: list
    units: list
    total: Decimal


async def _resolve(db: AsyncSession, item, key: dict, codes, mode: str, *,
                   lock: bool = False) -> _Picks:
    """What the picked codes name, checked against the lot as it stands.

    Refuses a code picked twice, a code that is not an available unit (or, on a CODES
    lot, a live pack) of this lot, a unit picked twice through two of its codes, a pick
    some document already holds, and a unit or pack picked as well as a pack around it
    — that is the same goods counted twice.
    """
    codes = [str(c).strip() for c in (codes or []) if str(c).strip()]
    twice = sorted({c for c in codes if codes.count(c) > 1})
    if twice:
        raise ValidationError(f"{item.code}: {', '.join(twice[:3])} is picked twice.")
    if mode == MODE_QUANTITY:
        if codes:
            raise ValidationError(
                f"{item.code}: this batch and location carries no codes — write it off "
                "by the count alone.")
        return _Picks([], [], ZERO)
    if not codes:
        return _Picks([], [], ZERO)

    wanted = set(codes)
    lot_packs = await _lot_packs(db, key, lock=lock)
    by_code = {hu.hu_code: hu for hu in lot_packs.values()}
    picked_packs = ({c: by_code[c] for c in wanted if c in by_code}
                    if mode == MODE_CODES else {})

    rest = wanted - set(picked_packs)
    units_by_code: dict[str, object] = {}
    if rest:
        stmt = _units_in(select(SN), key).where(or_(
            SN.serial_number.in_(rest), SN.imei.in_(rest),
            SN.asset_code.in_(rest), SN.consumable_code.in_(rest)))
        if lock:
            stmt = stmt.with_for_update()
        for unit in (await db.execute(stmt)).scalars().all():
            for code in _unit_keys(unit) & rest:
                units_by_code[code] = unit

    unknown = [c for c in codes if c not in picked_packs and c not in units_by_code]
    if unknown:
        what = ("serials / IMEIs" if mode == MODE_UNITS else "packs or unit codes")
        if mode == MODE_UNITS and any(c in by_code for c in unknown):
            raise ValidationError(
                f"{item.code}: {next(c for c in unknown if c in by_code)} is a pack. A "
                "serial-tracked shortfall names each unit — pick its serials one by one.")
        raise ValidationError(
            f"{item.code}: {len(unknown)} picked code(s) are not available {what} of "
            f"this item at this batch and location (e.g. {', '.join(unknown[:3])}).")

    units = list({u.id: u for u in units_by_code.values()}.values())
    if len(units) < len(units_by_code):
        raise ValidationError(
            f"{item.code}: the same unit is picked by two of its codes. Pick each unit once.")

    held = [hu.hu_code for hu in picked_packs.values() if hu.held_by]
    held += [_unit_code(u, item) for u in units if _unit_holder(u)]
    blocked = _blocked(lot_packs, await _held_unit_packs(db, key))
    held += [hu.hu_code for hu in picked_packs.values()
             if hu.id in blocked and not hu.held_by]
    if held:
        raise ValidationError(
            f"{item.code}: {', '.join(held[:3])} {'is' if len(held) == 1 else 'are'} held "
            "by an open document. Release it there first, or pick something else.")

    picked_ids = {hu.id for hu in picked_packs.values()}
    for hu in picked_packs.values():
        if any(a in picked_ids for a in _chain(hu.parent_id, lot_packs)):
            raise ValidationError(
                f"{item.code}: {hu.hu_code} sits inside another pack you picked — the "
                "outer pack already takes it.")
    for unit in units:
        if unit.handling_unit_id and any(
                a in picked_ids for a in _chain(unit.handling_unit_id, lot_packs)):
            raise ValidationError(
                f"{item.code}: {_unit_code(unit, item)} sits inside a pack you picked — "
                "the pack already takes it.")

    total = sum((wh_packing.held(hu) for hu in picked_packs.values()), ZERO) + len(units)
    return _Picks(list(picked_packs.values()), units, total)


def _noun(mode: str, item, qty: Decimal) -> str:
    if mode == MODE_UNITS:
        return "IMEIs" if (getattr(item, "is_imei_tracked", False)
                           and not getattr(item, "is_serial_tracked", False)) else "serials"
    return "units in packs and codes"


# --------------------------------------------------------------------------- #
#  The hooks inventory calls
# --------------------------------------------------------------------------- #

async def validate_write_off(db: AsyncSession, warehouse_id: int, line, qty) -> None:
    """`inventory.hooks.ON_ADJUSTMENT_VALIDATE`: refuse the audit unless the codes on
    this write-off line cover the shortfall EXACTLY — never fewer (stock leaves while
    its codes stay "available"), never more (codes retire for stock that is still
    there), and never on a lot that carries none."""
    item = await db.get(Item, line.item_id)
    if item is None:
        raise NotFoundError(f"Item {line.item_id} not found")
    key = _key(line.item_id, warehouse_id, line.batch_id, line.bin_id)
    mode = await lot_mode(db, item, key)
    qty = _d(qty)
    picks = await _resolve(db, item, key, line.serial_numbers, mode)
    if mode == MODE_QUANTITY:
        return
    if mode == MODE_UNITS and qty != qty.to_integral_value():
        raise ValidationError(
            f"{item.code}: a serial-tracked shortfall is a whole number of units, "
            f"not {_fmt(qty)}.")
    if not picks.units and not picks.packs:
        raise ValidationError(
            f"{item.code}: this batch and location is coded. Pick the {_fmt(qty)} "
            f"{_noun(mode, item, qty)} the shortfall takes off.")
    if picks.total != qty:
        raise ValidationError(
            f"{item.code}: the shortfall is {_fmt(qty)}, but the codes picked cover "
            f"{_fmt(picks.total)}. Pick exactly {_fmt(qty)}.")


async def write_off(db: AsyncSession, adjustment, adj_item, user) -> None:
    """`inventory.hooks.ON_ADJUSTMENT_OUT`: retire what an approved write-off named.

    Runs after the OUT movement, inside the posting transaction. The picks are resolved
    again UNDER LOCK, because approval can take days: a unit issued meanwhile is no
    longer this audit's to write off, and the posting stops and says so rather than
    retiring a code that left on somebody else's document.
    """
    qty = _d(adj_item.quantity)
    if qty <= ZERO:
        return
    item = await db.get(Item, adj_item.item_id)
    if item is None:
        return
    key = _key(adj_item.item_id, adjustment.warehouse_id, adj_item.batch_id, adj_item.bin_id)
    reason = f"Written off by {adjustment.adjustment_no}"
    who, now = getattr(user, "full_name", None), utcnow()
    mode = await lot_mode(db, item, key)
    codes = list(adj_item.serial_numbers or [])

    if mode != MODE_QUANTITY and codes:
        picks = await _resolve(db, item, key, codes, mode, lock=True)
        if picks.total != qty:
            raise ValidationError(
                f"{adjustment.adjustment_no} · {item.code}: the codes it names now cover "
                f"{_fmt(picks.total)} of the {_fmt(qty)} it writes off — the shelf changed "
                "since it was raised. Reject it and count again.")
        await _retire(db, picks, reason=reason, who=who, now=now)
    elif mode != MODE_QUANTITY:
        # An audit raised before codes were demanded (2026-10-31) names none: the
        # oldest free units go, as they always did, and their packs shrink around them.
        rows = (await db.execute(_units_in(select(SN), key)
                                 .order_by(SN.id).with_for_update())).scalars().all()
        free = [u for u in rows if not _unit_holder(u)][:int(qty)]
        if free:
            await _retire(db, _Picks([], free, Decimal(len(free))),
                          reason=reason, who=who, now=now)

    # Whatever left by quantity alone — an uncoded lot, a box-only lot from an old
    # audit, packs a unit was never linked to — the packs are trimmed to the balance.
    # Not on a lot holding more than one brand (2026-10-31): `reconcile_key` reads ONE
    # balance row of the lot, so it would measure the packs against a single brand's
    # stock and trim packs the other brand still fills.
    if await _combos_at(db, key) <= 1:
        for project_id in {int(adj_item.project_id or 0), 0}:
            await wh_packing.reconcile_key(db, {**key, "project_id": project_id},
                                           reason=reason, user=user)
    await box_codes._close_empty_shells(
        db, item_id=key["item_id"], warehouse_id=key["warehouse_id"],
        reason=reason, who=who, now=now)


async def _retire(db: AsyncSession, picks: _Picks, *, reason: str, who, now) -> None:
    """Scrap the units, consume the packs, and shrink every pack around them."""
    from app.modules.warehouse.service import _set_unit_fields

    unit_ids = [u.id for u in picks.units]
    if picks.packs:
        children = await box_codes._children(db, picks.packs)
        tree = [i for hu in picks.packs for i in box_codes._tree_ids(hu, children)]
        unit_ids += list((await db.execute(select(SN.id).where(
            SN.handling_unit_id.in_(tree or [0]),
            SN.status == SerialStatus.AVAILABLE.value,
            SN.is_active.is_(True)))).scalars().all())
        for hu in picks.packs:
            parent_id, lost = hu.parent_id, wh_packing.held(hu)
            wh_packing._consume(hu, children, reason, who, now)
            await wh_packing._shrink_ancestors(db, parent_id, lost,
                                               reason=reason, who=who, now=now)
    for unit in picks.units:
        if not unit.handling_unit_id:
            continue
        hu = (await db.execute(select(HU).where(HU.id == unit.handling_unit_id)
                               .with_for_update())).scalars().first()
        if hu is None or hu.status not in LIVE:
            continue
        parent_id, left = hu.parent_id, wh_packing.held(hu) - ONE
        if left <= ZERO:
            wh_packing._close(hu, HUS.CONSUMED.value, reason, who, now)
        else:
            wh_packing._set_held(hu, left)
        await wh_packing._shrink_ancestors(db, parent_id, ONE,
                                           reason=reason, who=who, now=now)
    if unit_ids:
        await _set_unit_fields(db, list(dict.fromkeys(unit_ids)),
                               status=SerialStatus.SCRAPPED.value, is_active=False,
                               remarks=reason[:500])


# --------------------------------------------------------------------------- #
#  What the audit form reads
# --------------------------------------------------------------------------- #

async def _visible(db: AsyncSession, warehouse_id: int, user) -> Warehouse:
    warehouse = await db.get(Warehouse, warehouse_id)
    if warehouse is None:
        raise NotFoundError(f"Warehouse {warehouse_id} not found")
    allowed = await warehouse_ids_for_user(db, user)
    if allowed is not None and warehouse_id not in allowed:
        raise PermissionError_(f"{warehouse.name} is outside the stock you can see")
    return warehouse


async def audit_items(db: AsyncSession, warehouse_id: int, user, *,
                      search: str | None = None) -> list[dict]:
    """Items this point actually holds — an audit only takes stock off, so an item with
    nothing here has nothing to count."""
    await _visible(db, warehouse_id, user)
    total = func.sum(Stock.total_qty)
    stmt = (select(Item.id, Item.code, Item.name, Item.uom_code, Item.is_serial_tracked,
                   Item.is_imei_tracked, Item.is_asset, total.label("qty"),
                   func.sum(Stock.reserved_qty).label("reserved"))
            .join(Item, Item.id == Stock.item_id)
            .where(Stock.warehouse_id == warehouse_id)
            .group_by(Item.id, Item.code, Item.name, Item.uom_code,
                      Item.is_serial_tracked, Item.is_imei_tracked, Item.is_asset)
            .having(total > 0))
    if search and search.strip():
        like = f"%{search.strip()}%"
        stmt = stmt.where(or_(Item.code.ilike(like), Item.name.ilike(like)))
    rows = (await db.execute(stmt.order_by(Item.name).limit(200))).all()
    return [{
        "item_id": r.id, "item_code": r.code, "item_name": r.name, "uom_code": r.uom_code,
        "system_qty": float(r.qty or 0), "reserved_qty": float(r.reserved or 0),
        "tracking": ("SERIAL" if r.is_serial_tracked else "IMEI" if r.is_imei_tracked
                     else "ASSET" if r.is_asset else "CONSUMABLE"),
    } for r in rows]


async def audit_lots(db: AsyncSession, warehouse_id: int, item_id: int, user) -> list[dict]:
    """Every (batch, location) of the item here holding stock — the lines an audit
    counts — earliest expiry first, each with the mode its write-off will take."""
    await _visible(db, warehouse_id, user)
    item = await db.get(Item, item_id)
    if item is None:
        raise NotFoundError(f"Item {item_id} not found")
    total = func.sum(Stock.total_qty)
    # One row per brand / variant / model (2026-10-31): 100 of Brand A and 50 of Brand B
    # on one shelf are two balances, counted and written off apart.
    rows = (await db.execute(
        select(Stock.batch_id, Stock.bin_id, Stock.brand_id, Stock.variant_id,
               Stock.model_id, total.label("qty"),
               func.sum(Stock.reserved_qty).label("reserved"))
        .where(Stock.warehouse_id == warehouse_id, Stock.item_id == item_id)
        .group_by(Stock.batch_id, Stock.bin_id, Stock.brand_id, Stock.variant_id,
                  Stock.model_id)
        .having(total > 0))).all()
    per_lot: dict[tuple, int] = {}
    for r in rows:
        per_lot[(r.batch_id, r.bin_id)] = per_lot.get((r.batch_id, r.bin_id), 0) + 1
    batch_ids = {r.batch_id for r in rows if r.batch_id}
    bin_ids = {r.bin_id for r in rows if r.bin_id}
    batches = {b.id: b for b in (await db.execute(
        select(m.Batch).where(m.Batch.id.in_(batch_ids or {0})))).scalars().all()}
    bins = {b.id: b for b in (await db.execute(
        select(m.WarehouseLocation).where(m.WarehouseLocation.id.in_(bin_ids or {0}))))
        .scalars().all()}
    out = []
    modes: dict[tuple, str] = {}
    for r in rows:
        key = _key(item_id, warehouse_id, r.batch_id, r.bin_id)
        lot = (key["batch_id"], key["bin_id"])
        if lot not in modes:
            modes[lot] = await lot_mode(db, item, key)
        mode = modes[lot]
        batch, location = batches.get(r.batch_id), bins.get(r.bin_id)
        out.append({
            "batch_id": int(r.batch_id or 0), "bin_id": int(r.bin_id or 0),
            "brand_id": int(r.brand_id or 0), "variant_id": int(r.variant_id or 0),
            "model_id": int(r.model_id or 0),
            "mixed": per_lot[(r.batch_id, r.bin_id)] > 1,
            "batch_no": getattr(batch, "batch_no", None),
            "expiry_date": getattr(batch, "expiry_date", None),
            "bin_code": getattr(location, "code", None),
            "bin_name": getattr(location, "name", None),
            "system_qty": float(r.qty or 0), "reserved_qty": float(r.reserved or 0),
            "mode": mode, "tracking": _tracking(item, mode),
        })
    await combinations.fill_names(db, out)
    out.sort(key=lambda row: (row["expiry_date"] is None, row["expiry_date"] or "",
                              row["batch_no"] or "", row["bin_code"] or "",
                              row["brand_name"] or ""))
    return out


async def lot_sources(db: AsyncSession, *, warehouse_id: int, item_id: int,
                      batch_id: int, bin_id: int, user, brand_id: int | None = None,
                      variant_id: int | None = None, model_id: int | None = None) -> dict:
    """Everything one lot's write-off can name: its packs as a tree (any level) and
    its units, each saying whether a document holds it. The form picks from exactly
    this; `validate_write_off` checks against exactly this."""
    await _visible(db, warehouse_id, user)
    item = await db.get(Item, item_id)
    if item is None:
        raise NotFoundError(f"Item {item_id} not found")
    key = _key(item_id, warehouse_id, batch_id, bin_id)
    mode = await lot_mode(db, item, key)
    stmt = select(func.coalesce(func.sum(Stock.total_qty), 0)).where(
        Stock.warehouse_id == warehouse_id, Stock.item_id == item_id,
        Stock.batch_id == key["batch_id"], Stock.bin_id == key["bin_id"])
    if brand_id is not None:
        stmt = stmt.where(Stock.brand_id == int(brand_id or 0),
                          Stock.variant_id == int(variant_id or 0),
                          Stock.model_id == int(model_id or 0))
    system_qty = _d(await db.scalar(stmt))
    result = {"mode": mode, "tracking": _tracking(item, mode),
              "system_qty": float(system_qty), "packs": [], "units": [],
              "truncated": False, "mixed": await _combos_at(db, key) > 1}
    if mode == MODE_QUANTITY:
        return result

    lot_packs = await _lot_packs(db, key)
    blocked = _blocked(lot_packs, await _held_unit_packs(db, key))
    holders: dict[str, str] = {}
    for hu in lot_packs.values():
        holder = None
        if hu.held_by:
            holder = holders.get(hu.held_by) or await box_codes.holder_label(db, hu.held_by)
            holders[hu.held_by] = holder
        result["packs"].append({
            "id": hu.id, "code": hu.hu_code, "name": hu.pack_name, "level": hu.level,
            "holds": float(wh_packing.held(hu)), "size": float(_d(hu.pack_size)),
            "parent_id": hu.parent_id if hu.parent_id in lot_packs else None,
            "held_by": holder or ("a document holds goods inside it"
                                  if hu.id in blocked else None),
            "selectable": mode == MODE_CODES and hu.id not in blocked,
        })
    units = (await db.execute(_units_in(select(SN), key).order_by(SN.id)
                              .limit(MAX_UNITS_SERVED + 1))).scalars().all()
    result["truncated"] = len(units) > MAX_UNITS_SERVED
    for unit in units[:MAX_UNITS_SERVED]:
        code = _unit_code(unit, item)
        alt = next((c for c in (unit.imei, unit.serial_number, unit.asset_code,
                                unit.consumable_code) if c and c != code), None)
        holder = _unit_holder(unit)
        result["units"].append({
            "id": unit.id, "code": code, "alt": alt,
            "pack_id": unit.handling_unit_id if unit.handling_unit_id in lot_packs else None,
            "held_by": holder, "selectable": holder is None,
        })
    return result
