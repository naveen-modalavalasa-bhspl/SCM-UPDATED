import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Download, X, Loader } from "lucide-react";
import { Button, Card } from "@/shared/components";

/**
 * Shared attachment viewer modal for all doctypes.
 *
 * Usage across modules:
 * - Warehouse: Documents on receipts, dispatch, QC inspections
 * - Indents: Receipt photos and bills on deliveries
 * - Procurement: Invoices, quotations, RFQ documents
 * - Logistics: Waybills, proof of delivery, transport documents
 * - Returns: Return authorization documents
 *
 * Supports: Images (PNG, JPG, GIF, WebP, SVG), PDFs, Text files, and others.
 */
/** The least a file has to carry to be previewed.
 *
 *  Deliberately NOT the warehouse's `AttachmentRead`: the Reports register serves a
 *  different row for the same file, and a viewer that insisted on `file_path` and
 *  `entity_type` would force one caller to fake columns the other owns. Anything with
 *  a name and a way to fetch its bytes can be shown. */
export interface Attachment {
  id: number;
  file_name: string;
  file_size?: number | null;
  mime_type?: string | null;
  doc_category?: string | null;
  uploaded_by_name?: string | null;
  /** Whichever stamp the caller's row carries; both names are read. */
  created_at?: string | null;
  uploaded_at?: string | null;
}

