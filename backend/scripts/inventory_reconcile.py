"""Repair the inventory data the stock screens have been reporting honestly.

Six gaps, none of them a bug in today's code — they are what the seeders and an early
schema left behind, and every one of them makes a screen say something untrue:

  1. **Item costs.** 90 of 103 items carry `purchase_price = 0`, so stock values as
     "Not costed" while `mst_vendor_items.last_rate` holds a real, negotiated rate for
     44 of them (Absorbant Cotton 8.50, Spirit 85.00). `min_order_qty` and
     `lead_time_days` are 0 on EVERY item and sit on the same vendor row.
  2. **Serial tracking on things that cannot be serialised.** Eight items are flagged
     `is_serial_tracked` while measured in grams, litres, metres or square metres. A
     weight has no serial number, and the generated units made "12 GMS" sit beside
     "19 units in lot" on the grid.
  3. **Stale snapshots.** `stk_balance` snapshots the warehouse name and UOM code at
     movement time (correctly — a document must not change when a master is renamed),
     but 98 rows point at a warehouse that has since been renamed and 8 at a UOM code
     that no longer matches the item master.
  4. **Duplicate lots.** Two `stk_balance` rows share one (warehouse, item, bin, batch)
     key, so one lot renders twice.
  5. **Quantity against units.** Serial-tracked lots whose `total_qty` disagrees with
     the count of active `whs_serial_numbers` rows behind them.
  6. **Nowhere to put anything.** 989 warehouses, 13 storage locations between them,
     which is why every row on the grid says "No bin".

What this script will NOT do
----------------------------
It never invents a number. A price with no vendor rate behind it stays 0 and keeps
reading "Not costed", because a plausible-looking rupee figure is worse than a blank.
Reorder levels are left at 0 for exactly this reason — nothing in the database knows
what "low" means for these items — and the screens now hide the Below Reorder tile
rather than reporting a reassuring zero over an unanswered question.

It also never writes stock behind the app's back. Quantity corrections (5) are posted
as **Stock Adjustment documents** through `service.create_stock_adjustment()`, so:

  * `stock.adjust` is checked against the actor's real RBAC grants before anything runs
    — the script refuses to start otherwise, exactly as the endpoint would;
  * the existing approval configuration decides what posts and what queues. An inward
    correction under 100 units AND 5000 rupees auto-approves; everything else, and every
    outward correction without exception, lands in the approvals queue for a human;
  * each posting writes its `stk_ledger` row and its audit row through `move_stock()`.

The one deliberate exception is (4): merging duplicate lots writes `stk_balance`
directly. It is not a quantity change — the two rows are summed into one and the total
is preserved, which is why the ledger still reconciles afterwards — so routing it
through an adjustment would post a movement that never physically happened.

    .venv/Scripts/python -m scripts.inventory_reconcile --dry-run
    .venv/Scripts/python -m scripts.inventory_reconcile --commit
    .venv/Scripts/python -m scripts.inventory_reconcile --commit --only costs,locations

Re-runnable: every step writes only what is still wrong, so a second run reports zeros.
`--dry-run` is the default; nothing is written until `--commit` is passed.
"""
import argparse
import asyncio
import sys
from decimal import Decimal

from sqlalchemy import func, or_, select

from app.core.database import SessionLocal
from app.modules.inventory import service
from app.modules.inventory.enums import AdjustmentStatus
from app.modules.inventory.models import Stock, StockAdjustment, StockAdjustmentItem
from app.modules.inventory.schemas import AdjustmentIn, AdjustmentItemIn
from app.modules.warehouse.models import SerialNumber
from app.platform.hcm.models import HcmEmployee
from app.platform.rbac import permissions as perms
from app.platform.rbac.service import get_user_permissions
from app.platform.settings.service import write_audit
from app.shared.enums import AdjustmentReason, AuditAction, StockDirection
from app.shared.models.master import Item, Uom, VendorItem
from app.shared.models.warehouse import Warehouse, WarehouseLocation

