import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  ExternalLink, File, FileSpreadsheet, FileText, Image as ImageIcon, Paperclip, X,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  Card, ErrorBanner, PageHeader, ResponsiveList, SearchField, SharedAttachmentViewer,
  StatCard, StatusPill, SubNav,
} from "@/shared/components";
import type { Column } from "@/shared/components/ResponsiveList";
import { fmtDate, fmtDateTime } from "@/shared/datetime";
import { AttachmentThumb, fetchAttachmentBlob } from "../components/AttachmentThumb";
import { ladderChipLabel, ladderOrigin, ladderRoute } from "../liveTrackingModel";
import {
  attachmentKeys, getAttachmentRows, getAttachmentSources, getAttachmentSummary,
} from "../attachmentsApi";
import type {
  AttachmentDocument, AttachmentFile, AttachmentFileKind,
} from "../attachmentsTypes";

/**
 * Reports > Attachments — every file filed against a document, in one register.
 *
 * Master-detail: the list is DOCUMENTS (a GRN, an indent, a shipment) and opening one
 * shows the paperwork on it. Grouped that way because that is the question a desk
 * actually asks — "what came in with this receipt?" — and because a flat list of files
 * makes the same document appear six times.
 *
 * Everything on screen arrived from `/api/reports/attachments*`: the tabs, each
 * document's number and status, the ladder it ran under, and the URL a file downloads
 * from. There is no doc-type map here, and no download URL is built in this file — a
 * row carries the route its OWNING module already gates, which is what keeps this
 * screen from becoming a second door onto files the other modules scope carefully.
 */

const PAGE_SIZE = 25;

const KIND_META: Record<AttachmentFileKind, {
  icon: typeof ImageIcon; label: string; tint: string;
}> = {
  image: { icon: ImageIcon, label: "Images", tint: "bg-info-bg text-info" },
  pdf: { icon: FileText, label: "PDFs", tint: "bg-bad-bg text-bad" },
  document: { icon: FileSpreadsheet, label: "Documents", tint: "bg-ok-bg text-ok" },
  other: { icon: File, label: "Other files", tint: "bg-neutral-bg text-neutral" },
};

const KIND_ORDER: AttachmentFileKind[] = ["image", "pdf", "document", "other"];

function fmtSize(bytes?: number | null): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The ladder stamp, shared with the Live Tracking board — same payload, same helpers,
 *  so the two screens cannot describe one document's approval differently. */
