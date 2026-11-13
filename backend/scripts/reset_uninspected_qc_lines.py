"""Reset the QC lines nobody has inspected yet to un-inspected (SCM_0124, 2026-11-13).

Before this, a QC sheet was raised with every line already "fully accepted" (inspected =
accepted = what arrived / was issued) and only its result said Pending — so the first
Save on a sheet nobody had looked at turned Pending into Pass. New sheets now start at
0 / 0 / 0 (`warehouse.service.qc_split`).

This brings the sheets still OPEN (draft / in progress) into line: a line still marked
Pending is set to inspected 0, accepted 0, rejected 0, its picked units cleared. Lines
already judged (Passed / Failed / Partial) and every completed, cancelled or rejected
sheet are left exactly as they are. Inward (`inb_inspections`) and outward
(`whs_inspections`, which Stock Transfer QC uses too) alike. Idempotent.

    .venv/Scripts/python -m scripts.reset_uninspected_qc_lines          # say what would change
    .venv/Scripts/python -m scripts.reset_uninspected_qc_lines --apply  # and write it
"""
import asyncio
import sys
from decimal import Decimal

from sqlalchemy import select

from app.core.database import SessionLocal
from app.modules.indents import models as _indents  # noqa: F401 — every mapper
from app.modules.inventory import models as _inventory  # noqa: F401
from app.modules.warehouse import models as m
from app.modules.warehouse import service
from app.modules.warehouse.enums import InspectionResult, InspectionStatus

OPEN = (InspectionStatus.DRAFT.value, InspectionStatus.IN_PROGRESS.value)
ZERO = Decimal("0")


async def _reset(db, sheet_model, line_model, label: str) -> int:
    rows = (await db.execute(
        select(line_model, sheet_model.inspection_no)
        .join(sheet_model, sheet_model.id == line_model.inspection_id)
        .where(sheet_model.status.in_(OPEN),
               line_model.result == InspectionResult.PENDING.value,
               line_model.inspected_qty > ZERO)
        .order_by(line_model.inspection_id, line_model.id)
    )).all()
    touched_sheets = set()
    for line, number in rows:
        print(f"  {label} {number}: {line.item_code} — was {line.inspected_qty:g} inspected / "
              f"{line.accepted_qty:g} accepted, now un-inspected")
        line.inspected_qty = line.accepted_qty = line.rejected_qty = ZERO
        line.serial_numbers = None
        if hasattr(line, "imei_numbers"):
            line.imei_numbers = None
        if hasattr(line, "pack_rejections"):
            line.pack_rejections = None
        touched_sheets.add(line.inspection_id)
    for sheet_id in touched_sheets:
        sheet = await db.get(sheet_model, sheet_id)
        await db.refresh(sheet, attribute_names=["items"])
        (service._inspection_totals if sheet_model is m.Inspection
         else service._outbound_inspection_totals)(sheet)
    return len(rows)


async def main(apply: bool) -> None:
    async with SessionLocal() as db:
        inward = await _reset(db, m.Inspection, m.InspectionItem, "Inward ")
        outward = await _reset(db, m.OutboundInspection, m.OutboundInspectionItem, "Outward")
        total = inward + outward
        if apply:
            await db.commit()
            print(f"\n{total} line(s) reset ({inward} inward, {outward} outward).")
        else:
            await db.rollback()
            print(f"\n{total} line(s) would be reset ({inward} inward, {outward} outward). "
                  "Nothing written — pass --apply.")


if __name__ == "__main__":
    asyncio.run(main("--apply" in sys.argv))
