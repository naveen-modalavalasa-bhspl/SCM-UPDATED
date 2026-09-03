"""mst_ tables — SCM's own master data. Owned by shared/."""
from sqlalchemy import (
    JSON, Boolean, Column, Date, ForeignKey, Index, Integer, Numeric, String,
    Text, UniqueConstraint, func, select,
)
from sqlalchemy.orm import column_property, relationship

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
    uom_class = Column(String(30), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)


class HsnCode(Base):
    """An HSN/SAC code and the GST rates that go with it.

    Tax is a property of the classification, not of the item: hundreds of items share
    one HSN, and a rate change is a government notification, not an item edit. So the
    rates live here and documents read them at PO/GRN time rather than copying them
    onto mst_items, where a change would mean rewriting every affected row.
    """
    __tablename__ = "mst_hsn_codes"
    id = pk()
    code = Column(String(20), unique=True, nullable=False)
    description = Column(String(300), nullable=True)
    cgst_rate = Column(Numeric(6, 3), nullable=False, default=0)
    sgst_rate = Column(Numeric(6, 3), nullable=False, default=0)
    igst_rate = Column(Numeric(6, 3), nullable=False, default=0)
    cess_rate = Column(Numeric(6, 3), nullable=False, default=0)
    effective_from = Column(Date, nullable=True)
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
    # Same shape and same rules as Brand.manufacturers below: eager because a lazy
    # load on an async session raises, and save-update only so an unticked brand is
    # deactivated rather than deleted.
    brands = relationship(
        "BrandGeneralName", lazy="selectin", cascade="save-update, merge",
        primaryjoin="GeneralName.id == BrandGeneralName.general_name_id",
    )


class BrandGeneralName(Base):
    """Which brands sell a given general name. Mirrors mst_brand_manufacturers: the
    item form narrows Brand by the chosen General Name, exactly as it narrows
    Manufacturer by the chosen Brand."""
    __tablename__ = "mst_brand_general_names"
    id = pk()
    general_name_id = Column(ForeignKey("mst_general_names.id"), index=True,
                             nullable=False)
    general_name_code = Column(String(10), nullable=True)
    general_name_name = Column(String(200), nullable=True)
    brand_id = Column(ForeignKey("mst_brands.id"), index=True, nullable=False)
    brand_code = Column(String(10), nullable=True)
    brand_name = Column(String(200), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    __table_args__ = (
        UniqueConstraint("general_name_id", "brand_id",
                         name="uq_general_name_brand"),
    )


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
    description = Column(String(300), nullable=True)
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
    hsn_code = Column(String(20), nullable=True)          # snapshot of mst_hsn_codes.code
    hsn_id = Column(ForeignKey("mst_hsn_codes.id"), index=True, nullable=True)
    # Assets are not consumed on issue. The asset or consumable code itself is
    # generated during putaway in the warehouse module, never here.
    is_asset = Column(Boolean, nullable=False, default=False)
    # The 4-digit tail of `code`, counted per L1L2L3-GEN-BRAND-MFR prefix. Stored so
    # the serial can be read without re-parsing the code string.
    serial_no = Column(Integer, nullable=True)
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
    is_imei_tracked = Column(Boolean, nullable=False, default=False)
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

    # NO dimensions and no unit volume live here, on purpose. An item is measured at
    # the packaging level it physically moves in — see mst_item_packaging — because a
    # bin holds boxes, not a puddle of cubic metres: 500 SIM cards are ten rigid boxes
    # on a pallet, and `qty x volume_per_each` reports that pallet as nearly empty.

    is_active = Column(Boolean, nullable=False, default=True)
    created_at = created_at_col()
    updated_at = updated_at_col()


# Plain index on name for search. (Guide's Postgres gin/to_tsvector is not portable
# to MySQL/SQLite; search uses LIKE on this index. See root CLAUDE.md deviations.)
Index("ix_mst_items_name", Item.name)
Index("ix_mst_items_is_active", Item.is_active)


class Vendor(Base):
    """Every column the live table has. The three NOT-NULL ones with DB defaults
    (vendor_type, is_approved, is_blacklisted) are mapped WITH the same default
    repeated — that is what makes mapping them safe. Mapping a NOT-NULL column and
    leaving it unset sends an explicit NULL that overrides the DB default; repeating
    the default here means an insert that says nothing still sends the right value."""
    __tablename__ = "mst_vendors"
    id = pk()
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(200), nullable=False, index=True)
    vendor_type = Column(String(30), nullable=False, default="MATERIAL")
    contact_person = Column(String(150), nullable=True)
    phone = Column(String(30), nullable=True)
    email = Column(String(200), nullable=True)
    address = Column(String(500), nullable=True)
    city = Column(String(100), nullable=True)
    state = Column(String(100), nullable=True)
    pincode = Column(String(10), nullable=True)
    gstin = Column(String(20), nullable=True)
    pan = Column(String(20), nullable=True)
    payment_terms_days = Column(Integer, nullable=True)
    credit_limit = Column(Numeric(16, 2), nullable=True)
    rating = Column(Numeric(4, 2), nullable=True)
    is_approved = Column(Boolean, nullable=False, default=False)
    is_blacklisted = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True, index=True)
    created_at = created_at_col()
    updated_at = updated_at_col()


