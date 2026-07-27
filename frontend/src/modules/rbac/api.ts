import { api } from "@/shared/api/client";
import type { Paginated } from "@/shared/types";
import type {
  AccessSummary, AdminUserRow, FeatureAccessMatrix, GrantResult, GroupMember,
  PageAccessMatrix, UserGroup,
} from "./types";

type ListParams = { search?: string; page?: number; size?: number };
const page = <T>(url: string, params: Record<string, unknown> = {}) =>
  api.get<Paginated<T>>(url, { params }).then((response) => response.data);
const all = <T>(url: string) =>
  api.get<{ items: T[] }>(url).then((response) => response.data.items);

export const rbacApi = {
  users: {
    list: (params: ListParams & { with_access?: boolean }) =>
      page<AdminUserRow>("/api/admin/users", params),
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
    list: (params: ListParams = {}) => page<UserGroup>("/api/admin/groups", params),
    create: (body: Partial<UserGroup>) =>
      api.post<UserGroup>("/api/admin/groups", body).then((response) => response.data),
    update: (id: number, body: Partial<UserGroup>) =>
      api.put<UserGroup>(`/api/admin/groups/${id}`, body).then((response) => response.data),
    deactivate: (id: number) =>
      api.delete(`/api/admin/groups/${id}`).then((response) => response.data),
    members: (id: number) => all<GroupMember>(`/api/admin/groups/${id}/members`),
    addMember: (id: number, employeeId: number) =>
      api.post(`/api/admin/groups/${id}/members/${employeeId}`).then((response) => response.data),
    removeMember: (id: number, employeeId: number) =>
      api.delete(`/api/admin/groups/${id}/members/${employeeId}`).then((response) => response.data),
  },
  roles: () => all<{
    id: number;
    code: string;
    name: string;
    is_active: boolean;
    source: "HCM" | "SCM";
    assignable: boolean;
  }>("/api/admin/roles"),
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

