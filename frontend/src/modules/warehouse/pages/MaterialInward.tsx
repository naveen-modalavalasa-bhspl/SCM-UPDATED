import { useNavigate } from "react-router-dom";
import { StatusPill, type Column } from "@/shared/components";
import { DocumentList } from "../components/DocumentList";
import { listReceipts } from "../api";
import { fmtDate, fmtQty } from "../format";
import type { Receipt } from "../types";

/**
 * Gate entry — the vehicle is at the gate and the goods are not yours yet.
 *
 * Same table as the GRN (`inb_receipts`), separated by `receipt_type`. A gate entry
 * records who arrived with what paperwork; the GRN records what was actually counted
 * off the vehicle. Keeping them one row means the GRN already knows the vehicle, the
 * LR and the invoice without anyone retyping them.
 */

const STATUSES = [
  { value: "DRAFT", label: "Draft" },
  { value: "GATE_ENTRY", label: "At the gate" },
  { value: "RECEIVED", label: "Received" },
  { value: "CANCELLED", label: "Cancelled" },
];

export default function MaterialInward() {
  const nav = useNavigate();

  const columns: Column<Receipt>[] = [
    {
      key: "no",
      header: "Gate entry",
      render: (r) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{r.gate_entry_no ?? r.grn_no}</div>
          <div className="text-[11px] text-muted">{fmtDate(r.grn_date)}</div>
        </div>
      ),
    },
    {
      key: "vendor",
      header: "From",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-ink">{r.vendor_name ?? r.transfer_no ?? "—"}</div>
          <div className="truncate text-[11px] text-muted">{r.po_no ?? "No PO"}</div>
        </div>
      ),
    },
    {
      key: "vehicle",
      header: "Vehicle",
      hideOnNarrow: true,
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-ink">{r.vehicle_no ?? "—"}</div>
          <div className="truncate text-[11px] text-muted">{r.transporter_name ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "docs",
      header: "Invoice / LR",
      hideOnNarrow: true,
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-ink">{r.invoice_no ?? "—"}</div>
          <div className="truncate text-[11px] text-muted">{r.lr_no ?? "—"}</div>
        </div>
      ),
    },
    { key: "warehouse", header: "Warehouse", hideOnNarrow: true, render: (r) => r.warehouse_name ?? "—" },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
  ];

  return (
    <DocumentList<Receipt>
      title="Gate entry"
      queryKey="wh-gate-entries"
      fetch={(p) => listReceipts({ ...p, receipt_type: "GATE_ENTRY" })}
      extraParams={{ receipt_type: "GATE_ENTRY" }}
      columns={columns}
      keyOf={(r) => r.id}
      searchIn={(r) => [r.gate_entry_no, r.grn_no, r.vendor_name, r.vehicle_no, r.invoice_no, r.lr_no, r.po_no]}
      searchPlaceholder="Search gate entry, vehicle, invoice or LR…"
      statuses={STATUSES}
      createTo="new"
      createLabel="New gate entry"
      createPermission="grn.create"
      onRowClick={(r) => nav(String(r.id))}
      empty="Nothing at the gate."
      kpis={(rows) => [
        { label: "At the gate", value: rows.filter((r) => r.status === "GATE_ENTRY").length, tone: "text-warn" },
        { label: "Drafts", value: rows.filter((r) => r.status === "DRAFT").length },
        { label: "Received today", value: rows.filter((r) => r.grn_date === new Date().toISOString().slice(0, 10)).length },
        { label: "Total lines", value: rows.reduce((s, r) => s + (r.total_items ?? 0), 0) },
      ]}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs font-semibold text-ink">{r.gate_entry_no ?? r.grn_no}</span>
            <StatusPill status={r.status} />
          </div>
          <div className="truncate text-sm text-body">{r.vendor_name ?? "—"}</div>
          <div className="truncate text-[11px] text-muted">
            {r.vehicle_no ?? "no vehicle"} · {fmtDate(r.grn_date)} · {fmtQty(r.total_received_qty)} qty
          </div>
        </div>
      )}
    />
  );
}
