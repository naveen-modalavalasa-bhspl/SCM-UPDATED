import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { AlertTriangle, ArrowRight, TrendingDown, TrendingUp } from "lucide-react";
import { ErrorBanner, NoticeChip, Textarea, useToast } from "@/shared/components";
import { Button } from "./ActionButton";
import { rfqApi } from "../api";
import { QuantityInput } from "@/shared/components/QuantityInput";
import { useUomDecimals } from "@/shared/hooks/useUomDecimals";
import { quantityProblem } from "@/shared/quantity";
import type { Quotation, QuoteItem } from "../types";
import {
  CombinationPicker, askedLabel, combinationKey, combinationLabel, comboFrom, comboPayload,
  useCombinationOptions, type CombinationValue,
} from "@/shared/combination";

const money = (n: number) =>
  `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A line the buyer is proposing to change: the supplier's numbers frozen on
 *  the left of every row, the ask on the right. */
interface DraftLine {
  quotation_item_id: number;
  item: QuoteItem;
  quantity: string;
  rate: string;
  discount_percent: string;
  note: string;
  included: boolean;
  /** The brand / variant / model asked of the supplier — the quoted one unless
   *  the buyer picks another (2026-10-26). */
  combo?: CombinationValue;
}

/**
 * Request change — the buyer's ask on a supplier's quotation.
 *
 * Business rule: rates may only DECREASE (you ask for a better price, not a
 * worse one). Quantities can go up or down. The modal enforces this inline so
 * the buyer sees exactly which lines would be refused before they press Send.
 *
 * Two-pane sheet: LEFT = the quote exactly as priced (read-only, muted);
 * RIGHT = what the buyer proposes, with delta chips on every touched line.
 * The "New total" strip recomputes in the browser as a preview — states that
 * it is a preview, because the server's `_quote_totals` is the truth.
 *
 * Nothing here changes the quotation: this POSTs a change request, which the
 * SUPPLIER accepts or declines. An ask applied before the answer would be the
 * buyer negotiating with themselves.
 */
export function QuoteChangeRequestModal({ quote, onClose }: {
  quote: Quotation;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [drafts, setDrafts] = useState<DraftLine[]>(() =>
    quote.items.map((item) => ({
      quotation_item_id: item.id,
      item,
      quantity: String(item.quantity),
      rate: String(item.rate),
      discount_percent: String(item.discount_percent ?? 0),
      note: "",
      included: false,
      combo: comboFrom(item),
    })));
  const comboOptions = useCombinationOptions(quote.items.map((item) => item.item_id));
  const comboChanged = (d: DraftLine) =>
    !!d.combo?.brand_id && combinationKey(d.combo) !== combinationKey(comboFrom(d.item));

  const touched = drafts.filter((d) => d.included);

  const uomDecimals = useUomDecimals();
  // The net under the keyboard filter: a proposed quantity the unit cannot hold.
  const quantityInvalid = drafts.some((d) => Boolean(quantityProblem(d.quantity, {
    decimals: uomDecimals(quote.items.find((i) => i.id === d.quotation_item_id)?.uom_code),
  })));
  const update = (id: number, patch: Partial<DraftLine>) =>
    setDrafts(drafts.map((d) => (d.quotation_item_id === id ? { ...d, ...patch } : d)));

  const lineAmount = (d: DraftLine) =>
    Number(d.quantity || 0) * Number(d.rate || 0)
      * (1 - Number(d.discount_percent || 0) / 100);
  const originalAmount = (d: DraftLine) => Number(d.item.amount ?? 0);

  /** Rate violation: the buyer is asking for a HIGHER rate — not allowed. */
  const rateIncreased = (d: DraftLine) =>
    Number(d.rate) > Number(d.item.rate) + 1e-9;

  const newTotal = useMemo(() => {
    const kept = drafts.filter((d) => Number(d.quantity) > 0);
    const subtotal = kept.reduce((sum, d) => sum + lineAmount(d), 0);
    const tax = kept.reduce((sum, d) =>
      sum + lineAmount(d) * (Number(d.item.tax_percent ?? 0) / 100), 0);
    return subtotal + tax
      + Number(quote.freight_amount ?? 0) - Number(quote.discount_amount ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, quote.freight_amount, quote.discount_amount]);

  const propose = useMutation({
    mutationFn: () => rfqApi.proposeChange(quote.id, {
      reason: reason.trim(),
      lines: touched.map((d) => ({
        quotation_item_id: d.quotation_item_id,
        proposed_quantity: Number(d.quantity || 0),
        proposed_rate: Number(d.rate || 0),
        proposed_discount_percent: Number(d.discount_percent || 0),
        note: d.note || undefined,
        ...(comboChanged(d) ? comboPayload(d.combo) : {}),
      })),
    }),
    onSuccess: (cr) => {
      queryClient.invalidateQueries({ queryKey: ["quotations"] });
      queryClient.invalidateQueries({ queryKey: ["quotation", String(quote.id)] });
      queryClient.invalidateQueries({ queryKey: ["quote-change-requests", quote.id] });
      queryClient.invalidateQueries({ queryKey: ["quote-price-trail", quote.id] });
      toast.success(`${cr.cr_no} sent — awaiting the supplier's answer`);
      onClose();
    },
  });

  const changed = (d: DraftLine) =>
    Number(d.quantity) !== Number(d.item.quantity)
    || Number(d.rate) !== Number(d.item.rate)
    || Number(d.discount_percent) !== Number(d.item.discount_percent ?? 0)
    || comboChanged(d);

  /** The RFQ's quantity is the ceiling (2026-11-03): an amendment may ask for it or
   *  less, never more. The server refuses the same; this says it before Send. */
  const qtyCap = (d: DraftLine) => d.item.requested_quantity ?? null;
  const qtyAbove = (d: DraftLine) =>
    d.included && qtyCap(d) != null && Number(d.quantity) > Number(qtyCap(d));

  // Any included line with a rate increase blocks the send.
  const hasRateViolation = touched.some(rateIncreased) || touched.some(qtyAbove);
  const hasUnchanged = touched.some((d) => !changed(d));

  const canSend = !propose.isPending && !quantityInvalid
    && touched.length > 0
    && reason.trim().length >= 3
    && !hasRateViolation
    && !hasUnchanged;

  const totalDelta = newTotal - Number(quote.grand_total ?? 0);

  return (
    <Modal isOpen onClose={onClose} size="5xl" scrollBehavior="inside"
           classNames={{ base: "rounded-2xl border border-line/70 shadow-2xl" }}>
      <ModalContent>
        {/* ── Header ── */}
        <ModalHeader className="items-start gap-3 border-b border-line/60 pb-3">
          <NoticeChip tone="warning" />
          <div className="min-w-0 flex-1 pt-0.5">
            <span className="block text-sm font-semibold leading-5 text-ink">
              Request a change from {quote.vendor_name ?? "the supplier"}
            </span>
            <span className="text-xs font-normal text-muted">
              {quote.quotation_no} — rates can only go down; the supplier accepts or declines.
            </span>
          </div>
        </ModalHeader>

        <ModalBody className="pt-4">
          <ErrorBanner error={propose.error} />

          {/* ── Rule banner ── */}
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <p className="text-xs text-amber-800">
              <strong>Rates can only decrease.</strong> You can ask for a lower price or change
              the quantity (up or down); proposing a higher rate than the supplier quoted is not allowed.
            </p>
          </div>

          {/* ── Two-pane layout ── */}
          <div className="grid gap-3 md:grid-cols-2">
            {/* LEFT — the quote as sent */}
            <div className="rounded-xl border border-line bg-surface-2/40 p-4">
              <h4 className="mb-3 text-[11px] font-bold uppercase tracking-[0.06em] text-muted">
                As quoted
              </h4>
              <div className="space-y-2">
                {quote.items.map((item) => (
                  <div key={item.id}
                       className="rounded-lg border border-line/60 bg-white/60 px-3 py-2.5">
                    <div className="truncate text-sm font-medium text-ink">
                      {item.item_name ?? `Item ${item.item_id}`}
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-muted">
                        {item.quantity} {item.uom_code ?? ""} × {money(item.rate)}
                      </span>
                      <span className="font-mono text-xs font-semibold text-ink">
                        {money(item.amount)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-baseline justify-between border-t border-line/60 pt-2.5">
                <span className="text-xs text-muted">Quotation total</span>
                <span className="font-mono text-sm font-bold text-ink">
                  {money(Number(quote.grand_total))}
                </span>
              </div>
            </div>

            {/* RIGHT — the ask */}
            <div className="rounded-xl border border-brand/30 bg-brand/[0.03] p-4">
              <h4 className="mb-3 text-[11px] font-bold uppercase tracking-[0.06em] text-brand">
                Your ask
              </h4>
              {drafts.length === 0 && (
                <p className="text-sm text-muted">This quotation has no lines.</p>
              )}
              <div className="space-y-2">
                {drafts.map((d) => {
                  const amt = lineAmount(d);
                  const orig = originalAmount(d);
                  const amtDelta = d.included ? amt - orig : 0;
                  const rateUp = d.included && rateIncreased(d);
                  const isChanged = d.included && changed(d);

                  return (
                    <div key={d.quotation_item_id}
                         className={`rounded-lg border p-3 transition-colors ${
                           rateUp
                             ? "border-danger/40 bg-danger/[0.04]"
                             : isChanged
                             ? "border-brand/40 bg-white"
                             : "border-line bg-white/60"}`}>
                      {/* Line header with checkbox and delta chip */}
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-line text-brand focus:ring-brand/30"
                          checked={d.included}
                          onChange={(e) => update(d.quotation_item_id, { included: e.target.checked })}
                          aria-label={`Propose a change on ${d.item.item_name ?? "this line"}`}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                          {d.item.item_name ?? `Item ${d.item.item_id}`}
                        </span>
                        {isChanged && (
                          <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                            amtDelta < 0
                              ? "bg-success/10 text-success"
                              : "bg-danger/10 text-danger"}`}>
                            {amtDelta < 0
                              ? <TrendingDown className="h-3 w-3" />
                              : <TrendingUp className="h-3 w-3" />}
                            {amtDelta < 0 ? "−" : "+"}{money(Math.abs(amtDelta))}
                          </span>
                        )}
                      </label>

                      {d.included && (
                        <>
                          {/* The brand (2026-10-26): what was asked, what was quoted,
                              and — if the buyer wants another — what to ask for now. */}
                          {!!comboOptions.data?.[String(d.item.item_id)]?.length && (
                            <div className="mt-2.5 rounded-md border border-line/70 bg-content1 p-2">
                              <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] uppercase tracking-wide text-muted">
                                <span>Brand</span>
                                {askedLabel(d.item) && <span className="normal-case">RFQ asked: <b className="text-ink">{askedLabel(d.item)}</b></span>}
                                <span className="normal-case">Quoted: <b className={d.item.brand_changed ? "text-warn" : "text-ink"}>{combinationLabel(d.item) || "—"}</b></span>
                              </div>
                              <CombinationPicker
                                options={comboOptions.data?.[String(d.item.item_id)]}
                                value={d.combo}
                                ariaLabel={`Brand to ask for on ${d.item.item_name ?? "this line"}`}
                                onChange={(combo) => update(d.quotation_item_id, { combo })}
                              />
                              {comboChanged(d) && (
                                <div className="mt-1 text-[11px] font-semibold text-brand">
                                  Asking for {combinationLabel(d.combo)} instead of {combinationLabel(d.item)}
                                </div>
                              )}
                            </div>
                          )}
                          {/* Inputs row */}
                          <div className="mt-2.5 grid grid-cols-3 gap-2">
                            <label className="text-[10px] uppercase tracking-wide text-muted">
                              Qty
                              <QuantityInput
                                decimals={uomDecimals(quote.items.find((i) => i.id === d.quotation_item_id)?.uom_code)}
                                className="mt-0.5 h-9 w-full rounded-md border border-line bg-content1 px-2 text-sm text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                                value={d.quantity}
                                data-uom={d.item?.uom_code ?? ""}
                                onChange={(raw) => update(d.quotation_item_id, { quantity: raw })}
                                aria-label="Proposed quantity"
                              />
                            </label>
                            <label className={`text-[10px] uppercase tracking-wide ${rateUp ? "text-danger" : "text-muted"}`}>
                              Rate
                              <div className="relative mt-0.5">
                                <input
                                  type="text" inputMode="decimal"
                                  className={`h-9 w-full rounded-md border px-2 text-sm outline-none focus:ring-2 ${
                                    rateUp
                                      ? "border-danger bg-danger/5 text-danger focus:border-danger focus:ring-danger/20"
                                      : "border-line bg-content1 text-ink focus:border-brand focus:ring-brand/20"}`}
                                  value={d.rate}
                                  onChange={(e) => update(d.quotation_item_id, { rate: e.target.value })}
                                  aria-label="Proposed rate"
                                />
                              </div>
                            </label>
                            <label className="text-[10px] uppercase tracking-wide text-muted">
                              Disc %
                              <input
                                type="text" inputMode="decimal"
                                className="mt-0.5 h-9 w-full rounded-md border border-line bg-content1 px-2 text-sm text-ink outline-none focus:border-brand focus:ring-brand/20 focus:ring-2"
                                value={d.discount_percent}
                                onChange={(e) => update(d.quotation_item_id, { discount_percent: e.target.value })}
                                aria-label="Proposed discount percent"
                              />
                            </label>
                          </div>

                          {/* Quantity above the RFQ */}
                          {qtyAbove(d) && (
                            <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-danger/10 px-2.5 py-1.5">
                              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-danger" />
                              <span className="text-[11px] font-semibold text-danger">
                                The RFQ asked for {qtyCap(d)} {d.item.uom_code ?? ""} — ask for that or less, never more
                              </span>
                            </div>
                          )}
                          {d.included && !qtyAbove(d) && qtyCap(d) != null && (
                            <p className="mt-1 text-[10px] text-muted">Qty up to {qtyCap(d)} (the RFQ's) · can only be lowered</p>
                          )}

                          {/* Rate-increase error */}
                          {rateUp && (
                            <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-danger/10 px-2.5 py-1.5">
                              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-danger" />
                              <span className="text-[11px] font-semibold text-danger">
                                Rate cannot increase — the ask is ₹{(Number(d.rate) - Number(d.item.rate)).toFixed(2)} above the quote
                              </span>
                            </div>
                          )}

                          {/* Visual diff when changed */}
                          {isChanged && !rateUp && (
                            <div className="mt-2 flex items-center gap-1.5 rounded-md bg-white/80 px-2.5 py-1.5">
                              <span className="font-mono text-[11px] text-muted line-through">
                                {money(orig)}
                              </span>
                              <ArrowRight className="h-3 w-3 shrink-0 text-muted" />
                              <span className={`font-mono text-[11px] font-semibold ${amtDelta < 0 ? "text-success" : "text-danger"}`}>
                                {money(amt)}
                              </span>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* New total preview */}
              {touched.length > 0 && (
                <div className={`mt-3 flex items-center justify-between rounded-xl border px-3 py-2.5 ${
                  totalDelta < 0
                    ? "border-success/30 bg-success/[0.07]"
                    : "border-warn/30 bg-warn-bg"}`}>
                  <div>
                    <span className="text-[11px] text-muted">
                      Preview if they accept
                    </span>
                    {totalDelta !== 0 && (
                      <span className={`ml-2 text-[11px] font-semibold ${
                        totalDelta < 0 ? "text-success" : "text-danger"}`}>
                        ({totalDelta < 0 ? "−" : "+"}{money(Math.abs(totalDelta))})
                      </span>
                    )}
                  </div>
                  <span className="font-mono text-sm font-bold text-ink">
                    {money(newTotal)}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* ── Reason ── */}
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">
              Why are you asking? <span className="text-danger">*</span>
            </span>
            <Textarea
              value={reason}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setReason(e.target.value)}
              minRows={2}
              placeholder="e.g. Budget ceiling for this line is lower — can you meet ₹450?"
              aria-label="Reason for the change request"
            />
          </label>

          {/* Validation summary */}
          {hasRateViolation && (
            <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/[0.05] px-3 py-2.5">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
              <p className="text-xs text-danger">
                One or more lines propose a rate higher than the supplier's quote. Lower the rate or uncheck those lines.
              </p>
            </div>
          )}
        </ModalBody>

        <ModalFooter className="border-t border-line/60">
          <Button variant="subtle" onClick={onClose}>Cancel</Button>
          <Button
            disabled={!canSend}
            onClick={() => propose.mutate()}
          >
            {propose.isPending
              ? "Sending…"
              : `Send change request (${touched.length} line${touched.length === 1 ? "" : "s"})`}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