# A serial number names one physical thing you can pick up. These UOM classes measure a
# CONTINUOUS quantity, and 19 grams of cotton is not 19 of anything — so an item
# measured in one of them cannot be serial-tracked, whatever the flag says.
CONTINUOUS_UOM_CLASSES = {"WEIGHT", "VOLUME", "LENGTH", "AREA", "TEMPERATURE", "ENERGY"}

# Where a warehouse with no storage tree at all puts its stock. One bin, at the root,
# so putaway has a destination that exists; the real racks and shelves are somebody's
# survey of a physical building and are not this script's to invent.
DEFAULT_BIN_CODE = "MAIN"
DEFAULT_BIN_NAME = "Main Storage"


def _d(value) -> Decimal:
    return Decimal(str(value or 0))


# --------------------------------------------------------------------------- costs

async def backfill_item_costs(db, *, commit: bool) -> dict:
    """Fill item cost, MOQ and lead time from the vendor the item is actually bought from.

    `mst_vendor_items` is a master with a screen and real rates in it. The preferred
    vendor wins when one is marked (`apply_vendor_item` allows at most one per item);
    otherwise the cheapest rate is taken, which is the one a buyer would defend.
    Only blank fields are filled — an item that already has a price keeps it.
    """
    rows = (await db.execute(
        select(VendorItem).where(VendorItem.last_rate.isnot(None), VendorItem.last_rate > 0)
    )).scalars().all()

    best: dict[int, VendorItem] = {}
    for vi in rows:
        seen = best.get(vi.item_id)
        if seen is None or (vi.is_preferred and not seen.is_preferred) or (
            vi.is_preferred == seen.is_preferred and _d(vi.last_rate) < _d(seen.last_rate)
        ):
            best[vi.item_id] = vi

    items = (await db.execute(
        select(Item).where(Item.id.in_(best.keys()))
    )).scalars().all() if best else []

    priced = moq = lead = 0
    for item in items:
        vi = best[item.id]
        if _d(item.purchase_price) <= 0 and _d(vi.last_rate) > 0:
            if commit:
                item.purchase_price = _d(vi.last_rate)
            priced += 1
        if _d(item.min_order_qty) <= 0 and _d(vi.min_order_qty) > 0:
            if commit:
                item.min_order_qty = _d(vi.min_order_qty)
            moq += 1
        if not (item.lead_time_days or 0) and (vi.lead_time_days or 0) > 0:
            if commit:
                item.lead_time_days = vi.lead_time_days
            lead += 1

    # Counted, not fixed: these are the items nothing in the database knows a price for.
    # They keep reading "Not costed", which is the truth.
    unpriced = int(await db.scalar(
        select(func.count()).select_from(Item)
        .where(Item.is_active.is_(True), Item.purchase_price <= 0,
               Item.id.notin_(best.keys()) if best else True)
    ) or 0)

    return {"priced": priced, "min_order_qty": moq, "lead_time": lead,
            "left_unpriced": unpriced}


# ------------------------------------------------------------------ serial tracking

async def untrack_continuous_items(db, *, commit: bool) -> dict:
    """Clear `is_serial_tracked` where the item is measured, not counted.

    The generated unit rows are deactivated with it rather than deleted: they are the
    evidence of what the flag caused, `whs_serial_numbers` is read by the ledger and
    the unit lookup, and a deactivated row disappears from both without leaving the
    dangling references a DELETE would.
    """
    items = (await db.execute(
        select(Item).join(Uom, Uom.id == Item.uom_id)
        .where(Item.is_serial_tracked.is_(True),
               func.upper(Uom.uom_class).in_(CONTINUOUS_UOM_CLASSES))
    )).scalars().all()

    if not items:
        return {"items": 0, "units_deactivated": 0, "ids": [], "names": []}

    ids = [i.id for i in items]
    units = (await db.execute(
        select(SerialNumber).where(SerialNumber.item_id.in_(ids),
                                   SerialNumber.is_active.is_(True))
    )).scalars().all()

    if commit:
        for item in items:
            item.is_serial_tracked = False
            # IMEI is the same claim by another name — a phone identity on a litre of
            # spirit — and four of these carry it too.
            item.is_imei_tracked = False
        for unit in units:
            unit.is_active = False

    return {"items": len(items), "units_deactivated": len(units),
            "ids": ids,
            "names": [f"{i.name} ({i.uom_code})" for i in items]}


