"""Reservation: the only code that moves quantity between available_qty and
reserved_qty.

Reserving is NOT a stock movement. Nothing has physically left the shelf, so total_qty
is untouched and no stk_ledger row is written — the ledger row appears when the issue
posts. That is why this deliberately does not go through move_stock(), and why
CLAUDE.md rule 7 is split: physical changes via move_stock(), reservation columns via
this module, and nothing else assigns to stk_balance.
"""
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.modules.inventory import availability
from app.modules.inventory.models import NO_PROJECT, Reservation, Stock
from app.shared.enums import PickStrategy, ReservationStatus
from app.shared.models.base import utcnow

ZERO = Decimal("0")


@dataclass(frozen=True)
class ConsumedStock:
    """The exact stock dimensions released for a physical issue."""

    item_id: int
    warehouse_id: int
    bin_id: int
    batch_id: int
    project_id: int
    quantity: Decimal


def _d(value) -> Decimal:
    return Decimal(str(value))


async def reserve(db: AsyncSession, item_id: int, qty, ref_type: str, ref_id: int,
                  ref_no: str | None, user, *, project_id: int = NO_PROJECT,
                  warehouse_types: list[str] | None = None,
                  warehouse_ids: list[int] | None = None,
                  ref_line_id: int | None = None, item=None) -> tuple[Decimal, Decimal]:
    """Reserve up to `qty`. Returns (reserved, shortfall).

    A partial reservation is a normal outcome, not an error: an indent for 100 when 60
    are on hand should reserve 60 and let the caller raise an MR for the other 40.
    """
    qty = _d(qty)
    if qty <= ZERO:
        raise ValidationError("Reservation quantity must be positive")

    strategy = (availability.pick_strategy_for(item) if item is not None
                else PickStrategy.FIFO.value)
    rows = await availability.candidate_stock(db, item_id, project_id,
                                              warehouse_types, strategy,
                                              warehouse_ids=warehouse_ids)

    remaining, reserved_total = qty, ZERO
    for stock in rows:
        if remaining <= ZERO:
            break
        take = min(remaining, stock.available_qty or ZERO)
        if take <= ZERO:
            continue
        stock.available_qty = (stock.available_qty or ZERO) - take
        stock.reserved_qty = (stock.reserved_qty or ZERO) + take
        # total_qty is untouched on purpose: reserving moves nothing.
        db.add(Reservation(
            stock_id=stock.id, item_id=item_id, warehouse_id=stock.warehouse_id,
            bin_id=stock.bin_id, batch_id=stock.batch_id, project_id=stock.project_id,
            quantity=take, ref_type=ref_type, ref_id=ref_id, ref_no=ref_no,
            ref_line_id=ref_line_id, status=ReservationStatus.ACTIVE.value,
            created_by_id=getattr(user, "id", None),
            created_by_name=getattr(user, "full_name", None),
        ))
        remaining -= take
        reserved_total += take

    await db.flush()
    return reserved_total, remaining


async def _active(db: AsyncSession, ref_type: str, ref_id: int,
                  ref_line_id: int | None) -> list[Reservation]:
    stmt = select(Reservation).where(
        Reservation.ref_type == ref_type,
        Reservation.ref_id == ref_id,
        Reservation.status == ReservationStatus.ACTIVE.value,
    )
    if ref_line_id is not None:
        stmt = stmt.where(Reservation.ref_line_id == ref_line_id)
    return list((await db.execute(stmt.with_for_update())).scalars().all())


async def release(db: AsyncSession, ref_type: str, ref_id: int,
                  ref_line_id: int | None = None) -> Decimal:
    """Give reserved stock back. Called when the holding document is rejected or
    cancelled. Returns the quantity restored to available_qty."""
    returned = ZERO
    for res in await _active(db, ref_type, ref_id, ref_line_id):
        stock = await db.get(Stock, res.stock_id, with_for_update=True)
        if stock is not None:
            stock.reserved_qty = (stock.reserved_qty or ZERO) - res.quantity
            stock.available_qty = (stock.available_qty or ZERO) + res.quantity
        res.status = ReservationStatus.RELEASED.value
        res.released_at = utcnow()
        returned += res.quantity
    await db.flush()
    return returned


async def release_one(db: AsyncSession, reservation_id: int) -> Reservation:
    """Release a single reservation by its own id.

    The admin screen releases one row rather than a whole document, which `release`
    above cannot express. It lived in `service.py` and assigned `reserved_qty` and
    `available_qty` itself — the one thing CLAUDE.md rule 7 says only this module may
    do, and it took the two row locks in the opposite order to everything here, which
    is how a deadlock gets in. Same work, same order, one owner.

    Does not commit: the caller's unit of work owns the transaction.
    """
    res = await db.get(Reservation, reservation_id, with_for_update=True)
    if res is None:
        raise NotFoundError(f"Reservation {reservation_id} not found")
    if res.status != ReservationStatus.ACTIVE.value:
        raise ValidationError(
            f"Reservation is in status {res.status}, cannot release")

    stock = await db.get(Stock, res.stock_id, with_for_update=True)
    if stock is not None:
        stock.reserved_qty = (stock.reserved_qty or ZERO) - res.quantity
        stock.available_qty = (stock.available_qty or ZERO) + res.quantity
    res.status = ReservationStatus.RELEASED.value
    res.released_at = utcnow()
    await db.flush()
    return res


