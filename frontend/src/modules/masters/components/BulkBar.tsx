import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, FileUp, Loader2, Sheet } from "lucide-react";
import type { ReactNode } from "react";
import { Button, Can } from "@/shared/components";
import type { BulkApi, ImportPreview, ImportResult, ImportRow } from "../api";
import { ImportReview } from "./ImportReview";
import { TONE_BLUE } from "@/shared/components/tones";

/** `Can` requires a permission code. A few masters (the UOM conversions, the vendor
 *  rates) are declared without one, and those should stay visible rather than
 *  silently disappearing because a prop was undefined. */
function Gate({ perm, children }: { perm?: string; children: ReactNode }) {
  return perm ? <Can do={perm}>{children}</Can> : <>{children}</>;
}

/** Template / Export / Import for one master.
 *
 *  Every master is served by the same backend factory, so all three calls are the
 *  same three calls with a different path — this is one component used by every tab
 *  rather than a toolbar written 27 times.
 *
 *  Import is all-or-nothing on the server: a rejected file changes nothing, so the
 *  error can be shown in full and the admin fixes the sheet and re-uploads. That is
 *  why the failure message is rendered whole, newlines and all, instead of being
 *  truncated to a toast.
 *
 *  Every pick stops at `preview`, which writes nothing and reports what the server
 *  made of the sheet. Even a clean file needs an explicit Save: upload is selection,
 *  not permission to change master data. Problems can be corrected in `ImportReview`.
 */
export function BulkBar({ api, managePerm, queryKey, label }: {
  api: BulkApi;
  managePerm?: string;
  /** Invalidated after a successful import so the list reflects the new rows. */
  queryKey: string;
  label: string;
}) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"template" | "export" | "import" | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);

  const run = async (kind: "template" | "export", call: () => Promise<void>) => {
    setBusy(kind); setError(null); setResult(null);
    try {
      await call();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const done = (outcome: ImportResult) => {
    setResult(outcome);
    setPreview(null);
    qc.invalidateQueries({ queryKey: ["masters", queryKey] });
  };

  const upload = async (file: File) => {
    setBusy("import"); setError(null); setResult(null); setPreview(null);
    try {
      const draft = await api.preview(file);
      setPreview(draft);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(null);
      // Cleared so re-picking the same corrected file fires onChange again.
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const commit = async (rows: ImportRow[]) => {
    setBusy("import"); setError(null);
    try {
      done(await api.commit(rows));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const spin = (kind: string) =>
    busy === kind ? <Loader2 className="h-4 w-4 animate-spin" /> : null;

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" disabled={busy !== null}
                onClick={() => run("template", api.template)}>
          {spin("template") ?? <Sheet className="h-4 w-4" />} Template
        </Button>
        <Button className={TONE_BLUE} variant="ghost" disabled={busy !== null}
                onClick={() => run("export", () => api.export())}>
          {spin("export") ?? <Download className="h-4 w-4" />} Export
        </Button>
        <Gate perm={managePerm}>
          <Button variant="ghost" disabled={busy !== null}
                  onClick={() => fileRef.current?.click()}>
            {spin("import") ?? <FileUp className="h-4 w-4" />} Import
          </Button>
        </Gate>
        <input
          ref={fileRef} type="file" className="hidden"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          aria-label={`Import ${label}`}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </div>

      {preview && (
        <ImportReview
          preview={preview} label={label} busy={busy === "import"}
          onCommit={(rows) => void commit(rows)}
          onCancel={() => setPreview(null)}
        />
      )}
      {result && (
        <div className="mt-2 rounded-lg bg-ok-bg px-3 py-2 text-sm text-ok">
          Imported {result.total} row{result.total === 1 ? "" : "s"} —{" "}
          {result.created} created, {result.updated} updated
          {result.unchanged ? `, ${result.unchanged} unchanged` : ""}.
        </div>
      )}
      {error && (
        <div className="mt-2 rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">
          <div className="font-semibold">Nothing was saved.</div>
          <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap font-sans text-xs">
            {error}
          </pre>
        </div>
      )}
    </div>
  );
}
