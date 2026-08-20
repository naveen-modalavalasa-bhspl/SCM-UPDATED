import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/shared/api/client";
import { getStockMovementOrder, warehouseOptions } from "../api";
import { fmtDate, fmtQty } from "../format";
import { PrintTemplate } from "@/shared/components";

export function StockMovementPrintPage() {
  const [params] = useSearchParams();
  const orderNo = params.get("order_no");

  const query = useQuery({
    queryKey: ["warehouse-stock-movement-order", orderNo],
    queryFn: () => getStockMovementOrder(orderNo as string),
    enabled: !!orderNo,
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

  const order = query.data;
  
  const warehouse = warehouses?.find((w: any) => w.id === order.warehouse_id || w.value === order.warehouse_id) as any;
  const warehouseName = warehouse?.label || warehouse?.name || `WH-${order.warehouse_id}`;

  const metadata = [
    { label: "Warehouse", value: order.warehouse_id ? warehouseName : "—" },
    { label: "Status", value: order.status || "—" },
    { label: "Created By", value: order.created_by_name || "—" },
  ];

  const columns = [
    { header: "Item" },
    { header: "From" },
    { header: "To" },
    { header: "Quantity", className: "text-right w-[15%]" },
  ];

  const items = (order.items || []).map((line: any) => [
    <div key={`name-${line.id}`} className="font-bold text-neutral-900">{line.item_name ?? "—"}
      <div className="font-mono text-[10px] text-neutral-500 font-normal">{line.item_code}</div>
    </div>,
    <div key={`src-${line.id}`}>
      <div className="font-mono text-[11px] text-neutral-700">{line.source_bin_code ?? "—"}</div>
      {line.batch_id && (
        <div className="mt-0.5 text-[10px] text-neutral-500">Batch: {line.batch_id}</div>
      )}
    </div>,
    <div key={`dst-${line.id}`}>
      <div className="font-mono text-[11px] text-neutral-700">{line.destination_bin_code ?? "—"}</div>
    </div>,
    <div key={`qty-${line.id}`} className="text-right font-medium text-neutral-900">
      {fmtQty(line.quantity)} <span className="text-[10px] text-neutral-500 font-normal">{line.uom_code ?? ""}</span>
    </div>,
  ]);

  return (
    <PrintTemplate
      title="Stock Movement Order"
      documentNo={order.order_no}
      date={fmtDate(order.created_at)}
      status={order.status}
      companyName={company?.name}
      companyLegalName={company?.legal_name}
      companyAddress={company?.address}
      metadata={metadata}
      columns={columns}
      items={items}
      remarks={order.reason}
    />
  );
}
