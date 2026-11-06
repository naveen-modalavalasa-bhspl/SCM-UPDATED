import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Snowflake } from "lucide-react";
import {
  Card, ErrorBanner, PageHeader, Select, StatusPill,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { rfqApi } from "../api";
import { money } from "./RequisitionListPage";
import type { RFQListRow, QuoteListRow } from "../types";

const SIZE = 100;

/**
 * Quotations — the reading room (2026-09-26).
 *
 * This register no longer answers "what does everyone charge" — that is Price
 * Compare's job, one tab over. It answers "what came back on THIS tender": pick
 * an RFQ at the top, and beneath it one card per supplier's quotation against
 * that tender. No rank, no best-price chips, no cross-RFQ price list — a buyer
 * reads one supplier's paper here and compares every paper in the studio.
 *
 * The drill-in (`/procurement/quotations/:id`) is where the quote's own life
 * happens: Request change, the price trail, the thread with the supplier.
 */
export function QuotationListPage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const rfqId = Number(params.get("rfq") ?? 0);

  // The tenders that can show something here. Any reply state is eligible —
  // even one response makes the tender worth opening.
  const { data: rfqPage, error: rfqError } = useQuery({
    queryKey: ["quotations-rfqs"],
    queryFn: () => rfqApi.list({ status: "PUBLISHED", page: 1, size: SIZE }),
  });
  const { data: closedPage } = useQuery({
    queryKey: ["quotations-rfqs-closed"],
    queryFn: () => rfqApi.list({ status: "CLOSED", page: 1, size: SIZE }),
  });
  const { data: awardedPage } = useQuery({
    queryKey: ["quotations-rfqs-awarded"],
    queryFn: () => rfqApi.list({ status: "AWARDED", page: 1, size: SIZE }),
  });

  const rfqOptions: RFQListRow[] = useMemo(() => {
    const seen = new Set<number>();
    const merged: RFQListRow[] = [];
    for (const page of [rfqPage, closedPage, awardedPage]) {
      for (const row of page?.items ?? []) {
        if (row.response_count > 0 && !seen.has(row.id)) {
          seen.add(row.id);
          merged.push(row);
        }
      }
    }
    return merged.sort((a, b) => b.id - a.id);
  }, [rfqPage, closedPage, awardedPage]);

  // Default to the newest tender with replies — the one a buyer most likely
  // came here for — while keeping their explicit choice sticky in the URL.
  const effectiveRfqId = rfqId || rfqOptions[0]?.id || 0;

  const selected = rfqOptions.find((r) => r.id === effectiveRfqId);

  const { data: quotes, isLoading, error } = useQuery({
    queryKey: ["quotations", effectiveRfqId],
    queryFn: () => rfqApi.quotations({ rfq_id: effectiveRfqId, page: 1, size: SIZE }),
    enabled: effectiveRfqId > 0,
  });

  const rows: QuoteListRow[] = quotes?.items ?? [];
  const quoted = rows.filter((r) => r.status !== "DRAFT");

  return (
    <div>
      <PageHeader
        eyebrow="Procurement"
        title="Quotations"
        actions={selected?.is_price_frozen ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700">
            <Snowflake className="h-3.5 w-3.5" /> Prices frozen
          </span>
        ) : undefined}
      />

      {/* The tender switcher. Carries the RFQ's identity and how far the replies
          have got, so the page answers "what came back on this tender" before
          the first card is read. */}
      <Card className="mb-4 p-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[300px] flex-1">
            <Select
              value={effectiveRfqId ? String(effectiveRfqId) : ""}
              placeholder="Pick a tender…"
              options={rfqOptions.map((r) => {
                const titleStr = r.title && r.title.trim() !== "" && r.title !== "Untitled" ? ` · ${r.title}` : "";
                return {
                  value: String(r.id),
                  label: `${r.rfq_no}${titleStr} · ${r.response_count}/${r.vendor_count} replied`,
                };
              })}
              onChange={(value) => {
                const next = new URLSearchParams(params);
                next.set("rfq", value);
                setParams(next, { replace: true });
              }}
            />
          </div>
          {selected && (
            <div className="flex items-center gap-3 text-xs text-muted">
              <span>
                Closes {selected.due_date ? fmtDate(selected.due_date) : "—"}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2">
                  <span
                    className="block h-full rounded-full bg-brand"
                    style={{
                      width: `${selected.vendor_count
                        ? Math.round((selected.response_count / selected.vendor_count) * 100)
                        : 0}%`,
                    }}
                  />
                </span>
                {selected.response_count} of {selected.vendor_count} suppliers responded
              </span>
            </div>
          )}
        </div>
      </Card>

      <ErrorBanner error={rfqError ?? error} />

      {effectiveRfqId > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {quoted.map((q) => (
            <button
              key={q.id}
              type="button"
              onClick={() => nav(`/procurement/quotations/${q.id}`)}
              className="group rounded-2xl border border-line bg-surface-2/40 p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-brand/30"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-3">
                  {/* Supplier initial tile — one glance says whose paper this is. */}
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-sm font-bold text-brand">
                    {(q.vendor_name ?? "?").trim().charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-ink">
                      {q.vendor_name ?? `Vendor ${q.vendor_id}`}
                    </div>
                    <div className="font-mono text-[11px] text-muted">
                      {q.quotation_no}
                    </div>
                    {q.organization_name && (
                      <div className="truncate text-[11px] text-muted">{q.organization_name}</div>
                    )}
                  </div>
                </div>
                <StatusPill status={q.status} />
              </div>
              <div className="mt-3 flex items-end justify-between border-t border-line/60 pt-3">
                <div className="text-xs text-muted">
                  {q.submitted_at ? `Submitted ${fmtDate(q.submitted_at)}` : "Not submitted"}
                  {q.revision_count > 0 ? ` · ${q.revision_count} revision${q.revision_count === 1 ? "" : "s"}` : ""}
                </div>
                <div className="font-mono text-base font-bold text-ink group-hover:text-brand">
                  {money(q.grand_total)}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {effectiveRfqId > 0 && !isLoading && quoted.length === 0 && (
        <Card className="p-10 text-center">
          <p className="text-sm font-semibold text-ink">No supplier has quoted this RFQ yet</p>
          <p className="mt-1 text-sm text-muted">
            Quotations appear here the moment a supplier submits from their portal.
          </p>
        </Card>
      )}

      {rfqOptions.length === 0 && !rfqError && (
        <Card className="p-10 text-center">
          <p className="text-sm font-semibold text-ink">Nothing to read yet</p>
          <p className="mt-1 text-sm text-muted">
            Publish an RFQ and its replies will gather here, one tender at a time.
          </p>
        </Card>
      )}
    </div>
  );
}
