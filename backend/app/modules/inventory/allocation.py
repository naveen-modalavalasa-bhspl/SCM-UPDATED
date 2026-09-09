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


@dataclass(frozen=True)
class Relocation:
    """One hold that moved, in the words a screen can repeat back."""

    item_id: int
    quantity: Decimal
    from_bin_id: int
    from_batch_id: int
    to_bin_id: int
    to_batch_id: int


def _slot(bin_id, batch_id) -> tuple[int, int]:
    """The (bin, batch) a hold sits on.

    0 is this system's "none" on both columns — `stk_balance` and `inv_reservations`
    are NOT NULL DEFAULT 0 there — so a caller handing None means the same thing and
    is folded to it rather than making a second, silently different key.
    """
    return (int(bin_id or 0), int(batch_id or 0))


async def _stock_at(db: AsyncSession, *, item_id: int, warehouse_id: int,
                    bin_id: int, batch_id: int) -> list[Stock]:
    """The balance rows standing at one (bin, batch), most free first, row-locked.

    A (bin, batch) can carry several balance rows because `stk_balance` is also keyed
    on the project. Taking the freest first keeps a relocation on as few rows as it
    can be.
    """
    rows = (await db.execute(
        select(Stock).where(
            Stock.item_id == item_id,
            Stock.warehouse_id == warehouse_id,
            Stock.bin_id == bin_id,
            Stock.batch_id == batch_id,
        ).with_for_update()
    )).scalars().all()
    return sorted(rows, key=lambda row: -(row.available_qty or ZERO))


