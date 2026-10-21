export interface MasterItem {
  id: number;
  /** The latest photo, for the list's thumbnail. Null when there is none. */
  photo_id?: number | null;
  /** L1L2L3-GEN-0001. Assigned once at create, never regenerated. */
  code: string;
  serial_no?: number | null;
  name: string;
  short_name?: string | null;
  uom_id?: number | null;
  uom_code?: string | null;
  category_id?: number | null;
  category_name?: string | null;
  general_name_id?: number | null;
  general_name_code?: string | null;
  general_name?: string | null;
  brand_id?: number | null;
  brand_code?: string | null;
  brand_name?: string | null;
  manufacturer_id?: number | null;
  manufacturer_code?: string | null;
  manufacturer_name?: string | null;
  item_class_id?: number | null;
  item_class_code?: string | null;
  item_class_name?: string | null;
  item_sub_class_id?: number | null;
  item_sub_class_code?: string | null;
  item_sub_class_name?: string | null;
  /** HCM department responsible for item-related work and ticket routing. */
  owner_department_id?: number | null;
  owner_department_name?: string | null;
  item_type?: string | null;
  hsn_id?: number | null;
  hsn_code?: string | null;
  /** Asset or consumable. The code itself is generated at putaway, in warehouse. */
  is_asset: boolean;
  description?: string | null;
  has_components: boolean;
  barcode_type?: string | null;
  barcode_value?: string | null;
  is_batch_tracked?: boolean;
  is_serial_tracked?: boolean;
  is_imei_tracked?: boolean;
  has_expiry: boolean;
  requires_qi: boolean;
  dosage_form_id?: number | null;
  dosage_form_code?: string | null;
  dosage_form_name?: string | null;
  valuation_method: string;
  requires_special_storage: boolean;
  storage_conditions?: string | null;
  requires_special_transport: boolean;
  transport_conditions?: string | null;
  // No dimensions and no unit volume here, on purpose. How much room the goods take is
  // a property of the PACK they move in — see MasterItemPackaging — because a bin holds
  // boxes, not a puddle of cubic metres.
  is_active: boolean;
}

export interface MasterCategory {
  id: number;
  code: string;
  name: string;
  parent_id?: number | null;
  path?: string | null;
  level?: number | null;
  segment_code?: string | null;
  is_active: boolean;
}

export interface NamedMaster {
  id: number;
  code: string;
  name: string;
  description?: string | null;
  is_active: boolean;
}

/** A UOM type. `allows_decimal` off → every unit of the type is whole-only on documents. */
export interface MasterUomClass extends NamedMaster {
  allows_decimal: boolean;
}

export interface MasterBrandManufacturer {
  id: number;
  brand_id: number;
  brand_code?: string | null;
  brand_name?: string | null;
  manufacturer_id: number;
  manufacturer_code?: string | null;
  manufacturer_name?: string | null;
  is_active: boolean;
}

/** A brand-to-item mapping: which brands are associated with an item. */
export interface MasterBrandItemMapping {
  id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  brand_id: number;
  brand_code?: string | null;
  brand_name?: string | null;
  /** Manufacturer comes from the brand's own manufacturer list. */
  manufacturer_names?: string[] | null;
  is_preferred?: boolean;
  is_active: boolean;
}

/** Sources for the Brand Item Mapping panel — analogous to VendorMappingSources. */
export interface BrandItemMappingSources {
  brands: { id: number; code: string; name: string; manufacturer_names: string[] }[];
  categories: { id: number; code: string; name: string; level: number | null;
                parent_id: number | null; path: string | null }[];
  items: { id: number; code: string; name: string; category_id: number }[];
  /** [brand_id, item_id] pairs that are already mapped. */
  mapped: [number, number][];
}

export interface MasterItemSubClass extends NamedMaster {
  item_class_id: number;
  item_class_code?: string | null;
  item_class_name?: string | null;
}

export interface MasterPaymentTerm {
  id: number; code: string; name: string; description: string | null; is_active: boolean;
  advance_pct: number; advance_days: number; delivery_pct: number; delivery_days: number;
  installation_pct: number; installation_days: number;
  warranty_pct: number; warranty_days: number;
  /** "30,60,90": the delivery share in equal instalments. */
  delivery_schedule: string | null;
}

