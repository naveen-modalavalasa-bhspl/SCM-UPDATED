"""Put unit codes back inside the packs they travel in (2026-10-28).

NA/104/2026-27/STO0002 sent two strips LIP to LIP and the receiving LIP got them with
no codes inside: at the source every code still pointed at a box at the central
warehouse, so nothing that moved the strips moved the codes. They stayed "available"
at the source — more codes there than stock — and the strips that arrived held none.
The code is fixed (`box_codes.seat_stray_units`, run by every issue save and every
landing). This puts the history right, in three passes:

1. At every point, codes pointing at a pack that is not standing there are seated into
   the packs there that hold fewer codes than their contents.
2. A package that LANDED from a consignment holding fewer codes than its contents takes
   the missing ones from the point that sent it — only codes that point holds BEYOND
   its stock (the ones that physically left), never one still on its shelf.
3. What is left over is listed: a point still holding more codes than stock (goods
   rejected at outward QC, or history from before codes were kept per pack).

A bare run only reports; `--apply` writes it. Idempotent.

    .venv/Scripts/python -m scripts.reseat_unit_codes
    .venv/Scripts/python -m scripts.reseat_unit_codes --apply
"""
import asyncio
import sys
from collections import defaultdict
from decimal import Decimal

from sqlalchemy import func, select, update

import app.all_models  # noqa: F401
from app.core.database import SessionLocal, engine
from app.modules.inventory.models import Stock
from app.modules.warehouse import box_codes
from app.modules.warehouse import models as m
from app.modules.warehouse.enums import LIVE_HANDLING_UNIT_STATUSES as LIVE, SerialStatus
from app.modules.warehouse.packing import held
from app.platform.settings.service import write_audit
from app.shared.enums import AuditAction

ZERO = Decimal("0")
AVAILABLE = SerialStatus.AVAILABLE.value


async def _pairs(db):
    """Every (item, point) holding live packs and available codes."""
    packs = set((await db.execute(select(m.HandlingUnit.item_id, m.HandlingUnit.warehouse_id)
                                  .where(m.HandlingUnit.status.in_(LIVE)).distinct())).all())
    units = set((await db.execute(select(m.SerialNumber.item_id, m.SerialNumber.warehouse_id)
                                  .where(m.SerialNumber.status == AVAILABLE,
                                         m.SerialNumber.is_active.is_(True)).distinct())).all())
    return sorted(packs & units)


async def _in_live_pack_here(db, item_id, warehouse_id) -> set[int]:
    live = select(m.HandlingUnit.id).where(m.HandlingUnit.item_id == item_id,
                                           m.HandlingUnit.warehouse_id == warehouse_id,
                                           m.HandlingUnit.status.in_(LIVE))
    return set((await db.execute(select(m.SerialNumber.id).where(
        m.SerialNumber.item_id == item_id, m.SerialNumber.warehouse_id == warehouse_id,
        m.SerialNumber.status == AVAILABLE,
        m.SerialNumber.handling_unit_id.in_(live)))).scalars().all())


async def _excess(db, item_id, warehouse_id, batch_id) -> list[int]:
    """Codes at a point's lot beyond its stock, outside any pack standing there — the
    ones that physically left. Newest last, so the oldest are taken first."""
    stock = Decimal(str(await db.scalar(select(func.coalesce(func.sum(Stock.total_qty), 0)).where(
        Stock.item_id == item_id, Stock.warehouse_id == warehouse_id,
        Stock.batch_id == (batch_id or 0))) or 0))
    rows = (await db.execute(select(m.SerialNumber.id, m.SerialNumber.remarks).where(
        m.SerialNumber.item_id == item_id, m.SerialNumber.warehouse_id == warehouse_id,
        m.SerialNumber.batch_id == batch_id, m.SerialNumber.status == AVAILABLE,
        m.SerialNumber.is_active.is_(True)).order_by(m.SerialNumber.id))).all()
    over = len(rows) - int(stock)
    if over <= 0:
        return []
    inside = await _in_live_pack_here(db, item_id, warehouse_id)
    free = [r.id for r in rows if r.id not in inside
            and not (r.remarks or "").startswith("Reserved for")]
    return free[:over]


