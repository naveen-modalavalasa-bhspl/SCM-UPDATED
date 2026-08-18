import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/shared/api/client";
import { poApi } from "../api";
import { fmtDate } from "@/shared/datetime";

const money = (value: number) =>
  new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(value ?? 0);

/**
 * The purchase order as a document — the thing that gets signed, filed and posted.
 *
 * Mounted OUTSIDE the app shell, so what prints is the order and not a sidebar with an
 * order next to it. Saving it as a PDF is the browser's own print dialog: there is no
 * server-side renderer to keep in step with this page, nothing to install, and what
 * comes out is exactly what is on the screen — which is the whole point of a document
 * a vendor and a buyer are both meant to be reading.
 *
 * Every field the order carries is here, including the empty ones. A blank payment
 * term on a printed order is information: it says nobody agreed one.
 */
export function POPrintPage() {
  const { id } = useParams();
  const poId = Number(id);

  const po = useQuery({
    queryKey: ["purchase-order", poId],
    queryFn: () => poApi.get(poId),
    enabled: Number.isFinite(poId) && poId > 0,
  });

  // The company on whose paper this order is placed. Read from settings rather than
  // hardcoded — there is one company today and the letterhead still has to say which.
  const { data: company } = useQuery({
    queryKey: ["print-company"],
    queryFn: () =>
      api.get<{ company?: Record<string, string> }>("/api/settings")
        .then((r) => r.data.company ?? {})
        .catch(() => ({} as Record<string, string>)),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  // Print once the order is actually on the page. Firing on mount would open the
  // dialog over an empty sheet.
  useEffect(() => {
    if (!po.data) return;
    const timer = setTimeout(() => window.print(), 250);
    return () => clearTimeout(timer);
  }, [po.data]);

  if (po.isLoading) return <p className="p-8 text-sm">Loading the order…</p>;
  if (po.error) return <p className="p-8 text-sm">{(po.error as Error).message}</p>;
  if (!po.data) return <p className="p-8 text-sm">Purchase order not found.</p>;

  const order = po.data;
  const terms: [string, string | null | undefined][] = [
    ["Payment terms", order.payment_terms],
    ["Delivery terms", order.delivery_terms],
    ["Material terms", order.material_terms],
    ["Logistics terms", order.logistics_terms],
  ];

  return (
    <div className="mx-auto max-w-[820px] bg-white p-8 text-[13px] leading-snug text-black print:p-0">
      <style>{`
        @page { size: A4; margin: 14mm; }
        @media print {
          .no-print { display: none !important; }
          body { background: #fff; }
          table { page-break-inside: auto; }
          tr { page-break-inside: avoid; }
        }
      `}</style>

      <div className="no-print mb-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
        >
          Print / Save as PDF
        </button>
      </div>

      <header className="flex items-start justify-between border-b-2 border-black pb-3">
        <div>
          <h1 className="text-lg font-bold uppercase">
            {company?.name || "Purchase order"}
          </h1>
          {company?.legal_name && <p className="text-[12px]">{company.legal_name}</p>}
          {company?.address && <p className="max-w-[380px] text-[12px]">{company.address}</p>}
          <p className="text-[12px]">
            {company?.gstin ? `GSTIN ${company.gstin}` : ""}
            {company?.phone ? ` · ${company.phone}` : ""}
          </p>
        </div>
        <div className="text-right">
          <p className="text-base font-bold uppercase tracking-wide">Purchase Order</p>
          <p className="font-mono text-[14px]">{order.po_no}</p>
          <p className="text-[12px]">Date {fmtDate(order.po_date)}</p>
          {(order.revision_no ?? 0) > 0 && (
            <p className="text-[12px] font-semibold">Revision {order.revision_no}</p>
          )}
          <p className="text-[12px]">Status {order.status}</p>
          {order.vendor_status && (
            <p className="text-[12px]">Vendor: {order.vendor_status}</p>
          )}
        </div>
      </header>

      <section className="mt-4 grid grid-cols-2 gap-6">
        <div>
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wide">Vendor</p>
          <p className="font-semibold">{order.vendor_name ?? "—"}</p>
        </div>
        <div>
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wide">Order details</p>
          <table className="w-full text-[12px]">
            <tbody>
              <tr><td className="pr-3 text-neutral-600">Project</td><td>{order.project_name || "—"}</td></tr>
              <tr><td className="pr-3 text-neutral-600">Expected date</td><td>{fmtDate(order.expected_date)}</td></tr>
              <tr><td className="pr-3 text-neutral-600">Indent</td><td className="font-mono">{order.indent_no || "—"}</td></tr>
              <tr><td className="pr-3 text-neutral-600">Requisition</td><td className="font-mono">{order.requisition_no || "—"}</td></tr>
              <tr><td className="pr-3 text-neutral-600">RFQ</td><td className="font-mono">{order.rfq_no || "—"}</td></tr>
              <tr><td className="pr-3 text-neutral-600">Quotation</td><td className="font-mono">{order.quotation_no || "—"}</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-4 grid grid-cols-2 gap-6">
        <div>
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wide">Bill to</p>
          <p className="whitespace-pre-line">{order.billing_address || "—"}</p>
        </div>
        <div>
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wide">Ship to</p>
          <p className="whitespace-pre-line">{order.shipping_address || "—"}</p>
        </div>
      </section>

      <table className="mt-5 w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-y border-black text-left">
            <th className="py-1.5 pr-2">#</th>
            <th className="py-1.5 pr-2">Item</th>
            <th className="py-1.5 pr-2 text-right">Qty</th>
            <th className="py-1.5 pr-2 text-right">Rate</th>
            <th className="py-1.5 pr-2 text-right">Tax %</th>
            <th className="py-1.5 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {order.items.map((line, index) => (
            <tr key={line.id} className="border-b border-neutral-300 align-top">
              <td className="py-1.5 pr-2">{index + 1}</td>
              <td className="py-1.5 pr-2">
                <div className="font-medium">{line.item_name ?? "—"}</div>
                <div className="font-mono text-[11px] text-neutral-600">
                  {line.item_code ?? `#${line.item_id}`}
                </div>
              </td>
              <td className="py-1.5 pr-2 text-right">{line.quantity} {line.uom_code ?? ""}</td>
              <td className="py-1.5 pr-2 text-right">{money(line.rate)}</td>
              <td className="py-1.5 pr-2 text-right">{line.tax_percent}%</td>
              <td className="py-1.5 text-right">{money(line.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="mt-3 flex justify-end">
        <table className="w-[280px] text-[12px]">
          <tbody>
            <tr><td className="py-0.5 text-neutral-600">Subtotal</td><td className="py-0.5 text-right">{money(order.sub_total)}</td></tr>
            <tr><td className="py-0.5 text-neutral-600">Discount</td><td className="py-0.5 text-right">{money(order.discount_amount)}</td></tr>
            <tr><td className="py-0.5 text-neutral-600">Tax</td><td className="py-0.5 text-right">{money(order.tax_amount)}</td></tr>
            <tr><td className="py-0.5 text-neutral-600">Freight</td><td className="py-0.5 text-right">{money(order.freight_amount)}</td></tr>
            <tr className="border-t border-black">
              <td className="py-1 font-bold">Total</td>
              <td className="py-1 text-right font-bold">{money(order.total_amount)}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="mt-5">
        <p className="mb-1 text-[11px] font-bold uppercase tracking-wide">
          Terms and conditions
        </p>
        <table className="w-full text-[12px]">
          <tbody>
            {terms.map(([label, text]) => (
              <tr key={label} className="align-top">
                <td className="w-[130px] py-1 pr-3 text-neutral-600">{label}</td>
                <td className="py-1 whitespace-pre-line">{text || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {order.remarks && (
        <section className="mt-4">
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wide">Remarks</p>
          <p className="whitespace-pre-line text-[12px]">{order.remarks}</p>
        </section>
      )}

      {order.amendment_reason && (
        <section className="mt-4">
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wide">
            Amendment {order.revision_no}
          </p>
          <p className="text-[12px]">
            {order.amendment_reason}
            {order.amended_at ? ` · ${fmtDate(order.amended_at)}` : ""}
          </p>
        </section>
      )}

      <footer className="mt-12 flex justify-between text-[12px]">
        <div>
          <div className="h-12" />
          <p className="border-t border-black pt-1">Prepared by</p>
        </div>
        <div>
          <div className="h-12" />
          <p className="border-t border-black pt-1">Authorised signatory</p>
        </div>
        <div>
          <div className="h-12" />
          <p className="border-t border-black pt-1">Vendor acknowledgement</p>
        </div>
      </footer>
    </div>
  );
}
