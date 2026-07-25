"""One MasterDef per mst_ master. This is the whole masters API surface.

Only `mst_` tables live here. Roles, positions, user groups and document numbering are
RBAC/settings concerns and are served by platform/admin, which imports the same
factory — platform may import shared, but not the other way round (rule 5).
"""
from datetime import date

from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError
from app.platform.hcm.models import HcmEmployee, HcmFacility, HcmOffice
from app.platform.rbac import permissions as perms
from app.shared.enums import BinType, WarehouseType
from app.shared.masters.crud import MasterDef
from app.shared.models.master import (
    Item, ItemCategory, Project, Uom, UomConversion, Vendor,
)
from app.shared.models.warehouse import Bin, Warehouse


# --------------------------------------------------------------------------- #
#  Items
# --------------------------------------------------------------------------- #
class ItemIn(BaseModel):
    code: str
    name: str
    short_name: str | None = None
    uom_id: int | None = None
    category_id: int | None = None
    item_type: str | None = None
    hsn_code: str | None = None
    tax_percent: float | None = None
    is_batch_tracked: bool = False
    is_serial_tracked: bool = False
    is_active: bool = True


def item_out(i: Item) -> dict:
    return {"id": i.id, "code": i.code, "name": i.name, "short_name": i.short_name,
            "uom_id": i.uom_id, "uom_code": i.uom_code, "category_id": i.category_id,
            "category_name": i.category_name, "item_type": i.item_type,
            "hsn_code": i.hsn_code,
            "tax_percent": float(i.tax_percent) if i.tax_percent is not None else None,
            "is_batch_tracked": i.is_batch_tracked,
            "is_serial_tracked": i.is_serial_tracked, "is_active": i.is_active}


async def apply_item(db: AsyncSession, item: Item, data: ItemIn) -> None:
    """Snapshot uom_code and category_name onto the row so an item list renders from
    one query instead of joining two masters (rule: minimise joins per screen)."""
    uom = await db.get(Uom, data.uom_id) if data.uom_id else None
    category = await db.get(ItemCategory, data.category_id) if data.category_id else None
    for key, value in data.model_dump().items():
        setattr(item, key, value)
    item.uom_code = uom.code if uom else None
    item.category_name = category.name if category else None


# --------------------------------------------------------------------------- #
#  Item categories
# --------------------------------------------------------------------------- #
class CategoryIn(BaseModel):
    code: str
    name: str
    parent_id: int | None = None
    is_active: bool = True


def category_out(c: ItemCategory) -> dict:
    return {"id": c.id, "code": c.code, "name": c.name, "parent_id": c.parent_id,
            "level": c.level, "is_active": c.is_active}


async def apply_category(db: AsyncSession, cat: ItemCategory, data: CategoryIn) -> None:
    """`level` is derived, never supplied: a sub-category is always one below its
    parent, so the tree cannot be saved into an inconsistent depth."""
    if data.parent_id is not None and data.parent_id == cat.id:
        raise ValidationError("A category cannot be its own parent")
    parent = await db.get(ItemCategory, data.parent_id) if data.parent_id else None
    if data.parent_id is not None and parent is None:
        raise ValidationError("Parent category not found")
    for key, value in data.model_dump().items():
        setattr(cat, key, value)
    cat.level = (parent.level or 1) + 1 if parent else 1


# --------------------------------------------------------------------------- #
#  UOM and conversions
# --------------------------------------------------------------------------- #
class UomIn(BaseModel):
    code: str
    name: str
    is_active: bool = True


def uom_out(u: Uom) -> dict:
    return {"id": u.id, "code": u.code, "name": u.name, "is_active": u.is_active}


class UomConversionIn(BaseModel):
    from_uom_id: int
    to_uom_id: int
    factor: float


def uom_conversion_out(c: UomConversion) -> dict:
    return {"id": c.id, "from_uom_id": c.from_uom_id, "to_uom_id": c.to_uom_id,
            "factor": float(c.factor) if c.factor is not None else None}


async def apply_uom_conversion(db: AsyncSession, row: UomConversion,
                               data: UomConversionIn) -> None:
    if data.from_uom_id == data.to_uom_id:
        raise ValidationError("A UOM cannot convert to itself")
    if data.factor <= 0:
        raise ValidationError("Conversion factor must be greater than zero")
    if await db.get(Uom, data.from_uom_id) is None \
            or await db.get(Uom, data.to_uom_id) is None:
        raise ValidationError("Both units of measure must exist")
    for key, value in data.model_dump().items():
        setattr(row, key, value)


