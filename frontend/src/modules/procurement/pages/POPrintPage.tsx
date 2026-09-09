import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PrintPanel, PrintTemplate, SectionTitle, type PrintColumn } from "@/shared/components";
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
 * The paper is `@/shared/components/PrintTemplate`, the same sheet the indent this
 * order came from prints on. It is the same company placing the order, and until this
 * they were two different letterheads.
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

  const columns: PrintColumn[] = [
    { header: "Item", width: "38%" },
    { header: "Qty", align: "right", width: "13%" },
    { header: "Rate", align: "right", width: "14%" },
    { header: "Tax %", align: "right", width: "10%" },
    { header: "Amount", align: "right", width: "15%" },
  ];

  return (
    <PrintTemplate
      title="Purchase Order"
      kicker="Order placed on the vendor"
      documentNo={formatPONo(order.po_no, order.revision_no)}
      dateFields={[
        ["Order date", fmtDate(order.po_date)],
        ["Expected", fmtDate(order.expected_date)],
      ]}
      status={order.status}
      metadata={[
        { label: "Vendor", value: order.vendor_name ?? "—", fullWidth: true },
        { label: "Project", value: order.project_name || "—" },
        { label: "Indent", value: order.indent_no || "—", mono: true },
        { label: "Requisition", value: order.requisition_no || "—", mono: true },
        { label: "RFQ", value: order.rfq_no || "—", mono: true },
        { label: "Quotation", value: order.quotation_no || "—", mono: true },
      ]}
      blocks={[{
        title: "Addresses",
        columns: 2,
        fields: [
          {
            label: "Bill to",
            value: <span className="whitespace-pre-line break-words">{order.billing_address || "—"}</span>,
          },
          {
            label: "Ship to",
            value: <span className="whitespace-pre-line break-words">{order.shipping_address || "—"}</span>,
          },
        ],
      }]}
      columns={columns}
      items={order.items.map((line) => [
        <>
          <div className="font-semibold" style={{ color: "#141a2a" }}>{line.item_name ?? "—"}</div>
          <div className="mt-0.5 font-mono text-[8.5px]" style={{ color: "#697187" }}>
            {line.item_code ?? `#${line.item_id}`}
          </div>
        </>,
        <>{line.quantity} <span style={{ color: "#697187" }}>{line.uom_code ?? ""}</span></>,
        money(line.rate),
        `${line.tax_percent}%`,
        <span className="font-semibold" style={{ color: "#141a2a" }}>{money(line.amount)}</span>,
      ])}
      itemsTotal={["", "", "", "", money(order.total_amount)]}
      remarks={order.remarks}
      signatures={["Prepared by", "Verified by", "Authorised signatory", "Vendor acknowledgement"]}
    >
      {/* ── What the order comes to ─────────────────────────────────────── */}
      <section className="avoid-break mt-4 flex justify-end">
        <table className="w-[70mm] text-[10px]">
          <tbody>
            {([
              ["Subtotal", order.sub_total],
              ["Discount", order.discount_amount],
              ["Tax", order.tax_amount],
              ["Freight", order.freight_amount],
            ] as [string, number | null | undefined][]).map(([label, value]) => (
              <tr key={label}>
                <td className="py-1 pr-4" style={{ color: "#697187" }}>{label}</td>
                <td className="py-1 text-right font-medium" style={{ color: "#141a2a" }}>{money(value)}</td>
              </tr>
            ))}
            <tr style={{ borderTop: "1.5px solid #CC004C" }}>
              <td className="py-1.5 pr-4 text-[9px] font-bold uppercase tracking-[0.1em]" style={{ color: "#697187" }}>
                Order total
              </td>
              <td className="py-1.5 text-right text-[12px] font-black" style={{ color: "#141a2a" }}>
                {money(order.total_amount)}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* ── The terms, empty ones included ──────────────────────────────── */}
      <section className="avoid-break mt-5">
        <SectionTitle>Terms and conditions</SectionTitle>
        <table className="w-full text-[10px]">
          <tbody>
            {terms.map(([label, text]) => (
              <tr key={label} className="align-top">
                <td className="w-[34mm] border-b border-dotted py-1.5 pr-4 font-semibold"
                    style={{ color: "#697187", borderColor: "#e5e8ef" }}>
                  {label}
                </td>
                <td className="whitespace-pre-line border-b border-dotted py-1.5 leading-relaxed"
                    style={{ color: "#141a2a", borderColor: "#e5e8ef" }}>
                  {text || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {order.amendment_reason && (
        <section className="mt-5">
          <SectionTitle>Amendment {order.revision_no}</SectionTitle>
          <PrintPanel tone="warn">
            <span className="font-semibold">{order.amendment_reason}</span>
            {order.amended_at ? ` · ${fmtDate(order.amended_at)}` : ""}
          </PrintPanel>
        </section>
      )}
    </PrintTemplate>
  );
}
