"""Inventory business logic. The base module — imports nothing from app.modules.

Physical stock changes go ONLY through move_stock(); reservation columns go ONLY
through allocation.py. Nothing else assigns to stk_balance.
"""
import json
import logging
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import String, case, cast, func, select, or_, and_, text, true
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.exceptions import NotFoundError, PermissionError_, ValidationError
from app.core.pagination import PageParams, paginate
from app.modules.inventory import allocation, availability, locations
from app.modules.inventory.enums import AdjustmentStatus, CycleCountStatus, STOStatus
from app.modules.inventory.models import (
    NO_BATCH, NO_BIN, NO_PROJECT, Allocation, MaterialRequest, MaterialRequestItem, Stock,
    StockMovement, StockAdjustment, StockAdjustmentItem, StockTransferOrder,
    StockTransferOrderItem, CycleCount, CycleCountItem, Reservation,
)
from app.platform.hcm.models import HcmEmployee, HcmFacility, HcmOffice
from app.platform.rbac import permissions as perms
from app.platform.rbac.models import Role, UserRole
from app.platform.rbac.service import get_user_permissions
from app.platform.admin.notifications import recipients_for
from app.platform.notifications import service as notifications
from app.platform.rules import evaluator as rules
from app.platform.settings.service import get_setting, set_setting, write_audit
from app.platform.workflow import engine
from app.shared.scope import rung_for, scope_condition
from app.shared.enums import (
    AdjustmentReason, ApprovalAction, AuditAction, DocType, IndentStatus,
    InstanceStatus, MRStatus,
    Priority, RefType, ScopeRung, StockDirection, UserRole as RoleCode,
)
from app.shared.models.base import utcnow
from app.shared.models.master import Item, Uom
from app.shared.models.warehouse import Warehouse, WarehouseLocation
from app.shared.numbering import next_number
from app.shared.time import now as ist_now, today as ist_today
from app.shared.time import to_ist


logger = logging.getLogger(__name__)


def _d(value) -> Decimal:
    return Decimal(str(value))


def _aware(value: datetime | None) -> datetime | None:
    """Force a datetime read back from MySQL into UTC-aware.

    `stk_balance.last_movement_at` is a plain DateTime, so aiomysql hands it back
    naive while `utcnow()` is tz-aware — subtracting the two raised
    "can't subtract offset-naive and offset-aware datetimes" on every
    GET /api/stock/ageing. Normalising on read is the fix that needs no migration.
    """
    if value is None:
        return None
    return to_ist(value)


def _as_date(value) -> date | None:
    """`expiry_date` is a DATE, but batch snapshots have landed as datetimes;
    subtracting one from `date.today()` is the same TypeError one line down."""
    if value is None:
        return None
    return value.date() if isinstance(value, datetime) else value


async def _batch_snapshot(db: AsyncSession, batch_id: int) -> tuple[str | None, date | None]:
    """Resolve batch values for the stock balance snapshot columns."""
    if not batch_id:
        return None, None
    row = (await db.execute(
        text("SELECT batch_no, expiry_date FROM stk_batches WHERE id = :batch_id"),
        {"batch_id": batch_id},
    )).mappings().one_or_none()
    return (row["batch_no"], row["expiry_date"]) if row else (None, None)


async def _warehouse_ids_for_user(db: AsyncSession, user) -> set[int] | None:
    """Warehouses visible to this login; None means the admin/global scope."""
    if user is None:
        return None
    is_admin = (await db.execute(
        select(Role.id)
        .join(UserRole, UserRole.role_id == Role.id)
        .where(
            UserRole.employee_id == user.id,
            Role.code == RoleCode.ADMIN.value,
            Role.is_active.is_(True),
        )
        .limit(1)
    )).scalar_one_or_none()
    if is_admin is not None:
        return None
    user_permissions = await get_user_permissions(
        db, user, getattr(user, "active_position_id", None),
    )
    if perms.ADMIN_SETTINGS_MANAGE in user_permissions:
        return None
    # Inventory decides which warehouse fills an indent, so it needs the whole
    # network, not the one office the login sits in.
    if perms.STOCK_VIEW_ALL in user_permissions:
        return None

    # The job profile's data scope decides how far down the chain this login sees.
    # It is the SAME dropdown that governs indents and warehouse documents, so moving
    # a DM from "own documents" to "reporting line" widens his stock view too, and
    # taking him off an approval ladder does not narrow it — the ladder says who signs,
    # the rung says who may look.
    rung = await rung_for(db, user)
    if rung is ScopeRung.ALL:
        return None

    office_id = getattr(user, "office_id", None)
    project_id = getattr(user, "project_id", None)

    # Points this person holds directly: they are its incharge, or it hangs off their
    # own office. This is the SELF floor — no rung is ever narrower than "mine".
    own_conditions = [Warehouse.incharge_id == user.id]
    if office_id is not None:
        own_conditions.extend((
            Warehouse.office_id == office_id,
            HcmFacility.office_id == office_id,
        ))
    own = set((await db.execute(
        select(Warehouse.id)
        .outerjoin(HcmFacility, HcmFacility.id == Warehouse.facility_id)
        .where(Warehouse.is_active.is_(True), or_(*own_conditions))
    )).scalars().all())

    if rung is ScopeRung.PROJECT and project_id is not None:
        # Everything in the project, however it is tagged.
        in_project = set((await db.execute(
            select(Warehouse.id)
            .outerjoin(HcmFacility, HcmFacility.id == Warehouse.facility_id)
            .outerjoin(HcmOffice, HcmOffice.id == func.coalesce(
                Warehouse.office_id, HcmFacility.office_id))
            .join(HcmEmployee, HcmEmployee.office_id == HcmOffice.id)
            .where(Warehouse.is_active.is_(True),
                   HcmEmployee.project_id == project_id)
        )).scalars().all())
        return own | in_project

    if rung in (ScopeRung.SUBTREE, ScopeRung.OFFICE):
        # The REPORTING TREE, walked through hcm_positions.parent_position_id — every
        # point tagged to a position under this one, so a DM finds the OE and the LIPs
        # below him. OFFICE gets it too: an office head who cannot see the points
        # inside his own office is not scoped, he is blindfolded.
        subtree = await locations.warehouses_visible_to(db, user)
        return own | subtree if subtree else own

    # SELF, or a rung whose data is missing: only what this login holds itself.
    return own


async def warehouse_ids_for_user(db: AsyncSession, user) -> set[int] | None:
    """Public alias — later modules (warehouse, procurement) scope their documents
    to the same warehouse set the inventory screens use, so the two can never
    disagree about which docks a login can see. None means unrestricted."""
    return await _warehouse_ids_for_user(db, user)


async def drawable_warehouse_ids(db: AsyncSession, user) -> set[int] | None:
    """Points this login may DRAW FROM when it decides an allocation. None = every one.

    The UNION of the two rules that were being applied separately, and disagreeing:
    the stocking points tagged to this person's own posts and their reportees'
    (`locations.location_ids_for_user`), plus whatever their job profile's data scope
    opens up (`warehouse_ids_for_user` — admin, `stock.view_all`, and the ALL /
    PROJECT / OFFICE rungs).

    The allocation screen read the tagging alone, so a login granted "All projects"
    in Settings > Job Profiles was still shown `available 0` for stock sitting outside
    their own reporting tree, and the whole line fell through to procurement. Union,
    never intersection: widening a profile must not be able to take away a point
    somebody can reach today, and a narrow rung must not take away their own shelf.

    Visibility only. Who may SIGN is untouched — `create_allocation_for_indent` still
    classifies OWN_STOCK_ALLOCATION vs ALLOCATION off the reporting subtree alone, so
    drawing from a point outside your own tree still goes up the inventory ladder
    rather than approving itself.
    """
    if user is None:
        return None
    allowed = await warehouse_ids_for_user(db, user)
    if allowed is None:
        return None
    return allowed | await locations.location_ids_for_user(db, user)


async def _scoped_warehouse_ids(
    db: AsyncSession, user, warehouse_id: int | None = None,
) -> set[int] | None:
    allowed = await _warehouse_ids_for_user(db, user)
    if allowed is not None and warehouse_id is not None and warehouse_id not in allowed:
        raise PermissionError_("Warehouse is outside your assigned office")
    if warehouse_id is not None:
        return {warehouse_id}
    return allowed


async def _can_view_valuation(db: AsyncSession, user) -> bool:
    if user is None:
        return True
    user_permissions = await get_user_permissions(
        db, user, getattr(user, "active_position_id", None),
    )
    return perms.STOCK_VALUATION_VIEW in user_permissions


def _apply_warehouse_scope(stmt, column, warehouse_ids: set[int] | None):
    return stmt if warehouse_ids is None else stmt.where(column.in_(warehouse_ids))


def costed_value_sum(qty_col, rate_col, price_col):
    """The one expression for what stock on hand is worth.

    A balance row that was never costed carries `valuation_rate` 0 — a GRN raised
    against an indent has no price to quote. Zero is not "worthless", it is "not
    known here", so the item's last costed price stands in. That is what
    get_stock_valuation() has always done in Python; the two SQL callers summed
    `total_qty * valuation_rate` with no fallback and so reported a SMALLER number
    than Inventory > Overview for the very same stock. One expression, three
    screens, so they cannot drift apart again.

    Takes columns rather than a model so it works over a subquery as well as over
    Stock itself. `price_col` must be reached by an OUTER join — an inner join here
    would silently drop balance rows whose item is missing and change the count.
    """
    return func.coalesce(func.sum(qty_col * case(
        (or_(rate_col.is_(None), rate_col == 0), func.coalesce(price_col, 0)),
        else_=rate_col,
    )), 0)


# ---------------- stock: the single mutation point ----------------

async def default_warehouse_for_facility(db: AsyncSession, facility_id: int) -> Warehouse:
    """The whs_warehouses row that stocks an HCM facility.

    Callers that only know a facility land here. One is created on first use if the
    facility has no warehouse yet, so a receipt is never blocked by missing master data.
    """
    warehouse = (await db.execute(
        select(Warehouse).where(Warehouse.facility_id == facility_id,
                                Warehouse.is_active.is_(True))
        .order_by(Warehouse.id).limit(1)
    )).scalar_one_or_none()
    if warehouse is not None:
        return warehouse

    facility = await db.get(HcmFacility, facility_id)
    warehouse = Warehouse(
        code=f"FAC-{facility_id}",
        name=facility.name if facility else f"Facility {facility_id}",
        facility_id=facility_id,
        facility_name=facility.name if facility else None,
    )
    db.add(warehouse)
    await db.flush()
    return warehouse