# --------------------------------------------------------------------------- #
#  Warehouses and bins — the location master (the DB team's whs_ tables)
# --------------------------------------------------------------------------- #
class WarehouseIn(BaseModel):
    code: str
    name: str
    facility_id: int | None = None
    office_id: int | None = None
    warehouse_type: str = "MAIN"
    address: str | None = None
    incharge_id: int | None = None
    is_bin_managed: bool = False
    is_active: bool = True


def warehouse_out(w: Warehouse) -> dict:
    return {"id": w.id, "code": w.code, "name": w.name, "facility_id": w.facility_id,
            "facility_name": w.facility_name, "office_id": w.office_id,
            "office_name": w.office_name, "warehouse_type": w.warehouse_type,
            "address": w.address, "incharge_id": w.incharge_id,
            "incharge_name": w.incharge_name, "is_bin_managed": w.is_bin_managed,
            "is_active": w.is_active}


async def apply_warehouse(db: AsyncSession, w: Warehouse, data: WarehouseIn) -> None:
    """Snapshot facility, office and incharge names so the warehouse list renders from
    one query instead of joining three HCM mirrors."""
    if data.warehouse_type not in {t.value for t in WarehouseType}:
        raise ValidationError(
            f"warehouse_type must be one of "
            f"{', '.join(t.value for t in WarehouseType)}")
    facility = await db.get(HcmFacility, data.facility_id) if data.facility_id else None
    if data.facility_id is not None and facility is None:
        raise ValidationError("Facility not found")
    incharge = await db.get(HcmEmployee, data.incharge_id) if data.incharge_id else None
    if data.incharge_id is not None and incharge is None:
        raise ValidationError("Incharge employee not found")

    for key, value in data.model_dump().items():
        setattr(w, key, value)
    w.facility_name = facility.name if facility else None
    w.incharge_name = incharge.full_name if incharge else None
    # A facility knows its office, so the office follows from it unless set explicitly.
    if facility is not None and data.office_id is None:
        w.office_id = facility.office_id
    office = await db.get(HcmOffice, w.office_id) if w.office_id else None
    w.office_name = office.name if office else None


class BinIn(BaseModel):
    warehouse_id: int
    code: str
    name: str | None = None
    parent_id: int | None = None
    bin_type: str = "STORAGE"
    capacity_qty: float | None = None
    is_pickable: bool = True
    is_active: bool = True


def bin_out(b: Bin) -> dict:
    return {"id": b.id, "warehouse_id": b.warehouse_id, "code": b.code, "name": b.name,
            "parent_id": b.parent_id, "bin_type": b.bin_type, "path": b.path,
            "level": b.level,
            "capacity_qty": float(b.capacity_qty) if b.capacity_qty is not None else None,
            "is_pickable": b.is_pickable, "is_active": b.is_active}


async def apply_bin(db: AsyncSession, b: Bin, data: BinIn) -> None:
    """`path` and `level` are derived from the parent, never supplied, so the tree
    cannot be saved into a depth that disagrees with its own ancestry."""
    if data.bin_type not in {t.value for t in BinType}:
        raise ValidationError(
            f"bin_type must be one of {', '.join(t.value for t in BinType)}")
    if await db.get(Warehouse, data.warehouse_id) is None:
        raise ValidationError("Warehouse not found")
    if data.parent_id is not None and data.parent_id == b.id:
        raise ValidationError("A bin cannot be its own parent")

    parent = await db.get(Bin, data.parent_id) if data.parent_id else None
    if data.parent_id is not None and parent is None:
        raise ValidationError("Parent bin not found")
    if parent is not None and parent.warehouse_id != data.warehouse_id:
        raise ValidationError("A bin's parent must be in the same warehouse")
    await _reject_bin_cycle(db, b, parent)

    for key, value in data.model_dump().items():
        setattr(b, key, value)
    b.level = (parent.level or 1) + 1 if parent else 1
    b.path = f"{parent.path or parent.code}/{data.code}" if parent else data.code


