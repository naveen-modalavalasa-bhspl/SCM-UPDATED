import { api } from "@/shared/api/client";
import type {
  AttachmentDocument, AttachmentSource, AttachmentSummary,
} from "./attachmentsTypes";

/** Attachments HTTP layer. Three reads, all behind `report.view`, all scoped to this
 *  login's rows by `reports/attachments.py` on top of that.
 *
 *  Downloads deliberately do NOT go through here: a row's `download_url` already
 *  points at the OWNING module's own scoped route, and that route is the one that
 *  checks whether this login may read the document the file hangs on. Adding a
 *  download helper in this module would be adding a second door to the same files. */

const BASE = "/api/reports/attachments";

export interface AttachmentQuery {
  entity_type?: string;
  kind?: string;
  search?: string;
  page?: number;
  size?: number;
}

export interface AttachmentRows {
  items: AttachmentDocument[];
  total: number;
  page: number;
  size: number;
}

/** Empty values are dropped — an empty filter must not narrow anything. */
const toParams = (q: AttachmentQuery): Record<string, string | number> => {
  const params: Record<string, string | number> = {};
  if (q.entity_type) params.entity_type = q.entity_type;
  if (q.kind) params.kind = q.kind;
  if (q.search?.trim()) params.search = q.search.trim();
  if (q.page) params.page = q.page;
  if (q.size) params.size = q.size;
  return params;
};

export const attachmentKeys = {
  sources: ["reports", "attachments", "sources"] as const,
  summary: (entityType?: string) =>
    ["reports", "attachments", "summary", entityType ?? ""] as const,
  rows: (q: AttachmentQuery) => ["reports", "attachments", "rows", q] as const,
};

export const getAttachmentSources = () =>
  api.get<AttachmentSource[]>(`${BASE}/sources`).then((r) => r.data);

export const getAttachmentSummary = (entityType?: string) =>
  api.get<AttachmentSummary>(`${BASE}/summary`, {
    params: entityType ? { entity_type: entityType } : {},
  }).then((r) => r.data);

export const getAttachmentRows = (q: AttachmentQuery) =>
  api.get<AttachmentRows>(BASE, { params: toParams(q) }).then((r) => r.data);
