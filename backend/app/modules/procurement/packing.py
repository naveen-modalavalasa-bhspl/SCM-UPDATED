"""How a purchase order's goods are to be PACKED, and the supplier's answer (2026-10-08).

Every PO line keeps its quantity in the item's base unit — that is what is bought,
received, paid for and capped. On top of it the line now says HOW: one of the item's
pack hierarchies and a breakdown inside it ("2 Carton" of "Strip of 10"). The vendor
reads it on the portal and despatches in it — or in other levels of the same
hierarchy, which is always fine (2 Carton or 24 Box are the same order).

A DIFFERENT hierarchy is a different product shape (strips of 15 instead of 10), so it
is allowed but never silent: the despatch note line is marked PENDING, the buyer is
notified, and the buyer accepts it (the order now says the new hierarchy) or declines
it (the gate sees the refusal on the receipt before booking anything in).

The arithmetic is `app/shared/packing.py`; the ladders come from
`app/shared/masters/packs.py`. Nothing here trusts a client's idea of a pack size.
"""
from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.platform.notifications import service as notifications
from app.platform.settings.service import write_audit
from app.shared import packing
from app.shared.enums import AuditAction, PackChangeStatus
from app.shared.masters import packs
from app.shared.models.base import utcnow
from app.modules.procurement.models import (
    DespatchNote, DespatchNoteItem, POItem, PurchaseOrder,
)

logger = logging.getLogger(__name__)


def _entries(raw) -> list[dict] | None:
    """A request's breakdown as plain dicts (pydantic models or dicts both accepted)."""
    if not raw:
        return None
    return [e.model_dump() if hasattr(e, "model_dump") else dict(e) for e in raw]


async def stamp_line(db: AsyncSession, row, *, hierarchy_id, entries) -> None:
    """Freeze what a client said about one line's packing onto it.

    A breakdown must add up to the line's quantity — the server never lets the two
    numbers on one line disagree. A hierarchy with no breakdown means "this
    hierarchy, in its biggest whole packs". Neither leaves the line for
    `sync_po_packing` to describe.
    """
    entries = _entries(entries)
    if not entries and not hierarchy_id:
        return
    # The order says how packs are to be MADE, so a part pack under its level's
    # minimum is refused here (2026-10-11).
    hid, out = await packs.snapshot(db, item_id=row.item_id, hierarchy_id=hierarchy_id,
                                    entries=entries, base_qty=row.quantity,
                                    enforce_min=True)
    row.pack_hierarchy_id, row.pack_breakdown = hid, out or None


async def sync_po_packing(db: AsyncSession, po_id: int) -> None:
    """Make every line's packing agree with its quantity. Run on every write that
    creates lines or changes a quantity, before the commit.

    * a line whose quantity moved under its breakdown is rescaled in the same
      hierarchy (an approver trimming 2 Carton to 1,800 TAB reads "18 Box");
    * a line with no packing yet is described in the item's DEFAULT hierarchy, in
      whole packs — so an order written off a quotation still tells the supplier how
      to pack it. An item with no packing configured is left alone.
    """
    rows = (await db.execute(select(POItem).where(POItem.po_id == po_id))).scalars().all()
    if not rows:
        return
    found = await packs.ladders(db, {row.item_id for row in rows})
    for row in rows:
        ladders = found.get(row.item_id) or []
        if row.pack_breakdown:
            if packing.base_of(row.pack_breakdown) == packing.dec(row.quantity):
                continue
            ladder = next((l for l in ladders if l.hierarchy_id == row.pack_hierarchy_id),
                          None)
            if ladder is None:
                row.pack_hierarchy_id, row.pack_breakdown = None, None
            else:
                out = packing.rescale(ladder, row.pack_breakdown, row.quantity)
                for e in out:
                    e["hierarchy"] = ladder.hierarchy_name
                row.pack_breakdown = out
                continue
        if not ladders or ladders[0].top == 0:
            continue
        ladder = ladders[0]
        out = packing.greedy(ladder, row.quantity)
        for e in out:
            e["hierarchy"] = ladder.hierarchy_name
        row.pack_hierarchy_id, row.pack_breakdown = ladder.hierarchy_id, out


