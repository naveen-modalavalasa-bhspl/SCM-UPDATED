"""Master-data endpoints. CRUD comes from the MasterDef registry; the only things
written by hand here are the two HCM mirrors (read-only, rule 10) and item specs,
whose primary key is item_id rather than a surrogate id."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_permission
from app.core.exceptions import NotFoundError, ValidationError
from app.platform.hcm.models import HcmDepartment, HcmFacility
from app.platform.rbac import permissions as perms
from app.shared.enums import AuditAction, UomClass
from app.shared.masters.crud import build_router
from app.shared.masters.defs import (
    MASTERS, UOM_SUGGESTIONS, hsn_out, packaging_breakdown,
)
from app.shared.models.master import HsnCode, Item, ItemSpec, Uom

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
#  Job profiles — the rung a BOM group is handed to
# --------------------------------------------------------------------------- #
_profiles = APIRouter(tags=["masters"])


@_profiles.get("/api/bom-groups/job-profiles")
async def bom_group_job_profiles(
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.MASTER_BOM_MANAGE)),
):
    """The job profiles a BOM can be given to, named and grouped by project.

    Gated on the BOM permission rather than on ADMIN_ROLES_MANAGE, which the RBAC
    screen's own listing uses: naming a profile is not editing one, and a master-data
    maintainer must be able to fill this dropdown without holding the keys to RBAC.

    `user` is passed on, so the dropdown is narrowed to the caller's scope rung — it
    offers exactly the profiles `apply_bom_group` will accept a write for, and a
    district admin is never shown another region's jobs.

    Derived from the HCM mirror on every read (rule 10), so a profile that no longer
    exists after a cutover simply stops being offered.
    """
    from app.platform.rbac.profiles import profile_options

    return {"items": await profile_options(db, user)}


router.include_router(_profiles)


# --------------------------------------------------------------------------- #
#  UOM suggestions — the standard units for a measurement class
# --------------------------------------------------------------------------- #
_uom = APIRouter(tags=["masters"])


@_uom.get("/api/uom/suggestions")
async def uom_suggestions(uom_class: str, db: AsyncSession = Depends(get_db),
                          user=Depends(get_current_user)):
    """The known units for a class, each flagged with whether it already exists.

    Offering the list is what stops "Litre", "litre" and "Ltr" becoming three rows:
    the admin ticks a name rather than typing one.
    """
    if uom_class not in {c.value for c in UomClass}:
        raise ValidationError(
            f"uom_class must be one of {', '.join(c.value for c in UomClass)}")
    taken = set((await db.execute(select(Uom.code))).scalars().all())
    return {"items": [{"code": code, "name": name, "exists": code in taken}
                      for code, name in UOM_SUGGESTIONS[uom_class]]}


class UomBulkIn(BaseModel):
    uom_class: str
    codes: list[str]


@_uom.post("/api/uom/suggestions")
async def create_suggested_uoms(
    data: UomBulkIn, db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.MASTER_UOM_MANAGE)),
):
    """Create the ticked suggestions in one call. Codes that already exist are
    skipped rather than rejected, so ticking the whole list twice is harmless."""
    if data.uom_class not in {c.value for c in UomClass}:
        raise ValidationError(
            f"uom_class must be one of {', '.join(c.value for c in UomClass)}")
    known = dict(UOM_SUGGESTIONS[data.uom_class])
    unknown = [code for code in data.codes if code not in known]
    if unknown:
        raise ValidationError(
            f"Not a suggested unit for {data.uom_class}: {', '.join(unknown)}")

    taken = set((await db.execute(select(Uom.code))).scalars().all())
    created = []
    for code in data.codes:
        if code in taken:
            continue
        db.add(Uom(code=code, name=known[code], uom_class=data.uom_class,
                   is_active=True))
        created.append(code)
    await db.commit()
    return {"created": created, "skipped": [c for c in data.codes if c in taken]}


router.include_router(_uom)


# --------------------------------------------------------------------------- #
#  HSN resolve — item entry may register a provisional zero-rate classification
# --------------------------------------------------------------------------- #
_hsn = APIRouter(tags=["masters"])


class HsnResolveIn(BaseModel):
    code: str = Field(min_length=8, max_length=8, pattern=r"^\d{8}$")


@_hsn.post("/api/hsn-codes/resolve")
async def resolve_hsn_code(
    data: HsnResolveIn,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.MASTER_ITEM_MANAGE)),
):
    """Return an existing HSN or create a zero-rate row for later tax maintenance.

    Item maintainers may register the classification code, but only HSN maintainers
    can subsequently edit GST rates through the normal HSN master endpoint.
    """
    existing = await db.scalar(select(HsnCode).where(HsnCode.code == data.code))
    if existing is not None:
        return hsn_out(existing)

    row = HsnCode(code=data.code, cgst_rate=0, sgst_rate=0, igst_rate=0,
                  cess_rate=0, is_active=True)
    db.add(row)
    await db.flush()

    from app.platform.settings.service import write_audit

    await write_audit(db, entity=HsnCode.__tablename__, entity_id=row.id,
                      action=AuditAction.CREATE, actor=user, after=hsn_out(row))
    await db.commit()
    await db.refresh(row)
    return hsn_out(row)


router.include_router(_hsn)


# --------------------------------------------------------------------------- #
#  Packaging breakdown — the ladder multiplied up
# --------------------------------------------------------------------------- #
_packing = APIRouter(tags=["masters"])


@_packing.get("/api/items/{item_id}/packaging-breakdown")
async def item_packaging_breakdown(item_id: int, db: AsyncSession = Depends(get_db),
                                   user=Depends(get_current_user)):
    """1 tray = 10 L, 1 box = 10 trays = 100 L, 1 container = 10 boxes = 1000 L.

    Computed from the stored rungs on every read rather than kept as a column, so
    the totals can never drift from the quantities they come from.
    """
    return {"items": await packaging_breakdown(db, item_id)}


router.include_router(_packing)


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
