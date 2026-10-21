"""One MasterDef per mst_ master. This is the whole masters API surface.

Only `mst_` tables live here. Roles, positions, user groups and document numbering are
RBAC/settings concerns and are served by platform/admin, which imports the same
factory — platform may import shared, but not the other way round (rule 5).
"""
from datetime import date
from decimal import Decimal
import re

from pydantic import BaseModel, Field, field_validator, model_validator
from pydantic_core import PydanticCustomError
from sqlalchemy import false, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.shared.limits import MAX_BATCH_IDS
from app.platform.hcm.models import HcmDepartment, HcmEmployee, HcmFacility, HcmOffice
from app.platform.rbac import permissions as perms
from app.shared.enums import (
    ItemScope,
    AuditAction, CARRIER_VENDOR_TYPES, SHIPMENT_ADDRESS_WAREHOUSE_TYPES,
    AttributeDataType, CategoryTagType, UomClass,
    WarehouseType, PAYMENT_MILESTONE_META,
)
from app.shared.masters.crud import Lookup, MasterDef
from app.platform.rbac.models import Role
from app.shared.models.master import (
    ItemEligibility,
    Attribute, Bom, BomGroup, BomItem, Brand, BrandGeneralName, BrandManufacturer,
    BrandItemMapping, BrandModel, BrandVariant,
    CategoryTag, DosageForm, Feature, GeneralName, HsnCode, Item, ItemCategory,
    ItemClass, ItemComponent, ItemGroup, ItemPackaging, ItemSubClass, Manufacturer,
    Packaging, PaymentTerm, Project, Spec, Uom, UomConversion, Vendor, VendorItem,
    UomClassRow, VendorCategory, VendorCategoryMember,
)
from app.shared.models.warehouse import Bin, StorageType, Warehouse


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
        raise ValidationError(f"{label} is empty. Please fill it in.")
    stmt = select(model.id).where(func.lower(getattr(model, column)) == text.lower())
    if scope is not None:
        stmt = stmt.where(scope)
    if getattr(row, "id", None) is not None:
        stmt = stmt.where(model.id != row.id)
    if await db.scalar(stmt) is not None:
        raise ValidationError(
            f"{label} “{text}” is already used by another entry. Use a different one, "
            "or edit the existing entry instead.")


# --------------------------------------------------------------------------- #
#  Items
# --------------------------------------------------------------------------- #
def build_item_prefix(category_path: str) -> str:
    """The part of an item code the category decides: its six-digit path, L1L2L3.

    The general name, brand and manufacturer are NOT in the code (2026-10-01): the
    code is the category, a hyphen and a running number, 101010-001, 101010-002 — which
    is what the business reads on a shelf label (101010-001). Items created before keep the
    longer shape they were created with; a code is never rewritten.
    """
    if not re.fullmatch(r"\d{6}", category_path or ""):
        raise ValidationError(
            "Category: pick the exact category (Level 3), not a main group above it.")
    return category_path


def build_item_code(category_path: str, serial: int) -> str:
    """The full item code: the category path, then a three-digit series."""
    if not 1 <= serial <= 999:
        raise ValidationError(
            "This category already has 999 items, the most its numbering allows. "
            "Add the item under another Level 3 category.")
    return f"{build_item_prefix(category_path)}-{serial:03d}"


def _series_codes(prefix: str):
    """Codes in this category's series: the prefix, a hyphen and exactly 3 digits
    (101010-001). `_` is LIKE's one-character wildcard, so the older
    101010-GEN-0001 codes, and the brief 101010001 form, never count."""
    return Item.code.like(f"{prefix}-___")


async def next_item_serial(db: AsyncSession, prefix: str) -> int:
    """The next free serial for a prefix.

    Reads the existing serials FOR UPDATE, which makes InnoDB hold the range so a
    second transaction on the same prefix waits rather than picking the same number.
    Two brand-new prefixes racing is still possible, and the unique index on
    mst_items.code is what catches that — it surfaces as a readable duplicate
    message rather than two items sharing a code.
    """
    rows = (await db.execute(
        select(Item.serial_no).where(_series_codes(prefix)).with_for_update()
    )).scalars().all()
    return max([r for r in rows if r] or [0]) + 1


async def peek_item_serial(db: AsyncSession, prefix: str) -> int:
    """What `next_item_serial` would hand out, without taking the lock.

    For the item form's code preview only: the save re-reads under lock, so two
    people creating into the same prefix still serialize there. A preview taken
    a moment ago may be off by one by the time it is saved — the saved code is
    the authority, and the preview says so beside itself.
    """
    rows = (await db.execute(
        select(Item.serial_no).where(_series_codes(prefix))
    )).scalars().all()
    return max([r for r in rows if r] or [0]) + 1


async def sibling_item(db: AsyncSession, prefix: str, category_id: int,
                       general_name_id: int | None) -> Item | None:
    """An item already coded for this category + general name (2026-10-06).

    Brand variants of one product share ONE code — 070001-001 is the 300 Ltr
    Refrigerator whether Elanpro or Western makes it — so a new brand of an existing
    general name reuses that code and serial instead of taking the next one."""
    if not general_name_id:
        return None
    return (await db.execute(
        select(Item).where(_series_codes(prefix), Item.category_id == category_id,
                           Item.general_name_id == general_name_id)
        .order_by(Item.id).limit(1))).scalars().first()


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
    # Brand and manufacturer are optional on the item form — they are managed
    # centrally via the Brand Item Mapping screen (mst_brand_item_mappings). The
    # form still accepts them for backward compatibility with existing saves and
    # API clients, but it no longer requires them.
    brand_id: int | None = None
    manufacturer_id: int | None = None
    item_class_id: int
    item_sub_class_id: int | None = None
    # Operational owner used by downstream ticket routing. This is separate from
    # the project dimension that owns quantities in the stock ledger.
    owner_department_id: int | None = None
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
    # The fifth tracking toggle. ON means every unit of this item is given an asset
    # code (if it is an asset) or a consumable code (if it is not) when it is put away.
    # Not a column — the live schema is frozen, so the list of tracked item codes lives
    # in sys_settings; see platform/settings/codeformat.TRACKED_ITEMS_KEY.
    generate_unit_code: bool = True
    has_expiry: bool = False
    requires_qi: bool = False
    dosage_form_id: int | None = None
    valuation_method: str = "FIFO"
    requires_special_storage: bool = False
    storage_conditions: str | None = None
    requires_special_transport: bool = False
    transport_conditions: str | None = None
    # No dimensions and no unit volume here, deliberately. How much room the goods take
    # is a property of the PACK they move in, not of one loose unit — a bin holds boxes,
    # not a puddle of cubic metres. It is configured on the item's Packaging tab
    # (mst_item_packaging) and read by modules/warehouse/capacity.py.
    is_active: bool = True


async def prepare_items(db: AsyncSession, rows: list[Item]) -> None:
    """The latest photo of every item on the page, in one query, for the list's
    thumbnail column. Photos live in sys_attachments under entity_type ITEM."""
    from app.platform.settings.models import Attachment
    ids = [row.id for row in rows if row.id is not None]
    latest = dict((await db.execute(
        select(Attachment.entity_id, func.max(Attachment.id))
        .where(Attachment.entity_type == "ITEM", Attachment.entity_id.in_(ids))
        .group_by(Attachment.entity_id))).all()) if ids else {}
    for row in rows:
        row._photo_id = latest.get(row.id)