async def restore_putaway_codes(db, *, commit: bool) -> dict:
    """Give the measured items their putaway CODE back, without the serial number.

    `untrack_continuous_items` deactivated the whole unit row, and the asset/consumable
    code lived on the same row as the serial — so tearing up a fake serial number also
    threw away a real putaway label, and both columns went blank for cotton and spirit.

    The two identities are not the same claim. A serial number says "this is unit 7 of
    19", which is meaningless for 12 grams. A putaway code labels the physical package
    the storekeeper put on the shelf, and that package exists whatever the UOM is. So
    the row comes back with the code and without the serial or the IMEI.

    A row that carried no code has nothing to come back for and stays retired.
    """
    rows = (await db.execute(
        select(SerialNumber).join(Item, Item.id == SerialNumber.item_id)
        .where(SerialNumber.is_active.is_(False),
               Item.is_serial_tracked.is_(False),
               or_(SerialNumber.asset_code.isnot(None),
                   SerialNumber.consumable_code.isnot(None)))
    )).scalars().all()

    if commit:
        for row in rows:
            row.is_active = True
            # `serial_number` is UNIQUE and NOT NULL on this table, so the fake value
            # cannot be blanked here — 2,098 empty strings would collide on the index.
            # It stays as the row's key and is suppressed at the READ side instead:
            # warehouse.service.serial_summary only reports a serial for an item the
            # master says is serial-tracked, so cotton shows its code and no serial.

    empty = int(await db.scalar(
        select(func.count()).select_from(SerialNumber)
        .where(SerialNumber.is_active.is_(False),
               SerialNumber.asset_code.is_(None),
               SerialNumber.consumable_code.is_(None))
    ) or 0)

    return {"restored": len(rows), "no_code_left_retired": empty}


# ---------------------------------------------------------------------- snapshots

async def refresh_stock_snapshots(db, *, commit: bool) -> dict:
    """Re-point stale display snapshots on `stk_balance` at their masters.

    Only the two DISPLAY columns, never a quantity or a rate. A snapshot exists so a
    document reads the same next year, but `stk_balance` is not a document — it is the
    current position, and the current position should name the warehouse by the name it
    has now. `stk_ledger` is left strictly alone: those rows ARE history.
    """
    # The item master snapshots its own UOM code too, and that one has drifted: items
    # carry `g` and `Kg` where `mst_uom` says `UOM-GMS` and `UOM-L`. Fixed FIRST, so the
    # balance rows below are re-pointed at a code that matches a real master row.
    uom_by_id = dict((await db.execute(select(Uom.id, Uom.code))).all())
    items = (await db.execute(select(Item))).scalars().all()
    item_uom_fixed = 0
    for item in items:
        code = uom_by_id.get(item.uom_id)
        if code and item.uom_code != code:
            if commit:
                item.uom_code = code
            item_uom_fixed += 1

    warehouses = dict((await db.execute(select(Warehouse.id, Warehouse.name))).all())
    wanted = {i.id: (uom_by_id.get(i.uom_id) or i.uom_code) for i in items}

    rows = (await db.execute(select(Stock))).scalars().all()
    wh_fixed = uom_fixed = 0
    for row in rows:
        name = warehouses.get(row.warehouse_id)
        if name and row.warehouse_name != name:
            if commit:
                row.warehouse_name = name
            wh_fixed += 1
        code = wanted.get(row.item_id)
        if code and row.uom_code != code:
            if commit:
                row.uom_code = code
            uom_fixed += 1

    return {"warehouse_names": wh_fixed, "uom_codes": uom_fixed,
            "item_uom_codes": item_uom_fixed}


