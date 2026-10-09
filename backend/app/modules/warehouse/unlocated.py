"""Stock with no location, in a warehouse that keeps locations.

A warehouse that does not keep locations (`is_bin_managed = false`) banks what it
receives at `bin_id = 0` — `stk_balance`'s "no location" — the moment the GRN and QC
are done. That is right for it. The trouble starts the day somebody switches the
warehouse to keep locations: everything received from then on goes through putaway
and lands in a real location, and everything received BEFORE stays at bin 0. Every
screen on a bin-managed warehouse asks for a location to draw from — the issue form,
the stock movement form, the location pickers, which join stock to
`whs_warehouse_locations` and so can never return a row at bin 0 — and the floor scope
filters on location ids. So the old stock was on the shelf, counted in every total,
and impossible to issue or move.

The answer is to give it an address. Each warehouse that keeps locations gets ONE
location of the kind **Unlocated** (storage-type code `UNLOCATED`, pickable, top
level, nothing may sit inside it), created the first time it is needed, and every
balance row standing at bin 0 is moved into it:

* through `inventory.service.rehome_balance`, so the goods go OUT of bin 0 and IN to
  the location through `move_stock` and the ledger says so (ref type `UNLOCATED`),
  at their own valuation rate;
* reserved as well as free — an approved allocation, a project hold and an issue's
  claim move with the goods (`allocation.lift_for_rehome` / `set_down_after_rehome`),
  so nothing anybody has signed is let go;
* with the physical units (`whs_serial_numbers`) re-addressed alongside, so the unit
  picker scoped to the location finds the serials the stock row says are there.

From then on it is an ordinary location: the issue form draws from it, a stock
movement takes it to its real bay, and when the last unit has left it simply reads
empty. Nothing about the documents that were already open changes — a line naming
no location means "wherever this stock is held" to `_issue_slices`,
`consume_for_issue` and `move_stock_out`, and the holds now stand at the new address.

**When it runs.** On the switch itself (`update_warehouse`, bulk -> locations), from
the warehouse screen on demand, from `scripts/place_unlocated_stock.py` for a whole
database, and — because the flag can also be flipped through the shared masters API,
and other doors (a return, a transfer received) can still bank stock at bin 0 — as a
self-heal at the top of the two reads every pick goes through (`bin_options`,
`issue_stock_sources`). That self-heal costs one indexed EXISTS when there is nothing
to do.

The location is found by its KIND, never by its code, so renaming it does not make a
second one appear.
"""
from __future__ import annotations

import logging
from decimal import Decimal
from types import SimpleNamespace

from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.modules.inventory.models import NO_BIN, Stock
from app.modules.inventory.service import rehome_balance, take_units
from app.modules.warehouse import models as m
from app.modules.warehouse import storage_types
from app.modules.warehouse.enums import SerialStatus
from app.platform.settings.service import write_audit
from app.shared.enums import AuditAction, RefType
from app.shared.models.warehouse import Bin, Warehouse

logger = logging.getLogger(__name__)

ZERO = Decimal("0")

#: The storage-type code that marks a warehouse's unlocated location.
KIND = "UNLOCATED"
#: The code the location is created with. Only a default — it is found by KIND.
CODE = "UNLOCATED"

#: Who the ledger names when nobody pressed anything — an internal read, or the script.
SYSTEM = SimpleNamespace(id=None, full_name="System (unlocated stock)")

#: A unit in one of these is standing in the warehouse, so it moves with the stock.
#: An issued, consumed or scrapped unit is history and keeps the address it left from.
IN_STOCK_UNIT_STATUSES = (SerialStatus.AVAILABLE.value, SerialStatus.RETURNED.value,
                          SerialStatus.MAINTENANCE.value)


def is_unlocated(location: Bin | None) -> bool:
    """Is this the warehouse's unlocated location?"""
    return location is not None and (location.bin_type or "").upper() == KIND


def assert_can_hold_children(parent: Bin | None) -> None:
    """Nothing is ever filed INSIDE the unlocated location.

    The kind has no allowed children in the master, which already refuses every
    configured kind; this also refuses a brand-new kind nobody has configured yet,
    which the master deliberately leaves unconstrained.
    """
    if is_unlocated(parent):
        raise ValidationError(
            f"{parent.code} holds stock received before this warehouse kept "
            "locations. Nothing can be placed inside it — choose a real location "
            "as the parent.")