function LadderChip({ approval }: { approval: AttachmentDocument["approval"] }) {
  const nav = useNavigate();
  const route = ladderRoute(approval);
  const origin = ladderOrigin(approval);
  const label = ladderChipLabel(approval);
  const body = (
    <>
      {label}
      {origin && <span className="ml-1 font-normal text-muted">· {origin}</span>}
    </>
  );
  if (!route) {
    return (
      <span className="rounded-full bg-content2 px-2 py-0.5 text-[11px] font-semibold text-muted">
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      title={`${label}${origin ? ` — ${origin}` : ""}`}
      onClick={(event) => { event.stopPropagation(); nav(route); }}
      className="rounded-full bg-brand-050 px-2 py-0.5 text-[11px] font-semibold text-brand hover:bg-brand/10"
    >
      {body}
    </button>
  );
}

export function AttachmentsReportPage() {
  const nav = useNavigate();
  const [entityType, setEntityType] = useState("");
  const [kind, setKind] = useState<"" | AttachmentFileKind>("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<AttachmentDocument | null>(null);
  const [viewing, setViewing] = useState<{ files: AttachmentFile[]; at: number } | null>(null);

  const sources = useQuery({
    queryKey: attachmentKeys.sources,
    queryFn: getAttachmentSources,
    staleTime: Infinity,
  });
  const summary = useQuery({
    queryKey: attachmentKeys.summary(entityType),
    queryFn: () => getAttachmentSummary(entityType || undefined),
  });
  const query = { entity_type: entityType, kind, search, page, size: PAGE_SIZE };
  const rows = useQuery({
    queryKey: attachmentKeys.rows(query),
    queryFn: () => getAttachmentRows(query),
    placeholderData: keepPreviousData,
  });

  const items = rows.data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((rows.data?.total ?? 0) / PAGE_SIZE));

  /** Reset to page 1 whenever the question changes — page 4 of a different filter is
   *  a blank screen that looks like "no files". */
  const refine = (change: () => void) => { change(); setPage(1); setOpen(null); };

  /** The bytes, from the route the row itself carries. Shared with the thumbnails, so
   *  opening a preview of a picture already on screen costs no second fetch. */
  const fetchBlob = (file: AttachmentFile): Promise<Blob> => {
    if (!file.download_url) {
      return Promise.reject(
        new Error(`${file.file_name} has no download route in its module.`));
    }
    return fetchAttachmentBlob(file.download_url);
  };

  const columns: Column<AttachmentDocument>[] = [
    {
      key: "doc",
      header: "Document",
      render: (row) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 rounded bg-content2 px-1.5 py-0.5 text-[10px] font-bold text-muted">
            {row.doctype_code ?? row.doc_label}
          </span>
          <span className="mono truncate text-sm font-semibold text-ink">
            {row.doc_no ?? `#${row.entity_id}`}
          </span>
        </div>
      ),
    },
    {
      key: "type", header: "Type", hideOnNarrow: true,
      render: (row) => <span className="text-sm text-body">{row.source_label}</span>,
    },
    {
      key: "status", header: "Status",
      render: (row) => (row.doc_status ? <StatusPill status={row.doc_status} /> : <span className="text-muted">—</span>),
    },
    {
      key: "date", header: "Date", hideOnNarrow: true,
      render: (row) => <span className="text-sm text-body">{fmtDate(row.doc_date)}</span>,
    },
    {
      key: "ladder", header: "Approval", hideOnNarrow: true,
      render: (row) => <LadderChip approval={row.approval} />,
    },
    {
      // A strip of the actual pictures, not a count. Three, then "+n" — a register
      // whose whole subject is paperwork should show the paperwork, and the row is
      // where a reader decides whether to open the document at all.
      key: "files", header: "Files",
      render: (row) => (
        <span className="flex items-center gap-1">
          {row.attachments.slice(0, 3).map((file) => (
            <AttachmentThumb key={file.id} file={file} className="h-8 w-8" />
          ))}
          {row.attachment_count > 3 && (
            <span className="inline-flex items-center gap-0.5 pl-0.5 text-xs font-semibold text-muted">
              <Paperclip className="h-3 w-3" />+{row.attachment_count - 3}
            </span>
          )}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader eyebrow="Reports" title="Attachments" />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="All files" value={summary.data?.total ?? "—"}
                  icon={<Paperclip className="h-4 w-4" />} />
        {KIND_ORDER.map((key) => {
          const meta = KIND_META[key];
          const Icon = meta.icon;
          return (
            <button key={key} type="button" className="text-left"
                    onClick={() => refine(() => setKind(kind === key ? "" : key))}>
              <StatCard
                label={meta.label}
                value={summary.data?.[key] ?? "—"}
                icon={<Icon className={`h-4 w-4 ${kind === key ? "text-brand" : ""}`} />}
              />
            </button>
          );
        })}
      </div>

      {/* The tabs are SERVED — one per document type the register is able to bound, so
          a type this login can never see is a type it is never offered. */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <SubNav
          label="Document type"
          value={entityType}
          onChange={(value) => refine(() => setEntityType(value))}
          items={[
            { key: "", label: "All documents" },
            ...(sources.data ?? []).map((s) => ({ key: s.entity_type, label: s.label })),
          ]}
        />
        <SearchField
          value={search}
          onChange={(value) => refine(() => setSearch(value))}
          placeholder="File name, uploader or category"
        />
      </div>

      <ErrorBanner error={rows.error ?? summary.error ?? sources.error} />

      {/* Register left, the open document's paperwork RIGHT — the detail is a companion
          to the row it belongs to, and putting it under a page of rows meant scrolling
          away from the row you just clicked to see what it holds. The aside sticks so
          it stays beside the list while the list scrolls; under `lg` the two stack,
          detail first, because on a phone there is no "beside". */}
      <div className={`grid gap-4 ${open ? "lg:grid-cols-[minmax(0,1fr)_380px]" : ""}`}>
        <Card className="order-2 lg:order-1">
          <ResponsiveList
            data={items}
            columns={columns}
            keyOf={(row) => `${row.entity_type}:${row.entity_id}`}
            loading={rows.isLoading}
            onRowClick={(row) => setOpen(open?.entity_id === row.entity_id
              && open?.entity_type === row.entity_type ? null : row)}
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            empty={
              <p className="p-10 text-center text-sm text-muted">
                No document in view carries a file{kind ? " of that kind" : ""}
                {search ? ` matching “${search}”` : ""}.
              </p>
            }
            renderCard={(row) => (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="mono text-sm font-semibold text-ink">
                    {row.doc_no ?? `#${row.entity_id}`}
                  </span>
                  {row.doc_status && <StatusPill status={row.doc_status} />}
                </div>
                <p className="text-xs text-muted">
                  {row.source_label} · {fmtDate(row.doc_date)} · {row.attachment_count} file
                  {row.attachment_count === 1 ? "" : "s"}
                </p>
                <span className="flex flex-wrap items-center gap-1">
                  {row.attachments.slice(0, 4).map((file) => (
                    <AttachmentThumb key={file.id} file={file} className="h-10 w-10" />
                  ))}
                </span>
                <LadderChip approval={row.approval} />
              </div>
            )}
          />
        </Card>

        {open && (
          <aside className="order-1 lg:order-2 lg:sticky lg:top-4 lg:self-start">
            <Card className="p-4">
              <div className="mb-3 flex items-start justify-between gap-2 border-b border-line/60 pb-3">
                <div className="min-w-0">
                  <p className="mono truncate text-sm font-bold text-ink">
                    {open.doc_no ?? `#${open.entity_id}`}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">{open.source_label}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {open.doc_status && <StatusPill status={open.doc_status} />}
                    <LadderChip approval={open.approval} />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(null)}
                  aria-label="Close the document panel"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-content2 hover:text-ink"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {open.doc_path && (
                <button
                  type="button"
                  onClick={() => nav(open.doc_path!)}
                  className="mb-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-brand/30 px-3 py-2 text-xs font-semibold text-brand hover:bg-content1"
                >
                  Open document <ExternalLink className="h-3.5 w-3.5" />
                </button>
              )}

              {/* Every picture drawn as itself. A contact sheet is the point of an
                  attachments register — a column of paperclip glyphs says a file
                  exists and nothing about which one you want. */}
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
                {open.attachments.map((file, index) => (
                  <li key={file.id}>
                    <button
                      type="button"
                      disabled={!file.download_url}
                      onClick={() => setViewing({ files: open.attachments, at: index })}
                      title={file.download_url
                        ? `Preview ${file.file_name}`
                        : "This file's module serves no download route yet."}
                      className="flex w-full items-center gap-3 rounded-xl border border-line bg-content1 p-2 text-left transition-colors enabled:hover:bg-content2 disabled:opacity-60"
                    >
                      <AttachmentThumb file={file} className="h-12 w-12" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-ink">
                          {file.file_name}
                        </span>
                        <span className="block truncate text-xs text-muted">
                          {fmtSize(file.file_size)} · {file.uploaded_by_name ?? "—"}
                        </span>
                        <span className="block truncate text-[11px] text-muted">
                          {fmtDateTime(file.uploaded_at)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          </aside>
        )}
      </div>

      {viewing && (
        <SharedAttachmentViewer
          attachments={viewing.files}
          initialIndex={viewing.at}
          onClose={() => setViewing(null)}
          onDownload={fetchBlob}
        />
      )}
    </div>
  );
}
