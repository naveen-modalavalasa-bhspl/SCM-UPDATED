"""Inventory endpoints. No logic — routes call the service."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import require_permission
from app.core.pagination import Page, PageParams
from app.modules.inventory import service
from app.modules.inventory.schemas import MovementRow, StockRow
from app.platform.rbac import permissions as perms

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


router.include_router(stock_router)
