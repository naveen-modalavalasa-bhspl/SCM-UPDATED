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
from app.shared.enums import (
    AttributeDataType, AttributeTarget, BinType, BomType, PriceType, WarehouseType,
)
from app.shared.masters.crud import MasterDef
from app.shared.models.master import (
    Attribute, AttributeMapping, Bom, BomItem, Brand, Feature, Item, ItemCategory,
    ItemClass, Packaging, PriceList, PriceListItem, Project, Uom, UomConversion,
    Vendor,
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
#  Simple lookups: brands, item classes, packaging, features
# --------------------------------------------------------------------------- #
class BrandIn(BaseModel):
    code: str
    name: str
    manufacturer: str | None = None
    description: str | None = None
    is_active: bool = True


def brand_out(b: Brand) -> dict:
    return {"id": b.id, "code": b.code, "name": b.name,
            "manufacturer": b.manufacturer, "description": b.description,
            "is_active": b.is_active}


class ItemClassIn(BaseModel):
    code: str
    name: str
    description: str | None = None
    is_capitalised: bool = False
    is_active: bool = True


def item_class_out(c: ItemClass) -> dict:
    return {"id": c.id, "code": c.code, "name": c.name,
            "description": c.description, "is_capitalised": c.is_capitalised,
            "is_active": c.is_active}


class PackagingIn(BaseModel):
    code: str
    name: str
    uom_id: int | None = None
    qty_per_pack: float | None = None
    length_cm: float | None = None
    width_cm: float | None = None
    height_cm: float | None = None
    weight_kg: float | None = None
    is_returnable: bool = False
    is_active: bool = True


def _num(value):
    return float(value) if value is not None else None


def packaging_out(p: Packaging) -> dict:
    return {"id": p.id, "code": p.code, "name": p.name, "uom_id": p.uom_id,
            "uom_code": p.uom_code, "qty_per_pack": _num(p.qty_per_pack),
            "length_cm": _num(p.length_cm), "width_cm": _num(p.width_cm),
            "height_cm": _num(p.height_cm), "weight_kg": _num(p.weight_kg),
            "is_returnable": p.is_returnable, "is_active": p.is_active}


async def apply_packaging(db: AsyncSession, row: Packaging, data: PackagingIn) -> None:
    if data.qty_per_pack is not None and data.qty_per_pack <= 0:
        raise ValidationError("Quantity per pack must be greater than zero")
    uom = await db.get(Uom, data.uom_id) if data.uom_id else None
    if data.uom_id is not None and uom is None:
        raise ValidationError("Unit of measure not found")
    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.uom_code = uom.code if uom else None


class FeatureIn(BaseModel):
    code: str
    name: str
    description: str | None = None
    affects_handling: bool = False
    is_active: bool = True


def feature_out(f: Feature) -> dict:
    return {"id": f.id, "code": f.code, "name": f.name,
            "description": f.description, "affects_handling": f.affects_handling,
            "is_active": f.is_active}


# --------------------------------------------------------------------------- #
#  Attributes and attribute mapping
# --------------------------------------------------------------------------- #
class AttributeIn(BaseModel):
    code: str
    name: str
    data_type: str = AttributeDataType.TEXT.value
    unit: str | None = None
    allowed_values: list[str] | None = None
    description: str | None = None
    is_active: bool = True


def attribute_out(a: Attribute) -> dict:
    return {"id": a.id, "code": a.code, "name": a.name, "data_type": a.data_type,
            "unit": a.unit, "allowed_values": a.allowed_values or [],
            "description": a.description, "is_active": a.is_active}


async def apply_attribute(db: AsyncSession, row: Attribute, data: AttributeIn) -> None:
    if data.data_type not in {t.value for t in AttributeDataType}:
        raise ValidationError(
            f"data_type must be one of {', '.join(t.value for t in AttributeDataType)}")
    # A LIST attribute with no options would render an empty dropdown nobody can use.
    if data.data_type == AttributeDataType.LIST.value and not data.allowed_values:
        raise ValidationError("A LIST attribute needs at least one allowed value")
    for key, value in data.model_dump().items():
        setattr(row, key, value)


class AttributeMappingIn(BaseModel):
    attribute_id: int
    target_type: str
    target_id: int
    is_required: bool = False
    sort_order: int = 0
    is_active: bool = True


def attribute_mapping_out(m: AttributeMapping) -> dict:
    return {"id": m.id, "attribute_id": m.attribute_id,
            "attribute_code": m.attribute_code, "attribute_name": m.attribute_name,
            "target_type": m.target_type, "target_id": m.target_id,
            "target_name": m.target_name, "is_required": m.is_required,
            "sort_order": m.sort_order, "is_active": m.is_active}


async def apply_attribute_mapping(db: AsyncSession, row: AttributeMapping,
                                  data: AttributeMappingIn) -> None:
    """Snapshots the attribute and target names so the mapping list reads without
    joining three tables."""
    if data.target_type not in {t.value for t in AttributeTarget}:
        raise ValidationError(
            f"target_type must be one of {', '.join(t.value for t in AttributeTarget)}")
    attribute = await db.get(Attribute, data.attribute_id)
    if attribute is None:
        raise ValidationError("Attribute not found")

    if data.target_type == AttributeTarget.CATEGORY.value:
        target = await db.get(ItemCategory, data.target_id)
    else:
        target = await db.get(ItemClass, data.target_id)
    if target is None:
        raise ValidationError(f"{data.target_type.replace('_', ' ').title()} not found")

    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.attribute_code = attribute.code
    row.attribute_name = attribute.name
    row.target_name = target.name


# --------------------------------------------------------------------------- #
#  Price lists
# --------------------------------------------------------------------------- #
class PriceListIn(BaseModel):
    code: str
    name: str
    price_type: str = PriceType.PURCHASE.value
    currency: str = "INR"
    vendor_id: int | None = None
    project_id: int | None = None
    valid_from: date | None = None
    valid_to: date | None = None
    description: str | None = None
    is_active: bool = True


def price_list_out(p: PriceList) -> dict:
    return {"id": p.id, "code": p.code, "name": p.name, "price_type": p.price_type,
            "currency": p.currency, "vendor_id": p.vendor_id,
            "vendor_name": p.vendor_name, "project_id": p.project_id,
            "project_name": p.project_name,
            "valid_from": p.valid_from.isoformat() if p.valid_from else None,
            "valid_to": p.valid_to.isoformat() if p.valid_to else None,
            "description": p.description, "is_active": p.is_active}


async def apply_price_list(db: AsyncSession, row: PriceList, data: PriceListIn) -> None:
    if data.price_type not in {t.value for t in PriceType}:
        raise ValidationError(
            f"price_type must be one of {', '.join(t.value for t in PriceType)}")
    if data.valid_from and data.valid_to and data.valid_to < data.valid_from:
        raise ValidationError("valid_to cannot be before valid_from")
    vendor = await db.get(Vendor, data.vendor_id) if data.vendor_id else None
    if data.vendor_id is not None and vendor is None:
        raise ValidationError("Vendor not found")
    project = await db.get(Project, data.project_id) if data.project_id else None
    if data.project_id is not None and project is None:
        raise ValidationError("Project not found")

    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.vendor_name = vendor.name if vendor else None
    row.project_name = project.name if project else None


class PriceListItemIn(BaseModel):
    price_list_id: int
    item_id: int
    rate: float
    min_qty: float = 0
    discount_percent: float = 0
    is_active: bool = True


def price_list_item_out(r: PriceListItem) -> dict:
    return {"id": r.id, "price_list_id": r.price_list_id, "item_id": r.item_id,
            "item_code": r.item_code, "item_name": r.item_name, "uom_id": r.uom_id,
            "uom_code": r.uom_code, "rate": _num(r.rate), "min_qty": _num(r.min_qty),
            "discount_percent": _num(r.discount_percent), "is_active": r.is_active}


async def apply_price_list_item(db: AsyncSession, row: PriceListItem,
                                data: PriceListItemIn) -> None:
    if data.rate < 0:
        raise ValidationError("Rate cannot be negative")
    if not 0 <= data.discount_percent <= 100:
        raise ValidationError("Discount must be between 0 and 100")
    if await db.get(PriceList, data.price_list_id) is None:
        raise ValidationError("Price list not found")
    item = await db.get(Item, data.item_id)
    if item is None:
        raise ValidationError("Item not found")

    for key, value in data.model_dump().items():
        setattr(row, key, value)
    # The rate is per the item's own stocking unit, so it follows the item.
    row.item_code, row.item_name = item.code, item.name
    row.uom_id, row.uom_code = item.uom_id, item.uom_code


# --------------------------------------------------------------------------- #
#  Bills of material
# --------------------------------------------------------------------------- #
class BomIn(BaseModel):
    code: str
    name: str
    bom_type: str = BomType.GENERAL.value
    parent_item_id: int | None = None
    output_qty: float = 1
    project_id: int | None = None
    department_id: int | None = None
    description: str | None = None
    is_default: bool = False
    effective_from: date | None = None
    effective_to: date | None = None
    is_active: bool = True


def bom_out(b: Bom) -> dict:
    return {"id": b.id, "code": b.code, "name": b.name, "bom_type": b.bom_type,
            "parent_item_id": b.parent_item_id,
            "parent_item_code": b.parent_item_code,
            "parent_item_name": b.parent_item_name,
            "output_qty": _num(b.output_qty), "project_id": b.project_id,
            "project_name": b.project_name, "department_id": b.department_id,
            "department_name": b.department_name, "description": b.description,
            "total_items": b.total_items, "is_default": b.is_default,
            "effective_from": b.effective_from.isoformat() if b.effective_from else None,
            "effective_to": b.effective_to.isoformat() if b.effective_to else None,
            "is_active": b.is_active}


async def apply_bom(db: AsyncSession, row: Bom, data: BomIn) -> None:
    if data.bom_type not in {t.value for t in BomType}:
        raise ValidationError(
            f"bom_type must be one of {', '.join(t.value for t in BomType)}")
    if data.output_qty <= 0:
        raise ValidationError("Output quantity must be greater than zero")
    if data.effective_from and data.effective_to \
            and data.effective_to < data.effective_from:
        raise ValidationError("effective_to cannot be before effective_from")
    parent = await db.get(Item, data.parent_item_id) if data.parent_item_id else None
    if data.parent_item_id is not None and parent is None:
        raise ValidationError("Parent item not found")
    project = await db.get(Project, data.project_id) if data.project_id else None

    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.parent_item_code = parent.code if parent else None
    row.parent_item_name = parent.name if parent else None
    row.project_name = project.name if project else None


class BomItemIn(BaseModel):
    bom_id: int
    item_id: int
    line_no: int = 1
    quantity: float = 1
    scrap_percent: float = 0
    child_bom_id: int | None = None
    is_optional: bool = False
    remarks: str | None = None


def bom_item_out(r: BomItem) -> dict:
    return {"id": r.id, "bom_id": r.bom_id, "line_no": r.line_no,
            "item_id": r.item_id, "item_code": r.item_code, "item_name": r.item_name,
            "category_name": r.category_name, "uom_id": r.uom_id,
            "uom_code": r.uom_code, "quantity": _num(r.quantity),
            "scrap_percent": _num(r.scrap_percent), "child_bom_id": r.child_bom_id,
            "is_optional": r.is_optional, "remarks": r.remarks}


async def apply_bom_item(db: AsyncSession, row: BomItem, data: BomItemIn) -> None:
    bom = await db.get(Bom, data.bom_id)
    if bom is None:
        raise ValidationError("BOM not found")
    if data.quantity <= 0:
        raise ValidationError("Quantity must be greater than zero")
    item = await db.get(Item, data.item_id)
    if item is None:
        raise ValidationError("Item not found")
    # A BOM containing itself would make an expansion recurse forever.
    if data.child_bom_id is not None and data.child_bom_id == data.bom_id:
        raise ValidationError("A BOM cannot contain itself")

    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.item_code, row.item_name = item.code, item.name
    row.category_name = item.category_name
    row.uom_id, row.uom_code = item.uom_id, item.uom_code


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

    # ---- simple lookups ----
    MasterDef(path="brands", name="Brand", model=Brand, schema=BrandIn,
              manage_perm=perms.MASTER_BRAND_MANAGE, serialize=brand_out,
              search_cols=("name", "code", "manufacturer")),

    MasterDef(path="item-classes", name="Item class", model=ItemClass,
              schema=ItemClassIn, manage_perm=perms.MASTER_CLASS_MANAGE,
              serialize=item_class_out, search_cols=("name", "code")),

    MasterDef(path="packaging", name="Packaging", model=Packaging,
              schema=PackagingIn, manage_perm=perms.MASTER_PACKAGING_MANAGE,
              serialize=packaging_out, search_cols=("name", "code"),
              apply=apply_packaging),

    MasterDef(path="features", name="Feature", model=Feature, schema=FeatureIn,
              manage_perm=perms.MASTER_FEATURE_MANAGE, serialize=feature_out,
              search_cols=("name", "code")),

    # ---- attributes: the definition, then where it applies ----
    MasterDef(path="attributes", name="Attribute", model=Attribute,
              schema=AttributeIn, manage_perm=perms.MASTER_ATTRIBUTE_MANAGE,
              serialize=attribute_out, search_cols=("name", "code"),
              apply=apply_attribute),

    MasterDef(path="attribute-mappings", name="Attribute mapping",
              model=AttributeMapping, schema=AttributeMappingIn,
              manage_perm=perms.MASTER_ATTRIBUTE_MANAGE,
              serialize=attribute_mapping_out,
              search_cols=("attribute_name", "target_name"),
              order_col="sort_order", apply=apply_attribute_mapping,
              filters=("attribute_id", "target_type", "target_id")),

    # ---- price lists: header, then lines filtered by header ----
    MasterDef(path="price-lists", name="Price list", model=PriceList,
              schema=PriceListIn, manage_perm=perms.MASTER_PRICE_MANAGE,
              serialize=price_list_out, search_cols=("name", "code"),
              apply=apply_price_list, filters=("price_type", "vendor_id",
                                               "project_id")),

    MasterDef(path="price-list-items", name="Price list line", model=PriceListItem,
              schema=PriceListItemIn, manage_perm=perms.MASTER_PRICE_MANAGE,
              serialize=price_list_item_out, search_cols=("item_name", "item_code"),
              order_col="item_name", apply=apply_price_list_item,
              filters=("price_list_id", "item_id")),

    # ---- bills of material ----
    MasterDef(path="boms", name="BOM", model=Bom, schema=BomIn,
              manage_perm=perms.MASTER_BOM_MANAGE, serialize=bom_out,
              search_cols=("name", "code", "parent_item_name"), apply=apply_bom,
              filters=("bom_type", "parent_item_id", "project_id")),

    MasterDef(path="bom-items", name="BOM line", model=BomItem, schema=BomItemIn,
              manage_perm=perms.MASTER_BOM_MANAGE, serialize=bom_item_out,
              search_cols=("item_name", "item_code"), order_col="line_no",
              apply=apply_bom_item, filters=("bom_id", "item_id")),
]
