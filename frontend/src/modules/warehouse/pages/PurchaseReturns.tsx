import { useNavigate } from "react-router-dom";
import { Chip } from "@heroui/react";
import { StatusPill, type Column } from "@/shared/components";
import { DocumentList } from "../components/DocumentList";
import { listReturns, deletePurchaseReturn, DRAFT_DELETE_PERMISSION } from "../api";
import { fmtDate, fmtMoneyShort, fmtQty } from "../format";
import type { PurchaseReturn } from "../types";

/**
 * Purchase returns — rejected or damaged stock going back to the vendor.
 *
 * The credit note number is a column of its own because an approved return with no
 * credit note is money the business has not got back yet, and that is the whole
 * reason anyone opens this list.
 */

const STATUSES = [
  { value: "DRAFT", label: "Draft" },
  { value: "PENDING_APPROVAL", label: "In approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
  { value: "DISPATCHED", label: "Sent back" },
  { value: "COMPLETED", label: "Completed" },
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
    {
      key: "vendor",
      header: "To vendor",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-ink">{r.vendor_name ?? "—"}</div>
          <div className="truncate font-mono text-[11px] text-muted">{r.grn_no ?? r.po_no ?? "—"}</div>
        </div>
      ),
    },
    { key: "warehouse", header: "From", hideOnNarrow: true, render: (r) => r.warehouse_name ?? "—" },
    {
      key: "qty",
      header: "Qty",
      className: "text-right",
      render: (r) => (
        <div>
          <div className="tabular text-sm text-ink">{fmtQty(r.total_qty)}</div>
          <div className="text-[11px] text-muted">{r.total_items} lines</div>
        </div>
      ),
    },
    {
      key: "value",
      header: "Value",
      className: "text-right",
      render: (r) => <span className="tabular text-sm text-ink">₹ {fmtMoneyShort(r.total_value)}</span>,
    },
    {
      key: "credit",
      header: "Credit note",
      render: (r) =>
        r.credit_note_no ? (
          <span className="font-mono text-xs text-ink">{r.credit_note_no}</span>
        ) : (
          <Chip size="sm" variant="flat" color={r.status === "COMPLETED" ? "warning" : "default"}>
            not received
          </Chip>
        ),
    },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
  ];

  return (
    <DocumentList<PurchaseReturn>
      title="Purchase returns"
      queryKey="wh-returns"
      fetch={listReturns}
      columns={columns}
      keyOf={(r) => r.id}
      searchIn={(r) => [r.return_no, r.grn_no, r.po_no, r.vendor_name, r.credit_note_no]}
      searchPlaceholder="Search return, GRN, vendor or credit note…"
      statuses={STATUSES}
      createTo="new"
      createLabel="New return"
      createPermission="grn.create"
      onRowClick={(r) => nav(String(r.id))}
      empty="No returns match these filters."
      onDelete={(r) => deletePurchaseReturn(r.id)}
      canDelete={(r) => r.status === "DRAFT"}
      deletePermission={DRAFT_DELETE_PERMISSION.return}
      deleteLabel="return"
      labelOf={(r) => r.return_no ?? `Return ${r.id}`}
      kpiCounts={[
        { label: "In approval", statuses: ["PENDING_APPROVAL"], tone: "text-warn" },
        { label: "Sent back", statuses: ["DISPATCHED"] },
      ]}
      kpis={(rows) => [
        {
          label: "Awaiting credit note",
          value: rows.filter((r) => !r.credit_note_no && r.status === "COMPLETED").length,
          tone: "text-bad",
        },
        { label: "Value", value: `₹ ${fmtMoneyShort(rows.reduce((s, r) => s + Number(r.total_value ?? 0), 0))}` },
      ]}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs font-semibold text-ink">{r.return_no}</span>
            <StatusPill status={r.status} />
          </div>
          <div className="truncate text-sm text-body">{r.vendor_name ?? "—"}</div>
          <div className="text-[11px] text-muted">
            {fmtQty(r.total_qty)} across {r.total_items} lines · {r.grn_no ?? "—"}
          </div>
        </div>
      )}
    />
  );
}
