"""The supplier's invoice and delivery challan (DC), filed against a PO (2026-10-06).

The supplier uploads them from the portal; procurement and accounts read them on the
order. Files live in `sys_attachments` under `PURCHASE_ORDER` with `doc_category`
INVOICE or DC, so nothing new is stored beside the platform's own attachment store —
which also does the type sniffing, the 20 MB cap and the audit row.

Several of each are normal: an order delivered in three lots carries three invoices
and three challans, so an upload ADDS rather than replaces. A supplier may remove only
what they uploaded themselves — the vendor id comes from the token, and every read
goes through the order's own scope first.
"""
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.modules.procurement.models import PurchaseOrder
from app.platform.settings import attachments
from app.shared.enums import VendorDocCategory

PO_ATTACHMENT_ENTITY = "PURCHASE_ORDER"
_CATEGORIES = {c.value for c in VendorDocCategory}
_SUPPLIER_TAG = " (supplier)"


def _category(value: str | None) -> str:
    category = (value or "").strip().upper()
    if category not in _CATEGORIES:
        raise ValidationError("Choose what this file is: the invoice or the delivery challan (DC).")
    return category


async def list_po_documents(db: AsyncSession, po_id: int) -> list:
    """Every invoice and DC on the order, newest first. Internal readers (PO desk,
    accounts) call this after their own permission check."""
    if await db.get(PurchaseOrder, po_id) is None:
        raise NotFoundError(f"Purchase order {po_id} not found")
    return [a for a in await attachments.list_attachments(db, PO_ATTACHMENT_ENTITY, po_id)
            if (a.doc_category or "").upper() in _CATEGORIES]


async def po_document_file(db: AsyncSession, po_id: int, attachment_id: int):
    await attachments.require_attachment(
        db, attachment_id, entity_type=PO_ATTACHMENT_ENTITY, entity_id=po_id)
    return await attachments.attachment_file(db, attachment_id)


# --- the buyer's side: the PO desk, through the order's own visibility rule ------------

async def list_for_user(db: AsyncSession, po_id: int, user) -> list:
    from app.modules.procurement.service import get_po_detail
    await get_po_detail(db, po_id, user=user)       # raises if the order is not theirs
    return await list_po_documents(db, po_id)


async def file_for_user(db: AsyncSession, po_id: int, attachment_id: int, user):
    from app.modules.procurement.service import get_po_detail
    await get_po_detail(db, po_id, user=user)
    return await po_document_file(db, po_id, attachment_id)


# --- the supplier's side: every call is scoped to the token's vendor first ----------

async def _vendor_po(db: AsyncSession, vendor_id: int, po_id: int) -> PurchaseOrder:
    from app.modules.procurement.service import _vendor_po_visible
    return await _vendor_po_visible(db, vendor_id, po_id)


async def vendor_list_documents(db: AsyncSession, vendor_id: int, po_id: int) -> list:
    po = await _vendor_po(db, vendor_id, po_id)
    return await list_po_documents(db, po.id)


async def vendor_document_file(db: AsyncSession, vendor_id: int, po_id: int,
                               attachment_id: int):
    po = await _vendor_po(db, vendor_id, po_id)
    return await po_document_file(db, po.id, attachment_id)


async def vendor_upload_document(db: AsyncSession, vendor_id: int, po_id: int, *,
                                 doc_category: str, upload) -> list:
    category = _category(doc_category)
    po = await _vendor_po(db, vendor_id, po_id)
    row = await attachments.add_attachment(
        db, entity_type=PO_ATTACHMENT_ENTITY, entity_id=po.id, upload=upload,
        doc_category=category, user=None)
    # The platform names the uploader from an employee; a supplier is not one.
    row.uploaded_by_name = f"{(po.vendor_name or 'Supplier')[:180]}{_SUPPLIER_TAG}"
    await db.commit()
    return await list_po_documents(db, po.id)


async def vendor_delete_document(db: AsyncSession, vendor_id: int, po_id: int,
                                 attachment_id: int) -> list:
    po = await _vendor_po(db, vendor_id, po_id)
    row = await attachments.require_attachment(
        db, attachment_id, entity_type=PO_ATTACHMENT_ENTITY, entity_id=po.id)
    if not (row.uploaded_by_name or "").endswith(_SUPPLIER_TAG):
        raise ValidationError("That file was attached by the buyer, not by you.")
    await attachments.delete_attachment(
        db, attachment_id, None, entity_type=PO_ATTACHMENT_ENTITY, entity_id=po.id)
    return await list_po_documents(db, po.id)