async def move_stock(db: AsyncSession, item_id: int, qty, direction: str,
                     ref_type: str, ref_id: int, ref_no: str, user,
                     warehouse_id: int | None = None, facility_id: int | None = None,
                     bin_id: int = NO_BIN, batch_id: int = NO_BATCH,
                     project_id: int = NO_PROJECT, rate=None,
                     serial_numbers: list[str] | None = None) -> Stock:
    """The ONLY function that changes stock. Always writes a stk_ledger row.

    Either warehouse_id or facility_id must be given; a facility resolves to its
    default warehouse, so callers that only know a facility keep working.

    `rate` is the unit cost the goods arrived at, and only means anything on an
    inward move. It belongs here rather than in the GRN because valuation lives on
    `stk_balance`, and rule 7 says nothing but this function assigns to that table.
    Without it every balance row kept `valuation_rate = 0` and the warehouse read
    "Stock value on hand ₹ 0" no matter how much had been received.

    `serial_numbers` names the UNITS this movement carried — the codes the warehouse
    module claimed off `whs_serial_numbers` for this leg. Passed in rather than read
    here because inventory is the base module and may not touch a `whs_` table
    (rule 5). Omitted (None) it falls back to the lot's own `stk_balance.serial_number`,
    which is what every caller did before and is still right for a move that names no
    units of its own. Without it the ledger's `serial_numbers` column was NULL on
    every row ever written, because that fallback column is NULL on every balance row.
    """
    qty = _d(qty)
    if qty <= 0:
        raise ValidationError("Stock movement quantity must be positive")

    if warehouse_id is None:
        if facility_id is None:
            raise ValidationError("move_stock needs a warehouse_id or a facility_id")
        warehouse_id = (await default_warehouse_for_facility(db, facility_id)).id

    bin_id, batch_id, project_id = bin_id or NO_BIN, batch_id or NO_BATCH, \
        project_id or NO_PROJECT
    batch_no, expiry_date = await _batch_snapshot(db, batch_id)

    # stk_balance.item_id is a hard FK to mst_items. Inserting a row for an item that
    # is not there raised a bare IntegrityError from deep inside the flush — the
    # putaway-confirm 500. Check first so the caller is told which item is missing
    # instead of being handed a driver error, and so nothing half-posts.
    item = await db.get(Item, item_id)
    if item is None:
        raise ValidationError(
            f"Item {item_id} does not exist in the item master, so no stock movement "
            f"can be recorded against it. Fix the document's item before retrying."
        )
    warehouse = await db.get(Warehouse, warehouse_id)
    if warehouse is None:
        raise ValidationError(f"Warehouse {warehouse_id} does not exist")

    # The bin's code, for the same reason the warehouse's and the item's names are
    # read here: every name on a stock row and on a ledger row is a SNAPSHOT, so the
    # row still reads correctly after somebody renames the thing. `bin_code` was the
    # one nobody filled — balance rows got theirs later from the warehouse module and
    # ledger rows never got one at all, which is why the Bin column on the ledger
    # screen was empty on every row ever written.
    #
    # Raw SQL, not the model: `whs_warehouse_locations` belongs to the warehouse
    # module, and inventory is the base module that imports no module (rule 5). The
    # same dodge `rbac/service.py` uses to read `inv_position_locations`.
    bin_code = None
    if bin_id and bin_id != NO_BIN:
        bin_code = await db.scalar(
            text("SELECT code FROM whs_warehouse_locations WHERE id = :bin_id"),
            {"bin_id": bin_id},
        )

    stock = (await db.execute(
        select(Stock).where(Stock.item_id == item_id,
                            Stock.warehouse_id == warehouse_id,
                            Stock.bin_id == bin_id,
                            Stock.batch_id == batch_id,
                            Stock.project_id == project_id)
        .with_for_update()
    )).scalar_one_or_none()

    if stock is None:
        stock = Stock(warehouse_id=warehouse_id,
                      warehouse_name=warehouse.name,
                      item_id=item_id,
                      item_code=item.code,
                      item_name=item.name,
                      uom_code=item.uom_code,
                      bin_id=bin_id, bin_code=bin_code,
                      batch_id=batch_id, batch_no=batch_no,
                      expiry_date=expiry_date, project_id=project_id,
                      available_qty=Decimal("0"), total_qty=Decimal("0"))
        try:
            # Nested so a lost race rolls back only this INSERT. Two putaways into the
            # same item/warehouse/bin/batch/project both see no row, both insert, and
            # the second hits uq_stk_balance_item_wh_bin_batch_proj. The row the winner
            # created is the one we wanted, so re-read it and carry on. The add() has to
            # happen inside the savepoint, or the rollback leaves it pending and the
            # next flush retries the same failing INSERT.
            async with db.begin_nested():
                db.add(stock)
                await db.flush()
        except IntegrityError:
            stock = (await db.execute(
                select(Stock).where(Stock.item_id == item_id,
                                    Stock.warehouse_id == warehouse_id,
                                    Stock.bin_id == bin_id,
                                    Stock.batch_id == batch_id,
                                    Stock.project_id == project_id)
                .with_for_update()
            )).scalar_one_or_none()
            if stock is None:
                raise
    elif batch_id != NO_BATCH and batch_no is not None:
        # Repair older snapshot rows when their next real stock movement touches them.
        stock.batch_no = batch_no
        stock.expiry_date = expiry_date

    delta = qty if direction == StockDirection.IN.value else -qty
    new_balance = (stock.available_qty or Decimal("0")) + delta
    if new_balance < 0:
        raise ValidationError("Insufficient stock for this movement")
    stock.available_qty = new_balance
    # total = what is on hand: free, spoken for but not yet issued, and in flight.
    # `transit_qty` was left out of this sum, so anything that ever set it would have
    # watched the quantity vanish from `total_qty` on the very next movement — while
    # `get_item_availability` went on reporting it. Nothing writes transit today, so
    # this is the latent case being closed, not a live correction.
    stock.total_qty = (new_balance
                       + (stock.reserved_qty or Decimal("0"))
                       + (stock.transit_qty or Decimal("0")))
    stock.last_movement_at = utcnow()

    unit_cost = _d(rate) if rate is not None else Decimal("0")
    if direction == StockDirection.IN.value and unit_cost <= 0:
        # No rate on the document. A GRN raised against an indent rather than a PO has
        # no price to quote, and leaving the cost at zero is not "unknown", it is a
        # claim that the goods are worthless — which is what put ₹0 against real stock
        # and made the value tile meaningless. Fall back to the last known cost for
        # the item (`mst_items.purchase_price`, written here on every priced inward),
        # so the valuation is the best figure the system actually holds.
        unit_cost = _d(getattr(item, "purchase_price", None) or 0)
    if direction == StockDirection.IN.value and unit_cost > 0:
        # Weighted average, not "latest wins": a hundred units bought at 10 and ten
        # at 100 are worth 1,910, and overwriting the rate would call them 11,000.
        held = stock.total_qty - qty
        previous = _d(stock.valuation_rate)
        stock.valuation_rate = (
            ((held * previous) + (qty * unit_cost)) / stock.total_qty
            if stock.total_qty > 0 and held > 0 and previous > 0
            else unit_cost
        )
        # The item-level fallback the masters overhaul kept for exactly this: a
        # cost for screens that value stock without a balance row to read.
        item.purchase_price = unit_cost

    # stk_balance.stock_value was never written — only the rate was — so the column
    # stayed 0 on every row and the Value column read "Not costed" against stock that
    # had a perfectly good rate beside it. Value is rate * what is on hand, restated
    # on every move so the two can never disagree.
    posted_rate = _d(stock.valuation_rate) or _d(getattr(item, "purchase_price", None) or 0)
    stock.stock_value = (stock.total_qty * posted_rate).quantize(Decimal("0.01"))

    db.add(StockMovement(
        warehouse_id=warehouse_id,
        warehouse_name=stock.warehouse_name,
        item_id=item_id, item_code=stock.item_code, item_name=stock.item_name,
        uom_code=stock.uom_code,
        # bin_code as well as bin_id: every other name on this row is snapshotted
        # (warehouse, item, batch) because a ledger row has to still read correctly
        # after the thing it names is renamed. The bin was the one that was not, so
        # the Bin column on the ledger screen was blank on every row ever written.
        # `or stock.bin_code`: a balance row that predates this carries the code the
        # warehouse module stamped on it later, and that is still the right name.
        bin_id=bin_id, bin_code=bin_code or stock.bin_code,
        batch_id=batch_id, batch_no=batch_no, project_id=project_id,
        direction=direction, quantity=qty, balance_after=new_balance,
        rate=posted_rate,
        value=(qty * posted_rate).quantize(Decimal("0.01")),
        # The units this leg carried, when the caller knows them. `is not None` and
        # not `or`: an empty list is a caller saying "this move named no units", and
        # must not silently fall back to the lot's.
        serial_numbers=(serial_numbers if serial_numbers is not None
                        else stock.serial_number),
        ref_type=ref_type, ref_id=ref_id, ref_no=ref_no,
        created_by_id=user.id, created_by_name=user.full_name,
    ))
    await db.flush()

    # Warehouse-wide availability after this move, and what it was a moment ago.
    if direction == StockDirection.OUT.value:
        after = await _available_at(db, item_id, warehouse_id)
        await notify_if_below_minimum(db, item_id, warehouse_id,
                                      after + float(qty), after)

    # FIXED 2026-08-21 — an allocation parked on AWAITING_PROCUREMENT only ever woke
    # from TWO doorways: warehouse putaway, and a receipt against the MR its own
    # shortfall raised. Stock reaching the shelf any other way — a transfer in, a
    # return to stock, an adjustment, a GRN posted through another path — left the
    # allocation asleep, so the indent stayed out of the fulfilment queue and could
    # not be edited with the goods sitting in the bin. That is the bug that has come
    # back over and over, once per doorway.
    #
    # Here because this is the ONE function every stock increase passes through
    # (rule 7), so there is no doorway left to miss. It is deliberately not gated on
    # ref_type: how the goods arrived is exactly the lineage that was wrong to care
    # about. `reopen_for_available_stock` is idempotent and tier-filtered — an inward
    # move at a LIP or MDP wakes nothing, because that stock is not the warehouse's to
    # give — and it returns immediately when no allocation is parked on the item.
    if direction == StockDirection.IN.value:
        # Imported here, not at module load: `allocations` imports this file for its
        # MR helper, and a top-level import would close the loop.
        from app.modules.inventory import allocations

        # No `on_approved` to pass: inventory may not import warehouse (rule 5). The
        # warehouse registers its handoff on `allocations.ON_APPROVED_HOOK` at import
        # and the reopen falls back to it, so an allocation whose ladder self-approves
        # still gets its fulfilment drafts from this doorway as from the others.
        await allocations.reopen_for_available_stock(db, {item_id})
    return stock


def take_units(codes: list[str] | None, count) -> list[str] | None:
    """Pop the first `count` unit codes off `codes`, mutating it.

    One document line can be satisfied from several balance rows, and each of those
    slices writes its OWN ledger row. Handing every slice the line's whole code list
    would report the same unit as having moved three times, so the list is consumed
    front-to-back and each slice keeps only its share. `None` in, `None` out: a caller
    that names no units still gets the old fallback behaviour.
    """
    if codes is None:
        return None
    wanted = int(_d(count))
    taken = codes[:wanted]
    del codes[:wanted]
    return taken


async def move_stock_out(
    db: AsyncSession,
    item_id: int,
    qty,
    *,
    ref_type: str,
    ref_id: int,
    ref_no: str,
    user,
    warehouse_id: int,
    project_id: int = NO_PROJECT,
    bin_id: int | None = None,
    batch_id: int | None = None,
    serial_numbers: list[str] | None = None,
) -> None:
    """Issue stock across matching balance rows using move_stock() for every slice.

    A document that does not specify a bin means "pick from available stock", not
    "bulk bin 0". This matters after put-away, when valid stock no longer sits in the
    bulk balance.

    `serial_numbers` is the units the caller claimed for this whole quantity; it is
    split across the slices in order. The list is COPIED before it is consumed, so a
    caller can pass the same line's list twice without it emptying underneath them.
    """
    wanted = _d(qty)
    if wanted <= 0:
        raise ValidationError("Stock movement quantity must be positive")

    stmt = select(Stock).where(
        Stock.item_id == item_id,
        Stock.warehouse_id == warehouse_id,
        Stock.project_id == (project_id or NO_PROJECT),
        Stock.available_qty > 0,
    )
    if bin_id is not None:
        stmt = stmt.where(Stock.bin_id == (bin_id or NO_BIN))
    if batch_id is not None:
        stmt = stmt.where(Stock.batch_id == (batch_id or NO_BATCH))
    rows = list((await db.execute(
        stmt.order_by(
            Stock.expiry_date.is_(None),
            Stock.expiry_date.asc(),
            Stock.bin_id,
            Stock.id,
        ).with_for_update()
    )).scalars().all())

    available = sum((row.available_qty or Decimal("0") for row in rows), Decimal("0"))
    if available < wanted:
        raise ValidationError(
            f"Insufficient stock for this movement: {available} available, {wanted} required"
        )

    remaining = wanted
    pool = list(serial_numbers) if serial_numbers is not None else None
    for row in rows:
        if remaining <= 0:
            break
        take = min(remaining, row.available_qty or Decimal("0"))
        await move_stock(
            db,
            item_id=item_id,
            qty=take,
            direction=StockDirection.OUT.value,
            ref_type=ref_type,
            ref_id=ref_id,
            ref_no=ref_no,
            user=user,
            warehouse_id=warehouse_id,
            bin_id=row.bin_id,
            batch_id=row.batch_id,
            project_id=row.project_id,
            serial_numbers=take_units(pool, take),
        )
        remaining -= take


async def transfer_stock(db: AsyncSession, item_id: int, qty, user,
                         from_warehouse_id: int, to_warehouse_id: int,
                         from_project_id: int = NO_PROJECT,
                         to_project_id: int = NO_PROJECT,
                         ref_no: str | None = None) -> None:
    """Move quantity between warehouses or projects as two balanced ledger rows.

    This is how stock changes project: two rows, and mst_items is never touched.
    """
    if (from_warehouse_id, from_project_id) == (to_warehouse_id, to_project_id):
        raise ValidationError("Transfer source and destination are the same")
    if await db.get(Warehouse, from_warehouse_id) is None \
            or await db.get(Warehouse, to_warehouse_id) is None:
        raise NotFoundError("Transfer warehouse not found")

    # OUT first: if the source is short, it raises before anything is credited.
    await move_stock(db, item_id=item_id, qty=qty,
                     direction=StockDirection.OUT.value, ref_type=RefType.TRANSFER.value,
                     ref_id=to_warehouse_id, ref_no=ref_no, user=user,
                     warehouse_id=from_warehouse_id, project_id=from_project_id)
    await move_stock(db, item_id=item_id, qty=qty,
                     direction=StockDirection.IN.value, ref_type=RefType.TRANSFER.value,
                     ref_id=from_warehouse_id, ref_no=ref_no, user=user,
                     warehouse_id=to_warehouse_id, project_id=to_project_id)


async def _stock_query(db: AsyncSession, item_id: int | None = None,
                       warehouse_id: int | None = None, project_id: int | None = None,
                       bin_id: int | None = None, search: str | None = None,
                       category_id: int | None = None, batch_no: str | None = None,
                       include_zero: bool = False, expiring_in_days: int | None = None,
                       expiry_status: str | None = None, expiry_from: date | None = None,
                       expiry_to: date | None = None, expired_in_last_days: int | None = None,
                       below_reorder: bool = False, user=None):
    """Every filter the stock balance screen offers, applied once.

    The list and its KPI tiles have to agree, so they cannot each build their own
    WHERE clause — the tiles used to be summed in the browser over whichever page had
    been fetched, which made every number a function of the page size.
    """
    warehouse_ids = await _scoped_warehouse_ids(db, user, warehouse_id)
    stmt = _apply_warehouse_scope(select(Stock), Stock.warehouse_id, warehouse_ids)
    if item_id is not None:
        stmt = stmt.where(Stock.item_id == item_id)
    if project_id is not None:
        stmt = stmt.where(Stock.project_id == project_id)
    if bin_id is not None:
        stmt = stmt.where(Stock.bin_id == bin_id)
    if batch_no:
        stmt = stmt.where(Stock.batch_no.like(f"%{batch_no}%"))
    if not include_zero:
        # "Zero stock" is zero AVAILABLE, not zero on hand. A lot whose 40 units are
        # all reserved against an allocation is nothing anybody can draw on, so it read
        # as stock on a screen whose only question is what can be given out — and
        # toggling the filter changed nothing, because total_qty alone is almost never
        # zero in the live data. Both tests, so an emptied lot still goes too.
        stmt = stmt.where(Stock.total_qty > 0, Stock.available_qty > 0)
    if expiring_in_days is not None:
        today_date = utcnow().date()
        cutoff = today_date + timedelta(days=expiring_in_days)
        stmt = stmt.where(Stock.expiry_date.isnot(None), Stock.expiry_date >= today_date, Stock.expiry_date <= cutoff)
    if expiry_status == "expired":
        stmt = stmt.where(Stock.expiry_date.isnot(None), Stock.expiry_date < utcnow().date())
    if expiry_from is not None:
        stmt = stmt.where(Stock.expiry_date >= expiry_from)
    if expiry_to is not None:
        stmt = stmt.where(Stock.expiry_date <= expiry_to)
    if expired_in_last_days is not None:
        today_date = utcnow().date()
        start_date = today_date - timedelta(days=expired_in_last_days)
        stmt = stmt.where(Stock.expiry_date.isnot(None), Stock.expiry_date >= start_date, Stock.expiry_date < today_date)
    if search:
        # One box covers what a store user actually types: item code or name, the batch,
        # the bin, a serial off a label, or a scanned item barcode.
        like = f"%{search}%"
        barcoded = select(Item.id).where(
            or_(Item.barcode_value == search, Item.code == search))
        stmt = stmt.where(or_(
            Stock.item_code.like(like), Stock.item_name.like(like),
            Stock.batch_no.like(like), Stock.bin_code.like(like),
            # serial_number is a JSON list of the units in the lot. Cast to text and
            # LIKE it: scanning a label has to find the lot holding that serial, and
            # a JSON column has no LIKE of its own.
            cast(Stock.serial_number, String).like(like),
            Stock.asset_code.like(like), Stock.consumable_code.like(like),
            Stock.item_id.in_(barcoded),
        ))
    if category_id is not None:
        stmt = stmt.where(Stock.item_id.in_(
            select(Item.id).where(Item.category_id == category_id)))
    if below_reorder:
        # The whole comparison in SQL. It used to select only "items that HAVE a
        # reorder level" and then drop the rest out of the page in Python, which
        # rewrote `total` to the size of the page — page 2 of a below-reorder list
        # showed rows page 1 had already shown, and the count was never the count.
        stmt = stmt.where(Stock.item_id.in_(
            select(Item.id).where(Item.reorder_level > 0)
        )).where(Stock.available_qty < (
            select(Item.reorder_level).where(Item.id == Stock.item_id).scalar_subquery()
        ))
    return stmt