async def assert_location_write(db: AsyncSession, existing: Bin | None, *,
                                kind_code: str | None, parent: Bin | None,
                                is_active: bool) -> None:
    """The rules a location write must keep about the unlocated location.

    There is exactly one per warehouse and the system makes it, so a person may
    neither create another nor turn an ordinary location into one or one into an
    ordinary location — `find_location` would then answer with the wrong row. It
    stays at the top of the tree, and it is not switched off while it still holds
    stock: an inactive location cannot be issued from, which is the whole problem
    this exists to solve. Its code, name and description are the site's to edit.
    """
    becomes = (kind_code or "").upper() == KIND
    if existing is None or not is_unlocated(existing):
        if becomes:
            raise ValidationError(
                "The Unlocated location is created automatically, one per warehouse, "
                "when stock held with no location needs somewhere to stand. Choose "
                "another storage type.")
        assert_can_hold_children(parent)
        return
    if not becomes:
        raise ValidationError(
            f"{existing.code} is this warehouse's Unlocated location and keeps that "
            "storage type. Move its stock to real locations; it then simply reads "
            "empty.")
    if parent is not None:
        raise ValidationError(f"{existing.code} stays at the top of the warehouse.")
    if not is_active:
        held = await db.scalar(
            select(func.coalesce(func.sum(Stock.total_qty), 0))
            .where(Stock.bin_id == existing.id))
        if Decimal(str(held or 0)) > ZERO:
            raise ValidationError(
                f"{existing.code} still holds {held}. Issue or move that stock "
                "before switching it off, or it cannot be drawn from at all.")


async def find_location(db: AsyncSession, warehouse_id: int) -> Bin | None:
    return await db.scalar(
        select(Bin).where(Bin.warehouse_id == warehouse_id,
                          func.upper(Bin.bin_type) == KIND)
        .order_by(Bin.id).limit(1))


async def ensure_location(db: AsyncSession, wh: Warehouse, user=None) -> Bin:
    """The warehouse's unlocated location — created, or switched back on, if needed."""
    location = await find_location(db, wh.id)
    if location is not None:
        if not location.is_active:
            location.is_active = True
            await db.flush()
        return location

    kind = await storage_types.ensure_kind(db, KIND)
    # The code is free on every site seen so far; a site that already used it for
    # something else gets a numbered one rather than a clash.
    taken = set((await db.execute(
        select(func.upper(Bin.code)).where(Bin.warehouse_id == wh.id,
                                           func.upper(Bin.code).like(f"{CODE}%"))
    )).scalars().all())
    code, n = CODE, 1
    while code.upper() in taken:
        n += 1
        code = f"{CODE}-{n}"

    location = Bin(
        warehouse_id=wh.id, code=code, name="Unlocated",
        description="Stock received before this warehouse kept locations. Issue "
                    "from here, or move it to the location it actually sits in.",
        parent_id=None, bin_type=kind.code, storage_type_id=int(kind.id),
        temperature_controlled=False, is_active=True,
    )
    db.add(location)
    await db.flush()
    await storage_types.pickable_codes(db)   # the registry `is_pickable` reads
    await write_audit(db, entity="whs_warehouse_locations", entity_id=location.id,
                      entity_no=location.code, action=AuditAction.CREATE, actor=user,
                      summary=f"Created automatically for {wh.code}: stock held with "
                              "no location needed somewhere to stand.")
    return location


def _pending_clause(warehouse_id: int):
    """Balance rows at bin 0 with anything in them — free or reserved."""
    return (Stock.warehouse_id == warehouse_id,
            Stock.bin_id == NO_BIN,
            (Stock.available_qty + Stock.reserved_qty) > 0)


async def has_pending(db: AsyncSession, warehouse_id: int) -> bool:
    return bool(await db.scalar(
        select(Stock.id).where(*_pending_clause(warehouse_id)).limit(1)))