async def consume(db: AsyncSession, ref_type: str, ref_id: int,
                  ref_line_id: int | None = None) -> Decimal:
    """Mark reservations used at issue time.

    The caller immediately posts the matching move_stock() OUT. This makes the held
    quantity available on its exact balance first; the movement writes the ledger and
    reduces total_qty.
    """
    rows = await consume_for_issue(db, ref_type, ref_id, ref_line_id=ref_line_id)
    return sum((row.quantity for row in rows), ZERO)


async def consume_for_issue(
    db: AsyncSession,
    ref_type: str,
    ref_id: int,
    *,
    quantity=None,
    ref_line_id: int | None = None,
    item_id: int | None = None,
    warehouse_id: int | None = None,
) -> list[ConsumedStock]:
    """Consume an exact quantity and return the balance slices it came from.

    A partial issue leaves the unissued quantity ACTIVE and records the issued part as
    a separate CONSUMED row, preserving an explainable reservation history. The hold
    becomes available on its exact balance row so the caller can immediately post the
    matching physical OUT movement in the same transaction.
    """
    remaining = _d(quantity) if quantity is not None else None
    if remaining is not None and remaining <= ZERO:
        return []

    consumed: list[ConsumedStock] = []
    now = utcnow()
    for res in await _active(db, ref_type, ref_id, ref_line_id):
        if remaining is not None and remaining <= ZERO:
            break
        if item_id is not None and res.item_id != item_id:
            continue
        if warehouse_id is not None and res.warehouse_id != warehouse_id:
            continue

        take = res.quantity if remaining is None else min(res.quantity, remaining)
        if take <= ZERO:
            continue

        stock = await db.get(Stock, res.stock_id, with_for_update=True)
        if stock is None:
            raise ValidationError(
                f"Reservation {res.id} points to a stock balance that no longer exists"
            )
        if (stock.reserved_qty or ZERO) < take:
            raise ValidationError(
                f"Reservation {res.id} is not backed by enough reserved stock"
            )

        stock.reserved_qty = (stock.reserved_qty or ZERO) - take
        stock.available_qty = (stock.available_qty or ZERO) + take

        if take == res.quantity:
            res.status = ReservationStatus.CONSUMED.value
            res.released_at = now
        else:
            res.quantity = res.quantity - take
            db.add(Reservation(
                stock_id=res.stock_id,
                item_id=res.item_id,
                warehouse_id=res.warehouse_id,
                bin_id=res.bin_id,
                batch_id=res.batch_id,
                project_id=res.project_id,
                quantity=take,
                ref_type=res.ref_type,
                ref_id=res.ref_id,
                ref_no=res.ref_no,
                ref_line_id=res.ref_line_id,
                status=ReservationStatus.CONSUMED.value,
                created_by_id=res.created_by_id,
                created_by_name=res.created_by_name,
                released_at=now,
            ))

        consumed.append(ConsumedStock(
            item_id=res.item_id,
            warehouse_id=res.warehouse_id,
            bin_id=res.bin_id,
            batch_id=res.batch_id,
            project_id=res.project_id,
            quantity=take,
        ))
        if remaining is not None:
            remaining -= take

    await db.flush()
    return consumed


async def reserved_for(db: AsyncSession, ref_type: str, ref_id: int) -> Decimal:
    """What a document is currently holding. The fulfilment queue shows it, and a
    consistency check can compare it against stk_balance.reserved_qty."""
    rows = await _active(db, ref_type, ref_id, None)
    return sum((r.quantity for r in rows), ZERO)


async def reserved_quantity(
    db: AsyncSession,
    ref_type: str,
    ref_id: int,
    *,
    ref_line_id: int | None = None,
    item_id: int | None = None,
    warehouse_id: int | None = None,
) -> Decimal:
    """Active quantity for one fulfilment slice without mutating it."""
    stmt = select(func.coalesce(func.sum(Reservation.quantity), 0)).where(
        Reservation.ref_type == ref_type,
        Reservation.ref_id == ref_id,
        Reservation.status == ReservationStatus.ACTIVE.value,
    )
    if ref_line_id is not None:
        stmt = stmt.where(Reservation.ref_line_id == ref_line_id)
    if item_id is not None:
        stmt = stmt.where(Reservation.item_id == item_id)
    if warehouse_id is not None:
        stmt = stmt.where(Reservation.warehouse_id == warehouse_id)
    return _d(await db.scalar(stmt))
