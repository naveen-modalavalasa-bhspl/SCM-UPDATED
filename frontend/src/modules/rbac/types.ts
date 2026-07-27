export interface AdminUserRow {
  employee_id: number;
  emp_code?: string | null;
  full_name: string;
  email?: string | null;
  department_name?: string | null;
  has_access: boolean;
  locked: boolean;
  last_login_at?: string | null;
  roles: {
    id: number;
    code: string;
    name: string;
    source: "HCM" | "SCM";
    assignable: boolean;
  }[];
  positions: { id: number; name: string }[];
}

export interface AccessSummary {
  active_employees: number;
  users_with_access: number;
  active_roles: number;
}

export interface PageAccessMatrix {
  pages: {
    code: string;
    name: string;
    module?: string | null;
    always_on: boolean;
    required_permission?: string | null;
  }[];
  roles: {
    id: number;
    code: string;
    name: string;
    source: "HCM" | "SCM";
    page_codes: string[];
  }[];
}

export interface FeatureAccessMatrix {
  features: {
    code: string;
    module: string;
    description: string;
  }[];
  roles: {
    id: number;
    code: string;
    name: string;
    source: "HCM" | "SCM";
    permission_codes: string[];
  }[];
}

/** Returned once, on grant or reset. The password is never readable again. */
export interface GrantResult {
  success: boolean;
  employee_id: number;
  temporary_password?: string | null;
}

export type GroupType = "ROLE" | "HCM_ROLE" | "POSITION" | "LOCATION";

export interface UserGroup {
  id: number;
  code: string;
  name: string;
  description?: string | null;
  parent_id?: number | null;
  group_type: GroupType;
  role_id?: number | null;
  position_id?: number | null;
  location_id?: number | null;
  is_active: boolean;
}

export interface GroupMember {
  id: number;
  emp_code?: string | null;
  full_name: string;
  email?: string | null;
  department_name?: string | null;
}

