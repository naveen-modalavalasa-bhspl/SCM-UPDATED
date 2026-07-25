"""mst_ tables — SCM's own master data. Owned by shared/."""
from sqlalchemy import (
    JSON, Boolean, Column, Date, ForeignKey, Index, Integer, Numeric, String,
    Text, UniqueConstraint,
)

from app.core.database import Base
from app.shared.models.base import (
    BigIntPortable, created_at_col, pk, soft_fk, updated_at_col,
)


class Uom(Base):
    # Maps only the columns the app uses. The live table also has NOT-NULL columns
    # (uom_class, decimal_places) with DB defaults; leaving them UNMAPPED lets those
    # defaults apply on insert — mapping them and passing None would send an explicit
    # NULL that overrides the default and raises IntegrityError.
    __tablename__ = "mst_uom"
    id = pk()
    code = Column(String(20), unique=True, nullable=False)
    name = Column(String(100), nullable=False)
    is_active = Column(Boolean, nullable=False, default=True)


class ItemCategory(Base):
    # Columns mirror the DB team's live mst_item_categories table exactly. Keep in
    # sync with SHOW COLUMNS mst_item_categories — a stray column crashes SELECTs.
    __tablename__ = "mst_item_categories"
    id = pk()
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(200), nullable=False)
    parent_id = Column(ForeignKey("mst_item_categories.id"), index=True, nullable=True)
    # NOT NULL in the live table with DB default 1; mirror the default so inserts that
    # don't compute a tree level still satisfy the constraint. (path is left unmapped.)
    level = Column(Integer, nullable=False, default=1)
    segment_code = Column(String(2), nullable=True)
    path = Column(String(500), nullable=True, unique=True)
    is_active = Column(Boolean, nullable=False, default=True)


class GeneralName(Base):
    __tablename__ = "mst_general_names"
    id = pk()
    code = Column(String(10), unique=True, nullable=False)
    name = Column(String(200), nullable=False)
    description = Column(String(300), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)


class Manufacturer(Base):
    __tablename__ = "mst_manufacturers"
    id = pk()
    code = Column(String(10), unique=True, nullable=False)
    name = Column(String(200), nullable=False)
    description = Column(String(300), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)


class DosageForm(Base):
    __tablename__ = "mst_dosage_forms"
    id = pk()
    code = Column(String(10), unique=True, nullable=False)
    name = Column(String(200), nullable=False)
    is_active = Column(Boolean, nullable=False, default=True)


