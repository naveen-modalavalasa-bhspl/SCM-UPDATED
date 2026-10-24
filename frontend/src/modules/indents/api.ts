import { api } from "@/shared/api/client";
import { useEffect, useMemo, useRef } from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { useAuth } from "@/shared/auth/AuthContext";
import type { CompanyProfile } from "./companyProfile";
import type { Paginated, Option } from "@/shared/types";
import type {
  Acknowledgement, AcknowledgeLine, ActivityRow, DirectIssueAck,
  BomChoice, BomChoiceItem, FulfilmentStep, Indent, IndentCreate, IndentListRow, IndentJourney,
  IndentNotification, IndentStats, IndentUpdate, RaiserTracking, ReceiptAttachment,
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
  shipments: (scope: IndentAccountScope, id: number) =>
    [...indentKeys.all(scope), "shipments", id] as const,
  company: (scope: IndentAccountScope) =>
    [...indentKeys.all(scope), "company"] as const,
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
  /**
   * The items THIS requester may raise an indent for.
   *
   * Not `masterApi.items()`, which is the shared item master read by procurement, the
   * warehouse and the masters screens — narrowing that would change all of them. This
   * endpoint narrows only the indent picker, and returns exactly the master's contents
   * until an administrator tags an item (see `modules/indents/eligibility.py`).
   *
   * The picker is advice, not the gate: the server checks again on create and on
   * update, because the request body carries whatever item id the caller sent.
   */
  eligibleItems: (search?: string) =>
    api.get<{
      id: number; code: string; name: string; uom_code?: string | null;
      category_name?: string | null
    }[]>(
      "/api/indents/eligible-items", { params: { search: search || undefined } },
    ).then((r) => r.data),
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
  /** The letterhead for the printed indent. Authenticated, not admin-gated — see
   *  companyProfile.ts. A failure is not fatal: the fallback particulars stand. */
  company: (signal?: AbortSignal) =>
    api.get<Partial<CompanyProfile>>("/api/settings/company", { signal })
      .then((r) => r.data)
      .catch(() => ({} as Partial<CompanyProfile>)),
  /** Shipment visibility follows indent ownership, so raisers need no logistics grant. */
  shipmentsForIndent: (id: number, signal?: AbortSignal) =>
    api.get<RaiserTracking[]>(`/api/transport/for-indent/${id}`, { signal })
      .then((r) => r.data),
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
  myAcknowledgements: (params: {
    search?: string; status?: string;
    only_actionable?: boolean; indent_type?: string[]
  } = {}) =>
    // URLSearchParams so `indent_type` repeats (`?indent_type=A&indent_type=B`) the
    // way FastAPI reads a list, not axios's `indent_type[]=`.
    api.get<Acknowledgement[]>("/api/warehouse/acknowledgements/mine",
      { params: toSearchParams(params) })
      .then((r) => r.data),

  /** Direct (no-indent) material issues handed to me, to confirm I got them. */
  myDirectIssues: (params: { search?: string; only_actionable?: boolean } = {}) =>
    api.get<DirectIssueAck[]>("/api/warehouse/acknowledgements/direct-issues", { params })
      .then((r) => r.data),

  /** One direct issue in the indent acknowledgement's own shape, so the same
   *  receipt journey (consignment, packages, codes, photos) runs over it. */
  directIssueReceipt: (issueId: number) =>
    api.get<Acknowledgement>(`/api/warehouse/acknowledgements/direct-issues/${issueId}`)
      .then((r) => r.data),

  /** The issued / dispatched / delivered stages for one indent's stepper. */
  fulfilment: (id: number) =>
    api.get<FulfilmentStep[]>(`/api/warehouse/indents/${id}/fulfilment`).then((r) => r.data),

  /**
   * What reached the requester, and what state it was in.
   *
   * `condition` is GOOD or DAMAGED and nothing else — a shortage is already stated by
   * the quantities in `lines`, so there is no SHORT to send. DAMAGED requires remarks;
   * the backend opens the claim from them.
   */
  acknowledge: (id: number, lines: AcknowledgeLine[],
    receipt: { condition?: string; remarks?: string } = {}) =>
    api.post<Indent>(`/api/indents/${id}/acknowledge`, { lines, ...receipt })
      .then((r) => r.data),

  receiptAttachments: (id: number) =>
    api.get<ReceiptAttachment[]>(`/api/indents/${id}/receipt-attachments`)
      .then((r) => r.data),

  uploadReceiptAttachment: (id: number, file: File, docCategory: string) => {
    const body = new FormData();
    body.append("file", file);
    return api
      .post<ReceiptAttachment>(
        // Encoded: a package-scoped category carries a "::" separator, and a raw
        // colon in a query string is not ours to gamble on.
        `/api/indents/${id}/receipt-attachments?doc_category=${encodeURIComponent(docCategory)}`,
        body,
      )
      .then((r) => r.data);
  },

  // The bytes themselves, for the preview. Nested under the indent because that is
  // the route indents gates — the viewer never builds a URL of its own.
  downloadReceiptAttachment: (id: number, attachmentId: number) =>
    api
      .get(`/api/indents/${id}/receipt-attachments/${attachmentId}/download`, {
        responseType: "blob",
      })
      .then((r) => r.data as Blob),

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
    api.get<BomChoiceItem[]>("/api/indents/eligible-bom-items", { params: { bom_id: bomId } })
      .then((r) => r.data),
};

/**
 * The receipt journey's server, for an indent or a DIRECT material issue. The screen
 * is the same; only where the photos are filed and what the press signs differ.
 */
export type ReceiptKind = "indent" | "issue";

const DIRECT = "/api/warehouse/acknowledgements/direct-issues";

export function receiptApi(kind: ReceiptKind) {
  if (kind === "indent") {
    return {
      attachments: indentApi.receiptAttachments,
      upload: indentApi.uploadReceiptAttachment,
      download: indentApi.downloadReceiptAttachment,
      remove: indentApi.deleteReceiptAttachment,
      acknowledge: (id: number, lines: AcknowledgeLine[]) =>
        indentApi.acknowledge(id, lines) as Promise<unknown>,
    };
  }
  return {
    attachments: (id: number) =>
      api.get<ReceiptAttachment[]>(`${DIRECT}/${id}/attachments`).then((r) => r.data),
    upload: (id: number, file: File, docCategory: string) => {
      const body = new FormData();
      body.append("file", file);
      return api
        .post<ReceiptAttachment>(
          `${DIRECT}/${id}/attachments?doc_category=${encodeURIComponent(docCategory)}`,
          body,
        )
        .then((r) => r.data);
    },
    download: (id: number, attachmentId: number) =>
      api.get(`${DIRECT}/${id}/attachments/${attachmentId}/download`, { responseType: "blob" })
        .then((r) => r.data as Blob),
    remove: (attachmentId: number) =>
      api.delete<void>(`${DIRECT}/attachments/${attachmentId}`).then((r) => r.data),
    acknowledge: (id: number, lines: AcknowledgeLine[]) =>
      api.post<Acknowledgement>(`${DIRECT}/${id}/acknowledge`, { lines })
        .then((r) => r.data) as Promise<unknown>,
  };
}
