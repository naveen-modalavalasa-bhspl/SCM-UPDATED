"""Warranty per received unit, captured on the GRN (MoM 2026-11-18, point 25).

Every serial / IMEI received on a GRN line can carry its own warranty: the card
(a PDF or a photo), the start and end date and, when the card has one, its number.
Most deliveries come with one warranty for the whole lot, so "same for all" is the
common press: ONE upload, one row per unit pointing at it.

A missing warranty is a WARNING, never a refusal (decided 2026-11-20): the goods are
at the gate whether or not the vendor packed the card, and refusing the GRN would only
stop real stock being booked in. The GRN shows "Warranty added for 18 of 20" until it
is complete, and the card can be added any time after submit — it often arrives later.

The unit at the gate is a string on `inb_receipt_items.serial_numbers` /
`imei_numbers` (position i of one is the same handset as position i of the other); its
`whs_serial_numbers` row is minted later, at putaway. So a warranty is keyed on the
line and the unit's CODE — the serial, else the IMEI — and every later reader (a scan,
the stock balance) finds it by item + code through `for_units`, without the unit path
knowing warranties exist.
"""
from __future__ import annotations

import json
from datetime import date

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.modules.warehouse import models as m
from app.modules.warehouse.enums import ReceiptStatus
from app.platform.settings import attachments
from app.platform.settings.service import write_audit
from app.shared.enums import AuditAction
from app.shared.models.base import utcnow

ENTITY = "GRN_WARRANTY"
CATEGORY = "WARRANTY"
#: A warranty ending within this many days is "expiring soon".
EXPIRING_DAYS = 30


def _codes(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            value = [part for part in value.replace("\n", ",").split(",")]
    if isinstance(value, dict):
        value = [code for codes in value.values() for code in (codes or [])]
    return [str(code).strip() for code in (value or []) if str(code or "").strip()]


def line_units(line) -> list[dict]:
    """The units a GRN line received, serial and IMEI paired by position. `code` is
    the unit's key: its serial, else its IMEI."""
    serials, imeis = _codes(line.serial_numbers), _codes(line.imei_numbers)
    units, seen = [], set()
    for index in range(max(len(serials), len(imeis))):
        serial = serials[index] if index < len(serials) else None
        imei = imeis[index] if index < len(imeis) else None
        code = serial or imei
        if code and code not in seen:
            seen.add(code)
            units.append({"code": code, "serial_number": serial, "imei": imei})
    return units


def status_of(end: date | None, today: date | None = None) -> tuple[str, int | None]:
    """ACTIVE, EXPIRING (inside `EXPIRING_DAYS`) or EXPIRED, and the days left."""
    if end is None:
        return "NONE", None
    days = (end - (today or date.today())).days
    if days < 0:
        return "EXPIRED", days
    return ("EXPIRING" if days <= EXPIRING_DAYS else "ACTIVE"), days


def status_sentence(end: date | None, today: date | None = None) -> str:
    status, days = status_of(end, today)
    if status == "EXPIRED":
        return f"Expired {abs(days)} day{'s' if abs(days) != 1 else ''} ago"
    if status == "EXPIRING":
        return "Ends today" if days == 0 else f"Ends in {days} day{'s' if days != 1 else ''}"
    return "In warranty" if status == "ACTIVE" else "No warranty recorded"


def _row_out(row: m.ReceiptUnitWarranty, docs: dict[int, object]) -> dict:
    status, days = status_of(row.end_date)
    doc = docs.get(row.attachment_id) if row.attachment_id else None
    return {
        "id": row.id, "start_date": row.start_date, "end_date": row.end_date,
        "card_no": row.card_no, "attachment_id": row.attachment_id,
        "document_name": getattr(doc, "file_name", None),
        "status": status, "days_left": days, "status_text": status_sentence(row.end_date),
        "added_by_name": row.created_by_name, "added_at": row.updated_at or row.created_at,
    }


def _tracked_lines(receipt: m.Receipt) -> list:
    return [line for line in receipt.items
            if getattr(line, "is_serial_tracked", False) or getattr(line, "is_imei_tracked", False)
            or line_units(line)]


async def _receipt(db: AsyncSession, receipt_id: int, user) -> m.Receipt:
    # Loaded through the GRN's own read, so its scope check is the warranty's too.
    from app.modules.warehouse import service as svc
    return await svc.get_receipt(db, receipt_id, user=user)


async def get_warranties(db: AsyncSession, receipt_id: int, user) -> dict:
    return await receipt_warranties(db, await _receipt(db, receipt_id, user))


async def receipt_warranties(db: AsyncSession, receipt: m.Receipt) -> dict:
    """Every tracked line of a GRN, each unit with its warranty or none."""
    rows = (await db.execute(
        select(m.ReceiptUnitWarranty).where(m.ReceiptUnitWarranty.receipt_id == receipt.id)
    )).scalars().all()
    by_key = {(row.receipt_item_id, row.unit_code): row for row in rows}
    doc_ids = {row.attachment_id for row in rows if row.attachment_id}
    docs = {}
    if doc_ids:
        from app.platform.settings.models import Attachment
        docs = {doc.id: doc for doc in (await db.execute(
            select(Attachment).where(Attachment.id.in_(doc_ids))
        )).scalars().all()}

    lines, covered_all, total_all = [], 0, 0
    for line in sorted(_tracked_lines(receipt), key=lambda li: li.line_no or 0):
        units = []
        for unit in line_units(line):
            row = by_key.get((line.id, unit["code"]))
            units.append({**unit, "warranty": _row_out(row, docs) if row else None})
        covered = sum(1 for unit in units if unit["warranty"])
        covered_all += covered
        total_all += len(units)
        lines.append({
            "receipt_item_id": line.id, "line_no": line.line_no, "item_id": line.item_id,
            "item_code": line.item_code, "item_name": line.item_name,
            "batch_no": line.batch_no, "units": units, "covered": covered,
            "total": len(units),
        })
    return {
        "receipt_id": receipt.id, "grn_no": receipt.grn_no, "lines": lines,
        "covered": covered_all, "total": total_all,
        "editable": receipt.status != ReceiptStatus.CANCELLED.value,
        "documents": [
            {"id": doc.id, "file_name": doc.file_name, "file_size": doc.file_size,
             "uploaded_by_name": doc.uploaded_by_name, "created_at": doc.created_at}
            for doc in sorted(docs.values(), key=lambda d: d.id)
        ],
    }


def _parse_date(value, label: str) -> date:
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value or "").strip())
    except ValueError:
        raise ValidationError(f"Give the warranty {label} as a date.") from None