def pack_text(row) -> str | None:
    """"2 Carton = 2,400 TAB" for any line carrying a breakdown."""
    entries = getattr(row, "pack_breakdown", None)
    if not entries:
        return None
    return packing.describe(entries, getattr(row, "uom_code", None))


def hierarchy_name(row) -> str | None:
    entries = getattr(row, "pack_breakdown", None) or []
    return next((e.get("hierarchy") for e in entries if e.get("hierarchy")), None)


# --------------------------------------------------------------------------- #
#  The despatch note: how the supplier actually packed it
# --------------------------------------------------------------------------- #

async def stamp_despatch_line(db: AsyncSession, row: DespatchNoteItem, po_line: POItem, *,
                              hierarchy_id, entries, reason: str | None) -> None:
    """The supplier's packing for one note line, and whether it needs the buyer.

    `despatched_qty` becomes the breakdown's total — the vendor states packs, the
    server counts tablets. With no breakdown, the line is described in the ORDER's
    hierarchy. A hierarchy other than the order's goes to the buyer and must say why.
    A part pack is a fact about what is on the lorry, so one under the level's minimum
    is accepted here and only flagged on screen (2026-10-11).
    """
    entries = _entries(entries)
    ordered_hid = po_line.pack_hierarchy_id
    chosen = hierarchy_id or ordered_hid
    if entries:
        hid, out = await packs.snapshot(db, item_id=row.item_id, hierarchy_id=chosen,
                                        entries=entries)
        row.despatched_qty = packing.base_of(out)
    else:
        hid, out = await packs.snapshot(db, item_id=row.item_id, hierarchy_id=chosen,
                                        entries=None, base_qty=row.despatched_qty)
    row.pack_hierarchy_id, row.pack_breakdown = hid, out or None

    changed = bool(ordered_hid and hid and hid != ordered_hid)
    if not changed:
        row.pack_change_status = PackChangeStatus.NONE.value
        row.ordered_pack_hierarchy_id = row.ordered_pack_hierarchy_name = None
        row.pack_change_reason = None
        return
    if not (reason or "").strip():
        raise ValidationError(
            f"{po_line.item_code or po_line.item_name}: the order asks for "
            f"\"{hierarchy_name(po_line) or 'its own packing'}\" and you are sending "
            f"\"{(out[0].get('hierarchy') if out else 'another packing')}\". Say why — "
            "the buyer reads your reason before accepting the change.")
    row.pack_change_status = PackChangeStatus.PENDING.value
    row.ordered_pack_hierarchy_id = ordered_hid
    row.ordered_pack_hierarchy_name = hierarchy_name(po_line)
    row.pack_change_reason = reason.strip()[:500]
    row.pack_change_note = row.pack_change_by_name = None
    row.pack_change_at = None


async def notify_buyer_of_changes(db: AsyncSession, note: DespatchNote,
                                  po: PurchaseOrder) -> int:
    """On submit: one notification to the buyer naming every line whose packing the
    supplier changed. Nothing is said for a note that kept the order's packing."""
    pending = [line for line in note.items
               if line.pack_change_status == PackChangeStatus.PENDING.value]
    if not pending:
        return 0
    names = ", ".join(f"{line.item_code or line.item_name}: "
                      f"{line.ordered_pack_hierarchy_name} → "
                      f"{hierarchy_name(line)}" for line in pending[:5])
    more = f" and {len(pending) - 5} more" if len(pending) > 5 else ""
    return await notifications.notify(
        db, [po.created_by_id],
        title=f"{po.po_no} — supplier changed the packing",
        body=(f"{po.vendor_name or 'The supplier'} is despatching {note.dn_no} in a "
              f"different pack hierarchy: {names}{more}. Accept or decline it on the "
              "order."),
        entity_type="PO", entity_id=po.id,
        deep_link=f"/procurement/pos/{po.id}?tab=packing")


