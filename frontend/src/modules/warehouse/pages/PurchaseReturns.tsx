import { useNavigate } from "react-router-dom";
import { StatusPill, type Column } from "@/shared/components";
import { DocumentList } from "../components/DocumentList";
import {
  DRAFT_DELETE_PERMISSION,
  deletePurchaseReturn,
  listReturns,
} from "../api";
import { fmtDate, fmtMoney, fmtQty } from "../format";
import type { PurchaseReturn } from "../types";

/**
 * Purchase Return drafts — and what happened to them afterwards.
 *
 * Defaults to `status=DRAFT`: a draft is the only thing that can still be
 * edited, deleted or sent, so it is what this queue is for. The status menu
 * (and the Sent tile) opens the rows already sent, which are read-only.
 */

const STATUSES = [
  { value: "DRAFT", label: "Draft" },
  { value: "SENT_TO_VENDOR", label: "Sent to vendor" },
  { value: "VENDOR_APPROVED", label: "Approved — refund or vehicle" },
  { value: "AWAITING_VENDOR_VEHICLE", label: "Vendor arranging vehicle" },
  { value: "VEHICLE_REQUESTED", label: "Vehicle requested" },
  { value: "IN_TRANSIT", label: "On the road" },
  { value: "RECEIVED_AT_WAREHOUSE", label: "Received at warehouse" },
  { value: "REFUNDED", label: "Refunded" },
  { value: "PENDING_APPROVAL", label: "In approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "DISPATCHED", label: "Dispatched" },
  { value: "COMPLETED", label: "Completed" },
  { value: "REJECTED", label: "Rejected" },
  { value: "CANCELLED", label: "Cancelled" },
];

export default function PurchaseReturns() {
  const nav = useNavigate();

  const columns: Column<PurchaseReturn>[] = [
    {
      key: "no",
      header: "Return",
      render: (r) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{r.return_no}</div>
          <div className="text-[11px] text-muted">{fmtDate(r.return_date)}</div>
        </div>
      ),
    },
    // A return raised automatically off a branch consignment stores no vendor, GRN or
    // PO at all. The chain behind its stock is read for the page and served on the
    // `traced_*` fields — shown here, and marked, so the row is not three em dashes.
    {
      key: "vendor",
      header: "Vendor",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-ink">
            {r.vendor_name ?? r.traced_vendor_name ?? "—"}
          </div>
          <div className="truncate text-[11px] text-muted">
            {r.vendor_code ?? (r.chain_traced ? "traced" : "")}
          </div>
        </div>
      ),
    },
    {
      key: "against",
      header: "Invoice / PO",
      render: (r) => {
        const po = r.po_no ?? r.traced_po_no ?? null;
        const grn = r.grn_no ?? r.traced_grn_no ?? null;
        return (
          <div className="text-sm">
            <div className="text-ink">{po ?? "—"}</div>
            <div className="text-[11px] text-muted">{grn ? `GRN ${grn}` : ""}</div>
          </div>
        );
      },
    },
    {
      key: "items",
      header: "Items",
      render: (r) => (
        <div className="text-sm">
          <div className="text-ink">{r.total_items} {r.total_items === 1 ? "item" : "items"}</div>
          <div className="text-[11px] text-muted">Qty {fmtQty(r.total_qty)}</div>
        </div>
      ),
    },
    {
      key: "value",
      header: "Total",
      hideOnNarrow: true,
      render: (r) => <span className="text-sm tabular">₹ {fmtMoney(r.total_value)}</span>,
    },
    {
      key: "status",
      header: "Status",
      // `status_label` where the supplier has answered — "Replacement to warehouse"
      // rather than a sent return that has plainly moved on. Colour still comes from the
      // stored status, which is untouched.
      render: (r) => <StatusPill status={r.status} label={r.status_label ?? undefined} />,
    },
    {
      key: "created",
      header: "Created",
      hideOnNarrow: true,
      render: (r) => <span className="text-sm text-muted">{fmtDate(r.created_at)}</span>,
    },
  ];

  return (
    <DocumentList<PurchaseReturn>
      eyebrow="Returns"
      title="Purchase returns"
      queryKey="warehouse-purchase-returns"
      fetch={(params) => listReturns({ ...params, status: params.status ?? "DRAFT" })}
      columns={columns}
      renderCard={(r) => (
        <div>
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs font-semibold text-ink">{r.return_no}</span>
            <StatusPill status={r.status} label={r.status_label ?? undefined} />
          </div>
          <div className="mt-1 text-sm text-ink">{r.vendor_name ?? "—"}</div>
          <div className="text-[11px] text-muted">
            {[r.po_no, r.grn_no ? `GRN ${r.grn_no}` : null].filter(Boolean).join(" · ") || "—"}
          </div>
          <div className="mt-1 text-[11px] text-muted">
            {r.total_items} items · Qty {fmtQty(r.total_qty)} · ₹ {fmtMoney(r.total_value)} · {fmtDate(r.return_date)}
          </div>
        </div>
      )}
      keyOf={(r) => r.id}
      searchPlaceholder="Search return, PO, GRN, vendor…"
      statuses={STATUSES}
      kpiCounts={[
        { label: "Drafts", statuses: ["DRAFT"] },
        { label: "Sent", statuses: ["SENT_TO_VENDOR"] },
      ]}
      onRowClick={(r) => nav(`/warehouse/purchase-returns/${r.id}`)}
      createTo="/warehouse/purchase-returns/new"
      createLabel="New return"
      createPermission="return.create"
      empty="No purchase returns here yet. Raise one against a Purchase Invoice or PO."
      onDelete={(r) => deletePurchaseReturn(r.id)}
      canDelete={(r) => r.status === "DRAFT"}
      deletePermission={DRAFT_DELETE_PERMISSION.return}
      deleteLabel="purchase return draft"
      labelOf={(r) => r.return_no}
    />
  );
}
