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