async def place(db: AsyncSession, warehouse_id: int, user) -> dict:
    """Move everything this warehouse holds at bin 0 into its unlocated location.

    Idempotent, never commits, and does nothing on a warehouse that does not keep
    locations — there bin 0 is where stock belongs. The warehouse row is locked first,
    so two requests healing the same warehouse at once queue instead of each creating
    a location.
    """
    wh = await db.scalar(select(Warehouse).where(Warehouse.id == warehouse_id)
                         .with_for_update())
    if wh is None:
        raise NotFoundError(f"Warehouse {warehouse_id} not found")
    summary = {"warehouse_id": wh.id, "warehouse_code": wh.code,
               "location_id": None, "location_code": None,
               "rows": 0, "quantity": ZERO, "units": 0}
    if not wh.is_bin_managed:
        return summary

    rows = list((await db.execute(
        select(Stock).where(*_pending_clause(wh.id))
        .order_by(Stock.item_id, Stock.batch_id, Stock.id).with_for_update()
    )).scalars().all())
    if not rows:
        location = await find_location(db, wh.id)
        if location is not None:
            summary.update(location_id=location.id, location_code=location.code)
        return summary

    location = await ensure_location(db, wh, user)
    summary.update(location_id=location.id, location_code=location.code)

    # The units standing with no location, so each ledger row can name the ones it
    # carried. Grouped by (item, batch) — the project is not on the unit — and dealt
    # out across that pair's balance rows in order.
    unit_ids: list[int] = []
    pools: dict[tuple[int, int], list[str]] = {}
    for unit_id, item_id, batch_id, code in (await db.execute(
        select(m.SerialNumber.id, m.SerialNumber.item_id, m.SerialNumber.batch_id,
               m.SerialNumber.serial_number)
        .where(m.SerialNumber.warehouse_id == wh.id,
               or_(m.SerialNumber.bin_id.is_(None), m.SerialNumber.bin_id == NO_BIN),
               m.SerialNumber.status.in_(IN_STOCK_UNIT_STATUSES),
               m.SerialNumber.item_id.in_({row.item_id for row in rows}))
        .order_by(m.SerialNumber.id)
    )).all():
        unit_ids.append(int(unit_id))
        pools.setdefault((int(item_id), int(batch_id or 0)), []).append(code)

    for row in rows:
        pool = pools.get((int(row.item_id), int(row.batch_id or 0)))
        carried = take_units(pool, (row.available_qty or ZERO)
                             + (row.reserved_qty or ZERO)) if pool else None
        moved = await rehome_balance(
            db, row, to_bin_id=location.id, ref_type=RefType.UNLOCATED.value,
            ref_id=location.id, ref_no=location.code, user=user,
            serial_numbers=carried)
        if moved > ZERO:
            summary["rows"] += 1
            summary["quantity"] += moved

    for start in range(0, len(unit_ids), 1000):
        await db.execute(
            update(m.SerialNumber)
            .where(m.SerialNumber.id.in_(unit_ids[start:start + 1000]))
            .values(bin_id=location.id)
            .execution_options(synchronize_session="fetch"))
    summary["units"] = len(unit_ids)

    await write_audit(
        db, entity="whs_warehouses", entity_id=wh.id, entity_no=wh.code,
        action=AuditAction.UPDATE, actor=user,
        after={"location": location.code, "rows": summary["rows"],
               "quantity": str(summary["quantity"]), "units": summary["units"]},
        summary=f"{summary['quantity']} held with no location placed in "
                f"{location.code} ({summary['rows']} stock rows, "
                f"{summary['units']} units).")
    logger.info("unlocated stock placed: %s", summary)
    return summary


async def heal(db: AsyncSession, warehouse_id: int | None, user) -> bool:
    """`place`, then COMMIT — for the read paths a pick starts from.

    Only ever called first thing on a route that has written nothing yet, so the
    commit carries this and nothing else. One indexed EXISTS when there is nothing to
    do. A failure is logged and swallowed: a screen must still open on a warehouse
    whose old stock could not be moved, and the next read tries again.
    """
    if not warehouse_id:
        return False
    wh = await db.get(Warehouse, warehouse_id)
    if wh is None or not wh.is_bin_managed or not await has_pending(db, warehouse_id):
        return False
    try:
        # A SAVEPOINT, not a full rollback on failure: rolling the whole session back
        # would expire everything the request has loaded — the caller included — and
        # its next attribute read would be IO outside the event loop's reach.
        async with db.begin_nested():
            summary = await place(db, warehouse_id, user or SYSTEM)
        await db.commit()
    except Exception:  # noqa: BLE001 — see docstring
        logger.exception("could not place unlocated stock in warehouse %s", warehouse_id)
        return False
    return summary["rows"] > 0


async def status(db: AsyncSession, warehouse_id: int) -> dict:
    """What the warehouse screen says about stock with no location."""
    wh = await db.get(Warehouse, warehouse_id)
    if wh is None:
        raise NotFoundError(f"Warehouse {warehouse_id} not found")
    pending_rows, pending_qty = (await db.execute(
        select(func.count(), func.coalesce(func.sum(Stock.total_qty), 0))
        .where(*_pending_clause(wh.id)))).one()
    location = await find_location(db, wh.id)
    held_rows, held_qty, held_items = 0, ZERO, 0
    if location is not None:
        held_rows, held_qty, held_items = (await db.execute(
            select(func.count(), func.coalesce(func.sum(Stock.total_qty), 0),
                   func.count(func.distinct(Stock.item_id)))
            .where(Stock.warehouse_id == wh.id, Stock.bin_id == location.id,
                   Stock.total_qty > 0))).one()
    return {
        "warehouse_id": wh.id,
        "is_bin_managed": bool(wh.is_bin_managed),
        "location_id": location.id if location is not None else None,
        "location_code": location.code if location is not None else None,
        "pending_rows": int(pending_rows or 0),
        "pending_qty": Decimal(str(pending_qty or 0)),
        "held_rows": int(held_rows or 0),
        "held_items": int(held_items or 0),
        "held_qty": Decimal(str(held_qty or 0)),
    }
