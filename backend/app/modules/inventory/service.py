"""Inventory business logic. The base module — imports nothing from app.modules.

Physical stock changes go ONLY through move_stock(); reservation columns go ONLY
through allocation.py. Nothing else assigns to stk_balance.
"""
import json
import logging
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import case, func, select, or_, and_, text, true
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.exceptions import NotFoundError, PermissionError_, ValidationError
from app.core.pagination import PageParams, paginate
from app.modules.inventory import allocation, availability, locations
from app.modules.inventory.enums import AdjustmentStatus, STOStatus
from app.modules.inventory.models import (
    NO_BATCH, NO_BIN, NO_PROJECT, MaterialRequest, MaterialRequestItem, Stock,
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
    AdjustmentReason, AuditAction, DocType, IndentStatus, InstanceStatus, MRStatus,
    Priority, RefType, ScopeRung, StockDirection, UserRole as RoleCode,
)
from app.shared.models.base import utcnow
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse, WarehouseLocation
from app.shared.numbering import next_number


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
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


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
                     project_id: int = NO_PROJECT, rate=None) -> Stock:
    """The ONLY function that changes stock. Always writes a stk_ledger row.

    Either warehouse_id or facility_id must be given; a facility resolves to its
    default warehouse, so callers that only know a facility keep working.

    `rate` is the unit cost the goods arrived at, and only means anything on an
    inward move. It belongs here rather than in the GRN because valuation lives on
    `stk_balance`, and rule 7 says nothing but this function assigns to that table.
    Without it every balance row kept `valuation_rate = 0` and the warehouse read
    "Stock value on hand ₹ 0" no matter how much had been received.
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
                      bin_id=bin_id, batch_id=batch_id, batch_no=batch_no,
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
    # total = what is on hand, including what is spoken for but not yet issued.
    stock.total_qty = new_balance + (stock.reserved_qty or Decimal("0"))
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

    db.add(StockMovement(
        warehouse_id=warehouse_id,
        warehouse_name=stock.warehouse_name,
        item_id=item_id, item_code=stock.item_code, item_name=stock.item_name,
        uom_code=stock.uom_code,
        bin_id=bin_id, batch_id=batch_id, batch_no=batch_no, project_id=project_id,
        direction=direction, quantity=qty, balance_after=new_balance,
        ref_type=ref_type, ref_id=ref_id, ref_no=ref_no,
        created_by_id=user.id, created_by_name=user.full_name,
    ))
    await db.flush()

    # Warehouse-wide availability after this move, and what it was a moment ago.
    if direction == StockDirection.OUT.value:
        after = await _available_at(db, item_id, warehouse_id)
        await notify_if_below_minimum(db, item_id, warehouse_id,
                                      after + float(qty), after)
    return stock


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
) -> None:
    """Issue stock across matching balance rows using move_stock() for every slice.

    A document that does not specify a bin means "pick from available stock", not
    "bulk bin 0". This matters after put-away, when valid stock no longer sits in the
    bulk balance.
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
        stmt = stmt.where(Stock.total_qty > 0)
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
            Stock.serial_number.like(like), Stock.asset_code.like(like),
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
    return page


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
            func.coalesce(func.sum(rows.c.total_qty * rows.c.valuation_rate), 0),
            # MySQL has no FILTER clause, so the window is a CASE inside the SUM.
            func.coalesce(func.sum(case((and_(
                rows.c.expiry_date.isnot(None),
                rows.c.expiry_date >= today_date,
                rows.c.expiry_date <= today_date + timedelta(days=30),
            ), 1), else_=0)), 0),
        )
    )).one()

    # "Below reorder" compares stk_balance against mst_items.reorder_level, which is
    # in another table — a join here rather than the per-page fixup list_stock does.
    below = int(await db.scalar(
        select(func.count())
        .select_from(rows)
        .join(Item, Item.id == rows.c.item_id)
        .where(Item.reorder_level > 0, rows.c.available_qty < Item.reorder_level)
    ) or 0)

    return {
        "stock_lines": int(totals[0] or 0),
        "distinct_items": int(totals[1] or 0),
        "total_value": float(totals[2] or 0),
        "expiring_30_days": int(totals[3] or 0),
        "below_reorder": below,
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
    return await paginate(db, stmt.order_by(StockMovement.created_at.desc()), params)


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
    return mr


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

    mr = MaterialRequest(
        mr_no=await next_number(db, "mr"),
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
        remarks=f"Raised automatically for {indent_no}" if indent_no else None,
    )
    db.add(mr)
    await db.flush()

    for line_no, line in enumerate(shortfalls, start=1):
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
            "total_quantity": float(sum(_d(s["quantity"]) for s in shortfalls)),
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
        after={"status": mr.status, "indent_no": indent_no, "lines": len(shortfalls)},
        summary=f"Material request raised for {indent_no or 'manual entry'}",
    )
    await rules.safe_fire(
        db,
        "MR_RAISED",
        {
            "mr_id": mr.id,
            "indent_id": indent_id,
            "quantity": float(sum(_d(s["quantity"]) for s in shortfalls)),
            "department_id": mr.department_id,
        },
        doc_type=DocType.MR.value,
        doc_id=mr.id,
    )
    await db.flush()
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

    today = date.today()
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
    res = await db.get(Reservation, reservation_id, with_for_update=True)
    if not res:
        raise NotFoundError(f"Reservation {reservation_id} not found")
    if res.status != "ACTIVE":
        raise ValidationError(f"Reservation is in status {res.status}, cannot release")

    stock = await db.get(Stock, res.stock_id, with_for_update=True)
    if stock:
        stock.reserved_qty = (stock.reserved_qty or Decimal("0")) - res.quantity
        stock.available_qty = (stock.available_qty or Decimal("0")) + res.quantity

    res.status = "RELEASED"
    res.released_at = utcnow()
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

    await db.commit()
    await db.refresh(sto)
    return sto


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


