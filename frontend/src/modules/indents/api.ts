import { api } from "@/shared/api/client";
import { useEffect, useMemo, useRef } from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { useAuth } from "@/shared/auth/AuthContext";
import type { Paginated, Option } from "@/shared/types";
import type {
  AcknowledgmentRow, ActivityRow, Indent, IndentCreate, IndentListRow,
  IndentJourney, IndentNotification, IndentStats, PendingApproval,
} from "./types";

export interface IndentQueryParams {
  search?: string;
  created_date_from?: string;
  created_date_to?: string;
  required_by_from?: string;
  required_by_to?: string;
  start_date?: string;
  end_date?: string;
  status?: string | string[];
  priority?: string | string[];
  department_id?: number | number[];
  project_id?: number | number[];
  office_id?: number | number[];
  warehouse_id?: number | number[];
  item_id?: number | number[];
  created_by_id?: number | number[];
  is_bookmarked?: "YES" | "NO" | string;
  sort_by?: string;
  sort_dir?: string;
  page?: number;
  size?: number;
}

type ReactQueryContext = {
  queryKey: readonly unknown[];
  signal?: AbortSignal;
};

export const INDENT_QUERY_STALE_TIME = 45_000;
export const INDENT_QUERY_GC_TIME = 5 * 60_000;
export const INDENT_QUERY_ROOT = "indents-module";

export interface IndentAccountScope {
  employeeId: number | null;
  activePositionId: number | null;
}

export const indentKeys = {
  all: (scope: IndentAccountScope) =>
    [INDENT_QUERY_ROOT, scope.employeeId, scope.activePositionId] as const,
  list: (scope: IndentAccountScope, filters: unknown) =>
    [...indentKeys.all(scope), "list", filters] as const,
  board: (scope: IndentAccountScope, filters: unknown) =>
    [...indentKeys.all(scope), "board", filters] as const,
  recent: (scope: IndentAccountScope, filters: unknown) =>
    [...indentKeys.all(scope), "recent", filters] as const,
  stats: (scope: IndentAccountScope, filters: unknown) =>
    [...indentKeys.all(scope), "stats", filters] as const,
  activity: (scope: IndentAccountScope, filters: unknown) =>
    [...indentKeys.all(scope), "activity", filters] as const,
  acknowledgments: (scope: IndentAccountScope, filters: unknown) =>
    [...indentKeys.all(scope), "acknowledgments", filters] as const,
  notifications: (scope: IndentAccountScope) =>
    [...indentKeys.all(scope), "notifications"] as const,
  pendingApprovals: (scope: IndentAccountScope) =>
    [...indentKeys.all(scope), "pending-approvals"] as const,
  detail: (scope: IndentAccountScope, id: number) =>
    [...indentKeys.all(scope), "detail", id] as const,
  journey: (scope: IndentAccountScope, id: number) =>
    [...indentKeys.all(scope), "journey", id] as const,
  items: (scope: IndentAccountScope, context: unknown = "default") =>
    [...indentKeys.all(scope), "items", context] as const,
};

export function isIndentModuleQuery(query: Query) {
  return query.queryKey[0] === INDENT_QUERY_ROOT;
}

export function isIndentUnavailableError(error: unknown) {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  return status === 403 || status === 404;
}

export function useIndentAccountScope(): IndentAccountScope {
  const { me } = useAuth();
  return useMemo(() => ({
    employeeId: me?.employee.id ?? null,
    activePositionId: me?.active_position?.id ?? null,
  }), [me?.employee.id, me?.active_position?.id]);
}

export function useIndentAccountCacheIsolation(scope: IndentAccountScope) {
  const qc = useQueryClient();
  const previous = useRef<string | null>(null);
  const current = `${scope.employeeId ?? "none"}:${scope.activePositionId ?? "none"}`;
  useEffect(() => {
    if (previous.current !== null && previous.current !== current) {
      qc.removeQueries({ predicate: isIndentModuleQuery });
    }
    previous.current = current;
  }, [current, qc]);
}

function normalizeParams(params?: IndentQueryParams | ReactQueryContext): IndentQueryParams {
  if (params && "queryKey" in params) return {};
  return params ?? {};
}

function toSearchParams(params: object = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params as Record<string, unknown>).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item !== undefined && item !== null && item !== "") {
          searchParams.append(key, String(item));
        }
      });
      return;
    }
    searchParams.set(key, String(value));
  });
  return searchParams;
}

export const indentApi = {
  list: (params: IndentQueryParams = {}) =>
    api.get<Paginated<IndentListRow>>("/api/indents", { params: toSearchParams(params) }).then((r) => r.data),
  stats: (params?: IndentQueryParams | ReactQueryContext) =>
    api.get<IndentStats>("/api/indents/stats", { params: toSearchParams(normalizeParams(params)) }).then((r) => r.data),
  activity: (params: {
    search?: string; date_from?: string; date_to?: string; item_id?: number;
    required_from?: string; required_to?: string;
    status?: string | string[]; priority?: string | string[];
    transaction_type?: string; direction?: string;
    page?: number; size?: number;
  }) => api.get<Paginated<ActivityRow>>("/api/indents/activity", { params: toSearchParams(params) }).then((r) => r.data),
  acknowledgments: (params: {
    search?: string;
    date_from?: string;
    date_to?: string;
    required_from?: string;
    required_to?: string;
    status?: string | string[];
    priority?: string | string[];
    page?: number;
    size?: number;
  } = {}) =>
    api.get<Paginated<AcknowledgmentRow>>("/api/indents/acknowledgments", { params: toSearchParams(params) }).then((r) => r.data),
  notifications: (params: { page?: number; size?: number } = {}) =>
    api.get<Paginated<IndentNotification>>("/api/indents/notifications", { params: toSearchParams(params) }).then((r) => r.data),
  pendingApprovals: () =>
    api.get<{ items: PendingApproval[] }>("/api/workflow/pending").then((r) => r.data.items),
  get: (id: number) => api.get<Indent>(`/api/indents/${id}`).then((r) => r.data),
  journey: (id: number) => api.get<IndentJourney>(`/api/indents/${id}/journey`).then((r) => r.data),
  create: (data: IndentCreate) => api.post<Indent>("/api/indents", data).then((r) => r.data),
  submit: (id: number) => api.post<Indent>(`/api/indents/${id}/submit`).then((r) => r.data),
  approve: (id: number, comments: string) =>
    api.post<Indent>(`/api/indents/${id}/approve`, { comments }).then((r) => r.data),
  reject: (id: number, comments: string) =>
    api.post<Indent>(`/api/indents/${id}/reject`, { comments }).then((r) => r.data),
  bookmark: (id: number) => api.post<Indent>(`/api/indents/${id}/bookmark`).then((r) => r.data),
  unbookmark: (id: number) => api.post<Indent>(`/api/indents/${id}/unbookmark`).then((r) => r.data),
};

export const masterApi = {
  items: (search?: string) =>
    api.get<Paginated<Option>>("/api/items", { params: { search, size: 100 } }).then((r) => r.data.items),
  facilities: () => api.get<{ items: Option[] }>("/api/facilities").then((r) => r.data.items),
};
