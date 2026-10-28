"""Seed Masters › Packaging for existing data (2026-10-23). Run once after deploying
the packaging-by-usage change, after `alembic upgrade head`:

    .venv/Scripts/python -m scripts.setup_container_usage            # preview
    .venv/Scripts/python -m scripts.setup_container_usage --apply    # save

What it does, per item:

* **Storage** = the container of the item's default putaway rung, so putaway keeps
  shelving exactly what it shelved yesterday — now fixed by the master.
* **Brand on ladders**: an item with exactly ONE brand gets that brand on its
  ladders that have none. An item with several keeps them as "All brands".

Indent, Purchase, Issue and Consumption are deliberately left unmapped: unmapped means
today's behaviour (any level on a PO, biggest packs on an issue, quantity on an
indent), and changing those is a decision for whoever owns the item, on
Masters › Packaging › Container Usage.

Idempotent: an item that already has any usage row is skipped; a ladder that already
has a brand is left alone. Nothing is deleted.

**Box codes for old stock** (2026-10-26). For every item ISSUED in a container, every
lot still coded per base unit — or packed in a container that is no longer the issue
one — is grouped into boxes of the Issue container: whole boxes first, then ONE part
box for the remainder, each box with its own code. The units' old codes stay on their
unit rows, inside their box, as hidden history (an old label scanned at the issue desk
still finds its box). Every new box code is queued under Inventory › Labels & Printing
› Box labels. Each lot is checked before and after — stock, unit count, and that the
boxes hold no more than the stock — and rolled back on any difference. A lot an open
issue holds is skipped and listed: it is re-boxed when that issue is next saved. Units
linked to a box that stands at ANOTHER point are detached from it first. Re-running
it boxes only what is still unboxed.
"""
from __future__ import annotations

import argparse
import asyncio
from decimal import Decimal

from sqlalchemy import func, or_, select, update

from app.core.database import SessionLocal
from app.modules.inventory.models import Stock
from app.modules.warehouse import box_codes
from app.modules.warehouse import models as m
from app.modules.warehouse.enums import LIVE_HANDLING_UNIT_STATUSES as LIVE, SerialStatus
from app.shared.masters import combinations, packs
from app.shared.models.master import (
    Item, ItemContainerUsage, ItemPackaging, PackHierarchy,
)

ZERO = Decimal("0")


class _Rollback(Exception):
    """Raised inside one lot's savepoint so that lot rolls back alone."""


def _lot(stmt, column_bin, column_batch, key: dict):
    for column, value in ((column_bin, key["bin_id"]), (column_batch, key["batch_id"])):
        stmt = stmt.where(column == value) if value else stmt.where(
            or_(column.is_(None), column == 0))
    return stmt


async def _snapshot(db, key: dict) -> tuple[Decimal, int, Decimal]:
    """(stock on hand, unit rows, what the standing packs hold) at one lot."""
    stock = Decimal(str(await db.scalar(
        select(func.coalesce(func.sum(Stock.total_qty), 0)).where(
            Stock.item_id == key["item_id"], Stock.warehouse_id == key["warehouse_id"],
            Stock.bin_id == key["bin_id"], Stock.batch_id == key["batch_id"],
            Stock.project_id == key["project_id"]))))
    units = int(await db.scalar(_lot(
        select(func.count()).select_from(m.SerialNumber).where(
            m.SerialNumber.item_id == key["item_id"],
            m.SerialNumber.warehouse_id == key["warehouse_id"],
            m.SerialNumber.status == SerialStatus.AVAILABLE.value,
            m.SerialNumber.is_active.is_(True)),
        m.SerialNumber.bin_id, m.SerialNumber.batch_id, key)) or 0)
    tops = (await db.execute(select(m.HandlingUnit).where(
        m.HandlingUnit.item_id == key["item_id"],
        m.HandlingUnit.warehouse_id == key["warehouse_id"],
        m.HandlingUnit.bin_id == (key["bin_id"] or m.NO_BIN),
        m.HandlingUnit.batch_id == (key["batch_id"] or m.NO_BATCH),
        m.HandlingUnit.project_id == key["project_id"],
        m.HandlingUnit.parent_id.is_(None),
        m.HandlingUnit.status.in_(LIVE)))).scalars().all()
    return stock, units, sum((box_codes.held(hu) for hu in tops), ZERO)


