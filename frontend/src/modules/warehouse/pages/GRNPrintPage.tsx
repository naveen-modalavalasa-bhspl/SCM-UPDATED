import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getReceipt, warehouseOptions } from "../api";
import { fmtDate, fmtDateTime, fmtQty } from "../format";
import { PrintTemplate, type PrintColumn } from "@/shared/components";
import { combinationLabel } from "@/shared/combination";

export function GRNPrintPage() {
  const { id } = useParams();
  const grnId = Number(id);

  const query = useQuery({
    queryKey: ["warehouse-grn", grnId],
    queryFn: () => getReceipt(grnId),
    enabled: Number.isFinite(grnId) && grnId > 0,
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

  const grn = query.data;
  
  const warehouse = warehouses?.find((w: any) => w.id === grn.warehouse_id || w.value === grn.warehouse_id) as any;
  const warehouseName = warehouse?.label || warehouse?.name || `WH-${grn.warehouse_id}`;

  // A gate entry and a GRN are the SAME ROW (`inb_receipts`, `receipt_type` says
  // which), so one sheet serves both — and must, or the paper a storekeeper hands the
  // driver at the gate would be headed "Goods Receipt Note" over goods that are not
  // ours yet, numbered with a REC the gate never wrote down. The number that identifies
  // a gate entry is `gate_entry_no`; `grn_no` on that row is re-minted when it converts.
  const atGate = grn.receipt_type === "GATE_ENTRY";

  const metadata = [
    { label: "Warehouse", value: grn.warehouse_id ? warehouseName : "—" },
    { label: "Vendor", value: grn.vendor_name || "—" },
    { label: "PO Number", value: grn.po_no || "—", mono: true },
    { label: "Invoice Number", value: grn.invoice_no || "—", mono: true },
    { label: "Vehicle", value: grn.vehicle_no || "—", mono: true },
    ...(atGate
      ? [
          { label: "Transporter", value: grn.transporter_name || "—" },
          { label: "LR Number", value: grn.lr_no || "—", mono: true },
          { label: "E-way Bill", value: grn.eway_bill_no || "—", mono: true },
        ]
      : [
          // The GRN names the gate entry it came in on, and when. The link between the
          // two is the only record that the goods were seen at the gate first.
          { label: "Gate Entry", value: grn.gate_entry_no || "—", mono: true },
          {
            label: "Gate Entry At",
            value: grn.gate_entry_at ? fmtDateTime(grn.gate_entry_at) : "—",
          },
        ]),
  ];

  const columns: PrintColumn[] = [
    { header: "Item" },
    { header: "Code/Batch" },
    { header: "Qty", align: "right" },
    { header: "Remarks" },
  ];

  const items = (grn.items || []).map((line: any) => [
    <div key={`name-${line.id}`} className="font-bold text-neutral-900">{line.item_name ?? "—"}</div>,
    <div key={`code-${line.id}`}>
      <div className="font-mono text-[11px] text-neutral-700">{line.item_code ?? "—"}</div>
      {combinationLabel(line) && (
        <div className="mt-0.5 text-[11px] text-neutral-600">{combinationLabel(line)}</div>
      )}
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
      title={atGate ? "Gate Entry" : "Goods Receipt Note"}
      kicker={atGate ? "Inward — at the gate" : undefined}
      documentNo={atGate ? (grn.gate_entry_no || grn.grn_no) : grn.grn_no}
      date={fmtDate(grn.grn_date)}
      dateFields={
        atGate && grn.gate_entry_at
          ? [["Arrived", fmtDateTime(grn.gate_entry_at)]]
          : undefined
      }
      status={grn.status}
      metadata={metadata}
      columns={columns}
      items={items}
      itemsTitle={atGate ? "Declared at the gate" : "Line items"}
      remarks={grn.remarks}
      signatures={
        atGate
          ? ["Driver", "Security / gate", "Storekeeper", "Authorised signatory"]
          : undefined
      }
      footerNote={
        atGate
          ? "Gate entry only. The goods recorded here have NOT been accepted — acceptance happens on the GRN raised from this entry."
          : undefined
      }
    />
  );
}
