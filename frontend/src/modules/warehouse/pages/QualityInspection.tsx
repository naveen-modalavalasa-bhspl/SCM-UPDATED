import { useNavigate } from "react-router-dom";
import { Chip } from "@heroui/react";
import { FileText } from "lucide-react";
import { StatusPill, type Column } from "@/shared/components";
import { DocumentList } from "../components/DocumentList";
import { listInspections, listOutboundInspections, deleteInspection, deleteOutboundInspection, DRAFT_DELETE_PERMISSION } from "../api";
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

/** `stockTransfer` splits Outward QC by who works it: `true` is the QC of stock
 *  transfers (Inventory > Stock Transfer), `false` everything else (the warehouse's
 *  own screen). `basePath` is where a row and New inspection open. */
export default function QualityInspection({
  type = "INCOMING",
  title = "Quality inspection",
  stockTransfer,
  basePath,
}: {
  type?: "INCOMING" | "OUTGOING";
  title?: string;
  stockTransfer?: boolean;
  basePath?: string;
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
          <div className="truncate font-mono text-xs text-ink">{r.grn_no ?? (r as any).issue_no ?? "—"}</div>
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
    {
      key: "actions",
      header: "",
      className: "w-12 text-right",
      render: (r) => (
        <div className="flex justify-end gap-1">
          <button
            type="button"
            aria-label={`Print ${r.inspection_no || "Draft"}`}
            title="Download PDF"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-neutral-100 hover:text-ink"
            onClick={(e) => {
              e.stopPropagation();
              window.open(`/warehouse/inspections/${r.id}/print?type=${type}`, "_blank");
            }}
          >
            <FileText className="h-4 w-4" />
          </button>
        </div>
      ),
    },
  ];

  return (
    <DocumentList<Inspection>
      title={title}
      queryKey={`wh-inspections-${type}-${stockTransfer ?? "all"}`}
      fetch={(p) => type === "OUTGOING"
        ? listOutboundInspections(
            stockTransfer === undefined ? p : { ...p, stock_transfer: stockTransfer } as any) as any
        : listInspections({ ...p, inspection_type: type })}
      extraParams={{ inspection_type: type }}
      columns={columns}
      keyOf={(r) => r.id}
      searchIn={(r) => [r.inspection_no, r.grn_no, (r as any).issue_no, r.vendor_name, r.inspector_name]}
      searchPlaceholder="Search inspection, GRN or vendor…"
      statuses={STATUSES}
      createTo={basePath ? `${basePath}/new` : "new"}
      createLabel="New inspection"
      createPermission="grn.qc"
      onRowClick={(r) => nav(basePath ? `${basePath}/${r.id}` : String(r.id))}
      empty="No inspections match these filters."
      onDelete={(r) => type === "OUTGOING" ? deleteOutboundInspection(r.id) : deleteInspection(r.id)}
      canDelete={(r) => r.status === "DRAFT"}
      deletePermission={type === "OUTGOING" ? DRAFT_DELETE_PERMISSION.outbound_inspection : DRAFT_DELETE_PERMISSION.inspection}
      deleteLabel="inspection"
      labelOf={(r) => r.inspection_no ?? `Inspection ${r.id}`}
      kpiCounts={[
        { label: "In progress", statuses: ["IN_PROGRESS"], tone: "warn" },
        { label: "Completed", statuses: ["COMPLETED"] },
      ]}
      kpis={(rows) => {
        const passed = rows.reduce((s, r) => s + r.passed_items, 0);
        const failed = rows.reduce((s, r) => s + r.failed_items, 0);
        return [
          { label: "Failed lines", value: failed, tone: "bad" },
          {
            ratio: true,
            // Over lines that have actually been judged, not over every line raised.
            // Against `total_items` an inspection with nothing failed and half its
            // lines still un-inspected read as a 50% pass rate, so the tile said
            // "82% pass" directly above "0 failed lines" and neither was wrong.
            label: "Pass rate",
            value: passed + failed ? `${percent(passed, passed + failed)}%` : "—",
          },
        ];
      }}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs font-semibold text-ink">{r.inspection_no}</span>
            <div className="flex items-center gap-2">
              <StatusPill status={r.status} />
              <button
                type="button"
                className="text-muted hover:text-ink p-1"
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(`/warehouse/inspections/${r.id}/print?type=${type}`, "_blank");
                }}
              >
                <FileText className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="truncate text-sm text-body">{r.grn_no ?? (r as any).issue_no ?? "—"} {r.vendor_name ? `· ${r.vendor_name}` : ""}</div>
          <div className="text-[11px] text-muted">
            {r.passed_items}/{r.total_items} passed
            {r.failed_items > 0 && <span className="font-semibold text-bad"> · {r.failed_items} failed</span>}
          </div>
        </div>
      )}
    />
  );
}
