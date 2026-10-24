import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileText } from "lucide-react";
import { Chip } from "@heroui/react";
import { StatusPill, type Column } from "@/shared/components";
import { DocumentList } from "../components/DocumentList";
import { NewPutawayModal } from "../components/NewPutawayModal";
import { listPutaways, deletePutaway, DRAFT_DELETE_PERMISSION } from "../api";
import { fmtQty, humanise, normaliseStatus } from "../format";
import { fmtCount, volume, weight } from "../components/CapacityMeter";
import type { Putaway as PutawayTask } from "../types";
import { CombinationTag } from "@/shared/combination";

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
  const [raising, setRaising] = useState(false);

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
          <CombinationTag value={r} className="mt-1" />
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
      // The queue is worked a pallet at a time, and the quantity beside it does not say
      // how many of those there are. `1500 EA` is thirty cartons or three pallets
      // depending only on the rung it arrived in, and which one it is decides whether
      // the suggested bay can take it — so the pack is on the row, not one click in.
      key: "load",
      header: "Load",
      hideOnNarrow: true,
      render: (r) => (
        r.package_name ? (
          <div className="min-w-0">
            <div className="tabular truncate text-xs font-semibold text-ink">
              {fmtCount(r.handling_units)} × {r.package_name}
            </div>
            <div className="tabular truncate text-[11px] text-muted">
              {r.line_volume_cbm == null ? "not measured" : volume(r.line_volume_cbm)}
              {r.line_weight_kg == null ? "" : ` · ${weight(r.line_weight_kg)}`}
            </div>
          </div>
        ) : (
          <span className="text-[11px] text-warn">No pack configured</span>
        )
      ),
    },
    {
      key: "bin",
      header: "Placed at",
      // Where the goods actually went, or nothing. Nothing suggests a location any
      // more, so a task waiting to be done has no bin on it — and printing a
      // suggestion here would have read as a placement that had already happened.
      render: (r) => (
        <Chip size="sm" variant="flat" color={r.actual_bin_code ? "success" : "default"}>
          {r.actual_bin_code ?? "not placed yet"}
        </Chip>
      ),
    },
    {
      key: "type",
      header: "Directed",
      hideOnNarrow: true,
      render: (r) => <span className="text-sm text-muted">{humanise(r.putaway_type)}</span>,
    },
    { key: "assignee", header: "Assigned", hideOnNarrow: true, render: (r) => r.assigned_to_name ?? "—" },
    { key: "status", header: "Status", render: (r) => <StatusPill status={normaliseStatus(r.status)} /> },
    {
      key: "actions",
      header: "",
      className: "w-12 text-right",
      render: (r) => (
        <div className="flex justify-end gap-1">
          <button
            type="button"
            aria-label={`Print ${r.putaway_no || "Draft"}`}
            title="Download PDF"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-neutral-100 hover:text-ink"
            onClick={(e) => {
              e.stopPropagation();
              window.open(`/warehouse/putaway/${r.id}/print`, "_blank");
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
    <DocumentList<PutawayTask>
      title="Putaway"
      queryKey="wh-putaways"
      fetch={listPutaways}
      columns={columns}
      keyOf={(r) => r.id}
      onCreate={() => setRaising(true)}
      createLabel="New putaway"
      createPermission="putaway.execute"
      searchIn={(r) => [r.putaway_no, r.grn_no, r.item_code, r.item_name, r.batch_no, r.actual_bin_code]}
      searchPlaceholder="Search task, GRN, item or location…"
      statuses={STATUSES}
      onRowClick={(r) => nav(String(r.id))}
      empty="Nothing waiting to be put away."
      // `whs_warehouse_items.status` is a lower-case MySQL ENUM. Only a draft goes:
      // a PENDING task is real work a GRN created and deleting it would lose the
      // obligation to put those goods away.
      onDelete={(r) => deletePutaway(r.id)}
      canDelete={(r) => r.status === "draft"}
      deletePermission={DRAFT_DELETE_PERMISSION.putaway}
      deleteLabel="put-away task"
      labelOf={(r) => r.putaway_no ?? `Task ${r.id}`}
      kpiCounts={[
        { label: "Pending", statuses: ["pending"], tone: "warn" },
        { label: "In progress", statuses: ["in_progress"] },
        { label: "Skipped", statuses: ["skipped"], tone: "bad" },
      ]}
      kpis={(rows) => [
        {
          label: "Qty to place",
          value: fmtQty(
            rows.filter((r) => r.status !== "completed" && r.status !== "cancelled")
              .reduce((s, r) => s + Number(r.qty ?? 0), 0),
          ),
        },
      ]}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs font-semibold text-ink">{r.putaway_no}</span>
            <div className="flex items-center gap-2">
              <StatusPill status={normaliseStatus(r.status)} />
              <button
                type="button"
                className="text-muted hover:text-ink p-1"
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(`/warehouse/putaway/${r.id}/print`, "_blank");
                }}
              >
                <FileText className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="truncate text-sm text-body">{r.item_name ?? r.item_code ?? "—"}</div>
          <CombinationTag value={r} />
          <div className="text-[11px] text-muted">
            {fmtQty(r.qty)} {r.uom_code ?? ""} → {r.actual_bin_code ?? "not placed yet"}
          </div>
        </div>
      )}
    />

    <NewPutawayModal
      isOpen={raising}
      onClose={() => setRaising(false)}
      // One task raised is one task to go and do; several is a queue to work through.
      onCreated={(ids) => ids.length === 1 && nav(String(ids[0]))}
    />
    </>
  );
}