export interface MasterVendorCategory {
  id: number; code: string; name: string; description: string | null;
  is_active: boolean; vendor_ids: number[];
}

export interface MasterVendor {
  id: number;
  /** The vendor categories it is tagged to. */
  category_ids?: number[];
  code: string;
  name: string;
  vendor_type?: string | null;
  contact_person?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  gstin?: string | null;
  pan?: string | null;
  payment_terms_days?: number | null;
  credit_limit?: number | null;
  rating?: number | null;
  is_approved?: boolean;
  is_blacklisted?: boolean;
  is_active: boolean;
}

/** What a vendor charges for an item and how long they take. The live table has
 *  carried these rows since before there was a screen for them. */
export interface MasterVendorItem {
  id: number;
  vendor_id: number;
  item_id: number;
  vendor_name?: string | null;
  vendor_code?: string | null;
  item_code?: string | null;
  item_name?: string | null;
  vendor_item_code?: string | null;
  last_rate?: number | null;
  lead_time_days?: number | null;
  min_order_qty?: number | null;
  is_preferred: boolean;
}

export type UomClass =
  | "COUNT" | "LENGTH" | "AREA" | "VOLUME" | "WEIGHT"
  | "TEMPERATURE" | "TIME" | "PRESSURE" | "ENERGY" | "PACKAGING";

export interface MasterUom {
  id: number;
  code: string;
  name: string;
  /** What the unit measures. Required: a conversion across classes is meaningless,
   *  and the item form offers only the units of the class being measured. */
  uom_class: UomClass;
  is_active: boolean;
}

/** A standard unit the backend knows about, and whether it has been created yet. */
export interface UomSuggestion {
  code: string;
  name: string;
  exists: boolean;
}

/**
 * factor = how many `to_uom` fit in one `from_uom`. BOX -> PCS, factor 12.
 * The live mst_uom_conversions table has no is_active column, so neither does this.
 */
export interface MasterUomConversion {
  id: number;
  from_uom_id: number;
  to_uom_id: number;
  factor: number;
}

export type WarehouseType = "MAIN" | "LIP" | "MDP" | "TRANSIT" | "QUARANTINE" | "SCRAP";
export type BinType = "ZONE" | "RACK" | "SHELF" | "STORAGE" | "STAGING";

/** whs_warehouses — the location master. Soft-linked to an HCM facility. */
export interface MasterWarehouse {
  id: number;
  code: string;
  name: string;
  facility_id?: number | null;
  facility_name?: string | null;
  office_id?: number | null;
  office_name?: string | null;
  warehouse_type: WarehouseType;
  address?: string | null;
  incharge_id?: number | null;
  incharge_name?: string | null;
  is_bin_managed: boolean;
  is_active: boolean;
}

/** whs_bins — storage inside a warehouse. `path` and `level` derive from the parent. */
export interface MasterBin {
  id: number;
  warehouse_id: number;
  code: string;
  name?: string | null;
  parent_id?: number | null;
  bin_type: BinType;
  path?: string | null;
  level: number;
  capacity_qty?: number | null;
  is_pickable: boolean;
  is_active: boolean;
}

/** mst_projects — owns stock, never items. */
export interface Project {
  id: number;
  code: string;
  name: string;
  office_id?: number | null;
  office_name?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  is_active: boolean;
}

export interface RefRow {
  id: number;
  code?: string;
  name: string;
  is_stock_location?: boolean;
}

// --------------------------------------------------------------------------- //
//  Brands, classes, packaging, features, attributes, price lists, BOM, specs
// --------------------------------------------------------------------------- //

export interface MasterBrand {
  id: number;
  code: string;
  name: string;
  description?: string | null;
  /** A brand is routinely made by several plants, so its manufacturers are edited
   *  on the brand itself rather than on a mapping screen of their own. */
  manufacturer_ids: number[];
  manufacturer_names: string[];
  is_active: boolean;
}

export interface MasterGeneralName {
  id: number;
  code: string;
  name: string;
  description?: string | null;
  /** The brands that sell this general name. Same call as MasterBrand above: edited
   *  on the general name itself, and read by the item form to narrow Brand. */
  brand_ids: number[];
  brand_names: string[];
  is_active: boolean;
}

export interface MasterItemClass {
  id: number;
  code: string;
  name: string;
  description?: string | null;
  is_active: boolean;
}