async def list_stock(db: AsyncSession, params: PageParams, item_id: int | None = None,
                     warehouse_id: int | None = None, project_id: int | None = None,
                     bin_id: int | None = None, search: str | None = None,
                     category_id: int | None = None, batch_no: str | None = None,
                     include_zero: bool = False, expiring_in_days: int | None = None,
                     expiry_status: str | None = None, expiry_from: date | None = None,
                     expiry_to: date | None = None, expired_in_last_days: int | None = None,
                     below_reorder: bool = False, user=None) -> dict:
    """The stock balance grid."""
    stmt = await _stock_query(
        db, item_id, warehouse_id, project_id, bin_id, search, category_id, batch_no,
        include_zero, expiring_in_days, expiry_status, expiry_from, expiry_to,
        expired_in_last_days, below_reorder, user=user,
    )

    page = await paginate(db, stmt.order_by(Stock.item_name), params)

    # Category and reorder level live on mst_items, not stk_balance. One lookup per
    # page fills the non-financial display fields.
    ids = {row.item_id for row in page["items"]}
    if ids:
        cols = (await db.execute(
            select(Item.id, Item.category_name, Item.reorder_level, Item.barcode_value)
            .where(Item.id.in_(ids))
        )).all()
        by_id = {c.id: c for c in cols}
        for row in page["items"]:
            item = by_id.get(row.item_id)
            row.category_name = item.category_name if item else None
            row.reorder_level = float(item.reorder_level or 0) if item else 0.0
            row.barcode_value = item.barcode_value if item else None
        await _fill_uom_names(db, page["items"])
    return page


async def _fill_uom_names(db: AsyncSession, rows) -> None:
    """Attach the readable UOM name to rows that carry a snapshot `uom_code`.

    The code is the identity the whole system is keyed on — stk_balance, stk_ledger,
    every PO/GRN line and every export snapshot it — so it can never be renamed to
    tidy up a display. The six oldest masters happen to carry their prefix inside the
    code (`UOM-GMS`, `UOM-L`, `UOM-NOS`) while everything created since is clean
    (`PCS`, `MTR`), which is why one grid printed "12 UOM-GMS" and the next "12 PCS".
    One lookup per page resolves the name; the code goes out unchanged beside it, and
    a code with no master row simply has no name and the screen falls back to it.
    """
    codes = {r.uom_code for r in rows if getattr(r, "uom_code", None)}
    if not codes:
        return
    names = dict((await db.execute(
        select(Uom.code, Uom.name).where(Uom.code.in_(codes))
    )).all())
    for r in rows:
        r.uom_name = names.get(r.uom_code)


async def stock_summary(db: AsyncSession, item_id: int | None = None,
                        warehouse_id: int | None = None, project_id: int | None = None,
                        bin_id: int | None = None, search: str | None = None,
                        category_id: int | None = None, batch_no: str | None = None,
                        include_zero: bool = False, expiring_in_days: int | None = None,
                        expiry_status: str | None = None, expiry_from: date | None = None,
                        expiry_to: date | None = None,
                        expired_in_last_days: int | None = None,
                        below_reorder: bool = False, user=None) -> dict:
    """The four tiles above the stock balance grid, counted over every matching row.

    Same filters as `list_stock`, no LIMIT. The browser cannot do this: it only ever
    holds one page, so "Stock lines 20 / Items 11" was really "rows on this page".
    """
    stmt = await _stock_query(
        db, item_id, warehouse_id, project_id, bin_id, search, category_id, batch_no,
        include_zero, expiring_in_days, expiry_status, expiry_from, expiry_to,
        expired_in_last_days, below_reorder, user=user,
    )
    rows = stmt.subquery()
    today_date = utcnow().date()
    totals = (await db.execute(
        select(
            func.count(rows.c.id),
            func.count(func.distinct(rows.c.item_id)),
            # On hand, including what is reserved — the same figure Stocking Points
            # puts on its "Stock on hand" card, so the two screens can be read against
            # each other. Without it this screen had no quantity at all and the only
            # comparable number was a row count.
            func.coalesce(func.sum(rows.c.total_qty), 0),
            # Same formula as Inventory > Overview and the warehouse dashboard.
            # The join is OUTER so a balance row whose item is missing still counts
            # in the two counts either side of it.
            costed_value_sum(rows.c.total_qty, rows.c.valuation_rate,
                             Item.purchase_price),
            # MySQL has no FILTER clause, so the window is a CASE inside the SUM.
            func.coalesce(func.sum(case((and_(
                rows.c.expiry_date.isnot(None),
                rows.c.expiry_date >= today_date,
                rows.c.expiry_date <= today_date + timedelta(days=30),
            ), 1), else_=0)), 0),
        )
        .select_from(rows)
        .outerjoin(Item, Item.id == rows.c.item_id)
    )).one()

    # "Below reorder" compares stk_balance against mst_items.reorder_level, which is
    # in another table — a join here rather than the per-page fixup list_stock does.
    below = int(await db.scalar(
        select(func.count())
        .select_from(rows)
        .join(Item, Item.id == rows.c.item_id)
        .where(Item.reorder_level > 0, rows.c.available_qty < Item.reorder_level)
    ) or 0)

    # Is the answer above meaningful at all? "Below reorder: 0" is indistinguishable
    # from "no item in the master has a reorder level", and today every one of them is
    # 0 — so the tile reported healthy stock over a question nobody had answered. The
    # screen hides the tile and the filter when this is false rather than printing a
    # reassuring zero.
    reorder_configured = bool(await db.scalar(
        select(func.count()).select_from(Item).where(Item.reorder_level > 0).limit(1)
    ))

    return {
        "stock_lines": int(totals[0] or 0),
        "distinct_items": int(totals[1] or 0),
        "total_qty": float(totals[2] or 0),
        "total_value": float(totals[3] or 0),
        "expiring_30_days": int(totals[4] or 0),
        "below_reorder": below,
        "reorder_configured": reorder_configured,
    }


async def _movement_query(db: AsyncSession, item_id: int | None = None,
                          warehouse_id: int | None = None, direction: str | None = None,
                          ref_type: str | None = None, search: str | None = None,
                          date_from: date | None = None, date_to: date | None = None,
                          user=None):
    """The stock ledger's filters. Same story as `_stock_query` — one WHERE clause,
    shared by the page and by the totals above it."""
    warehouse_ids = await _scoped_warehouse_ids(db, user, warehouse_id)
    stmt = _apply_warehouse_scope(
        select(StockMovement), StockMovement.warehouse_id, warehouse_ids,
    )
    if item_id is not None:
        stmt = stmt.where(StockMovement.item_id == item_id)
    if direction:
        stmt = stmt.where(StockMovement.direction == direction)
    if ref_type:
        stmt = stmt.where(StockMovement.ref_type == ref_type)
    if date_from is not None:
        stmt = stmt.where(StockMovement.txn_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(StockMovement.txn_date < date_to + timedelta(days=1))
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(
            StockMovement.item_code.like(like), StockMovement.item_name.like(like),
            StockMovement.ref_no.like(like), StockMovement.batch_no.like(like),
            # A serial or IMEI off a label is the one thing a store user has in hand
            # when they come to the ledger asking "where did THIS unit go". JSON list,
            # so it is matched as text — same as stk_balance.serial_number.
            cast(StockMovement.serial_numbers, String).like(like),
        ))
    return stmt


async def list_movements(db: AsyncSession, params: PageParams,
                         item_id: int | None = None, warehouse_id: int | None = None,
                         direction: str | None = None, ref_type: str | None = None,
                         search: str | None = None, date_from: date | None = None,
                         date_to: date | None = None, user=None) -> dict:
    """The stock ledger."""
    stmt = await _movement_query(db, item_id, warehouse_id, direction, ref_type,
                                 search, date_from, date_to, user=user)
    page = await paginate(db, stmt.order_by(StockMovement.created_at.desc()), params)

    # The asset / consumable code is generated at putaway and lives on the balance row,
    # not on the ledger. One lookup per page keyed the same way stk_balance is keyed,
    # so a movement shows the code of the exact lot it touched rather than any code
    # the item has ever carried. Rows whose lot has since been emptied and removed
    # simply show nothing — the movement itself is still the record.
    keys = {(r.item_id, r.warehouse_id, r.bin_id, r.batch_id, r.project_id)
            for r in page["items"]}
    codes: dict[tuple, tuple] = {}
    if keys:
        lots = (await db.execute(
            select(Stock.item_id, Stock.warehouse_id, Stock.bin_id, Stock.batch_id,
                   Stock.project_id, Stock.asset_code, Stock.consumable_code,
                   Stock.serial_number)
            .where(Stock.item_id.in_({k[0] for k in keys}),
                   Stock.warehouse_id.in_({k[1] for k in keys}))
        )).all()
        codes = {(l[0], l[1], l[2], l[3], l[4]): (l[5], l[6], l[7]) for l in lots}
    # Which of these items actually carries a serial. `whs_serial_numbers.serial_number`
    # is NOT NULL and UNIQUE, so putaway writes the minted asset / consumable code into
    # it for an item that has no real serial of its own — and that same string then
    # travelled into `stk_ledger.serial_numbers` and surfaced under "Serial / IMEI".
    # Same rule the warehouse applies in `serial_summary`: only a serial-tracked item
    # has serials; for every other item the string IS the unit code and belongs in the
    # asset or the consumable column, which is where it is put below.
    flags = {}
    if keys:
        flags = {r[0]: (bool(r[1]), bool(r[2])) for r in (await db.execute(
            select(Item.id, Item.is_serial_tracked, Item.is_asset)
            .where(Item.id.in_({k[0] for k in keys}))
        )).all()}

    for row in page["items"]:
        asset, consumable, serial = codes.get(
            (row.item_id, row.warehouse_id, row.bin_id, row.batch_id, row.project_id),
            (None, None, None))
        row.asset_code = asset
        row.consumable_code = consumable
        # Ledger rows written before serial_numbers was mapped carry NULL; the lot's
        # own serial is the best answer available for those.
        units = row.serial_numbers or serial
        # Unknown item (deleted master) keeps the old behaviour rather than silently
        # re-filing somebody's serials as consumable codes.
        serial_tracked, is_asset = flags.get(row.item_id, (True, False))
        if serial_tracked:
            row.serial_numbers = units
        else:
            row.serial_numbers = None
            code = ", ".join(units) if units else None
            if is_asset:
                row.asset_code = asset or code
            else:
                row.consumable_code = consumable or code
    return page


async def movement_summary(db: AsyncSession, item_id: int | None = None,
                           warehouse_id: int | None = None, direction: str | None = None,
                           ref_type: str | None = None, search: str | None = None,
                           date_from: date | None = None, date_to: date | None = None,
                           user=None) -> dict:
    """Movements / total in / total out over the whole filtered ledger, not one page."""
    stmt = await _movement_query(db, item_id, warehouse_id, direction, ref_type,
                                 search, date_from, date_to, user=user)
    rows = stmt.subquery()
    in_qty = func.sum(case((rows.c.direction == StockDirection.IN.value, rows.c.quantity), else_=0))
    out_qty = func.sum(case((rows.c.direction == StockDirection.OUT.value, rows.c.quantity), else_=0))
    totals = (await db.execute(
        select(func.count(rows.c.id), func.coalesce(in_qty, 0), func.coalesce(out_qty, 0))
    )).one()
    return {
        "movements": int(totals[0] or 0),
        "total_in": float(totals[1] or 0),
        "total_out": float(totals[2] or 0),
    }


# ---------------- Material Request ----------------

