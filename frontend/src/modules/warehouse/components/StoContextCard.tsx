import { ArrowRight, Lock, Truck, Warehouse } from "lucide-react";
import { StatusPill } from "@/shared/components";

/**
 * The Stock Transfer Order behind a material issue, said once at the top of the form
 * (2026-10-29): its number, its status, and the route it was approved for. The
 * destination is the ORDER's — locked here, and frozen by the server on save — because
 * an issue re-pointing a signed transfer would deliver somewhere nobody approved.
 */
export function StoContextCard({ stoNo, status, kind, strNo, fromName, toName, issueNo }: {
  stoNo: string;
  status?: string | null;
  kind?: "DIRECT" | "STR" | null;
  strNo?: string | null;
  fromName?: string | null;
  toName?: string | null;
  /** Shown when the card previews an order whose issue is not this page. */
  issueNo?: string | null;
}) {
  return (
    <div className="mb-4 overflow-hidden rounded-2xl border border-brand/30 bg-gradient-to-br from-brand/10 via-content1 to-content1 shadow-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand text-white shadow-sm">
          <Truck className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            {kind === "STR" ? "Stock Transfer Order · serves an STR" : "Stock Transfer Order"}
          </p>
          <p className="truncate font-mono text-base font-bold text-ink">{stoNo}</p>
        </div>
        {status && <StatusPill status={status} />}
        {kind === "STR" && strNo && (
          <span className="rounded-full bg-info-bg px-2.5 py-1 text-xs font-semibold text-info">
            STR <span className="font-mono">{strNo}</span>
          </span>
        )}
        {issueNo && (
          <span className="rounded-full bg-content2 px-2.5 py-1 text-xs font-semibold text-ink-700 ring-1 ring-line">
            Issue <span className="font-mono">{issueNo}</span>
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-brand/15 bg-content1/60 px-4 py-3 text-sm">
        <Warehouse className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium text-ink">{fromName ?? "—"}</span>
        <ArrowRight className="h-4 w-4 shrink-0 text-brand" aria-hidden />
        <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
          <span className="truncate font-semibold text-ink">{toName ?? "—"}</span>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand"
                title="The destination is the order's and cannot be changed on the issue">
            <Lock className="h-3 w-3" aria-hidden /> Locked
          </span>
        </span>
      </div>
    </div>
  );
}

/** The destination field of an STO's issue: shown, never chosen. */
export function LockedDestination({ name, stoNo }: { name?: string | null; stoNo: string }) {
  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium text-body">
        Destination warehouse <span className="text-bad">*</span>
      </span>
      <div className="flex min-h-11 items-center gap-2 rounded-md border border-brand/30 bg-brand/5 px-3 text-sm">
        <Lock className="h-4 w-4 shrink-0 text-brand" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-semibold text-ink">{name ?? "—"}</span>
      </div>
      <span className="mt-1 block text-xs text-muted">
        Locked from STO <span className="font-mono">{stoNo}</span> — an issue goes where its order was approved to.
      </span>
    </div>
  );
}