/**
 * A kind of container: Tray, Box, Tote, Euro-pallet — and its own physical spec.
 *
 * The spec is the CONTAINER'S: its outer box empty, its tare weight, and the handling
 * rules that follow from how it is built. It says nothing about how much it holds — a
 * tray of milk and a tray of vials differ — so the quantity, and the GROSS weight that
 * depends on it, are properties of the item's own rung in MasterItemPackaging.
 */
export interface MasterPackaging {
  id: number;
  code: string;
  name: string;
  /** The outer bounding box, empty. All three or none. */
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  /** Derived from the sides on the server, never stored. */
  volume_cbm?: number | null;
  /** TARE — what it weighs empty. */
  weight_kg?: number | null;
  is_stackable?: boolean;
  /** 1 means non-stackable. Null means nobody has said, which a capacity check reads
   *  as unknown and never as unlimited. */
  max_stack_tiers?: number | null;
  /** May it be tipped to make it fit? A drum may not; a carton may. */
  is_rotatable?: boolean;
  /** Void factor — the share of its own cube goods actually reach. */
  fill_efficiency_pct?: number | null;
  is_returnable?: boolean;
  is_active: boolean;
}

/**
 * One rung of an item's packing ladder — a PACKAGING UNIT: 10 litres in a tray, 10
 * trays in a box.
 *
 * `quantity` is the conversion factor. The dimensions OVERRIDE the container type's own
 * box and are blank in the ordinary case; `gross_weight_kg` is what one of these weighs
 * full, which is item-specific and so cannot live on the container type.
 */
export interface MasterItemPackaging {
  id: number;
  item_id: number;
  level: number;
  package_id: number;
  package_name?: string | null;
  quantity: number;
  uom_id?: number | null;
  uom_code?: string | null;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  gross_weight_kg?: number | null;
  max_stack_tiers?: number | null;
  /** The rung putaway and bin occupancy work in unless a document says otherwise.
   *  At most one per item — setting one clears the others. */
  is_default_putaway_unit?: boolean;
  is_active: boolean;
}

/** The ladder with its running totals, multiplied up on the server. */
export interface PackagingBreakdown {
  level: number;
  package_id: number;
  package_name?: string | null;
  quantity: number;
  uom_code?: string | null;
  /** One current container expressed as counts of every container below it. */
  package_breakup: Array<{
    package_id: number;
    package_name?: string | null;
    quantity: number;
  }>;
  /** What one of this package holds, in the item's own unit. */
  base_quantity: number;
  base_uom_code?: string | null;
  /** What the warehouse checks a bin against. The rung's own sides where it overrides
   *  them, the container type's otherwise — `dims_from` says which. */
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  volume_cbm?: number | null;
  dims_from?: "RUNG" | "PACKAGE" | null;
  gross_weight_kg?: number | null;
  tare_weight_kg?: number | null;
  max_stack_tiers?: number | null;
  is_default_putaway_unit?: boolean;
}

/** One component of a kit. A real item, so the contents can be issued. */
export interface MasterItemComponent {
  id: number;
  item_id: number;
  line_no: number;
  component_item_id: number;
  component_code?: string | null;
  component_name?: string | null;
  quantity: number;
  uom_id?: number | null;
  uom_code?: string | null;
  remarks?: string | null;
  is_active: boolean;
}

export interface MasterFeature {
  id: number;
  code: string;
  name: string;
  description?: string | null;
  affects_handling: boolean;
  is_active: boolean;
}

export type AttributeDataType = "TEXT" | "NUMBER" | "BOOLEAN" | "DATE" | "LIST";

/** A selectable trait: colour, size, grade. Contrast MasterSpec, a measurement. */
export interface MasterAttribute {
  id: number;
  code: string;
  name: string;
  data_type: AttributeDataType;
  uom_id?: number | null;
  uom_code?: string | null;
  /** Only used when data_type is LIST. */
  allowed_values: string[];
  description?: string | null;
  is_active: boolean;
}

/** A technical measurement: operating voltage in volts. Always carries a UOM. */
export interface MasterSpec {
  id: number;
  code: string;
  name: string;
  uom_id?: number | null;
  uom_code?: string | null;
  description?: string | null;
  is_active: boolean;
}

export type CategoryTagType = "ATTRIBUTE" | "SPEC" | "FEATURE";

