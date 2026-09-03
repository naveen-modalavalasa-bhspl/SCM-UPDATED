/** The Attachments register, as the backend serves it.
 *
 *  A row is a DOCUMENT carrying the files filed against it, not a loose file — the
 *  question the screen answers is "what paperwork does this GRN have?", and a flat
 *  list makes the same document appear six times.
 *
 *  Nothing here is derived in the screen. Which document types exist, what each is
 *  called, which ladder a document ran under and where a download lives all arrive
 *  from `/api/reports/attachments*`, so a new document type is one entry in
 *  `reports/attachments.py` `SOURCES` and no change at all on this side. */

export type AttachmentFileKind = "image" | "pdf" | "document" | "other";

/** One document type the register can be grouped by, served by `/attachments/sources`. */
export interface AttachmentSource {
  /** `sys_attachments.entity_type` — the filter value. */
  entity_type: string;
  /** What the tab says, e.g. "Goods Receipt". */
  label: string;
  /** The traceability node key behind it, e.g. "grn". */
  kind: string;
  doc_label: string;
}

/** One stored file. `download_url` is null where the owning module serves no scoped
 *  download route — the register never serves bytes itself, so a missing link is an
 *  honest gap and not something to paper over with a direct path. */
export interface AttachmentFile {
  id: number;
  file_name: string;
  file_kind: AttachmentFileKind;
  mime_type: string | null;
  file_size: number | null;
  doc_category: string | null;
  uploaded_by_id: number | null;
  uploaded_by_name: string | null;
  uploaded_at: string | null;
  download_url: string | null;
}

/** The approval ladder the document ran under, shared with the Live Tracking board —
 *  same payload, same backend helper, so the two screens cannot disagree about which
 *  version signed a document. Null when it was never submitted. */
export type { TrackApproval as AttachmentApproval } from "./liveTrackingModel";

/** One document on the register, with its files. */
export interface AttachmentDocument {
  entity_type: string;
  entity_id: number;
  source_label: string;
  kind: string;
  doc_label: string;
  doc_no: string | null;
  doc_status: string | null;
  doc_date: string | null;
  /** The path that opens the document, resolved by the backend's own NODES map. */
  doc_path: string | null;
  doctype_code: string | null;
  approval: import("./liveTrackingModel").TrackApproval | null;
  attachments: AttachmentFile[];
  attachment_count: number;
}

/** The KPI strip, counted over the same scoped set the register lists. */
export interface AttachmentSummary {
  total: number;
  image: number;
  pdf: number;
  document: number;
  other: number;
}