class VendorItem(Base):
    """What a vendor charges for an item and how long they take to supply it. The
    live table has carried rows since before there was a screen for it; procurement
    reads this to price a PO and to pick a preferred supplier."""
    __tablename__ = "mst_vendor_items"
    id = pk()
    vendor_id = Column(ForeignKey("mst_vendors.id", ondelete="CASCADE"), index=True, nullable=False)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    # Snapshots, so the list renders without joining the item master.
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    # The vendor's own part number for the item — what appears on their invoice.
    vendor_item_code = Column(String(50), nullable=True)
    last_rate = Column(Numeric(16, 4), nullable=True)
    lead_time_days = Column(Integer, nullable=True)
    min_order_qty = Column(Numeric(16, 3), nullable=True)
    is_preferred = Column(Boolean, nullable=False, default=False)
    # The table carries no vendor snapshot, and the list has to show a vendor name on
    # every row. Eager (selectin): a lazy load on an async session raises rather than
    # emitting SQL.
    vendor = relationship("Vendor", lazy="selectin")


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
    # The table has no code snapshot columns, but a caller reading "BOX -> PCS" should
    # not have to fetch two more masters to render one row. Loaded eagerly (selectin)
    # because a lazy load on an async session raises rather than emitting SQL.
    from_uom = relationship("Uom", foreign_keys=[from_uom_id], lazy="selectin")
    to_uom = relationship("Uom", foreign_keys=[to_uom_id], lazy="selectin")


