"""Procurement endpoints. No logic — every route calls the service."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import require_permission
from app.core.pagination import Page, PageParams
from app.modules.procurement import service
from app.modules.procurement.schemas import ActionIn, POCreate, POListRow, POOut
from app.platform.rbac import permissions as perms

router = APIRouter(prefix="/api/pos", tags=["procurement"])


@router.get("", response_model=Page[POListRow])
async def list_pos(params: PageParams = Depends(), status: str | None = None,
                   vendor_id: int | None = None, db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission(perms.PO_VIEW))):
    return await service.list_pos(db, params, status, vendor_id)


@router.get("/open-for-grn", response_model=Page[POListRow])
async def open_for_grn(params: PageParams = Depends(), db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.PO_VIEW))):
    return await service.open_for_grn(db, params)


@router.post("/from-indent/{indent_id}", response_model=POOut)
async def create_from_indent(indent_id: int, data: POCreate, db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.PO_CREATE))):
    return await service.create_po_from_indent(db, indent_id, data, user)


@router.get("/{po_id}", response_model=POOut)
async def get_one(po_id: int, db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(perms.PO_VIEW))):
    return await service.get_po(db, po_id)


@router.post("/{po_id}/submit", response_model=POOut)
async def submit(po_id: int, db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(perms.PO_SUBMIT))):
    return await service.submit_po(db, po_id, user)


@router.post("/{po_id}/approve", response_model=POOut)
async def approve(po_id: int, body: ActionIn = ActionIn(), db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(perms.PO_APPROVE))):
    return await service.act_on_po(db, po_id, "APPROVE", body.comments, user)


@router.post("/{po_id}/reject", response_model=POOut)
async def reject(po_id: int, body: ActionIn = ActionIn(), db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(perms.PO_REJECT))):
    return await service.act_on_po(db, po_id, "REJECT", body.comments, user)


@router.post("/{po_id}/send-to-vendor", response_model=POOut)
async def send_to_vendor(po_id: int, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(perms.PO_SEND_VENDOR))):
    return await service.send_to_vendor(db, po_id, user)
