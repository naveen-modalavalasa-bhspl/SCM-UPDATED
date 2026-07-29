import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Paperclip, Trash2, Upload } from "lucide-react";
import { Button } from "@/shared/components";
import { deleteAttachment, listAttachments, uploadAttachment } from "../api";
import { fmtDateTime } from "../format";
import { ErrorBanner } from "./Feedback";

/**
 * Documents hung off a warehouse record — invoice copies, LR slips, QC certificates,
 * proof of delivery.
 *
 * `sys_attachments` is keyed by `(entity_type, entity_id)`, so this component takes
 * that pair and needs no per-document wiring: the GRN screen passes `"RECEIPT"`, the
 * dispatch screen `"DISPATCH"`, and both get the same panel.
 *
 * Uploading is disabled until the record has an id — a draft that has never been
 * saved has nothing to attach to, and the old screens let you pick a file anyway and
 * then dropped it silently on save.
 */
export function AttachmentsPanel({
  entityType,
  entityId,
  category,
  readOnly = false,
}: {
  entityType: string;
  entityId?: number | null;
  category?: string;
  readOnly?: boolean;
}) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const key = ["wh-attachments", entityType, entityId];

  const { data = [], isLoading } = useQuery({
    queryKey: key,
    queryFn: () => listAttachments(entityType, entityId as number),
    enabled: !!entityId,
  });

  const upload = useMutation({
    mutationFn: (file: File) => uploadAttachment(entityType, entityId as number, file, category),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => deleteAttachment(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  const size = (bytes?: number | null) => {
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  return (
    <div>
      <ErrorBanner error={upload.error ?? remove.error} />

      {!readOnly && (
        <div className="mb-3 flex items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload.mutate(file);
              e.target.value = "";
            }}
          />
          <Button
            variant="subtle"
            onClick={() => fileRef.current?.click()}
            disabled={!entityId || upload.isPending}
          >
            <Upload className="h-4 w-4" /> {upload.isPending ? "Uploading…" : "Attach a file"}
          </Button>
          {!entityId && <span className="text-xs text-muted">Save the document first.</span>}
        </div>
      )}

      {isLoading ? (
        <div className="py-6 text-center text-sm text-muted">Loading…</div>
      ) : data.length === 0 ? (
        <div className="flex items-center gap-2 rounded-xl border border-dashed border-line px-4 py-6 text-sm text-muted">
          <Paperclip className="h-4 w-4" /> No documents attached.
        </div>
      ) : (
        <ul className="space-y-2">
          {data.map((a) => (
            <li
              key={a.id}
              className="flex min-h-11 items-center gap-3 rounded-xl border border-line/70 bg-content1 px-3 py-2"
            >
              <FileText className="h-4 w-4 shrink-0 text-muted" />
              <a
                href={a.file_path}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate text-sm font-medium text-brand hover:underline"
              >
                {a.file_name}
              </a>
              <span className="hidden shrink-0 text-[11px] text-muted sm:inline">
                {a.doc_category ? `${a.doc_category} · ` : ""}
                {size(a.file_size)}
              </span>
              <span className="hidden shrink-0 text-[11px] text-muted lg:inline">
                {a.uploaded_by_name ?? "—"} · {fmtDateTime(a.created_at)}
              </span>
              {!readOnly && (
                <button
                  type="button"
                  aria-label={`Remove ${a.file_name}`}
                  onClick={() => remove.mutate(a.id)}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:text-bad"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
