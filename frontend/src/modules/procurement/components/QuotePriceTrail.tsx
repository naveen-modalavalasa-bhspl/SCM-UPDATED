import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, History } from "lucide-react";
import { Card, ErrorBanner } from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { rfqApi, supplierApi } from "../api";
import type { PriceTrailVersion, QuoteChangeRequest } from "../types";

const money = (n: number | null | undefined) =>
  n == null ? "—" : `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** One number that moved: struck-through before, arrow, after, delta. Green
 *  means the buyer pays LESS — stated once in the legend below, never assumed
 *  from context. */
function Diff({ label, before, after, isQty = false }: {
  label: string; before: number; after: number; isQty?: boolean;
}) {
  const delta = after - before;
  const changed = Math.abs(delta) > 1e-9;
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      <span className="text-right font-mono">
        {changed ? (
          <>
            <span className="mr-2 text-xs text-muted line-through">
              {isQty ? before : money(before)}
            </span>
            <span className="text-sm font-bold text-ink">
              {isQty ? after : money(after)}
            </span>
            <span className={`ml-2 text-xs font-bold ${
              isQty
                ? (delta < 0 ? "text-amber-600" : "text-emerald-600")
                : (delta < 0 ? "text-emerald-600" : "text-rose-600")
            }`}>
              ({delta > 0 ? "+" : ""}{isQty ? delta : money(Math.abs(delta))})
            </span>
          </>
        ) : (
          <span className="text-sm font-semibold text-body">
            {isQty ? after : money(after)}
          </span>
        )}
      </span>
    </div>
  );
}

const CR_STATUS_LABEL: Record<string, string> = {
  AWAITING_SUPPLIER: "Awaiting supplier",
  ACCEPTED: "Accepted",
  DECLINED: "Declined",
  WITHDRAWN: "Withdrawn",
  SUPERSEDED: "Superseded",
};

/**
 * The Price Trail: every version this quotation has been, oldest first.
 *
 * Served by `GET /api/rfqs/quotations/{id}/price-trail` (buyer) and mirrored on
 * the portal route (supplier) — ONE trail, ONE writer, so the buyer's screen and
 * the supplier's portal can never disagree about what version a price belongs
 * to. This component formats; it never recomputes.
 */
export function QuotePriceTrail({
  quotationId, rfqId, side = "BUYER",
  selectedVersion, onSelectVersion,
}: {
  quotationId?: number;
  rfqId?: number;
  side?: "BUYER" | "SUPPLIER";
  selectedVersion?: number | null;
  onSelectVersion?: (v: number | null) => void;
}) {
  const [localVersion, setLocalVersion] = useState<number | null>(null);
  const activeVersion = selectedVersion !== undefined ? selectedVersion : localVersion;
  const setActiveVersion = (v: number | null) => {
    setLocalVersion(v);
    onSelectVersion?.(v);
  };

  const targetId = side === "SUPPLIER" ? (rfqId || quotationId || 0) : (quotationId || 0);

  const trail = useQuery({
    queryKey: side === "SUPPLIER" ? ["supplier-quote-price-trail", targetId] : ["quote-price-trail", targetId],
    queryFn: () => side === "SUPPLIER" ? supplierApi.priceTrail(targetId) : rfqApi.priceTrail(targetId),
    enabled: Number.isFinite(targetId) && targetId > 0,
  });
  const crs = useQuery({
    queryKey: side === "SUPPLIER" ? ["supplier-quote-change-requests", targetId] : ["quote-change-requests", targetId],
    queryFn: () => side === "SUPPLIER" ? supplierApi.changeRequests(targetId) : rfqApi.changeRequests(targetId),
    enabled: Number.isFinite(targetId) && targetId > 0,
  });

  if (trail.error) {
    return <ErrorBanner error={trail.error} />;
  }
  const versions: PriceTrailVersion[] = trail.data ?? [];
  const requests: QuoteChangeRequest[] = crs.data ?? [];
  const latestVersionNum = versions.length ? Math.max(...versions.map((v) => v.version)) : 1;

  const displayedVersions = activeVersion != null
    ? versions.filter((v) => v.version === activeVersion)
    : versions;

  return (
    <Card className="p-5 border-0 shadow-lg ring-1 ring-black/5 bg-white">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand/10 text-brand">
            <History className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-ink">Price Trail</h3>
            <p className="text-[11px] text-muted">
              Displays buyer requested quantities & proposed rates, version by version
            </p>
          </div>
        </div>

        {versions.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted">Version Filter:</span>
            <div className="relative">
              <select
                value={activeVersion === null ? "all" : String(activeVersion)}
                onChange={(e) => {
                  const val = e.target.value;
                  setActiveVersion(val === "all" ? null : Number(val));
                }}
                className="h-9 rounded-xl border border-brand/30 bg-surface-2/60 py-1 pl-3 pr-8 text-xs font-bold text-ink shadow-sm outline-none transition-all hover:border-brand focus:border-brand focus:ring-2 focus:ring-brand/20 cursor-pointer appearance-none"
              >
                <option value="all">All Versions (Price Trail)</option>
                {[...versions].sort((a, b) => b.version - a.version).map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version} {v.version === 1 ? "(Original Quote)" : v.cr_no ? `(${v.cr_no} - Buyer Request)` : "(Change Request)"}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            </div>
          </div>
        )}
      </div>

      {versions.length <= 1 && requests.length === 0 && (
        <p className="py-3 text-center text-sm text-muted">
          Original offer only — no buyer change requests have been made yet.
        </p>
      )}

      {displayedVersions.length === 0 && versions.length > 0 && (
        <p className="py-3 text-center text-sm text-muted">
          No data found for Version {activeVersion}.
        </p>
      )}

      <ol className="relative space-y-4 border-l-2 border-brand/20 pl-5">
        {displayedVersions.map((v) => {
          const isCurrent = v.version === latestVersionNum;
          return (
            <li key={v.version} className="relative">
              {/* The version dot. Current version stands out; history recedes. */}
              <span className={`absolute -left-[27px] top-1.5 h-3.5 w-3.5 rounded-full border-2 border-white ${
                isCurrent ? "bg-brand ring-2 ring-brand/30" : "bg-line"}`} />
              <div className={`rounded-2xl border p-4 transition-all ${
                isCurrent ? "border-brand/40 bg-gradient-to-br from-brand/[0.04] to-sky-50/30 shadow-md" : "border-line bg-surface-2/30"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="text-sm font-bold text-ink">
                      Version {v.version}
                    </span>
                    <span className="ml-2 rounded-full bg-surface-2 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-body">
                      {v.source === "CHANGE_REQUEST" ? `Buyer Request ${v.cr_no}` : "Original Supplier Quote"}
                    </span>
                  </div>
                  <span className="text-xs text-muted">
                    {v.effective_at ? fmtDate(v.effective_at) : ""} · by {v.changed_by ?? "—"}
                  </span>
                </div>
                {v.reason && (
                  <p className="mt-1.5 text-xs italic text-muted">“{v.reason}”</p>
                )}

                {/* Render Version-wise Buyer Requested Lines */}
                {v.source === "CHANGE_REQUEST" && ((v.buyer_requested_lines as any[]) ?? (v.lines as any[]))?.length > 0 && (
                  <div className="mt-3 space-y-2 border-t border-line/60 pt-3">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-amber-700 mb-1 flex items-center justify-between">
                      <span>Buyer Requested Quantities & Rates:</span>
                      <span className="text-[10px] font-normal text-muted">Version wise proposed figures</span>
                    </div>
                    {((v.buyer_requested_lines as any[]) ?? (v.lines as any[])).map((line: any, idx: number) => {
                      const curQty = Number(line.current_quantity ?? line.quantity ?? 0);
                      const propQty = Number(line.proposed_quantity ?? line.quantity ?? 0);
                      const curRate = Number(line.current_rate ?? line.rate ?? 0);
                      const propRate = Number(line.proposed_rate ?? line.rate ?? 0);
                      const curDisc = Number(line.current_discount_percent ?? line.discount_percent ?? 0);
                      const propDisc = Number(line.proposed_discount_percent ?? line.discount_percent ?? 0);
                      const curAmt = Number(line.current_amount ?? (curQty * curRate * (1 - curDisc / 100)));
                      const propAmt = propQty * propRate * (1 - propDisc / 100);

                      return (
                        <div key={line.quotation_item_id ?? idx} className="rounded-xl border border-line bg-white/90 p-3 shadow-xs">
                          <div className="text-xs font-semibold text-ink">
                            {line.item_name ?? `Item ${line.item_id}`}
                            {line.item_code && (
                              <span className="ml-2 font-mono text-[10px] text-muted">{line.item_code}</span>
                            )}
                          </div>
                          <div className="mt-1.5 space-y-0.5">
                            <Diff label="Buyer Requested Qty" before={curQty} after={propQty} isQty />
                            <Diff label="Buyer Requested Rate" before={curRate} after={propRate} />
                            <Diff label="Buyer Requested Amount" before={curAmt} after={propAmt} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {v.totals?.grand_total != null && (
                  <div className="mt-3 border-t border-line/60 pt-2">
                    <div className="flex items-baseline justify-between">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                        {v.source === "CHANGE_REQUEST" ? `Buyer Requested Total (v${v.version})` : `Quotation Total (v${v.version})`}
                      </span>
                      <span className="font-mono text-base font-bold text-ink">
                        {money(v.totals.grand_total)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {requests.length > 0 && (
        <div className="mt-5 border-t border-line/60 pt-3">
          <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">
            Every Ask On This Quote
          </h4>
          <ul className="space-y-1.5">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-xs rounded-lg bg-surface-2/40 px-3 py-1.5">
                <span className="font-mono font-bold text-body">{r.cr_no}</span>
                <span className="min-w-0 flex-1 truncate text-muted">“{r.reason}”</span>
                <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase ${
                  r.status === "ACCEPTED"
                    ? "bg-emerald-100 text-emerald-800"
                    : r.status === "DECLINED"
                      ? "bg-rose-100 text-rose-800"
                      : r.status === "AWAITING_SUPPLIER"
                        ? "bg-amber-100 text-amber-800"
                        : "bg-surface-2 text-body"}`}>
                  {CR_STATUS_LABEL[r.status] ?? r.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-3 text-[11px] text-muted">
        Green indicates price/amount reduction (savings); red indicates price increase.
      </p>
    </Card>
  );
}

