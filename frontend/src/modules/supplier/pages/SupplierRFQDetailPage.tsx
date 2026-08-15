import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, Card, ErrorBanner, Field, Input, PageHeader, StatusPill, useToast,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { supplierApi } from "@/modules/procurement/api";
import type { QuoteSubmit } from "@/modules/procurement/types";

const money = (n: number) =>
  `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface QuoteLine {
  rfq_item_id: number;
  item_name: string;
  item_code: string;
  uom_code: string;
  quantity: number;
  rate: string;
  discount_percent: string;
  tax_percent: string;
  delivery_days: string;
}

/**
 * The quote form.
 *
 * Totals are computed here for the vendor to see and recomputed server-side on save —
 * the browser's arithmetic is never trusted into the database. A vendor may re-submit
 * until the deadline; each save bumps `revision_count`, which the buyer can see.
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
      quantity: Number(item.quantity),
      rate: String(item.rate ?? 0),
      discount_percent: String(item.discount_percent ?? 0),
      tax_percent: String(item.tax_percent ?? 0),
      delivery_days: item.delivery_days == null ? "" : String(item.delivery_days),
    })));
  }, [quote]);

  const totals = useMemo(() => {
    let sub = 0;
    let tax = 0;
    for (const line of lines) {
      const gross = line.quantity * Number(line.rate || 0);
      const net = gross - (gross * Number(line.discount_percent || 0)) / 100;
      sub += net;
      tax += (net * Number(line.tax_percent || 0)) / 100;
    }
    const grand = sub + tax + Number(header.freight_amount || 0)
      - Number(header.discount_amount || 0);
    return { sub, tax, grand };
  }, [lines, header.freight_amount, header.discount_amount]);

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
        lines: lines.map((line) => ({
          rfq_item_id: line.rfq_item_id,
          rate: Number(line.rate || 0),
          discount_percent: Number(line.discount_percent || 0),
          tax_percent: Number(line.tax_percent || 0),
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
        <h2 className="text-sm font-semibold text-ink">Your prices</h2>

        {isLoading && <p className="text-sm text-muted">Loading…</p>}

        {lines.map((line, index) => {
          const gross = line.quantity * Number(line.rate || 0);
          const net = gross - (gross * Number(line.discount_percent || 0)) / 100;
          return (
            <div key={line.rfq_item_id} className="rounded-xl border border-line p-3">
              <div className="mb-3">
                <div className="text-sm font-medium text-ink">{line.item_name}</div>
                <div className="font-mono text-[11px] text-muted">
                  {line.item_code} · {line.quantity} {line.uom_code}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <Field label="Rate">
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
                <Field label="Tax %">
                  <Input
                    type="number" min="0" step="0.01" value={line.tax_percent} disabled={!open}
                    onChange={(e) => set(index, { tax_percent: e.target.value })}
                  />
                </Field>
                <Field label="Delivery days">
                  <Input
                    type="number" min="0" value={line.delivery_days} disabled={!open}
                    onChange={(e) => set(index, { delivery_days: e.target.value })}
                  />
                </Field>
                <div className="flex items-end pb-2">
                  <div>
                    <div className="text-[11px] text-muted">Line total</div>
                    <div className="font-semibold text-ink">{money(net)}</div>
                  </div>
                </div>
              </div>
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
          <Field label="Valid until">
            <Input
              type="date" value={header.valid_till} disabled={!open}
              onChange={(e) => setHeader({ ...header, valid_till: e.target.value })}
            />
          </Field>
          <Field label="Can deliver by">
            <Input
              type="date" value={header.expected_delivery_date} disabled={!open}
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

        {open && (
          <Button
            className="w-full sm:w-auto"
            disabled={save.isPending || !lines.length}
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