async def save_warranty(db: AsyncSession, receipt_id: int, *, receipt_item_id: int,
                        codes: list[str] | str, start_date, end_date, card_no: str | None,
                        upload=None, attachment_id: int | None = None, user=None) -> dict:
    """Set one warranty on the chosen units of one line — replacing what they had.
    `codes` may arrive as a JSON list (a multipart form carries it as text)."""
    receipt = await _receipt(db, receipt_id, user)
    codes = _codes(codes)
    if receipt.status == ReceiptStatus.CANCELLED.value:
        raise ValidationError("This GRN was cancelled — its warranties cannot change.")
    line = next((li for li in receipt.items if li.id == receipt_item_id), None)
    if line is None:
        raise NotFoundError("That line is not on this GRN.")
    units = {unit["code"]: unit for unit in line_units(line)}
    if not units:
        raise ValidationError(
            f"{line.item_name or 'This line'} has no serial or IMEI captured yet — "
            "scan the units first, then add their warranty.")
    chosen = list(dict.fromkeys(code.strip() for code in codes if code and code.strip()))
    if not chosen:
        raise ValidationError("Pick at least one unit for this warranty.")
    unknown = [code for code in chosen if code not in units]
    if unknown:
        raise ValidationError(
            f"{', '.join(unknown[:3])}{' …' if len(unknown) > 3 else ''} "
            f"{'is' if len(unknown) == 1 else 'are'} not on this line.")
    start = _parse_date(start_date, "start date")
    end = _parse_date(end_date, "end date")
    if end < start:
        raise ValidationError("The warranty cannot end before it starts.")
    card = (card_no or "").strip()[:100] or None

    if upload is not None and getattr(upload, "filename", None):
        doc = await attachments.add_attachment(
            db, entity_type=ENTITY, entity_id=receipt.id, upload=upload,
            doc_category=f"{CATEGORY}::{line.id}", user=user)
        attachment_id = doc.id
    elif attachment_id:
        await attachments.require_attachment(db, attachment_id, entity_type=ENTITY,
                                             entity_id=receipt.id)
    else:
        raise ValidationError("Attach the warranty card — a PDF or a photo of it.")

    existing = {row.unit_code: row for row in (await db.execute(
        select(m.ReceiptUnitWarranty).where(
            m.ReceiptUnitWarranty.receipt_item_id == line.id,
            m.ReceiptUnitWarranty.unit_code.in_(chosen))
    )).scalars().all()}
    name = getattr(user, "full_name", None) or getattr(user, "name", None)
    for code in chosen:
        row = existing.get(code)
        if row is None:
            row = m.ReceiptUnitWarranty(
                receipt_id=receipt.id, receipt_item_id=line.id, item_id=line.item_id,
                unit_code=code, serial_number=units[code]["serial_number"],
                imei=units[code]["imei"])
            db.add(row)
        row.start_date, row.end_date, row.card_no = start, end, card
        row.attachment_id = attachment_id
        row.created_by_id = getattr(user, "id", None)
        row.created_by_name = name
        row.updated_at = utcnow()
    await write_audit(
        db, entity="inb_receipts", entity_id=receipt.id, entity_no=receipt.grn_no,
        action=AuditAction.UPDATE, actor=user,
        summary=(f"Warranty {start:%d %b %Y} – {end:%d %b %Y} added for {len(chosen)} "
                 f"unit{'s' if len(chosen) != 1 else ''} of {line.item_name or line.item_code}"),
        after={"receipt_item_id": line.id, "units": chosen, "card_no": card,
               "attachment_id": attachment_id})
    await db.commit()
    return await receipt_warranties(db, receipt)


