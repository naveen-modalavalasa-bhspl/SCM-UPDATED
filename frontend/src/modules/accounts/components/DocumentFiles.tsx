import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Trash2, Upload } from "lucide-react";
import { errorMessage, useToast } from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { downloadFile, type DocumentEndpoints } from "../api";
import type { FiledDocument } from "../types";

const CATEGORY_LABEL: Record<string, string> = { INVOICE: "Invoice", DC: "Delivery challan" };

/**
 * Invoices and delivery challans filed against a document. One component for the four
 * places they appear — the supplier's PO, the carrier's shipment, the PO desk and the
 * accounts desk — so a file reads the same wherever it is opened. Upload buttons show
 * only when the caller passes `upload` (the portals); inside the company it is a list.
 */
export function DocumentFiles({
  queryKey, endpoints, categories, initial, emptyText = "Nothing filed yet.",
}: {
  queryKey: unknown[];
  endpoints: DocumentEndpoints;
  /** The kinds the uploader may file, e.g. ["INVOICE", "DC"]. One kind = one button. */
  categories?: string[];
  /** Already-loaded rows (the accounts read carries them), so no second request. */
  initial?: FiledDocument[];
  emptyText?: string;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<string>(categories?.[0] ?? "INVOICE");

  const docs = useQuery({
    queryKey, queryFn: endpoints.list, enabled: initial === undefined,
  });
  const rows = initial ?? docs.data ?? [];

  const done = (next: FiledDocument[]) => qc.setQueryData(queryKey, next);
  const upload = useMutation({
    mutationFn: (file: File) => endpoints.upload!(category, file),
    onSuccess: (next) => { done(next); toast.success(`${CATEGORY_LABEL[category] ?? category} uploaded`); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: number) => endpoints.remove!(id),
    onSuccess: (next) => { done(next); toast.success("File removed"); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const pick = (kind: string) => { setCategory(kind); input.current?.click(); };

  return (
    <div className="space-y-3">
      {endpoints.upload && categories && (
        <div className="flex flex-wrap gap-2">
          {categories.map((kind) => (
            <button key={kind} type="button" disabled={upload.isPending}
              onClick={() => pick(kind)}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line bg-content1 px-4 text-sm font-semibold text-brand hover:bg-brand-050 disabled:opacity-60">
              <Upload className="h-4 w-4" />
              {upload.isPending && category === kind ? "Uploading…" : `Upload ${CATEGORY_LABEL[kind] ?? kind}`}
            </button>
          ))}
          <input ref={input} type="file" hidden
            accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.doc,.docx"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) upload.mutate(file);
            }} />
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-muted">{docs.isLoading ? "Loading…" : emptyText}</p>
      ) : (
        <ul className="divide-y divide-line/70 rounded-xl border border-line/70">
          {rows.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <FileText className="h-4 w-4 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-ink">{d.file_name}</div>
                <div className="text-xs text-muted">
                  {CATEGORY_LABEL[d.doc_category ?? ""] ?? d.doc_category ?? "File"}
                  {d.uploaded_by_name ? ` · ${d.uploaded_by_name}` : ""}
                  {d.created_at ? ` · ${fmtDate(d.created_at)}` : ""}
                </div>
              </div>
              <button type="button" aria-label={`Download ${d.file_name}`}
                onClick={() => downloadFile(endpoints.downloadUrl(d.id), d.file_name)
                  .catch((e) => toast.error(errorMessage(e)))}
                className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-brand hover:bg-brand-050">
                <Download className="h-4 w-4" />
              </button>
              {endpoints.remove && (
                <button type="button" aria-label={`Remove ${d.file_name}`}
                  disabled={remove.isPending} onClick={() => remove.mutate(d.id)}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-red-600 hover:bg-red-50 disabled:opacity-60">
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
