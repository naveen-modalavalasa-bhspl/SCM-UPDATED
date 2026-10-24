import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftRight, ArrowUpRight, ChevronDown, Clock, History, Lock, Truck,
} from "lucide-react";
import {
  Can, Card, ConfirmModal, ErrorBanner, PageHeader, StatusPill, useToast,
} from "@/shared/components";
import { Button } from "../components/ActionButton";
import { fmtDate } from "@/shared/datetime";
import { errorMessage } from "@/shared/api/errors";
import { rfqApi } from "../api";
import { QuotationChat } from "../components/QuotationChat";
import { QuotePriceTrail } from "../components/QuotePriceTrail";
import { QuoteChangeRequestModal } from "../components/QuoteChangeRequestModal";
import { money } from "./RequisitionListPage";
import type { PriceTrailVersion } from "../types";
import { CombinationTag } from "@/shared/combination";

const GST_LABEL = (region?: string | null) =>
  region === "INTRA" ? "CGST + SGST (intra-state)" : "IGST (inter-state)";

export function QuotationDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const quoteId = Number(id);
  const [crOpen, setCrOpen] = useState(false);
  const [withdraw, setWithdraw] = useState(false);
  const [selectedVersionNum, setSelectedVersionNum] = useState<number | null>(null);

  const { data: quote, isLoading, error } = useQuery({
    queryKey: ["quotation", id],
    queryFn: () => rfqApi.quotation(quoteId),
    enabled: Number.isFinite(quoteId) && quoteId > 0,
  });

  const { data: parentRfq } = useQuery({
    queryKey: ["rfq", String(quote?.rfq_id)],
    queryFn: () => rfqApi.get(quote!.rfq_id),
    enabled: !!quote?.rfq_id,
  });

  const { data: crs = [] } = useQuery({
    queryKey: ["quote-change-requests", quoteId],
    queryFn: () => rfqApi.changeRequests(quoteId),
    enabled: Number.isFinite(quoteId) && quoteId > 0,
  });

  const { data: priceTrailVersions = [] } = useQuery<PriceTrailVersion[]>({
    queryKey: ["quote-price-trail", quoteId],
    queryFn: () => rfqApi.priceTrail(quoteId),
    enabled: Number.isFinite(quoteId) && quoteId > 0,
  });

  const openCr = crs.find((c) => c.status === "AWAITING_SUPPLIER");

  const withdrawCr = useMutation({
    mutationFn: () => openCr && quote
      ? rfqApi.withdrawChange(quote.id, openCr.id)
      : Promise.reject(new Error("No open request")),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["quote-change-requests", quoteId] });
      queryClient.invalidateQueries({ queryKey: ["quotation", id] });
      queryClient.invalidateQueries({ queryKey: ["quotations"] });
      setWithdraw(false);
      toast.success("Change request withdrawn");
    },
    onError: (e: unknown) => toast.error(errorMessage(e)),
  });

  if (isLoading) {
    return (
      <div>
        <PageHeader back={{ to: "/procurement/quotations", label: "Back to Quotations" }}
                    eyebrow="Procurement" title="Quotation" />
        <Card className="p-8 text-center text-sm text-muted">Loading…</Card>
      </div>
    );
  }
  if (error || !quote) {
    return (
      <div>
        <PageHeader back={{ to: "/procurement/quotations", label: "Back to Quotations" }}
                    eyebrow="Procurement" title="Quotation" />
        <ErrorBanner error={error} />
      </div>
    );
  }

  const awarded = quote.status === "ACCEPTED";
  const frozen = parentRfq?.is_price_frozen ?? false;
  const latestVersionNum = priceTrailVersions.length ? Math.max(...priceTrailVersions.map((v) => v.version)) : 1;

  // Selected version details for historical inspection
  const activeVersionObj = selectedVersionNum != null
    ? priceTrailVersions.find((v) => v.version === selectedVersionNum)
    : null;

  const canAmend = !awarded && !openCr && !frozen;

  return (
    <div>
      <PageHeader
        back={{ to: "/procurement/quotations", label: "Back to Quotations" }}
        eyebrow="Procurement"
        title={quote.quotation_no}
        actions={
          <>
            {quote.under_negotiation && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700">
                Under negotiation
              </span>
            )}
            <StatusPill status={quote.status} />
            {quote.accepted_revision ? (
              <span className="rounded-full bg-surface-2 px-3 py-1.5 text-xs font-medium text-body">
                v{quote.accepted_revision + 1} pricing
              </span>
            ) : null}
            <Can do="rfq.compare">
              <Button variant="subtle"
                      onClick={() => nav(`/procurement/compare?rfq=${quote.rfq_id}`)}>
                <ArrowUpRight className="mr-1.5 h-4 w-4" /> Compare all
              </Button>
            </Can>
            {canAmend && (
              <Button className="bg-brand text-white hover:bg-brand/90 font-medium shadow-sm inline-flex items-center gap-1.5"
                      onClick={() => setCrOpen(true)}>
                <ArrowLeftRight className="h-4 w-4" /> Amend quotation
              </Button>
            )}
          </>
        }
      />

      <ErrorBanner error={error} />

      {openCr && (
        <Card className="mb-4 border-amber-300 bg-amber-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-amber-800">
                {openCr.cr_no} awaiting the supplier&apos;s answer
              </p>
              <p className="mt-0.5 truncate text-xs text-amber-700">
                {openCr.lines.length} line{openCr.lines.length === 1 ? "" : "s"} proposed
                · sent {fmtDate(openCr.created_at)} by {openCr.proposed_by_name ?? "you"}
              </p>
            </div>
            <Button variant="subtle" disabled={withdrawCr.isPending}
                    onClick={() => setWithdraw(true)}>
              Withdraw request
            </Button>
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ── The paper ── */}
        <div className="space-y-4 lg:col-span-2">
          <Card className="p-4">
            {/* Version Switcher Bar */}
            {priceTrailVersions.length > 1 && (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand/20 bg-gradient-to-r from-brand/5 via-sky-50/50 to-indigo-50/40 p-3 shadow-sm">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand/10 text-brand">
                    <History className="h-4 w-4" />
                  </div>
                  <div>
                    <span className="block text-xs font-bold uppercase tracking-wider text-ink">Version History</span>
                    <span className="text-[11px] text-muted">Select version snapshot to view</span>
                  </div>
                </div>
                <div className="relative">
                  <select
                    value={selectedVersionNum ?? latestVersionNum}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setSelectedVersionNum(val === latestVersionNum ? null : val);
                    }}
                    className="h-9 rounded-xl border border-brand/30 bg-white py-1 pl-3.5 pr-9 text-xs font-bold text-ink shadow-sm outline-none transition-all hover:border-brand focus:border-brand focus:ring-2 focus:ring-brand/20 cursor-pointer appearance-none"
                  >
                    {[...priceTrailVersions]
                      .sort((a, b) => b.version - a.version)
                      .map((v) => (
                        <option key={v.version} value={v.version}>
                          v{v.version} {v.version === latestVersionNum ? "(Latest - Supplier Accepted)" : v.version === 1 ? "(Original Quote)" : v.cr_no ? `(${v.cr_no})` : ""}
                        </option>
                      ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                </div>
              </div>
            )}

            {/* Historical Version Notice Banner */}
            {activeVersionObj && selectedVersionNum !== latestVersionNum && (
              <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 flex items-center justify-between">
                <span>Viewing Supplier Accepted Snapshot for <strong>Version {activeVersionObj.version}</strong>.</span>
                <button
                  type="button"
                  onClick={() => setSelectedVersionNum(null)}
                  className="font-semibold text-brand hover:underline"
                >
                  Switch to Latest Version →
                </button>
              </div>
            )}

            {/* Vendor header */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-sm font-bold text-brand">
                  {(quote.vendor_name ?? "?").trim().charAt(0).toUpperCase()}
                </span>
                <div>
                  <h3 className="text-sm font-semibold text-ink">
                    {quote.vendor_name ?? `Vendor ${quote.vendor_id}`}
                  </h3>
                  <span className="text-[11px] text-muted">
                    {GST_LABEL(quote.tax_region)}
                    {quote.vendor_gstin ? ` · GSTIN ${quote.vendor_gstin}` : ""}
                  </span>
                </div>
              </div>
            </div>

            {/* Meta row */}
            <div className="mb-4 grid grid-cols-2 gap-x-6 gap-y-2 rounded-xl bg-surface-2/40 p-3 text-sm sm:grid-cols-4">
              <Fact label="Against RFQ" value={quote.rfq_no ?? `#${quote.rfq_id}`}
                    onOpen={() => nav(`/procurement/rfqs/${quote.rfq_id}`)} />
              <Fact label="Submitted"
                    value={quote.submitted_at ? fmtDate(quote.submitted_at) : "Not yet"} />
              <Fact label="Valid till"
                    value={quote.valid_till ? fmtDate(quote.valid_till) : "—"} />
              <Fact label="Delivery"
                    value={quote.delivery_days != null
                      ? `${quote.delivery_days} days` : "—"} />
            </div>

            {/* Line items table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted">
                    <th className="py-2 pr-3 font-semibold">Item</th>
                    <th className="py-2 pr-3 text-right font-semibold">Qty</th>
                    <th className="py-2 pr-3 text-right font-semibold">Rate</th>
                    <th className="py-2 pr-3 text-right font-semibold">Disc %</th>
                    <th className="py-2 pr-3 text-right font-semibold">GST %</th>
                    <th className="py-2 text-right font-semibold">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {((activeVersionObj?.lines && activeVersionObj.lines.length > 0)
                    ? activeVersionObj.lines.map((l: any, idx: number) => {
                        const qty = l.quantity ?? l.proposed_quantity ?? 0;
                        const rate = l.rate ?? l.proposed_rate ?? 0;
                        const disc = l.discount_percent ?? l.proposed_discount_percent ?? 0;
                        const tax = l.tax_percent ?? 0;
                        const gross = Number(qty) * Number(rate);
                        const net = gross - (gross * Number(disc)) / 100;
                        const amount = l.amount ?? net;
                        return {
                          id: l.quotation_item_id ?? l.id ?? idx,
                          item_name: l.item_name ?? `Item ${l.item_id ?? idx + 1}`,
                          item_code: l.item_code ?? "—",
                          quantity: qty,
                          rate: rate,
                          discount_percent: disc,
                          tax_percent: tax,
                          amount: amount,
                        };
                      })
                    : quote.items
                  ).map((item: any) => (
                    <tr key={item.id} className="border-b border-line/50">
                      <td className="py-2.5 pr-3">
                        <div className="font-medium text-ink">
                          {item.item_name ?? `Item ${item.item_id}`}
                        </div>
                        <div className="font-mono text-[11px] text-muted">
                          {item.item_code ?? "—"}
                        </div>
                        <CombinationTag value={item} className="mt-1" />
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono">{item.quantity}</td>
                      <td className="py-2.5 pr-3 text-right font-mono">{money(item.rate)}</td>
                      <td className="py-2.5 pr-3 text-right font-mono">
                        {item.discount_percent ?? 0}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono">
                        {item.tax_percent ?? 0}
                      </td>
                      <td className="py-2.5 text-right font-mono font-semibold text-ink">
                        {money(item.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals */}
            <div className="ml-auto mt-4 max-w-xs space-y-1 border-t border-line pt-3 text-sm">
              <Row label="Subtotal" value={money(activeVersionObj?.totals.sub_total ?? quote.sub_total)} />
              {Number(activeVersionObj?.totals.discount_amount ?? quote.discount_amount) > 0 && (
                <Row label="Discount" value={`− ${money(activeVersionObj?.totals.discount_amount ?? quote.discount_amount)}`} />
              )}
              <Row label="Tax" value={money(activeVersionObj?.totals.tax_amount ?? quote.tax_amount)} />
              {Number(activeVersionObj?.totals.freight_amount ?? quote.freight_amount) > 0 && (
                <Row label="Freight" value={money(activeVersionObj?.totals.freight_amount ?? quote.freight_amount)} />
              )}
              <div className="flex items-baseline justify-between border-t border-line pt-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Grand total
                </span>
                <span className="font-mono text-lg font-bold text-ink">
                  {money(activeVersionObj?.totals.grand_total ?? quote.grand_total)}
                </span>
              </div>
            </div>
          </Card>

          <QuotePriceTrail quotationId={quote.id} selectedVersion={selectedVersionNum} onSelectVersion={setSelectedVersionNum} />
        </div>

        {/* ── Right rail: chat + navigation + PO action ── */}
        <div className="space-y-4">
          <QuotationChat quotationId={quote.id} vendorName={quote.vendor_name}
                         side="BUYER" />

          {/* Actions Card */}
          <Card className="p-4">
            <h3 className="mb-3 text-sm font-semibold text-ink">Actions</h3>
            <div className="space-y-3">
              {/* Tender link */}
              <div className="flex items-center gap-2 text-sm">
                <Clock className="h-4 w-4 shrink-0 text-muted" />
                <button className="text-brand hover:underline"
                        onClick={() => nav(`/procurement/rfqs/${quote.rfq_id}`)}>
                  Open the tender {quote.rfq_no ? `(${quote.rfq_no})` : ""}
                </button>
              </div>

              {/* Price compare link */}
              <Can do="rfq.compare">
                <div className="flex items-center gap-2 text-sm">
                  <ArrowLeftRight className="h-4 w-4 shrink-0 text-muted" />
                  <button className="text-brand hover:underline"
                          onClick={() => nav(`/procurement/compare?rfq=${quote.rfq_id}`)}>
                    Compare all quotes
                  </button>
                </div>
              </Can>

              {/* Amend Quotation Button in Right Rail */}
              {canAmend && (
                <div className="mt-1 border-t border-line/60 pt-3">
                  <Button
                    className="w-full justify-center bg-brand text-white hover:bg-brand/90 font-medium shadow-sm"
                    onClick={() => setCrOpen(true)}
                  >
                    <ArrowLeftRight className="mr-1.5 h-4 w-4" /> Amend quotation
                  </Button>
                </div>
              )}

              {/* Award / PO state */}
              <div className="flex items-start gap-2 text-sm">
                <Truck className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                {awarded
                  ? <span className="text-body">Awarded on Compare Quotations.</span>
                  : <span className="text-muted">Not awarded. Award happens on Compare Quotations.</span>}
              </div>

              {/* Freeze state indicator */}
              {parentRfq && (
                <div className={`flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs ${
                  frozen
                    ? "bg-amber-50 text-amber-700"
                    : "bg-surface-2/60 text-muted"}`}>
                  <Lock className="h-3.5 w-3.5 shrink-0" />
                  {frozen
                    ? `Prices frozen${parentRfq.frozen_at ? ` · ${fmtDate(parentRfq.frozen_at)}` : ""}`
                    : "Prices not frozen yet — freeze on the RFQ page before raising a PO"}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      {crOpen && (
        <QuoteChangeRequestModal quote={quote} onClose={() => setCrOpen(false)} />
      )}
      <ConfirmModal
        isOpen={withdraw}
        title={`Withdraw ${openCr?.cr_no ?? "this request"}?`}
        message="The supplier will no longer see an open ask on this quotation. You can send a new one any time."
        confirmLabel="Withdraw"
        busy={withdrawCr.isPending}
        onConfirm={() => withdrawCr.mutate()}
        onClose={() => setWithdraw(false)}
      />
    </div>
  );
}

function Fact({ label, value, onOpen }: {
  label: string; value: string; onOpen?: () => void;
}) {
  return (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted">
        {label}
      </div>
      {onOpen ? (
        <button className="text-sm text-brand hover:underline" onClick={onOpen}>
          {value}
        </button>
      ) : (
        <div className="text-sm text-ink">{value}</div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-xs text-muted">{label}</span>
      <span className="font-mono text-sm text-body">{value}</span>
    </div>
  );
}