async def get_mr(db: AsyncSession, mr_id: int, user=None) -> MaterialRequest:
    mr = (await db.execute(
        select(MaterialRequest).where(
            MaterialRequest.id == mr_id,
            # Same scope the list applies. A document hidden from the list must
            # not be readable by putting its id in the URL.
            await scope_condition(
                db, user,
                owner_col=MaterialRequest.requested_by_id,
                project_col=MaterialRequest.project_id,
            ) if user is not None else true(),
        )
    )).scalar_one_or_none()
    if not mr:
        raise NotFoundError(f"Material request {mr_id} not found")
    # The RUNG the request is sitting on, not the person holding it. A name answers
    # "who signs next"; the screen's badge asks "where is this", and the ladder rung is
    # what an approver recognises across five regions holding the same post. Read off
    # the frozen `resolved_chain` — the same link the indent journey names its stages
    # from — so a ladder edited today never renames a document already in approval.
    mr.current_stage_name = None
    if mr.status == MRStatus.PENDING_APPROVAL.value:
        instance = await engine_instance_for(db, DocType.MR.value, mr.id)
        chain = (instance.resolved_chain or []) if instance is not None else []
        index = ((instance.current_sequence or 1) - 1) if instance is not None else -1
        link = chain[index] if 0 <= index < len(chain) else None
        if isinstance(link, dict):
            mr.current_stage_name = link.get("role_name") or link.get("position_name")
    return mr


async def mark_mrs_received(db: AsyncSession,
                            receipts: dict[int, Decimal],
                            on_approved=None) -> list[int]:
    """Close every material request whose goods have now reached stock.

    `receipts` is the CUMULATIVE accepted quantity per INDENT LINE, worked out by the
    module that owns the receipt — inventory cannot read a GRN (rule 5), and the caller
    already holds the join. A request is only closed when every one of its lines is
    covered: a part delivery leaves it open, because the rest is still on order.

    Why it exists: "on order" is subtracted from what an indent still owes, so a
    request that stays open forever makes its own shortfall unallocatable — the stock
    arrives, and the indent that asked for it is refused a second allocation because
    the system still believes the goods are coming.

    No permission of its own: it is a consequence of the receipt the caller was already
    entitled to record, and it changes no approval — the request was approved long ago
    and RECEIVED is where an ORDERED one ends.
    """
    if not receipts:
        return []
    mr_ids = (await db.execute(
        select(MaterialRequestItem.mr_id)
        .where(MaterialRequestItem.indent_item_id.in_(list(receipts)))
        .distinct()
    )).scalars().all()
    if not mr_ids:
        return []
    closed: list[int] = []
    for mr in (await db.execute(
        select(MaterialRequest)
        .options(selectinload(MaterialRequest.items))
        .where(
            MaterialRequest.id.in_(mr_ids),
            MaterialRequest.status.in_([
                MRStatus.APPROVED.value, MRStatus.ORDERED.value,
            ]),
        )
    )).scalars().unique().all():
        covered = all(
            _d(receipts.get(line.indent_item_id or 0, 0)) >= _d(line.quantity)
            for line in mr.items
        )
        if covered and mr.items:
            mr.status = MRStatus.RECEIVED.value
            closed.append(mr.id)
            # The allocation that raised this request has been sitting on
            # AWAITING_PROCUREMENT waiting for exactly these goods. Hand it back to its
            # approver rather than leaving the indent to raise a second one.
            if mr.indent_id:
                # Imported here, not at module load: `allocations` imports this file
                # for its MR helper, and a top-level import would close the loop.
                from app.modules.inventory import allocations

                # `on_approved` travels with it: a reopened allocation whose ladder
                # self-approves settles inside that call, and settling means the
                # warehouse's fulfilment draft too. Inventory cannot import warehouse
                # (rule 5), so the caller that owns the receipt supplies the handoff.
                await allocations.reopen_for_receipt(
                    db, mr.indent_id, on_approved)
    return closed


async def list_mrs(db: AsyncSession, params: PageParams, status: str | None = None,
                   indent_id: int | None = None, user=None) -> dict:
    stmt = select(MaterialRequest)
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user,
            owner_col=MaterialRequest.requested_by_id,
            project_col=MaterialRequest.project_id,
        ))
    if status:
        stmt = stmt.where(MaterialRequest.status == status)
    if indent_id is not None:
        stmt = stmt.where(MaterialRequest.indent_id == indent_id)
    return await paginate(db, stmt.order_by(MaterialRequest.created_at.desc()), params)


async def create_mr_from_shortfall(db: AsyncSession, indent_id: int | None,
                                   indent_no: str | None, shortfalls: list[dict],
                                   user, ctx: dict | None = None) -> MaterialRequest:
    """One MR carrying every line an indent could not fill from stock.

    One document, not one per line: procurement buys against a request, and five
    separate MRs for one indent would be five RFQs for the same delivery.
    """
    if not shortfalls:
        raise ValidationError("A material request needs at least one short line")

    ctx = ctx or {}
    if indent_id is not None:
        existing = (await db.execute(
            select(MaterialRequest).where(
                MaterialRequest.indent_id == indent_id,
                MaterialRequest.status != MRStatus.REJECTED.value,
            ).order_by(MaterialRequest.id)
        )).scalars().first()
        if existing is not None:
            # Replaying an approval, or approving a second partial allocation, must
            # not create two purchase demands for the same shortage.
            return existing

    return await _raise_mr(db, indent_id, indent_no, shortfalls, user, ctx)


async def _raise_mr(db: AsyncSession, indent_id: int | None, indent_no: str | None,
                    lines: list[dict], user, ctx: dict) -> MaterialRequest:
    """Write one material request and put it into approval.

    The single writer, shared by the automatic shortfall path above and the manual
    one below. Both doors have to produce the SAME document — same numbering, same
    `engine.start` on DocType.MR, same status arithmetic, same audit row — or
    `act_on_mr` is approving two different shapes and the ladder only governs one
    of them.
    """
    mr = MaterialRequest(
        mr_no=await next_number(db, "mr", project=ctx.get("project_name")),
        mr_date=utcnow().date(),
        indent_id=indent_id, indent_no=indent_no,
        requested_by_id=getattr(user, "id", None),
        requested_by_name=getattr(user, "full_name", None),
        department_id=ctx.get("department_id"),
        department_name=ctx.get("department_name"),
        facility_id=ctx.get("facility_id"),
        project_id=ctx.get("project_id"),
        project_name=ctx.get("project_name"),
        status=MRStatus.DRAFT.value,
        priority=ctx.get("priority") or Priority.NORMAL.value,
        required_by=ctx.get("required_by"),
        remarks=ctx.get("remarks") or (
            f"Raised automatically for {indent_no}" if indent_no else None),
    )
    db.add(mr)
    await db.flush()

    for line_no, line in enumerate(lines, start=1):
        db.add(MaterialRequestItem(
            mr_id=mr.id, line_no=line_no, item_id=line["item_id"],
            item_code=line.get("item_code"), item_name=line.get("item_name"),
            uom_code=line.get("uom_code"), quantity=_d(line["quantity"]),
            project_id=line.get("project_id") or NO_PROJECT,
            indent_item_id=line.get("indent_item_id"),
        ))

    # Straight into approval: nobody types an auto-raised MR, so leaving it in DRAFT
    # would strand it waiting for a human to press submit.
    instance = await engine.start(
        db, doc_type=DocType.MR.value, doc_id=mr.id,
        context={
            "doc_no": mr.mr_no,
            "doc_summary": f"Material request {mr.mr_no}",
            "department_id": mr.department_id,
            # The indent's project, carried down through the allocation: the MR ladder
            # belongs to the project being served, not to whoever approved the
            # allocation that raised it.
            "project_id": mr.project_id,
            "requester_position_id": ctx.get("requester_position_id"),
            "total_quantity": float(sum(_d(s["quantity"]) for s in lines)),
        },
        user=user,
    )
    # The ladder can finish at submit. Recording PENDING_APPROVAL anyway would leave
    # the MR waiting for an approval that already happened and no pending row to make
    # it happen — the same divergence that stranded the allocations.
    if instance.status == InstanceStatus.APPROVED.value:
        mr.status = MRStatus.APPROVED.value
        mr.approved_at = utcnow()
        mr.current_approver_name = None
    else:
        mr.status = MRStatus.PENDING_APPROVAL.value
        await _refresh_mr_approver(db, mr)
    await write_audit(
        db, entity="inv_material_requests", entity_id=mr.id, entity_no=mr.mr_no,
        action=AuditAction.CREATE, actor=user,
        after={"status": mr.status, "indent_no": indent_no, "lines": len(lines)},
        summary=f"Material request raised for {indent_no or 'manual entry'}",
    )
    await rules.safe_fire(
        db,
        "MR_RAISED",
        {
            "mr_id": mr.id,
            "indent_id": indent_id,
            "quantity": float(sum(_d(s["quantity"]) for s in lines)),
            "department_id": mr.department_id,
        },
        doc_type=DocType.MR.value,
        doc_id=mr.id,
    )
    await db.flush()
    return mr


async def create_mr_manual(db: AsyncSession, data: dict, user) -> MaterialRequest:
    """Raise a material request by hand — the allocation screen's per-line button and
    the Create button on the Material Requests screen both land here.

    Exists because the only way to raise an MR used to be the automatic shortfall on
    an allocation, and that fires on what is on the shelf ANYWHERE. Stock sitting in
    LIP points counts as available, so a line the warehouse cannot actually serve was
    never short and never reached procurement, and there was no other door to knock on.

    Deduped per ITEM rather than per indent. The automatic path keeps one MR per
    indent because it writes every short line at once; a person raising one line at a
    time is not replaying that, so the rule that matters here is the one that stops
    the same material being bought twice. Raising against an item already sitting on
    an open request is refused, and named, so the answer is the existing document
    rather than a second RFQ for the same delivery.

    A new document every time, never an append: the first request is already in front
    of an approver, and adding lines underneath them would change what they are
    signing after they were asked. Quantities on a pending MR are changed by the
    approver, through `revise_mr_items`, which is gated on approve for that reason.
    """
    lines = data.get("items") or []
    if not lines:
        raise ValidationError("A material request needs at least one line")

    indent_id = data.get("indent_id")
    indent_no = data.get("indent_no")

    # The indent belongs to another module, so its header is never read from here
    # (rule 5). Everything an MR needs about it is already mirrored on inventory's own
    # allocation row, which is written when the indent reaches this module.
    allocation = None
    if indent_id is not None:
        allocation = (await db.execute(
            select(Allocation)
            .where(Allocation.indent_id == indent_id)
            .order_by(Allocation.id.desc())
        )).scalars().first()
        if allocation is not None:
            indent_no = indent_no or allocation.indent_no

        claimed = (await db.execute(
            select(MaterialRequest.mr_no, MaterialRequestItem.item_id)
            .join(MaterialRequestItem,
                  MaterialRequestItem.mr_id == MaterialRequest.id)
            .where(MaterialRequest.indent_id == indent_id,
                   MaterialRequest.status != MRStatus.REJECTED.value)
        )).all()
        already = {item_id: mr_no for mr_no, item_id in claimed}
        clash = [already[line["item_id"]] for line in lines
                 if line["item_id"] in already]
        if clash:
            raise ValidationError(
                f"Already requested on {', '.join(sorted(set(clash)))}. "
                "Change the quantity there rather than raising a second request."
            )

    project_id = getattr(user, "project_id", None)
    resolved = []
    for line in lines:
        quantity = _d(line.get("quantity"))
        if quantity <= 0:
            raise ValidationError("Every line needs a quantity above zero")
        item = await db.get(Item, line["item_id"])
        if item is None:
            raise NotFoundError(f"Item {line['item_id']} not found")
        resolved.append({
            # FIXED 2026-08-21 — `item` is the MASTER row (`mst_items`), whose columns
            # are `code` and `name`. Reading `item_code`/`item_name` off it raised
            # AttributeError and 500'd every manual material request. The snapshot keys
            # keep the document's own names; only the source attributes were wrong.
            "item_id": item.id, "item_code": item.code,
            "item_name": item.name, "uom_code": item.uom_code,
            "quantity": quantity,
            "project_id": line.get("project_id") or project_id or NO_PROJECT,
            "indent_item_id": line.get("indent_item_id"),
        })

    mr = await _raise_mr(db, indent_id, indent_no, resolved, user, {
        "department_id": (getattr(allocation, "department_id", None)
                          or getattr(user, "department_id", None)),
        "department_name": getattr(user, "department_name", None),
        "project_id": project_id,
        "project_name": getattr(user, "project_name", None),
        "priority": data.get("priority"),
        "required_by": data.get("required_by"),
        "remarks": data.get("remarks"),
        # Same key the automatic path passes, so the ladder resolves the raiser's
        # reporting line identically whichever door the request came through.
        "requester_position_id": getattr(user, "active_position_id", None),
    })
    # `_raise_mr` only flushes: on the automatic path it is one step inside the
    # allocation's transaction. This door is the whole transaction.
    await db.commit()
    return mr


async def _refresh_mr_approver(db: AsyncSession, mr: MaterialRequest) -> None:
    approvers = await engine.current_approvers(db, DocType.MR.value, mr.id)
    mr.current_approver_name = ", ".join(a.full_name for a in approvers) or None


async def act_on_mr(db: AsyncSession, mr_id: int, action: str, user,
                    comments: str = "") -> MaterialRequest:
    """APPROVE / REJECT. Engine owns the chain; this module owns the status."""
    mr = await get_mr(db, mr_id)
    if mr.status != MRStatus.PENDING_APPROVAL.value:
        raise ValidationError(
            f"Material request is not awaiting approval (status {mr.status})")

    before = mr.status
    instance = await engine.act(
        db, DocType.MR.value, mr.id, action, user, comments,
        context={"doc_no": mr.mr_no, "department_id": mr.department_id},
    )

    if instance.status == InstanceStatus.APPROVED.value:
        mr.status = MRStatus.APPROVED.value
        mr.approved_at = utcnow()
        mr.current_approver_name = None
        await rules.safe_fire(
            db,
            "MR_APPROVED",
            {
                "mr_id": mr.id,
                "indent_id": mr.indent_id,
                "priority": mr.priority,
                "department_id": mr.department_id,
            },
            doc_type=DocType.MR.value,
            doc_id=mr.id,
        )
    elif instance.status == InstanceStatus.REJECTED.value:
        mr.status = MRStatus.REJECTED.value
        mr.current_approver_name = None
    else:
        await _refresh_mr_approver(db, mr)

    await write_audit(
        db, entity="inv_material_requests", entity_id=mr.id, entity_no=mr.mr_no,
        action=AuditAction.UPDATE, actor=user,
        before={"status": before}, after={"status": mr.status},
        summary=f"{action.title()} material request",
    )
    await db.commit()
    await db.refresh(mr)
    return mr


