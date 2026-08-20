import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/shared/api/client";
import { getConsignment, warehouseOptions } from "../api";
import { fmtDate, fmtQty } from "../format";
import { PrintTemplate } from "@/shared/components";

export function ConsignmentPrintPage() {
  const { id } = useParams();
  const consignmentId = Number(id);

  const query = useQuery({
    queryKey: ["warehouse-consignment", consignmentId],
    queryFn: () => getConsignment(consignmentId),
    enabled: Number.isFinite(consignmentId) && consignmentId > 0,
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

  const consignment = query.data;
  
  const warehouse = warehouses?.find((w: any) => w.id === consignment.warehouse_id || w.value === consignment.warehouse_id) as any;
  const warehouseName = warehouse?.label || warehouse?.name || `WH-${consignment.warehouse_id}`;

  const metadata = [
    { label: "Warehouse", value: consignment.warehouse_id ? warehouseName : "—" },
    { label: "Destination", value: consignment.destination_office_name || consignment.to_warehouse_name || "—" },
    { label: "Ref No", value: consignment.ref_no || "—", mono: true },
    { label: "Carrier", value: consignment.carrier_name || "—" },
    { label: "Vehicle Number", value: consignment.vehicle_number || "—", mono: true },
    { label: "LR No", value: consignment.lr_no || "—", mono: true },
    { label: "Delivery Address", value: consignment.delivery_address || "—", fullWidth: true },
  ];

  const columns = [
    { header: "Package No", className: "w-[15%]" },
    { header: "Type", className: "w-[10%]" },
    { header: "Items", className: "w-[50%]" },
    { header: "Weight (kg)", className: "text-right w-[10%]" },
  ];

  const items = (consignment.packages || []).map((pkg: any) => {
    const pkgItems = (consignment.items || []).filter((item: any) => item.package_id === pkg.id);
    
    return [
      <div key={`no-${pkg.id}`} className="font-mono text-[11px] text-neutral-900">{pkg.package_no ?? "—"}</div>,
      <div key={`type-${pkg.id}`} className="text-neutral-700 capitalize">{pkg.package_type ?? "—"}</div>,
      <div key={`items-${pkg.id}`} className="space-y-1">
        {pkgItems.map((item: any) => (
          <div key={item.id} className="flex justify-between items-start text-[11px] border-b border-neutral-100 last:border-0 pb-1 last:pb-0">
            <div>
              <span className="font-semibold text-neutral-800">{item.item_name}</span>
              <div className="font-mono text-[10px] text-neutral-500">{item.item_code}</div>
              {item.serial_numbers && item.serial_numbers.length > 0 && (
                <div className="mt-0.5 text-[9px] text-neutral-400 break-all">
                  S/N: {item.serial_numbers.join(", ")}
                </div>
              )}
            </div>
            <span className="font-medium text-neutral-900 whitespace-nowrap pl-2">
              {fmtQty(item.quantity)} <span className="text-[10px] text-neutral-500">{item.uom_code ?? ""}</span>
            </span>
          </div>
        ))}
        {pkgItems.length === 0 && (
          <div className="text-[11px] text-neutral-400 italic">No items</div>
        )}
      </div>,
      <div key={`weight-${pkg.id}`} className="text-right text-neutral-900">
        {fmtQty(pkg.weight_kg)}
      </div>,
    ];
  });

  return (
    <PrintTemplate
      title="Consignment"
      documentNo={consignment.dispatch_no}
      date={fmtDate(consignment.dispatch_date)}
      status={consignment.status}
      companyName={company?.name}
      companyLegalName={company?.legal_name}
      companyAddress={company?.address}
      metadata={metadata}
      columns={columns}
      items={items}
      remarks={consignment.remarks}
    />
  );
}
