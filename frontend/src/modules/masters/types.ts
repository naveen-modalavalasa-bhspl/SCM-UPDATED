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

/** factor = how many `to_uom` fit in one `from_uom`. BOX -> PCS, factor 12. */
export interface MasterUomConversion {
  id: number;
  from_uom_id: number;
  from_uom_code?: string | null;
  to_uom_id: number;
  to_uom_code?: string | null;
  factor: number;
  is_active: boolean;
}

export type LocationType = "SITE" | "WAREHOUSE" | "ZONE" | "BIN";

export interface MasterLocation {
  id: number;
  code: string;
  name: string;
  location_type: LocationType;
  parent_id?: number | null;
  parent_name?: string | null;
  hcm_facility_id?: number | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  is_stock_point: boolean;
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