async def _reject_bin_cycle(db: AsyncSession, b: Bin, parent) -> None:
    """Walk up from the proposed parent. Reaching this row means the edit would make
    the tree a loop, which would hang any recursive read of it."""
    if b.id is None or parent is None:
        return
    seen, node = set(), parent
    while node is not None:
        if node.id == b.id:
            raise ValidationError("That parent would create a bin loop")
        if node.id in seen:
            return
        seen.add(node.id)
        node = await db.get(Bin, node.parent_id) if node.parent_id else None


# --------------------------------------------------------------------------- #
#  Projects — stock owners. Items stay project-agnostic (see mst_projects).
# --------------------------------------------------------------------------- #
class ProjectIn(BaseModel):
    code: str
    name: str
    office_id: int | None = None
    start_date: date | None = None
    end_date: date | None = None
    is_active: bool = True


def project_out(p: Project) -> dict:
    return {"id": p.id, "code": p.code, "name": p.name, "office_id": p.office_id,
            "office_name": p.office_name,
            "start_date": p.start_date.isoformat() if p.start_date else None,
            "end_date": p.end_date.isoformat() if p.end_date else None,
            "is_active": p.is_active}


async def apply_project(db: AsyncSession, p: Project, data: ProjectIn) -> None:
    if data.start_date and data.end_date and data.end_date < data.start_date:
        raise ValidationError("end_date cannot be before start_date")
    office = await db.get(HcmOffice, data.office_id) if data.office_id else None
    for key, value in data.model_dump().items():
        setattr(p, key, value)
    p.office_name = office.name if office else None


# --------------------------------------------------------------------------- #
#  Vendors
# --------------------------------------------------------------------------- #
class VendorIn(BaseModel):
    code: str
    name: str
    contact_person: str | None = None
    phone: str | None = None
    email: str | None = None
    city: str | None = None
    state: str | None = None
    gstin: str | None = None
    is_active: bool = True


def vendor_out(v: Vendor) -> dict:
    return {"id": v.id, "code": v.code, "name": v.name,
            "contact_person": v.contact_person, "phone": v.phone, "email": v.email,
            "city": v.city, "state": v.state, "gstin": v.gstin,
            "is_active": v.is_active}


# --------------------------------------------------------------------------- #
#  The registry
# --------------------------------------------------------------------------- #
MASTERS: list[MasterDef] = [
    MasterDef(path="items", name="Item", model=Item, schema=ItemIn,
              manage_perm=perms.MASTER_ITEM_MANAGE, serialize=item_out,
              search_cols=("name", "code"), apply=apply_item,
              default_active_only=True),

    MasterDef(path="item-categories", name="Category", model=ItemCategory,
              schema=CategoryIn, manage_perm=perms.MASTER_CATEGORY_MANAGE,
              serialize=category_out, search_cols=("name", "code"),
              apply=apply_category),

    MasterDef(path="uom", name="UOM", model=Uom, schema=UomIn,
              manage_perm=perms.MASTER_UOM_MANAGE, serialize=uom_out,
              search_cols=("name", "code"), order_col="code", paginated=False),

    # mst_uom_conversions has no is_active column, so this master cannot be
    # deactivated; the DELETE route still registers and returns a clear 400.
    MasterDef(path="uom-conversions", name="UOM conversion", model=UomConversion,
              schema=UomConversionIn, manage_perm=perms.MASTER_UOM_MANAGE,
              serialize=uom_conversion_out, order_col="from_uom_id",
              apply=apply_uom_conversion, paginated=False),

    MasterDef(path="warehouses", name="Warehouse", model=Warehouse, schema=WarehouseIn,
              manage_perm=perms.MASTER_LOCATION_MANAGE, serialize=warehouse_out,
              search_cols=("name", "code"), apply=apply_warehouse),

    MasterDef(path="bins", name="Bin", model=Bin, schema=BinIn,
              manage_perm=perms.MASTER_LOCATION_MANAGE, serialize=bin_out,
              search_cols=("code", "name", "path"), order_col="path",
              apply=apply_bin),

    MasterDef(path="projects", name="Project", model=Project, schema=ProjectIn,
              manage_perm=perms.MASTER_PROJECT_MANAGE, serialize=project_out,
              search_cols=("name", "code"), apply=apply_project),

    MasterDef(path="vendors", name="Vendor", model=Vendor, schema=VendorIn,
              manage_perm=perms.MASTER_VENDOR_MANAGE, serialize=vendor_out,
              search_cols=("name", "code"), default_active_only=True),
]
