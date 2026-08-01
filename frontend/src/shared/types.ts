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
  };
  roles: string[];
  positions: {
    id: number; name: string; department_id?: number | null;
    department_name?: string | null; office_id?: number | null;
    office_name?: string | null; is_primary: boolean;
  }[];
  active_position?: {
    id: number; name: string; department_id?: number | null;
    department_name?: string | null; office_id?: number | null;
    office_name?: string | null; is_primary: boolean;
  } | null;
  permissions: string[];
  menu: MenuItem[];
}

export interface Option {
  id: number;
  name: string;
  code?: string;
  uom_code?: string | null;
}
