import { useNavigate } from "react-router-dom";
import { Chip } from "@heroui/react";
import { StatusPill, type Column } from "@/shared/components";
import { DocumentList } from "../components/DocumentList";
import { DispatchFlowNav } from "../components/DispatchFlowNav";
import { listDispatches } from "../api";
import { daysUntil, fmtDate, fmtQty, humanise } from "../format";
import type { Dispatch as DispatchDoc } from "../types";

/**
 * Dispatches — consignments leaving the site.
 *
 * "Late" is computed against `expected_delivery` and shown on the row rather than
 * behind a filter, because an overdue consignment is the only kind anyone needs to
 * find in a hurry. A delivered consignment is never late, whatever the date says.
 */

const STATUSES = [
  { value: "DRAFT", label: "Draft" },
  { value: "PENDING_APPROVAL", label: "In approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "PACKED", label: "Packed" },
  { value: "DISPATCHED", label: "Dispatched" },
  { value: "IN_TRANSIT", label: "In transit" },
  { value: "DELIVERED", label: "Delivered" },
  { value: "ACKNOWLEDGED", label: "Acknowledged" },
  { value: "CANCELLED", label: "Cancelled" },
];

const SETTLED = ["DELIVERED", "ACKNOWLEDGED", "CANCELLED"];

const destinationOf = (row: DispatchDoc) =>
  row.destination_office_name
  ?? row.delivery_address
  ?? row.to_warehouse_name
  ?? row.customer_name
  ?? row.vendor_name
  ?? "";

export default function Dispatch() {
  const nav = useNavigate();

  const columns: Column<DispatchDoc>[] = [
    {
      key: "no",
      header: "Dispatch",
      render: (r) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{r.dispatch_no}</div>
          <div className="text-[11px] text-muted">{fmtDate(r.dispatch_date)}</div>
        </div>
      ),
    },
    {
      key: "to",
      header: "Destination",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-ink">
            {destinationOf(r) || "—"}
          </div>
          <div className="truncate text-[11px] text-muted">{humanise(r.dispatch_type)}</div>
        </div>
      ),
    },
    {
      key: "transport",
      header: "Transport",
      hideOnNarrow: true,
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-ink">{r.vehicle_number ?? "—"}</div>
          <div className="truncate text-[11px] text-muted">{r.carrier_name ?? r.driver_name ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "load",
      header: "Load",
      className: "text-right",
      render: (r) => (
        <div>
          <div className="tabular text-sm text-ink">{fmtQty(r.total_qty)}</div>
          <div className="text-[11px] text-muted">{r.total_packages} pkg</div>
        </div>
      ),
    },
    {
      key: "eta",
      header: "Expected",
      render: (r) => {
        const days = daysUntil(r.expected_delivery);
        const late = days !== null && days < 0 && !SETTLED.includes(r.status);
        return (
          <div>
            <div className="text-sm text-ink">{fmtDate(r.expected_delivery)}</div>
            {late && <Chip size="sm" variant="flat" color="danger">{-days!}d late</Chip>}
          </div>
        );
      },
    },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
  ];

  return (
    <>
      <DispatchFlowNav />
      <DocumentList<DispatchDoc>
        title="Dispatches"
        queryKey="wh-dispatches"
        fetch={listDispatches}
        columns={columns}
        keyOf={(r) => r.id}
        searchIn={(r) => [
          r.dispatch_no, r.ref_no, r.destination_office_name, r.customer_name, r.vendor_name, r.to_warehouse_name,
          r.vehicle_number, r.lr_no, r.gate_pass_no,
        ]}
        searchPlaceholder="Search dispatch, destination, vehicle or LR..."
        statuses={STATUSES}
        createTo="new"
        createLabel="Confirm dispatch"
        createPermission="dispatch.gate_out"
        onRowClick={(r) => nav(String(r.id))}
        empty="No dispatches match these filters."
        kpis={(rows) => [
          { label: "In transit", value: rows.filter((r) => ["DISPATCHED", "IN_TRANSIT"].includes(r.status)).length },
          { label: "Awaiting gate-out", value: rows.filter((r) => r.status === "PACKED").length, tone: "text-warn" },
          {
            label: "Late",
            value: rows.filter((r) => (daysUntil(r.expected_delivery) ?? 1) < 0 && !SETTLED.includes(r.status)).length,
            tone: "text-bad",
          },
          { label: "Packages out", value: rows.reduce((s, r) => s + (r.total_packages ?? 0), 0) },
        ]}
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs font-semibold text-ink">{r.dispatch_no}</span>
              <StatusPill status={r.status} />
            </div>
            <div className="truncate text-sm text-body">
              {destinationOf(r) || "—"}
            </div>
            <div className="text-[11px] text-muted">
              {r.vehicle_number ?? "no vehicle"} · {r.total_packages} pkg · {fmtQty(r.total_qty)}
            </div>
          </div>
        )}
      />
    </>
  );
}
