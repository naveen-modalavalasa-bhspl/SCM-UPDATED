"""The carrier's freight invoice, filed against the shipment it carried (2026-10-06).

A carrier files an INVOICE only — a delivery challan is the goods supplier's paper,
not the truck's. Only the carrier the shipment was awarded to may file one: a losing
bidder can still open the tender read-only, and must not be able to bill for it.
Stored in `sys_attachments` under `TRANSPORT_REQUEST`, category INVOICE.
"""
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.modules.logistics.models import TransportRequest
from app.platform.settings import attachments
from app.shared.enums import VendorDocCategory

TR_ATTACHMENT_ENTITY = "TRANSPORT_REQUEST"
_INVOICE = VendorDocCategory.INVOICE.value
_CARRIER_TAG = " (carrier)"


async def list_invoices(db: AsyncSession, tr_id: int) -> list:
    if await db.get(TransportRequest, tr_id) is None:
        raise NotFoundError(f"Shipment {tr_id} not found")
    return [a for a in await attachments.list_attachments(db, TR_ATTACHMENT_ENTITY, tr_id)
            if (a.doc_category or "").upper() == _INVOICE]


async def invoice_file(db: AsyncSession, tr_id: int, attachment_id: int):
    row = await attachments.require_attachment(
        db, attachment_id, entity_type=TR_ATTACHMENT_ENTITY, entity_id=tr_id)
    if (row.doc_category or "").upper() != _INVOICE:
        raise NotFoundError(f"Attachment {attachment_id} not found")
    return await attachments.attachment_file(db, attachment_id)


async def _won(db: AsyncSession, carrier_id: int, tr_id: int) -> TransportRequest:
    """The shipment, only if this carrier was awarded it."""
    from app.modules.logistics.transport import carrier_get_request
    doc = await carrier_get_request(db, carrier_id, tr_id)
    if doc.carrier_id != carrier_id:
        raise ValidationError("Only the carrier this shipment was awarded to can invoice it.")
    return doc


async def carrier_list_invoices(db: AsyncSession, carrier_id: int, tr_id: int) -> list:
    doc = await _won(db, carrier_id, tr_id)
    return await list_invoices(db, doc.id)


async def carrier_invoice_file(db: AsyncSession, carrier_id: int, tr_id: int,
                               attachment_id: int):
    doc = await _won(db, carrier_id, tr_id)
    return await invoice_file(db, doc.id, attachment_id)


async def carrier_upload_invoice(db: AsyncSession, carrier_id: int, tr_id: int,
                                 upload) -> list:
    doc = await _won(db, carrier_id, tr_id)
    row = await attachments.add_attachment(
        db, entity_type=TR_ATTACHMENT_ENTITY, entity_id=doc.id, upload=upload,
        doc_category=_INVOICE, user=None)
    row.uploaded_by_name = f"{(doc.carrier_name or 'Carrier')[:180]}{_CARRIER_TAG}"
    await db.commit()
    return await list_invoices(db, doc.id)


async def carrier_delete_invoice(db: AsyncSession, carrier_id: int, tr_id: int,
                                 attachment_id: int) -> list:
    doc = await _won(db, carrier_id, tr_id)
    row = await attachments.require_attachment(
        db, attachment_id, entity_type=TR_ATTACHMENT_ENTITY, entity_id=doc.id)
    if not (row.uploaded_by_name or "").endswith(_CARRIER_TAG) \
            or (row.doc_category or "").upper() != _INVOICE:
        raise ValidationError("You can remove only an invoice you uploaded.")
    await attachments.delete_attachment(
        db, attachment_id, None, entity_type=TR_ATTACHMENT_ENTITY, entity_id=doc.id)
    return await list_invoices(db, doc.id)
