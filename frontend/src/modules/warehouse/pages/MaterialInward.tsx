import { useNavigate } from "react-router-dom";
import { StatusPill, type Column } from "@/shared/components";
import { DocumentList } from "../components/DocumentList";
import { listReceipts, deleteReceipt, DRAFT_DELETE_PERMISSION } from "../api";
import { fmtDate, fmtQty } from "../format";
import type { Receipt } from "../types";

/**
 * Gate entry — the vehicle is at the gate and the goods are not yours yet.
 *
 * Same table as the GRN (`inb_receipts`), separated by `receipt_type`. A gate entry
 * records who arrived with what paperwork; the GRN records what was actually counted
 * off the vehicle. Keeping them one row means the GRN already knows the vehicle, the
 * LR and the invoice without anyone retyping them.
 *
 * This is a register, not a queue: it lists every entry ever made at the gate, so the
 * list asks for `gate_register` rather than `receipt_type=GATE_ENTRY`. Converting an
 * entry rewrites that type to PURCHASE on the same row, which used to make the entry
 * vanish from here the moment somebody worked on it. Only two states are worth showing
 * — still at the gate (draft), or turned into a GRN (done).
 */

/** `inb_receipts.status` — the same column and the same values the GRN screen filters
 *  on, because it is the same table. NOT the DRAFT/DONE the rows display: that is
 *  derived from `receipt_type` (has this entry become a GRN yet) and filtering on it
 *  would need a parameter the list endpoint does not take. Live gate-register rows
 *  carry SUBMITTED and COMPLETED, so a GATE_ENTRY/DRAFT dropdown would have narrowed
 *  every search to nothing. */
const STATUSES = [
  { value: "DRAFT", label: "Draft" },
  { value: "GATE_ENTRY", label: "At the gate" },
  { value: "SUBMITTED", label: "Submitted" },
  { value: "PENDING_QC", label: "Awaiting QC" },
  { value: "QC_PASSED", label: "QC passed" },
  { value: "QC_FAILED", label: "QC failed" },
  { value: "PARTIALLY_RECEIVED", label: "Partially received" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
];

/** Draft while the row is still typed as a gate entry; done once it became a GRN. */
const isDraft = (r: Receipt) => r.receipt_type === "GATE_ENTRY";

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
    {
      key: "status",
      header: "Status",
      render: (r) => <StatusPill status={isDraft(r) ? "DRAFT" : "DONE"} />,
    },
  ];

  return (
    <DocumentList<Receipt>
      title="Gate entry"
      queryKey="wh-gate-entries"
      fetch={(p) => listReceipts({ ...p, gate_register: true })}
      extraParams={{ gate_register: true }}
      columns={columns}
      keyOf={(r) => r.id}
      searchIn={(r) => [r.gate_entry_no, r.grn_no, r.vendor_name, r.vehicle_no, r.invoice_no, r.lr_no, r.po_no]}
      searchPlaceholder="Search gate entry, vehicle, invoice or LR…"
      // The gate register had a search box and nothing else, so narrowing it to
      // "what is still open" or "what came into this point" meant reading the whole
      // list. Both filters are served by `listReceipts` already — the list was simply
      // not asking for them.
      statuses={STATUSES}
      createTo="new"
      createLabel="New gate entry"
      createPermission="grn.create"
      // A converted entry is a GRN now; opening it in the gate form would offer to edit
      // it as something it no longer is.
      onRowClick={(r) => nav(isDraft(r) ? String(r.id) : `../grn/${r.id}`)}
      empty="No gate entries yet."
      // A gate entry that was never worked on. Once it becomes a GRN its status
      // moves on and the button disappears with it.
      onDelete={(r) => deleteReceipt(r.id)}
      canDelete={(r) => r.status === "DRAFT" || r.status === "GATE_ENTRY"}
      deletePermission={DRAFT_DELETE_PERMISSION.receipt}
      deleteLabel="gate entry"
      labelOf={(r) => r.gate_entry_no ?? r.grn_no ?? `Entry ${r.id}`}
      // "Entries" was Draft + Done restated, so it told nobody anything they could
      // not already add up. "Arrived today" is the number a gate actually works to.
      kpis={(rows) => {
        const today = new Date().toDateString();
        const arrivedToday = rows.filter((r) => {
          const when = r.gate_entry_at ?? r.created_at;
          return when ? new Date(when).toDateString() === today : false;
        }).length;
        return [
          { label: "Draft", value: rows.filter(isDraft).length, tone: "text-warn" },
          { label: "Done", value: rows.filter((r) => !isDraft(r)).length },
          { label: "Arrived today", value: arrivedToday },
        ];
      }}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs font-semibold text-ink">{r.gate_entry_no ?? r.grn_no}</span>
            <StatusPill status={isDraft(r) ? "DRAFT" : "DONE"} />
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