# --------------------------------------------------------------------- duplicates

async def merge_duplicate_lots(db, *, commit: bool, actor) -> dict:
    """Collapse `stk_balance` rows that share a (warehouse, item, bin, batch) key.

    The quantities are SUMMED into the surviving row and the duplicate is zeroed, not
    deleted: the total is unchanged, so the ledger still reconciles to the balance
    afterwards, and a zeroed row falls out of every screen on its own (the grid filters
    `total_qty > 0` unless "Include zero stock" is ticked). Deleting would break the
    `inv_reservations.stock_id` pointing at it.

    This is the one place that assigns to `stk_balance` outside `move_stock()`. It is a
    repair of a duplicated KEY rather than a change of quantity — no stock moved, so no
    movement is written — and it leaves an audit row saying so.
    """
    dupes = (await db.execute(
        select(Stock.warehouse_id, Stock.item_id, Stock.bin_id, Stock.batch_id)
        .group_by(Stock.warehouse_id, Stock.item_id, Stock.bin_id, Stock.batch_id)
        .having(func.count() > 1)
    )).all()

    merged = 0
    for warehouse_id, item_id, bin_id, batch_id in dupes:
        rows = (await db.execute(
            select(Stock)
            .where(Stock.warehouse_id == warehouse_id, Stock.item_id == item_id,
                   Stock.bin_id == bin_id, Stock.batch_id == batch_id)
            .order_by(Stock.id)
        )).scalars().all()
        keeper, extras = rows[0], rows[1:]
        # Already merged on an earlier run. The duplicated KEY survives a merge — the
        # emptied rows are zeroed rather than deleted, because `inv_reservations`
        # points at them by id — so without this the step would report the same two
        # rows as work forever and write a fresh audit row saying it moved nothing.
        if all(_d(e.total_qty) == 0 and _d(e.reserved_qty) == 0
               and _d(e.transit_qty) == 0 for e in extras):
            continue
        before = {"keeper_total": str(keeper.total_qty),
                  "absorbed": [str(e.total_qty) for e in extras]}

        for extra in extras:
            if commit:
                keeper.available_qty = _d(keeper.available_qty) + _d(extra.available_qty)
                keeper.reserved_qty = _d(keeper.reserved_qty) + _d(extra.reserved_qty)
                keeper.transit_qty = _d(keeper.transit_qty) + _d(extra.transit_qty)
                keeper.total_qty = _d(keeper.total_qty) + _d(extra.total_qty)
                keeper.stock_value = _d(keeper.stock_value) + _d(extra.stock_value)
                extra.available_qty = extra.reserved_qty = Decimal("0")
                extra.transit_qty = extra.total_qty = Decimal("0")
                extra.stock_value = Decimal("0")
            merged += 1

        if commit:
            await write_audit(
                db, entity="stk_balance", entity_id=keeper.id,
                entity_no=keeper.item_code, action=AuditAction.UPDATE, actor=actor,
                before=before,
                after={"keeper_total": str(keeper.total_qty),
                       "zeroed_rows": [e.id for e in extras]},
                summary=(f"Merged {len(extras)} duplicate lot row(s) for "
                         f"{keeper.item_code} at {keeper.warehouse_name} — total "
                         f"unchanged, ledger still reconciles"),
            )

    return {"keys": len(dupes), "rows_merged": merged}


# ---------------------------------------------------------------------- locations