async def approve_sto(db: AsyncSession, sto_id: int, user) -> StockTransferOrder:
    sto = await get_sto(db, sto_id)
    if sto.status != STOStatus.PENDING_APPROVAL.value:
        raise ValidationError(f"STO is in status {sto.status}, cannot approve")

    sto.status = STOStatus.APPROVED.value
    sto.approved_by_name = getattr(user, "full_name", None)
    sto.approved_at = utcnow()
    await db.commit()
    await db.refresh(sto)
    return sto


async def dispatch_sto(db: AsyncSession, sto_id: int, user) -> StockTransferOrder:
    """Take transfer stock out of the source when it physically leaves."""
    sto = await get_sto(db, sto_id)
    if sto.status != STOStatus.APPROVED.value:
        raise ValidationError(f"STO is in status {sto.status}, cannot dispatch")

    for sto_item in sto.items:
        sto_item.dispatched_qty = sto_item.requested_qty
        await move_stock_out(
            db, item_id=sto_item.item_id, qty=sto_item.dispatched_qty,
            ref_type="STO", ref_id=sto.id, ref_no=sto.sto_no, user=user,
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
            ref_type="STO", ref_id=sto.id, ref_no=sto.sto_no, user=user,
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
        status="PLANNED",
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
    if cc.status not in ("PLANNED", "IN_PROGRESS"):
        raise ValidationError(f"Cycle count is in status {cc.status}, cannot update")

    cc.status = "IN_PROGRESS"
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
    if cc.status != "IN_PROGRESS":
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
            ref_type="CYCLE_COUNT", ref_id=cc.id, ref_no=cc.count_no, user=user,
            warehouse_id=cc.warehouse_id, bin_id=item.bin_id, batch_id=item.batch_id,
        )

    cc.status = "COMPLETED"
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


