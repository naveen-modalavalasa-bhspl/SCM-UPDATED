"""Master-data endpoints. CRUD comes from the MasterDef registry; the only things
written by hand here are the two HCM mirrors (read-only, rule 10) and item specs,
whose primary key is item_id rather than a surrogate id."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_permission
from app.core.exceptions import NotFoundError, ValidationError
from app.platform.hcm.models import HcmDepartment, HcmFacility
from app.platform.rbac import permissions as perms
from app.shared.masters.crud import build_router
from app.shared.masters.defs import MASTERS
from app.shared.models.master import Item, ItemSpec

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


# --------------------------------------------------------------------------- #
#  Item specifications — keyed by item_id, so this is an upsert, not a create
# --------------------------------------------------------------------------- #
_specs = APIRouter(tags=["masters"])


class ItemSpecIn(BaseModel):
    description: str | None = None
    brand: str | None = None
    model_no: str | None = None
    part_no: str | None = None
    manufacturer: str | None = None
    # Answers to whatever the item's category requires, keyed by attribute code.
    specifications: dict | None = None
    storage_conditions: str | None = None
    shelf_life_days: int | None = None
    image_url: str | None = None


def _spec_out(s: ItemSpec) -> dict:
    return {"item_id": s.item_id, "description": s.description, "brand": s.brand,
            "model_no": s.model_no, "part_no": s.part_no,
            "manufacturer": s.manufacturer, "specifications": s.specifications or {},
            "storage_conditions": s.storage_conditions,
            "shelf_life_days": s.shelf_life_days, "image_url": s.image_url}


@_specs.get("/api/item-specs/{item_id}")
async def get_item_spec(item_id: int, db: AsyncSession = Depends(get_db),
                        user=Depends(get_current_user)):
    """Returns an empty spec rather than 404 when the item has none yet, so the
    screen can render the form without a special 'not created' branch."""
    if await db.get(Item, item_id) is None:
        raise NotFoundError("Item not found")
    spec = await db.get(ItemSpec, item_id)
    return _spec_out(spec) if spec else {"item_id": item_id, "specifications": {}}


@_specs.put("/api/item-specs/{item_id}")
async def save_item_spec(item_id: int, data: ItemSpecIn,
                         db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(perms.MASTER_SPEC_MANAGE))):
    if await db.get(Item, item_id) is None:
        raise NotFoundError("Item not found")
    if data.shelf_life_days is not None and data.shelf_life_days < 0:
        raise ValidationError("Shelf life cannot be negative")

    spec = await db.get(ItemSpec, item_id)
    if spec is None:
        spec = ItemSpec(item_id=item_id)
        db.add(spec)
    for key, value in data.model_dump().items():
        setattr(spec, key, value)
    await db.commit()
    await db.refresh(spec)
    return _spec_out(spec)


router.include_router(_specs)