async def default_locations(db, *, commit: bool) -> dict:
    """Give every warehouse that HOLDS stock one root bin to hold it in.

    Scoped to warehouses with stock — 76 of 989 — on purpose. Creating a bin for a
    stocking point that has never received anything is 900 rows of clutter that a real
    warehouse survey will have to reconcile against later.

    Existing `stk_balance` rows keep `bin_id = 0`. Re-homing goods that are physically
    somewhere into a location invented by a script would be a lie with a foreign key on
    it; what this fixes is that putaway now has somewhere to put the NEXT receipt.
    """
    stocked = {r[0] for r in (await db.execute(
        select(Stock.warehouse_id).where(Stock.total_qty > 0).distinct()
    )).all()}
    have = {r[0] for r in (await db.execute(
        select(WarehouseLocation.warehouse_id).distinct()
    )).all()}
    missing = sorted(stocked - have)

    if commit:
        for warehouse_id in missing:
            db.add(WarehouseLocation(
                warehouse_id=warehouse_id,
                code=DEFAULT_BIN_CODE,
                name=DEFAULT_BIN_NAME,
                bin_type="BIN",
                description="Created by scripts.inventory_reconcile so putaway has a "
                            "destination. Replace with the real storage tree.",
                is_active=True,
            ))

    return {"warehouses_with_stock": len(stocked), "created": len(missing)}


# ------------------------------------------------------- quantity vs unit counts

async def reconcile_unit_counts(db, *, commit: bool, actor, skip_items=()) -> dict:
    """Bring `stk_balance` in line with the units actually registered.

    The serial rows win: a unit row is one physical thing somebody booked in, while the
    balance is a running total that a bad movement can drift. Serial-tracked items only,
    minus `skip_items` — the ones `untrack_continuous_items` is about to stop tracking,
    passed in explicitly so a DRY RUN reports the same set a commit would act on.

    Compared per ITEM and WAREHOUSE, never per lot. `whs_serial_numbers` records a bin
    and a batch on almost none of its 10,000 rows, so a unit count is only meaningful at
    the stocking point; comparing it against each lot separately would "correct" a
    warehouse holding two batches to the full unit count twice and double its stock.
    The adjustment document has no bin picker either — an outward line resolves to
    "pick from available" — so the stocking point is the right grain at both ends.

    Every correction goes out as a Stock Adjustment through the normal service call, so
    the approval configuration — not this script — decides what posts now and what waits
    for an approver. Expect most of these to queue: an inward correction only
    auto-approves under 100 units AND 5000 rupees, and an outward one never does.
    """
    tracked = {r[0] for r in (await db.execute(
        select(Item.id).where(Item.is_serial_tracked.is_(True))
    )).all()} - set(skip_items)
    if not tracked:
        return {"pairs": 0, "warehouses": 0, "posted": 0, "queued": 0,
                "documents": [], "changes": []}

    counts = dict(((r.item_id, r.warehouse_id), r.n) for r in (await db.execute(
        select(SerialNumber.item_id, SerialNumber.warehouse_id,
               func.count().label("n"))
        .where(SerialNumber.item_id.in_(tracked), SerialNumber.is_active.is_(True))
        .group_by(SerialNumber.item_id, SerialNumber.warehouse_id)
    )).all())

    # Corrections already raised and still waiting for an approver. Without this a
    # second run would raise a SECOND document for the same gap — the first one has not
    # posted yet, so the balance still disagrees with the units and the gap still looks
    # unfixed. Approving both would then apply the correction twice.
    in_flight = {(r.item_id, r.warehouse_id) for r in (await db.execute(
        select(StockAdjustmentItem.item_id, StockAdjustment.warehouse_id)
        .join(StockAdjustment, StockAdjustment.id == StockAdjustmentItem.adjustment_id)
        .where(StockAdjustment.status == AdjustmentStatus.PENDING_APPROVAL.value)
    )).all()}

    # The balance summed the same way, so the two sides are the same shape.
    balances = {(r.item_id, r.warehouse_id): r for r in (await db.execute(
        select(Stock.item_id, Stock.warehouse_id,
               func.sum(Stock.total_qty).label("qty"),
               func.min(Stock.item_code).label("item_code"),
               func.min(Stock.warehouse_name).label("warehouse_name"))
        .where(Stock.item_id.in_(tracked))
        .group_by(Stock.item_id, Stock.warehouse_id)
    )).all()}

    # One document per warehouse, not one per line: a storekeeper approving "eleven
    # lines at Central" is reviewing one physical recount, and eleven separate
    # documents would ask them the same question eleven times.
    by_warehouse: dict[int, list[AdjustmentItemIn]] = {}
    detail: list[str] = []
    waiting = 0
    for key, balance in balances.items():
        units = counts.get(key)
        if units is None:
            continue
        if key in in_flight:
            waiting += 1
            continue
        gap = _d(units) - _d(balance.qty)
        if gap == 0:
            continue
        item_id, warehouse_id = key
        by_warehouse.setdefault(warehouse_id, []).append(AdjustmentItemIn(
            item_id=item_id,
            direction=(StockDirection.IN if gap > 0 else StockDirection.OUT).value,
            quantity=float(abs(gap)),
            remarks=(f"Recount: {units} unit(s) registered against "
                     f"{_d(balance.qty):g} on the balance"),
        ))
        detail.append(f"{balance.item_code} @ {balance.warehouse_name}: "
                      f"{_d(balance.qty):g} -> {units}")

    posted = queued = 0
    documents: list[str] = []
    if commit:
        for warehouse_id, items in by_warehouse.items():
            adjustment = await service.create_stock_adjustment(
                db,
                AdjustmentIn(
                    warehouse_id=warehouse_id,
                    reason=AdjustmentReason.CYCLE_COUNT.value,
                    remarks="Balance reconciled against registered serial units "
                            "(scripts.inventory_reconcile)",
                    items=items,
                ),
                actor,
            )
            documents.append(f"{adjustment.adjustment_no} "
                             f"({len(items)} line(s), {adjustment.status})")
            if adjustment.status == AdjustmentStatus.APPROVED.value:
                posted += 1
            else:
                queued += 1

    return {"pairs": len(detail), "warehouses": len(by_warehouse),
            "posted": posted, "queued": queued, "awaiting_approval": waiting,
            "documents": documents, "changes": detail}


