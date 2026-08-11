"""One MasterDef per mst_ master. This is the whole masters API surface.

Only `mst_` tables live here. Roles, positions, user groups and document numbering are
RBAC/settings concerns and are served by platform/admin, which imports the same
factory — platform may import shared, but not the other way round (rule 5).
"""
from datetime import date
from decimal import Decimal
import re

from pydantic import BaseModel, Field
from sqlalchemy import false, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.platform.hcm.models import HcmEmployee, HcmFacility, HcmOffice
from app.platform.rbac import permissions as perms
from app.shared.enums import (
    AttributeDataType, BinType, CategoryTagType, UomClass, WarehouseType,
)
from app.shared.masters.crud import MasterDef
from app.shared.models.master import (
    Attribute, Bom, BomGroup, BomItem, Brand, BrandGeneralName, BrandManufacturer,
    CategoryTag, DosageForm, Feature, GeneralName, HsnCode, Item, ItemCategory,
    ItemClass, ItemComponent, ItemGroup, ItemPackaging, ItemSubClass, Manufacturer,
    Packaging, Project, Spec, Uom, UomConversion, Vendor, VendorItem,
)
from app.shared.models.warehouse import Bin, Warehouse


# --------------------------------------------------------------------------- #
#  Shared validation
# --------------------------------------------------------------------------- #
async def require_unique(db: AsyncSession, model: type, column: str, value: str,
                         row, label: str, *, scope=None) -> None:
    """Reject a duplicate value on `column`, case-insensitively.

    Done in Python rather than with a unique index because the scoped cases cannot be
    indexed reliably: a Level 1 category has parent_id NULL, and MySQL counts NULLs in
    a unique index as distinct, so two Level 1 rows named "Furniture" would both pass
    an index and only collide in the user's head.

    `row` is the row being saved; on an update it is excluded so a row does not clash
    with itself. `scope` is an extra WHERE clause — the categories use it to scope the
    check to one parent, which is what lets Furniture be a Level 1 and also a Level 2
    under a different branch.
    """
    text = (value or "").strip()
    if not text:
        raise ValidationError(f"{label} is required")
    stmt = select(model.id).where(func.lower(getattr(model, column)) == text.lower())
    if scope is not None:
        stmt = stmt.where(scope)
    if getattr(row, "id", None) is not None:
        stmt = stmt.where(model.id != row.id)
    if await db.scalar(stmt) is not None:
        raise ValidationError(f"{label} '{text}' already exists")


# --------------------------------------------------------------------------- #
#  Items
# --------------------------------------------------------------------------- #
def build_item_prefix(category_path: str, general_code: str, brand_code: str,
                      manufacturer_code: str) -> str:
    """The part of an item code that identity decides: 101010-PARACET-DOLO-DOLO."""
    if not re.fullmatch(r"\d{6}", category_path or ""):
        raise ValidationError("Select a Level 3 category with a six-digit category path")
    parts = [general_code, brand_code, manufacturer_code]
    if any(not re.fullmatch(
        r"[A-Z0-9]+(?:-[A-Z0-9]+)*", (part or "").strip().upper())
           for part in parts):
        raise ValidationError(
            "General name, brand and manufacturer codes may contain letters, "
            "numbers and internal hyphens only"
        )
    return "-".join([category_path, *(part.strip().upper() for part in parts)])


def build_item_code(category_path: str, general_code: str, brand_code: str,
                    manufacturer_code: str, serial: int) -> str:
    """The full item code: identity, then a four-digit serial.

    The serial is what lets one brand and manufacturer carry several items — Dolo
    650 and Dolo 500 share every other part of the code and differ only here.
    """
    if not 1 <= serial <= 9999:
        raise ValidationError(
            "This brand and manufacturer already have 9999 items in this category")
    code = f"{build_item_prefix(category_path, general_code, brand_code, manufacturer_code)}-{serial:04d}"
    if len(code) > 50:
        raise ValidationError("Generated item code exceeds 50 characters")
    return code


async def next_item_serial(db: AsyncSession, prefix: str) -> int:
    """The next free serial for a prefix.

    Reads the existing serials FOR UPDATE, which makes InnoDB hold the range so a
    second transaction on the same prefix waits rather than picking the same number.
    Two brand-new prefixes racing is still possible, and the unique index on
    mst_items.code is what catches that — it surfaces as a readable duplicate
    message rather than two items sharing a code.
    """
    rows = (await db.execute(
        select(Item.serial_no).where(Item.code.like(f"{prefix}-%")).with_for_update()
    )).scalars().all()
    return max([r for r in rows if r] or [0]) + 1


class ItemIn(BaseModel):
    """What the item form sends.

    Deliberately absent, though the columns still exist:
      · pricing and tax — tax comes from the HSN row at PO/GRN time, and
        purchase_price is fed by GRN as the stock-valuation cost, not typed here;
      · stock limits — reorder levels are a warehouse decision, not an item one;
      · shelf life — expiry is tracked per batch, so a fixed number on the item
        only ever disagreed with the stock.
    """
    name: str
    short_name: str | None = None
    category_id: int
    general_name_id: int
    brand_id: int
    manufacturer_id: int
    item_class_id: int
    item_sub_class_id: int | None = None
    uom_id: int
    hsn_id: int
    # Asset or consumable. The asset/consumable code itself is generated during
    # putaway in the warehouse module — nothing is numbered here.
    is_asset: bool = False
    description: str | None = None
    has_components: bool = False
    barcode_type: str | None = None
    barcode_value: str | None = None
    is_batch_tracked: bool = False
    is_serial_tracked: bool = False
    is_imei_tracked: bool = False
    has_expiry: bool = False
    requires_qi: bool = False
    dosage_form_id: int | None = None
    valuation_method: str = "FIFO"
    requires_special_storage: bool = False
    storage_conditions: str | None = None
    requires_special_transport: bool = False
    transport_conditions: str | None = None
    is_active: bool = True


def item_out(i: Item) -> dict:
    return {"id": i.id, "code": i.code, "serial_no": i.serial_no, "name": i.name,
            "short_name": i.short_name,
            "uom_id": i.uom_id, "uom_code": i.uom_code, "category_id": i.category_id,
            "category_name": i.category_name, "item_type": i.item_type,
            "general_name_id": i.general_name_id, "general_name_code": i.general_name_code,
            "general_name": i.general_name, "brand_id": i.brand_id,
            "brand_code": i.brand_code, "brand_name": i.brand_name,
            "manufacturer_id": i.manufacturer_id,
            "manufacturer_code": i.manufacturer_code,
            "manufacturer_name": i.manufacturer_name,
            "item_class_id": i.item_class_id, "item_class_code": i.item_class_code,
            "item_class_name": i.item_class_name,
            "item_sub_class_id": i.item_sub_class_id,
            "item_sub_class_code": i.item_sub_class_code,
            "item_sub_class_name": i.item_sub_class_name,
            "hsn_id": i.hsn_id, "hsn_code": i.hsn_code, "is_asset": i.is_asset,
            "description": i.description,
            "has_components": i.has_components, "barcode_type": i.barcode_type,
            "barcode_value": i.barcode_value,
            "is_batch_tracked": i.is_batch_tracked,
            "is_serial_tracked": i.is_serial_tracked,
            "is_imei_tracked": i.is_imei_tracked, "has_expiry": i.has_expiry,
            "requires_qi": i.requires_qi,
            "dosage_form_id": i.dosage_form_id,
            "dosage_form_code": i.dosage_form_code,
            "dosage_form_name": i.dosage_form_name,
            "valuation_method": i.valuation_method,
            "requires_special_storage": i.requires_special_storage,
            "storage_conditions": i.storage_conditions,
            "requires_special_transport": i.requires_special_transport,
            "transport_conditions": i.transport_conditions,
            "is_active": i.is_active}