def item_out(i: Item) -> dict:
    return {"id": i.id, "code": i.code, "serial_no": i.serial_no, "name": i.name,
            "photo_id": getattr(i, "_photo_id", None),
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
            "owner_department_id": i.owner_department_id,
            "owner_department_name": i.owner_department_name,
            "hsn_id": i.hsn_id, "hsn_code": i.hsn_code, "is_asset": i.is_asset,
            # A PREFILL for a document line, never the authority on the rate. Tax is a
            # property of the HSN classification and a PO or GRN reads it from there
            # at the moment it is raised (`_hsn_rates`), which is the rule this does
            # not touch: it only saves a buyer retyping the usual figure into a line
            # they can still edit. Served as NULL rather than 0 when the item says
            # nothing, because 0% is a real rate that exempt goods genuinely carry and
            # stamping it on an unclassified item would be a claim nobody made.
            "tax_percent": float(i.tax_percent) if i.tax_percent is not None else None,
            "description": i.description,
            "has_components": i.has_components, "barcode_type": i.barcode_type,
            "barcode_value": i.barcode_value,
            "is_batch_tracked": i.is_batch_tracked,
            "is_serial_tracked": i.is_serial_tracked,
            "is_imei_tracked": i.is_imei_tracked, "has_expiry": i.has_expiry,
            "tax_percent": float(i.tax_percent) if i.tax_percent is not None else 0,
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
    # Brand and manufacturer are optional — managed via Brand Item Mapping.
    brand = await db.get(Brand, data.brand_id) if data.brand_id else None
    manufacturer = await db.get(Manufacturer, data.manufacturer_id) \
        if data.manufacturer_id else None
    item_class = await db.get(ItemClass, data.item_class_id)
    hsn = await db.get(HsnCode, data.hsn_id)
    sub_class = await db.get(ItemSubClass, data.item_sub_class_id) \
        if data.item_sub_class_id else None
    dosage = await db.get(DosageForm, data.dosage_form_id) \
        if data.dosage_form_id else None
    owner_department = await db.get(HcmDepartment, data.owner_department_id) \
        if data.owner_department_id else None
    missing = []
    if category is None:
        missing.append("category")
    if general is None:
        missing.append("general name")
    if data.brand_id and brand is None:
        missing.append("brand")
    if data.manufacturer_id and manufacturer is None:
        missing.append("manufacturer")
    if item_class is None:
        missing.append("item class")
    if uom is None:
        missing.append("UOM")
    if missing:
        raise ValidationError(
            f"These are empty or do not exist: {', '.join(missing)}. "
            "Pick each one from its list.")
    if hsn is None:
        raise ValidationError("HSN code is empty. Pick the HSN code for this item.")
    if data.owner_department_id and (
        owner_department is None or not owner_department.is_active
    ):
        raise ValidationError(
            "Ownership department: that department is closed or does not exist. "
            "Pick an active department from the list.")
    if category.level != 3:
        raise ValidationError(
            f"Category: “{category.name}” is a main group (Level {category.level}). "
            "Pick the exact category under it (Level 3).")
    # The brand-manufacturer pairing is only checked when BOTH are named — an
    # item without either carries no pairing to verify.
    if brand is not None and manufacturer is not None:
        mapping = await db.scalar(select(BrandManufacturer.id).where(
            BrandManufacturer.brand_id == brand.id,
            BrandManufacturer.manufacturer_id == manufacturer.id,
            BrandManufacturer.is_active.is_(True),
        ))
        if mapping is None:
            raise ValidationError(
                f"Manufacturer: “{manufacturer.name}” is not linked to the brand "
                f"“{brand.name}”. Pick the right manufacturer, or link them under "
                "Masters › Brands.")
    if sub_class and sub_class.item_class_id != item_class.id:
        raise ValidationError(
            f"Item sub class: “{sub_class.name}” belongs to a different item class, "
            f"not “{item_class.name}”. Pick a sub class of “{item_class.name}”.")

    payload = data.model_dump()
    # Not a column on mst_items — it is stored per item code in sys_settings, applied
    # after the code is known (a new item has none until the block below runs).
    generate_unit_code = payload.pop("generate_unit_code", True)
    for key, value in payload.items():
        setattr(item, key, value)
    # The code is assigned once and never regenerated. Re-deriving it on every edit
    # would renumber an item that already has stock, ledger rows and documents
    # pointing at the code it was created with. Items created before the brand and
    # manufacturer left the code keep their longer shape for the same reason.
    if item.code is None:
        prefix = build_item_prefix(category.path)
        await next_item_serial(db, prefix)            # takes the series lock first
        sibling = await sibling_item(db, prefix, category.id, general.id)
        if sibling is not None:
            # The same code + the same brand + the same manufacturer is the same
            # item. NULL-safe on both sides: an item with no brand clashes only
            # with another unbranded item of that code, never with a branded
            # variant sharing the code (brand variants intentionally share one).
            clash_stmt = select(Item.id).where(Item.code == sibling.code)
            if brand is not None:
                clash_stmt = clash_stmt.where(Item.brand_id == brand.id)
            else:
                clash_stmt = clash_stmt.where(Item.brand_id.is_(None))
            if manufacturer is not None:
                clash_stmt = clash_stmt.where(
                    Item.manufacturer_id == manufacturer.id)
            else:
                clash_stmt = clash_stmt.where(Item.manufacturer_id.is_(None))
            if await db.scalar(clash_stmt) is not None:
                if brand is not None and manufacturer is not None:
                    who = f" by {brand.name} / {manufacturer.name}"
                elif brand is not None:
                    who = f" by {brand.name}"
                else:
                    who = ""
                raise ValidationError(
                    f"“{general.name}”{who} already "
                    f"exists as {sibling.code}. Edit that item instead.")
            item.serial_no, item.code = sibling.serial_no, sibling.code
        else:
            item.serial_no = await next_item_serial(db, prefix)
            item.code = build_item_code(category.path, item.serial_no)
    item.uom_code = uom.code
    item.hsn_code = hsn.code
    item.category_name = category.name
    item.general_name_code, item.general_name = general.code, general.name
    if brand is not None:
        item.brand_code, item.brand_name = brand.code, brand.name
    else:
        item.brand_code, item.brand_name = None, None
    if manufacturer is not None:
        item.manufacturer_code, item.manufacturer_name = (manufacturer.code,
                                                          manufacturer.name)
    else:
        item.manufacturer_code, item.manufacturer_name = None, None
    item.item_class_code, item.item_class_name = item_class.code, item_class.name
    item.item_sub_class_code = sub_class.code if sub_class else None
    item.item_sub_class_name = sub_class.name if sub_class else None
    item.owner_department_name = owner_department.name if owner_department else None
    item.dosage_form_code = dosage.code if dosage else None
    item.dosage_form_name = dosage.name if dosage else None
    item.item_type = item_class.code
    # Whether the dock mints an asset / consumable code for this item's units. Which
    # of the two it mints is `is_asset`, decided above; this only says "code it".
    from app.platform.settings import codeformat
    await codeformat.set_item_tracked(db, item.code, generate_unit_code)


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
        raise ValidationError(
            "Parent: a category cannot be placed under itself. Pick a different parent.")
    parent = await db.get(ItemCategory, data.parent_id) if data.parent_id else None
    if data.parent_id is not None and parent is None:
        raise ValidationError(
            "Parent: that category does not exist. Pick one from the list.")
    level = (parent.level or 1) + 1 if parent else 1
    if level > 3:
        raise ValidationError(
            f"Parent: “{parent.name}” is already at Level 3, the lowest level. "
            "Pick a Level 1 or Level 2 category as the parent.")
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
        raise ValidationError(
            f"Category number “{segment}” must be two digits, 00 to 99, e.g. 07.")
    for key, value in data.model_dump(exclude={"segment_code"}).items():
        setattr(cat, key, value)
    cat.level = level
    cat.segment_code = segment
    cat.path = f"{parent.path if parent else ''}{segment}"


# --------------------------------------------------------------------------- #
#  UOM and conversions
# --------------------------------------------------------------------------- #
class UomClassIn(BaseModel):
    """A kind of unit (Count, Weight, Volume ...): the UOM form's "What it measures"."""
    code: str = Field(min_length=1, max_length=30, pattern=r"^[A-Za-z0-9_]+$")
    name: str = Field(min_length=1, max_length=100)
    description: str | None = Field(None, max_length=300)
    # Off → every unit of this type is whole-only on every document (shared.uom).
    allows_decimal: bool = True
    is_active: bool = True

    @field_validator("code", mode="before")
    @classmethod
    def _upper(cls, value):
        return str(value).strip().upper() if value is not None else value


def uom_class_out(row: UomClassRow) -> dict:
    return {**named_code_out(row), "allows_decimal": bool(row.allows_decimal)}


class UomIn(BaseModel):
    code: str = Field(min_length=1, max_length=20)
    name: str
    uom_class: str
    is_active: bool = True


def uom_out(u: Uom) -> dict:
    return {"id": u.id, "code": u.code, "name": u.name,
            "uom_class": u.uom_class, "is_active": u.is_active}


async def apply_uom(db: AsyncSession, row: Uom, data: UomIn) -> None:
    # Any case is accepted (“Count”, “count”), and the allowed list is the UOM types
    # master (mst_uom_classes), so a site can add a kind of unit without a release.
    data.uom_class = (data.uom_class or "").strip().upper()
    allowed = {code: name for code, name in (await db.execute(
        select(UomClassRow.code, UomClassRow.name)
        .where(UomClassRow.is_active.is_(True)))).all()}
    if not allowed:                       # master not seeded yet: the old fixed list
        allowed = {c.value: c.value.title() for c in UomClass}
    if data.uom_class not in allowed:
        raise ValidationError(
            f"Unit type: “{data.uom_class}” is not one of the choices. Pick one of: "
            f"{', '.join(allowed.values())} — or add it under Masters › UOM Types.")
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
        raise ValidationError(
            "From unit and To unit are the same. Pick two different units.")
    if data.factor <= 0:
        raise ValidationError(
            f"Conversion factor must be more than 0. You typed {data.factor}.")
    from_uom = await db.get(Uom, data.from_uom_id)
    to_uom = await db.get(Uom, data.to_uom_id)
    if from_uom is None or to_uom is None:
        raise ValidationError(
            "From unit or To unit does not exist. Pick both from the list.")
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
    # Blank = follow the company default (warehouse.requires_inward_default). True
    # means arrivals here go through Material Inward -> GRN -> QC before they count.
    requires_inward: bool | None = None
    is_active: bool = True


def warehouse_kind_filter(request, stmt):
    """`?kind=SHIPMENT_ADDRESS` on the warehouse list.

    One master holds the two real warehouses and the 981 LIP/MDP field points that
    stock is distributed OUT to — that is on purpose, they are all stocking points —
    but a purchase is only ever shipped to the former. The requisition, RFQ and
    consolidation pickers were offering all 983, so a buyer searched nine hundred
    addresses no vendor has ever delivered to and the two that matter sorted last.

    Left off, the list is unchanged: the masters screen still manages every row, and
    so does every other reader. Narrowing is the caller's choice, exactly as it is for
    `vendor_kind_filter` above — and the same reason applies for why refusing a bad
    id at SAVE time lives in procurement rather than here: this only decides what is
    offered, never what is accepted.
    """
    kind = (request.query_params.get("kind") or "").strip().upper()
    if kind != "SHIPMENT_ADDRESS":
        return stmt
    return stmt.where(func.upper(func.coalesce(Warehouse.warehouse_type, "MAIN")).in_(
        SHIPMENT_ADDRESS_WAREHOUSE_TYPES))


def warehouse_out(w: Warehouse) -> dict:
    return {"id": w.id, "code": w.code, "name": w.name, "facility_id": w.facility_id,
            "facility_name": w.facility_name, "office_id": w.office_id,
            "office_name": w.office_name, "warehouse_type": w.warehouse_type,
            "address": w.address, "incharge_id": w.incharge_id,
            "incharge_name": w.incharge_name, "is_bin_managed": w.is_bin_managed,
            "requires_inward": w.requires_inward, "is_active": w.is_active}


async def apply_warehouse(db: AsyncSession, w: Warehouse, data: WarehouseIn) -> None:
    """Snapshot facility, office and incharge names so the warehouse list renders from
    one query instead of joining three HCM mirrors."""
    # Any case is accepted (“Count”, “count”): the message lists the choices
    # in readable case, so the check must not then refuse them for it.
    data.warehouse_type = (data.warehouse_type or "").strip().upper()
    if data.warehouse_type not in {t.value for t in WarehouseType}:
        raise ValidationError(
            f"Warehouse type: “{data.warehouse_type}” is not one of the choices. "
            f"Pick one of: {', '.join(t.value for t in WarehouseType)}.")
    facility = await db.get(HcmFacility, data.facility_id) if data.facility_id else None
    if data.facility_id is not None and facility is None:
        raise ValidationError("Facility: that facility does not exist. Pick one from the list.")
    incharge = await db.get(HcmEmployee, data.incharge_id) if data.incharge_id else None
    if data.incharge_id is not None and incharge is None:
        raise ValidationError("In-charge: that employee does not exist. Pick one from the list.")

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
            "path": getattr(b, "_derived_path", b.code),
            "level": getattr(b, "_derived_level", 1),
            "capacity_qty": float(b.capacity_qty) if b.capacity_qty is not None else None,
            "is_pickable": b.is_pickable, "is_active": b.is_active}