# --------------------------------------------------------------------------- main

STEPS = ("costs", "serials", "codes", "snapshots", "duplicates", "locations", "counts")


async def resolve_actor(db, identifier: str | None):
    """The employee the corrections are raised as, and the RBAC check on them.

    A repair script is not a way around the permission model: whoever runs this has to
    hold `stock.adjust`, the same grant the POST /api/stock/adjust endpoint demands,
    and the documents carry their name so the approvals queue shows who asked.
    """
    actor = None
    if identifier and identifier.isdigit():
        actor = await db.get(HcmEmployee, int(identifier))
    elif identifier:
        actor = (await db.execute(
            select(HcmEmployee).where(HcmEmployee.emp_code == identifier)
        )).scalars().first()
    if actor is None:
        raise SystemExit(
            f"No employee matches {identifier!r}. Pass --actor <employee id or code> — "
            "the corrections are raised in that person's name and checked against their "
            "permissions."
        )

    granted = await get_user_permissions(db, actor)
    if perms.STOCK_ADJUST not in granted:
        raise SystemExit(
            f"{actor.full_name} does not hold {perms.STOCK_ADJUST}. That is the same "
            "permission POST /api/stock/adjust requires, and this script will not post "
            "a stock correction the person running it could not post through the app."
        )
    return actor