async def convert_codes(db, report: dict) -> None:
    """Old stock into boxes of each item's Issue container (see the module notes)."""
    items = sorted(set((await db.execute(select(ItemContainerUsage.item_id).where(
        ItemContainerUsage.usage == "ISSUE", ItemContainerUsage.package_id > 0))).scalars()))
    codes = dict((await db.execute(select(Item.id, Item.code))).all())
    for item_id in items:
        item = await db.get(Item, item_id)
        label = codes.get(item_id) or str(item_id)
        packages = await box_codes.issue_packages(db, item_id)

        # Units linked to a box standing at ANOTHER point are not in that box.
        stray = list((await db.execute(
            select(m.SerialNumber.id).join(
                m.HandlingUnit, m.HandlingUnit.id == m.SerialNumber.handling_unit_id)
            .where(m.SerialNumber.item_id == item_id,
                   m.SerialNumber.warehouse_id != m.HandlingUnit.warehouse_id))).scalars())
        if stray:
            await db.execute(update(m.SerialNumber).where(m.SerialNumber.id.in_(stray))
                             .values(handling_unit_id=None))
            report["detached"].append(f"{label}: {len(stray)} unit(s) were linked to a box "
                                      "standing at another point - detached")

        # Boxes coded at their own level before this are plain boxes now: part of one
        # leaves as a part box, never a refused break bulk.
        await db.execute(update(m.HandlingUnit).where(
            m.HandlingUnit.item_id == item_id, m.HandlingUnit.is_atom.is_(True),
            m.HandlingUnit.status.in_(LIVE),
            m.HandlingUnit.item_packaging_id.in_(
                select(ItemPackaging.id).where(ItemPackaging.item_id == item_id,
                                               ItemPackaging.package_id.in_(packages))))
            .values(is_atom=False))

        keys = (await db.execute(select(
            Stock.warehouse_id, Stock.bin_id, Stock.batch_id, Stock.project_id)
            .where(Stock.item_id == item_id, Stock.total_qty > 0).distinct())).all()
        for warehouse_id, bin_id, batch_id, project_id in keys:
            key = {"item_id": item_id, "warehouse_id": warehouse_id, "bin_id": bin_id or 0,
                   "batch_id": batch_id or 0, "project_id": project_id or 0}
            where = (f"{label} @ warehouse {warehouse_id}, location {bin_id or '-'}, "
                     f"batch {batch_id or '-'}")
            holder = await box_codes.held_lot(db, key)
            if holder:
                report["held"].append(
                    f"{where}: held by {await box_codes.holder_label(db, holder)}")
                continue
            hierarchy = await db.scalar(select(m.HandlingUnit.pack_hierarchy_id).where(
                m.HandlingUnit.item_id == item_id, m.HandlingUnit.warehouse_id == warehouse_id,
                m.HandlingUnit.bin_id == (bin_id or m.NO_BIN),
                m.HandlingUnit.batch_id == (batch_id or m.NO_BATCH),
                m.HandlingUnit.status.in_(LIVE)).limit(1))
            try:
                ladder = await packs.ladder(db, item_id, hierarchy)
            except Exception:                                      # noqa: BLE001
                report["skipped"].append(f"{where}: no pack hierarchy")
                continue
            level = await box_codes.issue_level(db, item_id, ladder)
            if not level:
                continue
            live = (await db.execute(select(m.HandlingUnit).where(
                m.HandlingUnit.item_id == item_id, m.HandlingUnit.warehouse_id == warehouse_id,
                m.HandlingUnit.bin_id == (bin_id or m.NO_BIN),
                m.HandlingUnit.batch_id == (batch_id or m.NO_BATCH),
                m.HandlingUnit.project_id == (project_id or 0),
                m.HandlingUnit.pack_hierarchy_id == ladder.hierarchy_id,
                m.HandlingUnit.status.in_(LIVE)))).scalars().all()
            stock, units, packed = await _snapshot(db, key)
            loose = stock - packed
            if not box_codes.needs_rebox(live, level) and (
                    loose <= ZERO or loose != loose.to_integral_value()):
                continue                                         # already boxed
            try:
                async with db.begin_nested():
                    out = await box_codes.rebox_lot(
                        db, key, item=item, ladder=ladder, level=level,
                        reason=f"Converted: {label} is issued in {ladder.at(level).name}",
                        label_reason=box_codes.BoxLabelReason.CONVERTED,
                        source=("CONVERT", 0, "Box codes"))
                    after = await _snapshot(db, key)
                    if after[0] != stock or after[1] != units or after[2] > after[0]:
                        raise _Rollback(f"stock {stock} -> {after[0]}, units {units} -> "
                                        f"{after[1]}, boxes hold {after[2]}")
            except _Rollback as exc:
                report["rolled_back"].append(f"{where}: {exc}")
                continue
            report["converted"].append(
                f"{where}: {out['made']} new {ladder.at(level).name} code(s), "
                f"{out['kept']} kept, {out['retired']} inner code(s) retired")
            report["boxes"] += out["made"]


