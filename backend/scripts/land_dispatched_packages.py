"""Shelve, at the receiving point, the PACKAGES a consignment carried (2026-10-26).

A consignment packed by package (one `out_dispatch_items` row per box / strip, with
`box_code`) now lands those packages at the receiving point under the SAME codes, each
holding what arrived in it. Consignments acknowledged before that change were re-packed
there into new packs instead. This brings them forward:

* the packs the old arrival made at the receiving point (source DISPATCH, this
  consignment, not one of its package codes) are closed — their units unlinked;
* the packages are landed (`box_codes.land_packages`), each with the units it holds.

Quantities never move: the stock was credited when the consignment was signed for.

    .venv/Scripts/python -m scripts.land_dispatched_packages            # preview
    .venv/Scripts/python -m scripts.land_dispatched_packages --apply    # save
"""
from __future__ import annotations

import argparse
import asyncio

from sqlalchemy import select, update
from sqlalchemy.orm import selectinload

from app.core.database import SessionLocal
from app.modules.warehouse import box_codes
from app.modules.warehouse import models as m
from app.modules.warehouse.enums import (
    DispatchStatus, HandlingUnitStatus as HUS, LIVE_HANDLING_UNIT_STATUSES as LIVE,
)
from app.shared.models.base import utcnow


async def run(apply: bool) -> None:
    report: list[str] = []
    async with SessionLocal() as db:
        dispatches = (await db.execute(
            select(m.Dispatch).options(selectinload(m.Dispatch.items))
            .where(m.Dispatch.status == DispatchStatus.ACKNOWLEDGED.value,
                   m.Dispatch.to_warehouse_id.isnot(None),
                   m.Dispatch.id.in_(select(m.DispatchItem.dispatch_id)
                                     .where(m.DispatchItem.box_code.isnot(None))))
            .order_by(m.Dispatch.id))).scalars().all()
        for dispatch in dispatches:
            rows = [row for row in dispatch.items if row.box_code]
            codes = {row.box_code for row in rows}
            already = (await db.execute(select(m.HandlingUnit.hu_code).where(
                m.HandlingUnit.hu_code.in_(codes),
                m.HandlingUnit.warehouse_id == dispatch.to_warehouse_id,
                m.HandlingUnit.status.in_(LIVE)))).scalars().all()
            if len(already) == len([r for r in rows if r.delivered_qty and r.delivered_qty > 0]):
                continue
            old = (await db.execute(select(m.HandlingUnit).where(
                m.HandlingUnit.warehouse_id == dispatch.to_warehouse_id,
                m.HandlingUnit.source_type == "DISPATCH",
                m.HandlingUnit.source_id == dispatch.id,
                m.HandlingUnit.status.in_(LIVE),
                m.HandlingUnit.hu_code.notin_(codes)))).scalars().all()
            for hu in old:
                hu.status, hu.closed_reason = HUS.OPENED.value, (
                    "Replaced by the packages the consignment carried")
                hu.closed_by_name, hu.closed_at, hu.parent_id = "System", utcnow(), None
            if old:
                await db.execute(update(m.SerialNumber).where(
                    m.SerialNumber.handling_unit_id.in_([hu.id for hu in old]))
                    .values(handling_unit_id=None))
            landed = 0
            for batch_id in {row.batch_id for row in rows}:
                landed += await box_codes.land_packages(
                    db, dispatch, [r for r in rows if r.batch_id == batch_id], batch_id=batch_id)
            report.append(f"{dispatch.dispatch_no}: {len(old)} re-packed pack(s) closed, "
                          f"{landed} package(s) landed with their codes")
        if apply:
            await db.commit()
        else:
            await db.rollback()
    print(f"\n{'APPLY' if apply else 'PREVIEW'} - {len(report)} consignment(s) brought forward")
    for line in report:
        print("  " + line)
    if not apply:
        print("\nNothing was saved. Run again with --apply to save.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--apply", action="store_true")
    asyncio.run(run(parser.parse_args().apply))


if __name__ == "__main__":
    main()
