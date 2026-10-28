"""Labels for what a posted issue SENT, and for what a site ACKNOWLEDGED (2026-10-28).

The Box labels queue prints a code the day it is made. This prints a DOCUMENT: every
package that left on one issue — the carton or box named on the line, the strips
inside it, the part pack cut at the desk — and every asset / consumable code it
carried, item by item, so the desk that posts an issue can label the whole load in
one press. Serial and IMEI numbers are never printed here (decided 2026-10-28): the
maker's label is already on the goods.

Two doors, one row shape:

- **After posting only.** `issue_labels` refuses an issue whose stock has not been
  posted — before that the part packs have no codes, and the boxes named on a draft
  are a claim, not a departure.
- **What arrived, not what was sent.** `received_labels` reads a consignment's rows
  with `delivered_qty > 0` — the acknowledgement's own answer — so a package the site
  marked missing is never labelled at the place it never reached.

Read-only: nothing here writes, and the codes are the ones already on the packs. A
queued Box label for the same pack is named (`label_id`) so printing here can tick it
off the queue through the existing `mark_printed`.
"""
from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.modules.warehouse import box_codes
from app.modules.warehouse import models as m
from app.modules.warehouse.enums import BoxLabelStatus
from app.modules.warehouse.packing import held

ZERO = Decimal("0")
_MAX_DEPTH = 8


def _d(value) -> Decimal:
    return Decimal(str(value or 0))


async def _descendants(db: AsyncSession, roots: list) -> dict[int, list]:
    """Every pack inside the given ones, at any depth and in ANY status — a box that
    left whole was consumed with its strips, and the strips still carry codes."""
    out: dict[int, list] = {}
    frontier = [hu.id for hu in roots]
    seen = set(frontier)
    for _ in range(_MAX_DEPTH):
        if not frontier:
            break
        kids = (await db.execute(select(m.HandlingUnit).where(
            m.HandlingUnit.parent_id.in_(frontier)).order_by(m.HandlingUnit.id))).scalars().all()
        frontier = []
        for kid in kids:
            if kid.id in seen:
                continue
            seen.add(kid.id)
            out.setdefault(kid.parent_id, []).append(kid)
            frontier.append(kid.id)
    return out


def _plural(name: str, n: int) -> str:
    return box_codes._plural(name, n)


async def _batches(db: AsyncSession, ids) -> dict[int, m.Batch]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return {b.id: b for b in (await db.execute(
        select(m.Batch).where(m.Batch.id.in_(ids)))).scalars().all()}


async def _queued(db: AsyncSession, hu_ids) -> dict[int, int]:
    """The Box-label queue row still waiting for each pack, if any."""
    if not hu_ids:
        return {}
    rows = (await db.execute(select(m.BoxLabel.handling_unit_id, m.BoxLabel.id).where(
        m.BoxLabel.handling_unit_id.in_(list(hu_ids)),
        m.BoxLabel.status == BoxLabelStatus.QUEUED.value))).all()
    return {hu_id: label_id for hu_id, label_id in rows}


async def _pack_rows(db: AsyncSession, roots: list, *, line, qty_of: dict[int, Decimal],
                     new_ids: set[int]) -> list[dict]:
    """A line's packages as label rows, parent first and each child under it."""
    from app.modules.warehouse.service import public_label_token
    tree = await _descendants(db, roots)
    every = list(roots) + [k for kids in tree.values() for k in kids]
    batches = await _batches(db, {hu.batch_id for hu in every} | {line.batch_id})
    queued = await _queued(db, {hu.id for hu in every})
    out: list[dict] = []

    def emit(hu, depth: int, parent_code: str | None):
        kids = tree.get(hu.id, [])
        inside: dict[str, int] = {}
        for k in kids:
            inside[k.pack_name or "pack"] = inside.get(k.pack_name or "pack", 0) + 1
        batch = batches.get(hu.batch_id) or batches.get(line.batch_id)
        qty = qty_of.get(hu.id, held(hu))
        out.append({
            "key": f"h-{hu.id}", "kind": "PACK", "code": hu.hu_code,
            "line_id": line.id, "item_id": line.item_id,
            "item_code": line.item_code, "item_name": line.item_name,
            "uom_code": line.uom_code,
            "pack_name": hu.pack_name, "qty": float(qty), "pack_size": float(_d(hu.pack_size)),
            "part": qty < _d(hu.pack_size),
            "batch_no": getattr(batch, "batch_no", None) or line.batch_no,
            "expiry_date": getattr(batch, "expiry_date", None) or line.expiry_date,
            "brand_name": line.brand_name, "variant_name": line.variant_name,
            "model_name": line.model_name,
            "depth": depth, "parent_code": parent_code,
            "packs_inside": ", ".join(f"{n} {_plural(k, n)}" for k, n in inside.items()) or None,
            "qr_token": public_label_token("h", hu.id),
            "label_id": queued.get(hu.id),
            "new_here": hu.id in new_ids,
        })
        if depth < _MAX_DEPTH:
            for k in kids:
                emit(k, depth + 1, hu.hu_code)

    for hu in sorted(roots, key=lambda h: h.id):
        emit(hu, 0, None)
    return out


