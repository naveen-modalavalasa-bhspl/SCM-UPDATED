import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/shared/api/client";
import { getReceipt, warehouseOptions } from "../api";
import { fmtDate, fmtQty } from "../format";
import { PrintTemplate } from "@/shared/components";

export function GRNPrintPage() {
  const { id } = useParams();
  const grnId = Number(id);

  const query = useQuery({
    queryKey: ["warehouse-grn", grnId],
    queryFn: () => getReceipt(grnId),
    enabled: Number.isFinite(grnId) && grnId > 0,
  });

  const { data: company } = useQuery({
    queryKey: ["print-company"],
    queryFn: () =>
      api.get<{ company?: Record<string, string> }>("/api/settings")
        .then((r) => r.data.company ?? {})
        .catch(() => ({} as Record<string, string>)),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const { data: warehouses } = useQuery({
    queryKey: ["print-warehouses"],
    queryFn: () => warehouseOptions(),
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (!query.data) return;
    const timer = setTimeout(() => window.print(), 250);
    return () => clearTimeout(timer);
  }, [query.data]);

  if (query.isLoading) return <p className="p-8 text-sm">Loading the document…</p>;
  if (query.error) return <p className="p-8 text-sm">{(query.error as Error).message}</p>;
  if (!query.data) return <p className="p-8 text-sm">Document not found.</p>;

  const grn = query.data;
  
  const warehouse = warehouses?.find((w: any) => w.id === grn.warehouse_id || w.value === grn.warehouse_id) as any;
  const warehouseName = warehouse?.label || warehouse?.name || `WH-${grn.warehouse_id}`;

  const metadata = [
    { label: "Warehouse", value: grn.warehouse_id ? warehouseName : "—" },
    { label: "Vendor", value: grn.vendor_name || "—" },
    { label: "PO Number", value: grn.po_no || "—", mono: true },
    { label: "Invoice Number", value: grn.invoice_no || "—", mono: true },
    { label: "Vehicle", value: grn.vehicle_number || "—", mono: true },
    { label: "Gate Register", value: grn.gate_register ? "Yes" : "No" },
  ];

  const columns = [
    { header: "Item" },
    { header: "Code/Batch" },
    { header: "Qty", className: "text-right" },
    { header: "Remarks" },
  ];

  const items = (grn.items || []).map((line: any) => [
    <div key={`name-${line.id}`} className="font-bold text-neutral-900">{line.item_name ?? "—"}</div>,
    <div key={`code-${line.id}`}>
      <div className="font-mono text-[11px] text-neutral-700">{line.item_code ?? "—"}</div>
      {line.batch_no && (
        <div className="mt-0.5 text-[11px] text-neutral-500">Batch: {line.batch_no}</div>
      )}
    </div>,
    <div key={`qty-${line.id}`} className="text-right font-medium text-neutral-900">
      {fmtQty(line.received_qty)} <span className="text-neutral-500">{line.uom_code ?? ""}</span>
    </div>,
    <div key={`rem-${line.id}`} className="text-neutral-700">{line.remarks || "—"}</div>,
  ]);

  return (
    <PrintTemplate
      title="Goods Receipt Note"
      documentNo={grn.grn_no}
      date={fmtDate(grn.grn_date)}
      status={grn.status}
      companyName={company?.name}
      companyLegalName={company?.legal_name}
      companyAddress={company?.address}
      metadata={metadata}
      columns={columns}
      items={items}
      remarks={grn.remarks}
    />
  );
}
