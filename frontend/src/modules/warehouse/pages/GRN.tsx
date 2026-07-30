import { useNavigate } from "react-router-dom";
import { Chip } from "@heroui/react";
import { StatusPill, type Column } from "@/shared/components";
import { DocumentList } from "../components/DocumentList";
import { listReceipts } from "../api";
import { fmtDate, fmtMoneyShort, fmtQty } from "../format";
import type { Receipt } from "../types";

/**
 * Goods receipt notes — what was actually counted off the vehicle.
 *
 * The rejected column is always shown, never hidden behind a filter: a receipt with
 * rejections is the one someone has to act on, and burying it made short and damaged
 * deliveries sit unnoticed until the vendor chased the credit note.
 *
 * `is_stock_posted` is surfaced as its own chip because it is the difference between
 * a document that exists and stock that exists. A completed GRN with nothing posted
 * means the putaway never ran.
 */

const STATUSES = [
  { value: "DRAFT", label: "Draft" },
  { value: "SUBMITTED", label: "Submitted" },
  { value: "PENDING_QC", label: "Awaiting QC" },
  { value: "QC_PASSED", label: "QC passed" },
  { value: "QC_FAILED", label: "QC failed" },
  { value: "PARTIALLY_RECEIVED", label: "Partially received" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
];

export default function GRN() {
  const nav = useNavigate();

  const columns: Column<Receipt>[] = [
    {
      key: "no",
      header: "GRN",
      render: (r) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{r.grn_no}</div>
          <div className="text-[11px] text-muted">{fmtDate(r.grn_date)}</div>
        </div>
      ),
    },
    {
      key: "source",
      header: "Against",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-ink">{r.vendor_name ?? r.transfer_no ?? "—"}</div>
          <div className="truncate font-mono text-[11px] text-muted">{r.po_no ?? r.transfer_no ?? "No PO"}</div>
        </div>
      ),
    },
    {
      key: "qty",
      header: "Received",
      className: "text-right",
      render: (r) => <span className="tabular text-sm text-ink">{fmtQty(r.total_received_qty)}</span>,
    },
    {
      key: "rejected",
      header: "Rejected",
      className: "text-right",
      render: (r) => (
        <span className={`tabular text-sm ${Number(r.total_rejected_qty) > 0 ? "font-semibold text-bad" : "text-muted"}`}>
          {fmtQty(r.total_rejected_qty)}
        </span>
      ),
    },
    {
      key: "value",
      header: "Value",
      className: "text-right",
      hideOnNarrow: true,
      render: (r) => <span className="tabular text-sm text-ink">₹ {fmtMoneyShort(r.total_value)}</span>,
    },
    {
      key: "posted",
      header: "Stock",
      render: (r) => (
        <Chip size="sm" variant="flat" color={r.is_stock_posted ? "success" : "default"}>
          {r.is_stock_posted ? "Posted" : "Not posted"}
        </Chip>
      ),
    },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
  ];

  return (
    <DocumentList<Receipt>
      title="Goods receipt notes"
      queryKey="wh-receipts"
      fetch={(p) => listReceipts({ ...p, receipt_type: "GRN" })}
      extraParams={{ receipt_type: "GRN" }}
      columns={columns}
      keyOf={(r) => r.id}
      searchIn={(r) => [r.grn_no, r.po_no, r.vendor_name, r.invoice_no, r.warehouse_name]}
      searchPlaceholder="Search GRN, PO, vendor or invoice…"
      statuses={STATUSES}
      createTo="new"
      createLabel="New GRN"
      createPermission="grn.create"
      onRowClick={(r) => nav(String(r.id))}
      empty="No receipts match these filters."
      kpis={(rows) => [
        { label: "Awaiting QC", value: rows.filter((r) => r.status === "PENDING_QC").length, tone: "text-warn" },
        { label: "Not posted", value: rows.filter((r) => !r.is_stock_posted && r.status !== "CANCELLED").length },
        {
          label: "Rejected qty",
          value: fmtQty(rows.reduce((s, r) => s + Number(r.total_rejected_qty ?? 0), 0)),
          tone: "text-bad",
        },
        { label: "Value", value: `₹ ${fmtMoneyShort(rows.reduce((s, r) => s + Number(r.total_value ?? 0), 0))}` },
      ]}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs font-semibold text-ink">{r.grn_no}</span>
            <StatusPill status={r.status} />
          </div>
          <div className="truncate text-sm text-body">{r.vendor_name ?? "—"}</div>
          <div className="truncate text-[11px] text-muted">
            {r.po_no ?? "no PO"} · {fmtQty(r.total_received_qty)} received
            {Number(r.total_rejected_qty) > 0 && (
              <span className="font-semibold text-bad"> · {fmtQty(r.total_rejected_qty)} rejected</span>
            )}
          </div>
        </div>
      )}
    />
  );
}