class Brand(Base):
    """Manufacturer brand. Until now a brand was free text on mst_item_specs.brand,
    so the same brand appeared under several spellings. This makes it a real row."""
    __tablename__ = "mst_brands"
    id = pk()
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(200), nullable=False)
    # Superseded by the mst_brand_manufacturers rows below, which let one brand carry
    # several manufacturers. Left mapped only because the live table still has it.
    manufacturer = Column(String(200), nullable=True)
    description = Column(String(300), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    # Eager (selectin): a lazy load on an async session raises rather than emitting
    # SQL, and the brand list has to render its manufacturers without a second query.
    # save-update only, never a delete cascade: an unticked manufacturer is
    # deactivated, because items already reference the pair and deleting the row
    # would erase the evidence that the pair was once legal.
    manufacturers = relationship(
        "BrandManufacturer", lazy="selectin", cascade="save-update, merge",
        primaryjoin="Brand.id == BrandManufacturer.brand_id",
    )


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
    """A reusable container type — Packet, Box, Tote, Euro-pallet — and its physical
    spec.

    The spec is the container's OWN: its outer bounding box empty, its tare weight, and
    the handling rules that follow from its construction (can it be stacked, how many
    high, may it be turned to fit). None of that depends on what is inside it, which is
    why it belongs here and is configured once.

    What DOES depend on the contents — how many base units one holds, and what it
    weighs full — lives on each item's own rung in `mst_item_packaging`, because the
    same box holds 50 SIM cards or 4 litres of oil.

    A rung may override the three dimensions where an item genuinely packs differently
    in the same container type; blank there means "whatever the container type says",
    which is the ordinary case.
    """
    __tablename__ = "mst_packaging"
    id = pk()
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(200), nullable=False)
    uom_id = Column(ForeignKey("mst_uom.id"), index=True, nullable=True)
    uom_code = Column(String(20), nullable=True)          # snapshot
    qty_per_pack = Column(Numeric(16, 3), nullable=True)

    # The OUTER bounding box of the empty container, in centimetres. All three or
    # none — two sides describe nothing a slotting check can use.
    length_cm = Column(Numeric(10, 2), nullable=True)
    width_cm = Column(Numeric(10, 2), nullable=True)
    height_cm = Column(Numeric(10, 2), nullable=True)
    # TARE: what the container weighs empty. Gross weight is on the item's rung.
    weight_kg = Column(Numeric(12, 3), nullable=True)

    # Handling rules. `max_stack_tiers` of 1 means non-stackable; NULL means nobody has
    # said, which the capacity check treats as "unknown", never as "unlimited".
    is_stackable = Column(Boolean, nullable=True)
    max_stack_tiers = Column(Integer, nullable=True)
    # May the container be turned to make it fit? A drum may not; a carton may.
    is_rotatable = Column(Boolean, nullable=True)
    # Void factor — the share of the container's own cube that goods actually reach.
    # Loose parts in a rigid tote settle at 70-80%, and pretending otherwise overstates
    # every bin in the building.
    fill_efficiency_pct = Column(Numeric(5, 2), nullable=True)

    is_returnable = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True)


class ItemPackaging(Base):
    """One rung of an item's packing ladder — a PACKAGING UNIT in the WMS sense.

    Level 1 is the smallest pack and its quantity is in the item's own UOM: a tray
    holds 10 litres. Every level above counts the level below it, so level 2 is 10
    trays and level 3 is 10 boxes. Only the rung is stored; the running totals (100
    litres, 1000 litres) are multiplied up on read, so a stored total can never
    disagree with its own parts.

    `quantity` is the conversion factor. The rest of what a WMS needs from a packaging
    unit is here too:

    - the three dimensions, as an OVERRIDE of the container type's own box. Blank —
      the ordinary case — means the container type's, so a ladder is cheap to set up
      and only the exceptions are typed.
    - `gross_weight_kg`, what ONE of these weighs full. Item-specific by definition,
      which is exactly why it cannot live on `mst_packaging`.
    - `is_default_putaway_unit`: the rung putaway and bin occupancy work in unless the
      document says otherwise. At most one per item.

    Volume is never stored. It is L x W x H on read, for the same reason the running
    totals are: a stored cube is one edit away from disagreeing with its own sides.
    """
    __tablename__ = "mst_item_packaging"
    id = pk()
    item_id = Column(ForeignKey("mst_items.id", ondelete="CASCADE"), index=True,
                     nullable=False)
    level = Column(Integer, nullable=False, default=1)
    package_id = Column(ForeignKey("mst_packaging.id"), index=True, nullable=False)
    package_name = Column(String(200), nullable=True)     # snapshot
    quantity = Column(Numeric(16, 3), nullable=False, default=1)
    uom_id = Column(ForeignKey("mst_uom.id"), index=True, nullable=True)
    uom_code = Column(String(20), nullable=True)          # snapshot

    length_cm = Column(Numeric(10, 2), nullable=True)
    width_cm = Column(Numeric(10, 2), nullable=True)
    height_cm = Column(Numeric(10, 2), nullable=True)
    gross_weight_kg = Column(Numeric(12, 3), nullable=True)
    max_stack_tiers = Column(Integer, nullable=True)
    is_default_putaway_unit = Column(Boolean, nullable=False, default=False)

    is_active = Column(Boolean, nullable=False, default=True)
    __table_args__ = (
        UniqueConstraint("item_id", "level", name="uq_item_packaging_level"),
    )


