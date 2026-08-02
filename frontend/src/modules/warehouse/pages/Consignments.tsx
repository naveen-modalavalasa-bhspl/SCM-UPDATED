import { useNavigate } from "react-router-dom";
import { Chip } from "@heroui/react";
import { StatusPill, type Column } from "@/shared/components";
import { DocumentList } from "../components/DocumentList";
import { listConsignments } from "../api";
import { fmtDate, fmtQty, humanise, num } from "../format";
import type { Dispatch } from "../types";

const STATUSES = [
  { value: "PACKED", label: "Ready" },
  { value: "DISPATCHED", label: "Dispatched" },
  { value: "IN_TRANSIT", label: "In transit" },
  { value: "DELIVERED", label: "Delivered" },
  { value: "ACKNOWLEDGED", label: "Acknowledged" },
  { value: "CANCELLED", label: "Cancelled" },
];

const destinationOf = (row: Dispatch) =>
  row.destination_office_name
  ?? row.delivery_address
  ?? row.to_warehouse_name
  ?? row.customer_name
  ?? row.vendor_name
  ?? "";

export default function Consignments() {
  const nav = useNavigate();

  const columns: Column<Dispatch>[] = [
    {
      key: "no",
      header: "Consignment",
      render: (row) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{row.dispatch_no}</div>
          <div className="text-[11px] text-muted">{fmtDate(row.dispatch_date)}</div>
        </div>
      ),
    },
    {
      key: "issue",
      header: "Material issue",
      render: (row) => (
        <div>
          <div className="font-mono text-xs text-ink">{row.ref_no ?? "—"}</div>
          <div className="text-[11px] text-muted">{humanise(row.dispatch_type)}</div>
        </div>
      ),
    },
    {
      key: "to",
      header: "Destination",
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-ink">
            {destinationOf(row) || "—"}
          </div>
          <div className="truncate text-[11px] text-muted">{row.warehouse_name ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "load",
      header: "Packages",
      className: "text-right",
      render: (row) => (
        <div>
          <div className="tabular text-sm text-ink">{row.total_packages}</div>
          <div className="text-[11px] text-muted">{fmtQty(row.total_qty)} qty</div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row) => (
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={row.status} />
          {row.status === "PACKED" && <Chip size="sm" variant="flat" color="success">Ready</Chip>}
        </div>
      ),
    },
  ];

  return (
    <>
      <DocumentList<Dispatch>
        title="Consignments"
        queryKey="wh-consignments"
        fetch={listConsignments}
        columns={columns}
        keyOf={(row) => row.id}
        searchIn={(row) => [
          row.dispatch_no,
          row.ref_no,
          row.destination_office_name,
          row.to_warehouse_name,
          row.vendor_name,
          row.delivery_address,
        ]}
        searchPlaceholder="Search consignment, material issue or destination..."
        statuses={STATUSES}
        createTo="new"
        createLabel="New consignment"
        createPermission="dispatch.create"
        onRowClick={(row) => nav(String(row.id))}
        empty="No consignments match these filters."
        kpis={(rows) => [
          { label: "Ready", value: rows.filter((row) => row.status === "PACKED").length, tone: "text-ok" },
          // num(), not `?? 0`: MySQL DECIMALs arrive as strings, so a bare `+` built
          // "03.00020.000" and fmtQty turned that into "0".
          { label: "Packages", value: rows.reduce((sum, row) => sum + num(row.total_packages), 0) },
          { label: "Quantity", value: fmtQty(rows.reduce((sum, row) => sum + num(row.total_qty), 0)) },
          { label: "Dispatched", value: rows.filter((row) => ["DISPATCHED", "IN_TRANSIT"].includes(row.status)).length },
        ]}
        renderCard={(row) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs font-semibold text-ink">{row.dispatch_no}</span>
              <StatusPill status={row.status} />
            </div>
            <div className="font-mono text-xs text-muted">{row.ref_no ?? "No issue"}</div>
            <div className="truncate text-xs text-body">{destinationOf(row) || "No destination"}</div>
            <div className="text-[11px] text-muted">{row.total_packages} pkg · {fmtQty(row.total_qty)}</div>
          </div>
        )}
      />
    </>
  );
}
