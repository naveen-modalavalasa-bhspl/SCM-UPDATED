from fastapi import APIRouter, Depends

from app.core.dependencies import require_permission
from app.modules.inventory import service
from app.modules.inventory.schemas import InventoryOverviewOut

router = APIRouter(prefix="/api/inventory", tags=["inventory"])


@router.get("", response_model=InventoryOverviewOut)
async def overview(user=Depends(require_permission("stock.view"))):
    return await service.get_overview()