async def relocate(
    db: AsyncSession,
    ref_type: str,
    ref_id: int,
    *,
    wanted: dict[tuple[int, int], Decimal],
    ref_line_id: int | None = None,
    item_id: int | None = None,
    warehouse_id: int | None = None,
    ref_no: str | None = None,
    user=None,
    label: str | None = None,
) -> list[Relocation]:
    """Move an existing hold onto the (bin, batch) a document now names.

    Inventory allocates against the stock rows that were free when it signed. The
    storekeeper who then picks the goods regularly finds them somewhere else — a
    consolidation moved them overnight, the bay he was sent to is behind a pallet, the
    batch on the shelf is the older one — and changes the location on the issue. That
    edit used to change nothing behind the screen: the reservation stayed where it
    was, `consume_for_issue` consumed it there, and the stock left a bay the document
    did not name while the bay it DID name stayed reserved for a document that had
    already gone out.

    So this is the other half of that edit. The hold at the location the document has
    stopped naming is **released — the quantity goes back to `available_qty`, free for
    anybody** — and the same quantity is taken at the location it now names.

    **The total held never changes.** Only `min(surplus, deficit)` moves, so an issue
    drawing less than was allocated leaves the balance of the allocation exactly where
    it was: the indent still holds it, and this is not a way to hand stock back.
    Nothing is released until the whole move is known to be placeable, because a
    half-done relocation is a hold this document has lost and cannot get back.
    """
    wanted = {_slot(*key): _d(qty) for key, qty in wanted.items() if _d(qty) > ZERO}

    held: dict[tuple[int, int], list[Reservation]] = {}
    for res in await _active(db, ref_type, ref_id, ref_line_id):
        if item_id is not None and res.item_id != item_id:
            continue
        if warehouse_id is not None and res.warehouse_id != warehouse_id:
            continue
        held.setdefault(_slot(res.bin_id, res.batch_id), []).append(res)
    if not held:
        return []

    totals = {key: sum((r.quantity for r in rows), ZERO) for key, rows in held.items()}
    deficit = {key: qty - totals.get(key, ZERO)
               for key, qty in wanted.items() if qty > totals.get(key, ZERO)}
    surplus = {key: qty - wanted.get(key, ZERO)
               for key, qty in totals.items() if qty > wanted.get(key, ZERO)}
    if not deficit or not surplus:
        return []

    # Never more than the document actually re-pointed. An issue taking less than was
    # allocated has a surplus that is not a change of mind, and must keep it.
    budget = min(sum(deficit.values(), ZERO), sum(surplus.values(), ZERO))

    sample = held[next(iter(held))][0]
    subject = item_id or sample.item_id
    point = warehouse_id or sample.warehouse_id
    name = label or f"item {subject}"

    # Can the new locations take it, BEFORE anything is given up? A location can
    # absorb what is free on it; the part of this document's own hold already sitting
    # there is not moving, so it is not capacity either way.
    room: dict[tuple[int, int], Decimal] = {}
    for key in deficit:
        rows = await _stock_at(db, item_id=subject, warehouse_id=point,
                               bin_id=key[0], batch_id=key[1])
        room[key] = sum((row.available_qty or ZERO for row in rows), ZERO)

    placeable = sum((min(need, room.get(key, ZERO))
                     for key, need in deficit.items()), ZERO)
    if placeable < budget:
        short = next(key for key, need in deficit.items()
                     if room.get(key, ZERO) < need)
        raise ValidationError(
            f"{name}: the location this is being moved onto cannot hold it. "
            f"{room.get(short, ZERO)} is free there and {deficit[short]} was asked "
            f"of it. Pick a location that holds the goods, or leave the allocation "
            f"where inventory put it."
        )

    now = utcnow()
    moves: list[Relocation] = []

    # Give the abandoned holds back first, then take the same quantity at the new
    # locations. Both halves are inside the caller's transaction, so the stock is
    # never briefly free to anybody else.
    freed: list[tuple[tuple[int, int], Decimal]] = []
    left = budget
    # Locations the document has abandoned outright come first: those holds are
    # certainly wrong, where an over-held location is merely too full.
    for key in sorted(surplus, key=lambda k: (k in wanted, k)):
        if left <= ZERO:
            break
        take = min(surplus[key], left)
        given = ZERO
        for res in held[key]:
            if given >= take:
                break
            part = min(res.quantity, take - given)
            if part <= ZERO:
                continue
            stock = await db.get(Stock, res.stock_id, with_for_update=True)
            if stock is not None:
                stock.reserved_qty = (stock.reserved_qty or ZERO) - part
                stock.available_qty = (stock.available_qty or ZERO) + part
            if part == res.quantity:
                res.status = ReservationStatus.RELEASED.value
                res.released_at = now
            else:
                res.quantity = res.quantity - part
                db.add(Reservation(
                    stock_id=res.stock_id, item_id=res.item_id,
                    warehouse_id=res.warehouse_id, bin_id=res.bin_id,
                    batch_id=res.batch_id, project_id=res.project_id,
                    quantity=part, ref_type=res.ref_type, ref_id=res.ref_id,
                    ref_no=res.ref_no, ref_line_id=res.ref_line_id,
                    status=ReservationStatus.RELEASED.value,
                    created_by_id=res.created_by_id,
                    created_by_name=res.created_by_name,
                    released_at=now,
                ))
            given += part
        if given > ZERO:
            freed.append((key, given))
        left -= given
    await db.flush()

    source = list(freed)
    for key, need in deficit.items():
        remaining = min(need, budget)
        for stock in await _stock_at(db, item_id=subject, warehouse_id=point,
                                     bin_id=key[0], batch_id=key[1]):
            if remaining <= ZERO:
                break
            take = min(remaining, stock.available_qty or ZERO)
            if take <= ZERO:
                continue
            stock.available_qty = (stock.available_qty or ZERO) - take
            stock.reserved_qty = (stock.reserved_qty or ZERO) + take
            db.add(Reservation(
                stock_id=stock.id, item_id=subject, warehouse_id=stock.warehouse_id,
                bin_id=stock.bin_id, batch_id=stock.batch_id,
                project_id=stock.project_id, quantity=take,
                ref_type=ref_type, ref_id=ref_id,
                ref_no=ref_no or sample.ref_no, ref_line_id=ref_line_id,
                status=ReservationStatus.ACTIVE.value,
                created_by_id=getattr(user, "id", None),
                created_by_name=getattr(user, "full_name", None),
            ))
            # Which abandoned location this quantity came off, so a screen can say
            # "5 moved from F1-A1-R1-B1 to F1-A2-R3-B2" rather than "something moved".
            outstanding = take
            while outstanding > ZERO and source:
                from_key, spare = source[0]
                part = min(outstanding, spare)
                if part > ZERO:
                    moves.append(Relocation(
                        item_id=subject, quantity=part,
                        from_bin_id=from_key[0], from_batch_id=from_key[1],
                        to_bin_id=stock.bin_id, to_batch_id=stock.batch_id,
                    ))
                if spare - part <= ZERO:
                    source.pop(0)
                else:
                    source[0] = (from_key, spare - part)
                outstanding -= part
            remaining -= take
            budget -= take

    await db.flush()
    return moves


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
    bin_id: int | None = None,
    batch_id: int | None = None,
) -> list[ConsumedStock]:
    """Consume an exact quantity and return the balance slices it came from.

    A partial issue leaves the unissued quantity ACTIVE and records the issued part as
    a separate CONSUMED row, preserving an explainable reservation history. The hold
    becomes available on its exact balance row so the caller can immediately post the
    matching physical OUT movement in the same transaction.

    `bin_id` / `batch_id` narrow it to the goods a document actually names. One
    allocation is routinely held in two bays and served by two issue LINES, and
    without the narrowing the first line consumes whichever hold the query returns
    first — so the stock left the bay the other line named and the ledger disagreed
    with the document. Left as None they filter nothing, which is the older
    behaviour every unbinned and unbatched caller still relies on.
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
        if bin_id is not None and res.bin_id != bin_id:
            continue
        if batch_id is not None and res.batch_id != batch_id:
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
    statuses: tuple[str, ...] = (ReservationStatus.ACTIVE.value,),
) -> Decimal:
    """Quantity held for one fulfilment slice without mutating it.

    ACTIVE only by default — that is what "how much is currently held" means, and it is
    what the availability arithmetic wants.

    `statuses` widens it for the one caller that is asking a different question: how
    much of this line has ALREADY been put aside, across the whole life of the line.
    A reopened allocation needs CONSUMED counted too — see `apply_to_stock`.
    RELEASED is never in that answer: a released reservation gave its stock back.
    """
    stmt = select(func.coalesce(func.sum(Reservation.quantity), 0)).where(
        Reservation.ref_type == ref_type,
        Reservation.ref_id == ref_id,
        Reservation.status.in_(list(statuses)),
    )
    if ref_line_id is not None:
        stmt = stmt.where(Reservation.ref_line_id == ref_line_id)
    if item_id is not None:
        stmt = stmt.where(Reservation.item_id == item_id)
    if warehouse_id is not None:
        stmt = stmt.where(Reservation.warehouse_id == warehouse_id)
    return _d(await db.scalar(stmt))