/** What a category expects its items to carry. One table for all three kinds:
 *  they differ in meaning but not in what a tag records. */
export interface MasterCategoryTag {
  id: number;
  category_id: number;
  category_name?: string | null;
  tag_type: CategoryTagType;
  tag_id: number;
  tag_code?: string | null;
  tag_name?: string | null;
  /** Specs only — the unit the item form should label the input with. */
  tag_uom_code?: string | null;
  is_required: boolean;
  is_active: boolean;
}

/** An item made available to a user group. Groups are defined by role or position,
 *  so this decides who may request the item. */
export interface MasterItemGroup {
  id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  group_id: number;
  group_name?: string | null;
  is_active: boolean;
}

/**
 * An HSN/SAC code and its GST rates. Tax belongs to the classification, not the
 * item: hundreds of items share one HSN, and a rate change is a notification rather
 * than an item edit. Documents read the rate from here at PO/GRN time.
 */
export interface MasterHsnCode {
  id: number;
  code: string;
  description?: string | null;
  /** The one GST rate: the within-state CGST + SGST and the across-state IGST are the
   *  same number, so a document derives the halves rather than storing them. */
  gst_rate: number;
  effective_from?: string | null;
  is_active: boolean;
}

/** A named, reusable set of items on a project — the standard kit a requester
 *  picks instead of typing the same twelve lines every time. */
export interface MasterBom {
  id: number;
  code: string;
  name: string;
  project_id?: number | null;
  project_name?: string | null;
  description?: string | null;
  total_items: number;
  /** Optional validity window, both ends independent. Blank means no bound that
   *  side, so a BOM with neither date is available all the time. */
  effective_from?: string | null;
  effective_to?: string | null;
  /** Switched on AND inside its window — what a consumer asks before offering it. */
  is_effective?: boolean;
  is_active: boolean;
}

export interface MasterBomItem {
  id: number;
  bom_id: number;
  line_no: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  category_name?: string | null;
  uom_id?: number | null;
  uom_code?: string | null;
  quantity: number;
  remarks?: string | null;
}

/** One BOM handed to one job profile — "who gets this kit". */
export interface MasterBomGroup {
  id: number;
  bom_id: number;
  bom_code?: string | null;
  bom_name?: string | null;
  /** RBAC's derived profile key, e.g. "4:DEO". A job profile has no table. */
  profile_key: string;
  profile_job?: string | null;
  profile_name?: string | null;
  project_id?: number | null;
  project_name?: string | null;
  remarks?: string | null;
  /** Optional validity window — blank ends mean the pairing stands all the time. */
  effective_from?: string | null;
  effective_to?: string | null;
  is_effective?: boolean;
  is_active: boolean;
}

/** A job profile as the BOM-group screen needs it: named, counted, nothing else. */
export interface JobProfileOption {
  key: string;
  role_id?: number | null;
  job: string;
  name: string;
  project_id: number;
  project_name: string;
  position_count: number;
  holder_count: number;
  configured: boolean;
}

/** Keyed by item_id, so it is saved with PUT and never created separately. */
export interface MasterItemSpec {
  item_id: number;
  description?: string | null;
  brand?: string | null;
  model_no?: string | null;
  part_no?: string | null;
  manufacturer?: string | null;
  specifications: Record<string, unknown>;
  storage_conditions?: string | null;
  shelf_life_days?: number | null;
  image_url?: string | null;
}

/** One item-eligibility tag: this item, for this role or this region.
 *
 *  An item with NO tags is requestable by everyone — only a tagged item is ever
 *  narrowed. See `backend/app/modules/indents/eligibility.py`. */
export interface MasterItemEligibility {
  id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  scope_type: "ROLE" | "REGION";
  scope_id: number;
  scope_name?: string | null;
  is_active: boolean;
}

export interface ItemEligibilityScopes {
  /** `code` tells three identically-named "Store Keeper" rows apart, and `holders`
   *  says how many people actually hold the role — a tag on a 0-holder role restricts
   *  the item to nobody, which is how the whole catalogue once ended up invisible. */
  projects: { id: number; name: string }[];
  roles: { id: number; name: string; code?: string; holders?: number;
           project_id?: number | null; project_name?: string | null }[];
  regions: { id: number; name: string }[];
}
