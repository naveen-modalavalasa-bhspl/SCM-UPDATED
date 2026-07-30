"""Read-only stock lookup: what can we pick, and in what order.

Kept separate from allocation.py because the ordering IS the business rule — nearest
expiry first for anything perishable — and it must be checkable without writing
anything or, in sort_key's case, without a database at all.
"""
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.inventory.models import NO_PROJECT, Stock
from app.shared.enums import PickStrategy
from app.shared.models.warehouse import Warehouse

# A batch with no expiry must sort *after* every dated one: an undated drum should not
# jump ahead of a batch that expires next week.
_NO_EXPIRY = date.max


def pick_strategy_for(item) -> str:
    """FEFO when the item carries batches or expiry, FIFO otherwise.

    Picking the nearest expiry first is the entire reason expiry is tracked, so this
    is not configurable per call — a rule can steer which warehouse, never whether to
    ignore expiry.
    """
    if getattr(item, "is_batch_tracked", False):
        return PickStrategy.FEFO.value
    return PickStrategy.FIFO.value


def sort_key(strategy: str):
    """Ordering as a plain function so it can be tested without MySQL.

    FEFO: expiry ascending, undated last, then id for a stable tie-break.
    FIFO: id ascending — the oldest balance row is the earliest receipt.
    """
    if strategy == PickStrategy.FEFO.value:
        return lambda s: (s.expiry_date or _NO_EXPIRY, s.id)
    return lambda s: (s.id,)


async def candidate_stock(db: AsyncSession, item_id: int,
                          project_id: int | None = NO_PROJECT,
                          warehouse_types: list[str] | None = None,
                          strategy: str = PickStrategy.FIFO.value,
                          warehouse_ids: list[int] | None = None) -> list[Stock]:
    """Rows with something available, in the order they should be drawn down.

    Locked FOR UPDATE: two indents approved at the same moment must not both read the
    same availability and both believe they can have it.
    """
    stmt = select(Stock).where(Stock.item_id == item_id, Stock.available_qty > 0)
    if project_id is not None:
        # A project draws on its own earmarked stock AND the general pool. Matching the
        # project alone hid every unearmarked row: live stock sits at NO_PROJECT, so a
        # project's indent saw "0 available" with a full shelf behind it, and the
        # allocation screen had no warehouse to offer. Stock earmarked for ANOTHER
        # project is still excluded, which is the whole point of the dimension.
        stmt = stmt.where(Stock.project_id.in_({project_id, NO_PROJECT}))
    if warehouse_ids:
        # An allocator picked these warehouses explicitly. That choice wins over any
        # type filter a rule suggested — a person looked at the shelf and decided.
        stmt = stmt.where(Stock.warehouse_id.in_(warehouse_ids))
    elif warehouse_types:
        stmt = stmt.where(Stock.warehouse_id.in_(
            select(Warehouse.id).where(Warehouse.warehouse_type.in_(warehouse_types),
                                       Warehouse.is_active.is_(True))))
    rows = list((await db.execute(stmt.with_for_update())).scalars().all())
    # Sorted in Python, not SQL, so the ordering rule has exactly one definition and
    # sort_key can be tested on plain objects.
    return sorted(rows, key=sort_key(strategy))


async def available_for(db: AsyncSession, item_id: int,
                        project_id: int | None = NO_PROJECT,
                        warehouse_types: list[str] | None = None) -> Decimal:
    """Total unreserved quantity. Used by the fulfilment queue to show a line's
    availability before anyone commits to it."""
    rows = await candidate_stock(db, item_id, project_id, warehouse_types)
    return sum((r.available_qty or Decimal("0") for r in rows), Decimal("0"))
