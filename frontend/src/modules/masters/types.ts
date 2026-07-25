export interface MasterItem {
  id: number;
  code: string;
  name: string;
  short_name?: string | null;
  uom_id?: number | null;
  uom_code?: string | null;
  category_id?: number | null;
  category_name?: string | null;
  item_type?: string | null;
  hsn_code?: string | null;
  tax_percent?: number | null;
  is_batch_tracked?: boolean;
  is_serial_tracked?: boolean;
  is_active: boolean;
}

export interface MasterCategory {
  id: number;
  code: string;
  name: string;
  parent_id?: number | null;
  path?: string | null;
  level?: number | null;
  is_active: boolean;
}

export interface MasterVendor {
  id: number;
  code: string;
  name: string;
  contact_person?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  state?: string | null;
  gstin?: string | null;
  is_active: boolean;
}

export interface MasterUom {
  id: number;
  code: string;
  name: string;
  is_active: boolean;
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

export type WarehouseType = "MAIN" | "TRANSIT" | "QUARANTINE" | "SCRAP";
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

export interface MasterRole {
  id: number;
  code: string;
  name: string;
  description?: string | null;
  is_system: boolean;
  is_active: boolean;
}

export type ResetPolicy = "NEVER" | "YEARLY" | "MONTHLY";

export interface DocSeries {
  id: number;
  doc_type: string;
  fiscal_year: string;
  prefix: string;
  pattern: string;
  last_number: number;
  reset_policy: ResetPolicy;
  last_reset_period?: string | null;
  is_active: boolean;
  /** Server-rendered example of the next number, so the pattern is checkable. */
  preview: string;
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
  manufacturer?: string | null;
  description?: string | null;
  is_active: boolean;
}

export interface MasterItemClass {
  id: number;
  code: string;
  name: string;
  description?: string | null;
  /** Assets, not consumed when issued. */
  is_capitalised: boolean;
  is_active: boolean;
}

export interface MasterPackaging {
  id: number;
  code: string;
  name: string;
  uom_id?: number | null;
  uom_code?: string | null;
  qty_per_pack?: number | null;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  weight_kg?: number | null;
  is_returnable: boolean;
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

export interface MasterAttribute {
  id: number;
  code: string;
  name: string;
  data_type: AttributeDataType;
  unit?: string | null;
  /** Only used when data_type is LIST. */
  allowed_values: string[];
  description?: string | null;
  is_active: boolean;
}

export type AttributeTarget = "CATEGORY" | "ITEM_CLASS";

/** Says which attributes items of a kind must carry. The values live on the spec. */
export interface MasterAttributeMapping {
  id: number;
  attribute_id: number;
  attribute_code?: string | null;
  attribute_name?: string | null;
  target_type: AttributeTarget;
  target_id: number;
  target_name?: string | null;
  is_required: boolean;
  sort_order: number;
  is_active: boolean;
}

export type PriceType = "PURCHASE" | "SALE" | "TRANSFER";

export interface MasterPriceList {
  id: number;
  code: string;
  name: string;
  price_type: PriceType;
  currency: string;
  vendor_id?: number | null;
  vendor_name?: string | null;
  project_id?: number | null;
  project_name?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  description?: string | null;
  is_active: boolean;
}

export interface MasterPriceListItem {
  id: number;
  price_list_id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_id?: number | null;
  uom_code?: string | null;
  rate: number;
  /** Slab pricing: this rate applies from this quantity upwards. */
  min_qty: number;
  discount_percent: number;
  is_active: boolean;
}

export type BomType = "GENERAL" | "KIT" | "ASSEMBLY" | "VEHICLE";

export interface MasterBom {
  id: number;
  code: string;
  name: string;
  bom_type: BomType;
  parent_item_id?: number | null;
  parent_item_code?: string | null;
  parent_item_name?: string | null;
  output_qty: number;
  project_id?: number | null;
  project_name?: string | null;
  department_id?: number | null;
  department_name?: string | null;
  description?: string | null;
  total_items: number;
  is_default: boolean;
  effective_from?: string | null;
  effective_to?: string | null;
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
  scrap_percent: number;
  child_bom_id?: number | null;
  is_optional: boolean;
  remarks?: string | null;
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