async def run(apply: bool) -> None:
    seeded, branded, skipped = [], [], 0
    report = {"converted": [], "held": [], "rolled_back": [], "detached": [],
              "skipped": [], "boxes": 0}
    async with SessionLocal() as db:
        mapped = set((await db.execute(select(ItemContainerUsage.item_id).distinct())).scalars())
        putaway = (await db.execute(
            select(ItemPackaging.item_id, ItemPackaging.package_id, ItemPackaging.package_name)
            .where(ItemPackaging.is_default_putaway_unit.is_(True),
                   ItemPackaging.is_active.is_(True)))).all()
        codes = dict((await db.execute(select(Item.id, Item.code))).all())
        for item_id, package_id, name in putaway:
            if item_id in mapped:
                skipped += 1
                continue
            db.add(ItemContainerUsage(item_id=item_id, package_id=package_id, usage="STORAGE"))
            mapped.add(item_id)
            seeded.append(f"{codes.get(item_id)}: Storage = {name}")

        ladders = (await db.execute(select(PackHierarchy).where(
            PackHierarchy.brand_id.is_(None), PackHierarchy.is_active.is_(True)))).scalars().all()
        for ladder in ladders:
            brands = {c.brand_id: c.brand_name
                      for c in await combinations.sync_item(db, ladder.item_id)}
            if len(brands) == 1:
                (brand_id, brand_name), = brands.items()
                ladder.brand_id, ladder.brand_name = brand_id, brand_name
                branded.append(f"{codes.get(ladder.item_id)}: '{ladder.name}' -> {brand_name}")

        await db.flush()
        await convert_codes(db, report)

        if apply:
            await db.commit()
        else:
            await db.rollback()

    print(f"\n{'APPLY' if apply else 'PREVIEW'} - storage seeded for {len(seeded)} items, "
          f"{len(branded)} ladders given their brand, {skipped} items already mapped")
    for line in seeded + branded:
        print("  " + line)
    print(f"\nBOX CODES - {len(report['converted'])} lot(s) boxed, {report['boxes']} new box "
          f"code(s) queued for labels, {len(report['held'])} lot(s) held by an open issue, "
          f"{len(report['rolled_back'])} rolled back")
    for title, rows in (("BOXED", report["converted"]),
                        ("HELD - re-boxed when that issue is next saved", report["held"]),
                        ("ROLLED BACK", report["rolled_back"]),
                        ("CLEANED", report["detached"]), ("SKIPPED", report["skipped"])):
        if rows:
            print(f"  {title}:")
            for row in rows:
                print("    " + row)
    if not apply:
        print("\nNothing was saved. Run again with --apply to save.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--apply", action="store_true")
    asyncio.run(run(parser.parse_args().apply))


if __name__ == "__main__":
    main()