class Item(Base):
    # Columns mirror the DB team's live mst_items table exactly. Keep in sync with
    # SHOW COLUMNS mst_items — a column here that the table lacks makes select(Item)
    # fail with "Unknown column", which empties the /api/items dropdown.
    __tablename__ = "mst_items"
    id = pk()
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(300), nullable=False)
    short_name = Column(String(100), nullable=True)
    category_id = Column(ForeignKey("mst_item_categories.id"), index=True, nullable=True)
    category_name = Column(String(200), nullable=True)   # snapshot
    general_name_id = Column(ForeignKey("mst_general_names.id"), index=True, nullable=True)
    general_name_code = Column(String(10), nullable=True)
    general_name = Column(String(200), nullable=True)
    brand_id = Column(ForeignKey("mst_brands.id"), index=True, nullable=True)
    brand_code = Column(String(10), nullable=True)
    brand_name = Column(String(200), nullable=True)
    manufacturer_id = Column(ForeignKey("mst_manufacturers.id"), index=True, nullable=True)
    manufacturer_code = Column(String(10), nullable=True)
    manufacturer_name = Column(String(200), nullable=True)
    item_class_id = Column(ForeignKey("mst_item_classes.id"), index=True, nullable=True)
    item_class_code = Column(String(10), nullable=True)
    item_class_name = Column(String(200), nullable=True)
    item_sub_class_id = Column(ForeignKey("mst_item_sub_classes.id"), index=True,
                               nullable=True)
    item_sub_class_code = Column(String(10), nullable=True)
    item_sub_class_name = Column(String(200), nullable=True)
    uom_id = Column(ForeignKey("mst_uom.id"), index=True, nullable=True)
    uom_code = Column(String(20), nullable=True)          # snapshot
    item_type = Column(String(30), nullable=True)
    hsn_code = Column(String(20), nullable=True)
    description = Column(Text, nullable=True)
    has_components = Column(Boolean, nullable=False, default=False)
    barcode_type = Column(String(20), nullable=True)
    barcode_value = Column(String(100), nullable=True)
    tax_percent = Column(Numeric(6, 3), nullable=True)
    cgst_rate = Column(Numeric(6, 3), nullable=False, default=0)
    sgst_rate = Column(Numeric(6, 3), nullable=False, default=0)
    igst_rate = Column(Numeric(6, 3), nullable=False, default=0)
    is_batch_tracked = Column(Boolean, nullable=False, default=False)
    is_serial_tracked = Column(Boolean, nullable=False, default=False)
    has_expiry = Column(Boolean, nullable=False, default=False)
    requires_qi = Column(Boolean, nullable=False, default=False)
    shelf_life_days = Column(Integer, nullable=False, default=0)
    safety_stock = Column(Numeric(16, 3), nullable=False, default=0)
    reorder_level = Column(Numeric(16, 3), nullable=False, default=0)
    reorder_qty = Column(Numeric(16, 3), nullable=False, default=0)
    lead_time_days = Column(Integer, nullable=False, default=0)
    min_order_qty = Column(Numeric(16, 3), nullable=False, default=0)
    max_order_qty = Column(Numeric(16, 3), nullable=False, default=0)
    purchase_price = Column(Numeric(16, 4), nullable=False, default=0)
    selling_price = Column(Numeric(16, 4), nullable=False, default=0)
    mrp = Column(Numeric(16, 4), nullable=False, default=0)
    dosage_form_id = Column(ForeignKey("mst_dosage_forms.id"), index=True, nullable=True)
    dosage_form_code = Column(String(10), nullable=True)
    dosage_form_name = Column(String(200), nullable=True)
    valuation_method = Column(String(20), nullable=False, default="FIFO")
    requires_special_storage = Column(Boolean, nullable=False, default=False)
    storage_conditions = Column(String(300), nullable=True)
    requires_special_transport = Column(Boolean, nullable=False, default=False)
    transport_conditions = Column(String(300), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = created_at_col()
    updated_at = updated_at_col()


# Plain index on name for search. (Guide's Postgres gin/to_tsvector is not portable
# to MySQL/SQLite; search uses LIKE on this index. See root CLAUDE.md deviations.)
Index("ix_mst_items_name", Item.name)
Index("ix_mst_items_is_active", Item.is_active)


class Vendor(Base):
    # Maps only the columns the app reads/writes. The live table has more (vendor_type,
    # rating, credit_limit, is_approved, is_blacklisted, pincode, payment_terms_days,
    # pan, address) — some NOT NULL with DB defaults (e.g. vendor_type='MATERIAL').
    # Those are left UNMAPPED so their defaults apply on insert; mapping a NOT-NULL
    # column and passing None sends an explicit NULL that overrides the default.
    __tablename__ = "mst_vendors"
    id = pk()
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(200), nullable=False, index=True)
    contact_person = Column(String(150), nullable=True)
    phone = Column(String(30), nullable=True)
    email = Column(String(200), nullable=True)
    city = Column(String(100), nullable=True)
    state = Column(String(100), nullable=True)
    gstin = Column(String(20), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True, index=True)
    created_at = created_at_col()
    updated_at = updated_at_col()


class VendorItem(Base):
    __tablename__ = "mst_vendor_items"
    id = pk()
    vendor_id = Column(ForeignKey("mst_vendors.id", ondelete="CASCADE"), index=True, nullable=False)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    last_rate = Column(Numeric(14, 2), nullable=True)
    lead_time_days = Column(Numeric(6, 0), nullable=True)
    is_preferred = Column(Boolean, nullable=False, default=False)