async def main(apply: bool) -> None:
    async with SessionLocal() as db:
        print("Pass 1 — codes pointing at a pack somewhere else, seated where they stand")
        seated = 0
        for item_id, warehouse_id in await _pairs(db):
            n = await box_codes.seat_stray_units(db, item_id=item_id, warehouse_id=warehouse_id)
            if n:
                print(f"  item {item_id:>6} at point {warehouse_id:>6}: {n} code(s) seated")
                seated += n
        await db.flush()

        print("\nPass 2 — packages that landed short of codes, filled from the point that sent them")
        moved = 0
        landed = (await db.execute(select(m.HandlingUnit).where(
            m.HandlingUnit.source_type == "DISPATCH", m.HandlingUnit.status.in_(LIVE))
            .order_by(m.HandlingUnit.id))).scalars().all()
        kids_held: dict[int, Decimal] = defaultdict(lambda: ZERO)
        for hu in (await db.execute(select(m.HandlingUnit).where(
                m.HandlingUnit.parent_id.in_([h.id for h in landed] or [0]),
                m.HandlingUnit.status.in_(LIVE)))).scalars().all():
            kids_held[hu.parent_id] += held(hu)
        for hu in landed:
            linked = await db.scalar(select(func.count()).select_from(m.SerialNumber).where(
                m.SerialNumber.handling_unit_id == hu.id, m.SerialNumber.status == AVAILABLE,
                m.SerialNumber.warehouse_id == hu.warehouse_id))
            room = int(held(hu) - kids_held[hu.id]) - int(linked or 0)
            if room <= 0 or not hu.source_id:
                continue
            dispatch = await db.get(m.Dispatch, hu.source_id)
            if dispatch is None or not dispatch.warehouse_id:
                continue
            take = (await _excess(db, hu.item_id, dispatch.warehouse_id, hu.batch_id))[:room]
            if not take:
                print(f"  {hu.hu_code} at point {hu.warehouse_id}: {room} code(s) missing, "
                      f"none spare at the sender ({dispatch.dispatch_no}) — left as it is")
                continue
            await db.execute(update(m.SerialNumber).where(m.SerialNumber.id.in_(take)).values(
                warehouse_id=hu.warehouse_id, bin_id=None, handling_unit_id=hu.id,
                remarks=f"Received by {dispatch.dispatch_no}")
                .execution_options(synchronize_session=False))
            await write_audit(
                db, entity="whs_handling_units", entity_id=hu.id, entity_no=hu.hu_code,
                action=AuditAction.UPDATE, actor=None,
                after={"codes_moved": len(take), "from_point": dispatch.warehouse_id,
                       "to_point": hu.warehouse_id},
                summary=f"{len(take)} unit code(s) that travelled in {hu.hu_code} on "
                        f"{dispatch.dispatch_no} re-homed to the point that received it "
                        "(scripts.reseat_unit_codes)")
            print(f"  {hu.hu_code} at point {hu.warehouse_id}: {len(take)} code(s) brought "
                  f"from point {dispatch.warehouse_id} ({dispatch.dispatch_no})")
            moved += len(take)
        await db.flush()

        print("\nPass 3 — points still holding more codes than stock (not changed)")
        rows = (await db.execute(
            select(m.SerialNumber.item_id, m.SerialNumber.warehouse_id, m.SerialNumber.batch_id,
                   func.count()).where(m.SerialNumber.status == AVAILABLE,
                                       m.SerialNumber.is_active.is_(True))
            .group_by(m.SerialNumber.item_id, m.SerialNumber.warehouse_id,
                      m.SerialNumber.batch_id))).all()
        over = 0
        for item_id, warehouse_id, batch_id, n in rows:
            stock = Decimal(str(await db.scalar(select(func.coalesce(func.sum(Stock.total_qty), 0))
                .where(Stock.item_id == item_id, Stock.warehouse_id == warehouse_id,
                       Stock.batch_id == (batch_id or 0))) or 0))
            if n > stock:
                over += 1
                print(f"  item {item_id:>6} at point {warehouse_id:>6} batch {batch_id}: "
                      f"{n} codes, {stock.normalize():f} in stock")

        if apply:
            await db.commit()
        else:
            await db.rollback()
        print(f"\n{seated} code(s) seated in place, {moved} brought to the point that received "
              f"them, {over} lot(s) still over. "
              + ("Written." if apply else "Dry run — nothing written; add --apply."))
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main("--apply" in sys.argv))