async def apply_item(db: AsyncSession, item: Item, data: ItemIn) -> None:
    """Validates the item's identity and snapshots the codes onto the row.

    Snapshots let an item list render from one query rather than joining seven
    masters, which is what the list screen actually needs.
    """
    uom = await db.get(Uom, data.uom_id)
    category = await db.get(ItemCategory, data.category_id)
    general = await db.get(GeneralName, data.general_name_id)
    brand = await db.get(Brand, data.brand_id)
    manufacturer = await db.get(Manufacturer, data.manufacturer_id)
    item_class = await db.get(ItemClass, data.item_class_id)
    hsn = await db.get(HsnCode, data.hsn_id)
    sub_class = await db.get(ItemSubClass, data.item_sub_class_id) \
        if data.item_sub_class_id else None
    dosage = await db.get(DosageForm, data.dosage_form_id) \
        if data.dosage_form_id else None
    missing = []
    if category is None:
        missing.append("category")
    if general is None:
        missing.append("general name")
    if brand is None:
        missing.append("brand")
    if manufacturer is None:
        missing.append("manufacturer")
    if item_class is None:
        missing.append("item class")
    if uom is None:
        missing.append("UOM")
    if missing:
        raise ValidationError(f"Missing required item fields: {', '.join(missing)}")
    if hsn is None:
        raise ValidationError("An HSN code is required")
    if category.level != 3:
        raise ValidationError("Select a Level 3 category with a six-digit category path")
    mapping = await db.scalar(select(BrandManufacturer.id).where(
        BrandManufacturer.brand_id == brand.id,
        BrandManufacturer.manufacturer_id == manufacturer.id,
        BrandManufacturer.is_active.is_(True),
    ))
    if mapping is None:
        raise ValidationError("The selected manufacturer is not mapped to this brand")
    if sub_class and sub_class.item_class_id != item_class.id:
        raise ValidationError("The selected subclass does not belong to this item class")

    for key, value in data.model_dump().items():
        setattr(item, key, value)
    # The code is assigned once and never regenerated. Re-deriving it on every edit
    # would renumber an item that already has stock, ledger rows and documents
    # pointing at the code it was created with.
    if item.code is None:
        prefix = build_item_prefix(category.path, general.code, brand.code,
                                   manufacturer.code)
        item.serial_no = await next_item_serial(db, prefix)
        item.code = build_item_code(category.path, general.code, brand.code,
                                    manufacturer.code, item.serial_no)
    item.uom_code = uom.code
    item.hsn_code = hsn.code
    item.category_name = category.name
    item.general_name_code, item.general_name = general.code, general.name
    item.brand_code, item.brand_name = brand.code, brand.name
    item.manufacturer_code, item.manufacturer_name = manufacturer.code, manufacturer.name
    item.item_class_code, item.item_class_name = item_class.code, item_class.name
    item.item_sub_class_code = sub_class.code if sub_class else None
    item.item_sub_class_name = sub_class.name if sub_class else None
    item.dosage_form_code = dosage.code if dosage else None
    item.dosage_form_name = dosage.name if dosage else None
    item.item_type = item_class.code


async def restrict_items_to_my_groups(db: AsyncSession, user, stmt):
    """Narrow an item list to what the caller's user groups allow.

    Tagging is opt-in and additive: only groups that actually carry item tags take
    part, and a user in none of them sees everything. Configuration must never
    strand a requester with an empty catalogue (rule 8's spirit).

    The import is function-local so the module graph still runs one way — shared
    must not depend on platform at import time (rule 5), the same dodge crud.py
    uses to reach the audit writer.
    """
    from app.platform.admin.groups import resolve_member_ids

    tagged = (await db.execute(
        select(ItemGroup.group_id).where(ItemGroup.is_active.is_(True)).distinct()
    )).scalars().all()
    if not tagged:
        return stmt
    mine = [gid for gid in tagged
            if user.id in await resolve_member_ids(db, gid)]
    if not mine:
        return stmt
    return stmt.where(Item.id.in_(
        select(ItemGroup.item_id).where(ItemGroup.group_id.in_(mine),
                                        ItemGroup.is_active.is_(True))
    ))


# --------------------------------------------------------------------------- #
#  Item categories
# --------------------------------------------------------------------------- #
class CategoryIn(BaseModel):
    code: str
    name: str
    parent_id: int | None = None
    segment_code: str | None = None
    is_active: bool = True


def category_out(c: ItemCategory) -> dict:
    return {"id": c.id, "code": c.code, "name": c.name, "parent_id": c.parent_id,
            "level": c.level, "segment_code": c.segment_code, "path": c.path,
            "is_active": c.is_active}


async def apply_category(db: AsyncSession, cat: ItemCategory, data: CategoryIn) -> None:
    """`level` is derived, never supplied: a sub-category is always one below its
    parent, so the tree cannot be saved into an inconsistent depth."""
    if data.parent_id is not None and data.parent_id == cat.id:
        raise ValidationError("A category cannot be its own parent")
    parent = await db.get(ItemCategory, data.parent_id) if data.parent_id else None
    if data.parent_id is not None and parent is None:
        raise ValidationError("Parent category not found")
    level = (parent.level or 1) + 1 if parent else 1
    if level > 3:
        raise ValidationError("Item categories support only Level 1, 2 and 3")
    # Scoped to the parent, not to the level: Furniture must not appear twice among
    # the Level 1 roots, but it may still be a Level 2 under a different Level 1.
    await require_unique(
        db, ItemCategory, "name", data.name, cat, "A category named",
        scope=(ItemCategory.parent_id == data.parent_id if data.parent_id is not None
               else ItemCategory.parent_id.is_(None)),
    )
    await require_unique(db, ItemCategory, "code", data.code, cat, "Category code")
    segment = data.segment_code
    if not segment:
        sibling_max = await db.scalar(select(func.max(ItemCategory.segment_code)).where(
            ItemCategory.parent_id == data.parent_id
            if data.parent_id is not None else ItemCategory.parent_id.is_(None)
        ))
        segment = f"{int(sibling_max or -1) + 1:02d}"
    if len(segment) != 2 or not segment.isdigit() or not 0 <= int(segment) <= 99:
        raise ValidationError("Category segment must be two digits from 00 to 99")
    for key, value in data.model_dump(exclude={"segment_code"}).items():
        setattr(cat, key, value)
    cat.level = level
    cat.segment_code = segment
    cat.path = f"{parent.path if parent else ''}{segment}"


# --------------------------------------------------------------------------- #
#  UOM and conversions
# --------------------------------------------------------------------------- #
class UomIn(BaseModel):
    code: str = Field(min_length=1, max_length=20)
    name: str
    uom_class: str
    is_active: bool = True


def uom_out(u: Uom) -> dict:
    return {"id": u.id, "code": u.code, "name": u.name,
            "uom_class": u.uom_class, "is_active": u.is_active}


async def apply_uom(db: AsyncSession, row: Uom, data: UomIn) -> None:
    if data.uom_class not in {c.value for c in UomClass}:
        raise ValidationError(
            f"uom_class must be one of {', '.join(c.value for c in UomClass)}")
    await require_unique(db, Uom, "code", data.code, row, "UOM code")
    # Name is scoped to the class: "Ton" as a weight and "Ton" as a refrigeration
    # capacity are different units that happen to share a word.
    await require_unique(db, Uom, "name", data.name, row, "A unit named",
                         scope=(Uom.uom_class == data.uom_class))
    for key, value in data.model_dump().items():
        setattr(row, key, value)


# The units worth offering for each class, so an admin picks from a list instead of
# inventing spellings. Not config: these are the SI/trade names, and letting them be
# edited is how "Litre", "litre" and "Ltr" all end up in the same dropdown.
UOM_SUGGESTIONS: dict[str, list[tuple[str, str]]] = {
    UomClass.COUNT.value: [("PCS", "Pieces"), ("NOS", "Numbers"), ("PAIR", "Pair"),
                           ("SET", "Set"), ("DOZ", "Dozen")],
    UomClass.LENGTH.value: [("MM", "Millimetre"), ("CM", "Centimetre"),
                            ("MTR", "Metre"), ("KM", "Kilometre"), ("INCH", "Inch"),
                            ("FT", "Foot")],
    UomClass.AREA.value: [("SQM", "Square metre"), ("SQFT", "Square foot"),
                          ("SQCM", "Square centimetre")],
    UomClass.VOLUME.value: [("ML", "Millilitre"), ("LTR", "Litre"),
                            ("CBM", "Cubic metre"), ("GAL", "Gallon")],
    UomClass.WEIGHT.value: [("MG", "Milligram"), ("GM", "Gram"), ("KG", "Kilogram"),
                            ("QTL", "Quintal"), ("TON", "Tonne")],
    UomClass.TEMPERATURE.value: [("CEL", "Celsius"), ("FAH", "Fahrenheit"),
                                 ("KEL", "Kelvin")],
    UomClass.TIME.value: [("SEC", "Second"), ("MIN", "Minute"), ("HR", "Hour"),
                          ("DAY", "Day"), ("MON", "Month"), ("YR", "Year")],
    UomClass.PRESSURE.value: [("PA", "Pascal"), ("KPA", "Kilopascal"), ("BAR", "Bar"),
                              ("PSI", "Pounds per square inch")],
    UomClass.ENERGY.value: [("J", "Joule"), ("KJ", "Kilojoule"), ("CAL", "Calorie"),
                            ("KWH", "Kilowatt hour"), ("W", "Watt")],
    UomClass.PACKAGING.value: [("BOX", "Box"), ("CTN", "Carton"), ("TRAY", "Tray"),
                               ("PLT", "Pallet"), ("BAG", "Bag"), ("DRUM", "Drum"),
                               ("CONT", "Container"), ("ROLL", "Roll")],
}


