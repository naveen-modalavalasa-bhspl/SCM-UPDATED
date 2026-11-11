"""Organisations and organisation departments.

The reads take a signed-in user, as `/api/departments` does: a buyer's form needs these
dropdowns whether or not they can open Settings, and the rows are names and codes. The
sync is the same permission as the HCM sync.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_permission
from app.platform.org_directory import service
from app.platform.rbac import permissions as perms

router = APIRouter(tags=["org-directory"])


@router.get("/api/organisations")
async def list_organisations(include_inactive: bool = False,
                             db: AsyncSession = Depends(get_db),
                             user=Depends(get_current_user)):
    return await service.list_organisations(db, include_inactive)


@router.get("/api/org-departments")
async def list_org_departments(include_inactive: bool = False,
                               db: AsyncSession = Depends(get_db),
                               user=Depends(get_current_user)):
    return await service.list_org_departments(db, include_inactive)


@router.get("/api/organisations/sync-status")
async def sync_status(db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    return await service.sync_status(db)


@router.post("/api/organisations/sync")
async def sync_now(db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission(perms.ADMIN_USERS_MANAGE))):
    return await service.sync_now(db)

