import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileCheck2, ShieldAlert } from "lucide-react";
import { Button, Card, ErrorBanner } from "@/shared/components";
import { returnsApi } from "../api";
import { CERTIFICATE_CATEGORY } from "../types";
import type { StockReturn } from "../types";

/**
 * The disposal certificate — the one file that arrives after the document has been worked.
 *
 * A controlled disposal is the outcome for hazardous, cold-chain or regulated material. The
 * agency destroys it and hands the paperwork over days later, so this upload is deliberately
 * the exception to "attachments freeze at submit": `service.add_file` allows this category
 * past DRAFT, but only while a certificate is still owed and only for the raiser or the desk
 * that took the decision.
 *
 * Until it is on file the return cannot be acknowledged — `can_acknowledge` comes back false
 * and `acknowledge_return` refuses it as well. The missing button is UX; the service check is
 * the control.
 */
export function CertificatePanel({ doc }: { doc: StockReturn }) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: (file: File) => returnsApi.upload(doc.id, file, CERTIFICATE_CATEGORY),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["returns"] });
    },
    onError: (err: any) =>
      setError(err?.response?.data?.error ?? "That certificate could not be uploaded."),
  });

  if (!doc.needs_certificate) return null;

  if (doc.has_certificate) {
    return (
      <div className="flex items-start gap-2 rounded-xl bg-ok-bg px-3 py-2 text-sm text-ok">
        <FileCheck2 className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Disposal certificate on file
          {doc.decision?.disposal_agency ? ` from ${doc.decision.disposal_agency}` : ""}.
          This return can be closed.
        </span>
      </div>
    );
  }

  return (
    <Card className="p-4">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-lg font-bold text-ink">
            Disposal certificate outstanding
          </h2>
          <p className="mt-1 text-sm text-body">
            This was a controlled disposal
            {doc.decision?.disposal_agency
              ? ` by ${doc.decision.disposal_agency}`
              : ""}
            . The return cannot be closed until their certificate is on the document.
          </p>

          {error && <ErrorBanner error={error} />}

          {doc.can_attach_certificate ? (
            <>
              <input
                ref={input}
                type="file"
                accept="image/*,application/pdf"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) upload.mutate(file);
                  // Clearing is what lets the same file be picked again after a failure.
                  event.target.value = "";
                }}
              />
              <Button
                className="mt-3"
                disabled={upload.isPending}
                onClick={() => input.current?.click()}
              >
                {upload.isPending ? "Uploading…" : "Attach the certificate"}
              </Button>
            </>
          ) : (
            <p className="mt-2 text-xs text-muted">
              The person who raised this return, or the desk that decided it, posts the
              certificate.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
