import { api } from "@/shared/api/client";
import { useEffect, useMemo, useRef } from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { useAuth } from "@/shared/auth/AuthContext";
import type { Paginated, Option } from "@/shared/types";
import type {
  AcknowledgeLine, AcknowledgmentRow, ActivityRow,
  BomChoice, BomChoiceItem, Delivery, FulfilmentStep, Indent, IndentCreate, IndentListRow, IndentJourney,
  IndentNotification, IndentStats, IndentUpdate, ReceiptAttachment,
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
  indent_type?: string | string[];
  department_id?: number | number[];
  region_id?: number | number[];
  /** Include indents with no Region/Location. Opt-in: `region_id` alone drops them. */
  region_unassigned?: boolean;
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
export const INDENT_JOURNEY_CONTRACT_VERSION = 5;

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
  detail: (scope: IndentAccountScope, id: number) =>
    [...indentKeys.all(scope), "detail", id] as const,
  offices: (scope: IndentAccountScope) =>
    [...indentKeys.all(scope), "offices"] as const,
  regions: (scope: IndentAccountScope) =>
    [...indentKeys.all(scope), "regions"] as const,
  vehicles: (scope: IndentAccountScope, search: string = "") =>
    [...indentKeys.all(scope), "vehicles", search] as const,
  journey: (scope: IndentAccountScope, id: number) =>
    [...indentKeys.all(scope), "journey", INDENT_JOURNEY_CONTRACT_VERSION, id] as const,
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
    region_id?: number | number[]; region_unassigned?: boolean;
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
  offices: () => api.get<{ items: Option[] }>("/api/indents/options/offices").then((r) => r.data.items),
  /**
   * The Region/Location values actually present on the caller's visible indents —
   * not the 1,500-row office master, so every option returns rows.
   */
  regions: () =>
    api.get<{ items: Option[] }>("/api/indents/options/regions").then((r) => r.data.items),
  /**
   * Vehicles come from the indents module, not from warehouse's identical endpoint:
   * raising an indent must not require warehouse permissions.
   */
  vehicles: (search?: string) =>
    api.get<Option[]>("/api/indents/options/vehicles", {
      params: toSearchParams({ search }),
    }).then((r) => r.data),
  get: (id: number, signal?: AbortSignal) =>
    api.get<Indent>(`/api/indents/${id}`, { signal }).then((r) => r.data),
  journey: (id: number, signal?: AbortSignal) =>
    api.get<IndentJourney>(`/api/indents/${id}/journey`, { signal }).then((r) => r.data),
  create: (data: IndentCreate) => api.post<Indent>("/api/indents", data).then((r) => r.data),
  update: (id: number, data: IndentUpdate) =>
    api.put<Indent>(`/api/indents/${id}`, data).then((r) => r.data),
  delete: (id: number) => api.delete<void>(`/api/indents/${id}`).then((r) => r.data),
  submit: (id: number) => api.post<Indent>(`/api/indents/${id}/submit`).then((r) => r.data),
  returnForCorrection: (id: number, comments: string) =>
    api.post<Indent>(`/api/indents/${id}/return-for-correction`, { comments })
      .then((r) => r.data),
  resubmitCorrection: (id: number) =>
    api.post<Indent>(`/api/indents/${id}/resubmit-correction`).then((r) => r.data),
  approve: (id: number, comments: string) =>
    api.post<Indent>(`/api/indents/${id}/approve`, { comments }).then((r) => r.data),
  reject: (id: number, comments: string) =>
    api.post<Indent>(`/api/indents/${id}/reject`, { comments }).then((r) => r.data),
  bookmark: (id: number) => api.post<Indent>(`/api/indents/${id}/bookmark`).then((r) => r.data),
  unbookmark: (id: number) => api.post<Indent>(`/api/indents/${id}/unbookmark`).then((r) => r.data),

  /**
   * What the requester is still owed, and how far it has got.
   *
   * Served by the warehouse module because the issue and dispatch evidence lives
   * there; the screen is an indents screen all the same.
   */
  myDeliveries: (params: { search?: string; status?: string; only_actionable?: boolean } = {}) =>
    api.get<Delivery[]>("/api/warehouse/deliveries/mine", { params }).then((r) => r.data),

  /** The issued / dispatched / delivered stages for one indent's stepper. */
  fulfilment: (id: number) =>
    api.get<FulfilmentStep[]>(`/api/warehouse/indents/${id}/fulfilment`).then((r) => r.data),

  acknowledge: (id: number, lines: AcknowledgeLine[]) =>
    api.post<Indent>(`/api/indents/${id}/acknowledge`, { lines }).then((r) => r.data),

  receiptAttachments: (id: number) =>
    api.get<ReceiptAttachment[]>(`/api/indents/${id}/receipt-attachments`)
      .then((r) => r.data),

  uploadReceiptAttachment: (id: number, file: File, docCategory: string) => {
    const body = new FormData();
    body.append("file", file);
    return api
      .post<ReceiptAttachment>(
        `/api/indents/${id}/receipt-attachments?doc_category=${docCategory}`,
        body,
      )
      .then((r) => r.data);
  },

  deleteReceiptAttachment: (attachmentId: number) =>
    api.delete<void>(`/api/indents/receipt-attachments/${attachmentId}`).then((r) => r.data),
};

export const masterApi = {
  items: (search?: string) =>
    allMasterRows<Option>("/api/items", { search }),
  facilities: () => api.get<{ items: Option[] }>("/api/facilities").then((r) => r.data.items),
  boms: () =>
    // mine=true: only the kits tagged to the hat this session is wearing. Without it
    // the picker listed every BOM in the company and the tagging did nothing at all.
    allMasterRows<BomChoice>("/api/boms", { mine: "true" })
      // is_effective is the switch AND the BOM's optional validity window, decided
      // by the server against its own clock. Undefined only where the row predates
      // the field, which is not a reason to hide a kit.
      .then((items) => items.filter(
        (bom) => bom.is_active && bom.is_effective !== false)),
  bomItems: (bomId: number) =>
    allMasterRows<BomChoiceItem>("/api/bom-items", { bom_id: bomId }),
};