class UomConversion(Base):
    """factor = how many `to_uom` in one `from_uom`. BOX -> PCS with factor 12 means
    one box is twelve pieces. Only the forward direction is stored; the reverse is
    1/factor, so a pair cannot disagree with itself.

    Columns mirror the DB team's live table exactly — it has no is_active and no code
    snapshots, so neither is mapped (a mapped column the table lacks raises 1054 on
    every SELECT).
    """
    __tablename__ = "mst_uom_conversions"
    id = pk()
    from_uom_id = Column(ForeignKey("mst_uom.id", ondelete="CASCADE"), index=True,
                         nullable=False)
    to_uom_id = Column(ForeignKey("mst_uom.id", ondelete="CASCADE"), index=True,
                       nullable=False)
    factor = Column(Numeric(16, 6), nullable=False)


class Brand(Base):
    """Manufacturer brand. Until now a brand was free text on mst_item_specs.brand,
    so the same brand appeared under several spellings. This makes it a real row."""
    __tablename__ = "mst_brands"
    id = pk()
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(200), nullable=False)
    manufacturer = Column(String(200), nullable=True)
    description = Column(String(300), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)


class BrandManufacturer(Base):
    __tablename__ = "mst_brand_manufacturers"
    id = pk()
    brand_id = Column(ForeignKey("mst_brands.id"), index=True, nullable=False)
    brand_code = Column(String(10), nullable=True)
    brand_name = Column(String(200), nullable=True)
    manufacturer_id = Column(ForeignKey("mst_manufacturers.id"), index=True,
                             nullable=False)
    manufacturer_code = Column(String(10), nullable=True)
    manufacturer_name = Column(String(200), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    __table_args__ = (
        UniqueConstraint("brand_id", "manufacturer_id",
                         name="uq_brand_manufacturer"),
    )


class ItemClass(Base):
    """Broad classification, coarser than a category. Replaces the free-text
    mst_items.item_type, which defaulted to 'CONSUMABLE' and was never validated."""
    __tablename__ = "mst_item_classes"
    id = pk()
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(200), nullable=False)
    description = Column(String(300), nullable=True)
    # Items of a capitalised class are assets, not consumed on issue.
    is_capitalised = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True)


class ItemSubClass(Base):
    __tablename__ = "mst_item_sub_classes"
    id = pk()
    item_class_id = Column(ForeignKey("mst_item_classes.id"), index=True, nullable=False)
    item_class_code = Column(String(10), nullable=True)
    item_class_name = Column(String(200), nullable=True)
    code = Column(String(10), nullable=False)
    name = Column(String(200), nullable=False)
    description = Column(String(300), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    __table_args__ = (
        UniqueConstraint("item_class_id", "code", name="uq_item_sub_class_code"),
    )


class Packaging(Base):
    """How an item is packed for handling: box of 12, carton of 6 boxes.

    qty_per_pack is expressed in `uom_id`, so a "Box" holding 12 PCS stores
    qty_per_pack=12 with the PCS uom. That keeps it consistent with
    mst_uom_conversions rather than inventing a second conversion rule.
    """
    __tablename__ = "mst_packaging"
    id = pk()
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(200), nullable=False)
    uom_id = Column(ForeignKey("mst_uom.id"), index=True, nullable=True)
    uom_code = Column(String(20), nullable=True)          # snapshot
    qty_per_pack = Column(Numeric(16, 3), nullable=True)
    length_cm = Column(Numeric(10, 2), nullable=True)
    width_cm = Column(Numeric(10, 2), nullable=True)
    height_cm = Column(Numeric(10, 2), nullable=True)
    weight_kg = Column(Numeric(10, 3), nullable=True)
    is_returnable = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True)