class UomConversionIn(BaseModel):
    from_uom_id: int
    to_uom_id: int
    factor: float


def uom_conversion_out(c: UomConversion) -> dict:
    return {"id": c.id, "from_uom_id": c.from_uom_id, "to_uom_id": c.to_uom_id,
            "from_uom_code": c.from_uom.code if c.from_uom else None,
            "to_uom_code": c.to_uom.code if c.to_uom else None,
            "factor": float(c.factor) if c.factor is not None else None}


async def apply_uom_conversion(db: AsyncSession, row: UomConversion,
                               data: UomConversionIn) -> None:
    if data.from_uom_id == data.to_uom_id:
        raise ValidationError("A UOM cannot convert to itself")
    if data.factor <= 0:
        raise ValidationError("Conversion factor must be greater than zero")
    from_uom = await db.get(Uom, data.from_uom_id)
    to_uom = await db.get(Uom, data.to_uom_id)
    if from_uom is None or to_uom is None:
        raise ValidationError("Both units of measure must exist")
    for key, value in data.model_dump().items():
        setattr(row, key, value)
    # Attach the loaded rows to the relationships. Serialising a brand-new row would
    # otherwise have to lazy-load them, and a lazy load on an async session raises
    # instead of emitting SQL. Reads get them eagerly via lazy="selectin".
    row.from_uom = from_uom
    row.to_uom = to_uom


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
    bin_type: str = "BIN"
    capacity_qty: float | None = None
    is_active: bool = True


def bin_out(b: Bin) -> dict:
    return {"id": b.id, "warehouse_id": b.warehouse_id, "code": b.code, "name": b.name,
            "parent_id": b.parent_id, "bin_type": b.bin_type,
            "capacity_qty": float(b.capacity_qty) if b.capacity_qty is not None else None,
            "is_pickable": b.is_pickable, "is_active": b.is_active}


