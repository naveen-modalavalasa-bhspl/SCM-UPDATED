"""Accounts endpoints. No logic — every route calls the service.

`/api/accounts/**` is the accounts desk (accounts.view / .pay / .approve).
`/api/pos/{po_id}/payments` is the same read for the PO desk, behind `po.view`, so the
buyer sees what has been paid without being handed the accounts screen.
"""
from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import require_permission
from app.core.pagination import Page, PageParams
from app.modules.accounts import service
from app.modules.accounts.schemas import (
    CarrierInvoiceRow, PayableRow, PaymentActionIn, PaymentIn, PaymentOut, PoPaymentsOut,
)
from app.platform.rbac import permissions as perms

accounts = APIRouter(prefix="/api/accounts", tags=["accounts"])
po_side = APIRouter(prefix="/api/pos", tags=["accounts"])


@accounts.get("/meta")
async def accounts_meta(user=Depends(require_permission(perms.ACCOUNTS_VIEW))):
    return service.meta()


@accounts.get("/payables", response_model=Page[PayableRow])
async def payables(params: PageParams = Depends(), tab: str = "open",
                   search: str | None = None, vendor_id: int | None = None,
                   project_id: int | None = None, db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission(perms.ACCOUNTS_VIEW))):
    """Approved orders with payment terms: total, paid, outstanding, what is next."""
    return await service.list_payables(db, params, tab=tab, search=search,
                                       vendor_id=vendor_id, project_id=project_id)


@accounts.get("/pos/{po_id}", response_model=PoPaymentsOut)
async def po_payments(po_id: int, db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.ACCOUNTS_VIEW))):
    return await service.po_payments(db, po_id, user)


@accounts.get("/pos/{po_id}/documents/{attachment_id}/download")
async def po_document_download(po_id: int, attachment_id: int,
                               db: AsyncSession = Depends(get_db),
                               user=Depends(require_permission(perms.ACCOUNTS_VIEW))):
    path, file_name, mime_type = await service.po_document_file(db, po_id, attachment_id)
    return FileResponse(path, filename=file_name, media_type=mime_type)


@accounts.get("/payments", response_model=Page[PaymentOut])
async def payments(params: PageParams = Depends(), status: str | None = None,
                   search: str | None = None, po_id: int | None = None,
                   db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission(perms.ACCOUNTS_VIEW))):
    return await service.list_payments(db, params, user, status=status, search=search,
                                       po_id=po_id)


@accounts.get("/payments/{payment_id}", response_model=PaymentOut)
async def payment(payment_id: int, db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(perms.ACCOUNTS_VIEW))):
    return await service.get_payment(db, payment_id, user)


@accounts.post("/payments", response_model=PaymentOut, status_code=201)
async def record_payment(body: PaymentIn, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(perms.ACCOUNTS_PAY))):
    """Record a payment against one milestone. It counts once its ladder signs it."""
    return await service.record_payment(db, body, user)


@accounts.post("/payments/{payment_id}/act", response_model=PaymentOut)
async def act_on_payment(payment_id: int, body: PaymentActionIn,
                         db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(perms.ACCOUNTS_APPROVE))):
    return await service.act_on_payment(db, payment_id, body.action, user, body.remarks)


@accounts.post("/payments/{payment_id}/proofs", response_model=PaymentOut, status_code=201)
async def add_payment_proof(payment_id: int, file: UploadFile = File(...),
                            db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.ACCOUNTS_PAY))):
    """Attach the bank advice, UTR screenshot or cheque scan to a payment."""
    return await service.add_payment_proof(db, payment_id, file, user)


@accounts.get("/payments/{payment_id}/proofs/{attachment_id}/download")
async def payment_proof_download(payment_id: int, attachment_id: int,
                                 db: AsyncSession = Depends(get_db),
                                 user=Depends(require_permission(perms.ACCOUNTS_VIEW))):
    path, file_name, mime_type = await service.payment_proof_file(db, payment_id, attachment_id)
    return FileResponse(path, filename=file_name, media_type=mime_type)


@accounts.get("/carrier-invoices", response_model=Page[CarrierInvoiceRow])
async def carrier_invoices(params: PageParams = Depends(), search: str | None = None,
                           db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.ACCOUNTS_VIEW))):
    return await service.list_carrier_invoices(db, params, search)


@accounts.get("/carrier-invoices/{tr_id}/{attachment_id}/download")
async def carrier_invoice_download(tr_id: int, attachment_id: int,
                                   db: AsyncSession = Depends(get_db),
                                   user=Depends(require_permission(perms.ACCOUNTS_VIEW))):
    path, file_name, mime_type = await service.carrier_invoice_file(db, tr_id, attachment_id)
    return FileResponse(path, filename=file_name, media_type=mime_type)


@po_side.get("/{po_id}/payments", response_model=PoPaymentsOut)
async def po_payments_for_buyer(po_id: int, db: AsyncSession = Depends(get_db),
                                user=Depends(require_permission(perms.PO_VIEW))):
    """The PO desk's read of the same answer: what is due, paid and pending."""
    return await service.po_payments_for_buyer(db, po_id, user)


@po_side.get("/{po_id}/payments/{payment_id}/proofs/{attachment_id}/download")
async def payment_proof_download_for_buyer(po_id: int, payment_id: int, attachment_id: int,
                                           db: AsyncSession = Depends(get_db),
                                           user=Depends(require_permission(perms.PO_VIEW))):
    path, file_name, mime_type = await service.payment_proof_file_for_buyer(
        db, po_id, payment_id, attachment_id, user)
    return FileResponse(path, filename=file_name, media_type=mime_type)


router = APIRouter()
router.include_router(accounts)
router.include_router(po_side)