async def _unit_rows(db: AsyncSession, units: list, *, line) -> list[dict]:
    """Asset / consumable codes as label rows. A unit with neither is skipped: its only
    identity is a serial or an IMEI, and those are the maker's label, not ours."""
    from app.modules.warehouse.service import public_label_token
    batches = await _batches(db, {u.batch_id for u in units} | {line.batch_id})
    out = []
    for u in units:
        code = u.asset_code or u.consumable_code
        if not code:
            continue
        batch = batches.get(u.batch_id) or batches.get(line.batch_id)
        out.append({
            "key": f"u-{u.id}", "kind": "UNIT", "code": code,
            "line_id": line.id, "item_id": line.item_id,
            "item_code": line.item_code, "item_name": line.item_name,
            "uom_code": line.uom_code,
            "pack_name": "Asset" if u.asset_code else "Consumable",
            "qty": 1.0, "pack_size": 1.0, "part": False,
            "batch_no": getattr(batch, "batch_no", None) or line.batch_no,
            "expiry_date": getattr(batch, "expiry_date", None) or line.expiry_date,
            "brand_name": line.brand_name, "variant_name": line.variant_name,
            "model_name": line.model_name,
            "depth": 0, "parent_code": None, "packs_inside": None,
            "qr_token": public_label_token("u", u.id),
            "label_id": None, "new_here": False,
        })
    return out


def _line_summary(line, rows: list[dict], qty) -> dict:
    return {
        "line_id": line.id, "item_id": line.item_id, "item_code": line.item_code,
        "item_name": line.item_name, "uom_code": line.uom_code, "qty": float(_d(qty)),
        "brand_name": line.brand_name, "variant_name": line.variant_name,
        "model_name": line.model_name, "batch_no": line.batch_no,
        "packs": sum(1 for r in rows if r["kind"] == "PACK" and r["depth"] == 0),
        "inner_packs": sum(1 for r in rows if r["kind"] == "PACK" and r["depth"] > 0),
        "units": sum(1 for r in rows if r["kind"] == "UNIT"),
    }


async def _units_by_code(db: AsyncSession, item_id: int, codes: set[str]) -> list:
    if not codes:
        return []
    from sqlalchemy import or_
    return list((await db.execute(select(m.SerialNumber).where(
        m.SerialNumber.item_id == item_id,
        or_(m.SerialNumber.asset_code.in_(codes), m.SerialNumber.consumable_code.in_(codes),
            m.SerialNumber.serial_number.in_(codes)))
        .order_by(m.SerialNumber.id))).scalars().all())


async def issue_labels(db: AsyncSession, issue_id: int) -> dict:
    """Every label a POSTED issue's goods should carry, item by item."""
    from app.modules.warehouse.service import _issue_units_by_line
    issue = await db.get(m.MaterialIssue, issue_id)
    if issue is None:
        raise NotFoundError("Issue not found")
    if not issue.is_stock_posted:
        raise ValidationError(
            f"{issue.issue_no} has not been issued yet — labels print once the stock is posted, "
            "when every package it sends (part packs included) has its code.")
    await db.refresh(issue, ["items"])
    line_ids = [line.id for line in issue.items]
    # A package that has since travelled lost its issue stamp at the far end; the
    # consignment row still names it, so both are read.
    shipped: dict[int, set[str]] = {}
    shipped_units: dict[int, set[str]] = {}
    for row in (await db.execute(select(m.DispatchItem).where(
            m.DispatchItem.issue_item_id.in_(line_ids or [0])))).scalars().all():
        if row.box_code:
            shipped.setdefault(row.issue_item_id, set()).add(row.box_code)
        elif row.serial_no:
            shipped_units.setdefault(row.issue_item_id, set()).add(row.serial_no)
    units_by_line = await _issue_units_by_line(db, issue)

    lines, labels = [], []
    for line in sorted(issue.items, key=lambda l: (l.line_no, l.id)):
        roots = {hu.id: hu for hu in await box_codes.line_boxes(db, issue.id, line.id)}
        codes = shipped.get(line.id, set()) - {hu.hu_code for hu in roots.values()}
        if codes:
            for hu in (await db.execute(select(m.HandlingUnit).where(
                    m.HandlingUnit.hu_code.in_(codes),
                    m.HandlingUnit.item_id == line.item_id))).scalars().all():
                roots.setdefault(hu.id, hu)
        # A pack the line issued, never one nested in another it issued.
        tops = [hu for hu in roots.values() if hu.parent_id not in roots]
        new_ids = {hu.id for hu in tops if hu.source_type == "ISSUE" and hu.source_id == issue.id}
        rows = await _pack_rows(db, tops, line=line, qty_of={}, new_ids=new_ids)
        units = {u.id: u for u in units_by_line.get(line.id, [])}
        for u in await _units_by_code(db, line.item_id, shipped_units.get(line.id, set())):
            units.setdefault(u.id, u)
        rows += await _unit_rows(db, list(units.values()), line=line)
        lines.append(_line_summary(line, rows, line.issued_qty))
        labels += rows
    return {
        "document_type": "ISSUE", "document_id": issue.id, "document_no": issue.issue_no,
        "document_date": issue.issue_date,
        "from_name": issue.warehouse_name,
        "to_name": issue.destination_warehouse_name or issue.issued_to_name,
        "lines": lines, "labels": labels,
    }


