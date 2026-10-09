import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getPutaway, warehouseOptions } from "../api";
import { fmtDate, fmtQty } from "../format";
import { PrintTemplate, type PrintColumn } from "@/shared/components";

export function PutawayPrintPage() {
  const { id } = useParams();
  const putawayId = Number(id);

  const query = useQuery({
    queryKey: ["warehouse-putaway", putawayId],
    queryFn: () => getPutaway(putawayId),
    enabled: Number.isFinite(putawayId) && putawayId > 0,
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

  const putaway = query.data;
  
  const warehouse = warehouses?.find((w: any) => w.id === putaway.warehouse_id || w.value === putaway.warehouse_id) as any;
  const warehouseName = warehouse?.label || warehouse?.name || `WH-${putaway.warehouse_id}`;

  const metadata = [
    { label: "Warehouse", value: putaway.warehouse_id ? warehouseName : "—" },
    { label: "Assigned To", value: putaway.assigned_to_name || "—" },
    { label: "Item", value: putaway.item_name || "—", fullWidth: true },
    { label: "Code", value: putaway.item_code || "—", mono: true },
    { label: "Batch", value: putaway.batch_no || "—", mono: true },
    { label: "Suggested Bin", value: putaway.suggested_bin_code || "—", mono: true },
    { label: "Total Quantity", value: fmtQty(putaway.qty) },
  ];

  const columns: PrintColumn[] = [
    { header: "Putaway Bin", width: "40%" },
    { header: "Quantity", align: "right", width: "40%" },
  ];

  // A putaway task is ONE item into ONE bin — `whs_putaway` has no location lines to
  // loop over. The bin printed is the one it actually went into, falling back to the
  // suggestion while the task is still open.
  const items = [[
    <div key="bin" className="font-mono text-neutral-900">
      {putaway.actual_bin_path || putaway.actual_bin_code || putaway.suggested_bin_code || "—"}
    </div>,
    <div key="qty" className="text-right font-medium text-neutral-900">
      {fmtQty(putaway.qty)}
    </div>,
  ]];

  return (
    <PrintTemplate
      title="Putaway Task"
      documentNo={putaway.putaway_no}
      date={fmtDate(putaway.created_at)}
      status={putaway.status}
      metadata={metadata}
      columns={columns}
      items={items}
      remarks={putaway.remarks}
    />
  );
}
