import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/shared/api/client";
import { poApi } from "../api";
import { fmtDate } from "@/shared/datetime";
import { formatPONo } from "@/shared/format";

const money = (value: number | null | undefined) =>
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

      <header className="flex items-start justify-between border-b-2 border-neutral-800 pb-6">
        <div>
          <h1 className="text-xl font-black uppercase tracking-tight text-neutral-900">
            {company?.name || "Purchase order"}
          </h1>
          {company?.legal_name && <p className="mt-1 text-[12px] font-medium text-neutral-700">{company.legal_name}</p>}
          {company?.address && <p className="mt-1 max-w-[380px] text-[12px] leading-relaxed text-neutral-600">{company.address}</p>}
          <p className="mt-2 text-[12px] text-neutral-500">
            {company?.gstin ? <span className="font-medium">GSTIN {company.gstin}</span> : ""}
            {company?.phone ? ` · ${company.phone}` : ""}
          </p>
        </div>
        <div className="text-right">
          <p className="text-lg font-black uppercase tracking-widest text-neutral-800">Purchase Order</p>
          <p className="mt-1 font-mono text-[15px] font-bold text-neutral-900">{formatPONo(order.po_no, order.revision_no)}</p>
          <p className="mt-1 text-[12px] text-neutral-600">Date: <span className="font-medium text-neutral-900">{fmtDate(order.po_date)}</span></p>
          <div className="mt-2 inline-block rounded border border-neutral-200 bg-neutral-50 px-2 py-1">
            <p className="text-[11px] font-bold uppercase tracking-wider text-neutral-600">Status</p>
            <p className="text-[12px] font-medium text-neutral-900">{order.status}</p>
          </div>
        </div>
      </header>

      <div className="mt-8 flex flex-col gap-8">
        {/* Vendor Section */}
        <section className="rounded-lg border border-neutral-200 bg-neutral-50/50 p-6 shadow-sm">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-widest text-neutral-500">Vendor</p>
          <p className="text-[15px] font-bold text-neutral-900">{order.vendor_name ?? "—"}</p>
        </section>

        {/* Order Details Section */}
        <section className="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
          <p className="mb-4 text-[11px] font-bold uppercase tracking-widest text-neutral-500">Order details</p>
          <div className="grid grid-cols-2 gap-y-4 gap-x-8 text-[13px]">
            <div className="flex flex-col border-b border-neutral-100 pb-2">
              <span className="mb-1 text-[11px] font-semibold uppercase text-neutral-400">Project</span>
              <span className="font-medium text-neutral-800">{order.project_name || "—"}</span>
            </div>
            <div className="flex flex-col border-b border-neutral-100 pb-2">
              <span className="mb-1 text-[11px] font-semibold uppercase text-neutral-400">Expected date</span>
              <span className="font-medium text-neutral-800">{fmtDate(order.expected_date)}</span>
            </div>
            <div className="flex flex-col border-b border-neutral-100 pb-2">
              <span className="mb-1 text-[11px] font-semibold uppercase text-neutral-400">Indent</span>
              <span className="font-mono text-neutral-800">{order.indent_no || "—"}</span>
            </div>
            <div className="flex flex-col border-b border-neutral-100 pb-2">
              <span className="mb-1 text-[11px] font-semibold uppercase text-neutral-400">Requisition</span>
              <span className="font-mono text-neutral-800">{order.requisition_no || "—"}</span>
            </div>
            <div className="flex flex-col">
              <span className="mb-1 text-[11px] font-semibold uppercase text-neutral-400">RFQ</span>
              <span className="font-mono text-neutral-800">{order.rfq_no || "—"}</span>
            </div>
            <div className="flex flex-col">
              <span className="mb-1 text-[11px] font-semibold uppercase text-neutral-400">Quotation</span>
              <span className="font-mono text-neutral-800">{order.quotation_no || "—"}</span>
            </div>
          </div>
        </section>

        {/* Addresses Section */}
        <section className="flex flex-col gap-6 rounded-lg border border-neutral-200 bg-neutral-50 p-6 shadow-sm">
          <div className="border-b border-neutral-200 pb-4">
            <p className="mb-2 text-[11px] font-bold uppercase tracking-widest text-brand-600">Bill to</p>
            <p className="break-words whitespace-pre-line text-[13px] leading-relaxed text-neutral-800">{order.billing_address || "—"}</p>
          </div>
          <div>
            <p className="mb-2 text-[11px] font-bold uppercase tracking-widest text-brand-600">Ship to</p>
            <p className="break-words whitespace-pre-line text-[13px] leading-relaxed text-neutral-800">{order.shipping_address || "—"}</p>
          </div>
        </section>
      </div>

      <table className="mt-8 w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-y-2 border-neutral-800 bg-neutral-50/50 text-left text-[11px] uppercase tracking-wider text-neutral-600">
            <th className="py-2.5 pl-2 pr-2">#</th>
            <th className="py-2.5 pr-2">Item</th>
            <th className="py-2.5 pr-2 text-right">Qty</th>
            <th className="py-2.5 pr-2 text-right">Rate</th>
            <th className="py-2.5 pr-2 text-right">Tax %</th>
            <th className="py-2.5 pr-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-200">
          {order.items.map((line, index) => (
            <tr key={line.id} className="align-top">
              <td className="py-3 pl-2 pr-2 text-neutral-500">{index + 1}</td>
              <td className="py-3 pr-2">
                <div className="font-bold text-neutral-900">{line.item_name ?? "—"}</div>
                <div className="mt-0.5 font-mono text-[11px] text-neutral-500">
                  {line.item_code ?? `#${line.item_id}`}
                </div>
              </td>
              <td className="py-3 pr-2 text-right font-medium text-neutral-900">{line.quantity} <span className="text-neutral-500">{line.uom_code ?? ""}</span></td>
              <td className="py-3 pr-2 text-right text-neutral-800">{money(line.rate)}</td>
              <td className="py-3 pr-2 text-right text-neutral-800">{line.tax_percent}%</td>
              <td className="py-3 pr-2 text-right font-bold text-neutral-900">{money(line.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="mt-4 flex justify-end border-b border-neutral-300 pb-4">
        <table className="w-[320px] text-[13px]">
          <tbody className="divide-y divide-neutral-100">
            <tr><td className="py-1.5 pr-4 text-neutral-500">Subtotal</td><td className="py-1.5 text-right font-medium text-neutral-900">{money(order.sub_total)}</td></tr>
            <tr><td className="py-1.5 pr-4 text-neutral-500">Discount</td><td className="py-1.5 text-right font-medium text-neutral-900">{money(order.discount_amount)}</td></tr>
            <tr><td className="py-1.5 pr-4 text-neutral-500">Tax</td><td className="py-1.5 text-right font-medium text-neutral-900">{money(order.tax_amount)}</td></tr>
            <tr><td className="py-1.5 pr-4 text-neutral-500">Freight</td><td className="py-1.5 text-right font-medium text-neutral-900">{money(order.freight_amount)}</td></tr>
            <tr className="border-t-2 border-neutral-800 bg-neutral-50/50">
              <td className="py-2.5 pr-4 font-bold uppercase tracking-wider text-neutral-900">Total</td>
              <td className="py-2.5 text-right text-[15px] font-black text-neutral-900">{money(order.total_amount)}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="mt-8">
        <p className="mb-3 text-[11px] font-bold uppercase tracking-widest text-neutral-500">
          Terms and conditions
        </p>
        <table className="w-full text-[12px]">
          <tbody className="divide-y divide-neutral-100">
            {terms.map(([label, text]) => (
              <tr key={label} className="align-top">
                <td className="w-[140px] py-2.5 pr-4 font-medium text-neutral-700">{label}</td>
                <td className="py-2.5 whitespace-pre-line leading-relaxed text-neutral-800">{text || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {order.remarks && (
        <section className="mt-6 rounded border border-neutral-200 bg-neutral-50/50 p-4">
          <p className="mb-1 text-[11px] font-bold uppercase tracking-widest text-neutral-500">Remarks</p>
          <p className="whitespace-pre-line text-[12px] leading-relaxed text-neutral-800">{order.remarks}</p>
        </section>
      )}

      {order.amendment_reason && (
        <section className="mt-6 rounded border border-amber-200 bg-amber-50 p-4">
          <p className="mb-1 text-[11px] font-bold uppercase tracking-widest text-amber-700">
            Amendment {order.revision_no}
          </p>
          <p className="text-[12px] text-amber-900">
            <span className="font-medium">{order.amendment_reason}</span>
            {order.amended_at ? ` · ${fmtDate(order.amended_at)}` : ""}
          </p>
        </section>
      )}

      <footer className="mt-16 flex justify-between text-[12px]">
        <div className="w-[200px]">
          <div className="h-16" />
          <p className="border-t border-neutral-300 pt-2 font-bold uppercase tracking-wider text-neutral-600">Prepared by</p>
        </div>
        <div className="w-[200px]">
          <div className="h-16" />
          <p className="border-t border-neutral-300 pt-2 font-bold uppercase tracking-wider text-neutral-600">Authorised signatory</p>
        </div>
        <div className="w-[200px]">
          <div className="h-16" />
          <p className="border-t border-neutral-300 pt-2 font-bold uppercase tracking-wider text-neutral-600">Vendor acknowledgement</p>
        </div>
      </footer>
    </div>
  );
}
