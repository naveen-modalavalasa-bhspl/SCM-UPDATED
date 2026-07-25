"""Master-data endpoints. CRUD comes from the MasterDef registry; the only things
written by hand here are the two HCM mirrors, which are read-only (rule 10)."""
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user
from app.platform.hcm.models import HcmDepartment, HcmFacility
from app.shared.masters.crud import build_router
from app.shared.masters.defs import MASTERS

router = build_router(MASTERS)

_hcm = APIRouter(tags=["masters"])


@_hcm.get("/api/departments")
async def list_departments(db: AsyncSession = Depends(get_db),
                           user=Depends(get_current_user)):
    rows = (await db.execute(
        select(HcmDepartment).where(HcmDepartment.is_active.is_(True))
        .order_by(HcmDepartment.name)
    )).scalars().all()
    return {"items": [{"id": d.id, "code": d.code, "name": d.name} for d in rows]}


@_hcm.get("/api/facilities")
async def list_facilities(db: AsyncSession = Depends(get_db),
                          user=Depends(get_current_user)):
    rows = (await db.execute(
        select(HcmFacility).where(HcmFacility.is_active.is_(True))
        .order_by(HcmFacility.name)
    )).scalars().all()
    return {"items": [{"id": f.id, "name": f.name,
                       "is_stock_location": f.is_stock_location} for f in rows]}


router.include_router(_hcm)
