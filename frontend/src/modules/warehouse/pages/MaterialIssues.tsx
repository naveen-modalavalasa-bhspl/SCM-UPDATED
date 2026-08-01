import { useNavigate } from "react-router-dom";
import { Chip } from "@heroui/react";
import { StatusPill, type Column } from "@/shared/components";
import { DocumentList } from "../components/DocumentList";
import { listIssues } from "../api";
import { fmtDate, fmtMoneyShort, fmtQty } from "../format";
import type { Issue } from "../types";

/**
 * Material issues — stock leaving the store for a department, project or vehicle.
 *
 * `direction` distinguishes an issue from a return of one: both are `out_issues`
 * rows, and pairing them in one table is what lets a return point at the issue it
 * reverses (`original_issue_id`) instead of floating free.
 *
 * The approver column is filled from `current_approver_name` on the row — a snapshot
 * written when the workflow moved, so the list does not have to ask the workflow
 * engine who is holding each of two hundred documents.
 */

const STATUSES = [
  { value: "DRAFT", label: "Draft" },
  { value: "PENDING_APPROVAL", label: "In approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
  { value: "ISSUED", label: "Issued" },
  { value: "ACKNOWLEDGED", label: "Acknowledged" },
  { value: "CANCELLED", label: "Cancelled" },
];

export default function MaterialIssues({
  direction = "OUT",
  title = "Material issues",
}: {
  direction?: "OUT" | "IN";
  title?: string;
}) {
  const nav = useNavigate();

  const columns: Column<Issue>[] = [
    {
      key: "no",
      header: "Issue",
      render: (r) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{r.issue_no}</div>
          <div className="text-[11px] text-muted">{fmtDate(r.issue_date)}</div>
        </div>
      ),
    },
    {
      key: "to",
      header: "Issued to",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-ink">{r.issued_to_name ?? r.department_name ?? "—"}</div>
          <div className="truncate text-[11px] text-muted">
            {[r.project_name, r.vehicle_number].filter(Boolean).join(" · ") || r.indent_no || "—"}
          </div>
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
    {
      key: "approver",
      header: "With",
      hideOnNarrow: true,
      render: (r) => (
        <span className="text-sm text-muted">
          {r.status === "PENDING_APPROVAL" ? r.current_approver_name ?? "unassigned" : r.approved_by_name ?? "—"}
        </span>
      ),
    },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
  ];

  return (
    <DocumentList<Issue>
      title={title}
      queryKey={`wh-issues-${direction}`}
      fetch={(p) => listIssues({ ...p, direction })}
      extraParams={{ direction }}
      columns={columns}
      keyOf={(r) => r.id}
      searchIn={(r) => [r.issue_no, r.indent_no, r.issued_to_name, r.department_name, r.project_name, r.vehicle_number]}
      searchPlaceholder="Search issue, indent, person or project…"
      statuses={STATUSES}
      createTo="new"
      createLabel={direction === "OUT" ? "New issue" : "New return"}
      createPermission="issue.create"
      onRowClick={(r) => nav(String(r.id))}
      empty="No issues match these filters."
      kpis={(rows) => [
        { label: "In approval", value: rows.filter((r) => r.status === "PENDING_APPROVAL").length, tone: "text-warn" },
        { label: "Approved, not issued", value: rows.filter((r) => r.status === "APPROVED").length },
        { label: "Qty issued", value: fmtQty(rows.filter((r) => r.is_stock_posted).reduce((s, r) => s + Number(r.total_qty ?? 0), 0)) },
        {
          label: "Awaiting acknowledgement",
          value: rows.filter((r) => r.status === "ISSUED").length,
        },
      ]}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs font-semibold text-ink">{r.issue_no}</span>
            <StatusPill status={r.status} />
          </div>
          <div className="truncate text-sm text-body">{r.issued_to_name ?? r.department_name ?? "—"}</div>
          <div className="text-[11px] text-muted">
            {fmtQty(r.total_qty)} across {r.total_items} lines · {fmtDate(r.issue_date)}
          </div>
        </div>
      )}
    />
  );
}