async def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--commit", action="store_true",
                        help="write the changes; without it nothing is saved")
    # Accepted and ignored: dry run is already the default, and a reader who types the
    # safe-looking flag should not be met with a usage error.
    parser.add_argument("--dry-run", action="store_true", help="the default; explicit")
    parser.add_argument("--actor", default=None,
                        help="employee id or code the adjustments are raised as; "
                             "must hold stock.adjust")
    parser.add_argument("--only", default=",".join(STEPS),
                        help=f"comma-separated subset of: {', '.join(STEPS)}")
    args = parser.parse_args(argv)

    steps = [s.strip() for s in args.only.split(",") if s.strip()]
    unknown = set(steps) - set(STEPS)
    if unknown:
        raise SystemExit(f"Unknown step(s): {', '.join(sorted(unknown))}")

    commit = args.commit
    needs_actor = commit and bool({"duplicates", "counts"} & set(steps))

    print("Inventory reconcile —", "COMMIT" if commit else "DRY RUN (nothing is written)")
    print()

    async with SessionLocal() as db:
        actor = await resolve_actor(db, args.actor) if needs_actor else None
        if actor is not None:
            print(f"Raising corrections as {actor.full_name} (holds stock.adjust)\n")

        if "costs" in steps:
            r = await backfill_item_costs(db, commit=commit)
            print(f"Item costs      : {r['priced']} priced from vendor rates, "
                  f"{r['min_order_qty']} MOQ, {r['lead_time']} lead times")
            print(f"                  {r['left_unpriced']} item(s) have no rate "
                  f"anywhere and stay 'Not costed'")

        # Remembered across the steps: the items that stop being serial-tracked must not
        # then be "reconciled" against the unit rows this step just retired. In a dry run
        # nothing is written, so without carrying the set explicitly the preview would
        # list corrections a real run would never raise.
        untracked: list[int] = []

        if "serials" in steps:
            r = await untrack_continuous_items(db, commit=commit)
            untracked = r["ids"]
            print(f"Serial tracking : cleared on {r['items']} measured item(s), "
                  f"{r['units_deactivated']} generated unit row(s) deactivated")
            for name in r["names"]:
                print(f"                  - {name}")

        if "codes" in steps:
            r = await restore_putaway_codes(db, commit=commit)
            print(f"Putaway codes   : {r['restored']} unit(s) restored with their code "
                  f"and no serial")
            print(f"                  {r['no_code_left_retired']} row(s) had no code at "
                  f"all and stay retired")

        if "snapshots" in steps:
            r = await refresh_stock_snapshots(db, commit=commit)
            print(f"Snapshots       : {r['warehouse_names']} warehouse name(s), "
                  f"{r['uom_codes']} balance UOM code(s), "
                  f"{r['item_uom_codes']} item UOM code(s) refreshed")

        if "duplicates" in steps:
            r = await merge_duplicate_lots(db, commit=commit, actor=actor)
            print(f"Duplicate lots  : {r['keys']} duplicated key(s), "
                  f"{r['rows_merged']} row(s) merged into their keeper")

        if "locations" in steps:
            r = await default_locations(db, commit=commit)
            print(f"Locations       : {r['created']} default bin(s) created across "
                  f"{r['warehouses_with_stock']} stocked warehouse(s)")

        if "counts" in steps:
            r = await reconcile_unit_counts(db, commit=commit, actor=actor,
                                            skip_items=untracked)
            print(f"Unit counts     : {r['pairs']} item/warehouse pair(s) disagree "
                  f"with their units, across {r['warehouses']} warehouse(s)")
            if r["awaiting_approval"]:
                print(f"                  {r['awaiting_approval']} more already have a "
                      f"correction waiting for an approver — left alone")
            for line in r["changes"][:20]:
                print(f"                  - {line}")
            if len(r["changes"]) > 20:
                print(f"                  ... and {len(r['changes']) - 20} more")
            if commit:
                print(f"                  {r['posted']} document(s) auto-approved and "
                      f"posted, {r['queued']} queued for an approver")
                for doc in r["documents"]:
                    print(f"                  - {doc}")

        if commit:
            await db.commit()
            print("\nCommitted.")
        else:
            await db.rollback()
            print("\nDry run — nothing written. Re-run with --commit to apply.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(sys.argv[1:])))
