import { useNavigate } from "react-router-dom";
import { Progress } from "@heroui/react";
import { StatusPill, type Column } from "@/shared/components";
import { DocumentList } from "../components/DocumentList";
import { listPickings, deletePicking, DRAFT_DELETE_PERMISSION } from "../api";
import { fmtDate, humanise, percent } from "../format";
import type { Picking } from "../types";

/**
 * Picklists — what has to come off the shelves, and how far through it is.
 *
 * Progress is `picked_lines / total_lines` straight off the row, not counted from
 * the lines: the rollup is maintained when a line is picked, so the list reads one
 * table and a hundred open picklists stay one query.
 */

const STATUSES = [
  { value: "DRAFT", label: "Draft" },
  { value: "RELEASED", label: "Released" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "PICKED", label: "Picked" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
];

export default function Picklist() {
  const nav = useNavigate();

  const columns: Column<Picking>[] = [
    {
      key: "no",
      header: "Fulfilment",
      render: (r) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{r.pick_no}</div>
          <div className="text-[11px] text-muted">{fmtDate(r.pick_date)}</div>
        </div>
      ),
    },
    {
      key: "ref",
      header: "For",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-ink">{r.ref_no ?? "—"}</div>
          <div className="truncate text-[11px] text-muted">{humanise(r.ref_type)}</div>
        </div>
      ),
    },
    { key: "warehouse", header: "Warehouse", hideOnNarrow: true, render: (r) => r.warehouse_name ?? "—" },
    {
      key: "progress",
      header: "Progress",
      render: (r) => {
        const done = percent(r.picked_lines, r.total_lines);
        return (
          <div className="min-w-[120px]">
            <Progress
              size="sm"
              value={done}
              aria-label={`${done}% picked`}
              color={done === 100 ? "success" : "primary"}
              className="mb-1"
            />
            <span className="text-[11px] text-muted tabular">
              {r.picked_lines}/{r.total_lines} lines
            </span>
          </div>
        );
      },
    },
    {
      key: "strategy",
      header: "Strategy",
      hideOnNarrow: true,
      render: (r) => <span className="text-sm text-muted">{humanise(r.strategy) || "—"}</span>,
    },
    { key: "assignee", header: "Picker", hideOnNarrow: true, render: (r) => r.assigned_to_name ?? "—" },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
  ];

  return (
    <DocumentList<Picking>
      title="Material fulfilment"
      queryKey="wh-pickings"
      fetch={listPickings}
      columns={columns}
      keyOf={(r) => r.id}
      searchIn={(r) => [r.pick_no, r.ref_no, r.warehouse_name, r.assigned_to_name]}
      searchPlaceholder="Search fulfilment, reference or picker…"
      statuses={STATUSES}
      createTo="new"
      createLabel="New fulfilment"
      createPermission="issue.create"
      onRowClick={(r) => nav(String(r.id))}
      empty="No material fulfilments match these filters."
      onDelete={(r) => deletePicking(r.id)}
      canDelete={(r) => r.status === "DRAFT"}
      deletePermission={DRAFT_DELETE_PERMISSION.picking}
      deleteLabel="picklist"
      labelOf={(r) => r.pick_no ?? `Picklist ${r.id}`}
      kpiCounts={[
        { label: "Released", statuses: ["RELEASED"], tone: "text-warn" },
        { label: "In progress", statuses: ["IN_PROGRESS"] },
        { label: "Completed", statuses: ["COMPLETED"] },
      ]}
      kpis={(rows) => [
        {
          label: "Lines to pick",
          value: rows
            .filter((r) => !["COMPLETED", "CANCELLED"].includes(r.status))
            .reduce((s, r) => s + (r.total_lines - r.picked_lines), 0),
        },
      ]}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs font-semibold text-ink">{r.pick_no}</span>
            <StatusPill status={r.status} />
          </div>
          <div className="truncate text-sm text-body">{r.ref_no ?? "—"}</div>
          <div className="text-[11px] text-muted tabular">
            {r.picked_lines}/{r.total_lines} lines · {r.assigned_to_name ?? "unassigned"}
          </div>
        </div>
      )}
    />
  );
}
