import { useNavigate } from "react-router-dom";
import { Chip } from "@heroui/react";
import { StatusPill, type Column } from "@/shared/components";
import { DocumentList } from "../components/DocumentList";
import { listInspections } from "../api";
import { fmtDate, percent } from "../format";
import type { Inspection } from "../types";

/**
 * Quality inspections.
 *
 * `inspection_type` separates incoming QC (against a receipt) from outgoing QC
 * (before a dispatch leaves), so this one list serves both and the caller passes
 * which. The pass rate is shown per document because a 90%-pass inspection and a
 * 10%-pass inspection are entirely different conversations with the vendor.
 */

const STATUSES = [
  { value: "DRAFT", label: "Draft" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
];

export default function QualityInspection({
  type = "INCOMING",
  title = "Quality inspection",
}: {
  type?: "INCOMING" | "OUTGOING";
  title?: string;
}) {
  const nav = useNavigate();

  const columns: Column<Inspection>[] = [
    {
      key: "no",
      header: "Inspection",
      render: (r) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{r.inspection_no}</div>
          <div className="text-[11px] text-muted">{fmtDate(r.inspection_date)}</div>
        </div>
      ),
    },
    {
      key: "against",
      header: "Against",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-ink">{r.grn_no ?? "—"}</div>
          <div className="truncate text-[11px] text-muted">{r.vendor_name ?? "—"}</div>
        </div>
      ),
    },
    { key: "warehouse", header: "Warehouse", hideOnNarrow: true, render: (r) => r.warehouse_name ?? "—" },
    {
      key: "result",
      header: "Result",
      render: (r) => {
        const rate = percent(r.passed_items, r.total_items);
        return (
          <div className="flex items-center gap-2">
            <Chip size="sm" variant="flat" color={r.failed_items > 0 ? "danger" : "success"}>
              {r.passed_items}/{r.total_items} passed
            </Chip>
            <span className={`text-xs tabular ${rate < 100 ? "text-bad" : "text-ok"}`}>{rate}%</span>
          </div>
        );
      },
    },
    { key: "inspector", header: "Inspector", hideOnNarrow: true, render: (r) => r.inspector_name ?? "—" },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
  ];

  return (
    <DocumentList<Inspection>
      title={title}
      queryKey={`wh-inspections-${type}`}
      fetch={(p) => listInspections({ ...p, ...({ inspection_type: type } as object) })}
      extraParams={{ inspection_type: type }}
      columns={columns}
      keyOf={(r) => r.id}
      searchIn={(r) => [r.inspection_no, r.grn_no, r.vendor_name, r.inspector_name]}
      searchPlaceholder="Search inspection, GRN or vendor…"
      statuses={STATUSES}
      createTo="new"
      createLabel="New inspection"
      createPermission="grn.qc"
      onRowClick={(r) => nav(String(r.id))}
      empty="No inspections match these filters."
      kpis={(rows) => [
        { label: "In progress", value: rows.filter((r) => r.status === "IN_PROGRESS").length, tone: "text-warn" },
        { label: "Completed", value: rows.filter((r) => r.status === "COMPLETED").length },
        { label: "Failed lines", value: rows.reduce((s, r) => s + r.failed_items, 0), tone: "text-bad" },
        {
          label: "Pass rate",
          value: `${percent(
            rows.reduce((s, r) => s + r.passed_items, 0),
            rows.reduce((s, r) => s + r.total_items, 0),
          )}%`,
        },
      ]}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs font-semibold text-ink">{r.inspection_no}</span>
            <StatusPill status={r.status} />
          </div>
          <div className="truncate text-sm text-body">{r.grn_no ?? "—"} · {r.vendor_name ?? "—"}</div>
          <div className="text-[11px] text-muted">
            {r.passed_items}/{r.total_items} passed
            {r.failed_items > 0 && <span className="font-semibold text-bad"> · {r.failed_items} failed</span>}
          </div>
        </div>
      )}
    />
  );
}
