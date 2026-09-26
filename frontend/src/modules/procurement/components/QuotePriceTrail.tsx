import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { Card, ErrorBanner } from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { rfqApi } from "../api";
import type { PriceTrailVersion, QuoteChangeRequest } from "../types";

const money = (n: number | null | undefined) =>
  n == null ? "—" : `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** One number that moved: struck-through before, arrow, after, delta. Green
 *  means the buyer pays LESS — stated once in the legend below, never assumed
 *  from context. */
function Diff({ label, before, after }: {
  label: string; before: number; after: number;
}) {
  const delta = after - before;
  const changed = Math.abs(delta) > 1e-9;
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-right">
        {changed ? (
          <>
            <span className="mr-2 text-xs text-muted line-through">{money(before)}</span>
            <span className="text-sm font-semibold text-ink">{money(after)}</span>
            <span className={`ml-2 text-xs font-semibold ${delta < 0 ? "text-success" : "text-danger"}`}>
              {delta < 0 ? "−" : "+"}{money(Math.abs(delta)).replace("₹", "₹")}
            </span>
          </>
        ) : (
          <span className="text-sm text-body">{money(after)}</span>
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
import { useState } from "react";
import { supplierApi } from "../api";

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
    <Card className="p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-brand" />
          <h3 className="text-sm font-semibold text-ink">Price trail</h3>
          <span className="text-xs text-muted">
            what changed, version by version
          </span>
        </div>
        {versions.length > 1 && (
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => setActiveVersion(null)}
              className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition ${
                activeVersion === null
                  ? "bg-brand text-white shadow-sm"
                  : "bg-surface-2/80 text-body hover:bg-surface-2 border border-line"
              }`}
            >
              All
            </button>
            {versions.map((v) => {
              const isSelected = activeVersion === v.version;
              return (
                <button
                  key={v.version}
                  type="button"
                  onClick={() => setActiveVersion(v.version)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition ${
                    isSelected
                      ? "bg-brand text-white shadow-sm"
                      : "bg-surface-2/80 text-body hover:bg-surface-2 border border-line"
                  }`}
                >
                  v{v.version} {v.version === 1 ? "(Original)" : v.cr_no ? `(${v.cr_no})` : ""}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {versions.length <= 1 && requests.length === 0 && (
        <p className="py-3 text-center text-sm text-muted">
          Original offer only — no changes have been agreed yet.
        </p>
      )}

      {displayedVersions.length === 0 && versions.length > 0 && (
        <p className="py-3 text-center text-sm text-muted">
          No data found for Version {activeVersion}.
        </p>
      )}

      <ol className="relative space-y-4 border-l-2 border-line pl-5">
        {displayedVersions.map((v) => {
          const cr = v.cr_no
            ? requests.find((r) => r.cr_no === v.cr_no)
            : undefined;
          const isCurrent = v.version === latestVersionNum;
          return (
            <li key={v.version} className="relative">
              {/* The version dot. Current version stands out; history recedes. */}
              <span className={`absolute -left-[27px] top-1.5 h-3.5 w-3.5 rounded-full border-2 border-white ${
                isCurrent ? "bg-brand ring-2 ring-brand/30" : "bg-line"}`} />
              <div className={`rounded-xl border p-3 ${
                isCurrent ? "border-brand/30 bg-brand/[0.04] shadow-md" : "border-line bg-surface-2/40"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="text-sm font-semibold text-ink">
                      Version {v.version}
                    </span>
                    <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-body">
                      {v.source === "CHANGE_REQUEST" ? `Change request ${v.cr_no}` : v.source}
                    </span>
                  </div>
                  <span className="text-xs text-muted">
                    {v.effective_at ? fmtDate(v.effective_at) : ""} · by {v.changed_by ?? "—"}
                  </span>
                </div>
                {v.reason && (
                  <p className="mt-1.5 text-xs italic text-muted">“{v.reason}”</p>
                )}
                {cr && (
                  <div className="mt-2 space-y-2 border-t border-line/60 pt-2">
                    {cr.lines.map((line) => (
                      <div key={line.quotation_item_id} className="rounded-lg bg-white/60 px-3 py-2">
                        <div className="text-xs font-medium text-ink">
                          {line.item_name ?? `Item ${line.item_id}`}
                          {line.item_code
                            && <span className="ml-2 font-mono text-[10px] text-muted">{line.item_code}</span>}
                        </div>
                        <Diff label="Qty" before={line.current_quantity}
                              after={line.proposed_quantity} />
                        <Diff label="Rate" before={line.current_rate}
                              after={line.proposed_rate} />
                        <Diff label="Amount" before={line.current_amount ?? 0}
                              after={line.current_amount != null
                                ? line.proposed_quantity * line.proposed_rate
                                  * (1 - line.proposed_discount_percent / 100)
                                : 0} />
                      </div>
                    ))}
                  </div>
                )}
                {v.totals?.grand_total != null && (
                  <div className="mt-2 border-t border-line/60 pt-2">
                    <div className="flex items-baseline justify-between">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                        Quotation total (v{v.version})
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
        <div className="mt-4 border-t border-line/60 pt-3">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            Every ask on this quote
          </h4>
          <ul className="space-y-1.5">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-mono text-body">{r.cr_no}</span>
                <span className="min-w-0 flex-1 truncate text-muted">{r.reason}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  r.status === "ACCEPTED"
                    ? "bg-success/10 text-success"
                    : r.status === "DECLINED"
                      ? "bg-danger/10 text-danger"
                      : r.status === "AWAITING_SUPPLIER"
                        ? "bg-warn-bg text-warn"
                        : "bg-surface-2 text-body"}`}>
                  {CR_STATUS_LABEL[r.status] ?? r.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-3 text-[11px] text-muted">
        Green means the change reduces what you pay; red means it increases it.
      </p>
    </Card>
  );
}