async def apply_bin(db: AsyncSession, b: Bin, data: BinIn) -> None:
    """Depth and ancestry are derived when a tree is read, never stored, so the tree
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
    # Free text rather than an enum: the live column is a plain VARCHAR the DB team
    # already fills with values SCM does not own.
    vendor_type: str = "MATERIAL"
    contact_person: str | None = None
    phone: str | None = None
    email: str | None = None
    address: str | None = None
    city: str | None = None
    state: str | None = None
    pincode: str | None = None
    gstin: str | None = None
    pan: str | None = None
    payment_terms_days: int | None = Field(default=None, ge=0, le=365)
    credit_limit: Decimal | None = Field(default=None, ge=0)
    rating: Decimal | None = Field(default=None, ge=0, le=5)
    is_approved: bool = False
    is_blacklisted: bool = False
    is_active: bool = True


def vendor_out(v: Vendor) -> dict:
    return {"id": v.id, "code": v.code, "name": v.name,
            "vendor_type": v.vendor_type,
            "contact_person": v.contact_person, "phone": v.phone, "email": v.email,
            "address": v.address, "city": v.city, "state": v.state,
            "pincode": v.pincode, "gstin": v.gstin, "pan": v.pan,
            "payment_terms_days": v.payment_terms_days,
            "credit_limit": v.credit_limit, "rating": v.rating,
            "is_approved": v.is_approved, "is_blacklisted": v.is_blacklisted,
            "is_active": v.is_active}


class VendorItemIn(BaseModel):
    vendor_id: int
    item_id: int
    vendor_item_code: str | None = None
    last_rate: Decimal | None = Field(default=None, ge=0)
    lead_time_days: int | None = Field(default=None, ge=0, le=3650)
    min_order_qty: Decimal | None = Field(default=None, ge=0)
    is_preferred: bool = False


def vendor_item_out(row: VendorItem) -> dict:
    return {"id": row.id, "vendor_id": row.vendor_id, "item_id": row.item_id,
            "vendor_name": row.vendor.name if row.vendor else None,
            "vendor_code": row.vendor.code if row.vendor else None,
            "item_code": row.item_code, "item_name": row.item_name,
            "vendor_item_code": row.vendor_item_code,
            "last_rate": row.last_rate, "lead_time_days": row.lead_time_days,
            "min_order_qty": row.min_order_qty,
            "is_preferred": row.is_preferred}


async def apply_vendor_item(db: AsyncSession, row: VendorItem,
                            data: VendorItemIn) -> None:
    """Snapshots the item's code and name, and keeps 'preferred' to one vendor.

    Two preferred vendors for one item is not a preference, so ticking a new one
    unticks the old. Done here rather than with a unique index: the constraint is
    "at most one TRUE per item", which an index cannot express.
    """
    vendor = await db.get(Vendor, data.vendor_id)
    if vendor is None:
        raise ValidationError("That vendor does not exist")
    item = await db.get(Item, data.item_id)
    if item is None:
        raise ValidationError("That item does not exist")

    clash = (await db.execute(
        select(VendorItem).where(VendorItem.vendor_id == data.vendor_id,
                                 VendorItem.item_id == data.item_id)
    )).scalars().first()
    if clash is not None and clash.id != row.id:
        raise ValidationError(
            f"{vendor.name} already has a rate for {item.code}. Edit that row instead.")

    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.item_code, row.item_name = item.code, item.name

    if data.is_preferred:
        others = (await db.execute(
            select(VendorItem).where(VendorItem.item_id == data.item_id,
                                     VendorItem.is_preferred.is_(True))
        )).scalars().all()
        for other in others:
            if other.id != row.id:
                other.is_preferred = False


# --------------------------------------------------------------------------- #
#  Item identity lookups
# --------------------------------------------------------------------------- #
class NamedCodeIn(BaseModel):
    code: str = Field(
        min_length=1, max_length=10,
        pattern=r"^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$")
    name: str
    description: str | None = None
    is_active: bool = True


def named_code_out(row) -> dict:
    return {"id": row.id, "code": row.code, "name": row.name,
            "description": getattr(row, "description", None),
            "is_active": row.is_active}


def named_code_apply(model: type, label: str):
    """Every simple lookup wants the same two checks. Written once and bound per
    master, so a new lookup gets uniqueness by declaring it rather than by
    remembering to."""
    async def apply(db: AsyncSession, row, data: BaseModel) -> None:
        await require_unique(db, model, "name", data.name, row, f"{label} named")
        await require_unique(db, model, "code", data.code, row, f"{label} code")
        for key, value in data.model_dump().items():
            setattr(row, key, value)
    return apply


class GeneralNameIn(NamedCodeIn):
    # The brands that sell this general name, edited here rather than on a mapping
    # screen of its own — the same call as brands carrying their manufacturers.
    brand_ids: list[int] = Field(default_factory=list)


def general_name_out(row: GeneralName) -> dict:
    links = [b for b in (row.brands or []) if b.is_active]
    return {"id": row.id, "code": row.code, "name": row.name,
            "description": row.description,
            "brand_ids": [b.brand_id for b in links],
            "brand_names": [b.brand_name for b in links],
            "is_active": row.is_active}


async def apply_general_name(db: AsyncSession, row: GeneralName,
                             data: GeneralNameIn) -> None:
    """Writes the general name and reconciles its mst_brand_general_names rows."""
    if row.id is None:
        # See apply_brand: marks the collection loaded on a row that has never been
        # queried, so the first read after the create-flush is not a lazy load.
        row.brands = []
    await require_unique(db, GeneralName, "name", data.name, row, "A general name")
    await require_unique(db, GeneralName, "code", data.code, row, "General name code")
    wanted = list(dict.fromkeys(data.brand_ids))    # de-dupe, keep order
    rows = (await db.execute(
        select(Brand).where(Brand.id.in_(wanted))
    )).scalars().all() if wanted else []
    if len(rows) != len(wanted):
        raise ValidationError("One of the selected brands does not exist")

    for key, value in data.model_dump(exclude={"brand_ids"}).items():
        setattr(row, key, value)

    by_id = {link.brand_id: link for link in (row.brands or [])}
    for brand in rows:
        link = by_id.get(brand.id)
        if link is None:
            row.brands.append(BrandGeneralName(
                general_name_code=data.code, general_name_name=data.name,
                brand_id=brand.id, brand_code=brand.code, brand_name=brand.name,
                is_active=True))
        else:
            link.is_active = True
            link.brand_code, link.brand_name = brand.code, brand.name
    # Unticked links are deactivated, never deleted: items already carry this
    # general-name/brand pair and the row proves the pair was once legal.
    for brand_id, link in by_id.items():
        if brand_id not in set(wanted):
            link.is_active = False
    for link in row.brands:
        link.general_name_code, link.general_name_name = data.code, data.name


class BrandIn(BaseModel):
    code: str = Field(
        min_length=1, max_length=10,
        pattern=r"^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$")
    name: str
    description: str | None = None
    # A brand's manufacturers, edited here rather than on a screen of their own. One
    # brand is routinely made by several plants, and a separate mapping tab meant
    # creating a brand and then remembering to go somewhere else to make it usable.
    manufacturer_ids: list[int] = Field(default_factory=list)
    is_active: bool = True


def brand_out(b: Brand) -> dict:
    links = [m for m in (b.manufacturers or []) if m.is_active]
    return {"id": b.id, "code": b.code, "name": b.name,
            "description": b.description,
            "manufacturer_ids": [m.manufacturer_id for m in links],
            "manufacturer_names": [m.manufacturer_name for m in links],
            "is_active": b.is_active}


async def apply_brand(db: AsyncSession, row: Brand, data: BrandIn) -> None:
    """Writes the brand and reconciles its mst_brand_manufacturers rows in one go."""
    if row.id is None:
        # Marks the collection loaded on a row that has never been queried. Without
        # it the first read after the create-flush is a lazy load, which on an async
        # session raises MissingGreenlet instead of emitting SQL. lazy="selectin"
        # covers rows that arrive via a query; a brand-new one never does.
        row.manufacturers = []
    await require_unique(db, Brand, "name", data.name, row, "A brand named")
    await require_unique(db, Brand, "code", data.code, row, "Brand code")
    wanted = list(dict.fromkeys(data.manufacturer_ids))    # de-dupe, keep order
    rows = (await db.execute(
        select(Manufacturer).where(Manufacturer.id.in_(wanted))
    )).scalars().all() if wanted else []
    if len(rows) != len(wanted):
        raise ValidationError("One of the selected manufacturers does not exist")

    for key, value in data.model_dump(exclude={"manufacturer_ids"}).items():
        setattr(row, key, value)

    by_id = {link.manufacturer_id: link for link in (row.manufacturers or [])}
    for manufacturer in rows:
        link = by_id.get(manufacturer.id)
        if link is None:
            # Newly linked. Snapshot the codes so a brand list renders without
            # joining mst_manufacturers.
            row.manufacturers.append(BrandManufacturer(
                brand_code=data.code, brand_name=data.name,
                manufacturer_id=manufacturer.id, manufacturer_code=manufacturer.code,
                manufacturer_name=manufacturer.name, is_active=True))
        else:
            link.is_active = True
            link.manufacturer_code, link.manufacturer_name = (
                manufacturer.code, manufacturer.name)
    # Unticked links are deactivated, never deleted: items already carry this
    # brand/manufacturer pair and the row is what proves the pair was once legal.
    for manufacturer_id, link in by_id.items():
        if manufacturer_id not in set(wanted):
            link.is_active = False
    for link in row.manufacturers:
        link.brand_code, link.brand_name = data.code, data.name


class BrandManufacturerIn(BaseModel):
    brand_id: int
    manufacturer_id: int
    is_active: bool = True


def brand_manufacturer_out(row: BrandManufacturer) -> dict:
    return {"id": row.id, "brand_id": row.brand_id,
            "brand_code": row.brand_code, "brand_name": row.brand_name,
            "manufacturer_id": row.manufacturer_id,
            "manufacturer_code": row.manufacturer_code,
            "manufacturer_name": row.manufacturer_name,
            "is_active": row.is_active}


async def apply_brand_manufacturer(
    db: AsyncSession, row: BrandManufacturer, data: BrandManufacturerIn,
) -> None:
    brand = await db.get(Brand, data.brand_id)
    manufacturer = await db.get(Manufacturer, data.manufacturer_id)
    if not brand or not manufacturer:
        raise ValidationError("Brand and manufacturer are required")
    row.brand_id, row.brand_code, row.brand_name = brand.id, brand.code, brand.name
    row.manufacturer_id = manufacturer.id
    row.manufacturer_code, row.manufacturer_name = manufacturer.code, manufacturer.name
    row.is_active = data.is_active


class ItemClassIn(BaseModel):
    code: str = Field(
        min_length=1, max_length=10,
        pattern=r"^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$")
    name: str
    description: str | None = None
    is_active: bool = True


def item_class_out(c: ItemClass) -> dict:
    # is_capitalised is deliberately absent. Whether an item is an asset is now a
    # per-item choice (mst_items.is_asset), because the same class holds both: a
    # laptop is capitalised, a mouse in the same IT Equipment class is not.
    return {"id": c.id, "code": c.code, "name": c.name,
            "description": c.description, "is_active": c.is_active}


async def apply_item_class(db: AsyncSession, row: ItemClass, data: ItemClassIn) -> None:
    await require_unique(db, ItemClass, "name", data.name, row, "An item class named")
    await require_unique(db, ItemClass, "code", data.code, row, "Item class code")
    for key, value in data.model_dump().items():
        setattr(row, key, value)


class ItemSubClassIn(BaseModel):
    item_class_id: int
    code: str = Field(
        min_length=1, max_length=10,
        pattern=r"^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$")
    name: str
    description: str | None = None
    is_active: bool = True


def item_sub_class_out(row: ItemSubClass) -> dict:
    return {"id": row.id, "item_class_id": row.item_class_id,
            "item_class_code": row.item_class_code,
            "item_class_name": row.item_class_name, "code": row.code,
            "name": row.name, "description": row.description,
            "is_active": row.is_active}


async def apply_item_sub_class(
    db: AsyncSession, row: ItemSubClass, data: ItemSubClassIn,
) -> None:
    item_class = await db.get(ItemClass, data.item_class_id)
    if not item_class:
        raise ValidationError("Item class not found")
    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.item_class_code, row.item_class_name = item_class.code, item_class.name


class PackagingIn(BaseModel):
    """A reusable container type — Packet, Box, Tanker.

    Dimensions, weight, volume and capacity do not belong here. How much a container
    holds is configured independently for each item and its own UOM.
    """
    code: str = Field(min_length=1, max_length=50, pattern=r"^[A-Za-z0-9-]+$")
    name: str
    is_active: bool = True


def _num(value):
    return float(value) if value is not None else None


def packaging_out(p: Packaging) -> dict:
    return {"id": p.id, "code": p.code, "name": p.name,
            "is_active": p.is_active}


async def apply_packaging(db: AsyncSession, row: Packaging, data: PackagingIn) -> None:
    await require_unique(db, Packaging, "name", data.name, row, "A package named")
    await require_unique(db, Packaging, "code", data.code, row, "Package code")
    for key, value in data.model_dump().items():
        setattr(row, key, value)


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
    """A selectable trait: colour, size, grade. Its unit is a real UOM row, not the
    free text it used to be, so "kg" and "Kg" cannot both exist."""
    code: str = Field(min_length=1, max_length=50, pattern=r"^[A-Za-z0-9_]+$")
    name: str
    data_type: str = AttributeDataType.TEXT.value
    uom_id: int | None = None
    allowed_values: list[str] | None = None
    description: str | None = None
    is_active: bool = True


def attribute_out(a: Attribute) -> dict:
    return {"id": a.id, "code": a.code, "name": a.name, "data_type": a.data_type,
            "uom_id": a.uom_id, "uom_code": a.uom_code,
            "allowed_values": a.allowed_values or [],
            "description": a.description, "is_active": a.is_active}


async def apply_attribute(db: AsyncSession, row: Attribute, data: AttributeIn) -> None:
    if data.data_type not in {t.value for t in AttributeDataType}:
        raise ValidationError(
            f"data_type must be one of {', '.join(t.value for t in AttributeDataType)}")
    # A LIST attribute with no options would render an empty dropdown nobody can use.
    if data.data_type == AttributeDataType.LIST.value and not data.allowed_values:
        raise ValidationError("A LIST attribute needs at least one allowed value")
    uom = await db.get(Uom, data.uom_id) if data.uom_id else None
    if data.uom_id is not None and uom is None:
        raise ValidationError("Unit of measure not found")
    await require_unique(db, Attribute, "name", data.name, row, "An attribute named")
    await require_unique(db, Attribute, "code", data.code, row, "Attribute code")
    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.uom_code = uom.code if uom else None
    # The old free-text column is kept in step so anything still reading it agrees
    # with the UOM that was actually chosen.
    row.unit = uom.code if uom else None


# --------------------------------------------------------------------------- #
#  Specs — a measurement, as opposed to an attribute's selectable trait
# --------------------------------------------------------------------------- #
class SpecIn(BaseModel):
    code: str = Field(min_length=1, max_length=50, pattern=r"^[A-Za-z0-9_]+$")
    name: str
    uom_id: int | None = None
    description: str | None = None
    is_active: bool = True


def spec_out(s: Spec) -> dict:
    return {"id": s.id, "code": s.code, "name": s.name, "uom_id": s.uom_id,
            "uom_code": s.uom_code, "description": s.description,
            "is_active": s.is_active}


async def apply_spec(db: AsyncSession, row: Spec, data: SpecIn) -> None:
    uom = await db.get(Uom, data.uom_id) if data.uom_id else None
    if data.uom_id is not None and uom is None:
        raise ValidationError("Unit of measure not found")
    await require_unique(db, Spec, "name", data.name, row, "A spec named")
    await require_unique(db, Spec, "code", data.code, row, "Spec code")
    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.uom_code = uom.code if uom else None


# --------------------------------------------------------------------------- #
#  Category tags — attributes, specs and features a category expects
# --------------------------------------------------------------------------- #
class CategoryTagIn(BaseModel):
    category_id: int
    tag_type: str
    tag_id: int
    is_required: bool = False
    is_active: bool = True


def category_tag_out(t: CategoryTag) -> dict:
    return {"id": t.id, "category_id": t.category_id,
            "category_name": t.category_name, "tag_type": t.tag_type,
            "tag_id": t.tag_id, "tag_code": t.tag_code, "tag_name": t.tag_name,
            "tag_uom_code": t.tag_uom_code, "is_required": t.is_required,
            "is_active": t.is_active}


async def apply_category_tag(db: AsyncSession, row: CategoryTag,
                             data: CategoryTagIn) -> None:
    """Snapshots the category and the tagged thing so the tagging list reads without
    joining four tables — the target table changes with tag_type, so a join would
    have to be written three times."""
    if data.tag_type not in {t.value for t in CategoryTagType}:
        raise ValidationError(
            f"tag_type must be one of {', '.join(t.value for t in CategoryTagType)}")
    category = await db.get(ItemCategory, data.category_id)
    if category is None:
        raise ValidationError("Category not found")

    model = {CategoryTagType.ATTRIBUTE.value: Attribute,
             CategoryTagType.SPEC.value: Spec,
             CategoryTagType.FEATURE.value: Feature}[data.tag_type]
    target = await db.get(model, data.tag_id)
    if target is None:
        raise ValidationError(f"{data.tag_type.title()} not found")

    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.category_name = category.name
    row.tag_code, row.tag_name = target.code, target.name
    # Only a spec carries a unit; the column stays null for the other two.
    row.tag_uom_code = getattr(target, "uom_code", None)


# --------------------------------------------------------------------------- #
#  Item groups — who may request an item
# --------------------------------------------------------------------------- #
class ItemGroupIn(BaseModel):
    item_id: int
    group_id: int
    is_active: bool = True


def item_group_out(g: ItemGroup) -> dict:
    return {"id": g.id, "item_id": g.item_id, "item_code": g.item_code,
            "item_name": g.item_name, "group_id": g.group_id,
            "group_name": g.group_name, "is_active": g.is_active}


async def apply_item_group(db: AsyncSession, row: ItemGroup,
                           data: ItemGroupIn) -> None:
    """rbac_user_groups is a platform table, so the import is function-local: the
    module graph must still run modules -> platform -> shared -> core (rule 5)."""
    from app.platform.rbac.models import UserGroup

    item = await db.get(Item, data.item_id)
    if item is None:
        raise ValidationError("Item not found")
    group = await db.get(UserGroup, data.group_id)
    if group is None:
        raise ValidationError("User group not found")

    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.item_code, row.item_name = item.code, item.name
    row.group_name = group.name


# --------------------------------------------------------------------------- #
#  Item packaging — the tray -> box -> container ladder
# --------------------------------------------------------------------------- #
class ItemPackagingIn(BaseModel):
    item_id: int
    level: int
    package_id: int
    quantity: float
    is_active: bool = True


def item_packaging_out(p: ItemPackaging) -> dict:
    return {"id": p.id, "item_id": p.item_id, "level": p.level,
            "package_id": p.package_id, "package_name": p.package_name,
            "quantity": _num(p.quantity), "uom_id": p.uom_id,
            "uom_code": p.uom_code, "is_active": p.is_active}


async def apply_item_packaging(db: AsyncSession, row: ItemPackaging,
                               data: ItemPackagingIn) -> None:
    """Level 1 is measured in the item's own unit; every level above counts the
    level below it. The rungs are stored, never the running totals — a stored total
    is one edit away from disagreeing with its own parts."""
    if data.level < 1:
        raise ValidationError("Packaging levels start at 1")
    if data.quantity <= 0:
        raise ValidationError("Quantity must be greater than zero")
    item = await db.get(Item, data.item_id)
    if item is None:
        raise ValidationError("Item not found")
    package = await db.get(Packaging, data.package_id)
    if package is None:
        raise ValidationError("Package not found")
    if data.level > 1 and not float(data.quantity).is_integer():
        raise ValidationError(
            "Levels above 1 must contain a whole number of the package below")

    # A ladder with a missing rung cannot be multiplied up, so a level may only be
    # added directly on top of one that already exists.
    if data.level > 1:
        below = await db.scalar(select(ItemPackaging.id).where(
            ItemPackaging.item_id == data.item_id,
            ItemPackaging.level == data.level - 1,
            ItemPackaging.is_active.is_(True)))
        if below is None:
            raise ValidationError(
                f"Add level {data.level - 1} before level {data.level}")

    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.package_name = package.name
    # Every result is ultimately expressed in the item's own stocking UOM.
    row.uom_id, row.uom_code = item.uom_id, item.uom_code


async def validate_item_packaging_deactivate(
    db: AsyncSession, row: ItemPackaging,
) -> None:
    higher = await db.scalar(select(ItemPackaging.id).where(
        ItemPackaging.item_id == row.item_id,
        ItemPackaging.level > row.level,
        ItemPackaging.is_active.is_(True),
    ))
    if higher is not None:
        raise ValidationError(
            "Remove the highest packaging level first")


async def packaging_breakdown(db: AsyncSession, item_id: int) -> list[dict]:
    """The ladder with its running totals: 1 tray = 10 L, 1 box = 10 trays = 100 L.

    Multiplied up on read rather than stored, so the totals cannot drift from the
    rungs they come from.
    """
    item = await db.get(Item, item_id)
    if item is None:
        raise NotFoundError("Item not found")
    rows = (await db.execute(
        select(ItemPackaging)
        .where(ItemPackaging.item_id == item_id, ItemPackaging.is_active.is_(True))
        .order_by(ItemPackaging.level)
    )).scalars().all()

    out, running = [], 1.0
    for index, row in enumerate(rows):
        if row.level != index + 1:
            raise ValidationError(
                f"Packaging level {index + 1} is missing; rebuild the ladder in order")
        running *= float(row.quantity or 0)
        package_breakup, package_count = [], 1.0
        for lower_index in range(index, -1, -1):
            lower = rows[lower_index]
            package_breakup.append({
                "package_id": lower.package_id,
                "package_name": lower.package_name,
                "quantity": _num(package_count),
            })
            if lower_index > 0:
                package_count *= float(lower.quantity or 0)
        out.append({
            "level": row.level, "package_id": row.package_id,
            "package_name": row.package_name, "quantity": _num(row.quantity),
            "uom_code": row.uom_code,
            "package_breakup": package_breakup,
            # What one of this package holds, expressed in the item's own unit.
            "base_quantity": running, "base_uom_code": item.uom_code,
        })
    return out


# --------------------------------------------------------------------------- #
#  Kit components
# --------------------------------------------------------------------------- #
class ItemComponentIn(BaseModel):
    item_id: int
    component_item_id: int
    line_no: int = 1
    quantity: float = 1
    uom_id: int | None = None
    remarks: str | None = None
    is_active: bool = True


def item_component_out(c: ItemComponent) -> dict:
    return {"id": c.id, "item_id": c.item_id, "line_no": c.line_no,
            "component_item_id": c.component_item_id,
            "component_code": c.component_code, "component_name": c.component_name,
            "quantity": _num(c.quantity), "uom_id": c.uom_id,
            "uom_code": c.uom_code, "remarks": c.remarks, "is_active": c.is_active}


async def apply_item_component(db: AsyncSession, row: ItemComponent,
                               data: ItemComponentIn) -> None:
    if data.quantity <= 0:
        raise ValidationError("Quantity must be greater than zero")
    # A kit inside itself would make any expansion of its contents recurse forever.
    if data.item_id == data.component_item_id:
        raise ValidationError("A kit cannot contain itself")
    kit = await db.get(Item, data.item_id)
    if kit is None:
        raise ValidationError("Item not found")
    if not kit.has_components:
        raise ValidationError(
            "Turn on Has Components / Kit and save the item before adding components")
    component = await db.get(Item, data.component_item_id)
    if component is None:
        raise ValidationError("Component item not found")
    uom = await db.get(Uom, data.uom_id) if data.uom_id else None
    if data.uom_id is not None and uom is None:
        raise ValidationError("Unit of measure not found")

    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.component_code, row.component_name = component.code, component.name
    # Defaults to the component's own stocking unit, which is right nearly always
    # and still overridable when it is not.
    row.uom_id = uom.id if uom else component.uom_id
    row.uom_code = uom.code if uom else component.uom_code


# --------------------------------------------------------------------------- #
#  HSN codes — the tax classification
# --------------------------------------------------------------------------- #
class HsnIn(BaseModel):
    code: str = Field(min_length=8, max_length=8, pattern=r"^\d{8}$")
    description: str | None = None
    cgst_rate: float = 0
    sgst_rate: float = 0
    igst_rate: float = 0
    cess_rate: float = 0
    effective_from: date | None = None
    is_active: bool = True


def hsn_out(h: HsnCode) -> dict:
    return {"id": h.id, "code": h.code, "description": h.description,
            "cgst_rate": _num(h.cgst_rate), "sgst_rate": _num(h.sgst_rate),
            "igst_rate": _num(h.igst_rate), "cess_rate": _num(h.cess_rate),
            "effective_from": h.effective_from.isoformat() if h.effective_from else None,
            "is_active": h.is_active}


async def apply_hsn(db: AsyncSession, row: HsnCode, data: HsnIn) -> None:
    for name in ("cgst_rate", "sgst_rate", "igst_rate", "cess_rate"):
        if not 0 <= getattr(data, name) <= 100:
            raise ValidationError(f"{name.replace('_', ' ')} must be between 0 and 100")
    # GST is split as CGST + SGST within a state and charged as IGST across states, so
    # the two routes must come to the same number. They disagreeing means one of them
    # is wrong, and the document would tax the same sale differently by destination.
    if data.igst_rate and round(data.cgst_rate + data.sgst_rate, 3) != round(data.igst_rate, 3):
        raise ValidationError("CGST + SGST must equal IGST")
    await require_unique(db, HsnCode, "code", data.code, row, "HSN code")
    for key, value in data.model_dump().items():
        setattr(row, key, value)


# --------------------------------------------------------------------------- #
#  Bills of material
# --------------------------------------------------------------------------- #
def check_validity_window(data) -> None:
    """A window that ends before it starts is never open, so it is refused rather
    than saved as a row nobody can use."""
    if data.effective_from and data.effective_to \
            and data.effective_to < data.effective_from:
        raise ValidationError("Active to cannot be before Active from")


def in_effect(row) -> bool:
    """Whether a row is usable today.

    Both ends are optional and mean the obvious thing: no start is "since always",
    no end is "until further notice", neither is "all the time". Kept separate from
    is_active rather than folded into it — a row outside its window is scheduled or
    expired, not retired, and the flag must keep saying what the admin actually set
    or the next save would switch it off for good.
    """
    if not row.is_active:
        return False
    today = date.today()
    if row.effective_from and today < row.effective_from:
        return False
    if row.effective_to and today > row.effective_to:
        return False
    return True


class BomIn(BaseModel):
    """A named, reusable set of items belonging to a project — the standard kit a
    requester picks instead of typing the same twelve lines every time.

    No parent item, output quantity or assembly type any more: this is a request
    template, not a manufacturing recipe. Those columns stay in the table but the
    API no longer reads or writes them.
    """
    code: str = Field(min_length=1, max_length=50, pattern=r"^[A-Za-z0-9-]+$")
    name: str
    project_id: int | None = None
    description: str | None = None
    # Optional on both ends: a kit with no window is available all the time.
    effective_from: date | None = None
    effective_to: date | None = None
    is_active: bool = True


def bom_out(b: Bom) -> dict:
    return {"id": b.id, "code": b.code, "name": b.name,
            "project_id": b.project_id, "project_name": b.project_name,
            # line_count is counted from mst_bom_items; the stored total_items
            # column was never maintained and always read 0.
            "description": b.description, "total_items": b.line_count,
            "effective_from": b.effective_from.isoformat() if b.effective_from else None,
            "effective_to": b.effective_to.isoformat() if b.effective_to else None,
            # What a consumer asks before offering the kit: the switch AND the window.
            "is_effective": in_effect(b),
            "is_active": b.is_active}


async def scope_boms(db: AsyncSession, user, stmt):
    """Only the kits tagged to the hat this session is wearing.

    Applied on ?mine=true, not always: the BOM master screen has to keep showing every
    kit or an admin could not maintain the ones they do not personally draw. The indent
    picker is the caller that asks to be narrowed.

    The ACTIVE position's profile, not every post the person holds — `profile_keys_for
    _user` is already written that way, and a kit handed to one job must not follow
    somebody into another. Switching hats switches the kits.

    A profile nobody has paired a BOM with sees NO BOMs, not all of them. The opposite
    of the item master's unmapped-general-name rule on purpose: an untagged general
    name would block every item create, whereas an untagged profile can still raise an
    indent by picking items directly, so strict here costs nothing.
    """
    from app.platform.rbac.profiles import profile_keys_for_user

    keys = await profile_keys_for_user(db, user)
    if not keys:
        return stmt.where(false())

    today = date.today()
    paired = (
        select(BomGroup.bom_id)
        .where(BomGroup.profile_key.in_(keys),
               BomGroup.is_active.is_(True),
               or_(BomGroup.effective_from.is_(None),
                   BomGroup.effective_from <= today),
               or_(BomGroup.effective_to.is_(None),
                   BomGroup.effective_to >= today))
    )
    return stmt.where(Bom.id.in_(paired))


async def apply_bom(db: AsyncSession, row: Bom, data: BomIn) -> None:
    check_validity_window(data)
    project = await db.get(Project, data.project_id) if data.project_id else None
    if data.project_id is not None and project is None:
        raise ValidationError("Project not found")
    await require_unique(db, Bom, "name", data.name, row, "A BOM named")
    await require_unique(db, Bom, "code", data.code, row, "BOM code")

    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.project_name = project.name if project else None


class BomItemIn(BaseModel):
    bom_id: int
    item_id: int
    line_no: int = 1
    quantity: float = 1
    uom_id: int | None = None
    remarks: str | None = None


def bom_item_out(r: BomItem) -> dict:
    return {"id": r.id, "bom_id": r.bom_id, "line_no": r.line_no,
            "item_id": r.item_id, "item_code": r.item_code, "item_name": r.item_name,
            "category_name": r.category_name, "uom_id": r.uom_id,
            "uom_code": r.uom_code, "quantity": _num(r.quantity),
            "remarks": r.remarks}


async def apply_bom_item(db: AsyncSession, row: BomItem, data: BomItemIn) -> None:
    bom = await db.get(Bom, data.bom_id)
    if bom is None:
        raise ValidationError("BOM not found")
    if data.quantity <= 0:
        raise ValidationError("Quantity must be greater than zero")
    item = await db.get(Item, data.item_id)
    if item is None:
        raise ValidationError("Item not found")
    uom = await db.get(Uom, data.uom_id) if data.uom_id else None
    if data.uom_id is not None and uom is None:
        raise ValidationError("Unit of measure not found")

    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.item_code, row.item_name = item.code, item.name
    row.category_name = item.category_name
    row.uom_id = uom.id if uom else item.uom_id
    row.uom_code = uom.code if uom else item.uom_code


# --------------------------------------------------------------------------- #
#  BOM groups — which job profile gets which kit
# --------------------------------------------------------------------------- #
class BomGroupIn(BaseModel):
    """One BOM handed to one job profile.

    `profile_key` is RBAC's derived key ("4:DEO"), not an id: a job profile has no
    table (platform/rbac/profiles.py). It is validated against the live derivation on
    every save, narrowed to what the CALLER may see, so a key from a retired HCM
    generation — or from a project this login has no business in — is refused rather
    than stored.
    """
    bom_id: int
    profile_key: str = Field(min_length=1, max_length=150)
    remarks: str | None = None
    # Optional on both ends: a pairing with no window stands all the time.
    effective_from: date | None = None
    effective_to: date | None = None
    is_active: bool = True


def bom_group_out(g: BomGroup) -> dict:
    return {"id": g.id, "bom_id": g.bom_id, "bom_code": g.bom_code,
            "bom_name": g.bom_name, "profile_key": g.profile_key,
            "profile_job": g.profile_job, "profile_name": g.profile_name,
            "project_id": g.project_id, "project_name": g.project_name,
            "remarks": g.remarks,
            "effective_from": g.effective_from.isoformat() if g.effective_from else None,
            "effective_to": g.effective_to.isoformat() if g.effective_to else None,
            "is_effective": in_effect(g),
            "is_active": g.is_active}


async def scope_bom_groups(db: AsyncSession, user, stmt):
    """Narrow the list to the projects this login's rung reaches.

    Always applied (`scope_always` on the MasterDef below), never only on ?mine=true:
    a district admin maintaining their own kits must not read — or, through
    crud._require_in_scope, edit — another region's pairings.
    """
    from app.shared.scope import project_condition

    return stmt.where(await project_condition(db, user, BomGroup.project_id))


async def apply_bom_group(db: AsyncSession, row: BomGroup, data: BomGroupIn,
                          user=None) -> None:
    """RBAC lives in platform, which is downstream of shared, so the import is
    function-local — the module-level graph still runs one way (rule 5), the same way
    apply_item_group reaches rbac_user_groups.

    The profile is looked up in the CALLER's own option list, not in the whole
    derivation, so the write side and the read side agree: a profile this login could
    not have been shown is not a profile they may hand a kit to.
    """
    from app.platform.rbac.profiles import profile_options

    bom = await db.get(Bom, data.bom_id)
    if bom is None:
        raise ValidationError("BOM not found")
    check_validity_window(data)
    profile = next((p for p in await profile_options(db, user)
                    if p["key"] == data.profile_key), None)
    if profile is None:
        raise ValidationError("Job profile not found")

    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.bom_code, row.bom_name = bom.code, bom.name
    row.profile_job, row.profile_name = profile["job"], profile["name"]
    row.project_id = profile["project_id"] or None
    row.project_name = profile["project_name"]


# --------------------------------------------------------------------------- #
#  The registry
# --------------------------------------------------------------------------- #
# Where a master shows up once it is in use. Strings, not models: most of these
# tables belong to app.modules, and shared may not import a module (rule 5). Only the
# references an admin would weigh before deactivating a row are listed — the point is
# a readable warning, not a full dependency graph.
ITEM_USAGE = (
    ("Indent lines", "ind_indent_items", "item_id"),
    ("Purchase order lines", "pro_po_items", "item_id"),
    ("Goods receipt lines", "inb_receipt_items", "item_id"),
    ("Issue lines", "out_issue_items", "item_id"),
    ("Stock balances", "stk_balance", "item_id"),
    ("Vendor rates", "mst_vendor_items", "item_id"),
    ("BOM lines", "mst_bom_items", "item_id"),
)
VENDOR_USAGE = (
    ("Purchase orders", "pro_purchase_orders", "vendor_id"),
    ("Goods receipts", "inb_receipts", "vendor_id"),
    ("Vendor rates", "mst_vendor_items", "vendor_id"),
)
WAREHOUSE_USAGE = (
    ("Stock balances", "stk_balance", "warehouse_id"),
    ("Indents", "ind_indents", "warehouse_id"),
    ("Goods receipts", "inb_receipts", "warehouse_id"),
    ("Issues", "out_issues", "warehouse_id"),
)
USED_BY_ITEMS = ("Items", "mst_items")

MASTERS: list[MasterDef] = [
    MasterDef(path="items", name="Item", model=Item, schema=ItemIn,
              manage_perm=perms.MASTER_ITEM_MANAGE, serialize=item_out,
              search_cols=("name", "code"), apply=apply_item,
              default_active_only=True,
              scope_to_user=restrict_items_to_my_groups,
              filters=("category_id", "item_class_id", "brand_id", "hsn_id"),
              usage=ITEM_USAGE),

    MasterDef(path="item-categories", name="Category", model=ItemCategory,
              schema=CategoryIn, manage_perm=perms.MASTER_CATEGORY_MANAGE,
              serialize=category_out, search_cols=("name", "code"),
              apply=apply_category,
              usage=((*USED_BY_ITEMS, "category_id"), ("Category tags", "mst_category_tags", "category_id"),)),

    # Carries its brands inline, so there is no General-name/Brand mapping screen.
    # The item form reads this list to narrow the brand dropdown.
    MasterDef(path="general-names", name="General name", model=GeneralName,
              schema=GeneralNameIn, manage_perm=perms.MASTER_ITEM_MANAGE,
              serialize=general_name_out, search_cols=("name", "code"),
              apply=apply_general_name,
              usage=((*USED_BY_ITEMS, "general_name_id"), ("Brand mappings", "mst_brand_general_names", "general_name_id"),)),

    MasterDef(path="manufacturers", name="Manufacturer", model=Manufacturer,
              schema=NamedCodeIn, manage_perm=perms.MASTER_BRAND_MANAGE,
              serialize=named_code_out, search_cols=("name", "code"),
              apply=named_code_apply(Manufacturer, "A manufacturer"),
              usage=((*USED_BY_ITEMS, "manufacturer_id"), ("Brand mappings", "mst_brand_manufacturers", "manufacturer_id"),)),

    MasterDef(path="dosage-forms", name="Dosage form", model=DosageForm,
              schema=NamedCodeIn, manage_perm=perms.MASTER_ITEM_MANAGE,
              serialize=named_code_out, search_cols=("name", "code"),
              apply=named_code_apply(DosageForm, "A dosage form"),
              usage=((*USED_BY_ITEMS, "dosage_form_id"),)),

    MasterDef(path="uom", name="UOM", model=Uom, schema=UomIn,
              manage_perm=perms.MASTER_UOM_MANAGE, serialize=uom_out,
              search_cols=("name", "code"), order_col="code", paginated=False,
              apply=apply_uom, filters=("uom_class",),
              usage=((*USED_BY_ITEMS, "uom_id"), ("Indent lines", "ind_indent_items", "uom_id"), ("Packages", "mst_packaging", "uom_id"),)),

    # mst_uom_conversions has no is_active column, so this master cannot be
    # deactivated; the DELETE route still registers and returns a clear 400.
    MasterDef(path="uom-conversions", name="UOM conversion", model=UomConversion,
              schema=UomConversionIn, manage_perm=perms.MASTER_UOM_MANAGE,
              serialize=uom_conversion_out, order_col="from_uom_id",
              apply=apply_uom_conversion, paginated=False),

    MasterDef(path="warehouses", name="Warehouse", model=Warehouse, schema=WarehouseIn,
              manage_perm=perms.MASTER_LOCATION_MANAGE, serialize=warehouse_out,
              search_cols=("name", "code"), apply=apply_warehouse,
              usage=WAREHOUSE_USAGE),

    MasterDef(path="bins", name="Bin", model=Bin, schema=BinIn,
              manage_perm=perms.MASTER_LOCATION_MANAGE, serialize=bin_out,
              # `path` is derived when a tree is read, not a column — ordering or
              # searching on it is an AttributeError, not an empty result.
              search_cols=("code", "name"), order_col="code",
              apply=apply_bin),

    # Read-only: HCM owns projects and platform/hcm/sync.py writes them. A local edit
    # would survive only until the next sync overwrote it without saying so.
    MasterDef(path="projects", name="Project", model=Project, schema=ProjectIn,
              manage_perm=perms.MASTER_PROJECT_MANAGE, serialize=project_out,
              search_cols=("name", "code"), apply=apply_project, read_only=True),

    MasterDef(path="vendors", name="Vendor", model=Vendor, schema=VendorIn,
              manage_perm=perms.MASTER_VENDOR_MANAGE, serialize=vendor_out,
              search_cols=("name", "code"), default_active_only=True,
              usage=VENDOR_USAGE),

    # No is_active column on the live table, so this master cannot be deactivated;
    # the DELETE route still registers and returns a clear 400.
    MasterDef(path="vendor-items", name="Vendor item", model=VendorItem,
              schema=VendorItemIn, manage_perm=perms.MASTER_VENDOR_MANAGE,
              serialize=vendor_item_out, search_cols=("item_code", "item_name"),
              order_col="item_name", apply=apply_vendor_item,
              filters=("vendor_id", "item_id")),

    # ---- simple lookups ----
    # A brand carries its manufacturers inline, so there is no separate mapping
    # screen. The list route below stays: the item form reads it to narrow the
    # manufacturer dropdown to the chosen brand.
    MasterDef(path="brands", name="Brand", model=Brand, schema=BrandIn,
              manage_perm=perms.MASTER_BRAND_MANAGE, serialize=brand_out,
              search_cols=("name", "code"), apply=apply_brand,
              usage=((*USED_BY_ITEMS, "brand_id"), ("Manufacturer mappings", "mst_brand_manufacturers", "brand_id"), ("General name mappings", "mst_brand_general_names", "brand_id"),)),

    MasterDef(path="brand-manufacturers", name="Brand manufacturer",
              model=BrandManufacturer, schema=BrandManufacturerIn,
              manage_perm=perms.MASTER_BRAND_MANAGE,
              serialize=brand_manufacturer_out, order_col="brand_name",
              apply=apply_brand_manufacturer,
              filters=("brand_id", "manufacturer_id")),

    MasterDef(path="item-classes", name="Item class", model=ItemClass,
              schema=ItemClassIn, manage_perm=perms.MASTER_CLASS_MANAGE,
              serialize=item_class_out, search_cols=("name", "code"),
              apply=apply_item_class,
              usage=((*USED_BY_ITEMS, "item_class_id"), ("Subclasses", "mst_item_sub_classes", "item_class_id"),)),

    MasterDef(path="item-sub-classes", name="Item subclass", model=ItemSubClass,
              schema=ItemSubClassIn, manage_perm=perms.MASTER_CLASS_MANAGE,
              serialize=item_sub_class_out, search_cols=("name", "code"),
              apply=apply_item_sub_class, filters=("item_class_id",),
              usage=((*USED_BY_ITEMS, "item_sub_class_id"),)),

    MasterDef(path="packaging", name="Packaging", model=Packaging,
              schema=PackagingIn, manage_perm=perms.MASTER_PACKAGING_MANAGE,
              serialize=packaging_out, search_cols=("name", "code"),
              apply=apply_packaging),

    MasterDef(path="features", name="Feature", model=Feature, schema=FeatureIn,
              manage_perm=perms.MASTER_FEATURE_MANAGE, serialize=feature_out,
              search_cols=("name", "code"),
              apply=named_code_apply(Feature, "A feature")),

    # ---- what an item can be described by ----
    MasterDef(path="attributes", name="Attribute", model=Attribute,
              schema=AttributeIn, manage_perm=perms.MASTER_ATTRIBUTE_MANAGE,
              serialize=attribute_out, search_cols=("name", "code"),
              apply=apply_attribute),

    MasterDef(path="specs", name="Spec", model=Spec, schema=SpecIn,
              manage_perm=perms.MASTER_SPEC_MANAGE, serialize=spec_out,
              search_cols=("name", "code"), apply=apply_spec),

    # One screen for all three tagging relationships: attribute, spec and feature
    # answer the same two questions of a category, so they share one table.
    MasterDef(path="category-tags", name="Category tag", model=CategoryTag,
              schema=CategoryTagIn, manage_perm=perms.MASTER_ATTRIBUTE_MANAGE,
              serialize=category_tag_out,
              search_cols=("tag_name", "category_name"), order_col="tag_name",
              apply=apply_category_tag,
              filters=("category_id", "tag_type", "tag_id")),

    # ---- who may request an item ----
    MasterDef(path="item-groups", name="Item group", model=ItemGroup,
              schema=ItemGroupIn, manage_perm=perms.MASTER_ITEM_MANAGE,
              serialize=item_group_out, search_cols=("item_name", "group_name"),
              order_col="item_name", apply=apply_item_group,
              filters=("item_id", "group_id")),

    # ---- an item's packing ladder and, for a kit, its contents ----
    MasterDef(path="item-packaging", name="Item packaging", model=ItemPackaging,
              schema=ItemPackagingIn, manage_perm=perms.MASTER_PACKAGING_MANAGE,
              serialize=item_packaging_out, order_col="level",
              apply=apply_item_packaging, filters=("item_id",),
              default_active_only=True,
              before_deactivate=validate_item_packaging_deactivate),

    MasterDef(path="item-components", name="Kit component", model=ItemComponent,
              schema=ItemComponentIn, manage_perm=perms.MASTER_ITEM_MANAGE,
              serialize=item_component_out,
              search_cols=("component_name", "component_code"), order_col="line_no",
              apply=apply_item_component, filters=("item_id",),
              default_active_only=True),

    # ---- tax classification ----
    MasterDef(path="hsn-codes", name="HSN code", model=HsnCode, schema=HsnIn,
              manage_perm=perms.MASTER_HSN_MANAGE, serialize=hsn_out,
              search_cols=("code", "description"), order_col="code",
              apply=apply_hsn,
              usage=((*USED_BY_ITEMS, "hsn_id"),)),

    # ---- bills of material ----
    # `scope_to_user` without `scope_always`: the master screen keeps listing every
    # kit so an admin can maintain them, and the indent picker asks to be narrowed to
    # the caller's own job by passing ?mine=true.
    MasterDef(path="boms", name="BOM", model=Bom, schema=BomIn,
              manage_perm=perms.MASTER_BOM_MANAGE, serialize=bom_out,
              search_cols=("name", "code"), apply=apply_bom,
              filters=("project_id",), scope_to_user=scope_boms,
              usage=(("BOM lines", "mst_bom_items", "bom_id"),
                     ("Job profiles", "mst_bom_groups", "bom_id"))),

    MasterDef(path="bom-items", name="BOM line", model=BomItem, schema=BomItemIn,
              manage_perm=perms.MASTER_BOM_MANAGE, serialize=bom_item_out,
              search_cols=("item_name", "item_code"), order_col="line_no",
              apply=apply_bom_item, filters=("bom_id", "item_id")),

    # Which job profile gets which BOM. Sits under BOM on the same permission: a kit
    # and who may draw it are one decision, made by one person. Scoped on every read
    # and every write — this master names an RBAC profile, so it must not let one
    # project's admin see or touch another project's assignment.
    MasterDef(path="bom-groups", name="BOM group", model=BomGroup,
              schema=BomGroupIn, manage_perm=perms.MASTER_BOM_MANAGE,
              serialize=bom_group_out, order_col="profile_name",
              search_cols=("profile_name", "bom_name", "bom_code"),
              apply=apply_bom_group, apply_needs_user=True,
              scope_to_user=scope_bom_groups, scope_always=True,
              filters=("bom_id", "profile_key", "project_id")),
]
