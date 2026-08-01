import { api } from "@/shared/api/client";
import { useEffect, useMemo, useRef } from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { useAuth } from "@/shared/auth/AuthContext";
import type { Paginated, Option } from "@/shared/types";
import type {
  AcknowledgmentRow, ActivityRow, ApprovalDecisionRow, ApprovalDelegation,
  BomChoice, BomChoiceItem, Indent, IndentCreate, IndentListRow, IndentJourney,
  IndentNotification, IndentStats, IndentUpdate, PendingApproval, TeamQueueRow,
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
  notifications: (scope: IndentAccountScope, filters: unknown = {}) =>
    [...indentKeys.all(scope), "notifications", filters] as const,
  pendingApprovals: (scope: IndentAccountScope) =>
    [...indentKeys.all(scope), "pending-approvals"] as const,
  detail: (scope: IndentAccountScope, id: number) =>
    [...indentKeys.all(scope), "detail", id] as const,
  offices: (scope: IndentAccountScope) =>
    [...indentKeys.all(scope), "offices"] as const,
  journey: (scope: IndentAccountScope, id: number) =>
    [...indentKeys.all(scope), "journey", id] as const,
  items: (scope: IndentAccountScope, context: unknown = "default") =>
    [...indentKeys.all(scope), "items", context] as const,
  bomChoices: (scope: IndentAccountScope) =>
    [...indentKeys.all(scope), "bom-choices"] as const,
  bomChoiceItems: (scope: IndentAccountScope, bomId: number) =>
    [...indentKeys.all(scope), "bom-choice-items", bomId] as const,
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

export function normalizeIndentQueryParams<T extends object>(params: T): T {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => [
        key,
        Array.isArray(value)
          ? [...value].filter((item) => item !== undefined && item !== null && item !== "").sort()
          : value,
      ])
      .filter(([, value]) => !Array.isArray(value) || value.length > 0),
  ) as T;
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

async function allMasterRows<T>(
  url: string,
  params: Record<string, string | number | undefined> = {},
) {
  const size = 500;
  const first = (
    await api.get<Paginated<T>>(url, { params: { ...params, size } })
  ).data;
  const pageCount = Math.ceil((first.total ?? first.items.length) / size);
  if (pageCount <= 1) return first.items;

  const remaining = await Promise.all(
    Array.from({ length: pageCount - 1 }, (_, index) =>
      api.get<Paginated<T>>(url, {
        params: { ...params, page: index + 2, size },
      }).then((response) => response.data.items),
    ),
  );
  return [first.items, ...remaining].flat();
}

export const indentApi = {
  list: (params: IndentQueryParams = {}, signal?: AbortSignal) =>
    api.get<Paginated<IndentListRow>>("/api/indents", {
      params: toSearchParams(params),
      signal,
    }).then((r) => r.data),
  stats: (params: IndentQueryParams = {}, signal?: AbortSignal) =>
    api.get<IndentStats>("/api/indents/stats", {
      params: toSearchParams(params),
      signal,
    }).then((r) => r.data),
  activity: (params: {
    search?: string; date_from?: string; date_to?: string; item_id?: number;
    required_from?: string; required_to?: string;
    status?: string | string[]; priority?: string | string[];
    transaction_type?: string; direction?: string;
    page?: number; size?: number;
  }, signal?: AbortSignal) => api.get<Paginated<ActivityRow>>("/api/indents/activity", {
    params: toSearchParams(params),
    signal,
  }).then((r) => r.data),
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
  notifications: (params: {
    search?: string;
    date_from?: string;
    date_to?: string;
    status?: string | string[];
    page?: number;
    size?: number;
  } = {}, signal?: AbortSignal) =>
    api.get<Paginated<IndentNotification>>("/api/indents/notifications", {
      params: toSearchParams(params),
      signal,
    }).then((r) => r.data),
  pendingApprovals: () =>
    api.get<{ items: PendingApproval[] }>("/api/workflow/pending").then((r) => r.data.items),
  offices: () => api.get<{ items: Option[] }>("/api/indents/options/offices").then((r) => r.data.items),
  get: (id: number) => api.get<Indent>(`/api/indents/${id}`).then((r) => r.data),
  journey: (id: number) => api.get<IndentJourney>(`/api/indents/${id}/journey`).then((r) => r.data),
  create: (data: IndentCreate) => api.post<Indent>("/api/indents", data).then((r) => r.data),
  update: (id: number, data: IndentUpdate) =>
    api.put<Indent>(`/api/indents/${id}`, data).then((r) => r.data),
  delete: (id: number) => api.delete<void>(`/api/indents/${id}`).then((r) => r.data),
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
    allMasterRows<Option>("/api/items", { search }),
  facilities: () => api.get<{ items: Option[] }>("/api/facilities").then((r) => r.data.items),
  boms: () =>
    allMasterRows<BomChoice>("/api/boms")
      .then((items) => items.filter((bom) => bom.is_active)),
  bomItems: (bomId: number) =>
    allMasterRows<BomChoiceItem>("/api/bom-items", { bom_id: bomId }),
};

export const approvalApi = {
  pending: () => api.get<{ items: PendingApproval[] }>("/api/workflow/pending").then((r) => r.data.items),
  decisions: () => api.get<{ items: ApprovalDecisionRow[] }>("/api/workflow/my-decisions").then((r) => r.data.items),
  teamQueue: () => api.get<{ items: TeamQueueRow[] }>("/api/workflow/team-queue").then((r) => r.data.items),
  delegations: (scope: "mine" | "incoming" | "team" = "mine") =>
    api.get<ApprovalDelegation[]>("/api/workflow/delegations", { params: { scope } }).then((r) => r.data),
  delegationOptions: () =>
    api.get<{ items: Option[] }>("/api/workflow/delegation-options").then((r) => r.data.items),
  createDelegation: (data: {
    to_employee_id: number;
    doc_type?: string | null;
    valid_from: string;
    valid_to: string;
    reason?: string;
  }) => api.post<ApprovalDelegation>("/api/workflow/delegations", data).then((r) => r.data),
  endDelegation: (id: number, reason?: string) =>
    api.post<ApprovalDelegation>(`/api/workflow/delegations/${id}/end`, { reason }).then((r) => r.data),
};
