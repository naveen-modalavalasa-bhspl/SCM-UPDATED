export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

export interface MenuItem {
  code: string;
  path: string;
  name: string;
  icon?: string | null;
  module?: string | null;
  children: MenuItem[];
}

export interface Me {
  employee: {
    id: number; name: string; code?: string | null; email?: string | null;
    office_id?: number | null; office_name?: string | null;
    /** Service area code of the office. Absent for offices HCM has none for. */
    office_sac?: string | null;
  };
  roles: string[];
  positions: {
    id: number; name: string; department_id?: number | null;
    department_name?: string | null; office_id?: number | null;
    office_name?: string | null; office_sac?: string | null; is_primary: boolean;
  }[];
  active_position?: {
    id: number; name: string; department_id?: number | null;
    department_name?: string | null; office_id?: number | null;
    office_name?: string | null; office_sac?: string | null; is_primary: boolean;
  } | null;
  permissions: string[];
  menu: MenuItem[];
  /** What this login calls the warehouse module: "MDP", "LIP" or "Warehouse". */
  warehouse_label?: string;
  /** Every page path that exists, granted or not. Lets the route guard tell an
   *  ungranted page from a detail screen that has no rbac_pages row at all. */
  page_paths?: string[];
  /** The company this ERP belongs to, from Settings. Served on /me because
   *  /api/settings needs the permission to EDIT settings, which a buyer filling in
   *  an RFQ does not hold. */
  company_name?: string;
}

export interface Option {
  id: number;
  name: string;
  code?: string;
  uom_code?: string | null;
}
