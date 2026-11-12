import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, History } from "lucide-react";
import {
  Card, ConfirmModal, DocumentScopeStrip, ErrorBanner, Field, Input, StatusPill, Textarea, useToast,
} from "@/shared/components";
import { Button } from "@/modules/procurement/components/ActionButton";
import { fmtDate, todayIst } from "@/shared/datetime";
import { errorMessage } from "@/shared/api/errors";
import { supplierApi } from "@/modules/procurement/api";
import { QuotationChat } from "@/modules/procurement/components/QuotationChat";
import { QuotePriceTrail } from "@/modules/procurement/components/QuotePriceTrail";
import type { QuoteChangeRequest, QuoteOtpSent, QuoteSubmit } from "@/modules/procurement/types";
import {
  CombinationPicker, SUPPLIER_COMBINATIONS, askedLabel, combinationKey, combinationLabel,
  comboFrom, comboPayload, useCombinationOptions,
  type CombinationValue,
} from "@/shared/combination";
import { guardNumberKeys } from "@/shared/quantity";
import { QuantityInput } from "@/shared/components/QuantityInput";
import { useUomDecimals } from "@/shared/hooks/useUomDecimals";

const money = (n: number) =>
  `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface QuoteLine {
  rfq_item_id: number;
  item_id: number;
  /** The brand / variant / model offered — the buyer's ask, or another (2026-10-23). */
  combo?: CombinationValue;
  /** What the buyer asked for on the RFQ — the warning compares against it. */
  asked?: CombinationValue;
  askedLabel?: string;
  item_name: string;
  item_code: string;
  uom_code: string;
  /** What the vendor says they can supply. Typed, so it can be short of the ask. */
  quantity: string;
  /** What the RFQ asked for — the ceiling, and what the buyer will compare against. */
  requested: number;
  required_date?: string | null;
  rate: string;
  discount_percent: string;
  delivery_days: string;
  hsn_code?: string | null;
  /** The rate the item's HSN notifies, or null where the item has no HSN. */
  max_gst: number | null;
}

/**
 * The quote form.
 *
 * Totals are computed here for the vendor to see and recomputed server-side on save —
 * the browser's arithmetic is never trusted into the database. A vendor may re-submit
 * until the deadline; each save bumps `revision_count`, which the buyer can see.
 *
 * GST is not a vendor choice (SCM_0062): it is the rate the item's HSN notifies,
 * split into CGST + SGST or IGST by the two GSTINs' states — law, not negotiation.
 * Removing the edit removed the one way a mistyped number could refuse the whole
 * submission; what shows here is read-only, the same figure the server computes.
 */
export function SupplierRFQDetailPage() {
  const uomDecimals = useUomDecimals();
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const rfqId = Number(id);

  const [lines, setLines] = useState<QuoteLine[]>([]);
  const comboOptions = useCombinationOptions(lines.map((line) => line.item_id),
                                             SUPPLIER_COMBINATIONS);
  const [header, setHeader] = useState({
    vendor_ref_no: "", valid_till: "", expected_delivery_date: "",
    payment_terms: "", freight_amount: "", discount_amount: "", remarks: "",
  });

  const { data: rfq, error: rfqError } = useQuery({
    queryKey: ["supplier-rfq", id],
    queryFn: () => supplierApi.rfq(rfqId),
  });
  // The buyer's switch on the RFQ: no freight field unless they asked for it.
  const freightAsked = Boolean(rfq?.freight_required);

  const { data: quote, isLoading } = useQuery({
    queryKey: ["supplier-quote", id],
    queryFn: () => supplierApi.quotation(rfqId),
  });

  const { data: priceTrailVersions = [] } = useQuery({
    queryKey: ["supplier-quote-price-trail", id],
    queryFn: () => supplierApi.priceTrail(rfqId),
    enabled: Number.isFinite(rfqId) && rfqId > 0,
  });

  const [selectedVersionNum, setSelectedVersionNum] = useState<number | null>(null);
  const latestVersionNum = priceTrailVersions.length
    ? Math.max(...priceTrailVersions.map((v) => v.version))
    : 1;

  const activeVersionObj = selectedVersionNum != null
    ? priceTrailVersions.find((v) => v.version === selectedVersionNum)
    : null;

  useEffect(() => {
    if (!quote) return;
    setHeader({
      vendor_ref_no: quote.vendor_ref_no ?? "",
      valid_till: quote.valid_till ?? "",
      expected_delivery_date: quote.expected_delivery_date ?? "",
      payment_terms: quote.payment_terms ?? "",
      freight_amount: quote.freight_amount ? String(quote.freight_amount) : "",
      discount_amount: quote.discount_amount ? String(quote.discount_amount) : "",
      remarks: quote.remarks ?? "",
    });
    setLines(quote.items.map((item) => ({
      rfq_item_id: item.rfq_item_id ?? 0,
      item_id: Number(item.item_id),
      combo: comboFrom(item),
      asked: item.requested_brand_id ? {
        brand_id: item.requested_brand_id, variant_id: item.requested_variant_id || null,
        model_id: item.requested_model_id || null, brand_name: item.requested_brand_name ?? null,
        variant_name: item.requested_variant_name ?? null, model_name: item.requested_model_name ?? null,
      } : undefined,
      askedLabel: askedLabel(item),
      item_name: item.item_name ?? `Item ${item.item_id}`,
      item_code: item.item_code ?? "—",
      uom_code: item.uom_code ?? "",
      quantity: item.quantity ? String(item.quantity) : "",
      requested: Number(item.requested_quantity ?? item.quantity),
      required_date: item.required_date,
      rate: item.rate ? String(item.rate) : "",
      discount_percent: item.discount_percent ? String(item.discount_percent) : "",
      delivery_days: item.delivery_days == null ? "" : String(item.delivery_days),
      hsn_code: item.hsn_code,
      max_gst: item.max_gst_rate ?? null,
    })));
  }, [quote]);

  // Whether the supply is within a state or across one: it decides how the rate is
  // DESCRIBED (CGST + SGST, or IGST), never how much it is.
  const interstate = quote?.tax_region !== "INTRA";

  /** What this line is taxed at — the item's own HSN-notified rate, never a figure
   *  the vendor chose. Zero where the item has no HSN. */
  const taxRate = (line: QuoteLine) => Number(line.max_gst ?? 0);

  /** CGST+SGST within a state, IGST across one — the split, for display only. */
  const gstSplitLabel = (line: QuoteLine) => {
    const rate = taxRate(line);
    return interstate
      ? `IGST ${rate}%`
      : `CGST ${rate / 2}% + SGST ${rate / 2}%`;
  };

  /** The starred answers this quotation is still missing.
   *
   *  FIXED — the asterisk was the ONLY thing on this form saying a field had to be
   *  answered, and the submit ignored it: a quotation went in with no price on a line,
   *  no delivery days and no validity, and the buyer had to chase the vendor for the
   *  numbers the form had already asked for. The check reads the same fields the stars
   *  are drawn on, so the two can never disagree.
   *
   *  A rate of 0 counts as unanswered rather than as a free supply — the box opens at
   *  0, so "still 0" is what an untouched line looks like. */
  const gaps = useMemo(() => {
    const out: string[] = [];
    if (!header.valid_till) out.push("Valid until");
    if (!header.expected_delivery_date) out.push("Can deliver by");
    const count = (label: string, n: number) =>
      n ? out.push(`${label} on ${n} line${n === 1 ? "" : "s"}`) : 0;
    count("Rate", lines.filter((line) => !(Number(line.rate) > 0)).length);
    return out;
  }, [header.valid_till, header.expected_delivery_date, lines]);

  const totals = useMemo(() => {
    let sumNet = 0;
    let tax = 0;
    for (const line of lines) {
      const gross = Number(line.quantity || 0) * Number(line.rate || 0);
      const net = gross - (gross * Number(line.discount_percent || 0)) / 100;
      sumNet += net;
      tax += (net * taxRate(line)) / 100;
    }
    const sub = sumNet - Number(header.discount_amount || 0);
    const grand = sub + tax + (freightAsked ? Number(header.freight_amount || 0) : 0);
    return { sub, tax, grand };
  }, [lines, interstate, header.freight_amount, header.discount_amount, freightAsked]);

  const save = useMutation({
    mutationFn: () => {
      const payload: QuoteSubmit = {
        otp_code: otpCode.trim(),
        vendor_ref_no: header.vendor_ref_no || null,
        valid_till: header.valid_till || null,
        expected_delivery_date: header.expected_delivery_date || null,
        payment_terms: header.payment_terms || null,
        freight_amount: freightAsked ? Number(header.freight_amount || 0) : 0,
        discount_amount: Number(header.discount_amount || 0),
        remarks: header.remarks || null,
        // Always the HSN's notified rate (SCM_0062) — the server re-derives and
        // caps it the same way regardless of what is sent, so this is read-only
        // here too, not a value the vendor could still override.
        lines: lines.map((line) => ({
          rfq_item_id: line.rfq_item_id,
          quantity: Number(line.quantity || 0),
          rate: Number(line.rate || 0),
          discount_percent: Number(line.discount_percent || 0),
          tax_percent: taxRate(line),
          delivery_days: line.delivery_days ? Number(line.delivery_days) : null,
          ...comboPayload(line.combo),
        })),
      };
      return supplierApi.submitQuotation(rfqId, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["supplier-quote", id] });
      queryClient.invalidateQueries({ queryKey: ["supplier-rfqs"] });
      toast.success("Quotation submitted");
      nav("/supplier/rfqs");
    },
    onError: () => {
      // The code is spent by the ATTEMPT, not by the outcome — the server marks it
      // used before writing anything. Leaving the digits in the box would invite the
      // vendor to press Submit again with a code that can no longer work, and read
      // the second refusal as the screen being broken.
      setOtpCode("");
      setOtpSent(null);
    },
  });

  /* The code that stands between a drafted price and a submitted one. It is requested
   * here and typed here; everything that decides whether it is good — the window, the
   * attempt cap, whether it was already spent — is the server's, so this holds no
   * timer that could disagree with it. */
  const [otpCode, setOtpCode] = useState("");
  const [otpSent, setOtpSent] = useState<QuoteOtpSent | null>(null);

  const requestOtp = useMutation({
    mutationFn: () => supplierApi.requestQuoteOtp(rfqId),
    onSuccess: (sent) => {
      setOtpSent(sent);
      toast.success(`Code sent to ${sent.sent_to}`);
    },
  });

  const open = rfq?.status === "PUBLISHED";
  const set = (index: number, patch: Partial<QuoteLine>) =>
    setLines(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  // ── The buyer's change request (2026-09-26) ───────────────────────────────
  // The buyer may ask for different numbers; the SUPPLIER decides. This banner
  // is where that decision is made — accept re-prices the quotation through the
  // server's own arithmetic, decline leaves it byte-for-byte as quoted.
  const { data: changeRequests = [] } = useQuery({
    queryKey: ["supplier-quote-change-requests", id],
    queryFn: () => supplierApi.changeRequests(rfqId),
    enabled: Number.isFinite(rfqId) && rfqId > 0,
  });
  const openCr: QuoteChangeRequest | undefined =
    changeRequests.find((c) => c.status === "AWAITING_SUPPLIER");
  const [decideNote, setDecideNote] = useState("");
  const [decide, setDecide] = useState<"ACCEPT" | "DECLINE" | null>(null);
  const [counterMode, setCounterMode] = useState(false);
  const [counterEdits, setCounterEdits] = useState<Record<number, { qty: string; rate: string; discount: string; note?: string }>>({});
  /** What the RFQ asked for on a quotation line. A counter may offer more, but only
   *  with a reason on that line (2026-11-11). The server refuses the same. */
  const rfqAsked = (quotationItemId: number): number | null => {
    const item = quote?.items.find((row) => row.id === quotationItemId);
    const asked = item?.requested_quantity;
    return asked == null ? null : Number(asked);
  };
  const counterOver = (quotationItemId: number, qty: string) => {
    const asked = rfqAsked(quotationItemId);
    return asked != null && qty.trim() !== "" && Number(qty) > asked;
  };
  // The brand the supplier answers with (2026-10-26) — the buyer's ask by default.
  const [counterCombos, setCounterCombos] = useState<Record<number, CombinationValue | undefined>>({});

  useEffect(() => {
    if (openCr) {
      const edits: Record<number, { qty: string; rate: string; discount: string }> = {};
      openCr.lines.forEach((line) => {
        edits[line.quotation_item_id] = {
          qty: String(line.proposed_quantity),
          rate: String(line.proposed_rate),
          discount: String(line.proposed_discount_percent || 0),
        };
      });
      setCounterEdits(edits);
    }
  }, [openCr]);

  const answerCr = useMutation({
    mutationFn: ({ action, note, counterLines }: { action: "ACCEPT" | "DECLINE"; note: string; counterLines?: Record<string, unknown>[] }) =>
      action === "ACCEPT"
        ? supplierApi.acceptChange(rfqId, openCr!.id, note, counterLines, otpCode.trim())
        : supplierApi.declineChange(rfqId, openCr!.id, note),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["supplier-quote", id] });
      queryClient.invalidateQueries({ queryKey: ["supplier-quote-change-requests", id] });
      queryClient.invalidateQueries({ queryKey: ["supplier-quote-price-trail", id] });
      setDecide(null);
      setDecideNote("");
      setCounterMode(false);
      setOtpCode("");
      setOtpSent(null);
      toast.success(vars.action === "ACCEPT"
        ? (vars.counterLines?.length ? "Counter offer submitted & accepted" : "Accepted — your quotation now carries the agreed numbers")
        : "Declined — your quotation stands as you priced it");
    },
    onError: (e: unknown) => toast.error(errorMessage(e)),
  });

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      {/* Premium Hero Header */}
      <div className="relative mb-8 overflow-hidden rounded-3xl bg-gradient-to-br from-brand via-brand/90 to-brand/80 p-8 sm:p-10 text-white shadow-xl">
        <div className="absolute -right-20 -top-20 h-64 w-64 rounded-full bg-white/10 blur-3xl transition-transform duration-700 hover:scale-110" />
        <div className="absolute -bottom-20 -left-20 h-48 w-48 rounded-full bg-white/10 blur-2xl transition-transform duration-700 hover:scale-110" />
        <div className="relative z-10 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-white/80">
              <span className="h-1.5 w-1.5 rounded-full bg-white/80 animate-pulse" />
              Supplier Portal
            </p>
            <h1 className="font-display text-3xl font-extrabold tracking-tight sm:text-4xl">
              {rfq?.rfq_no ?? "Request"}
            </h1>
          </div>
          <button
            onClick={() => nav("/supplier/rfqs")}
            className="rounded-xl bg-white/20 px-4 py-2 text-sm font-semibold text-white shadow-sm backdrop-blur-md ring-1 ring-white/30 transition-all hover:bg-white/30 hover:scale-105"
          >
            Back to Your RFQs
          </button>
        </div>
      </div>

      <ErrorBanner error={rfqError ?? save.error} />

      {quote && <DocumentScopeStrip doc={quote} number={quote.quotation_no} className="mb-4" />}

      {rfq && (
        <Card className="mb-6 p-6 border-0 shadow-lg ring-1 ring-black/5 bg-gradient-to-r from-sky-50 to-indigo-50">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              {rfq.title && rfq.title.trim() !== "" && rfq.title !== "Untitled" && rfq.title !== "Untitled request" && (
                <h2 className="font-display text-lg font-bold text-ink mb-1">
                  {rfq.title}
                </h2>
              )}
              <p className="text-sm text-muted">
                {rfq.due_date ? `Closes ${fmtDate(rfq.due_date)}` : "No deadline"}
                {quote?.revision_count ? ` · you have revised ${quote.revision_count} time${quote.revision_count === 1 ? "" : "s"}` : ""}
              </p>
            </div>
            <StatusPill status={quote?.status ?? rfq.status} />
          </div>
          {rfq.terms && (
            <div className="mt-4 border-t border-line pt-4">
              <span className="block mb-1 text-xs font-semibold uppercase tracking-wider text-muted">
                Payment terms
              </span>
              <p className="text-sm text-body">{rfq.terms}</p>
            </div>
          )}
          {!open && (
            <p className="mt-4 rounded-lg bg-surface-2 px-3 py-2 text-sm text-body">
              This request is closed. You can read it, but it no longer accepts quotes.
            </p>
          )}
        </Card>
      )}

      {/* The buyer's ask. Amber, at the top, naming the buyer — a supplier should
          know WHO is asking before WHAT they are asking for. */}
      {openCr && (
        <Card className="mb-6 border border-amber-300 bg-amber-50 p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-amber-800">
                The buyer has proposed changes — {openCr.cr_no}
              </h2>
              <p className="mt-0.5 text-xs text-amber-700">
                Proposed by {openCr.proposed_by_name ?? "the buyer"} · {fmtDate(openCr.created_at)}
              </p>
              <p className="mt-2 text-sm italic text-amber-800">“{openCr.reason}”</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button className="bg-emerald-600 text-white hover:bg-emerald-700"
                      onClick={() => { setDecide("ACCEPT"); setDecideNote(""); }}>
                Accept buyer prices
              </Button>
              <Button variant="subtle" className="border-brand text-brand hover:bg-brand/10"
                      onClick={() => setCounterMode(!counterMode)}>
                {counterMode ? "Cancel counter" : "Counter-propose prices"}
              </Button>
              <Button variant="subtle" className="border-amber-300"
                      onClick={() => { setDecide("DECLINE"); setDecideNote(""); }}>
                Decline
              </Button>
            </div>
          </div>

          {counterMode ? (
            <div className="mt-4 space-y-3 rounded-xl border border-brand/30 bg-white p-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-brand">
                Counter-Offer: Adjust Prices or Quantities
              </h3>
              <p className="text-xs text-muted">
                Specify your requested rates and quantities. Submitting will update the quotation with these agreed counter values.
              </p>
              <div className="space-y-3">
                {openCr.lines.map((line) => {
                  const edit = counterEdits[line.quotation_item_id] ?? {
                    qty: String(line.proposed_quantity),
                    rate: String(line.proposed_rate),
                    discount: String(line.proposed_discount_percent || 0),
                  };
                  return (
                    <div key={line.quotation_item_id} className="rounded-lg border border-line bg-surface-2/30 p-3">
                      <div className="text-xs font-semibold text-ink">
                        {line.item_name ?? `Item ${line.item_id}`}
                        <span className="ml-2 text-muted">Original: Qty {line.current_quantity} @ ₹{line.current_rate} | Buyer Asked: Qty {line.proposed_quantity} @ ₹{line.proposed_rate}</span>
                      </div>
                      {(line.proposed_combination || line.current_combination) && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
                          <span className="text-muted">Brand quoted: <b className="text-ink">{line.current_combination ?? "—"}</b></span>
                          {line.proposed_combination && (
                            <span className="rounded-md bg-brand/10 px-2 py-0.5 font-semibold text-brand">
                              Buyer asks for {line.proposed_combination}
                            </span>
                          )}
                        </div>
                      )}
                      {!!line.item_id && !!comboOptions.data?.[String(line.item_id)]?.length && (() => {
                        const current: CombinationValue | undefined = line.current_brand_id ? {
                          brand_id: line.current_brand_id, variant_id: line.current_variant_id || null,
                          model_id: line.current_model_id || null } : undefined;
                        const asked: CombinationValue | undefined = line.proposed_brand_id ? {
                          brand_id: line.proposed_brand_id, variant_id: line.proposed_variant_id || null,
                          model_id: line.proposed_model_id || null } : undefined;
                        const value = counterCombos[line.quotation_item_id] ?? asked ?? current;
                        return (
                          <div className="mt-2 max-w-md">
                            <label className="block text-[11px] text-muted">Counter brand · variant · model</label>
                            <CombinationPicker
                              options={comboOptions.data?.[String(line.item_id)]}
                              value={value}
                              ariaLabel={`Brand to counter with on ${line.item_name ?? "this line"}`}
                              onChange={(combo) => setCounterCombos({ ...counterCombos, [line.quotation_item_id]: combo })}
                            />
                            {asked && value?.brand_id && combinationKey(value) !== combinationKey(asked) && (
                              <div className="mt-1 rounded-md border border-warn/40 bg-warn-bg px-2 py-1 text-[11px] text-warn">
                                ⚠ Not the {line.proposed_combination} the buyer asked for — they will see the change.
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <div>
                          <label className="block text-[11px] text-muted">Counter Quantity</label>
                            <QuantityInput
                              decimals={uomDecimals(line.uom_code)} min={0}
                              value={edit.qty}
                              data-uom={line.uom_code ?? ""}
                              onChange={(raw) => setCounterEdits({ ...counterEdits, [line.quotation_item_id]: { ...edit, qty: raw } })}
                              className={`h-9 w-full rounded-md border bg-white px-2 text-xs text-ink outline-none ${
                                counterOver(line.quotation_item_id, edit.qty)
                                  ? "border-danger focus:border-danger" : "border-line focus:border-brand"}`}
                            />
                          {rfqAsked(line.quotation_item_id) != null && (
                            <p className={`mt-1 text-[10px] ${counterOver(line.quotation_item_id, edit.qty) ? "font-semibold text-warn" : "text-muted"}`}>
                              {counterOver(line.quotation_item_id, edit.qty)
                                ? `More than the ${rfqAsked(line.quotation_item_id)} the RFQ asked for — say why below`
                                : `The RFQ asked for ${rfqAsked(line.quotation_item_id)} · more needs a reason`}
                            </p>
                          )}
                          {counterOver(line.quotation_item_id, edit.qty) && (
                            <input
                              type="text"
                              value={edit.note ?? line.note ?? ""}
                              onChange={(e) => setCounterEdits({ ...counterEdits, [line.quotation_item_id]: { ...edit, note: e.target.value } })}
                              placeholder="Reason for the higher quantity (required)"
                              aria-label="Reason for the higher quantity"
                              className={`mt-1 h-9 w-full rounded-md border bg-white px-2 text-xs text-ink outline-none ${
                                (edit.note ?? line.note ?? "").trim()
                                  ? "border-line focus:border-brand" : "border-danger focus:border-danger"}`}
                            />
                          )}
                        </div>
                        <div>
                          <label className="block text-[11px] text-muted">Counter Rate (₹)</label>
                          <input
                            type="number" onKeyDown={guardNumberKeys} min="0" step="0.01"
                            value={edit.rate}
                            onChange={(e) => setCounterEdits({ ...counterEdits, [line.quotation_item_id]: { ...edit, rate: e.target.value } })}
                            className="h-9 w-full rounded-md border border-line bg-white px-2 text-xs text-ink outline-none focus:border-brand"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] text-muted">Counter Discount %</label>
                          <input
                            type="number" onKeyDown={guardNumberKeys} min="0" max="100" step="0.01"
                            value={edit.discount}
                            onChange={(e) => setCounterEdits({ ...counterEdits, [line.quotation_item_id]: { ...edit, discount: e.target.value } })}
                            className="h-9 w-full rounded-md border border-line bg-white px-2 text-xs text-ink outline-none focus:border-brand"
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line/60 pt-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-ink">OTP:</span>
                  <input
                    inputMode="numeric"
                    maxLength={6}
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="6-digit code"
                    className="h-8 w-32 rounded border border-line px-2 text-center text-xs font-mono outline-none focus:border-brand"
                  />
                  <button
                    type="button"
                    disabled={requestOtp.isPending}
                    onClick={() => requestOtp.mutate()}
                    className="rounded bg-brand/10 px-2.5 py-1 text-xs font-semibold text-brand hover:bg-brand/20 disabled:opacity-50"
                  >
                    {requestOtp.isPending ? "Sending…" : otpSent ? "Resend OTP" : "Request OTP"}
                  </button>
                </div>
                <Button
                  className="bg-brand text-white hover:bg-brand/90"
                  disabled={answerCr.isPending || otpCode.trim().length < 5
                    || openCr.lines.some((l) => counterOver(l.quotation_item_id,
                      counterEdits[l.quotation_item_id]?.qty ?? String(l.proposed_quantity))
                      && !(counterEdits[l.quotation_item_id]?.note ?? l.note ?? "").trim())}
                  onClick={() => {
                    const counterLinesPayload = openCr.lines.map((l) => {
                      const ed = counterEdits[l.quotation_item_id];
                      // The brand answered with: picked, else the buyer's ask, else kept.
                      const combo = counterCombos[l.quotation_item_id]
                        ?? (l.proposed_brand_id ? { brand_id: l.proposed_brand_id,
                          variant_id: l.proposed_variant_id || null, model_id: l.proposed_model_id || null }
                          : undefined);
                      return {
                        quotation_item_id: l.quotation_item_id,
                        proposed_quantity: Number(ed?.qty ?? l.proposed_quantity),
                        proposed_rate: Number(ed?.rate ?? l.proposed_rate),
                        proposed_discount_percent: Number(ed?.discount ?? l.proposed_discount_percent),
                        // The reason for a quantity above the RFQ's: the supplier's own,
                        // else the buyer's on that line (2026-11-11).
                        note: (ed?.note ?? l.note ?? "").trim() || undefined,
                        ...comboPayload(combo),
                      };
                    });
                    answerCr.mutate({
                      action: "ACCEPT",
                      note: decideNote.trim() || "Counter offer submitted by supplier",
                      counterLines: counterLinesPayload,
                    });
                  }}
                >
                  {answerCr.isPending ? "Submitting counter…" : "Submit Counter-Offer & Accept"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-4 space-y-2">
              {openCr.lines.map((line) => {
                const rateDelta = line.proposed_rate - line.current_rate;
                const qtyDelta = line.proposed_quantity - line.current_quantity;
                return (
                  <div key={line.quotation_item_id}
                       className="rounded-xl border border-amber-200 bg-white px-3 py-2">
                    <div className="text-sm font-medium text-ink">
                      {line.item_name ?? `Item ${line.item_id}`}
                      {line.item_code
                        && <span className="ml-2 font-mono text-[11px] text-muted">{line.item_code}</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-6 gap-y-1 text-xs">
                      <span className="text-muted">
                        Qty: <span className="line-through">{line.current_quantity}</span>{" "}
                        <span className="font-semibold text-ink">{line.proposed_quantity}</span>
                        {qtyDelta !== 0 && (
                          <span className={qtyDelta < 0 ? " text-danger" : " text-success"}>
                            ({qtyDelta > 0 ? "+" : ""}{qtyDelta})
                          </span>
                        )}
                      </span>
                      <span className="text-muted">
                        Rate: <span className="line-through">₹{line.current_rate}</span>{" "}
                        <span className="font-semibold text-ink">₹{line.proposed_rate}</span>
                        {rateDelta !== 0 && (
                          <span className={rateDelta > 0 ? " text-success" : " text-danger"}>
                            ({rateDelta > 0 ? "+" : "−"}₹{Math.abs(rateDelta).toLocaleString("en-IN")})
                          </span>
                        )}
                        {rateDelta > 0 && <span className="ml-1 text-success">(you gain)</span>}
                      </span>
                      {line.note && <span className="text-muted">Note: {line.note}</span>}
                    </div>
                    {/* The brand (2026-10-26): what the RFQ asked for, what is quoted,
                        and — when this request names one — the brand asked for now. */}
                    {(() => {
                      const quoted = quote?.items.find((i) => i.id === line.quotation_item_id);
                      const rfqAsked = askedLabel(quoted);
                      const current = line.current_combination ?? (combinationLabel(quoted) || null);
                      if (!rfqAsked && !current && !line.proposed_combination) return null;
                      const changing = !!line.proposed_combination && line.proposed_combination !== current;
                      return (
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                          {rfqAsked && (
                            <span className="text-muted">
                              RFQ asked: <b className="text-ink">{rfqAsked}</b>
                            </span>
                          )}
                          <span className="text-muted">
                            Brand: {changing
                              ? <><span className="line-through">{current ?? "—"}</span>{" "}
                                  <b className="text-brand">{line.proposed_combination}</b>
                                  <span className="ml-1 rounded bg-brand/10 px-1.5 py-0.5 text-[10px] font-semibold text-brand">buyer asks</span></>
                              : <b className={quoted?.brand_changed ? "text-warn" : "text-ink"}>{current ?? "—"}</b>}
                          </span>
                          {!changing && quoted?.brand_changed && (
                            <span className="rounded bg-warn-bg px-1.5 py-0.5 text-[10px] font-semibold text-warn">
                              differs from the RFQ
                            </span>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-3 text-[11px] text-amber-700">
            Accepting re-prices your quotation to the agreed numbers. Declining leaves
            it exactly as you quoted. Your answer is recorded either way.
          </p>
        </Card>
      )}

      {/* The thread with the buyer, beside the paper. Always accessible for supplier. */}
      <div className="mb-6">
        <QuotationChat rfqId={rfqId} quotationId={quote?.id ?? 0} vendorName={quote?.vendor_name ?? rfq?.title}
                       side="SUPPLIER" />
      </div>

      <Card className="mb-6 space-y-6 p-6 border-0 shadow-lg ring-1 ring-black/5 bg-white">
        {priceTrailVersions.length > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand/20 bg-gradient-to-r from-brand/5 via-sky-50/50 to-indigo-50/40 p-3 shadow-sm">
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
                      v{v.version} {v.version === latestVersionNum ? "(Latest - Current Quote)" : v.version === 1 ? "(Original Quote)" : v.cr_no ? `(${v.cr_no})` : ""}
                    </option>
                  ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            </div>
          </div>
        )}

        {activeVersionObj && (
          <div className="rounded-xl border border-sky-300 bg-sky-50 p-4 text-sky-900 text-xs font-medium flex items-center justify-between gap-2">
            <div>
              <span className="font-bold">Viewing Version {activeVersionObj.version} Supplier Accepted Snapshot</span> — Historical view only.
            </div>
            <button
              onClick={() => setSelectedVersionNum(null)}
              className="text-xs bg-sky-600 text-white font-semibold px-3 py-1.5 rounded-lg hover:bg-sky-700 shrink-0"
            >
              Return to latest (v{latestVersionNum})
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">Your prices</h2>
        </div>
        <p className="text-xs text-muted">
          Rates open at what the item's HSN notifies. You may quote below them, not
          above.
        </p>

        {isLoading && <p className="text-sm text-muted">Loading…</p>}

        {activeVersionObj ? (
          <div className="space-y-4">
            {(activeVersionObj.lines as Record<string, unknown>[]).map((vLine, index) => {
              const qty = Number(vLine.quantity || 0);
              const rate = Number(vLine.rate || 0);
              const disc = Number(vLine.discount_percent || 0);
              const taxPct = Number(vLine.tax_percent || 0);
              const gross = qty * rate;
              const net = gross - (gross * disc) / 100;
              const tax = (net * taxPct) / 100;
              const total = net + tax;
              return (
                <div
                  key={index}
                  className="rounded-2xl border border-sky-200 bg-sky-50/40 p-5 shadow-sm"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-sm font-semibold text-ink">{String(vLine.item_name ?? `Item ${vLine.item_id}`)}</div>
                    {Boolean(vLine.item_code) && <span className="font-mono text-xs text-muted">{String(vLine.item_code)}</span>}
                  </div>
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-5 text-xs">
                    <div>
                      <span className="block text-muted text-[11px]">Quantity</span>
                      <span className="font-semibold text-ink">{qty} {String(vLine.uom_code || "")}</span>
                    </div>
                    <div>
                      <span className="block text-muted text-[11px]">Rate</span>
                      <span className="font-semibold text-ink">₹{rate.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                    </div>
                    <div>
                      <span className="block text-muted text-[11px]">Discount</span>
                      <span className="text-body">{disc}%</span>
                    </div>
                    <div>
                      <span className="block text-muted text-[11px]">GST</span>
                      <span className="text-body">{taxPct}%</span>
                    </div>
                    <div>
                      <span className="block text-muted text-[11px]">Amount</span>
                      <span className="font-bold text-ink">{money(total)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          lines.map((line, index) => {
            const gross = Number(line.quantity || 0) * Number(line.rate || 0);
            const net = gross - (gross * Number(line.discount_percent || 0)) / 100;
            const short = Number(line.quantity || 0) < line.requested;
            const taxed = net + (net * taxRate(line)) / 100;

            // Eye-feasting colors to differentiate lines
            const LINE_COLORS = [
              { bg: "#f0f9ff", border: "#bae6fd" }, // sky
              { bg: "#ecfdf5", border: "#a7f3d0" }, // emerald
              { bg: "#fdf4ff", border: "#fbcfe8" }, // fuchsia
              { bg: "#fffbeb", border: "#fde68a" }, // amber
              { bg: "#f5f3ff", border: "#ddd6fe" }, // violet
            ];
            const color = LINE_COLORS[index % LINE_COLORS.length];

            return (
              <div 
                key={line.rfq_item_id} 
                className="rounded-2xl border p-5 shadow-sm transition-all hover:shadow-md hover:-translate-y-0.5"
                style={{ backgroundColor: color.bg, borderColor: color.border }}
              >
                <div className="mb-3">
                  <div className="text-sm font-medium text-ink">{line.item_name}</div>
                  <div className="font-mono text-[11px] text-muted">
                    {line.item_code} · asked {line.requested} {line.uom_code}
                    {line.required_date ? ` · needed by ${fmtDate(line.required_date)}` : ""}
                    {line.hsn_code ? ` · HSN ${line.hsn_code}` : ""}
                  </div>
                </div>
                {!!comboOptions.data?.[String(line.item_id)]?.length && (
                  <div className="mb-3 max-w-md">
                    <Field label="Brand · variant · model">
                      <CombinationPicker
                        options={comboOptions.data?.[String(line.item_id)]}
                        value={line.combo}
                        locked={!open}
                        ariaLabel={`Brand, variant and model for ${line.item_name}`}
                        onChange={(combo) => set(index, { combo })}
                      />
                    </Field>
                    {line.askedLabel && (
                      <p className="mt-1 text-[11px] text-muted">Buyer asked for <b className="text-ink">{line.askedLabel}</b></p>
                    )}
                    {/* Another brand than the buyer asked for (2026-10-26): allowed, and
                        said out loud — the buyer sees the change on every screen. */}
                    {line.asked?.brand_id && line.combo?.brand_id
                      && combinationKey(line.combo) !== combinationKey(line.asked) && (
                      <div className="mt-2 flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-bg px-3 py-2 text-xs text-warn">
                        <span aria-hidden>⚠</span>
                        <span>
                          <b>You are quoting {combinationLabel(line.combo)}</b>, not the {line.askedLabel} the
                          buyer asked for. The buyer will see this as a brand change, and may ask you to quote
                          the requested brand instead.
                        </span>
                      </div>
                    )}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
                  {/* Short is an ordinary answer — say what you can actually supply. More
                    * than was asked for is refused by the server: a quotation answers a
                    * request, it does not enlarge it. */}
                  <Field
                    label="Quantity"
                    hint={short ? `${line.requested} asked for` : undefined}
                  >
                    <Input
                      type="number" min="0" step="0.001" max={line.requested}
                      value={line.quantity} disabled={!open}
                      data-uom={line.uom_code ?? ""}
                      onChange={(e) => set(index, { quantity: e.target.value })}
                    />
                  </Field>
                  <Field label="Rate" required>
                    <Input
                      type="number" min="0" step="0.01" value={line.rate} disabled={!open}
                      onChange={(e) => set(index, { rate: e.target.value })}
                    />
                  </Field>
                  <Field label="Discount %">
                    <Input
                      type="number" min="0" max="100" step="0.01"
                      value={line.discount_percent} disabled={!open}
                      onChange={(e) => set(index, { discount_percent: e.target.value })}
                    />
                  </Field>

                  {/* SCM_0062: GST is the HSN's notified rate, not a vendor choice — shown
                    * as the split the two GSTINs decide, read-only. A mistyped number
                    * here used to be the one way a submission could come back refused
                    * over a figure the vendor never actually needed to touch. */}
                  <Field label="GST">
                    <div className="flex h-11 items-center rounded-lg border border-line bg-content2/50 px-3 text-sm font-medium text-body">
                      {gstSplitLabel(line)}
                    </div>
                  </Field>

                  <div className="flex items-end pb-2">
                    <div>
                      <div className="text-[11px] text-muted">Line total</div>
                      <div className="font-semibold text-ink">{money(taxed)}</div>
                      <div className="text-[11px] text-muted">
                        {money(net)} + {taxRate(line)}% tax
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}

        {!isLoading && !lines.length && (
          <p className="text-sm text-muted">This request has no lines to price.</p>
        )}
      </Card>

      <Card className="space-y-5 p-6 border-0 shadow-lg ring-1 ring-black/5 bg-white">
        <h2 className="text-sm font-semibold text-ink">Terms and totals</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">

          <Field label="Valid until" required>
            <Input
              type="date" min={todayIst()} value={header.valid_till} disabled={!open}
              onChange={(e) => setHeader({ ...header, valid_till: e.target.value })}
            />
          </Field>
          <Field label="Can deliver by">
            <Input
              type="date" min={todayIst()} value={header.expected_delivery_date} disabled={!open}
              onChange={(e) => setHeader({ ...header, expected_delivery_date: e.target.value })}
            />
          </Field>

          {/* Only when the buyer asked for freight on this RFQ. */}
          {freightAsked && (
            <Field label="Freight" hint="The buyer asked for freight on this RFQ">
              <Input
                type="number" min="0" step="0.01" value={header.freight_amount} disabled={!open}
                onChange={(e) => setHeader({ ...header, freight_amount: e.target.value })}
              />
            </Field>
          )}
          <Field label="Overall discount (amount)" hint="A flat amount off the total, not a percentage">
            <Input
              type="number" min="0" step="0.01" value={header.discount_amount} disabled={!open}
              onChange={(e) => setHeader({ ...header, discount_amount: e.target.value })}
            />
          </Field>
        </div>

        <Field label="Remarks">
          <Input
            value={header.remarks} disabled={!open}
            onChange={(e) => setHeader({ ...header, remarks: e.target.value })}
          />
        </Field>

        {/* Stacks on a phone: three money columns at 375px wrap mid-number. */}
        <dl className="grid grid-cols-1 gap-4 border-t border-line pt-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted">Sub-total</dt>
            <dd className="mt-1 text-body">{money(totals.sub)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Tax</dt>
            <dd className="mt-1 text-body">{money(totals.tax)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Grand total</dt>
            <dd className="mt-1 font-semibold text-ink">{money(totals.grand)}</dd>
          </div>
        </dl>

        {open && gaps.length > 0 && (
          <p className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
            Still to answer: {gaps.join(", ")}. Every field marked * has to be filled
            in before the quotation can go in.
          </p>
        )}

        {/* The last step, and the only one that binds this vendor to a price. The code
            goes to the address on their account, so submitting takes something the
            portal link alone cannot give — which is the whole point: that link may
            have been forwarded, or left in a mailbox somebody still reads. */}
        {open && (
          <div className="rounded-xl border border-line bg-content2/40 p-4">
            <h3 className="text-sm font-semibold text-ink">Confirm it is you</h3>
            <p className="mt-1 text-xs text-muted">
              We email a one-time code to your registered address. Enter it to submit
              this quotation.
            </p>

            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <button
                type="button"
                className="rounded-xl border border-brand px-4 py-2.5 text-sm font-semibold text-brand transition hover:bg-brand/5 disabled:opacity-50 disabled:pointer-events-none"
                disabled={requestOtp.isPending}
                onClick={() => requestOtp.mutate()}
              >
                {requestOtp.isPending
                  ? "Sending…"
                  : otpSent ? "Send another code" : "Request OTP"}
              </button>

              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={otpCode}
                // Digits only: the code is six of them, and a pasted "Code: 123456"
                // should work rather than fail on the label somebody copied with it.
                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="6-digit code"
                aria-label="One-time code"
                className="h-11 w-full rounded-xl border border-line bg-content1 px-3 text-center text-base tracking-[0.4em] text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 sm:w-44"
              />
            </div>

            {otpSent && (
              <p className="mt-2 text-xs text-muted">
                Sent to <span className="font-semibold text-body">{otpSent.sent_to}</span>
                {" — good for "}
                {otpSent.expires_in_seconds >= 60
                  ? `${Math.round(otpSent.expires_in_seconds / 60)} minute${
                      otpSent.expires_in_seconds >= 120 ? "s" : ""}`
                  : `${otpSent.expires_in_seconds} seconds`}
                . It can be used once.
              </p>
            )}
            {requestOtp.isError && (
              <p className="mt-2 text-xs text-danger">
                {errorMessage(requestOtp.error)}
              </p>
            )}
            {save.isError && (
              <p className="mt-2 text-xs text-danger">{errorMessage(save.error)}</p>
            )}
          </div>
        )}

        {open && !openCr && (
          <button
            className="w-full sm:w-auto rounded-xl bg-gradient-to-r from-brand to-brand/90 px-8 py-3.5 text-base font-bold text-white shadow-xl transition-all hover:scale-105 hover:shadow-2xl hover:from-brand/90 hover:to-brand focus:outline-none focus:ring-4 focus:ring-brand/30 disabled:opacity-40 disabled:pointer-events-none disabled:transform-none"
            disabled={save.isPending || !lines.length
              || gaps.length > 0 || otpCode.trim().length < 5}
            onClick={() => save.mutate()}
          >
            {save.isPending
              ? "Submitting…"
              : quote?.status === "DRAFT" ? "Submit quotation" : "Edit & submit quote"}
          </button>
        )}
        {open && openCr && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
            The buyer's change request above is waiting for your answer — answer it
            before submitting your own prices.
          </p>
        )}
      </Card>

      {/* Accept / decline confirm: the ONE place the quotation re-prices. */}
      <ConfirmModal
        isOpen={decide != null}
        title={decide === "ACCEPT" ? "Accept the buyer's changes?" : "Decline the buyer's changes?"}
        message={decide === "ACCEPT"
          ? "Your quotation will be re-priced to the buyer's numbers immediately. Please enter your OTP code to confirm."
          : "Your quotation stays exactly as you quoted it. The buyer will see your answer"}
        confirmLabel={decide === "ACCEPT" ? "Accept changes" : "Decline"}
        tone="warning"
        busy={answerCr.isPending}
        onConfirm={() => {
          if (decide === "ACCEPT" && otpCode.trim().length < 5) {
            toast.error("First press Send OTP, then type the 6-digit code you received, then press Accept.");
            return;
          }
          if (decide) {
            answerCr.mutate({ action: decide, note: decideNote.trim() });
          }
        }}
        onClose={() => setDecide(null)}
      >
        <div className="space-y-3 pt-2">
          <Textarea
            value={decideNote}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDecideNote(e.target.value)}
            minRows={2}
            placeholder={decide === "DECLINE"
              ? "Optional — tell the buyer why you are declining"
              : "Optional — a note to the buyer"}
            aria-label="Note to the buyer"
          />
          {decide === "ACCEPT" && (
            <div className="rounded-xl border border-line bg-surface-2/50 p-3">
              <label className="block text-xs font-semibold text-ink mb-1">Enter OTP Code</label>
              <div className="flex gap-2">
                <input
                  inputMode="numeric"
                  maxLength={6}
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="6-digit OTP"
                  className="h-9 flex-1 rounded-lg border border-line px-3 text-center text-sm font-mono tracking-widest outline-none focus:border-brand"
                />
                <button
                  type="button"
                  disabled={requestOtp.isPending}
                  onClick={() => requestOtp.mutate()}
                  className="rounded-lg bg-brand/10 px-3 py-1.5 text-xs font-semibold text-brand hover:bg-brand/20 disabled:opacity-50"
                >
                  {requestOtp.isPending ? "Sending…" : otpSent ? "Resend" : "Request OTP"}
                </button>
              </div>
              {otpSent && (
                <p className="mt-1 text-[11px] text-muted">Sent to {otpSent.sent_to}</p>
              )}
            </div>
          )}
        </div>
      </ConfirmModal>

      <div className="mt-8">
        <QuotePriceTrail rfqId={rfqId} side="SUPPLIER" selectedVersion={selectedVersionNum} onSelectVersion={setSelectedVersionNum} />
      </div>
    </div>
  );
}
