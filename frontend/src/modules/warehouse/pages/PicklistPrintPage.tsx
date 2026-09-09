import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getPicking, warehouseOptions } from "../api";
import { fmtDate, fmtQty } from "../format";
import { PrintTemplate, type PrintColumn } from "@/shared/components";

export function PicklistPrintPage() {
  const { id } = useParams();
  const picklistId = Number(id);

  const query = useQuery({
    queryKey: ["warehouse-picking", picklistId],
    queryFn: () => getPicking(picklistId),
    enabled: Number.isFinite(picklistId) && picklistId > 0,
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

  const picking = query.data;
  
  const warehouse = warehouses?.find((w: any) => w.id === picking.warehouse_id || w.value === picking.warehouse_id) as any;
  const warehouseName = warehouse?.label || warehouse?.name || `WH-${picking.warehouse_id}`;

  const metadata = [
    { label: "Warehouse", value: picking.warehouse_id ? warehouseName : "—" },
    { label: "Picker", value: picking.assigned_to_name || "—" },
    { label: "Reference No", value: picking.ref_no || "—", mono: true },
    { label: "Pick Date", value: fmtDate(picking.pick_date) || "—" },
  ];

  const columns: PrintColumn[] = [
    { header: "Item" },
    { header: "Code/Batch" },
    { header: "Bin", width: "15%" },
    { header: "Picked", align: "right", width: "10%" },
  ];

  const items = (picking.items || []).map((line: any) => [
    <div key={`name-${line.id}`} className="font-bold text-neutral-900">{line.item_name ?? "—"}</div>,
    <div key={`code-${line.id}`}>
      <div className="font-mono text-[11px] text-neutral-700">{line.item_code ?? "—"}</div>
      {line.batch_no && (
        <div className="mt-0.5 text-[11px] text-neutral-500">Batch: {line.batch_no}</div>
      )}
    </div>,
    <div key={`bin-${line.id}`} className="font-mono text-[11px] text-neutral-800">{line.bin_code ?? "—"}</div>,
    <div key={`qty-${line.id}`} className="text-right font-medium text-neutral-900">
      {fmtQty(line.picked_qty)} <span className="text-neutral-500">{line.uom_code ?? ""}</span>
    </div>,
  ]);

  return (
    <PrintTemplate
      title="Material Fulfilment"
      documentNo={picking.pick_no}
      date={fmtDate(picking.pick_date)}
      status={picking.status}
      metadata={metadata}
      columns={columns}
      items={items}
    />
  );
}