async def remove_warranty(db: AsyncSession, receipt_id: int, warranty_id: int,
                          user=None) -> dict:
    receipt = await _receipt(db, receipt_id, user)
    if receipt.status == ReceiptStatus.CANCELLED.value:
        raise ValidationError("This GRN was cancelled — its warranties cannot change.")
    row = await db.get(m.ReceiptUnitWarranty, warranty_id)
    if row is None or row.receipt_id != receipt.id:
        raise NotFoundError("That warranty is not on this GRN.")
    await db.execute(delete(m.ReceiptUnitWarranty).where(m.ReceiptUnitWarranty.id == row.id))
    await write_audit(
        db, entity="inb_receipts", entity_id=receipt.id, entity_no=receipt.grn_no,
        action=AuditAction.UPDATE, actor=user,
        summary=f"Warranty removed from unit {row.unit_code}",
        before={"unit": row.unit_code, "start_date": str(row.start_date),
                "end_date": str(row.end_date), "card_no": row.card_no})
    await db.commit()
    return await receipt_warranties(db, receipt)


async def warranty_document(db: AsyncSession, receipt_id: int, attachment_id: int, user):
    receipt = await _receipt(db, receipt_id, user)
    await attachments.require_attachment(db, attachment_id, entity_type=ENTITY,
                                         entity_id=receipt.id)
    return await attachments.attachment_file(db, attachment_id)


async def for_units(db: AsyncSession, item_id: int, codes: list[str | None]):
    """The newest warranty recorded for a unit of `item_id` known by any of `codes`
    (its serial, its IMEI). None when nothing was recorded."""
    wanted = [code for code in codes if code]
    if not wanted:
        return None
    return (await db.execute(
        select(m.ReceiptUnitWarranty)
        .where(m.ReceiptUnitWarranty.item_id == item_id,
               m.ReceiptUnitWarranty.unit_code.in_(wanted))
        .order_by(m.ReceiptUnitWarranty.id.desc()).limit(1)
    )).scalars().first()


async def by_item(db: AsyncSession, item_ids, codes=None) -> dict[tuple[int, str], m.ReceiptUnitWarranty]:
    """{(item, code): the newest warranty recorded for it}. `codes` narrows the read to
    those units (chunked: a lot can name thousands); without it, every warranty of
    those items — the table holds only what a GRN recorded, which is small."""
    ids = sorted({int(i) for i in item_ids if i})
    if not ids:
        return {}
    stmt = (select(m.ReceiptUnitWarranty)
            .where(m.ReceiptUnitWarranty.item_id.in_(ids))
            .order_by(m.ReceiptUnitWarranty.id))
    rows: list = []
    if codes is None:
        rows = list((await db.execute(stmt)).scalars().all())
    else:
        wanted = sorted({c for c in codes if c})
        for start in range(0, len(wanted), 1000):
            rows += (await db.execute(stmt.where(
                m.ReceiptUnitWarranty.unit_code.in_(wanted[start:start + 1000])
            ))).scalars().all()
    # Ordered by id, so the newest for a unit is the one left standing.
    return {(int(row.item_id), row.unit_code): row for row in rows}


def unit_fields(row: m.ReceiptUnitWarranty | None) -> dict:
    """What a unit row says about its warranty — the same words the GRN uses."""
    if row is None:
        return {"warranty_status": "NONE"}
    status, days = status_of(row.end_date)
    return {"warranty_start": row.start_date, "warranty_end": row.end_date,
            "warranty_card_no": row.card_no, "warranty_status": status,
            "warranty_days_left": days, "warranty_text": status_sentence(row.end_date)}


def lot_tally() -> dict:
    return {"covered": 0, "active": 0, "expiring": 0, "expired": 0, "next_end": None}


def count_into(tally: dict, row: m.ReceiptUnitWarranty | None) -> None:
    """Add one unit to a lot's warranty tally: covered, and how many end soon or ended.
    `next_end` is the soonest end among units still in warranty."""
    if row is None:
        return
    status, _ = status_of(row.end_date)
    tally["covered"] += 1
    tally[{"ACTIVE": "active", "EXPIRING": "expiring", "EXPIRED": "expired"}[status]] += 1
    if status != "EXPIRED" and (tally["next_end"] is None or row.end_date < tally["next_end"]):
        tally["next_end"] = row.end_date
