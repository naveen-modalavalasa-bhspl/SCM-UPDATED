"""Inventory endpoints. No logic — routes call the service."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import require_permission
from app.core.pagination import Page, PageParams
from app.modules.inventory import service
from app.modules.inventory.schemas import (
    ActionIn, MovementRow, MRListRow, MROut, StockRow, TransferIn,
)
from app.platform.rbac import permissions as perms
from app.shared.enums import ApprovalAction

router = APIRouter(tags=["inventory"])

stock_router = APIRouter(prefix="/api/stock")


@stock_router.get("", response_model=Page[StockRow])
async def list_stock(params: PageParams = Depends(), item_id: int | None = None,
                     warehouse_id: int | None = None, project_id: int | None = None,
                     bin_id: int | None = None, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.STOCK_VIEW))):
    return await service.list_stock(db, params, item_id, warehouse_id, project_id,
                                    bin_id)


@stock_router.get("/movements", response_model=Page[MovementRow])
async def movements(params: PageParams = Depends(), item_id: int | None = None,
                    db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(perms.STOCK_VIEW))):
    return await service.list_movements(db, params, item_id)


@stock_router.post("/transfer", status_code=204)
async def transfer(body: TransferIn, db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission(perms.STOCK_TRANSFER))):
    await service.transfer_stock(
        db, body.item_id, body.quantity, user,
        from_warehouse_id=body.from_warehouse_id,
        to_warehouse_id=body.to_warehouse_id,
        from_project_id=body.from_project_id, to_project_id=body.to_project_id,
        ref_no=body.remarks)
    await db.commit()


mr_router = APIRouter(prefix="/api/material-requests")


@mr_router.get("", response_model=Page[MRListRow])
async def list_mrs(params: PageParams = Depends(), status: str | None = None,
                   indent_id: int | None = None, db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission(perms.MR_VIEW))):
    return await service.list_mrs(db, params, status, indent_id)


@mr_router.get("/{mr_id}", response_model=MROut)
async def get_mr(mr_id: int, db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(perms.MR_VIEW))):
    return await service.get_mr(db, mr_id)


@mr_router.post("/{mr_id}/approve", response_model=MROut)
async def approve_mr(mr_id: int, body: ActionIn, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.MR_APPROVE))):
    return await service.act_on_mr(db, mr_id, ApprovalAction.APPROVED.value, user,
                                   body.comments)


@mr_router.post("/{mr_id}/reject", response_model=MROut)
async def reject_mr(mr_id: int, body: ActionIn, db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(perms.MR_REJECT))):
    return await service.act_on_mr(db, mr_id, ApprovalAction.REJECTED.value, user,
                                   body.comments)


router.include_router(stock_router)
router.include_router(mr_router)