class ItemComponent(Base):
    """One component of a kit. A first-aid kit is an item; its bandages and swabs
    are these rows.

    The component is a real item rather than typed text, so the contents can be
    issued and stock-checked instead of only printed.
    """
    __tablename__ = "mst_item_components"
    id = pk()
    item_id = Column(ForeignKey("mst_items.id", ondelete="CASCADE"), index=True,
                     nullable=False)
    line_no = Column(Integer, nullable=False, default=1)
    component_item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    component_code = Column(String(50), nullable=True)    # snapshot
    component_name = Column(String(300), nullable=True)   # snapshot
    quantity = Column(Numeric(16, 3), nullable=False, default=1)
    uom_id = Column(ForeignKey("mst_uom.id"), index=True, nullable=True)
    uom_code = Column(String(20), nullable=True)          # snapshot
    remarks = Column(String(500), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)


class Spec(Base):
    """A technical measurement an item can be given: "Operating voltage", in volts.

    Distinct from an Attribute, which is a selectable trait with a value list. A spec
    always measures something, so its UOM is the point of it.
    """
    __tablename__ = "mst_specs"
    id = pk()
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(200), nullable=False)
    uom_id = Column(ForeignKey("mst_uom.id"), index=True, nullable=True)
    uom_code = Column(String(20), nullable=True)          # snapshot
    description = Column(String(300), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)


class CategoryTag(Base):
    """What a category expects its items to carry: attributes, specs and features.

    One table for all three. They differ in what they mean but not in what a tag
    records — which category, which thing, and whether it is required — so three
    tables would have been the same three columns written out three times.
    """
    __tablename__ = "mst_category_tags"
    id = pk()
    category_id = Column(ForeignKey("mst_item_categories.id", ondelete="CASCADE"),
                         index=True, nullable=False)
    category_name = Column(String(200), nullable=True)    # snapshot
    tag_type = Column(String(20), nullable=False)         # CategoryTagType
    # Soft reference: the target table depends on tag_type, so it cannot be a FK.
    tag_id = Column(BigIntPortable, index=True, nullable=False)
    tag_code = Column(String(50), nullable=True)          # snapshot
    tag_name = Column(String(200), nullable=True)         # snapshot
    tag_uom_code = Column(String(20), nullable=True)      # snapshot, specs only
    is_required = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True)
    __table_args__ = (
        UniqueConstraint("category_id", "tag_type", "tag_id",
                         name="uq_category_tag"),
    )


class ItemGroup(Base):
    """An item made available to a user group.

    Groups are defined by role or position in rbac_user_groups, so tagging an item
    to one decides who may request it. `group_id` is a soft FK: shared must not
    depend on platform, which is where rbac_ lives (rule 5).
    """
    __tablename__ = "mst_item_groups"
    id = pk()
    item_id = Column(ForeignKey("mst_items.id", ondelete="CASCADE"), index=True,
                     nullable=False)
    item_code = Column(String(50), nullable=True)         # snapshot
    item_name = Column(String(300), nullable=True)        # snapshot
    group_id = soft_fk()
    group_name = Column(String(200), nullable=True)       # snapshot
    is_active = Column(Boolean, nullable=False, default=True)
    __table_args__ = (
        UniqueConstraint("item_id", "group_id", name="uq_item_group"),
    )


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
    # Free text until now, which meant "kg", "Kg" and "kilogram" all appeared. The
    # unit is a real UOM row; `unit` survives only because the live table has it.
    unit = Column(String(30), nullable=True)
    uom_id = Column(ForeignKey("mst_uom.id"), index=True, nullable=True)
    uom_code = Column(String(20), nullable=True)       # snapshot
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


# `mst_boms.total_items` is a stored counter that nothing has ever maintained —
# adding or removing a line never touched it, so every BOM read back as "0 items"
# on both the masters list and the indent's Choose BOM modal. Count the lines
# instead: a correlated subquery on every SELECT cannot drift. The stored column
# stays mapped so inserts keep filling it (its DB default), it is just not read.
Bom.line_count = column_property(
    select(func.count(BomItem.id))
    .where(BomItem.bom_id == Bom.id)
    .correlate_except(BomItem)
    .scalar_subquery(),
)


