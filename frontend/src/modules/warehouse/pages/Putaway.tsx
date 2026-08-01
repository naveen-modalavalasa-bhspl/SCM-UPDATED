import { useNavigate } from "react-router-dom";
import { Chip } from "@heroui/react";
import { StatusPill, type Column } from "@/shared/components";
import { DocumentList } from "../components/DocumentList";
import { listPutaways } from "../api";
import { fmtQty, humanise, normaliseStatus } from "../format";
import type { Putaway as PutawayTask } from "../types";

/**
 * The putaway queue — received stock that is on the floor but not yet in a bin.
 *
 * One row per received line (`whs_warehouse_items`), not per GRN: putting away is
 * done a pallet at a time, and a task that covers eight lines cannot be half done.
 *
 * The suggested bin is shown next to the actual one so the difference is visible at
 * a glance — a queue where everyone overrides the suggestion is telling you the
 * suggestion rule is wrong.
 */

const STATUSES = [
  { value: "pending", label: "Pending" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
  { value: "skipped", label: "Skipped" },
  { value: "cancelled", label: "Cancelled" },
];

export default function Putaway() {
  const nav = useNavigate();

  const columns: Column<PutawayTask>[] = [
    {
      key: "no",
      header: "Task",
      render: (r) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{r.putaway_no}</div>
          <div className="text-[11px] text-muted">{r.grn_no ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "item",
      header: "Item",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-ink">{r.item_code ?? "—"}</div>
          <div className="truncate text-xs text-muted">
            {r.item_name ?? "—"}
            {r.batch_no ? ` · ${r.batch_no}` : ""}
          </div>
        </div>
      ),
    },
    {
      key: "qty",
      header: "Qty",
      className: "text-right",
      render: (r) => (
        <span className="tabular text-sm text-ink">
          {fmtQty(r.qty)} {r.uom_code ?? ""}
        </span>
      ),
    },
    {
      key: "bin",
      header: "Bin",
      render: (r) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip size="sm" variant="flat" color={r.actual_bin_code ? "success" : "default"}>
            {r.actual_bin_code ?? r.suggested_bin_code ?? "unassigned"}
          </Chip>
          {r.actual_bin_code && r.suggested_bin_code && r.actual_bin_code !== r.suggested_bin_code && (
            <span className="text-[11px] text-warn">overridden</span>
          )}
        </div>
      ),
    },
    {
      key: "type",
      header: "Directed",
      hideOnNarrow: true,
      render: (r) => <span className="text-sm text-muted">{humanise(r.putaway_type)}</span>,
    },
    {
      key: "assignee",
      header: "Assigned",
      hideOnNarrow: true,
      render: (r) => r.assigned_to_name ?? "—",
    },
    { key: "status", header: "Status", render: (r) => <StatusPill status={normaliseStatus(r.status)} /> },
  ];

  return (
    <DocumentList<PutawayTask>
      title="Putaway"
      queryKey="wh-putaways"
      fetch={listPutaways}
      columns={columns}
      keyOf={(r) => r.id}
      searchIn={(r) => [r.putaway_no, r.grn_no, r.item_code, r.item_name, r.batch_no, r.suggested_bin_code]}
      searchPlaceholder="Search task, GRN, item or bin…"
      statuses={STATUSES}
      onRowClick={(r) => nav(String(r.id))}
      empty="Nothing waiting to be put away."
      kpis={(rows) => [
        { label: "Pending", value: rows.filter((r) => r.status === "pending").length, tone: "text-warn" },
        { label: "In progress", value: rows.filter((r) => r.status === "in_progress").length },
        {
          label: "Qty to place",
          value: fmtQty(
            rows.filter((r) => r.status !== "completed" && r.status !== "cancelled")
              .reduce((s, r) => s + Number(r.qty ?? 0), 0),
          ),
        },
        { label: "Skipped", value: rows.filter((r) => r.status === "skipped").length, tone: "text-bad" },
      ]}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs font-semibold text-ink">{r.putaway_no}</span>
            <StatusPill status={normaliseStatus(r.status)} />
          </div>
          <div className="truncate text-sm text-body">{r.item_name ?? r.item_code ?? "—"}</div>
          <div className="text-[11px] text-muted">
            {fmtQty(r.qty)} {r.uom_code ?? ""} → {r.actual_bin_code ?? r.suggested_bin_code ?? "unassigned"}
          </div>
        </div>
      )}
    />
  );
}