async def prepare_bins(db: AsyncSession, rows: list[Bin]) -> None:
    """Derive ancestry for a page or a freshly-written row in one database query.

    A page may contain a child without its parent, so load the complete location tree
    for the warehouses represented by that page. The identity map reuses page rows;
    annotating every node also makes create/update and list responses identical.
    """
    warehouse_ids = {row.warehouse_id for row in rows}
    locations = (await db.execute(
        select(Bin).where(Bin.warehouse_id.in_(warehouse_ids))
    )).scalars().all()
    by_id = {row.id: row for row in locations}
    memo: dict[int, tuple[str, int]] = {}

    def ancestry(row: Bin, visiting: set[int] | None = None) -> tuple[str, int]:
        if row.id in memo:
            return memo[row.id]
        visiting = set() if visiting is None else visiting
        if row.id in visiting:
            # Legacy bad data must still be visible and editable; expose the looped
            # row as a root instead of recursing forever.
            return row.code, 1
        visiting.add(row.id)
        parent = by_id.get(row.parent_id) if row.parent_id else None
        if parent is None:
            result = (row.code, 1)
        else:
            parent_path, parent_level = ancestry(parent, visiting)
            result = (f"{parent_path}/{row.code}", parent_level + 1)
        visiting.remove(row.id)
        memo[row.id] = result
        return result

    for location in locations:
        location._derived_path, location._derived_level = ancestry(location)


async def _resolve_storage_type(db: AsyncSession, code: str) -> int | None:
    """Is this a kind of location this company actually has, and which row is it?

    Asked of the storage-type master (`whs_warehouse_storage_types`), not of an enum:
    the kinds are rows now, so a site can add "carton bay" and file locations under it
    the same afternoon. See `modules/warehouse/storage_types.py` for the whole story —
    shared may not import that module (rule 5), so this asks the table directly.

    A master with no rows in it accepts anything, which is the same answer this gave
    before the table carried the kinds: a database created but never seeded must not
    have its location master bricked by a missing type master.
    """
    rows = (await db.execute(
        select(StorageType.id, StorageType.code, StorageType.is_active))).all()
    if not rows:
        return None
    wanted = (code or "").strip().upper()
    for row_id, row_code, _active in rows:
        if (row_code or "").upper() == wanted:
            return int(row_id)
    live = sorted((c or "") for _i, c, active in rows if active)
    raise ValidationError(
        f"Location type: “{code}” is not one of the choices. Pick one of: "
        f"{', '.join(live)} — or add it under Warehouse › Masters › Storage types.")


async def apply_bin(db: AsyncSession, b: Bin, data: BinIn) -> None:
    """Depth and ancestry are derived when a tree is read, never stored, so the tree
    cannot be saved into a depth that disagrees with its own ancestry."""
    storage_type_id = await _resolve_storage_type(db, data.bin_type)
    if await db.get(Warehouse, data.warehouse_id) is None:
        raise ValidationError("Warehouse: that warehouse does not exist. Pick one from the list.")
    if data.parent_id is not None and data.parent_id == b.id:
        raise ValidationError("Parent: a location cannot be placed inside itself.")

    parent = await db.get(Bin, data.parent_id) if data.parent_id else None
    if data.parent_id is not None and parent is None:
        raise ValidationError("Parent: that location does not exist. Pick one from the list.")
    if parent is not None and parent.warehouse_id != data.warehouse_id:
        raise ValidationError(
            f"Parent: “{parent.code}” is in a different warehouse. Pick a parent "
            "location in the same warehouse.")
    await _reject_bin_cycle(db, b, parent)

    for key, value in data.model_dump().items():
        setattr(b, key, value)
    # The kind is a ROW; the code on the location is that row's code. Set together here
    # for the same reason `service._resolved_kind` sets them together — a location
    # carrying a code with no id behind it is one the location form cannot label.
    if storage_type_id is not None:
        b.storage_type_id = storage_type_id


async def _reject_bin_cycle(db: AsyncSession, b: Bin, parent) -> None:
    """Walk up from the proposed parent. Reaching this row means the edit would make
    the tree a loop, which would hang any recursive read of it."""
    if b.id is None or parent is None:
        return
    seen, node = set(), parent
    while node is not None:
        if node.id == b.id:
            raise ValidationError(
                "Parent: that location is already inside this one, so it cannot also "
                "be its parent. Pick a different parent.")
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
        raise ValidationError(
            f"End date {data.end_date:%d-%m-%Y} is before start date "
            f"{data.start_date:%d-%m-%Y}. Check both dates.")
    office = await db.get(HcmOffice, data.office_id) if data.office_id else None
    for key, value in data.model_dump().items():
        setattr(p, key, value)
    p.office_name = office.name if office else None


# --------------------------------------------------------------------------- #
#  Vendors
# --------------------------------------------------------------------------- #
VENDOR_CODE = re.compile(r"\d{6,8}")


class VendorIn(BaseModel):
    code: str
    # The vendor categories it belongs to. None = leave its categories alone, so a
    # sheet or a caller that does not mention them never wipes them.
    category_ids: list[int] | None = Field(None, max_length=100)
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


def vendor_kind_filter(request, stmt):
    """`?kind=MATERIAL` / `?kind=CARRIER` on the vendor list.

    One master holds both a bandage supplier and a courier — that is on purpose, a
    carrier IS a vendor — but a picker only ever means one of them. Procurement's RFQ,
    PO and supplier-account screens were offering the logistics partners alongside the
    material suppliers, so an RFQ could be sent to a truck operator for gauze. Left off,
    the list is unchanged: the masters screen still manages every row.
    """
    kind = (request.query_params.get("kind") or "").strip().upper()
    if kind:
        carriers = func.upper(func.coalesce(Vendor.vendor_type, "MATERIAL")).in_(
            CARRIER_VENDOR_TYPES)
        stmt = stmt.where(carriers if kind == "CARRIER" else ~carriers)

    # `?item_ids=12,44` — only the vendors actually mapped to supply those items.
    #
    # The UNION, not the intersection: a tender for gauze and syringes goes to whoever
    # can supply either, and asking for one vendor who covers both empties the list as
    # soon as two items have different suppliers. Which items a given vendor covers is
    # answered per row by `/api/vendor-items`, so the screen can say so.
    #
    # An item with NO mapping yields NO vendors, deliberately (2026-09-07). Falling
    # back to every vendor is the friendlier failure and the wrong one: it silently
    # restores exactly the free-for-all this rule exists to end, and nothing ever tells
    # anybody the mapping is missing. An empty list is a defect you can see and fix in
    # the item master, which is where the answer belongs.
    raw = (request.query_params.get("item_ids") or "").strip()
    if raw:
        try:
            item_ids = [int(piece) for piece in raw.split(",") if piece.strip()]
        except ValueError:
            raise ValidationError("item_ids must be a comma-separated list of numbers")
        if not item_ids:
            return stmt
        if len(item_ids) > MAX_BATCH_IDS:
            raise ValidationError(
                f"Too many items at once: {len(item_ids)}, the most is {MAX_BATCH_IDS}.")
        stmt = stmt.where(Vendor.id.in_(
            select(VendorItem.vendor_id).where(VendorItem.item_id.in_(item_ids))))
    return stmt