async def revise_mr_items(db: AsyncSession, mr_id: int, lines: list[dict], user,
                          comments: str = "") -> MaterialRequest:
    """Change how much an MR asks for, before it is signed.

    The shortfall that raised this document is what stock could not cover on the day —
    it is a starting figure, not a purchase decision. Procurement routinely buys a
    round case rather than the exact 7 that were short, or trims a line it knows is
    already on its way. Without this the only way to change the number was to reject
    the whole request and re-run the allocation.

    PENDING_APPROVAL only, for the same reason the allocation revise is: an approved MR
    is what procurement raises a PO against, and moving the quantity underneath a PO
    would leave the two disagreeing about what was bought. A rejected one is history.
    """
    mr = await get_mr(db, mr_id, user=user)
    if mr.status != MRStatus.PENDING_APPROVAL.value:
        raise ValidationError(
            f"Material request is not awaiting approval (status {mr.status})")
    if not lines:
        raise ValidationError("Nothing to change")

    rows = {row.id: row for row in (await db.execute(
        select(MaterialRequestItem).where(MaterialRequestItem.mr_id == mr.id)
    )).scalars().all()}

    changed: list[dict] = []
    for line in lines:
        row = rows.get(line["id"])
        if row is None:
            raise ValidationError(f"Line {line['id']} is not on {mr.mr_no}")
        quantity = _d(line["quantity"])
        if quantity <= Decimal("0"):
            raise ValidationError(
                f"{row.item_code or 'Line'}: quantity must be more than zero. "
                f"Reject the request instead of asking for nothing.")
        # Already-ordered units are a fact, not a proposal. Cutting the line below them
        # would ask procurement to un-buy something.
        if quantity < _d(row.ordered_quantity):
            raise ValidationError(
                f"{row.item_code or 'Line'}: {row.ordered_quantity} already ordered, "
                f"so it cannot be cut to {quantity}.")
        if quantity == _d(row.quantity):
            continue
        changed.append({"line_id": row.id, "item_code": row.item_code,
                        "from": float(_d(row.quantity)), "to": float(quantity)})
        row.quantity = quantity

    if not changed:
        return mr

    await write_audit(
        db, entity="inv_material_requests", entity_id=mr.id, entity_no=mr.mr_no,
        action=AuditAction.UPDATE, actor=user,
        after={"revisions": changed, "comments": comments},
        summary=f"Quantities revised on {mr.mr_no} by "
                f"{getattr(user, 'full_name', '')}".strip(),
    )
    logger.info("MR %s revised by %s: %s", mr.mr_no, getattr(user, "id", None), changed)
    await db.commit()
    await db.refresh(mr)
    return mr


async def mr_item_claims(db: AsyncSession, mr_id: int, item_id: int) -> dict:
    """Who ELSE is asking for this item, itemised — the MR answer to the question the
    allocation screen answers with `allocations.competing_claims`.

    The allocation version counts claims against the SHELF, because that is what an
    allocator is spending. An MR spends nothing on the shelf; it creates purchase
    demand. So the competing documents here are the other open material requests, and
    the number that matters is how much more of this item the company is already about
    to buy — which is exactly what stops the same shortage being ordered twice.

    Not REJECTED and not this request. `ordered_quantity` rides along so a line already
    covered by a PO reads differently from one still waiting for a buyer.
    """
    from app.modules.indents.models import Indent

    rows = (await db.execute(
        select(
            MaterialRequest.id, MaterialRequest.mr_no, MaterialRequest.status,
            MaterialRequest.indent_id, MaterialRequest.indent_no,
            MaterialRequest.requested_by_name, MaterialRequest.department_name,
            MaterialRequest.project_name, MaterialRequest.priority,
            MaterialRequest.created_at,
            MaterialRequestItem.quantity, MaterialRequestItem.ordered_quantity,
        )
        .join(MaterialRequest, MaterialRequest.id == MaterialRequestItem.mr_id)
        .where(MaterialRequestItem.item_id == item_id,
               MaterialRequest.id != mr_id,
               MaterialRequest.status != MRStatus.REJECTED.value)
        .order_by(MaterialRequest.created_at.desc(), MaterialRequest.id.desc())
    )).all()

    claims = [{
        "mr_id": row.id, "mr_no": row.mr_no, "status": row.status,
        "indent_id": row.indent_id, "indent_no": row.indent_no,
        "requested_by_name": row.requested_by_name,
        "department_name": row.department_name,
        "project_name": row.project_name,
        "priority": row.priority,
        "quantity": float(_d(row.quantity)),
        "ordered_quantity": float(_d(row.ordered_quantity)),
        "created_at": row.created_at,
    } for row in rows]

    item = await db.get(Item, item_id)
    total_qty, available_qty, reserved_qty = (await db.execute(
        select(func.coalesce(func.sum(Stock.total_qty), 0),
               func.coalesce(func.sum(Stock.available_qty), 0),
               func.coalesce(func.sum(Stock.reserved_qty), 0))
        .where(Stock.item_id == item_id)
    )).one()

    return {
        "item_id": item_id,
        "item_code": item.code if item else None,
        "item_name": item.name if item else None,
        "uom_code": item.uom_code if item else None,
        "total_qty": float(_d(total_qty)),
        "available_qty": float(_d(available_qty)),
        "reserved_qty": float(_d(reserved_qty)),
        "claimed_total": float(sum((_d(row.quantity) for row in rows), Decimal("0"))),
        # Requests raised outside an indent (a manual top-up) have no indent to count,
        # so this is the number of DISTINCT indents behind the claims, not of claims.
        "indent_count": len({row.indent_id for row in rows if row.indent_id}),
        "claims": claims,
    }


# ---------------- releasing what an indent holds ----------------
#
# There is deliberately no allocate_for_indent() here any more. Deciding how much
# stock an indent gets is a human judgement, not a function -- see allocations.py
# and docs/superpowers/specs/2026-07-26-allocation-is-a-decision-CHANGE.md.

async def release_for_indent(db: AsyncSession, indent_id: int) -> Decimal:
    """Hand back everything an indent was holding — it was rejected or cancelled."""
    return await allocation.release(db, RefType.RESERVATION.value, indent_id)


# ---------------- Stock Adjustments ----------------
#
# An adjustment is the one way stock changes without a document behind it, so the
# approval rules here are the only control on it.
#
# Auto-approve used to be "qty <= 100 AND value <= 5000". `unit_cost` is supplied by
# the caller and is optional, so posting 0 made value 0, the value test always passed,
# and an OUT of 100 units posted instantly with no approver. Repeated, that writes off
# unlimited stock leaving nothing but the adjustment rows behind.
#
# Two changes close it: an outward adjustment is never auto-approved (destroying stock
# always needs a second pair of eyes), and the value test falls back to the item's cost
# when the caller says zero, so a zero cannot buy its way under the threshold.
AUTO_APPROVE_MAX_QTY = Decimal("100")
AUTO_APPROVE_MAX_VALUE = Decimal("5000")


async def _adjustment_line_value(db: AsyncSession, item: Item, qty: Decimal,
                                 unit_cost) -> Decimal:
    """Value a line for the auto-approve test, never trusting a zero cost.

    Falls back to the item's stored purchase price, which is what move_stock() keeps
    updated from real receipts. If nothing knows the cost the line is treated as
    un-valued, and an un-valued line cannot clear a value threshold.
    """
    cost = _d(unit_cost or 0)
    if cost <= 0:
        cost = _d(item.purchase_price or 0)
    if cost <= 0:
        return AUTO_APPROVE_MAX_VALUE + 1   # unknown value never auto-approves
    return qty * cost


async def _post_adjustment_lines(db: AsyncSession, adjustment, adj_items, user) -> None:
    """Post an approved adjustment's lines to stock. Used by both the auto-approve
    path and the explicit approve, so the two cannot drift.

    An outward line goes through move_stock_out(), not move_stock(): the adjustment
    screen has no bin picker, so `bin_id` arrives as NO_BIN. move_stock() reads that
    literally as "the bulk bin", finds nothing there once the goods have been put away,
    and reports "Insufficient stock" against a warehouse that plainly has the item.
    move_stock_out() treats an unspecified bin as "pick from available", which is what
    a storekeeper writing off damage actually means.
    """
    for adj_item in adj_items:
        common = dict(
            ref_type=RefType.ADJUSTMENT.value, ref_id=adjustment.id,
            ref_no=adjustment.adjustment_no, user=user,
            warehouse_id=adjustment.warehouse_id, project_id=adj_item.project_id,
        )
        if adj_item.direction == StockDirection.OUT.value:
            await move_stock_out(
                db, item_id=adj_item.item_id, qty=adj_item.quantity,
                bin_id=adj_item.bin_id or None, batch_id=adj_item.batch_id or None,
                **common,
            )
        else:
            await move_stock(
                db, item_id=adj_item.item_id, qty=adj_item.quantity,
                direction=StockDirection.IN.value,
                bin_id=adj_item.bin_id, batch_id=adj_item.batch_id,
                rate=adj_item.unit_cost, **common,
            )


async def create_stock_adjustment(db: AsyncSession, data, user) -> StockAdjustment:
    """Create a stock adjustment. Outward lines always need approval; small inward
    ones post immediately (see AUTO_APPROVE_MAX_QTY / _VALUE above)."""
    warehouse = await db.get(Warehouse, data.warehouse_id)
    if not warehouse:
        raise NotFoundError(f"Warehouse {data.warehouse_id} not found")
    if not data.items:
        raise ValidationError("A stock adjustment needs at least one line")
    # Rule 3: the reason is an enum, not free text. It was unchecked, so a typo — or
    # anything at all — was stored and reported on as if it were a real category.
    valid_reasons = [r.value for r in AdjustmentReason]
    if data.reason not in valid_reasons:
        raise ValidationError(
            f"Unknown adjustment reason {data.reason!r}. Use one of: "
            f"{', '.join(valid_reasons)}")

    # Validated before anything is written. An adjustment naming an item that is not
    # in the master used to be accepted, snapshot its code as NULL, and then fail on
    # the FK the moment it posted — after the document already had a number.
    items_by_id: dict[int, Item] = {}
    for line in data.items:
        if line.direction not in (StockDirection.IN.value, StockDirection.OUT.value):
            raise ValidationError(
                f"Line direction must be IN or OUT, got {line.direction!r}")
        if _d(line.quantity) <= 0:
            raise ValidationError("Adjustment quantity must be positive")
        if line.item_id not in items_by_id:
            item = await db.get(Item, line.item_id)
            if item is None:
                raise NotFoundError(f"Item {line.item_id} not found in the item master")
            items_by_id[line.item_id] = item

    adj_no = await next_number(db, "adj")
    adjustment = StockAdjustment(
        adjustment_no=adj_no,
        warehouse_id=data.warehouse_id,
        warehouse_name=warehouse.name,
        reason=data.reason,
        status=AdjustmentStatus.PENDING_APPROVAL.value,
        remarks=data.remarks,
        created_by_id=getattr(user, "id", None),
        created_by_name=getattr(user, "full_name", None),
    )
    db.add(adjustment)
    await db.flush()

    total_qty, total_val = Decimal("0"), Decimal("0")
    has_outward = False
    # Collected as we go: adjustment.items is a lazy relationship, and touching it
    # before the row is reloaded raises MissingGreenlet under async.
    adj_items: list[StockAdjustmentItem] = []
    for item_data in data.items:
        item = items_by_id[item_data.item_id]
        qty = _d(item_data.quantity)
        cost = _d(item_data.unit_cost or 0)
        total_qty += qty
        total_val += await _adjustment_line_value(db, item, qty, cost)
        has_outward = has_outward or item_data.direction == StockDirection.OUT.value

        adj_items.append(StockAdjustmentItem(
            adjustment_id=adjustment.id,
            item_id=item_data.item_id,
            item_code=item.code,
            item_name=item.name,
            uom_code=item.uom_code,
            bin_id=item_data.bin_id or NO_BIN,
            batch_id=item_data.batch_id or NO_BATCH,
            project_id=item_data.project_id or NO_PROJECT,
            direction=item_data.direction,
            quantity=qty,
            unit_cost=cost,
            remarks=item_data.remarks,
        ))
    db.add_all(adj_items)

    # Outward stock is never written off unattended, however small: that was the hole
    # a zero unit_cost walked through. Inward stock under both thresholds still posts
    # immediately, so the everyday "found one more box" case is unchanged.
    auto = (not has_outward
            and total_qty <= AUTO_APPROVE_MAX_QTY
            and total_val <= AUTO_APPROVE_MAX_VALUE)
    if auto:
        adjustment.status = AdjustmentStatus.APPROVED.value
        adjustment.approved_by_id = getattr(user, "id", None)
        adjustment.approved_by_name = getattr(user, "full_name", None)
        adjustment.approved_at = utcnow()
        await db.flush()
        await _post_adjustment_lines(db, adjustment, adj_items, user)

    await write_audit(
        db, entity="inv_adjustments", entity_id=adjustment.id,
        entity_no=adjustment.adjustment_no, action=AuditAction.CREATE, actor=user,
        after={"status": adjustment.status, "reason": adjustment.reason,
               "warehouse_id": adjustment.warehouse_id,
               "total_qty": str(total_qty), "lines": len(adj_items)},
        summary=(f"Stock adjustment {adjustment.adjustment_no} raised"
                 + (" and auto-approved" if auto else " for approval")),
    )
    await db.commit()
    # Name the relationship: a bare refresh expires it, so the first caller to read
    # .items (the response model, for one) would lazy-load outside the greenlet.
    await db.refresh(adjustment, ["items"])
    return adjustment


