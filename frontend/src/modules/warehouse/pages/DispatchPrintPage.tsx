import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getDispatch, warehouseOptions } from "../api";
import { fmtDate, fmtQty } from "../format";
import { PrintTemplate, type PrintColumn } from "@/shared/components";
import { combinationLabel } from "@/shared/combination";

export function DispatchPrintPage() {
  const { id } = useParams();
  const dispatchId = Number(id);

  const query = useQuery({
    queryKey: ["warehouse-dispatch", dispatchId],
    queryFn: () => getDispatch(dispatchId),
    enabled: Number.isFinite(dispatchId) && dispatchId > 0,
  });

  const warehousesQuery = useQuery({
    queryKey: ["print-warehouses"],
    queryFn: () => warehouseOptions(),
    staleTime: 5 * 60 * 1000,
  });
  const warehouses = warehousesQuery.data;

  // The sheet opens the print dialog on its own once it is mounted, so a warehouse
  // name still in flight would go to paper as "WH-3". Hold until it has answered.
  if (query.isLoading || warehousesQuery.isLoading)
    return <p className="p-8 text-sm">Loading the document…</p>;
  if (query.error) return <p className="p-8 text-sm">{(query.error as Error).message}</p>;
  if (!query.data) return <p className="p-8 text-sm">Document not found.</p>;

  const dispatchDoc = query.data;
  
  const warehouse = warehouses?.find((w: any) => w.id === dispatchDoc.warehouse_id || w.value === dispatchDoc.warehouse_id) as any;
  const warehouseName = warehouse?.label || warehouse?.name || `WH-${dispatchDoc.warehouse_id}`;

  const metadata = [
    { label: "Warehouse", value: dispatchDoc.warehouse_id ? warehouseName : "—" },
    { label: "Destination", value: dispatchDoc.destination_office_name || dispatchDoc.to_warehouse_name || "—" },
    { label: "Customer", value: dispatchDoc.customer_name || "—" },
    { label: "Vendor", value: dispatchDoc.vendor_name || "—" },
    { label: "Ref No", value: dispatchDoc.ref_no || "—", mono: true },
    { label: "Gate Pass No", value: dispatchDoc.gate_pass_no || "—", mono: true },
    { label: "Carrier", value: dispatchDoc.carrier_name || "—" },
    { label: "Vehicle Number", value: dispatchDoc.vehicle_number || "—", mono: true },
    { label: "LR No", value: dispatchDoc.lr_no || "—", mono: true },
    { label: "Delivery Address", value: dispatchDoc.delivery_address || "—", fullWidth: true },
  ];

  const columns: PrintColumn[] = [
    { header: "Package No", width: "15%" },
    { header: "Type", width: "10%" },
    { header: "Items", width: "50%" },
    { header: "Weight (kg)", align: "right", width: "10%" },
  ];

  // The rows each carton carries, grouped per item: a package-coded item lists its
  // codes under the carton › box they came out of (2026-10-28), so the paper that
  // travels with the truck says what the stickers say.
  const paths: Record<string, { code: string; name?: string | null }[]> = dispatchDoc.box_paths ?? {};
  const rowsOf = (pkg: any) => {
    const own = (dispatchDoc.items || []).filter((r: any) => r.package_id === pkg.id);
    const source = own.length ? own : (pkg.items || []);
    const by = new Map<string, any>();
    for (const r of source) {
      const key = `${r.item_id}-${r.batch_no ?? ""}-${r.brand_id ?? 0}`;
      const e = by.get(key) ?? { ...r, id: key, quantity: 0, codes: [] as string[], serial_numbers: [] as string[] };
      e.quantity += Number(r.quantity) || 0;
      if (r.box_code) e.codes.push(r.box_code);
      else if (r.serial_no) e.serial_numbers.push(r.serial_no);
      for (const sn of r.serial_numbers ?? []) e.serial_numbers.push(sn);
      by.set(key, e);
    }
    return [...by.values()];
  };
  const pathLabel = (code: string) => (paths[code] ?? [])
    .map((p) => `${(p.name ?? "pack").toLowerCase()} …${p.code.split("-").pop()?.slice(-4)}`).join(" › ");
  const codeGroups = (codes: string[]) => {
    const by = new Map<string, string[]>();
    for (const c of codes) by.set(pathLabel(c), [...(by.get(pathLabel(c)) ?? []), c]);
    return [...by.entries()];
  };

  const items = (dispatchDoc.packages || []).map((pkg: any) => [
    <div key={`no-${pkg.id}`} className="font-mono text-[11px] text-neutral-900">{pkg.package_no ?? "—"}</div>,
    <div key={`type-${pkg.id}`} className="text-neutral-700 capitalize">{pkg.package_type ?? "—"}</div>,
    <div key={`items-${pkg.id}`} className="space-y-1">
      {rowsOf(pkg).map((item: any) => (
        <div key={item.id} className="flex justify-between items-start text-[11px] border-b border-neutral-100 last:border-0 pb-1 last:pb-0">
          <div>
            <span className="font-semibold text-neutral-800">{item.item_name}</span>
            <div className="font-mono text-[10px] text-neutral-500">{item.item_code}</div>
            {combinationLabel(item) && (
              <div className="text-[10px] text-neutral-600">{combinationLabel(item)}</div>
            )}
            {item.codes?.length > 0 && (
              <div className="mt-0.5 space-y-0.5 text-[9px] text-neutral-500">
                {codeGroups(item.codes).map(([where, codes]) => (
                  <div key={where || "-"} className="break-all">
                    {where && <span className="font-semibold capitalize text-neutral-700">{where}: </span>}
                    <span className="font-mono">{codes.join(", ")}</span>
                  </div>
                ))}
              </div>
            )}
            {item.serial_numbers && item.serial_numbers.length > 0 && (
              <div className="mt-0.5 text-[9px] text-neutral-400 break-all">
                S/N: {item.serial_numbers.join(", ")}
              </div>
            )}
          </div>
          <span className="font-medium text-neutral-900 whitespace-nowrap pl-2">
            {fmtQty(item.quantity)}
          </span>
        </div>
      ))}
    </div>,
    <div key={`weight-${pkg.id}`} className="text-right text-neutral-900">
      {fmtQty(pkg.weight_kg)}
    </div>,
  ]);

  return (
    <PrintTemplate
      title="Dispatch Document"
      documentNo={dispatchDoc.dispatch_no}
      date={fmtDate(dispatchDoc.dispatch_date)}
      status={dispatchDoc.status}
      metadata={metadata}
      columns={columns}
      items={items}
      remarks={dispatchDoc.remarks}
    />
  );
}