async def received_labels(db: AsyncSession, dispatch_id: int) -> dict:
    """Every label for what a site ACKNOWLEDGED on one consignment — only rows the
    acknowledgement said arrived, each package at what arrived in it."""
    dispatch = await db.get(m.Dispatch, dispatch_id)
    if dispatch is None:
        raise NotFoundError("Consignment not found")
    await db.refresh(dispatch, ["items"])
    arrived = [row for row in dispatch.items if _d(row.delivered_qty) > ZERO]
    if not arrived:
        raise ValidationError(
            f"Nothing on {dispatch.dispatch_no} has been acknowledged yet — labels print for "
            "what the site has received.")
    by_line: dict[tuple, list] = {}
    for row in arrived:
        by_line.setdefault((row.issue_item_id or 0, row.item_id, row.batch_id or 0), []).append(row)

    lines, labels = [], []
    for (_issue_item_id, item_id, _batch), rows in by_line.items():
        head = rows[0]
        pack_rows = [r for r in rows if r.box_code]
        hus = []
        qty_of: dict[int, Decimal] = {}
        if pack_rows:
            got = {r.box_code: _d(r.delivered_qty) for r in pack_rows}
            hus = (await db.execute(select(m.HandlingUnit).where(
                m.HandlingUnit.hu_code.in_(list(got)),
                m.HandlingUnit.item_id == item_id))).scalars().all()
            qty_of = {hu.id: got[hu.hu_code] for hu in hus if hu.hu_code in got}
        out = await _pack_rows(db, hus, line=head, qty_of=qty_of, new_ids=set())
        unit_codes = {r.serial_no for r in rows if not r.box_code and r.serial_no}
        out += await _unit_rows(db, await _units_by_code(db, item_id, unit_codes), line=head)
        lines.append(_line_summary(head, out, sum((_d(r.delivered_qty) for r in rows), ZERO)))
        labels += out
    return {
        "document_type": "RECEIPT", "document_id": dispatch.id, "document_no": dispatch.dispatch_no,
        "document_date": dispatch.dispatch_date,
        "from_name": dispatch.warehouse_name,
        "to_name": dispatch.to_warehouse_name,
        "lines": lines, "labels": labels,
    }


async def record_printed(db: AsyncSession, *, document_type: str, document_id: int,
                         label_ids: list[int], printed: int, reprint: bool, user) -> dict:
    """The desk said the sheet came out: tick any queued Box labels it covered and
    write who printed how many — a reprint included, so a second set of stickers on
    the road is never a mystery."""
    from app.platform.settings.service import write_audit
    from app.shared.enums import AuditAction
    if document_type == "ISSUE":
        doc = await db.get(m.MaterialIssue, document_id)
        entity, number = "out_issues", getattr(doc, "issue_no", None)
    else:
        doc = await db.get(m.Dispatch, document_id)
        entity, number = "out_dispatches", getattr(doc, "dispatch_no", None)
    if doc is None:
        raise NotFoundError("Document not found")
    await write_audit(
        db, entity=entity, entity_id=document_id, entity_no=number,
        action=AuditAction.CREATE, actor=user,
        after={"labels_printed": printed, "reprint": reprint,
               "for": "received goods" if document_type == "RECEIPT" else "issued goods"},
        summary=f"{'Reprinted' if reprint else 'Printed'} {printed} label(s) for {number}")
    # `mark_printed` commits, so the audit row above lands in the same transaction.
    ticked = 0
    if label_ids:
        ticked = (await box_codes.mark_printed(db, label_ids, user))["printed"]
    else:
        await db.commit()
    return {"printed": printed, "queue_ticked": ticked}