async def act_on_adjustment(db: AsyncSession, adjustment_id: int, action: str, user,
                            remarks: str | None = None) -> StockAdjustment:
    action = (action or "").upper()
    if action not in ("APPROVE", "REJECT"):
        raise ValidationError(f"Invalid action {action}")

    adjustment = (await db.execute(
        select(StockAdjustment)
        # .items is a lazy relationship: reading it after a plain select raises
        # MissingGreenlet under async, so approving an adjustment 500'd before it
        # posted a single movement. Load it with the parent instead.
        .options(selectinload(StockAdjustment.items))
        .where(StockAdjustment.id == adjustment_id)
    )).scalar_one_or_none()
    if not adjustment:
        raise NotFoundError(f"Stock adjustment {adjustment_id} not found")
    if adjustment.status != AdjustmentStatus.PENDING_APPROVAL.value:
        raise ValidationError(f"Adjustment is in status {adjustment.status}, cannot change")

    # Raising and approving are the same permission today (stock.adjust guards both
    # endpoints), so without this the approval step is decoration — the raiser simply
    # approves their own write-off. Splitting the permission needs a new code in
    # platform/rbac, which this module may not edit; refusing self-approval is the part
    # that can be enforced here, and it is the part that actually stops the abuse.
    actor_id = getattr(user, "id", None)
    if actor_id is not None and actor_id == adjustment.created_by_id:
        raise PermissionError_(
            "You raised this adjustment, so you cannot approve or reject it. "
            "Ask another storekeeper or the warehouse in-charge to action it."
        )

    before = {"status": adjustment.status}
    if action == "APPROVE":
        if not adjustment.items:
            raise ValidationError("This adjustment has no lines to post")
        adjustment.status = AdjustmentStatus.APPROVED.value
        adjustment.approved_by_id = actor_id
        adjustment.approved_by_name = getattr(user, "full_name", None)
        adjustment.approved_at = utcnow()
        await _post_adjustment_lines(db, adjustment, adjustment.items, user)
    else:
        adjustment.status = AdjustmentStatus.REJECTED.value
        # No column exists for a rejection reason and the schema is frozen, so it is
        # appended to the remarks the document already carries. Without it a rejection
        # is unexplainable after the fact.
        if remarks:
            who = getattr(user, "full_name", None) or "approver"
            note = f"[Rejected by {who}] {remarks}"
            adjustment.remarks = f"{adjustment.remarks}\n{note}" if adjustment.remarks else note

    await write_audit(
        db, entity="inv_adjustments", entity_id=adjustment.id,
        entity_no=adjustment.adjustment_no, action=AuditAction.UPDATE, actor=user,
        before=before, after={"status": adjustment.status},
        summary=f"Stock adjustment {adjustment.adjustment_no} {adjustment.status.lower()}",
    )
    await db.commit()
    await db.refresh(adjustment, ["items"])
    return adjustment


async def list_adjustments(db: AsyncSession, params: PageParams, warehouse_id: int | None = None,
                           status: str | None = None, user=None) -> dict:
    stmt = select(StockAdjustment)
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user,
            owner_col=StockAdjustment.created_by_id,
            warehouse_col=StockAdjustment.warehouse_id,
            warehouse_ids=await _warehouse_ids_for_user(db, user),
        ))
    if warehouse_id:
        stmt = stmt.where(StockAdjustment.warehouse_id == warehouse_id)
    if status:
        stmt = stmt.where(StockAdjustment.status == status)
    return await paginate(db, stmt.order_by(StockAdjustment.created_at.desc()), params)


async def get_adjustment(db: AsyncSession, adjustment_id: int, user=None) -> StockAdjustment:
    adj = (await db.execute(
        select(StockAdjustment).where(
            StockAdjustment.id == adjustment_id,
            # Same scope the list applies. A document hidden from the list must not
            # be readable by putting its id in the URL.
            await scope_condition(
                db, user,
                owner_col=StockAdjustment.created_by_id,
                warehouse_col=StockAdjustment.warehouse_id,
                warehouse_ids=await _warehouse_ids_for_user(db, user),
            ) if user is not None else true(),
        )
    )).scalar_one_or_none()
    if not adj:
        raise NotFoundError(f"Stock adjustment {adjustment_id} not found")
    return adj


# ---------------- Stock Replenishment ----------------

async def get_stock_detail(db: AsyncSession, stock_id: int, user=None) -> dict:
    """One balance row opened up: every lot of that item in that warehouse, and the
    full walk down the location tree to each one.

    A stk_balance row is already one lot (item + bin + batch + project), so the answer
    to "where is this and what else of it is here" is its siblings in the same
    warehouse. Batch mfg/vendor detail lives in stk_batches, which the warehouse module
    owns and inventory may not import (rule 5) — batch number and expiry are on the
    balance row itself and are what the shelf needs.
    """
    stock = await db.get(Stock, stock_id)
    if stock is None:
        raise NotFoundError(f"Stock row {stock_id} not found")
    warehouse_ids = await _scoped_warehouse_ids(db, user)
    if warehouse_ids is not None and stock.warehouse_id not in warehouse_ids:
        raise PermissionError_("Warehouse is outside your assigned office")

    warehouse = await db.get(Warehouse, stock.warehouse_id)
    locations = {
        loc.id: loc for loc in (await db.execute(
            select(WarehouseLocation)
            .where(WarehouseLocation.warehouse_id == stock.warehouse_id)
        )).scalars().all()
    }

    def path_to(bin_id: int) -> list[str]:
        """Warehouse -> ... -> bin. Ancestry is walked from parent_id, never stored."""
        trail, current, guard = [], locations.get(bin_id), 0
        while current is not None and guard < 20:
            trail.append(current.name or current.code)
            current, guard = locations.get(current.parent_id), guard + 1
        head = warehouse.name if warehouse else str(stock.warehouse_id)
        return [head, *reversed(trail)]

    rows = (await db.execute(
        select(Stock)
        .where(Stock.item_id == stock.item_id, Stock.warehouse_id == stock.warehouse_id)
        .order_by(Stock.expiry_date.is_(None), Stock.expiry_date.asc(), Stock.bin_id)
    )).scalars().all()

    today = ist_today()
    lots = [{
        "id": r.id, "bin_id": r.bin_id, "bin_code": r.bin_code,
        "batch_id": r.batch_id, "batch_no": r.batch_no, "expiry_date": r.expiry_date,
        "days_to_expiry": (_as_date(r.expiry_date) - today).days if r.expiry_date else None,
        "available_qty": float(r.available_qty or 0),
        "reserved_qty": float(r.reserved_qty or 0),
        "total_qty": float(r.total_qty or 0),
        "project_name": r.project_name, "serial_number": r.serial_number,
        "asset_code": r.asset_code,
        "location_path": path_to(r.bin_id),
    } for r in rows]

    return {
        "id": stock.id, "item_id": stock.item_id, "item_code": stock.item_code,
        "item_name": stock.item_name, "uom_code": stock.uom_code,
        "warehouse_id": stock.warehouse_id,
        "warehouse_name": warehouse.name if warehouse else stock.warehouse_name,
        "location_path": path_to(stock.bin_id),
        "total_available": sum(lot["available_qty"] for lot in lots),
        "total_reserved": sum(lot["reserved_qty"] for lot in lots),
        "total_on_hand": sum(lot["total_qty"] for lot in lots),
        "lots": lots,
    }


# ---------------- replenishment rules (per item, per warehouse) ----------------
#
# ponytail: the rules live in one sys_settings JSON row, not a new table — the brief
# forbids schema changes and this is a handful of numbers per item/warehouse. `text`
# holds ~65 KB, i.e. roughly a thousand rules; move to a stk_ table if it ever fills up.
REPLENISHMENT_RULES_KEY = "inventory.replenishment_rules"


def _rule_key(warehouse_id: int, item_id: int) -> str:
    return f"{warehouse_id}:{item_id}"


async def load_replenishment_rules(db: AsyncSession) -> dict[str, dict]:
    raw = await get_setting(db, REPLENISHMENT_RULES_KEY)
    return json.loads(raw) if raw else {}


async def list_replenishment_rules(db: AsyncSession, warehouse_id: int | None = None,
                                   item_id: int | None = None, user=None) -> list[dict]:
    """Every configured rule, with the live availability it is judged against."""
    warehouse_ids = await _scoped_warehouse_ids(db, user, warehouse_id)
    rules_map = await load_replenishment_rules(db)

    out = []
    for rule in rules_map.values():
        if warehouse_id and rule["warehouse_id"] != warehouse_id:
            continue
        if item_id and rule["item_id"] != item_id:
            continue
        if warehouse_ids is not None and rule["warehouse_id"] not in warehouse_ids:
            continue
        item = await db.get(Item, rule["item_id"])
        warehouse = await db.get(Warehouse, rule["warehouse_id"])
        available = await _available_at(db, rule["item_id"], rule["warehouse_id"])
        out.append({
            **rule,
            "item_code": item.code if item else None,
            "item_name": item.name if item else None,
            "uom_code": item.uom_code if item else None,
            "warehouse_name": warehouse.name if warehouse else None,
            "available_qty": available,
            "is_breached": available < rule["min_qty"],
        })
    return sorted(out, key=lambda r: (r["warehouse_name"] or "", r["item_name"] or ""))


async def save_replenishment_rule(db: AsyncSession, data, user) -> dict:
    """Create or replace the rule for one item in one warehouse."""
    if data.max_qty < data.min_qty:
        raise ValidationError("Maximum quantity cannot be below the minimum")
    if await db.get(Item, data.item_id) is None:
        raise NotFoundError(f"Item {data.item_id} not found")
    if await db.get(Warehouse, data.warehouse_id) is None:
        raise NotFoundError(f"Warehouse {data.warehouse_id} not found")

    rules_map = await load_replenishment_rules(db)
    rules_map[_rule_key(data.warehouse_id, data.item_id)] = data.model_dump()
    await set_setting(db, REPLENISHMENT_RULES_KEY, json.dumps(rules_map),
                      value_type="json", category="inventory")
    await write_audit(
        db, entity="sys_settings", entity_id=0, entity_no=REPLENISHMENT_RULES_KEY,
        action=AuditAction.UPDATE, actor=user, after=data.model_dump(),
        summary="Replenishment rule saved")
    await db.commit()
    rows = await list_replenishment_rules(db, data.warehouse_id, data.item_id, user)
    return rows[0]


async def delete_replenishment_rule(db: AsyncSession, warehouse_id: int, item_id: int,
                                    user) -> None:
    rules_map = await load_replenishment_rules(db)
    if rules_map.pop(_rule_key(warehouse_id, item_id), None) is None:
        raise NotFoundError("No replenishment rule for that item and warehouse")
    await set_setting(db, REPLENISHMENT_RULES_KEY, json.dumps(rules_map),
                      value_type="json", category="inventory")
    await write_audit(
        db, entity="sys_settings", entity_id=0, entity_no=REPLENISHMENT_RULES_KEY,
        action=AuditAction.DELETE, actor=user,
        before={"warehouse_id": warehouse_id, "item_id": item_id},
        summary="Replenishment rule removed")
    await db.commit()


async def _available_at(db: AsyncSession, item_id: int, warehouse_id: int) -> float:
    stmt = select(func.coalesce(func.sum(Stock.available_qty), 0)).where(
        Stock.item_id == item_id, Stock.warehouse_id == warehouse_id)
    return float((await db.execute(stmt)).scalar() or 0)


async def notify_if_below_minimum(db: AsyncSession, item_id: int, warehouse_id: int,
                                  before_qty: float, after_qty: float) -> None:
    """Tell the warehouse and inventory when a move takes an item under its minimum.

    Only on the crossing, so a warehouse that is already short is not re-notified on
    every issue. Never raises: a stock movement must not fail because nobody could be
    told about it.
    """
    try:
        rule = (await load_replenishment_rules(db)).get(_rule_key(warehouse_id, item_id))
        if not rule or not (before_qty >= rule["min_qty"] > after_qty):
            return

        warehouse = await db.get(Warehouse, warehouse_id)
        item = await db.get(Item, item_id)
        targets = await recipients_for(db, "STOCK_BELOW_THRESHOLD")
        if warehouse is not None and warehouse.incharge_id:
            targets = targets | {warehouse.incharge_id}
        if not targets:
            return

        await notifications.notify(
            db, targets,
            title=f"{item.code if item else item_id} below minimum",
            body=(f"{after_qty:g} left at {warehouse.name if warehouse else warehouse_id} "
                  f"(minimum {rule['min_qty']:g}, reorder {rule['reorder_qty']:g})."),
            deep_link="/inventory/replenishment",
            entity_type="stk_balance", entity_id=item_id,
        )
    except Exception:  # noqa: BLE001 — see docstring
        logger.exception("Replenishment notification failed for item %s wh %s",
                         item_id, warehouse_id)


