import { api } from "@/shared/api/client";
import type { LedgerQuery, ReportFilter, ReportLedgerInfo, ReportRows } from "./types";

/** Reports HTTP layer. Four ledgers, one set of endpoints — the ledger key is a path
 *  segment, and filters are plain query params the backend matches to that ledger. */

const BASE = "/api/reports";

/** Filter values live at the top level of the query string, so the same params work
 *  for the JSON list and for the CSV export. Empty values are dropped — an empty
 *  filter must not narrow anything. */
export const toParams = (q: LedgerQuery): Record<string, string | number> => {
  const params: Record<string, string | number> = {};
  if (q.search?.trim()) params.search = q.search.trim();
  if (q.date_from) params.date_from = q.date_from;
  if (q.date_to) params.date_to = q.date_to;
  if (q.sort) params.sort = q.sort;
  if (q.dir) params.dir = q.dir;
  if (q.page) params.page = q.page;
  if (q.size) params.size = q.size;
  for (const [key, value] of Object.entries(q.filters ?? {})) {
    if (value?.trim()) params[key] = value.trim();
  }
  return params;
};

export const reportKeys = {
  ledgers: ["reports", "ledgers"] as const,
  filters: (ledger: string) => ["reports", ledger, "filters"] as const,
  rows: (ledger: string, q: LedgerQuery) => ["reports", ledger, "rows", q] as const,
};

export const getLedgers = () =>
  api.get<ReportLedgerInfo[]>(`${BASE}/ledgers`).then((r) => r.data);

export const getFilters = (ledger: string) =>
  api.get<ReportFilter[]>(`${BASE}/${ledger}/filters`).then((r) => r.data);

export const getRows = (ledger: string, q: LedgerQuery) =>
  api.get<ReportRows>(`${BASE}/${ledger}`, { params: toParams(q) }).then((r) => r.data);

/** The export goes through the same axios client so it carries the bearer token —
 *  a plain <a href> download would hit the endpoint unauthenticated and 401.
 *  Excel by default: it is the only format that can carry a styled heading row. */
export const exportLedger = async (
  ledger: string, q: LedgerQuery, format: "xlsx" | "csv" = "xlsx",
) => {
  const response = await api.get<Blob>(`${BASE}/${ledger}/export`, {
    params: { ...toParams(q), format },
    responseType: "blob",
  });
  const disposition = String(response.headers?.["content-disposition"] ?? "");
  const named = /filename="?([^";]+)"?/.exec(disposition)?.[1];
  return { blob: response.data, filename: named ?? `${ledger}-ledger.${format}` };
};

/** Hands the blob to the browser as a download. Kept here so no page has to know
 *  about object URLs. */
export const saveFile = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};
