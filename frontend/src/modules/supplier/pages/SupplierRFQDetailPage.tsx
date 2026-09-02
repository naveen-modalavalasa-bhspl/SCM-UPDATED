import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, Card, ErrorBanner, Field, Input, PageHeader, StatusPill, useToast,
} from "@/shared/components";
import { fmtDate, todayIst } from "@/shared/datetime";
import { supplierApi } from "@/modules/procurement/api";
import type { QuoteSubmit } from "@/modules/procurement/types";

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
  cgst_rate: string;
  sgst_rate: string;
  igst_rate: string;
  delivery_days: string;
  hsn_code?: string | null;
  max_cgst: number | null;
  max_sgst: number | null;
  max_igst: number | null;
}

/**
 * The quote form.
 *
 * Totals are computed here for the vendor to see and recomputed server-side on save —
 * the browser's arithmetic is never trusted into the database. A vendor may re-submit
 * until the deadline; each save bumps `revision_count`, which the buyer can see.
 *
 * The tax boxes are not a free choice. Which ones open is decided by the two GSTINs —
 * same state is CGST + SGST, any other state is IGST — and how high they go is capped
 * by the rate notified for the item's HSN. Both rules are the server's; this screen
 * draws them so the vendor is never rejected for something they could not have known,
 * and the submit endpoint enforces them again regardless of what the browser sent.
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
    payment_terms: "", freight_amount: "0", discount_amount: "0", remarks: "",
  });

  const { data: rfq, error: rfqError } = useQuery({
    queryKey: ["supplier-rfq", id],
    queryFn: () => supplierApi.rfq(rfqId),
  });

  const { data: quote, isLoading } = useQuery({
    queryKey: ["supplier-quote", id],
    queryFn: () => supplierApi.quotation(rfqId),
  });

  useEffect(() => {
    if (!quote) return;
    setHeader({
      vendor_ref_no: quote.vendor_ref_no ?? "",
      valid_till: quote.valid_till ?? "",
      expected_delivery_date: quote.expected_delivery_date ?? "",
      payment_terms: quote.payment_terms ?? "",
      freight_amount: String(quote.freight_amount ?? 0),
      discount_amount: String(quote.discount_amount ?? 0),
      remarks: quote.remarks ?? "",
    });
    setLines(quote.items.map((item) => ({
      rfq_item_id: item.rfq_item_id ?? 0,
      item_name: item.item_name ?? `Item ${item.item_id}`,
      item_code: item.item_code ?? "—",
      uom_code: item.uom_code ?? "",
      quantity: String(item.quantity),
      requested: Number(item.requested_quantity ?? item.quantity),
      required_date: item.required_date,
      rate: String(item.rate ?? 0),
      discount_percent: String(item.discount_percent ?? 0),
      // Opens at the notified rate. That is what is normally charged, so the vendor
      // types nothing in the usual case and can only bring it down from there.
      cgst_rate: String(item.cgst_rate ?? item.max_cgst_rate ?? 0),
      sgst_rate: String(item.sgst_rate ?? item.max_sgst_rate ?? 0),
      igst_rate: String(item.igst_rate ?? item.max_igst_rate ?? 0),
      delivery_days: item.delivery_days == null ? "" : String(item.delivery_days),
      hsn_code: item.hsn_code,
      max_cgst: item.max_cgst_rate ?? null,
      max_sgst: item.max_sgst_rate ?? null,
      max_igst: item.max_igst_rate ?? null,
    })));
  }, [quote]);

  const interstate = quote?.tax_region !== "INTRA";

  /** What this line is taxed at, given which half of the split applies. */
  const taxRate = (line: QuoteLine) =>
    interstate
      ? Number(line.igst_rate || 0)
      : Number(line.cgst_rate || 0) + Number(line.sgst_rate || 0);

  /** The ceiling this line may quote up to, or null where the item has no HSN. */
  const ceiling = (line: QuoteLine) =>
    interstate
      ? line.max_igst
      : line.max_cgst == null && line.max_sgst == null
        ? null
        : (line.max_cgst ?? 0) + (line.max_sgst ?? 0);

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
    count("Delivery days",
      lines.filter((line) => String(line.delivery_days ?? "").trim() === "").length);
    return out;
  }, [header.valid_till, header.expected_delivery_date, lines]);

  const totals = useMemo(() => {
    let sub = 0;
    let tax = 0;
    for (const line of lines) {
      const gross = Number(line.quantity || 0) * Number(line.rate || 0);
      const net = gross - (gross * Number(line.discount_percent || 0)) / 100;
      sub += net;
      tax += (net * taxRate(line)) / 100;
    }
    const grand = sub + tax + Number(header.freight_amount || 0)
      - Number(header.discount_amount || 0);
    return { sub, tax, grand };
  }, [lines, interstate, header.freight_amount, header.discount_amount]);

  const save = useMutation({
    mutationFn: () => {
      const payload: QuoteSubmit = {
        vendor_ref_no: header.vendor_ref_no || null,
        valid_till: header.valid_till || null,
        expected_delivery_date: header.expected_delivery_date || null,
        payment_terms: header.payment_terms || null,
        freight_amount: Number(header.freight_amount || 0),
        discount_amount: Number(header.discount_amount || 0),
        remarks: header.remarks || null,
        // Only the half of the split that applies is sent. The other one is not zero
        // "for safety" — sending it at all is what the server rejects, because a rate
        // on the wrong side is a vendor charging something they cannot charge.
        lines: lines.map((line) => ({
          rfq_item_id: line.rfq_item_id,
          quantity: Number(line.quantity || 0),
          rate: Number(line.rate || 0),
          discount_percent: Number(line.discount_percent || 0),
          tax_percent: taxRate(line),
          cgst_rate: interstate ? null : Number(line.cgst_rate || 0),
          sgst_rate: interstate ? null : Number(line.sgst_rate || 0),
          igst_rate: interstate ? Number(line.igst_rate || 0) : null,
          delivery_days: line.delivery_days ? Number(line.delivery_days) : null,
        })),
      };
      return supplierApi.submitQuotation(rfqId, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["supplier-quote", id] });
      queryClient.invalidateQueries({ queryKey: ["supplier-rfqs"] });
      toast.success("Quotation submitted");
    },
  });

  const open = rfq?.status === "PUBLISHED";
  const set = (index: number, patch: Partial<QuoteLine>) =>
    setLines(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  return (
    <div>
      <PageHeader
        back={{ to: "/supplier/rfqs", label: "Back to Your RFQs" }}
        eyebrow="Supplier"
        title={rfq?.rfq_no ?? "Request"}
        actions={
          <Button variant="subtle" onClick={() => nav("/supplier/rfqs")}>Back</Button>
        }
      />

      <ErrorBanner error={rfqError ?? save.error} />

      {rfq && (
        <Card className="mb-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-display text-lg font-bold text-ink">
                {rfq.title ?? "Untitled request"}
              </h2>
              <p className="mt-1 text-sm text-muted">
                {rfq.due_date ? `Closes ${fmtDate(rfq.due_date)}` : "No deadline"}
                {quote?.revision_count ? ` · you have revised ${quote.revision_count} time${quote.revision_count === 1 ? "" : "s"}` : ""}
              </p>
            </div>
            <StatusPill status={quote?.status ?? rfq.status} />
          </div>
          {rfq.terms && (
            <p className="mt-4 border-t border-line pt-4 text-sm text-body">{rfq.terms}</p>
          )}
          {!open && (
            <p className="mt-4 rounded-lg bg-surface-2 px-3 py-2 text-sm text-body">
              This request is closed. You can read it, but it no longer accepts quotes.
            </p>
          )}
        </Card>
      )}

      <Card className="mb-4 space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">Your prices</h2>
          {/* Said out loud, with the reason. A vendor who sees only an IGST box and no
            * explanation assumes the form is broken. */}
          <span className="rounded-full bg-surface-2 px-3 py-1 text-[11px] text-body">
            Tax region: {interstate ? "Inter-state (IGST)" : "Intra-state (CGST + SGST)"}
            {quote?.vendor_gstin ? ` · your GSTIN ${quote.vendor_gstin}` : ""}
          </span>
        </div>
        <p className="text-xs text-muted">
          Rates open at what the item's HSN notifies. You may quote below them, not
          above.
        </p>

        {isLoading && <p className="text-sm text-muted">Loading…</p>}

        {lines.map((line, index) => {
          const gross = Number(line.quantity || 0) * Number(line.rate || 0);
          const net = gross - (gross * Number(line.discount_percent || 0)) / 100;
          const limit = ceiling(line);
          const over = limit != null && taxRate(line) > limit + 1e-9;
          const short = Number(line.quantity || 0) < line.requested;
          const taxed = net + (net * taxRate(line)) / 100;
          return (
            <div key={line.rfq_item_id} className="rounded-xl border border-line p-3">
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

                {/* One side of the split only. The other is not disabled, it is not
                  * drawn — an interstate supply has no CGST field to grey out. */}
                {interstate ? (
                  <Field
                    label="IGST %"
                    hint={line.max_igst != null ? `Up to ${line.max_igst}%` : undefined}
                  >
                    <Input
                      type="number" min="0" step="0.01"
                      max={line.max_igst ?? undefined}
                      value={line.igst_rate} disabled={!open}
                      onChange={(e) => set(index, { igst_rate: e.target.value })}
                    />
                  </Field>
                ) : (
                  <>
                    <Field
                      label="CGST %"
                      hint={line.max_cgst != null ? `Up to ${line.max_cgst}%` : undefined}
                    >
                      <Input
                        type="number" min="0" step="0.01"
                        max={line.max_cgst ?? undefined}
                        value={line.cgst_rate} disabled={!open}
                        onChange={(e) => set(index, { cgst_rate: e.target.value })}
                      />
                    </Field>
                    <Field
                      label="SGST %"
                      hint={line.max_sgst != null ? `Up to ${line.max_sgst}%` : undefined}
                    >
                      <Input
                        type="number" min="0" step="0.01"
                        max={line.max_sgst ?? undefined}
                        value={line.sgst_rate} disabled={!open}
                        onChange={(e) => set(index, { sgst_rate: e.target.value })}
                      />
                    </Field>
                  </>
                )}

                <Field label="Delivery days" required>
                  <Input
                    type="number" min="0" value={line.delivery_days} disabled={!open}
                    onChange={(e) => set(index, { delivery_days: e.target.value })}
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
        })}

        {!isLoading && !lines.length && (
          <p className="text-sm text-muted">This request has no lines to price.</p>
        )}
      </Card>

      <Card className="space-y-4 p-5">
        <h2 className="text-sm font-semibold text-ink">Terms and totals</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Your reference">
            <Input
              value={header.vendor_ref_no} disabled={!open}
              onChange={(e) => setHeader({ ...header, vendor_ref_no: e.target.value })}
            />
          </Field>
          <Field label="Valid until" required>
            <Input
              type="date" min={todayIst()} value={header.valid_till} disabled={!open}
              onChange={(e) => setHeader({ ...header, valid_till: e.target.value })}
            />
          </Field>
          <Field label="Can deliver by" required>
            <Input
              type="date" min={todayIst()} value={header.expected_delivery_date} disabled={!open}
              onChange={(e) => setHeader({ ...header, expected_delivery_date: e.target.value })}
            />
          </Field>
          <Field label="Payment terms">
            <Input
              value={header.payment_terms} disabled={!open}
              onChange={(e) => setHeader({ ...header, payment_terms: e.target.value })}
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

        {open && (
          <Button
            className="w-full sm:w-auto"
            disabled={save.isPending || !lines.length || overCeiling.length > 0
              || gaps.length > 0}
            onClick={() => save.mutate()}
          >
            {save.isPending
              ? "Submitting…"
              : quote?.status === "DRAFT" ? "Submit quotation" : "Submit revision"}
          </Button>
        )}
      </Card>
    </div>
  );
}