class BomGroup(Base):
    """A BOM handed to a job profile — "who gets this kit".

    The rung is the RBAC job profile (`platform/rbac/profiles.py`), which is the grant
    unit the rest of the system already reasons in: an HCM role is too coarse (role 29
    "MANAGER" covers fifteen unrelated jobs) and a position is one post in one village.
    A profile has no table of its own — it is derived from the HCM mirror and keyed
    "<project id>:<job>" ("4:DEO") — so `profile_key` is a string, not an FK, and the
    name is snapshotted beside it the way every other master snapshots its parent.

    One row is one pairing. A profile may hold several BOMs and a BOM may be given to
    several profiles; the unique constraint only stops the same pairing twice.
    """
    __tablename__ = "mst_bom_groups"
    id = pk()
    bom_id = Column(ForeignKey("mst_boms.id", ondelete="CASCADE"), index=True,
                    nullable=False)
    bom_code = Column(String(50), nullable=True)          # snapshot
    bom_name = Column(String(200), nullable=True)         # snapshot
    profile_key = Column(String(150), index=True, nullable=False)
    profile_job = Column(String(150), nullable=True)      # snapshot
    profile_name = Column(String(200), nullable=True)     # snapshot
    # The profile's own project, copied off the key so the list can be read, FILTERED
    # AND SCOPED without re-deriving 4,000 positions. This column is what
    # `scope_by_project` narrows on, so it is the row's security boundary too.
    project_id = Column(BigIntPortable, index=True, nullable=True)
    project_name = Column(String(200), nullable=True)     # snapshot
    remarks = Column(String(500), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    # Optional validity window, the same pair mst_boms carries. Both ends are
    # nullable: a pairing with neither date stands until someone switches it off.
    effective_from = Column(Date, nullable=True)
    effective_to = Column(Date, nullable=True)
    __table_args__ = (
        UniqueConstraint("bom_id", "profile_key", name="uq_bom_group"),
    )


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


class ItemEligibility(Base):
    """`mst_item_eligibility` — which items a person may raise an indent for.

    ONE row per (item, scope). An item tagged to nothing is available to EVERYONE;
    an item with any row at all is available only to a requester who matches one of
    them. That default is deliberate and matches how the rest of masters behaves —
    `mst_brand_general_names` falls back to every brand for an unmapped general name
    for exactly the same reason: the mapping starts empty, and reading an empty
    mapping as "deny" would stop every indent in the company the moment this shipped.

    Two kinds of scope, because the business asks the question both ways:

      ROLE    the requester's RBAC role (`rbac_roles.id`) — a Driver may raise fuel
              and consumables, not laboratory reagents.
      REGION  the requester's location (`hcm_employees.office_id`, which is what
              `indents.service` already stamps on `ind_indents.region_id`) — a
              district stocks what that district actually runs.

    A requester matching EITHER passes. They are alternatives, not both-required:
    tagging an item to two regions and one role would otherwise be unsatisfiable.
    """
    __tablename__ = "mst_item_eligibility"
    id = pk()
    item_id = Column(ForeignKey("mst_items.id", ondelete="CASCADE"),
                     index=True, nullable=False)
    item_code = Column(String(50), nullable=True)      # snapshot, for the register
    item_name = Column(String(300), nullable=True)     # snapshot
    #: "ROLE" or "REGION" — see `shared.enums.ItemScope`.
    scope_type = Column(String(20), nullable=False, index=True)
    #: `rbac_roles.id` for ROLE, `hcm_offices.id` for REGION. Soft: the two id spaces
    #: are different tables, so no single FK can express it.
    scope_id = Column(BigIntPortable, nullable=False, index=True)
    scope_name = Column(String(200), nullable=True)    # snapshot, so the row reads
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = created_at_col()
    updated_at = updated_at_col()


# One tag per item per scope. Checked in Python as well (see `indents.eligibility`),
# because MySQL counts NULLs as distinct and this index cannot express the intent on
# its own if a column ever becomes nullable.
Index("uq_item_eligibility", ItemEligibility.item_id,
      ItemEligibility.scope_type, ItemEligibility.scope_id, unique=True)