async def get_stock_replenishment(db: AsyncSession, warehouse_id: int | None = None,
                                  category_id: int | None = None,
                                  criticality: str | None = None, user=None) -> list[dict]:
    """What needs reordering: rule breaches first, then plain reorder-level shortfalls."""
    warehouse_ids = await _scoped_warehouse_ids(db, user, warehouse_id)
    can_view_valuation = await _can_view_valuation(db, user)

    results = []
    ruled_items = set()
    for rule in await list_replenishment_rules(db, warehouse_id, user=user):
        ruled_items.add(rule["item_id"])
        if not rule["is_breached"]:
            continue
        item = await db.get(Item, rule["item_id"])
        if category_id and (item is None or item.category_id != category_id):
            continue
        results.append({
            "item_id": rule["item_id"],
            "item_code": rule["item_code"], "item_name": rule["item_name"],
            "uom_code": rule["uom_code"],
            "category_name": str(item.category_id) if item and item.category_id else None,
            "warehouse_id": rule["warehouse_id"],
            "warehouse_name": rule["warehouse_name"],
            "available_qty": rule["available_qty"],
            "reorder_level": rule["min_qty"],
            "min_order_qty": rule["reorder_qty"],
            # Top back up to max if one is set, else order the configured reorder batch.
            "suggested_order_qty": max(
                rule["reorder_qty"], rule["max_qty"] - rule["available_qty"]),
            "lead_time_days": getattr(item, "lead_time_days", 7),
            "last_purchase_price": (
                float(getattr(item, "purchase_price", 0) or 0)
                if can_view_valuation else None
            ),
            "criticality": criticality or "HIGH",
        })

    stmt = select(Item).where(Item.is_active.is_(True), Item.reorder_level.isnot(None), Item.reorder_level > 0)
    if category_id:
        stmt = stmt.where(Item.category_id == category_id)

    items = [i for i in (await db.execute(stmt)).scalars().all()
             if i.id not in ruled_items]

    for item in items:
        stock_stmt = select(func.coalesce(func.sum(Stock.available_qty), 0)).where(
            Stock.item_id == item.id,
        )
        stock_stmt = _apply_warehouse_scope(
            stock_stmt, Stock.warehouse_id, warehouse_ids,
        )

        avail_qty = float((await db.execute(stock_stmt)).scalar() or 0)
        reorder_lvl = float(item.reorder_level or 0)

        if avail_qty < reorder_lvl:
            min_order = float(item.min_order_qty or 1)
            reorder_qty = float(item.reorder_qty or (reorder_lvl * 2 - avail_qty))
            suggested = max(reorder_qty, min_order)

            wh_name = None
            if warehouse_id:
                wh = await db.get(Warehouse, warehouse_id)
                wh_name = wh.name if wh else None

            results.append({
                "item_id": item.id,
                "item_code": item.code,
                "item_name": item.name,
                "uom_code": item.uom_code,
                "category_name": str(item.category_id) if item.category_id else None,
                "warehouse_id": warehouse_id,
                "warehouse_name": wh_name,
                "available_qty": avail_qty,
                "reorder_level": reorder_lvl,
                "min_order_qty": min_order,
                "suggested_order_qty": suggested,
                "lead_time_days": getattr(item, "lead_time_days", 7),
                "last_purchase_price": (
                    float(getattr(item, "purchase_price", 0) or 0)
                    if can_view_valuation else None
                ),
                "criticality": criticality or "HIGH",
            })

    return results


# ---------------- Reservations ----------------

async def list_reservations(db: AsyncSession, params: PageParams, item_id: int | None = None,
                            warehouse_id: int | None = None, status: str | None = None,
                            ref_type: str | None = None, ref_id: int | None = None, user=None) -> dict:
    stmt = select(Reservation)
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user,
            owner_col=Reservation.created_by_id,
            project_col=Reservation.project_id,
            warehouse_col=Reservation.warehouse_id,
            warehouse_ids=await _warehouse_ids_for_user(db, user),
        ))
    if item_id:
        stmt = stmt.where(Reservation.item_id == item_id)
    if warehouse_id:
        stmt = stmt.where(Reservation.warehouse_id == warehouse_id)
    if status:
        stmt = stmt.where(Reservation.status == status)
    if ref_type:
        stmt = stmt.where(Reservation.ref_type == ref_type)
    if ref_id:
        stmt = stmt.where(Reservation.ref_id == ref_id)

    return await paginate(db, stmt.order_by(Reservation.created_at.desc()), params)


async def release_reservation_by_id(db: AsyncSession, reservation_id: int) -> dict:
    """Hand one reservation back. The columns are moved by `allocation`, which owns
    them (rule 7); this only decides that it should happen and reports the result."""
    res = await allocation.release_one(db, reservation_id)
    await db.commit()

    return {
        "reservation_id": res.id,
        "released_qty": float(res.quantity),
        "status": res.status,
    }


# ---------------- Live Availability ----------------

async def get_item_availability(db: AsyncSession, item_id: int, project_id: int | None = NO_PROJECT,
                                warehouse_id: int | None = None, user=None) -> dict:
    item = await db.get(Item, item_id)
    if not item:
        raise NotFoundError(f"Item {item_id} not found")

    warehouse_ids = await _scoped_warehouse_ids(db, user, warehouse_id)
    stmt = _apply_warehouse_scope(
        select(Stock).where(Stock.item_id == item_id),
        Stock.warehouse_id,
        warehouse_ids,
    )
    if project_id is not None:
        stmt = stmt.where(Stock.project_id == project_id)

    stocks = list((await db.execute(stmt)).scalars().all())

    strategy = availability.pick_strategy_for(item)
    sorted_stocks = sorted(stocks, key=availability.sort_key(strategy))

    total_avail = sum((s.available_qty or Decimal("0") for s in stocks), Decimal("0"))
    total_res = sum((s.reserved_qty or Decimal("0") for s in stocks), Decimal("0"))
    total_transit = sum((s.transit_qty or Decimal("0") for s in stocks), Decimal("0"))

    batches = [
        {
            "stock_id": s.id,
            "warehouse_id": s.warehouse_id,
            "warehouse_name": s.warehouse_name,
            "bin_id": s.bin_id,
            "bin_code": s.bin_code,
            "batch_id": s.batch_id,
            "batch_no": s.batch_no,
            "expiry_date": s.expiry_date,
            "project_id": s.project_id,
            "available_qty": float(s.available_qty or 0),
            "reserved_qty": float(s.reserved_qty or 0),
        }
        for s in sorted_stocks
    ]

    return {
        "item_id": item.id,
        "item_code": item.code,
        "item_name": item.name,
        "uom_code": item.uom_code,
        "total_available_qty": float(total_avail),
        "total_reserved_qty": float(total_res),
        "total_transit_qty": float(total_transit),
        "pick_strategy": strategy,
        "batches": batches,
    }


# ---------------- Ageing & Valuation ----------------

async def get_stock_ageing(
    db: AsyncSession, warehouse_id: int | None = None, user=None,
) -> dict:
    warehouse_ids = await _scoped_warehouse_ids(db, user, warehouse_id)
    stmt = _apply_warehouse_scope(
        select(Stock).where(Stock.available_qty > 0),
        Stock.warehouse_id,
        warehouse_ids,
    )

    stocks = list((await db.execute(stmt)).scalars().all())
    now_dt = utcnow()
    today_d = now_dt.date()

    rows = []
    b0_30, b31_60, b61_90, b90_plus = Decimal("0"), Decimal("0"), Decimal("0"), Decimal("0")

    for s in stocks:
        last_mvmt = _aware(s.last_movement_at) or now_dt
        days_in_stock = max((now_dt - last_mvmt).days, 0)

        if days_in_stock <= 30:
            age_b = "0-30"
            b0_30 += (s.available_qty or Decimal("0"))
        elif days_in_stock <= 60:
            age_b = "31-60"
            b31_60 += (s.available_qty or Decimal("0"))
        elif days_in_stock <= 90:
            age_b = "61-90"
            b61_90 += (s.available_qty or Decimal("0"))
        else:
            age_b = "90+"
            b90_plus += (s.available_qty or Decimal("0"))

        days_to_exp = None
        exp_b = None
        expiry_d = _as_date(s.expiry_date)
        if expiry_d:
            days_to_exp = (expiry_d - today_d).days
            if days_to_exp < 0:
                exp_b = "EXPIRED"
            elif days_to_exp <= 30:
                exp_b = "0-30"
            elif days_to_exp <= 60:
                exp_b = "31-60"
            elif days_to_exp <= 90:
                exp_b = "61-90"
            else:
                exp_b = "90+"

        rows.append({
            "stock_id": s.id,
            "item_id": s.item_id,
            "item_code": s.item_code,
            "item_name": s.item_name,
            "warehouse_id": s.warehouse_id,
            "warehouse_name": s.warehouse_name,
            "batch_no": s.batch_no,
            "expiry_date": expiry_d,
            "quantity": float(s.available_qty or 0),
            "days_in_stock": days_in_stock,
            "age_bucket": age_b,
            "days_to_expiry": days_to_exp,
            "expiry_bucket": exp_b,
        })

    return {
        "items": rows,
        "bucket_0_30_qty": float(b0_30),
        "bucket_31_60_qty": float(b31_60),
        "bucket_61_90_qty": float(b61_90),
        "bucket_90_plus_qty": float(b90_plus),
    }


async def get_stock_valuation(
    db: AsyncSession, warehouse_id: int | None = None, user=None,
) -> dict:
    """Moving average cost per item per warehouse based on items/stock."""
    if not await _can_view_valuation(db, user):
        raise PermissionError_("Missing permission: stock.valuation.view")
    warehouse_ids = await _scoped_warehouse_ids(db, user, warehouse_id)
    stmt = _apply_warehouse_scope(
        select(Stock).where(Stock.total_qty > 0),
        Stock.warehouse_id,
        warehouse_ids,
    )

    stocks = list((await db.execute(stmt)).scalars().all())
    val_rows = []
    total_portfolio_val = Decimal("0")

    # One lookup instead of one per row: the fallback cost is the only thing wanted
    # from mst_items here, and a 90-row balance meant 90 round trips.
    item_ids = {s.item_id for s in stocks}
    prices = dict((await db.execute(
        select(Item.id, Item.purchase_price).where(Item.id.in_(item_ids))
    )).all()) if item_ids else {}

    for s in stocks:
        # stk_balance.valuation_rate is the costed rate the GRN wrote and is what
        # every other screen multiplies by (the warehouse dashboard, the stock grid,
        # the balance summary). mst_items.purchase_price is only the fallback for a
        # row that was never costed — reading it FIRST is what made this screen
        # disagree with Inventory Overview on the same stock.
        cost = _d(s.valuation_rate) or _d(prices.get(s.item_id) or 0)
        stock_val = (s.total_qty or Decimal("0")) * cost
        total_portfolio_val += stock_val

        val_rows.append({
            "item_id": s.item_id,
            "item_code": s.item_code,
            "item_name": s.item_name,
            "uom_code": s.uom_code,
            "warehouse_id": s.warehouse_id,
            "warehouse_name": s.warehouse_name,
            "total_qty": float(s.total_qty or 0),
            "moving_avg_cost": float(cost),
            "total_stock_value": float(stock_val),
        })

    return {
        "items": val_rows,
        "total_portfolio_value": float(total_portfolio_val),
    }


async def get_near_expiry_alerts(
    db: AsyncSession, days: int = 90, user=None,
) -> list[dict]:
    warehouse_ids = await _scoped_warehouse_ids(db, user)
    cutoff = utcnow().date() + timedelta(days=days)
    today_date = utcnow().date()
    stmt = select(Stock).where(Stock.expiry_date.isnot(None), Stock.expiry_date >= today_date, Stock.expiry_date <= cutoff, Stock.available_qty > 0)
    stmt = _apply_warehouse_scope(stmt, Stock.warehouse_id, warehouse_ids)
    stocks = list((await db.execute(stmt.order_by(Stock.expiry_date.asc()))).scalars().all())

    today_d = utcnow().date()
    alerts = []
    for s in stocks:
        days_rem = (_as_date(s.expiry_date) - today_d).days
        alerts.append({
            "stock_id": s.id,
            "item_id": s.item_id,
            "item_code": s.item_code,
            "item_name": s.item_name,
            "warehouse_id": s.warehouse_id,
            "warehouse_name": s.warehouse_name,
            "batch_no": s.batch_no,
            "expiry_date": s.expiry_date,
            "days_to_expiry": days_rem,
            "quantity": float(s.available_qty or 0),
        })
    return alerts


# ---------------- STO (Stock Transfer Order) ----------------

async def create_sto(db: AsyncSession, data, user) -> StockTransferOrder:
    from_wh = await db.get(Warehouse, data.from_warehouse_id)
    to_wh = await db.get(Warehouse, data.to_warehouse_id)
    if not from_wh or not to_wh:
        raise NotFoundError("Source or destination warehouse not found")

    # What this move IS comes from the two points, never from the request body, so a
    # cross-project transfer cannot be relabelled into something that skips approval.
    # Same-project stays PENDING_APPROVAL for the holder's own sign-off; crossing a
    # project boundary is what pulls in the Inventory Manager.
    kind = locations.classify(
        data.from_warehouse_id, from_wh.warehouse_type,
        data.to_warehouse_id, to_wh.warehouse_type,
    )
    gated = await locations.needs_inventory_manager(
        db, data.from_warehouse_id, data.to_warehouse_id,
    )
    logger.info(
        "STO %s -> %s classified as %s (inventory manager required: %s)",
        data.from_warehouse_id, data.to_warehouse_id, kind.value, gated,
    )

    sto_no = await next_number(db, "sto")
    sto = StockTransferOrder(
        sto_no=sto_no,
        from_warehouse_id=data.from_warehouse_id,
        from_warehouse_name=from_wh.name,
        to_warehouse_id=data.to_warehouse_id,
        to_warehouse_name=to_wh.name,
        from_project_id=data.from_project_id or NO_PROJECT,
        to_project_id=data.to_project_id or NO_PROJECT,
        status=STOStatus.PENDING_APPROVAL.value,
        requested_by_id=getattr(user, "id", None),
        requested_by_name=getattr(user, "full_name", None),
        # The derived kind and the gate are recorded in the remark rather than in a
        # new column: no schema change, and the reason a transfer needed the Inventory
        # Manager stays readable on the document long after the tagging has moved on.
        remarks=" · ".join(filter(None, (
            data.remarks,
            f"[{kind.value}]",
            "Inventory Manager approval required (crosses projects)" if gated else None,
        ))) or None,
    )
    db.add(sto)
    await db.flush()

    for item_data in data.items:
        item = await db.get(Item, item_data.item_id)
        db.add(StockTransferOrderItem(
            sto_id=sto.id,
            item_id=item_data.item_id,
            item_code=item.code if item else None,
            item_name=item.name if item else None,
            uom_code=item.uom_code if item else None,
            requested_qty=_d(item_data.requested_qty),
            remarks=item_data.remarks,
        ))

    await db.flush()
    # Ask the engine, if — and only if — this project configured a Stock Transfer
    # chain on Settings > Approval Flow. `STOCK_TRANSFER` was configurable there and
    # never submitted anywhere, so a chain saved against it was written and never read.
    #
    # Guarded the same way `dispatch_consignment` is: no chain configured (which is
    # every project today) and this is a no-op, the STO stays PENDING_APPROVAL and
    # `approve_sto` decides it exactly as it always has.
    await _start_sto_approval(db, sto, user)
    await db.commit()
    await db.refresh(sto)
    return sto