async def list_pack_changes(db: AsyncSession, po_id: int) -> list[dict]:
    """Every despatch-note line on this order that changed the packing, newest first,
    decided ones included — the buyer's record of what was agreed."""
    rows = (await db.execute(
        select(DespatchNoteItem, DespatchNote)
        .join(DespatchNote, DespatchNote.id == DespatchNoteItem.despatch_note_id)
        .where(DespatchNote.po_id == po_id,
               DespatchNoteItem.pack_change_status != PackChangeStatus.NONE.value)
        .order_by(DespatchNoteItem.id.desc())
    )).all()
    out = []
    for line, note in rows:
        out.append({
            "id": line.id, "despatch_note_id": note.id, "dn_no": note.dn_no,
            "dn_status": note.status, "po_item_id": line.po_item_id,
            "item_id": line.item_id, "item_code": line.item_code,
            "item_name": line.item_name, "uom_code": line.uom_code,
            "despatched_qty": float(line.despatched_qty or 0),
            "status": line.pack_change_status,
            "ordered_hierarchy_name": line.ordered_pack_hierarchy_name,
            "sent_hierarchy_name": hierarchy_name(line),
            "sent_pack_text": pack_text(line),
            "pack_breakdown": line.pack_breakdown,
            "reason": line.pack_change_reason,
            "decision_note": line.pack_change_note,
            "decided_by_name": line.pack_change_by_name,
            "decided_at": line.pack_change_at,
        })
    return out


async def decide_pack_change(db: AsyncSession, po_id: int, line_id: int, *,
                             accept: bool, note: str | None, user) -> dict:
    """The buyer's answer to one changed line.

    ACCEPT rewrites the ORDER line's packing into the supplier's hierarchy — same base
    quantity, described in whole packs of the new family — so every later note,
    receipt and putaway reads the hierarchy that is actually arriving. DECLINE leaves
    the order as it was; the gate is shown the refusal on the receipt.

    Either way the supplier is told, and the decision is audited.
    """
    row = await db.get(DespatchNoteItem, line_id)
    note_row = await db.get(DespatchNote, row.despatch_note_id) if row else None
    if row is None or note_row is None or note_row.po_id != po_id:
        raise NotFoundError("That packing change is not on this order.")
    if row.pack_change_status != PackChangeStatus.PENDING.value:
        raise ValidationError(
            f"This change was already {row.pack_change_status.lower()} "
            f"by {row.pack_change_by_name or 'someone'}.")
    if not accept and not (note or "").strip():
        raise ValidationError("Say why the change is declined — the supplier reads it.")
    po = await db.get(PurchaseOrder, po_id)
    po_line = await db.get(POItem, row.po_item_id) if row.po_item_id else None
    before = {"status": row.pack_change_status,
              "po_line_hierarchy": po_line.pack_hierarchy_id if po_line else None}

    if accept and po_line is not None:
        ladder = await packs.ladder(db, po_line.item_id, row.pack_hierarchy_id)
        out = packing.greedy(ladder, po_line.quantity)
        for e in out:
            e["hierarchy"] = ladder.hierarchy_name
        po_line.pack_hierarchy_id, po_line.pack_breakdown = ladder.hierarchy_id, out
    row.pack_change_status = (PackChangeStatus.ACCEPTED if accept
                              else PackChangeStatus.DECLINED).value
    row.pack_change_note = (note or "").strip()[:500] or None
    row.pack_change_by_name = getattr(user, "full_name", None)
    row.pack_change_at = utcnow()

    from app.modules.procurement.service import notify_vendor
    verdict = "accepted" if accept else "declined"
    await notify_vendor(
        db, po.vendor_id if po else None,
        title=f"{po.po_no if po else 'Order'} — packing change {verdict}",
        body=(f"{row.item_code or row.item_name} on {note_row.dn_no}: sending "
              f"\"{hierarchy_name(row)}\" instead of \"{row.ordered_pack_hierarchy_name}\" "
              f"was {verdict}" + (f". {row.pack_change_note}" if row.pack_change_note
                                  else ".")),
        entity_type="PO", entity_id=po_id, deep_link=f"/supplier/pos/{po_id}")
    await write_audit(db, entity="pro_despatch_note_items", entity_id=row.id,
                      entity_no=note_row.dn_no, action=AuditAction.UPDATE, actor=user,
                      before=before,
                      after={"status": row.pack_change_status, "note": row.pack_change_note,
                             "po_line_hierarchy": po_line.pack_hierarchy_id
                             if po_line else None})
    await db.commit()
    logger.info("%s: packing change on %s line %s %s by %s", po.po_no if po else po_id,
                note_row.dn_no, row.id, verdict, getattr(user, "full_name", "?"))
    return next(c for c in await list_pack_changes(db, po_id) if c["id"] == row.id)


