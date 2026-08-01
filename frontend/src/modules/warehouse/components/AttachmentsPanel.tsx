import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Paperclip, Trash2, Upload } from "lucide-react";
import { Button, ErrorBanner } from "@/shared/components";
import { deleteAttachment, downloadAttachment, listAttachments, uploadAttachment } from "../api";
import { fmtDateTime } from "../format";

/**
 * Documents hung off a warehouse record — invoice copies, LR slips, QC certificates,
 * proof of delivery.
 *
 * `sys_attachments` is keyed by `(entity_type, entity_id)`, so this component takes
 * that pair and needs no per-document wiring: the GRN screen passes `"RECEIPT"`, the
 * dispatch screen `"DISPATCH"`, and both get the same panel.
 *
 * A record that has never been saved has no id to attach to, and the panel used to
 * simply disable itself — on a new material inward that reads as "documents do not
 * work". Files picked before the first save are held here instead and handed to the
 * parent through `onStagedChange`; the form uploads them the moment the record has an
 * id. Nothing is silently dropped either way.
 */
export function AttachmentsPanel({
  entityType,
  entityId,
  category,
  readOnly = false,
  onStagedChange,
}: {
  entityType: string;
  entityId?: number | null;
  category?: string;
  readOnly?: boolean;
  /** Called with the files picked before the record exists, newest list each time. */
  onStagedChange?: (files: File[]) => void;
}) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [staged, setStaged] = useState<File[]>([]);
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

  /** Opens the file in a new tab. The href cannot be the API path directly — the
   *  download endpoint needs the bearer token, which an <a> does not send. */
  const open = useMutation({
    mutationFn: async (id: number) => {
      const blob = await downloadAttachment(id);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      // Revoked on a timer: revoking immediately can beat the new tab to the data.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  });

  const stage = (files: File[]) => {
    setStaged(files);
    onStagedChange?.(files);
  };

  /** Once the record has an id the parent has uploaded what was staged, and the server
   *  list is the truth — keeping the staged copies would show every file twice. */
  useEffect(() => {
    if (entityId) stage([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId]);

  const pick = (file: File) => (entityId ? upload.mutate(file) : stage([...staged, file]));

  const size = (bytes?: number | null) => {
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const nothingYet = data.length === 0 && staged.length === 0;

  return (
    <div>
      <ErrorBanner error={upload.error ?? remove.error ?? open.error} />

      {!readOnly && (
        <div className="mb-3 flex items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) pick(file);
              e.target.value = "";
            }}
          />
          <Button
            variant="subtle"
            onClick={() => fileRef.current?.click()}
            disabled={upload.isPending}
          >
            <Upload className="h-4 w-4" /> {upload.isPending ? "Uploading…" : "Attach a file"}
          </Button>
          {!entityId && staged.length > 0 && (
            <span className="text-xs text-muted">
              {staged.length === 1 ? "1 file" : `${staged.length} files`} upload when you save.
            </span>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="py-6 text-center text-sm text-muted">Loading…</div>
      ) : nothingYet ? (
        <div className="flex items-center gap-2 rounded-xl border border-dashed border-line px-4 py-6 text-sm text-muted">
          <Paperclip className="h-4 w-4" /> No documents attached.
        </div>
      ) : (
        <ul className="space-y-2">
          {staged.map((file, i) => (
            <li
              key={`staged-${i}-${file.name}`}
              className="flex min-h-11 items-center gap-3 rounded-xl border border-dashed border-line bg-content1 px-3 py-2"
            >
              <FileText className="h-4 w-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                {file.name}
              </span>
              <span className="shrink-0 text-[11px] text-muted">
                {size(file.size)} · uploads on save
              </span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() => stage(staged.filter((_, x) => x !== i))}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:text-bad"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
          {data.map((a) => (
            <li
              key={a.id}
              className="flex min-h-11 items-center gap-3 rounded-xl border border-line/70 bg-content1 px-3 py-2"
            >
              <FileText className="h-4 w-4 shrink-0 text-muted" />
              <button
                type="button"
                onClick={() => open.mutate(a.id)}
                className="min-w-0 flex-1 truncate text-left text-sm font-medium text-brand hover:underline"
              >
                {a.file_name}
              </button>
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