async def _sto_ladder(db: AsyncSession, sto: StockTransferOrder, user):
    """The configured Stock Transfer chain for this STO, or None."""
    from app.platform.workflow import ladder as wf_ladder

    position_id = getattr(user, "active_position_id", None)
    project_id = sto.from_project_id or None
    if project_id is None:
        project_id, _name = await wf_ladder.project_for(db, position_id, user)
    raiser_role_id = await wf_ladder.role_of_position(db, position_id)
    return await wf_ladder.find_ladder(
        db, project_id, DocType.STOCK_TRANSFER.value, raiser_role_id)


async def _start_sto_approval(db: AsyncSession, sto: StockTransferOrder, user) -> None:
    if await _sto_ladder(db, sto, user) is None:
        return
    position_id = getattr(user, "active_position_id", None)
    instance = await engine.start(
        db, DocType.STOCK_TRANSFER.value, sto.id,
        {
            "doc_no": sto.sto_no,
            "doc_summary": f"Stock transfer {sto.sto_no}",
            "requester_position_id": position_id,
            "project_id": sto.from_project_id or None,
            "from_warehouse_id": sto.from_warehouse_id,
            "to_warehouse_id": sto.to_warehouse_id,
        },
        user,
    )
    if instance.status == InstanceStatus.APPROVED.value:
        # Top of the chain, or "no approval needed": approved the moment it is raised.
        sto.status = STOStatus.APPROVED.value
        sto.approved_by_name = getattr(user, "full_name", None)
        sto.approved_at = utcnow()


async def get_sto(db: AsyncSession, sto_id: int, user=None) -> StockTransferOrder:
    sto = (await db.execute(
        select(StockTransferOrder)
        # .items is lazy, and dispatch/receive both walk it. Without this the walk
        # raises MissingGreenlet under async and the screen only ever showed
        # "The action failed", so no transfer could be dispatched at all.
        .options(selectinload(StockTransferOrder.items))
        .where(
            StockTransferOrder.id == sto_id,
            # Same scope the list applies. A document hidden from the list must
            # not be readable by putting its id in the URL.
            await scope_condition(
                db, user,
                owner_col=StockTransferOrder.requested_by_id,
            ) if user is not None else true(),
        )
    )).scalar_one_or_none()
    if not sto:
        raise NotFoundError(f"STO {sto_id} not found")
    return sto


async def list_stos(db: AsyncSession, params: PageParams, status: str | None = None, user=None) -> dict:
    stmt = select(StockTransferOrder)
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user,
            owner_col=StockTransferOrder.requested_by_id,
        ))
    if status:
        stmt = stmt.where(StockTransferOrder.status == status)
    return await paginate(db, stmt.order_by(StockTransferOrder.created_at.desc()), params)


async def approve_sto(db: AsyncSession, sto_id: int, user,
                      comments: str = "") -> StockTransferOrder:
    """Approve a transfer — through the engine when a chain governs it.

    Without a configured chain this is what it always was: anyone holding the
    permission signs, in one step. With one, the engine decides whether THIS caller is
    on the current rung and whether any rungs remain, and the STO only becomes APPROVED
    when the chain is finished (rule 8 — the engine owns the chain, the module owns the
    document status).
    """
    sto = await get_sto(db, sto_id)
    if sto.status != STOStatus.PENDING_APPROVAL.value:
        raise ValidationError(f"STO is in status {sto.status}, cannot approve")

    instance = await engine_instance_for(db, DocType.STOCK_TRANSFER.value, sto.id)
    if instance is not None and instance.status == InstanceStatus.IN_PROGRESS.value:
        instance = await engine.act(
            db, DocType.STOCK_TRANSFER.value, sto.id,
            ApprovalAction.APPROVED.value, user, comments,
            {"requester_position_id": getattr(user, "active_position_id", None)},
        )
        if instance.status != InstanceStatus.APPROVED.value:
            # More rungs above; the STO waits where it is.
            await db.commit()
            await db.refresh(sto)
            return sto

    sto.status = STOStatus.APPROVED.value
    sto.approved_by_name = getattr(user, "full_name", None)
    sto.approved_at = utcnow()
    await db.commit()
    await db.refresh(sto)
    return sto


async def engine_instance_for(db: AsyncSession, doc_type: str, doc_id: int):
    """The live approval on a document, or None. Read-only — never starts one."""
    from app.platform.workflow.models import Instance as WfInstance

    return (await db.execute(
        select(WfInstance)
        .where(WfInstance.doc_type == doc_type, WfInstance.doc_id == doc_id)
        .order_by(WfInstance.id.desc())
    )).scalars().first()


async def dispatch_sto(db: AsyncSession, sto_id: int, user) -> StockTransferOrder:
    """Take transfer stock out of the source when it physically leaves."""
    sto = await get_sto(db, sto_id)
    if sto.status != STOStatus.APPROVED.value:
        raise ValidationError(f"STO is in status {sto.status}, cannot dispatch")

    for sto_item in sto.items:
        sto_item.dispatched_qty = sto_item.requested_qty
        await move_stock_out(
            db, item_id=sto_item.item_id, qty=sto_item.dispatched_qty,
            ref_type=RefType.STO.value, ref_id=sto.id, ref_no=sto.sto_no, user=user,
            warehouse_id=sto.from_warehouse_id, project_id=sto.from_project_id,
        )

    sto.status = STOStatus.DISPATCHED.value
    sto.dispatched_at = utcnow()
    await db.commit()
    await db.refresh(sto)
    return sto


async def receive_sto(db: AsyncSession, sto_id: int, user) -> StockTransferOrder:
    """Credit the destination when the dispatched transfer is received."""
    sto = await get_sto(db, sto_id)
    if sto.status != STOStatus.DISPATCHED.value:
        raise ValidationError(f"STO is in status {sto.status}, cannot receive")

    for sto_item in sto.items:
        qty = sto_item.dispatched_qty or sto_item.requested_qty
        sto_item.received_qty = qty
        await move_stock(
            db, item_id=sto_item.item_id, qty=qty, direction=StockDirection.IN.value,
            ref_type=RefType.STO.value, ref_id=sto.id, ref_no=sto.sto_no, user=user,
            warehouse_id=sto.to_warehouse_id, project_id=sto.to_project_id,
        )

    sto.status = STOStatus.RECEIVED.value
    sto.received_at = utcnow()
    await db.commit()
    await db.refresh(sto)
    return sto


# ---------------- Cycle Count ----------------

async def create_cycle_count(db: AsyncSession, data, user) -> CycleCount:
    wh = await db.get(Warehouse, data.warehouse_id)
    if not wh:
        raise NotFoundError(f"Warehouse {data.warehouse_id} not found")

    count_no = await next_number(db, "cc")
    cc = CycleCount(
        count_no=count_no,
        warehouse_id=data.warehouse_id,
        warehouse_name=wh.name,
        count_date=data.count_date,
        status=CycleCountStatus.PLANNED.value,
        planned_by_name=getattr(user, "full_name", None),
        remarks=data.remarks,
    )
    db.add(cc)
    await db.flush()

    # Populate snapshot quantities from Stock
    stock_stmt = select(Stock).where(Stock.warehouse_id == data.warehouse_id)
    if data.item_ids:
        stock_stmt = stock_stmt.where(Stock.item_id.in_(data.item_ids))
    stocks = list((await db.execute(stock_stmt)).scalars().all())

    for s in stocks:
        db.add(CycleCountItem(
            cycle_count_id=cc.id,
            item_id=s.item_id,
            item_code=s.item_code,
            item_name=s.item_name,
            uom_code=s.uom_code,
            bin_id=s.bin_id,
            batch_id=s.batch_id,
            snapshot_qty=s.available_qty or Decimal("0"),
        ))

    await db.commit()
    await db.refresh(cc)
    return cc


async def get_cycle_count(db: AsyncSession, cc_id: int, user=None) -> CycleCount:
    cc = (await db.execute(
        select(CycleCount).where(
            CycleCount.id == cc_id,
            # Same scope the list applies. A document hidden from the list must
            # not be readable by putting its id in the URL.
            await scope_condition(
                db, user,
                warehouse_col=CycleCount.warehouse_id,
                warehouse_ids=await _warehouse_ids_for_user(db, user),
            ) if user is not None else true(),
        )
    )).scalar_one_or_none()
    if not cc:
        raise NotFoundError(f"Cycle count {cc_id} not found")
    return cc


async def list_cycle_counts(db: AsyncSession, params: PageParams, warehouse_id: int | None = None,
                           status: str | None = None, user=None) -> dict:
    stmt = select(CycleCount)
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user,
            warehouse_col=CycleCount.warehouse_id,
            warehouse_ids=await _warehouse_ids_for_user(db, user),
        ))
    if warehouse_id:
        stmt = stmt.where(CycleCount.warehouse_id == warehouse_id)
    if status:
        stmt = stmt.where(CycleCount.status == status)
    return await paginate(db, stmt.order_by(CycleCount.created_at.desc()), params)


async def update_cycle_count(db: AsyncSession, cc_id: int, data, user) -> CycleCount:
    cc = await get_cycle_count(db, cc_id)
    if cc.status not in (CycleCountStatus.PLANNED.value,
                         CycleCountStatus.IN_PROGRESS.value):
        raise ValidationError(f"Cycle count is in status {cc.status}, cannot update")

    cc.status = CycleCountStatus.IN_PROGRESS.value
    if data.remarks:
        cc.remarks = data.remarks

    item_map = {item.id: item for item in cc.items}
    for item_upd in data.items:
        cc_item = item_map.get(item_upd.id)
        if cc_item:
            cc_item.counted_qty = _d(item_upd.counted_qty)
            cc_item.variance_qty = cc_item.counted_qty - (cc_item.snapshot_qty or Decimal("0"))
            if item_upd.remarks:
                cc_item.remarks = item_upd.remarks

    await db.commit()
    await db.refresh(cc)
    return cc


async def post_cycle_count(db: AsyncSession, cc_id: int, user) -> CycleCount:
    """Post cycle count variances as stock adjustments via move_stock()."""
    cc = await get_cycle_count(db, cc_id)
    if cc.status != CycleCountStatus.IN_PROGRESS.value:
        raise ValidationError(f"Cycle count is in status {cc.status}, must be IN_PROGRESS to post")

    for item in cc.items:
        if item.counted_qty is None:
            continue
        variance = item.variance_qty or Decimal("0")
        if variance == Decimal("0"):
            continue

        direction = StockDirection.IN.value if variance > 0 else StockDirection.OUT.value
        qty = abs(variance)

        await move_stock(
            db, item_id=item.item_id, qty=qty, direction=direction,
            ref_type=RefType.CYCLE_COUNT.value, ref_id=cc.id, ref_no=cc.count_no, user=user,
            warehouse_id=cc.warehouse_id, bin_id=item.bin_id, batch_id=item.batch_id,
        )

    cc.status = CycleCountStatus.COMPLETED.value
    cc.posted_by_name = getattr(user, "full_name", None)
    cc.posted_at = utcnow()
    await db.commit()
    await db.refresh(cc)
    return cc


# ---------------- Overview KPIs ----------------

async def get_overview_kpis(db: AsyncSession, user=None) -> dict:
    warehouse_ids = await _scoped_warehouse_ids(db, user)
    can_view_valuation = await _can_view_valuation(db, user)
    tot_val = None
    if can_view_valuation:
        val = await get_stock_valuation(db, user=user)
        tot_val = val["total_portfolio_value"]

    reorder = await get_stock_replenishment(db, user=user)
    items_below_reorder = len(reorder)

    exp30 = len(await get_near_expiry_alerts(db, 30, user=user))
    exp60 = len(await get_near_expiry_alerts(db, 60, user=user))
    exp90 = len(await get_near_expiry_alerts(db, 90, user=user))

    available_stmt = _apply_warehouse_scope(
        select(func.coalesce(func.sum(Stock.available_qty), 0)),
        Stock.warehouse_id,
        warehouse_ids,
    )
    reserved_stmt = _apply_warehouse_scope(
        select(func.coalesce(func.sum(Stock.reserved_qty), 0)),
        Stock.warehouse_id,
        warehouse_ids,
    )
    tot_avail = float((await db.execute(available_stmt)).scalar() or 0)
    tot_res = float((await db.execute(reserved_stmt)).scalar() or 0)

    # Dead stock: available > 0 and last_movement_at < today - 60 days
    cutoff_date = utcnow() - timedelta(days=60)
    dead_stmt = select(func.count(Stock.id)).where(Stock.available_qty > 0, or_(Stock.last_movement_at.is_(None), Stock.last_movement_at < cutoff_date))
    dead_stmt = _apply_warehouse_scope(
        dead_stmt, Stock.warehouse_id, warehouse_ids,
    )
    dead_count = int((await db.execute(dead_stmt)).scalar() or 0)

    return {
        "total_stock_value": tot_val,
        "items_below_reorder": items_below_reorder,
        "near_expiry_30_days": exp30,
        "near_expiry_60_days": exp60,
        "near_expiry_90_days": exp90,
        "total_reserved_qty": tot_res,
        "total_available_qty": tot_avail,
        "dead_stock_count": dead_count,
    }


