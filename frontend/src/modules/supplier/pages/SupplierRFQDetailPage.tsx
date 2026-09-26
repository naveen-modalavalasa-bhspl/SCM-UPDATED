import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History } from "lucide-react";
import {
  Card, ConfirmModal, ErrorBanner, Field, Input, StatusPill, Textarea, useToast,
} from "@/shared/components";
import { Button } from "@/modules/procurement/components/ActionButton";
import { fmtDate, todayIst } from "@/shared/datetime";
import { errorMessage } from "@/shared/api/errors";
import { supplierApi } from "@/modules/procurement/api";
import { QuotationChat } from "@/modules/procurement/components/QuotationChat";
import { QuotePriceTrail } from "@/modules/procurement/components/QuotePriceTrail";
import type { QuoteChangeRequest, QuoteOtpSent, QuoteSubmit } from "@/modules/procurement/types";

const money = (n: number) =>
  `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface QuoteLine {
  rfq_item_id: number;
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
  /** The whole GST rate. Which half applies — CGST + SGST or IGST — is decided by the
   *  two GSTINs and only changes how the tax is described, not how much it is. */
  gst_rate: string;
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
 * The tax box is not a free choice: the rate is capped by the rate notified for the
 * item's HSN. Whether that rate is charged as CGST + SGST or as IGST is decided by the
 * two GSTINs, so the vendor types ONE figure and the server enforces the ceiling again
 * regardless of what the browser sent.
 */
export function SupplierRFQDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const rfqId = Number(id);

  const [lines, setLines] = useState<QuoteLine[]>([]);
  const [header, setHeader] = useState({
    vendor_ref_no: "", valid_till: "", expected_delivery_date: "",
    payment_terms: "", freight_amount: "", discount_amount: "", remarks: "",
  });

  const { data: rfq, error: rfqError } = useQuery({
    queryKey: ["supplier-rfq", id],
    queryFn: () => supplierApi.rfq(rfqId),
  });

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
      item_name: item.item_name ?? `Item ${item.item_id}`,
      item_code: item.item_code ?? "—",
      uom_code: item.uom_code ?? "",
      quantity: item.quantity ? String(item.quantity) : "",
      requested: Number(item.requested_quantity ?? item.quantity),
      required_date: item.required_date,
      rate: item.rate ? String(item.rate) : "",
      discount_percent: item.discount_percent ? String(item.discount_percent) : "",
      // Opens at the notified rate. That is what is normally charged, so the vendor
      // types nothing in the usual case and can only bring it down from there.
      gst_rate: (item.tax_percent || item.max_gst_rate)
        ? String(item.tax_percent || item.max_gst_rate) : "",
      delivery_days: item.delivery_days == null ? "" : String(item.delivery_days),
      hsn_code: item.hsn_code,
      max_gst: item.max_gst_rate ?? null,
    })));
  }, [quote]);

  // Whether the supply is within a state or across one: it decides how the rate is
  // DESCRIBED (CGST + SGST, or IGST), never how much it is.
  const interstate = quote?.tax_region !== "INTRA";

  /** What this line is taxed at. One rate, whichever route the goods travel. */
  const taxRate = (line: QuoteLine) => Number(line.gst_rate || 0);

  /** The ceiling this line may quote up to, or null where the item has no HSN. */
  const ceiling = (line: QuoteLine) => line.max_gst;

  const overCeiling = lines.filter((line) => {
    const limit = ceiling(line);
    return limit != null && taxRate(line) > limit + 1e-9;
  });

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
    const grand = sub + tax + Number(header.freight_amount || 0);
    return { sub, tax, grand };
  }, [lines, interstate, header.freight_amount, header.discount_amount]);

  const save = useMutation({
    mutationFn: () => {
      const payload: QuoteSubmit = {
        otp_code: otpCode.trim(),
        vendor_ref_no: header.vendor_ref_no || null,
        valid_till: header.valid_till || null,
        expected_delivery_date: header.expected_delivery_date || null,
        payment_terms: header.payment_terms || null,
        freight_amount: Number(header.freight_amount || 0),
        discount_amount: Number(header.discount_amount || 0),
        remarks: header.remarks || null,
        // One GST rate per line. The server caps it at the HSN's notified rate and
        // decides which half of it applies from the two GSTINs.
        lines: lines.map((line) => ({
          rfq_item_id: line.rfq_item_id,
          quantity: Number(line.quantity || 0),
          rate: Number(line.rate || 0),
          discount_percent: Number(line.discount_percent || 0),
          tax_percent: taxRate(line),
          delivery_days: line.delivery_days ? Number(line.delivery_days) : null,
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
  const [counterEdits, setCounterEdits] = useState<Record<number, { qty: string; rate: string; discount: string }>>({});

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
                      <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <div>
                          <label className="block text-[11px] text-muted">Counter Quantity</label>
                          <input
                            type="number" min="0" step="0.001"
                            value={edit.qty}
                            onChange={(e) => setCounterEdits({ ...counterEdits, [line.quotation_item_id]: { ...edit, qty: e.target.value } })}
                            className="h-9 w-full rounded-md border border-line bg-white px-2 text-xs text-ink outline-none focus:border-brand"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] text-muted">Counter Rate (₹)</label>
                          <input
                            type="number" min="0" step="0.01"
                            value={edit.rate}
                            onChange={(e) => setCounterEdits({ ...counterEdits, [line.quotation_item_id]: { ...edit, rate: e.target.value } })}
                            className="h-9 w-full rounded-md border border-line bg-white px-2 text-xs text-ink outline-none focus:border-brand"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] text-muted">Counter Discount %</label>
                          <input
                            type="number" min="0" max="100" step="0.01"
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
                  disabled={answerCr.isPending || otpCode.trim().length < 5}
                  onClick={() => {
                    const counterLinesPayload = openCr.lines.map((l) => {
                      const ed = counterEdits[l.quotation_item_id];
                      return {
                        quotation_item_id: l.quotation_item_id,
                        proposed_quantity: Number(ed?.qty ?? l.proposed_quantity),
                        proposed_rate: Number(ed?.rate ?? l.proposed_rate),
                        proposed_discount_percent: Number(ed?.discount ?? l.proposed_discount_percent),
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
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface-2/60 p-2.5">
            <div className="flex items-center gap-1.5">
              <History className="h-4 w-4 text-brand" />
              <span className="text-xs font-bold text-ink uppercase tracking-wider">Version History:</span>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {priceTrailVersions.map((v) => {
                const isSelected = (selectedVersionNum === v.version) || (selectedVersionNum === null && v.version === latestVersionNum);
                return (
                  <button
                    key={v.version}
                    type="button"
                    onClick={() => setSelectedVersionNum(v.version === latestVersionNum ? null : v.version)}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold transition ${
                      isSelected
                        ? "bg-brand text-white shadow-sm"
                        : "bg-white/80 text-muted hover:bg-white hover:text-ink border border-line"
                    }`}
                  >
                    v{v.version} {v.version === 1 ? "(Original)" : v.cr_no ? `(${v.cr_no})` : ""}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {activeVersionObj && (
          <div className="rounded-xl border border-sky-300 bg-sky-50 p-4 text-sky-900 text-xs font-medium flex items-center justify-between gap-2">
            <div>
              <span className="font-bold">Viewing Version {activeVersionObj.version} Snapshot ({activeVersionObj.source})</span> — Historical view only.
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
            const limit = ceiling(line);
            const over = limit != null && taxRate(line) > limit + 1e-9;
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

                  {/* One rate. Which half of it applies is the two GSTINs' business, not
                    * the vendor's, so there is a single box rather than one per half. */}
                  <Field
                    label="GST %"
                    hint={line.max_gst != null ? `Up to ${line.max_gst}%` : undefined}
                  >
                    <Input
                      type="number" min="0" step="0.01"
                      max={line.max_gst ?? undefined}
                      value={line.gst_rate} disabled={!open}
                      onChange={(e) => set(index, { gst_rate: e.target.value })}
                    />
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
                {over && (
                  <p className="mt-2 text-xs text-danger">
                    Above the {limit}% notified for
                    {line.hsn_code ? ` HSN ${line.hsn_code}` : " this item"}. Quote at or
                    below it — the submission will be refused otherwise.
                  </p>
                )}
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

          <Field label="Freight">
            <Input
              type="number" min="0" step="0.01" value={header.freight_amount} disabled={!open}
              onChange={(e) => setHeader({ ...header, freight_amount: e.target.value })}
            />
          </Field>
          <Field label="Overall discount">
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

        {open && overCeiling.length > 0 && (
          <p className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
            {overCeiling.length} line{overCeiling.length === 1 ? "" : "s"} quote more tax
            than the HSN allows. Bring them down to submit.
          </p>
        )}

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
            disabled={save.isPending || !lines.length || overCeiling.length > 0
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
            toast.error("Please request & enter a valid 6-digit OTP code before accepting");
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
        <QuotePriceTrail rfqId={rfqId} side="SUPPLIER" />
      </div>
    </div>
  );
}