class Feature(Base):
    """A yes/no trait an item can carry: fragile, hazardous, cold-chain.

    Deliberately a flag list, not an attribute: a feature has no value, an item
    either has it or does not.
    """
    __tablename__ = "mst_features"
    id = pk()
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(200), nullable=False)
    description = Column(String(300), nullable=True)
    # Features that change handling (hazardous, cold-chain) warn on the item screen.
    affects_handling = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True)


class Attribute(Base):
    """The DEFINITION of an item property: "Voltage", a NUMBER, measured in volts.

    The per-item VALUE is not here — it goes in mst_item_specs.specifications, which
    the DB team already provides as JSON. Splitting definition from value is what
    lets the same attribute be reused across categories.
    """
    __tablename__ = "mst_attributes"
    id = pk()
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(200), nullable=False)
    data_type = Column(String(20), nullable=False, default="TEXT")   # AttributeDataType
    unit = Column(String(30), nullable=True)          # "volts", "mm", "kg"
    # Only meaningful for data_type LIST: the values the UI offers.
    allowed_values = Column(JSON, nullable=True)
    description = Column(String(300), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)


class AttributeMapping(Base):
    """Which attributes items of a given kind should carry.

    A template, not a value: "every item in category Cables needs Voltage and Length".
    The item screen reads these to decide which fields to show, then writes the
    answers into mst_item_specs.specifications.
    """
    __tablename__ = "mst_attribute_mappings"
    id = pk()
    attribute_id = Column(ForeignKey("mst_attributes.id", ondelete="CASCADE"),
                          index=True, nullable=False)
    attribute_code = Column(String(50), nullable=True)    # snapshot
    attribute_name = Column(String(200), nullable=True)   # snapshot
    target_type = Column(String(20), nullable=False)      # AttributeTarget
    target_id = Column(BigIntPortable, index=True, nullable=False)
    target_name = Column(String(200), nullable=True)      # snapshot
    is_required = Column(Boolean, nullable=False, default=False)
    sort_order = Column(Integer, nullable=False, default=0)
    is_active = Column(Boolean, nullable=False, default=True)
    __table_args__ = (
        UniqueConstraint("attribute_id", "target_type", "target_id",
                         name="uq_attr_map_attr_target"),
    )


class PriceList(Base):
    """A named set of rates, valid for a period. Rates were previously scattered
    across mst_vendor_items.last_rate and mst_bom_items.estimated_rate with no
    history; a price list gives them one home and a validity window."""
    __tablename__ = "mst_price_lists"
    id = pk()
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(200), nullable=False)
    price_type = Column(String(20), nullable=False, default="PURCHASE")   # PriceType
    currency = Column(String(3), nullable=False, default="INR")
    vendor_id = Column(ForeignKey("mst_vendors.id"), index=True, nullable=True)
    vendor_name = Column(String(200), nullable=True)      # snapshot
    project_id = Column(BigIntPortable, index=True, nullable=True)
    project_name = Column(String(200), nullable=True)     # snapshot
    valid_from = Column(Date, nullable=True)
    valid_to = Column(Date, nullable=True)
    description = Column(String(300), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = created_at_col()
    updated_at = updated_at_col()


class PriceListItem(Base):
    """One item's rate inside a price list. min_qty allows slab pricing: two rows for
    the same item at different minimum quantities."""
    __tablename__ = "mst_price_list_items"
    id = pk()
    price_list_id = Column(ForeignKey("mst_price_lists.id", ondelete="CASCADE"),
                           index=True, nullable=False)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)         # snapshot
    item_name = Column(String(300), nullable=True)        # snapshot
    uom_id = Column(ForeignKey("mst_uom.id"), index=True, nullable=True)
    uom_code = Column(String(20), nullable=True)          # snapshot
    rate = Column(Numeric(16, 4), nullable=False)
    min_qty = Column(Numeric(16, 3), nullable=False, default=0)
    discount_percent = Column(Numeric(6, 3), nullable=False, default=0)
    is_active = Column(Boolean, nullable=False, default=True)
    __table_args__ = (
        UniqueConstraint("price_list_id", "item_id", "min_qty",
                         name="uq_price_list_item_qty"),
    )


