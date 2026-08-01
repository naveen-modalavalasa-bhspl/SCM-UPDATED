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

/** The Department and Position dropdowns on Roles & Access. Every option carries its
 *  headcount, and only options that match somebody are offered. Positions narrow to
 *  the chosen department. */
export interface UserFilters {
  departments: { name: string; count: number }[];
  positions: { id: number; name: string; count: number }[];
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

/** An active office — the "where" of a LOCATION sub-group (district/region). */
export interface Region {
  id: number;
  name: string;
  city?: string | null;
  state?: string | null;
}

export interface PermissionDef {
  id: number;
  code: string;
  module: string;
  resource: string;
  action: string;
  description: string;
}

export interface RoleWithPermissions {
  id: number;
  code: string;
  name: string;
  is_system: boolean;
  is_active: boolean;
  source: "HCM" | "SCM";
  permissions: string[];
}

export interface ReportingNode {
  position_id: number;
  position_name: string;
  role_name?: string | null;
  employees: { id: number; emp_code?: string | null; full_name: string;
               department_name?: string | null; office_name?: string | null }[];
  children?: ReportingNode[];
  direct_count?: number;
  team_size?: number;
}

export interface Reporting {
  employee: { id: number; emp_code?: string | null; full_name: string;
              department_name?: string | null; office_name?: string | null };
  positions: ReportingNode[];
  managers: ReportingNode[];   // nearest manager first
  team: ReportingNode[];       // direct reports with nested children
  team_size: number;
}

export interface OrgTree {
  roots: ReportingNode[];
}

export interface PermissionHolders {
  permission: { code: string; description: string; module: string };
  roles: {
    id: number;
    name: string;
    source: "HCM" | "SCM";
    employees: { id: number; emp_code?: string | null; full_name: string;
                 department_name?: string | null }[];
  }[];
  total_employees: number;
}

export interface ViewAs {
  employee: { id: number; emp_code?: string | null; full_name: string;
              department_name?: string | null };
  position?: { id: number; name: string } | null;
  roles: { id: number; code: string; name: string; source: "HCM" | "SCM" }[];
  permissions: string[];
  menu: { code: string; name: string; path: string;
          children?: { code: string; name: string; path: string }[] }[];
}

export interface SetPermissionsResult {
  success: boolean;
  role_id: number;
  granted: string[];
  revoked: string[];
  permission_codes: string[];
}