# --------------------------------------------------------------------------- #
#  Re-packing one PO line from the order screen
# --------------------------------------------------------------------------- #

async def repack_po_line(db: AsyncSession, po: PurchaseOrder, line: POItem, *,
                         hierarchy_id, entries, user, closed_statuses: tuple,
                         despatched_no: str | None) -> dict:
    """Change how a PO line is to be packed: its hierarchy, its levels, its count.

    Packing DESCRIBES the ordered quantity and never changes it, at any status — a
    draft included. "1 Pack + 150 loose" of pack-of-500 → "1 Pack + 200 loose" of
    pack-of-450 is the same 650 re-packed; the supplier is told if the order has
    already reached them. Buying more or less is the line's quantity (on a draft) or
    an amendment, never a re-pack.

    Refused once the supplier has despatched against the order: the despatch note
    already states how the goods were packed, and the gate receives against that.
    """
    from app.shared.enums import POStatus, POVendorStatus
    disallowed_statuses = (
        POStatus.SENT_TO_VENDOR.value,
        POStatus.ACCEPTED_BY_SUPPLIER.value,
        POStatus.PENDING_APPROVAL.value,
        POStatus.SUBMITTED.value,
        POStatus.PARTIALLY_RECEIVED.value,
        POStatus.RECEIVED.value,
        POStatus.CLOSED.value,
        POStatus.CANCELLED.value,
        POStatus.REJECTED.value,
    )
    if po.status in disallowed_statuses or (po.vendor_status and po.vendor_status in (
        POVendorStatus.PENDING.value, POVendorStatus.ACCEPTED.value, POVendorStatus.REJECTED.value
    )):
        raise ValidationError(
            f"{po.po_no} is {po.status} — packaging cannot be edited once an order is sent to "
            "the supplier, awaiting approval, or closed. To alter packaging on an active contract, "
            "amend the order."
        )
    if po.status in closed_statuses:
        raise ValidationError(f"{po.po_no} is {po.status} — its packing can no longer change.")
    if despatched_no:
        raise ValidationError(
            f"The supplier has already despatched against {po.po_no} on {despatched_no}; "
            "that note fixes how the goods are packed.")
    entries = _entries(entries)
    if not entries:
        raise ValidationError("Say how the line is packed — at least one pack or loose quantity.")
    hid, out = await packs.snapshot(db, item_id=line.item_id, hierarchy_id=hierarchy_id,
                                    entries=entries, enforce_min=True)
    new_qty = packing.base_of(out)
    old_qty = packing.dec(line.quantity)
    if new_qty <= ZERO_QTY:
        raise ValidationError("The packing adds up to nothing.")
    if new_qty != old_qty:
        raise ValidationError(
            f"That packing comes to {packing.fmt(new_qty)} {line.uom_code or 'units'}, "
            f"but {po.po_no} orders {packing.fmt(old_qty)}. Packing only changes how the "
            "quantity is packed — re-pack it to the ordered quantity, or change the "
            "quantity itself.")
    before = {"pack_text": pack_text(line), "quantity": str(old_qty)}
    line.pack_hierarchy_id, line.pack_breakdown = hid, out
    from app.shared.enums import POStatus
    sent = po.status in (POStatus.SENT_TO_VENDOR.value, POStatus.ACCEPTED_BY_SUPPLIER.value)
    if sent:
        from app.modules.procurement.service import notify_vendor
        await notify_vendor(
            db, po.vendor_id, title=f"{po.po_no} — packing changed",
            body=(f"{line.item_code or line.item_name}: please pack it as "
                  f"{packing.describe(out, line.uom_code)} (was {before['pack_text'] or 'loose'})."),
            entity_type="PO", entity_id=po.id, deep_link=f"/supplier/pos/{po.id}")
    await write_audit(db, entity="pro_po_items", entity_id=line.id, entity_no=po.po_no,
                      action=AuditAction.UPDATE, actor=user, before=before,
                      after={"pack_text": packing.describe(out, line.uom_code),
                             "quantity": str(new_qty)})
    return {"quantity_changed": new_qty != old_qty, "supplier_told": sent}


ZERO_QTY = packing.ZERO