class Project(Base):
    """Projects own stock without owning items: mst_items stays project-agnostic and
    the project dimension lives on the stock ledger, so a transfer between projects
    never touches the item master.

    Maps only the columns the app uses; the live table also has customer_*, manager_*,
    budget_amount and created_at, some NOT NULL with DB defaults (status='ACTIVE').
    """
    __tablename__ = "mst_projects"
    id = pk()
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(200), nullable=False)
    office_id = soft_fk()
    office_name = Column(String(200), nullable=True)
    start_date = Column(Date, nullable=True)
    end_date = Column(Date, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)


class Bom(Base):
    """Bill of materials: what an assembled or kitted item is made of.

    The DB team already created this table; these are the columns the app uses.
    Left unmapped: version, output_uom_code, vehicle_type, estimated_cost and
    created_by_*, several of which are NOT NULL with database defaults.
    """
    __tablename__ = "mst_boms"
    id = pk()
    code = Column(String(50), nullable=False, index=True)
    name = Column(String(200), nullable=False)
    bom_type = Column(String(30), nullable=False, default="GENERAL")   # BomType
    parent_item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=True)
    parent_item_code = Column(String(50), nullable=True)      # snapshot
    parent_item_name = Column(String(300), nullable=True)     # snapshot
    output_qty = Column(Numeric(16, 3), nullable=False, default=1)
    project_id = Column(BigIntPortable, index=True, nullable=True)
    project_name = Column(String(200), nullable=True)         # snapshot
    department_id = Column(BigIntPortable, index=True, nullable=True)
    department_name = Column(String(200), nullable=True)      # snapshot
    description = Column(String(500), nullable=True)
    total_items = Column(Integer, nullable=False, default=0)
    is_default = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True)
    effective_from = Column(Date, nullable=True)
    effective_to = Column(Date, nullable=True)


class BomItem(Base):
    """One component line of a BOM. `child_bom_id` lets a BOM contain another BOM,
    which is how a kit built from sub-kits is modelled."""
    __tablename__ = "mst_bom_items"
    id = pk()
    bom_id = Column(ForeignKey("mst_boms.id", ondelete="CASCADE"), index=True,
                    nullable=False)
    line_no = Column(Integer, nullable=False, default=1)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)         # snapshot
    item_name = Column(String(300), nullable=True)        # snapshot
    category_name = Column(String(200), nullable=True)    # snapshot
    uom_id = Column(BigIntPortable, nullable=True)
    uom_code = Column(String(20), nullable=True)          # snapshot
    quantity = Column(Numeric(16, 3), nullable=False, default=1)
    scrap_percent = Column(Numeric(6, 3), nullable=False, default=0)
    child_bom_id = Column(BigIntPortable, index=True, nullable=True)
    is_optional = Column(Boolean, nullable=False, default=False)
    remarks = Column(String(500), nullable=True)
    # estimated_rate / estimated_amount stay unmapped: costing is not wired yet.


class ItemSpec(Base):
    """Technical detail for one item. The primary key is item_id, not a surrogate —
    an item has at most one spec row, so the API upserts by item rather than creating.

    `specifications` holds the answers to whatever mst_attribute_mappings says this
    item's category requires, keyed by attribute code.
    """
    __tablename__ = "mst_item_specs"
    item_id = Column(ForeignKey("mst_items.id", ondelete="CASCADE"),
                     primary_key=True, autoincrement=False)
    description = Column(Text, nullable=True)
    brand = Column(String(100), nullable=True)
    model_no = Column(String(100), nullable=True)
    part_no = Column(String(100), nullable=True)
    manufacturer = Column(String(200), nullable=True)
    specifications = Column(JSON, nullable=True)
    storage_conditions = Column(String(300), nullable=True)
    shelf_life_days = Column(Integer, nullable=True)
    image_url = Column(String(500), nullable=True)
