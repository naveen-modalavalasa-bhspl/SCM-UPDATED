import { useNavigate } from "react-router-dom";
import { FileText } from "lucide-react";
import { type Column } from "@/shared/components";
import { ConsignmentStatusPill, statusTone } from "../components/ConsignmentStatusPill";
import { DocumentList } from "../components/DocumentList";
import { listConsignments, deleteDispatch, DRAFT_DELETE_PERMISSION } from "../api";
import { fmtDate, fmtQty, humanise, num } from "../format";
import type { Dispatch } from "../types";

/**
 * Status filter values mirror the Status column exactly. "Ready" stays a KPI bucket;
 * it is not a stored status on the consignment row.
 *
 * The list used to hold eight hand-picked labels ("Ready", "Awaiting release",
 * "Released") and left DRAFT and REJECTED out entirely, so two of the ten rungs a
 * consignment travels could be READ in the Status column and not FILTERED on: a desk
 * looking for its unfinished drafts had to page the whole queue. The friendly labels
 * made it worse — the column said DISPATCHED and the filter said "Released", so it was
 * not obvious they were the same set.
 *
 * Derived from one list of values now, and every value is a real `DispatchStatus`, so
 * a rung cannot be added to the type and quietly missed here. Do not reintroduce a
 * display-only entry: "Ready" is `PACKED || APPROVED`, which the server cannot filter
 * on, so putting it back gives a menu row that returns nothing.
 */
const STATUS_VALUES = [
  "DRAFT",
  "PACKED",
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "DISPATCHED",
  "IN_TRANSIT",
  "DELIVERED",
  "ACKNOWLEDGED",
  "CANCELLED",
] as const;

const statusLabel = (status: string) => status.replace(/_/g, " ");

// The menu wears the column's own colours: the dot beside a row is the same fill
// the pill carries, so filtering to a status and reading it back look alike.
const STATUSES = STATUS_VALUES.map((status) => ({
  value: status,
  label: statusLabel(status),
  dot: statusTone(status)[1],
}));

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
      render: (row) => <ConsignmentStatusPill status={row.status} />,
    },
    {
      key: "actions",
      header: "",
      className: "w-12 text-right",
      render: (r) => (
        <div className="flex justify-end gap-1">
          <button
            type="button"
            aria-label={`Print ${r.dispatch_no || "Draft"}`}
            title="Download PDF"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-neutral-100 hover:text-ink"
            onClick={(e) => {
              e.stopPropagation();
              window.open(`/warehouse/consignments/${r.id}/print`, "_blank");
            }}
          >
            <FileText className="h-4 w-4" />
          </button>
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
        searchPlaceholder="Search consignment, issue or destination..."
        // Two pills sit beside it, so the box takes whatever they leave: the strip
        // reads as one filled row rather than a short field with a gap after it.
        searchClassName="sm:w-auto sm:min-w-[18rem] sm:flex-1"
        statuses={STATUSES}
        warehouseOptionsScope="all"
        createTo="new"
        createLabel="New consignment"
        createPermission="dispatch.create"
        onRowClick={(row) => nav(String(row.id))}
        empty="No consignments match these filters."
        onDelete={(row) => deleteDispatch(row.id)}
        canDelete={(row) => row.status === "DRAFT"}
        deletePermission={DRAFT_DELETE_PERMISSION.dispatch}
        deleteLabel="consignment"
        labelOf={(row) => row.dispatch_no ?? `Consignment ${row.id}`}
        kpiCounts={[
          { label: "Ready", statuses: ["PACKED", "APPROVED"], tone: "ok" },
          { label: "Dispatched", statuses: ["DISPATCHED", "IN_TRANSIT"] },
        ]}
        kpis={(rows) => [
          // num(), not `?? 0`: MySQL DECIMALs arrive as strings, so a bare `+` built
          // "03.00020.000" and fmtQty turned that into "0".
          { label: "Packages", value: rows.reduce((sum, row) => sum + num(row.total_packages), 0) },
          { label: "Quantity", value: fmtQty(rows.reduce((sum, row) => sum + num(row.total_qty), 0)) },
        ]}
        renderCard={(row) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs font-semibold text-ink">{row.dispatch_no}</span>
              <div className="flex items-center gap-2">
                <ConsignmentStatusPill status={row.status} />
                <button
                  type="button"
                  className="text-muted hover:text-ink p-1"
                  onClick={(e) => {
                    e.stopPropagation();
                    window.open(`/warehouse/consignments/${row.id}/print`, "_blank");
                  }}
                >
                  <FileText className="h-4 w-4" />
                </button>
              </div>
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