export function SharedAttachmentViewer<T extends Attachment>({
  attachments,
  initialIndex = 0,
  onClose,
  onDownload,
}: {
  attachments: T[];
  initialIndex?: number;
  onClose: () => void;
  /** Fetch this file's bytes. Takes the ROW, not an id, so each caller uses the route
   *  its own module already gates — the viewer never builds a URL of its own, which is
   *  what keeps it from becoming a second, ungated door onto the same files. */
  onDownload: (attachment: T) => Promise<Blob>;
}) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [content, setContent] = useState<{
    type: "image" | "pdf" | "text" | "other";
    data?: string;
    error?: string;
  }>({ type: "other" });
  const [isLoading, setIsLoading] = useState(true);
  const [pdfUrl, setPdfUrl] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const current = attachments[currentIndex];
  const mimeType = current?.mime_type || "";

  useEffect(() => {
    loadContent();
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
      if (content.data && content.type === "image") {
        URL.revokeObjectURL(content.data);
      }
    };
  }, [currentIndex]);

  async function loadContent() {
    setIsLoading(true);
    setContent({ type: "other" });
    setPdfUrl("");

    try {
      const blob = await onDownload(current);
      const mimeType = current.mime_type || "";

      if (mimeType.startsWith("image/")) {
        const url = URL.createObjectURL(blob);
        setContent({ type: "image", data: url });
      } else if (mimeType === "application/pdf") {
        const url = URL.createObjectURL(blob);
        setPdfUrl(url);
        setContent({ type: "pdf" });
      } else if (
        mimeType.startsWith("text/") ||
        mimeType === "application/json" ||
        mimeType === "application/xml" ||
        mimeType === "text/xml" ||
        mimeType === "text/csv"
      ) {
        const text = await blob.text();
        setContent({ type: "text", data: text });
      } else {
        setContent({ type: "other" });
      }
    } catch (error) {
      setContent({
        type: "other",
        error: error instanceof Error ? error.message : "Failed to load content",
      });
    } finally {
      setIsLoading(false);
    }
  }

  async function save() {
    if (!current) return;
    setSaving(true);
    try {
      const blob = await onDownload(current);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = current.file_name;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setSaving(false);
    }
  }

  function getFileIcon() {
    if (mimeType.startsWith("image/")) return "🖼️";
    if (mimeType === "application/pdf") return "📄";
    if (mimeType.includes("word") || mimeType.includes("vnd.openxmlformats-officedocument.wordprocessingml"))
      return "📝";
    if (mimeType.includes("sheet") || mimeType.includes("spreadsheet"))
      return "📊";
    if (mimeType.startsWith("text/") || mimeType === "application/json") return "📋";
    return "📎";
  }

  function getFileTypeDescription() {
    if (mimeType.startsWith("image/")) return "Image";
    if (mimeType === "application/pdf") return "PDF Document";
    if (mimeType.includes("word") || mimeType.includes("vnd.openxmlformats-officedocument.wordprocessingml"))
      return "Word Document";
    if (mimeType.includes("sheet") || mimeType.includes("spreadsheet"))
      return "Spreadsheet";
    if (mimeType.startsWith("text/")) return "Text File";
    if (mimeType === "application/json") return "JSON File";
    return "Document";
  }

  function next() {
    if (currentIndex < attachments.length - 1) setCurrentIndex(currentIndex + 1);
  }

  function prev() {
    if (currentIndex > 0) setCurrentIndex(currentIndex - 1);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 overflow-y-auto">
      <Card className="max-h-[90vh] w-full max-w-4xl flex flex-col overflow-hidden my-4">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line/70 px-6 py-4 flex-shrink-0">
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-ink truncate">{current?.file_name}</h2>
            <p className="text-xs text-muted mt-1">
              {currentIndex + 1} of {attachments.length}
              {current?.doc_category && ` • ${current.doc_category}`}
              {current?.file_size && ` • ${formatFileSize(current.file_size)}`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:bg-content2 hover:text-ink flex-shrink-0 ml-4"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto bg-black/5">
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <div className="flex flex-col items-center gap-3">
                <Loader className="h-8 w-8 animate-spin text-muted" />
                <p className="text-sm text-muted">Loading…</p>
              </div>
            </div>
          ) : content.type === "image" && content.data ? (
            <div className="flex items-center justify-center h-full p-6">
              <img
                src={content.data}
                alt={current?.file_name}
                className="max-h-full max-w-full object-contain rounded-lg shadow-lg"
              />
            </div>
          ) : content.type === "text" && content.data ? (
            <div className="h-full overflow-auto p-6">
              <pre className="font-mono text-sm text-ink bg-content1 p-4 rounded-lg border border-line/70 whitespace-pre-wrap break-words">
                <code>{content.data}</code>
              </pre>
            </div>
          ) : content.type === "pdf" ? (
            <div className="h-full flex flex-col items-center justify-center gap-6 p-6">
              {pdfUrl ? (
                <iframe
                  src={`${pdfUrl}#toolbar=1&navpanes=0&scrollbar=1`}
                  className="w-full h-full rounded-lg border border-line/70"
                  title={current?.file_name}
                />
              ) : (
                <>
                  <div className="text-6xl">{getFileIcon()}</div>
                  <div className="text-center">
                    <h3 className="font-semibold text-ink mb-2">PDF Document</h3>
                    <p className="text-xs text-muted">
                      Click Download to view in your PDF reader.
                    </p>
                  </div>
                </>
              )}
            </div>
          ) : content.error ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center max-w-md">
                <p className="text-sm text-bad mb-2">Failed to load content</p>
                <p className="text-xs text-muted">{content.error}</p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-6">
              <div className="text-6xl">{getFileIcon()}</div>
              <div className="text-center">
                <h3 className="font-semibold text-ink mb-2">{getFileTypeDescription()}</h3>
                <p className="text-xs text-muted">
                  Preview not available. Click Download to view.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-line/70 bg-content2 px-6 py-4 flex-shrink-0">
          <div className="flex gap-2">
            <Button
              variant="subtle"
              onClick={prev}
              disabled={currentIndex === 0}
              className="h-10 w-10 p-0 flex items-center justify-center"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="subtle"
              onClick={next}
              disabled={currentIndex === attachments.length - 1}
              className="h-10 w-10 p-0 flex items-center justify-center"
            >
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
          {/* Saved from the bytes we already fetched, never from a bare `href`: the
              download routes are behind a bearer token the api client attaches, and a
              plain anchor sends none — it 401s, or worse bounces the session. */}
          <Button variant="subtle" onClick={save} disabled={!current || saving}>
            <Download className="h-4 w-4" /> {saving ? "Saving…" : "Download"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function formatFileSize(bytes?: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
