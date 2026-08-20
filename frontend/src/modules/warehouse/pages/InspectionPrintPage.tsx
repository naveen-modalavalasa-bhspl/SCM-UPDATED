import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/shared/api/client";
import { getInspection, getOutboundInspection, warehouseOptions } from "../api";
import { fmtDate, fmtQty } from "../format";
import { PrintTemplate } from "@/shared/components";

export function InspectionPrintPage() {
  const { id } = useParams();
  const inspectionId = Number(id);
  const [params] = useSearchParams();
  const type = params.get("type") || "INCOMING";

  const isOutgoing = type === "OUTGOING";

  const query = useQuery({
    queryKey: ["warehouse-inspection", type, inspectionId],
    queryFn: () => isOutgoing ? getOutboundInspection(inspectionId) : getInspection(inspectionId),
    enabled: Number.isFinite(inspectionId) && inspectionId > 0,
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

  const inspection = query.data as any;
  
  const warehouse = warehouses?.find((w: any) => w.id === inspection.warehouse_id || w.value === inspection.warehouse_id) as any;
  const warehouseName = warehouse?.label || warehouse?.name || `WH-${inspection.warehouse_id}`;

  const metadata = [
    { label: "Warehouse", value: inspection.warehouse_id ? warehouseName : "—" },
    { label: "Inspector", value: inspection.inspector_name || "—" },
    { label: isOutgoing ? "Material Issue No" : "GRN No", value: isOutgoing ? inspection.issue_no : inspection.grn_no || "—", mono: true },
    { label: "Passed Items", value: inspection.passed_items?.toString() || "0" },
    { label: "Failed Items", value: inspection.failed_items?.toString() || "0" },
  ];

  if (!isOutgoing) {
    metadata.push({ label: "Vendor", value: inspection.vendor_name || "—" });
  }

  const columns = [
    { header: "Item" },
    { header: "Code/Batch" },
    { header: "Requested", className: "text-right w-[10%]" },
    { header: "Accepted", className: "text-right w-[10%]" },
    { header: "Rejected", className: "text-right w-[10%]" },
    { header: "Status", className: "w-[15%]" },
  ];

  const items = (inspection.items || []).map((line: any) => [
    <div key={`name-${line.id}`} className="font-bold text-neutral-900">{line.item_name ?? "—"}</div>,
    <div key={`code-${line.id}`}>
      <div className="font-mono text-[11px] text-neutral-700">{line.item_code ?? "—"}</div>
      {line.batch_no && (
        <div className="mt-0.5 text-[11px] text-neutral-500">Batch: {line.batch_no}</div>
      )}
    </div>,
    <div key={`req-${line.id}`} className="text-right text-neutral-800">
      {fmtQty(line.requested_qty)} <span className="text-neutral-500">{line.uom_code ?? ""}</span>
    </div>,
    <div key={`acc-${line.id}`} className="text-right font-medium text-green-700">
      {fmtQty(line.accepted_qty)}
    </div>,
    <div key={`rej-${line.id}`} className="text-right font-medium text-red-700">
      {fmtQty(line.rejected_qty)}
    </div>,
    <div key={`stat-${line.id}`} className="text-neutral-700 uppercase tracking-wider text-[10px] font-bold">
      {line.result || "PENDING"}
    </div>,
  ]);

  return (
    <PrintTemplate
      title={isOutgoing ? "Outbound Quality Inspection" : "Inbound Quality Inspection"}
      documentNo={inspection.inspection_no}
      date={fmtDate(inspection.created_at)}
      status={inspection.status}
      companyName={company?.name}
      companyLegalName={company?.legal_name}
      companyAddress={company?.address}
      metadata={metadata}
      columns={columns}
      items={items}
      remarks={inspection.remarks}
    />
  );
}
