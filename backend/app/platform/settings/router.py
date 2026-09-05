"""Settings endpoints. Routers stay thin; service owns sys_settings mapping."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_permission
from app.platform.rbac import permissions as perms
from app.platform.settings import codeformat, service
from app.platform.settings.schemas import (
    CodeFormatSettings, CompanySettings, SettingsIn, SettingsOut,
)

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("", response_model=SettingsOut)
async def get_settings(db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.ADMIN_SETTINGS_MANAGE))):
    return await service.get_app_settings(db)


# The letterhead, and only the letterhead. Authenticated, with no permission code
# on purpose: it is what every printed document already carries out of the building,
# and gating it on admin.settings.manage meant a storekeeper's printed indent came
# out under a blank header while an admin's carried the company. Read-only, and it
# exposes no other group of sys_settings.
@router.get("/company", response_model=CompanySettings)
async def get_company_letterhead(db: AsyncSession = Depends(get_db),
                                 user=Depends(get_current_user)):
    return await service.get_company_letterhead(db)


@router.put("", response_model=SettingsOut)
async def update_settings(data: SettingsIn, db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(perms.ADMIN_SETTINGS_MANAGE))):
    return await service.update_app_settings(db, data, user)


# --------------------------------------------------------------------------- #
#  Asset / consumable code formula
#
#  Its own permission and its own endpoints, because it is the one setting that
#  changes what physical labels say. See platform/settings/codeformat.py.
# --------------------------------------------------------------------------- #

@router.get("/code-formats", response_model=CodeFormatSettings)
async def get_code_formats(db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.ADMIN_CODE_FORMATS_MANAGE))):
    return await service.get_code_formats(db)


@router.put("/code-formats", response_model=CodeFormatSettings)
async def update_code_formats(data: CodeFormatSettings, db: AsyncSession = Depends(get_db),
                              user=Depends(require_permission(perms.ADMIN_CODE_FORMATS_MANAGE))):
    return await service.update_code_formats(db, data, user)


@router.get("/code-formats/tokens")
async def code_format_tokens(user=Depends(require_permission(perms.ADMIN_CODE_FORMATS_MANAGE))):
    """The tokens a code format may use. Served rather than duplicated in the UI, so
    a token added to the engine is documented on the screen without a frontend change."""
    return {"tokens": [{"token": f"{{{name}}}", "description": text}
                       for name, text in codeformat.TOKENS.items()]}


@router.get("/code-formats/preview")
async def code_format_preview(template: str, is_asset: bool = True,
                              user=Depends(require_permission(perms.ADMIN_CODE_FORMATS_MANAGE))):
    """What this template produces, rendered by the engine the putaway uses."""
    return {"preview": codeformat.preview(template, is_asset=is_asset)}
