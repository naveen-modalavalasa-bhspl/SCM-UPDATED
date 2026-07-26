"""Reservation: the only code that moves quantity between available_qty and
reserved_qty.

Reserving is NOT a stock movement. Nothing has physically left the shelf, so total_qty
is untouched and no stk_ledger row is written — the ledger row appears when the issue
posts. That is why this deliberately does not go through move_stock(), and why
CLAUDE.md rule 7 is split: physical changes via move_stock(), reservation columns via
this module, and nothing else assigns to stk_balance.
"""
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError
from app.modules.inventory import availability
from app.modules.inventory.models import NO_PROJECT, Reservation, Stock
from app.shared.enums import PickStrategy, ReservationStatus
from app.shared.models.base import utcnow

ZERO = Decimal("0")


def _d(value) -> Decimal:
    return Decimal(str(value))


async def reserve(db: AsyncSession, item_id: int, qty, ref_type: str, ref_id: int,
                  ref_no: str | None, user, *, project_id: int = NO_PROJECT,
                  warehouse_types: list[str] | None = None,
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
                                              warehouse_types, strategy)

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


async def consume(db: AsyncSession, ref_type: str, ref_id: int,
                  ref_line_id: int | None = None) -> Decimal:
    """Mark reservations used at issue time.

    Only clears the hold. The caller posts the matching move_stock() OUT, which is
    what writes the ledger row and reduces total_qty — the goods have now left.
    """
    used = ZERO
    for res in await _active(db, ref_type, ref_id, ref_line_id):
        stock = await db.get(Stock, res.stock_id, with_for_update=True)
        if stock is not None:
            stock.reserved_qty = (stock.reserved_qty or ZERO) - res.quantity
        res.status = ReservationStatus.CONSUMED.value
        res.released_at = utcnow()
        used += res.quantity
    await db.flush()
    return used


async def reserved_for(db: AsyncSession, ref_type: str, ref_id: int) -> Decimal:
    """What a document is currently holding. The fulfilment queue shows it, and a
    consistency check can compare it against stk_balance.reserved_qty."""
    rows = await _active(db, ref_type, ref_id, None)
    return sum((r.quantity for r in rows), ZERO)