def vendor_out(v: Vendor) -> dict:
    return {"category_ids": getattr(v, "_category_ids", []), "id": v.id, "code": v.code, "name": v.name,
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
            # _num, not the raw Decimal: this dict is written into the audit row's
            # JSON column, and json.dumps has no encoder for Decimal — importing
            # vendor items died on the first row that carried a rate or an MOQ.
            "last_rate": _num(row.last_rate), "lead_time_days": row.lead_time_days,
            "min_order_qty": _num(row.min_order_qty),
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
        raise ValidationError("Vendor: that vendor does not exist. Pick one from the list.")
    item = await db.get(Item, data.item_id)
    if item is None:
        raise ValidationError("Item: that item does not exist. Pick one from the list.")

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


async def apply_vendor(db: AsyncSession, row: Vendor, data: VendorIn) -> None:
    """A vendor code is 6 to 8 digits (2026-10-01). Checked here rather than on the
    schema so the vendors created before the rule (V-GODREJ, LGV-EKART) can still be
    edited without being renumbered — only a NEW code, or a changed one, must fit."""
    code = (data.code or "").strip()
    if (row.id is None or code != row.code) and not VENDOR_CODE.fullmatch(code):
        raise ValidationError(
            f"Vendor code “{code}” must be a number of 6 to 8 digits, e.g. 100245.")
    await require_unique(db, Vendor, "code", code, row, "Vendor code")
    for key, value in data.model_dump(exclude={"category_ids"}).items():
        setattr(row, key, value)
    row.code = code
    if data.category_ids is not None:
        if row.id is None:
            db.add(row)
            await db.flush()
        await _set_memberships(db, vendor_ids=[row.id], category_ids=data.category_ids,
                               side="vendor")


async def _set_memberships(db: AsyncSession, *, vendor_ids: list[int],
                           category_ids: list[int], side: str) -> None:
    """Make one side's links exactly what was chosen. `side` says which list is the
    one being edited: a vendor's categories, or a category's vendors."""
    wanted_cats = list(dict.fromkeys(category_ids))
    wanted_vendors = list(dict.fromkeys(vendor_ids))
    if wanted_cats and len((await db.execute(select(VendorCategory.id).where(
            VendorCategory.id.in_(wanted_cats)))).all()) != len(wanted_cats):
        raise ValidationError(
            "Vendor categories: one of them no longer exists. Pick them again from the list.")
    if wanted_vendors and len((await db.execute(select(Vendor.id).where(
            Vendor.id.in_(wanted_vendors)))).all()) != len(wanted_vendors):
        raise ValidationError(
            "Vendors: one of them no longer exists. Pick them again from the list.")
    owner = VendorCategoryMember.vendor_id if side == "vendor" else VendorCategoryMember.category_id
    owner_id = wanted_vendors[0] if side == "vendor" else wanted_cats[0]
    current = (await db.execute(select(VendorCategoryMember).where(
        owner == owner_id))).scalars().all()
    keep = set(wanted_cats if side == "vendor" else wanted_vendors)
    have = set()
    for link in current:
        other = link.category_id if side == "vendor" else link.vendor_id
        if other in keep:
            have.add(other)
        else:
            await db.delete(link)
    for other in keep - have:
        db.add(VendorCategoryMember(
            vendor_id=owner_id if side == "vendor" else other,
            category_id=other if side == "vendor" else owner_id))
    await db.flush()


async def prepare_vendors(db: AsyncSession, rows: list) -> None:
    """Each vendor's category ids, one query per page."""
    ids = [r.id for r in rows if r.id is not None]
    links = (await db.execute(select(
        VendorCategoryMember.vendor_id, VendorCategoryMember.category_id).where(
        VendorCategoryMember.vendor_id.in_(ids)))).all() if ids else []
    by_vendor: dict[int, list[int]] = {}
    for v, c in links:
        by_vendor.setdefault(v, []).append(c)
    for row in rows:
        row._category_ids = by_vendor.get(row.id, [])


class VendorCategoryIn(BaseModel):
    code: str = Field(min_length=1, max_length=10)
    name: str = Field(min_length=1, max_length=150)
    description: str | None = Field(None, max_length=300)
    # The vendors tagged to this category. None = leave them as they are.
    vendor_ids: list[int] | None = Field(None, max_length=500)
    is_active: bool = True


def vendor_category_out(row) -> dict:
    return {"id": row.id, "code": row.code, "name": row.name,
            "description": row.description, "is_active": row.is_active,
            "vendor_ids": getattr(row, "_vendor_ids", [])}


def parse_schedule(value: str | None) -> list[int]:
    """"30, 60/90" -> [30, 60, 90]: the days after delivery each instalment is due."""
    parts = [p for p in re.split(r"[\s,/;]+", (value or "").strip()) if p]
    if not parts:
        return []
    if len(parts) > 12 or not all(p.isdigit() and int(p) <= 3650 for p in parts):
        raise PydanticCustomError(
            "payment_schedule",
            "Delivery instalments: list the days after delivery, e.g. 30,60,90 "
            "(at most 12, each 0–3650).")
    return sorted(int(p) for p in parts)


class PaymentTermIn(BaseModel):
    """A payment term: the four milestones' share of the order value, and how many days
    after its trigger each one is payable. The shares must add up to 100."""
    code: str = Field(min_length=1, max_length=20)
    name: str = Field(min_length=1, max_length=150)
    description: str | None = Field(None, max_length=300)
    advance_pct: Decimal = Field(default=Decimal(0), ge=0, le=100)
    advance_days: int = Field(default=0, ge=0, le=3650)
    delivery_pct: Decimal = Field(default=Decimal(0), ge=0, le=100)
    delivery_days: int = Field(default=0, ge=0, le=3650)
    # Equal instalments of the delivery share, e.g. "30,60,90" days after delivery.
    delivery_schedule: str | None = Field(None, max_length=60)
    installation_pct: Decimal = Field(default=Decimal(0), ge=0, le=100)
    installation_days: int = Field(default=0, ge=0, le=3650)
    warranty_pct: Decimal = Field(default=Decimal(0), ge=0, le=100)
    warranty_days: int = Field(default=0, ge=0, le=3650)
    is_active: bool = True

    @field_validator("delivery_schedule")
    @classmethod
    def _schedule(cls, value: str | None) -> str | None:
        days = parse_schedule(value)
        return ",".join(str(d) for d in days) or None

    @model_validator(mode="after")
    def _adds_to_hundred(self):
        total = (self.advance_pct + self.delivery_pct + self.installation_pct
                 + self.warranty_pct)
        if total != 100:
            raise PydanticCustomError(
                "payment_split",
                "Advance + delivery + installation + warranty must add up to 100% "
                "(they add up to {total}%).", {"total": f"{total:g}"})
        return self


def payment_term_out(row) -> dict:
    out = {"id": row.id, "code": row.code, "name": row.name,
           "description": row.description, "is_active": row.is_active}
    for stage in PAYMENT_MILESTONE_META:
        f = stage["field"]
        out[f"{f}_pct"] = float(getattr(row, f"{f}_pct") or 0)
        out[f"{f}_days"] = getattr(row, f"{f}_days") or 0
    out["delivery_schedule"] = row.delivery_schedule
    return out


async def apply_payment_term(db: AsyncSession, row, data: PaymentTermIn) -> None:
    await require_unique(db, PaymentTerm, "name", data.name, row, "A payment term named")
    await require_unique(db, PaymentTerm, "code", data.code, row, "Payment term code")
    for key, value in data.model_dump().items():
        setattr(row, key, value)


async def prepare_vendor_categories(db: AsyncSession, rows: list) -> None:
    ids = [r.id for r in rows if r.id is not None]
    links = (await db.execute(select(
        VendorCategoryMember.category_id, VendorCategoryMember.vendor_id).where(
        VendorCategoryMember.category_id.in_(ids)))).all() if ids else []
    by_cat: dict[int, list[int]] = {}
    for c, v in links:
        by_cat.setdefault(c, []).append(v)
    for row in rows:
        row._vendor_ids = by_cat.get(row.id, [])


async def apply_vendor_category(db: AsyncSession, row, data: VendorCategoryIn) -> None:
    await require_unique(db, VendorCategory, "name", data.name, row, "A vendor category named")
    await require_unique(db, VendorCategory, "code", data.code, row, "Vendor category code")
    for key, value in data.model_dump(exclude={"vendor_ids"}).items():
        setattr(row, key, value)
    if data.vendor_ids is not None:
        if row.id is None:
            db.add(row)
            await db.flush()
        await _set_memberships(db, vendor_ids=data.vendor_ids, category_ids=[row.id],
                               side="category")


# --------------------------------------------------------------------------- #
#  Vendor material mapping (2026-10-01)
# --------------------------------------------------------------------------- #
# The Vendor Rates screen made a buyer add one vendor x one item at a time. The
# mapping screen picks suppliers on one side, categories or items on the other, and
# saves every combination in one press with the same defaults. Rows are ordinary
# mst_vendor_items, so RFQs, POs and the supplier filters read them as they always
# have.
MAX_MAPPING_PAIRS = 5000      # one request; see shared/limits.py on why requests cap


class VendorMappingIn(BaseModel):
    vendor_ids: list[int] = Field(min_length=1, max_length=200)
    item_ids: list[int] = Field(default_factory=list, max_length=500)
    # A category stands for every active item under it, at any depth.
    category_ids: list[int] = Field(default_factory=list, max_length=500)
    # Blank = leave an existing mapping's figure alone; a new mapping gets nothing.
    lead_time_days: int | None = Field(None, ge=0, le=3650)
    min_order_qty: float | None = Field(None, ge=0)
    last_rate: float | None = Field(None, ge=0)
    is_preferred: bool = False


async def vendor_mapping_sources(db: AsyncSession) -> dict:
    """Everything the mapping screen draws, in one call: material suppliers, the
    category tree and the active items, plus which pairs already exist."""
    carriers = func.upper(func.coalesce(Vendor.vendor_type, "MATERIAL")).in_(
        CARRIER_VENDOR_TYPES)
    vendors = (await db.execute(select(Vendor).where(
        Vendor.is_active.is_(True), ~carriers).order_by(Vendor.name))).scalars().all()
    cats = (await db.execute(select(ItemCategory).where(
        ItemCategory.is_active.is_(True)).order_by(ItemCategory.path))).scalars().all()
    items = (await db.execute(select(Item).where(
        Item.is_active.is_(True)).order_by(Item.code))).scalars().all()
    pairs = (await db.execute(select(VendorItem.vendor_id, VendorItem.item_id))).all()
    groups = (await db.execute(select(VendorCategory).where(
        VendorCategory.is_active.is_(True)).order_by(VendorCategory.name))).scalars().all()
    await prepare_vendor_categories(db, list(groups))
    return {
        "vendor_categories": [{"id": g.id, "code": g.code, "name": g.name,
                               "vendor_ids": g._vendor_ids} for g in groups],
        "vendors": [{"id": v.id, "code": v.code, "name": v.name,
                     "status": ("BLOCKED" if v.is_blacklisted
                                else "APPROVED" if v.is_approved else "PENDING")}
                    for v in vendors],
        "categories": [{"id": c.id, "code": c.code, "name": c.name, "level": c.level,
                        "parent_id": c.parent_id, "path": c.path} for c in cats],
        "items": [{"id": i.id, "code": i.code, "name": i.name,
                   "category_id": i.category_id} for i in items],
        "mapped": [[v, i] for v, i in pairs],
    }


async def save_vendor_mapping(db: AsyncSession, data: VendorMappingIn, user) -> dict:
    """Create or update one mst_vendor_items row per supplier x item.

    A blacklisted vendor is refused, not skipped: mapping it would put it back in
    front of buyers. Preferred is one vendor per item, so it needs exactly one
    supplier picked, and unticks whoever was preferred before.
    """
    vendors = (await db.execute(select(Vendor).where(
        Vendor.id.in_(data.vendor_ids)))).scalars().all()
    if len(vendors) != len(set(data.vendor_ids)):
        raise ValidationError(
            "Suppliers: one of them no longer exists. Refresh and pick again.")
    blocked = [v.name for v in vendors if v.is_blacklisted]
    if blocked:
        raise ValidationError(
            f"{', '.join(blocked)} {'is' if len(blocked) == 1 else 'are'} blocked and "
            "cannot be mapped to materials. Untick them, or unblock them under Vendors.")

    item_ids = set(data.item_ids)
    if data.category_ids:
        paths = [p for (p,) in (await db.execute(select(ItemCategory.path).where(
            ItemCategory.id.in_(data.category_ids)))).all() if p]
        if paths:
            under = select(ItemCategory.id).where(
                or_(*[ItemCategory.path.like(f"{p}%") for p in paths]))
            item_ids |= {i for (i,) in (await db.execute(select(Item.id).where(
                Item.is_active.is_(True), Item.category_id.in_(under)))).all()}
    if not item_ids:
        raise ValidationError(
            "Materials: pick at least one item, or a category that has items in it.")
    if len(item_ids) * len(vendors) > MAX_MAPPING_PAIRS:
        raise ValidationError(
            f"That is {len(item_ids) * len(vendors):,} combinations; the most in one "
            f"save is {MAX_MAPPING_PAIRS:,}. Pick fewer suppliers or categories.")
    if data.is_preferred and len(vendors) != 1:
        raise ValidationError(
            "Preferred: an item has only one preferred supplier. Pick one supplier to "
            "save as preferred, or switch Preferred off.")

    items = {i.id: i for i in (await db.execute(select(Item).where(
        Item.id.in_(item_ids)))).scalars().all()}
    existing = {(r.vendor_id, r.item_id): r for r in (await db.execute(
        select(VendorItem).where(VendorItem.vendor_id.in_([v.id for v in vendors]),
                                 VendorItem.item_id.in_(list(items))))).scalars().all()}
    if data.is_preferred:
        others = (await db.execute(select(VendorItem).where(
            VendorItem.item_id.in_(list(items)), VendorItem.is_preferred.is_(True),
            VendorItem.vendor_id != vendors[0].id))).scalars().all()
        for row in others:
            row.is_preferred = False

    created = updated = 0
    for vendor in vendors:
        for item in items.values():
            row = existing.get((vendor.id, item.id))
            if row is None:
                row = VendorItem(vendor_id=vendor.id, item_id=item.id, is_preferred=False)
                db.add(row)
                created += 1
            else:
                updated += 1
            row.item_code, row.item_name = item.code, item.name
            if data.lead_time_days is not None:
                row.lead_time_days = data.lead_time_days
            if data.min_order_qty is not None:
                row.min_order_qty = data.min_order_qty
            if data.last_rate is not None:
                row.last_rate = data.last_rate
            if data.is_preferred:
                row.is_preferred = True

    from app.platform.settings.service import write_audit
    await write_audit(
        db, entity="mst_vendor_items", action=AuditAction.UPDATE, actor=user,
        entity_no="VENDOR-MAPPING",
        summary=(f"Vendor material mapping: {len(vendors)} supplier(s) x "
                 f"{len(items)} item(s), {created} added, {updated} updated"),
        after={"vendor_ids": [v.id for v in vendors], "item_ids": sorted(items),
               "lead_time_days": data.lead_time_days,
               "min_order_qty": data.min_order_qty,
               "last_rate": data.last_rate, "is_preferred": data.is_preferred})
    await db.commit()
    return {"success": True, "created": created, "updated": updated,
            "suppliers": len(vendors), "items": len(items)}


# --------------------------------------------------------------------------- #
#  Brand item mapping (2026-10-15)
# --------------------------------------------------------------------------- #
# Brand and manufacturer left the item form; they are managed centrally here.
# The mapping screen picks brands on one side, categories or items on the other,
# and saves every combination in one press. Manufacturers ride along from each
# brand's own mst_brand_manufacturers rows, so they are stored nowhere here.
class BrandItemMappingIn(BaseModel):
    brand_ids: list[int] = Field(min_length=1, max_length=500)
    item_ids: list[int] = Field(default_factory=list, max_length=1000)
    # A category stands for every active item under it, at any depth.
    category_ids: list[int] = Field(default_factory=list, max_length=500)


async def brand_item_mapping_sources(db: AsyncSession) -> dict:
    """Everything the Brand Item Mapping screen needs in one call.

    All active brands (with their manufacturer names), the full item category
    tree, all active items, and every brand-item pair already mapped. Mirrors
    the shape of `vendor_mapping_sources`.
    """
    cats = (await db.execute(select(ItemCategory).where(
        ItemCategory.is_active.is_(True)).order_by(ItemCategory.path))).scalars().all()
    items = (await db.execute(select(Item).where(
        Item.is_active.is_(True)).order_by(Item.code))).scalars().all()
    brands = (await db.execute(select(Brand).where(
        Brand.is_active.is_(True)).order_by(Brand.name))).scalars().all()
    pairs = (await db.execute(
        select(BrandItemMapping.brand_id, BrandItemMapping.item_id).where(
            BrandItemMapping.is_active.is_(True)))).all()
    # Per-brand manufacturer names off the eagerly-loaded Brand.manufacturers
    # relationship (selectin, so no lazy load on this async session).
    return {
        "brands": [{"id": b.id, "code": b.code, "name": b.name,
                    "manufacturer_names": [bm.manufacturer_name or ""
                                           for bm in (b.manufacturers or [])
                                           if bm.is_active and bm.manufacturer_name]}
                   for b in brands],
        "categories": [{"id": c.id, "code": c.code, "name": c.name, "level": c.level,
                        "parent_id": c.parent_id, "path": c.path} for c in cats],
        "items": [{"id": i.id, "code": i.code, "name": i.name,
                   "category_id": i.category_id} for i in items],
        "mapped": [[b, i] for b, i in pairs],
    }


async def save_brand_item_mapping(db: AsyncSession, data: BrandItemMappingIn,
                                  user) -> dict:
    """Create or restore mst_brand_item_mappings rows in one call.

    Category IDs expand to all active items they contain (at any depth), so one
    tick on a category node maps all its items without the caller enumerating
    them. An inactive row is restored rather than duplicated — the unique
    constraint on (item_id, brand_id) would refuse a fresh insert.
    """
    brand_rows = (await db.execute(select(Brand).where(
        Brand.id.in_(data.brand_ids)))).scalars().all()
    if len(brand_rows) != len(set(data.brand_ids)):
        raise ValidationError(
            "Brands: one of them no longer exists. Refresh and pick again.")

    item_ids = set(data.item_ids)
    if data.category_ids:
        paths = [p for (p,) in (await db.execute(select(ItemCategory.path).where(
            ItemCategory.id.in_(data.category_ids)))).all() if p]
        if paths:
            under = select(ItemCategory.id).where(
                or_(*[ItemCategory.path.like(f"{p}%") for p in paths]))
            item_ids |= {i for (i,) in (await db.execute(select(Item.id).where(
                Item.is_active.is_(True), Item.category_id.in_(under)))).all()}
    if not item_ids:
        raise ValidationError(
            "Materials: pick at least one item, or a category that has items in it.")
    if len(item_ids) * len(brand_rows) > MAX_MAPPING_PAIRS:
        raise ValidationError(
            f"That is {len(item_ids) * len(brand_rows):,} combinations; the most in "
            f"one save is {MAX_MAPPING_PAIRS:,}. Pick fewer brands or categories.")

    items = {i.id: i for i in (await db.execute(select(Item).where(
        Item.id.in_(item_ids)))).scalars().all()}
    existing = {
        (r.brand_id, r.item_id): r
        for r in (await db.execute(select(BrandItemMapping).where(
            BrandItemMapping.brand_id.in_([b.id for b in brand_rows]),
            BrandItemMapping.item_id.in_(list(items))))).scalars().all()
    }

    created = updated = 0
    for brand in brand_rows:
        for item in items.values():
            row = existing.get((brand.id, item.id))
            if row is None:
                row = BrandItemMapping(
                    brand_id=brand.id, brand_code=brand.code, brand_name=brand.name,
                    item_id=item.id, item_code=item.code, item_name=item.name,
                    is_active=True,
                )
                db.add(row)
                created += 1
            elif not row.is_active:
                row.is_active = True
                row.item_code, row.item_name = item.code, item.name
                row.brand_code, row.brand_name = brand.code, brand.name
                updated += 1
            # A row already active is left alone (idempotent).

    from app.platform.settings.service import write_audit
    await write_audit(
        db, entity="mst_brand_item_mappings", action=AuditAction.UPDATE, actor=user,
        entity_no="BRAND-ITEM-MAPPING",
        summary=(f"Brand item mapping: {len(brand_rows)} brand(s) x "
                 f"{len(items)} item(s), {created} new, {updated} restored"),
        after={"brand_ids": [b.id for b in brand_rows], "item_ids": sorted(items)})
    await db.commit()
    return {"success": True, "created": created, "updated": updated,
            "brands": len(brand_rows), "items": len(items)}


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
        raise ValidationError(
            "Brands: one of the brands does not exist any more. Pick them again from the list.")

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
        raise ValidationError(
            "Manufacturers: one of the manufacturers does not exist any more. Pick them "
            "again from the list.")

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
        raise ValidationError("Brand and Manufacturer: pick both from their lists.")
    row.brand_id, row.brand_code, row.brand_name = brand.id, brand.code, brand.name
    row.manufacturer_id = manufacturer.id
    row.manufacturer_code, row.manufacturer_name = manufacturer.code, manufacturer.name
    row.is_active = data.is_active


# --------------------------------------------------------------------------- #
#  Brand variants and models (Brand → Variant → Model)
# --------------------------------------------------------------------------- #
_CHILD_CODE = r"^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$"


class _BrandChildIn(BaseModel):
    code: str = Field(min_length=1, max_length=20, pattern=_CHILD_CODE)
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(None, max_length=300)
    is_active: bool = True

    @field_validator("code", mode="before")
    @classmethod
    def _upper(cls, value):
        return str(value).strip().upper() if value is not None else value

    @field_validator("name", mode="before")
    @classmethod
    def _trim(cls, value):
        return str(value).strip() if value is not None else value


class BrandVariantIn(_BrandChildIn):
    brand_id: int


class BrandModelIn(_BrandChildIn):
    brand_id: int
    variant_id: int


def brand_variant_out(row) -> dict:
    return {"id": row.id, "brand_id": row.brand_id, "brand_code": row.brand_code,
            "brand_name": row.brand_name, "code": row.code, "name": row.name,
            "description": row.description, "is_active": row.is_active}


def brand_model_out(row: BrandModel) -> dict:
    return {**brand_variant_out(row), "variant_id": row.variant_id,
            "variant_code": row.variant_code, "variant_name": row.variant_name}


async def _active_brand(db: AsyncSession, brand_id: int) -> Brand:
    brand = await db.get(Brand, brand_id)
    if not brand:
        raise ValidationError("Brand: pick one from the list.")
    if not brand.is_active:
        raise ValidationError(f"Brand “{brand.name}” is inactive. Reactivate it first.")
    return brand


async def apply_brand_variant(db: AsyncSession, row: BrandVariant,
                              data: BrandVariantIn) -> None:
    brand = await _active_brand(db, data.brand_id)
    # Its models snapshot the brand, so a variant with models cannot change brand.
    if row.id is not None and row.brand_id != brand.id and await db.scalar(
            select(BrandModel.id).where(BrandModel.variant_id == row.id).limit(1)):
        raise ValidationError(
            "This variant already has models, so it cannot move to another brand. "
            "Create a new variant under that brand instead.")
    scope = BrandVariant.brand_id == brand.id
    await require_unique(db, BrandVariant, "code", data.code, row,
                         f"Variant code in {brand.name}", scope=scope)
    await require_unique(db, BrandVariant, "name", data.name, row,
                         f"A variant of {brand.name} named", scope=scope)
    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.brand_code, row.brand_name = brand.code, brand.name


async def apply_brand_model(db: AsyncSession, row: BrandModel,
                            data: BrandModelIn) -> None:
    brand = await _active_brand(db, data.brand_id)
    variant = await db.get(BrandVariant, data.variant_id)
    if not variant or variant.brand_id != brand.id:
        raise ValidationError(f"Variant: pick one of the variants of {brand.name}.")
    if not variant.is_active:
        raise ValidationError(f"Variant “{variant.name}” is inactive. Reactivate it first.")
    scope = BrandModel.variant_id == variant.id
    label = f"{brand.name} {variant.name}"
    await require_unique(db, BrandModel, "code", data.code, row,
                         f"Model code in {label}", scope=scope)
    await require_unique(db, BrandModel, "name", data.name, row,
                         f"A model of {label} named", scope=scope)
    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.brand_code, row.brand_name = brand.code, brand.name
    row.variant_code, row.variant_name = variant.code, variant.name


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
        raise ValidationError("Item class: that item class does not exist. Pick one from the list.")
    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.item_class_code, row.item_class_name = item_class.code, item_class.name


class PackagingIn(BaseModel):
    """A reusable container type — Packet, Box, Tote, Euro-pallet — and its own
    physical spec.

    The spec here is the CONTAINER'S, not the goods': its outer bounding box empty, its
    tare weight, and the handling rules that follow from how it is built. None of that
    depends on what goes inside, which is why it is configured once here and inherited
    by every item that packs in this container.

    What does depend on the contents — how many base units one holds, and what it
    weighs full — belongs to each item's own rung in `mst_item_packaging`, because the
    same box holds 50 SIM cards or 4 litres of oil.
    """
    code: str = Field(min_length=1, max_length=50, pattern=r"^[A-Za-z0-9-]+$")
    name: str
    # All three or none: two sides describe nothing a slotting check can use, and a
    # half-measured container is why a bin check has to say "not measured" rather than
    # quietly assume the missing side away.
    length_cm: float | None = Field(default=None, gt=0, le=100000)
    width_cm: float | None = Field(default=None, gt=0, le=100000)
    height_cm: float | None = Field(default=None, gt=0, le=100000)
    #: TARE — what the container weighs empty.
    weight_kg: float | None = Field(default=None, ge=0, le=1000000)
    is_stackable: bool = True
    #: 1 means non-stackable. Blank means nobody has said, which the capacity check
    #: treats as unknown and never as unlimited.
    max_stack_tiers: int | None = Field(default=None, ge=1, le=999)
    #: May it be tipped to make it fit? A drum may not; a carton may.
    is_rotatable: bool = True
    #: Void factor — the share of the container's own cube goods actually reach.
    fill_efficiency_pct: float | None = Field(default=None, gt=0, le=100)
    is_returnable: bool = False
    is_active: bool = True

    @model_validator(mode="after")
    def whole_box_or_none(self):
        sides = (self.length_cm, self.width_cm, self.height_cm)
        if any(s is not None for s in sides) and not all(s is not None for s in sides):
            raise ValueError(
                "Give all three of length, width and height, or none of them — a "
                "container measured on two sides cannot be checked against a bin.")
        # A non-stackable container is one tier by definition. Storing the two so they
        # can disagree is how a screen ends up showing "not stackable, 4 high".
        if not self.is_stackable:
            self.max_stack_tiers = 1
        return self


def _num(value):
    return float(value) if value is not None else None


def packaging_out(p: Packaging) -> dict:
    return {"id": p.id, "code": p.code, "name": p.name,
            "length_cm": _num(p.length_cm), "width_cm": _num(p.width_cm),
            "height_cm": _num(p.height_cm), "weight_kg": _num(p.weight_kg),
            # Derived, never stored — three sides and a cube that can disagree is a bug
            # report waiting to happen, and the sides are the thing anyone measures.
            "volume_cbm": (
                None if not (p.length_cm and p.width_cm and p.height_cm)
                else float(p.length_cm) * float(p.width_cm) * float(p.height_cm) / 1e6),
            "is_stackable": True if p.is_stackable is None else bool(p.is_stackable),
            "max_stack_tiers": p.max_stack_tiers,
            "is_rotatable": True if p.is_rotatable is None else bool(p.is_rotatable),
            "fill_efficiency_pct": _num(p.fill_efficiency_pct),
            "is_returnable": bool(p.is_returnable),
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
    # Any case is accepted (“Count”, “count”): the message lists the choices
    # in readable case, so the check must not then refuse them for it.
    data.data_type = (data.data_type or "").strip().upper()
    if data.data_type not in {t.value for t in AttributeDataType}:
        raise ValidationError(
            f"Value type: “{data.data_type}” is not one of the choices. Pick one of: "
            f"{', '.join(t.value for t in AttributeDataType)}.")
    # A LIST attribute with no options would render an empty dropdown nobody can use.
    if data.data_type == AttributeDataType.LIST.value and not data.allowed_values:
        raise ValidationError(
            "Allowed values is empty. A LIST attribute needs the choices people can "
            "pick, separated by commas, e.g. Red, Blue, Green.")
    uom = await db.get(Uom, data.uom_id) if data.uom_id else None
    if data.uom_id is not None and uom is None:
        raise ValidationError(
            "Unit of measure: that unit does not exist. Pick one from the list.")
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
        raise ValidationError(
            "Unit of measure: that unit does not exist. Pick one from the list.")
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
    # Any case is accepted (“Count”, “count”): the message lists the choices
    # in readable case, so the check must not then refuse them for it.
    data.tag_type = (data.tag_type or "").strip().upper()
    if data.tag_type not in {t.value for t in CategoryTagType}:
        raise ValidationError(
            f"Tag type: “{data.tag_type}” is not one of the choices. Pick one of: "
            f"{', '.join(t.value for t in CategoryTagType)}.")
    category = await db.get(ItemCategory, data.category_id)
    if category is None:
        raise ValidationError("Category: that category does not exist. Pick one from the list.")

    model = {CategoryTagType.ATTRIBUTE.value: Attribute,
             CategoryTagType.SPEC.value: Spec,
             CategoryTagType.FEATURE.value: Feature}[data.tag_type]
    target = await db.get(model, data.tag_id)
    if target is None:
        raise ValidationError(
            f"Tag: that {data.tag_type.lower()} does not exist. Pick one from the list.")

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
        raise ValidationError("Item: that item does not exist. Pick one from the list.")
    group = await db.get(UserGroup, data.group_id)
    if group is None:
        raise ValidationError("Group: that group does not exist. Pick one from the list.")

    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.item_code, row.item_name = item.code, item.name
    row.group_name = group.name


# --------------------------------------------------------------------------- #
#  Item packaging — the tray -> box -> container ladder
# --------------------------------------------------------------------------- #
class ItemPackagingIn(BaseModel):
    """One rung of an item's ladder — a PACKAGING UNIT, in the WMS sense.

    `quantity` is the conversion factor (1 BOX = 50 EACH). The dimensions are an
    OVERRIDE of the container type's own box and are blank in the ordinary case, so a
    ladder stays cheap to configure and only genuine exceptions are typed.
    `gross_weight_kg` is what ONE of these weighs full — item-specific by definition,
    which is exactly why it cannot live on the container type.
    """
    item_id: int
    level: int
    package_id: int
    quantity: float
    length_cm: float | None = Field(default=None, gt=0, le=100000)
    width_cm: float | None = Field(default=None, gt=0, le=100000)
    height_cm: float | None = Field(default=None, gt=0, le=100000)
    gross_weight_kg: float | None = Field(default=None, ge=0, le=1000000)
    max_stack_tiers: int | None = Field(default=None, ge=1, le=999)
    is_default_putaway_unit: bool = False
    is_active: bool = True

    @model_validator(mode="after")
    def whole_box_or_none(self):
        sides = (self.length_cm, self.width_cm, self.height_cm)
        if any(s is not None for s in sides) and not all(s is not None for s in sides):
            raise ValueError(
                "Override all three of length, width and height, or leave all three "
                "blank to use the container type's own measurements.")
        return self


def item_packaging_out(p: ItemPackaging) -> dict:
    return {"id": p.id, "item_id": p.item_id, "level": p.level,
            "package_id": p.package_id, "package_name": p.package_name,
            "quantity": _num(p.quantity), "uom_id": p.uom_id,
            "uom_code": p.uom_code,
            "length_cm": _num(p.length_cm), "width_cm": _num(p.width_cm),
            "height_cm": _num(p.height_cm),
            "gross_weight_kg": _num(p.gross_weight_kg),
            "max_stack_tiers": p.max_stack_tiers,
            "is_default_putaway_unit": bool(p.is_default_putaway_unit),
            "is_active": p.is_active}


async def apply_item_packaging(db: AsyncSession, row: ItemPackaging,
                               data: ItemPackagingIn) -> None:
    """Level 1 is measured in the item's own unit; every level above counts the level
    below it. The rungs are stored, never the running totals — a stored total is one
    edit away from disagreeing with its own parts."""
    if data.level < 1:
        raise ValidationError(f"Pack level must be 1 or more. You typed {data.level}.")
    if data.quantity <= 0:
        raise ValidationError(f"Quantity must be more than 0. You typed {data.quantity}.")
    item = await db.get(Item, data.item_id)
    if item is None:
        raise ValidationError("Item: that item does not exist. Pick one from the list.")
    package = await db.get(Packaging, data.package_id)
    if package is None:
        raise ValidationError("Package: that package does not exist. Pick one from the list.")
    if data.level > 1 and not float(data.quantity).is_integer():
        raise ValidationError(
            f"Quantity: level {data.level} must hold a whole number of the pack below "
            f"it, e.g. 12 — not {data.quantity}.")

    # A ladder with a missing rung cannot be multiplied up, so a level may only be
    # added directly on top of one that already exists.
    if data.level > 1:
        below = await db.scalar(select(ItemPackaging.id).where(
            ItemPackaging.item_id == data.item_id,
            ItemPackaging.level == data.level - 1,
            ItemPackaging.is_active.is_(True)))
        if below is None:
            raise ValidationError(
                f"Pack level {data.level - 1} does not exist yet. Add level "
                f"{data.level - 1} before level {data.level}.")

    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.package_name = package.name
    # Every result is ultimately expressed in the item's own stocking UOM.
    row.uom_id, row.uom_code = item.uom_id, item.uom_code

    # At most one default putaway unit per item. Enforced here rather than by an index
    # for the reason `apply_vendor_item` gives about its preferred vendor: "at most one
    # TRUE per item" is not something a unique index can express. Turning one rung on
    # turns the others off, because the alternative is a form that refuses to save and
    # sends the storekeeper away to find the old default first.
    if data.is_default_putaway_unit:
        await db.execute(
            update(ItemPackaging)
            .where(ItemPackaging.item_id == data.item_id,
                   ItemPackaging.id != (row.id or 0))
            .values(is_default_putaway_unit=False)
        )


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
            "There is a bigger pack level above this one. Remove the highest level "
            "first, then this one.")


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

    containers = {
        c.id: c for c in (await db.execute(
            select(Packaging).where(
                Packaging.id.in_({r.package_id for r in rows if r.package_id}))
        )).scalars().all()
    } if rows else {}

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
        container = containers.get(row.package_id)
        # The rung's own override, else the container type's box. Volume is multiplied
        # out on read for the same reason the running totals are: a stored cube is one
        # edit away from disagreeing with the sides it came from.
        own = all(v is not None for v in (row.length_cm, row.width_cm, row.height_cm))
        sides = ((row.length_cm, row.width_cm, row.height_cm) if own else
                 (container.length_cm, container.width_cm, container.height_cm)
                 if container else (None, None, None))
        measured = all(v is not None for v in sides)
        out.append({
            "level": row.level, "package_id": row.package_id,
            "package_name": row.package_name, "quantity": _num(row.quantity),
            "uom_code": row.uom_code,
            "package_breakup": package_breakup,
            # What one of this package holds, expressed in the item's own unit.
            "base_quantity": running, "base_uom_code": item.uom_code,
            # What the warehouse checks a bin against — see modules/warehouse/capacity.
            "length_cm": _num(sides[0]), "width_cm": _num(sides[1]),
            "height_cm": _num(sides[2]),
            "volume_cbm": (float(sides[0]) * float(sides[1]) * float(sides[2]) / 1e6
                           if measured else None),
            "dims_from": ("RUNG" if own else "PACKAGE" if measured else None),
            "gross_weight_kg": _num(row.gross_weight_kg),
            "tare_weight_kg": _num(container.weight_kg) if container else None,
            "max_stack_tiers": (row.max_stack_tiers
                                or (container.max_stack_tiers if container else None)),
            "is_default_putaway_unit": bool(row.is_default_putaway_unit),
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
        raise ValidationError(f"Quantity must be more than 0. You typed {data.quantity}.")
    # A kit inside itself would make any expansion of its contents recurse forever.
    if data.item_id == data.component_item_id:
        raise ValidationError(
            "Component item is the kit itself. A kit cannot contain itself — pick a "
            "different item.")
    kit = await db.get(Item, data.item_id)
    if kit is None:
        raise ValidationError("Item: that item does not exist. Pick one from the list.")
    if not kit.has_components:
        raise ValidationError(
            "Turn on Has Components / Kit and save the item before adding components")
    component = await db.get(Item, data.component_item_id)
    if component is None:
        raise ValidationError(
            "Component item: that item does not exist. Pick one from the list.")
    uom = await db.get(Uom, data.uom_id) if data.uom_id else None
    if data.uom_id is not None and uom is None:
        raise ValidationError(
            "Unit of measure: that unit does not exist. Pick one from the list.")

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
HSN_CODE_LENGTH = 8
# Published tariff schedules write a code as "8471 30 10", "8471.30.10" or
# "8471-30-10". The grouping is presentation; the code is the eight digits.
_HSN_SEPARATORS = re.compile(r"[\s.\-]")


def _is_blank(value) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def normalize_hsn_code(value) -> str:
    """The canonical 8-digit text of an HSN code, from whatever carried it.

    An HSN code is a CODE made of digits, not a quantity, so it is stored as text —
    leading zeros are part of it. But it very often arrives as a NUMBER: Excel types a
    column of digits as numeric and hands back 10005040 (or 10005040.0), and an API
    client may post the bare integer. Both are the same code and both are accepted.

    A number cannot carry a leading zero, so chapters 01-09 come back one digit short
    ("01012100" -> 1012100). When the value arrived AS A NUMBER and is exactly one
    digit short, the zero is put back — that is the only way an 8-digit code can
    shrink to 7. TEXT typed as "1012100" is left alone and refused: that is somebody
    who mistyped, and guessing a chapter for them would be worse.
    """
    from_number = False
    if isinstance(value, bool):                   # bool is an int; it is not a code
        return str(value)
    if isinstance(value, float):
        if not value.is_integer():
            return str(value)                     # "8471.3" — refused as not 8 digits
        value, from_number = int(value), True
    elif isinstance(value, Decimal):
        if value != value.to_integral_value():
            return str(value)
        value, from_number = int(value), True
    elif isinstance(value, int):
        from_number = True
    text = _HSN_SEPARATORS.sub("", str(value))
    if from_number and text.isdigit() and len(text) == HSN_CODE_LENGTH - 1:
        text = "0" + text
    return text


def hsn_lookup_key(text: str) -> str:
    """How an HSN code typed into ANOTHER master's sheet (an item's HSN column) is
    matched against the HSN master. Only ever used to FIND an existing row, so
    restoring a lost leading zero here cannot invent a code — it either names a
    real row or matches nothing."""
    code = str(text).strip()
    if code.endswith(".0"):                  # a float that went through a CSV —
        code = code[:-2]                     # before "." is read as a separator
    code = _HSN_SEPARATORS.sub("", code)
    if code.isdigit() and len(code) == HSN_CODE_LENGTH - 1:
        code = "0" + code
    return code


def _pct(value: float) -> str:
    return f"{value:g}"


def check_hsn_code(value) -> str:
    """Normalise, then refuse anything that is not a real 8-digit HSN code, in words
    the person fixing the sheet can act on."""
    if _is_blank(value):
        raise PydanticCustomError("hsn_code", "HSN code is required")
    code = normalize_hsn_code(value)
    if not code.isdigit():
        raise PydanticCustomError(
            "hsn_code", "HSN code must contain digits only (got “{code}”)",
            {"code": code})
    if len(code) != HSN_CODE_LENGTH:
        raise PydanticCustomError(
            "hsn_code",
            "HSN code must be exactly 8 digits — “{code}” has {n}",
            {"code": code, "n": len(code)})
    # Chapters run 01-98; "00" is a short number that was zero-padded by hand.
    if code.startswith("00"):
        raise PydanticCustomError(
            "hsn_code", "HSN code “{code}” is in chapter 00, which does not exist",
            {"code": code})
    return code


class HsnIn(BaseModel):
    # Declared `str` because the code is text (leading zeros matter), but a number is
    # accepted — see normalize_hsn_code. The width stays declared on the field, where
    # the importer reads it to tell a fixed-width code column from free text.
    code: str = Field(min_length=HSN_CODE_LENGTH, max_length=HSN_CODE_LENGTH)
    description: str | None = Field(None, max_length=300)
    # The single GST rate for this classification. The within-state split (CGST +
    # SGST) and the across-state rate (IGST) are the same number on two routes, so
    # they are one field here and documents derive the halves when they need them.
    gst_rate: float = Field(0, ge=0, le=100)
    effective_from: date | None = None
    is_active: bool = True

    @field_validator("code", mode="before")
    @classmethod
    def _code(cls, value):
        return check_hsn_code(value)

    @field_validator("description", mode="before")
    @classmethod
    def _description(cls, value):
        if value is None:
            return None
        text = str(value).strip()
        return text or None



def hsn_out(h: HsnCode) -> dict:
    return {"id": h.id, "code": h.code, "description": h.description,
            "gst_rate": _num(h.gst_rate),
            "effective_from": h.effective_from.isoformat() if h.effective_from else None,
            "is_active": h.is_active}


async def apply_hsn(db: AsyncSession, row: HsnCode, data: HsnIn) -> None:
    # The 0-100 range is enforced by HsnIn itself, so the form, the API and every
    # import door refuse the same rows in the same words.
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
        raise ValidationError(
            "Effective to is before Effective from. Check both dates.")


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
        raise ValidationError("Project: that project does not exist. Pick one from the list.")
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
        raise ValidationError("BOM: that BOM does not exist. Pick one from the list.")
    if data.quantity <= 0:
        raise ValidationError(f"Quantity must be more than 0. You typed {data.quantity}.")
    item = await db.get(Item, data.item_id)
    if item is None:
        raise ValidationError("Item: that item does not exist. Pick one from the list.")
    uom = await db.get(Uom, data.uom_id) if data.uom_id else None
    if data.uom_id is not None and uom is None:
        raise ValidationError(
            "Unit of measure: that unit does not exist. Pick one from the list.")

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
        raise ValidationError("BOM: that BOM does not exist. Pick one from the list.")
    check_validity_window(data)
    profile = next((p for p in await profile_options(db, user)
                    if p["key"] == data.profile_key), None)
    if profile is None:
        raise ValidationError(
            "Job profile: that job profile does not exist. Pick one from the list.")

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

# --------------------------------------------------------------------------- #
#  Item eligibility — which items a role or a region may raise an indent for
# --------------------------------------------------------------------------- #

class ItemEligibilityIn(BaseModel):
    """One tag: this item, for this role or this region.

    An item with NO tags is requestable by everyone. Only a tagged item is ever
    narrowed — see `modules/indents/eligibility.py` for why the default is open and
    why it has to stay that way on a live system.
    """
    item_id: int
    scope_type: str
    scope_id: int
    is_active: bool = True


def item_eligibility_out(row: ItemEligibility) -> dict:
    return {
        "id": row.id,
        "item_id": row.item_id,
        "item_code": row.item_code,
        "item_name": row.item_name,
        "scope_type": row.scope_type,
        "scope_id": row.scope_id,
        "scope_name": row.scope_name,
        "is_active": row.is_active,
    }


async def apply_item_eligibility(db: AsyncSession, row: ItemEligibility,
                                 data: ItemEligibilityIn) -> None:
    """Validate the pair and snapshot both names onto the row.

    Snapshotted so the register reads without joining two unrelated tables — and
    because `scope_id` points at `rbac_roles` for a ROLE and `hcm_offices` for a
    REGION, which no single join could satisfy.
    """
    # Every field, not just the derived ones. `_apply_fields` calls this INSTEAD of
    # copying the payload — an `apply` hook owns the whole row — so a field left unset
    # here is never written. Missing `item_id` made every save a NOT NULL violation,
    # which the screen showed as "Internal server error".
    row.item_id = data.item_id
    row.scope_id = data.scope_id
    row.is_active = data.is_active

    scope = (data.scope_type or "").strip().upper()
    if scope not in {s.value for s in ItemScope}:
        raise ValidationError(
            f"Applies to: “{data.scope_type}” is not one of the choices. Pick one of: "
            f"{', '.join(sorted(s.value for s in ItemScope))}.")
    row.scope_type = scope

    item = await db.get(Item, data.item_id)
    if item is None:
        raise NotFoundError("Item: that item does not exist. Pick one from the list.")
    row.item_code, row.item_name = item.code, item.name

    if scope == ItemScope.ROLE.value:
        found = (await db.execute(
            select(Role.name).where(Role.id == data.scope_id))).scalar_one_or_none()
        if found is None:
            raise NotFoundError("Role: that role does not exist. Pick one from the list.")
    else:
        found = (await db.execute(
            select(HcmOffice.name).where(
                HcmOffice.id == data.scope_id))).scalar_one_or_none()
        if found is None:
            raise NotFoundError("Region: that office does not exist. Pick one from the list.")
    row.scope_name = found

    # Checked in Python as well as by the unique index: the message an admin needs is
    # "this item is already tagged to that role", not a driver-level duplicate-key
    # error with a constraint name in it.
    clash = (await db.execute(
        select(ItemEligibility.id).where(
            ItemEligibility.item_id == data.item_id,
            ItemEligibility.scope_type == scope,
            ItemEligibility.scope_id == data.scope_id,
            ItemEligibility.id != (row.id or 0),
        ))).scalar_one_or_none()
    if clash is not None:
        raise ValidationError(
            f"{item.code} is already tagged to {found}.")


# The item sheet's nine foreign keys, stated by name rather than by id. Six of them
# are required, so before this an item could not be added to the spreadsheet at all
# without six lookups into six other exports — which is why the item master is the
# one this started with.
#
# The chain the item form enforces (a general name narrows the brands, a brand
# narrows the manufacturers) is NOT re-stated here: `apply_item` already checks it on
# the way in and rejects a combination that does not hold, so a second copy in the
# sheet would only be a second opinion to keep in step.
ITEM_LOOKUPS = (
    Lookup("category_id", ItemCategory, "Category", where={"level": 3},
           where_hint="An item needs a Level 3 category — pick one under it."),
    Lookup("general_name_id", GeneralName, "Generic name"),
    Lookup("brand_id", Brand, "Brand"),
    Lookup("manufacturer_id", Manufacturer, "Manufacturer"),
    Lookup("item_class_id", ItemClass, "Item class"),
    Lookup("item_sub_class_id", ItemSubClass, "Item sub class"),
    Lookup("owner_department_id", HcmDepartment, "Ownership department",
           same_name_is_one=True),
    Lookup("uom_id", Uom, "Unit of measure"),
    # An HSN row has no `name` — it is a code and a description, and the code is
    # what is written on an invoice, so that is what the sheet asks for and matches
    # on first.
    Lookup("hsn_id", HsnCode, "HSN code",
           match=("code", "description"), display=("code",),
           normalize=hsn_lookup_key),
    Lookup("dosage_form_id", DosageForm, "Dosage form"),
)


MASTERS: list[MasterDef] = [
    # Which items a role or a region may raise an indent for. Empty by default, and
    # an untagged item stays open to everyone — so this screen NARROWS, and can never
    # be the reason nobody can raise an indent.
    MasterDef(path="item-eligibility", name="Item eligibility",
              model=ItemEligibility, schema=ItemEligibilityIn,
              manage_perm=perms.MASTER_ITEM_MANAGE,
              serialize=item_eligibility_out, apply=apply_item_eligibility,
              search_cols=("item_code", "item_name", "scope_name"),
              order_col="item_code",
              filters=("item_id", "scope_type", "scope_id")),

    MasterDef(path="items", name="Item", model=Item, schema=ItemIn,
              manage_perm=perms.MASTER_ITEM_MANAGE, serialize=item_out,
              search_cols=("name", "code"), apply=apply_item,
              default_active_only=True,
              scope_to_user=restrict_items_to_my_groups,
              filters=("category_id", "item_class_id", "brand_id", "hsn_id",
                       "owner_department_id"),
              lookups=ITEM_LOOKUPS, prepare=prepare_items,
              usage=ITEM_USAGE),

    MasterDef(path="item-categories", name="Category", model=ItemCategory,
              schema=CategoryIn, manage_perm=perms.MASTER_CATEGORY_MANAGE,
              serialize=category_out, search_cols=("name", "code"),
              apply=apply_category,
              # Numbered automatically under its parent; not asked for in a new sheet.
              template_omit=("segment_code",),
              # The parent by NAME or CODE, never an id nobody filling a sheet knows.
              # A parent added in the same file is created first (bulk.take_pending).
              lookups=(Lookup("parent_id", ItemCategory, "Parent category",
                              match=("code", "name"), display=("name",)),),
              usage=((*USED_BY_ITEMS, "category_id"), ("Category tags", "mst_category_tags", "category_id"),)),

    # Carries its brands inline, so there is no General-name/Brand mapping screen.
    # The item form reads this list to narrow the brand dropdown.
    MasterDef(path="general-names", name="Generic name", model=GeneralName,
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

    # What a unit measures. Was the UomClass enum; a master since 2026-10-01 so the
    # UOM form's list can be extended without a release. Same permission as UOM.
    MasterDef(path="uom-classes", name="UOM type", model=UomClassRow,
              schema=UomClassIn, manage_perm=perms.MASTER_UOM_MANAGE,
              serialize=uom_class_out, search_cols=("name", "code"),
              order_col="name", paginated=False,
              apply=named_code_apply(UomClassRow, "A UOM type"),
              usage=(("Units of measure", "mst_uom", "uom_class"),)),

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
              filters=("warehouse_type",), list_filter=warehouse_kind_filter,
              usage=WAREHOUSE_USAGE),

    MasterDef(path="bins", name="Bin", model=Bin, schema=BinIn,
              manage_perm=perms.MASTER_LOCATION_MANAGE, serialize=bin_out,
              # `path` is derived when a tree is read, not a column — ordering or
              # searching on it is an AttributeError, not an empty result.
              search_cols=("code", "name"), order_col="code",
              apply=apply_bin, prepare=prepare_bins),

    # Read-only: HCM owns projects and platform/hcm/sync.py writes them. A local edit
    # would survive only until the next sync overwrote it without saying so.
    MasterDef(path="projects", name="Project", model=Project, schema=ProjectIn,
              manage_perm=perms.MASTER_PROJECT_MANAGE, serialize=project_out,
              search_cols=("name", "code"), apply=apply_project, read_only=True),

    MasterDef(path="vendors", name="Vendor", model=Vendor, schema=VendorIn,
              manage_perm=perms.MASTER_VENDOR_MANAGE, serialize=vendor_out,
              search_cols=("name", "code"), default_active_only=True,
              filters=("vendor_type",), list_filter=vendor_kind_filter,
              apply=apply_vendor, prepare=prepare_vendors, usage=VENDOR_USAGE),

    # How suppliers are grouped (Glassware, Reagents ...). Same permission as Vendors.
    MasterDef(path="vendor-categories", name="Vendor category", model=VendorCategory,
              schema=VendorCategoryIn, manage_perm=perms.MASTER_VENDOR_MANAGE,
              serialize=vendor_category_out, search_cols=("name", "code"),
              order_col="name", paginated=False, apply=apply_vendor_category,
              prepare=prepare_vendor_categories,
              usage=(("Vendors tagged", "mst_vendor_category_members", "category_id"),)),

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
              usage=((*USED_BY_ITEMS, "brand_id"), ("Manufacturer mappings", "mst_brand_manufacturers", "brand_id"), ("General name mappings", "mst_brand_general_names", "brand_id"), ("Variants", "mst_brand_variants", "brand_id"),)),

    # Brand → Variant → Model, each scoped to its parent (Masters › Brands sub-tabs).
    MasterDef(path="brand-variants", name="Brand variant", model=BrandVariant,
              schema=BrandVariantIn, manage_perm=perms.MASTER_BRAND_MANAGE,
              serialize=brand_variant_out, search_cols=("name", "code", "brand_name"),
              order_col="brand_name", apply=apply_brand_variant,
              filters=("brand_id",),
              usage=(("Models", "mst_brand_models", "variant_id"),)),

    MasterDef(path="brand-models", name="Brand model", model=BrandModel,
              schema=BrandModelIn, manage_perm=perms.MASTER_BRAND_MANAGE,
              serialize=brand_model_out,
              search_cols=("name", "code", "brand_name", "variant_name"),
              order_col="brand_name", apply=apply_brand_model,
              filters=("brand_id", "variant_id")),

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

    # ---- payment terms (2026-10-06) ----
    MasterDef(path="payment-terms", name="Payment term", model=PaymentTerm,
              schema=PaymentTermIn, manage_perm=perms.MASTER_PAYMENT_TERM_MANAGE,
              serialize=payment_term_out, search_cols=("name", "code"),
              apply=apply_payment_term,
              usage=(("Purchase orders", "pro_purchase_orders", "payment_term_id"),)),

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
