import { api } from "@/shared/api/client";
import type { Paginated } from "@/shared/types";
import type {
  AccessSummary, AdminUserRow, FeatureAccessMatrix, GrantResult, GroupMember,
  OrgTree, PageAccessMatrix, PermissionDef, PermissionHolders, Region,
  Reporting, RoleWithPermissions, SetPermissionsResult, UserGroup, ViewAs,
} from "./types";

type ListParams = { search?: string; page?: number; size?: number };
const page = <T>(url: string, params: Record<string, unknown> = {}) =>
  api.get<Paginated<T>>(url, { params }).then((response) => response.data);
const all = <T>(url: string) =>
  api.get<{ items: T[] }>(url).then((response) => response.data.items);

export const rbacApi = {
  users: {
    // Served by the RBAC module (supports role_id filtering + pagination); the
    // grant/revoke/reset/setRoles actions below stay on the admin endpoints.
    list: (params: ListParams & { with_access?: boolean; role_id?: number }) =>
      page<AdminUserRow>("/api/rbac/users", params),
    summary: () =>
      api.get<AccessSummary>("/api/admin/users/summary").then((response) => response.data),
    grant: (body: { employee_id: number; role_ids: number[]; password?: string | null }) =>
      api.post<GrantResult>("/api/admin/users/grant", body).then((response) => response.data),
    revoke: (employeeId: number) =>
      api.delete(`/api/admin/users/${employeeId}/access`).then((response) => response.data),
    resetPassword: (employeeId: number) =>
      api.post<GrantResult>(`/api/admin/users/${employeeId}/reset-password`)
        .then((response) => response.data),
    setRoles: (employeeId: number, roleIds: number[]) =>
      api.put(`/api/admin/users/${employeeId}/roles`, { role_ids: roleIds })
        .then((response) => response.data),
  },
  groups: {
    // RBAC-owned endpoints. A LOCATION sub-group's location_id is an hcm_offices id
    // (a district/region), picked from regions() below.
    list: (params: ListParams = {}) => page<UserGroup>("/api/rbac/groups", params),
    create: (body: Partial<UserGroup>) =>
      api.post<UserGroup>("/api/rbac/groups", body).then((response) => response.data),
    update: (id: number, body: Partial<UserGroup>) =>
      api.put<UserGroup>(`/api/rbac/groups/${id}`, body).then((response) => response.data),
    deactivate: (id: number) =>
      api.delete(`/api/rbac/groups/${id}`).then((response) => response.data),
    members: (id: number) => all<GroupMember>(`/api/rbac/groups/${id}/members`),
    addMember: (id: number, employeeId: number) =>
      api.post(`/api/rbac/groups/${id}/members/${employeeId}`).then((response) => response.data),
    removeMember: (id: number, employeeId: number) =>
      api.delete(`/api/rbac/groups/${id}/members/${employeeId}`).then((response) => response.data),
    regions: () => all<Region>("/api/rbac/regions"),
  },
  roles: () => all<{
    id: number;
    code: string;
    name: string;
    is_active: boolean;
    source: "HCM" | "SCM";
    assignable: boolean;
  }>("/api/admin/roles"),

  reporting: (employeeId: number) =>
    api.get<Reporting>(`/api/rbac/users/${employeeId}/reporting`).then((r) => r.data),
  orgTree: () => api.get<OrgTree>("/api/rbac/org-tree").then((r) => r.data),
  viewAs: (employeeId: number) =>
    api.get<ViewAs>(`/api/rbac/users/${employeeId}/view-as`).then((r) => r.data),
  permissionHolders: (code: string) =>
    api.get<PermissionHolders>(`/api/rbac/permissions/${code}/holders`)
      .then((r) => r.data),

  // ---- Role lifecycle + permission matrix (RBAC-owned endpoints) ----
  matrix: {
    permissions: () => all<PermissionDef>("/api/rbac/permissions"),
    roles: () => all<RoleWithPermissions>("/api/rbac/roles"),
    setPermissions: (roleId: number, codes: string[]) =>
      api.put<SetPermissionsResult>(`/api/rbac/roles/${roleId}/permissions`,
        { permission_codes: codes }).then((r) => r.data),
    createRole: (body: { code: string; name: string; description?: string | null }) =>
      api.post(`/api/rbac/roles`, body).then((r) => r.data),
    updateRole: (roleId: number, body: { code: string; name: string }) =>
      api.put(`/api/rbac/roles/${roleId}`, body).then((r) => r.data),
    deleteRole: (roleId: number) =>
      api.delete(`/api/rbac/roles/${roleId}`).then((r) => r.data),
    cloneRole: (roleId: number, body: { code: string; name: string }) =>
      api.post(`/api/rbac/roles/${roleId}/clone`, body).then((r) => r.data),
  },
  hcmRoles: () =>
    all<{ id: number; name: string; positions: number }>("/api/admin/hcm-roles"),
  pageAccess: () =>
    api.get<PageAccessMatrix>("/api/rbac/page-access").then((response) => response.data),
  setPageAccess: (roleId: number, pageCodes: string[]) =>
    api.put(`/api/rbac/roles/${roleId}/page-access`, { page_codes: pageCodes })
      .then((response) => response.data),
  featureAccess: () =>
    api.get<FeatureAccessMatrix>("/api/rbac/feature-access").then((response) => response.data),
  setFeatureAccess: (roleId: number, permissionCodes: string[]) =>
    api.put(`/api/rbac/roles/${roleId}/feature-access`, {
      permission_codes: permissionCodes,
    }).then((response) => response.data),
};

