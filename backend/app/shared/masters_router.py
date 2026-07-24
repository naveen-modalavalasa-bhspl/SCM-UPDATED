"""Master-data endpoints (owned by the lead / shared): items, vendors, departments,
UOM, facilities. GET is available to any authenticated user (dropdowns); create
requires the manage permission.
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_permission
from app.core.pagination import PageParams, paginate
from app.platform.hcm.models import HcmDepartment, HcmFacility
from app.platform.rbac import permissions as perms
from app.shared.models.master import Item, Uom, Vendor

router = APIRouter(tags=["masters"])


class ItemIn(BaseModel):
    code: str
    name: str
    uom_id: int | None = None
    category_id: int | None = None
    reorder_level: float | None = None


class VendorIn(BaseModel):
    code: str
    name: str
    contact_person: str | None = None
    phone: str | None = None
    email: str | None = None
    gstin: str | None = None


@router.get("/api/items")
async def list_items(params: PageParams = Depends(), search: str | None = None,
                     db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    stmt = select(Item).where(Item.is_active.is_(True))
    if search:
        stmt = stmt.where(Item.name.ilike(f"%{search}%"))
    page = await paginate(db, stmt.order_by(Item.name), params)
    page["items"] = [{"id": i.id, "code": i.code, "name": i.name,
                      "uom_id": i.uom_id, "uom_code": i.uom_code} for i in page["items"]]
    return page


@router.post("/api/items")
async def create_item(data: ItemIn, db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.MASTER_ITEM_MANAGE))):
    uom = await db.get(Uom, data.uom_id) if data.uom_id else None
    item = Item(code=data.code, name=data.name, uom_id=data.uom_id,
                uom_code=uom.code if uom else None, category_id=data.category_id,
                reorder_level=data.reorder_level, is_active=True)
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return {"id": item.id, "code": item.code, "name": item.name}


@router.get("/api/vendors")
async def list_vendors(params: PageParams = Depends(), search: str | None = None,
                       db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    stmt = select(Vendor).where(Vendor.is_active.is_(True))
    if search:
        stmt = stmt.where(Vendor.name.ilike(f"%{search}%"))
    page = await paginate(db, stmt.order_by(Vendor.name), params)
    page["items"] = [{"id": v.id, "code": v.code, "name": v.name,
                      "gstin": v.gstin} for v in page["items"]]
    return page


@router.post("/api/vendors")
async def create_vendor(data: VendorIn, db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.MASTER_VENDOR_MANAGE))):
    vendor = Vendor(code=data.code, name=data.name, contact_person=data.contact_person,
                    phone=data.phone, email=data.email, gstin=data.gstin, is_active=True)
    db.add(vendor)
    await db.commit()
    await db.refresh(vendor)
    return {"id": vendor.id, "code": vendor.code, "name": vendor.name}


@router.get("/api/departments")
async def list_departments(db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    rows = (await db.execute(
        select(HcmDepartment).where(HcmDepartment.is_active.is_(True)).order_by(HcmDepartment.name)
    )).scalars().all()
    return {"items": [{"id": d.id, "code": d.code, "name": d.name} for d in rows]}


@router.get("/api/uom")
async def list_uom(db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    rows = (await db.execute(select(Uom).where(Uom.is_active.is_(True)).order_by(Uom.code))).scalars().all()
    return {"items": [{"id": u.id, "code": u.code, "name": u.name} for u in rows]}


@router.get("/api/facilities")
async def list_facilities(db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    rows = (await db.execute(
        select(HcmFacility).where(HcmFacility.is_active.is_(True)).order_by(HcmFacility.name)
    )).scalars().all()
    return {"items": [{"id": f.id, "name": f.name, "is_stock_location": f.is_stock_location}
                      for f in rows]}
