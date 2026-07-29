"""Settings endpoints. Routers stay thin; service owns sys_settings mapping."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import require_permission
from app.platform.rbac import permissions as perms
from app.platform.settings import service
from app.platform.settings.schemas import SettingsIn, SettingsOut

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("", response_model=SettingsOut)
async def get_settings(db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.ADMIN_SETTINGS_MANAGE))):
    return await service.get_app_settings(db)


@router.put("", response_model=SettingsOut)
async def update_settings(data: SettingsIn, db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(perms.ADMIN_SETTINGS_MANAGE))):
    return await service.update_app_settings(db, data, user)
