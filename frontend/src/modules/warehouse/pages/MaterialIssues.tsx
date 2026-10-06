import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import { Forward, FileText, CheckCircle } from "lucide-react";
import {
  Button, Can, ConfirmModal, SourceRef, SourceRefLine, StatusPill,
  type Column, type SourceRefCandidate,
} from "@/shared/components";
import { alerts } from "@/modules/alerts";
import { DocumentList } from "../components/DocumentList";
import {
  DRAFT_DELETE_PERMISSION, deleteIssue, forwardArrival, listIssues, listReceipts,
} from "../api";
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
  { value: "SPLIT", label: "Split across floors" },
  { value: "CLOSED", label: "Split, all posted" },
  { value: "REJECTED", label: "Rejected" },
  { value: "ISSUED", label: "Issued" },
  { value: "DISPATCHED", label: "Dispatched" },
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

  /* What this issue was raised AGAINST. An outward issue serves an indent (or, where
     one was cut, a picklist); a return reverses the issue it came back from. The link
     was always on the row — `indent_id` is the whole reason `out_issues` exists — but
     the list only ever leaked it into the "Issued to" subline, and only when there was
     no project or vehicle to crowd it out. So an issue against IND0011 showed
     "AP39TL9499" and the indent number appeared nowhere on the screen. */
  const sourceOf = (r: Issue): SourceRefCandidate[] => [
    { label: "Indent", no: r.indent_no, to: r.indent_id ? `/indents/${r.indent_id}` : null },
    // No detail screen for a picklist yet, so this one reads as text.
    { label: "Picklist", no: r.pick_no },
    {
      label: "Return of",
      no: r.original_issue_no,
      to: r.original_issue_id
        ? `/warehouse/transactions/material-issues/${r.original_issue_id}`
        : null,
    },
  ];

  const columns: Column<Issue>[] = [
    {
      key: "no",
      header: "Issue",
      render: (r) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{r.issue_no}</div>
          <div className="text-[11px] text-muted">{fmtDate(r.issue_date)}</div>
          {r.parent_issue_no && (
            <div className="text-[11px] text-muted">
              Split of <span className="font-mono">{r.parent_issue_no}</span>
              {r.floor_location_name ? ` · ${r.floor_location_name}` : ""}
            </div>
          )}
        </div>
      ),
    },
    {
      key: "against",
      header: "Against",
      render: (r) => <SourceRef refs={sourceOf(r)} />,
    },
    {
      key: "to",
      header: "Issued to",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-ink">{r.issued_to_name ?? r.department_name ?? "—"}</div>
          <div className="truncate text-[11px] text-muted">
            {[r.project_name, r.vehicle_number].filter(Boolean).join(" · ") || "—"}
          </div>
        </div>
      ),
    },
    { key: "warehouse", header: "From", hideOnNarrow: true, render: (r) => r.warehouse_id ? `WH-${r.warehouse_id}` : "—" },
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
    {
      key: "qc_status",
      header: "QC Status",
      hideOnNarrow: true,
      render: (r) => r.qc_status && r.qc_status !== "NOT_REQUIRED" ? (
        <span className={`text-[11px] font-semibold uppercase tracking-wider ${
          r.qc_status === "PASSED" ? "text-success" : 
          r.qc_status === "FAILED" ? "text-danger" : 
          r.qc_status === "PARTIAL" ? "text-warning" : "text-neutral-500"
        }`}>
          {r.qc_status}
        </span>
      ) : <span className="text-muted text-[11px] uppercase tracking-wider">N/A</span>,
    },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    {
      key: "actions",
      header: "",
      className: "w-24 text-right",
      render: (r) => (
        <div className="flex justify-end gap-1">
          {r.qc_status && (["PENDING", "PARTIAL", "FAILED"].includes(r.qc_status) || (r.qc_status === "NOT_REQUIRED" && r.direction === "OUT" && r.is_stock_posted)) && (
            <button
              type="button"
              aria-label={`QC ${r.issue_no}`}
              title="Perform QC"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-primary transition-colors hover:bg-primary-50"
              onClick={(e) => {
                e.stopPropagation();
                nav(`/warehouse/qc-outward/new?issue_id=${r.id}`);
              }}
            >
              <CheckCircle className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            aria-label={`Print ${r.issue_no || "Draft"}`}
            title="Download PDF"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-neutral-100 hover:text-ink"
            onClick={(e) => {
              e.stopPropagation();
              window.open(`/warehouse/material-issues/${r.id}/print`, "_blank");
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
    {/* Forwarding is reachable from here too, not only from the GRN screen. A
        storekeeper working out of Material Issues thinks "pass this consignment on",
        not "go back and reopen the receipt it arrived on". Same endpoint, same
        permission — the service still refuses anything not arrived and stock-posted,
        and skips indents that already have an issue at this point. */}
    {direction === "OUT" && <ForwardFromGrn />}
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
      onDelete={(r) => deleteIssue(r.id)}
      canDelete={(r) => r.status === "DRAFT"}
      deletePermission={DRAFT_DELETE_PERMISSION.issue}
      deleteLabel="issue"
      labelOf={(r) => r.issue_no ?? `Issue ${r.id}`}
      kpiCounts={[
        { label: "In approval", statuses: ["PENDING_APPROVAL"], tone: "warn" },
        { label: "Approved, not issued", statuses: ["APPROVED"] },
        { label: "Awaiting acknowledgement", statuses: ["ISSUED", "DISPATCHED"] },
      ]}
      kpis={(rows) => [
        { label: "Qty issued", value: fmtQty(rows.filter((r) => r.is_stock_posted).reduce((s, r) => s + Number(r.total_qty ?? 0), 0)) },
      ]}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs font-semibold text-ink">{r.issue_no}</span>
            <StatusPill status={r.status} />
          </div>
          {r.parent_issue_no && (
            <div className="text-[11px] text-muted">
              Split of <span className="font-mono">{r.parent_issue_no}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-sm text-body">{r.issued_to_name ?? r.department_name ?? "—"}</div>
            <div className="flex items-center gap-1">
              {r.qc_status && (["PENDING", "PARTIAL", "FAILED"].includes(r.qc_status) || (r.qc_status === "NOT_REQUIRED" && r.direction === "OUT" && r.is_stock_posted)) && (
                <button
                  type="button"
                  className="text-primary hover:bg-primary-50 p-1 rounded"
                  onClick={(e) => {
                    e.stopPropagation();
                    nav(`/warehouse/qc-outward/new?issue_id=${r.id}`);
                  }}
                >
                  <CheckCircle className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                className="text-muted hover:text-ink p-1"
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(`/warehouse/material-issues/${r.id}/print`, "_blank");
                }}
              >
                <FileText className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="text-[11px] text-muted">
            {fmtQty(r.total_qty)} across {r.total_items} lines · {fmtDate(r.issue_date)}
          </div>
          <SourceRefLine refs={sourceOf(r)} />
        </div>
      )}
    />
    </>
  );
}

/**
 * "Forward an arrived consignment" — the Material Issues doorway to the same action
 * the GRN screen offers.
 *
 * Lists consignment receipts that have landed at this point and been posted to stock,
 * and have not been forwarded yet. Picking one builds the onward issue drafts, one per
 * indent, exactly as the button on the GRN does: same endpoint, same `issue.forward`
 * permission, and the same scope — `listReceipts` only ever returns receipts at
 * warehouses this login can see.
 */
function ForwardFromGrn() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const arrived = useQuery({
    queryKey: ["wh-receipts", "arrived-consignments"],
    queryFn: () => listReceipts({ receipt_type: "DISPATCH", page: 1, size: 50 }),
    enabled: open,
  });

  const forward = useMutation({
    mutationFn: (receiptId: number) => forwardArrival(receiptId),
    onSuccess: (drafts) => {
      const made = (drafts ?? []) as Array<{ issue_no?: string }>;
      if (made.length === 0) {
        void alerts.info("issue.forwarded_none");
        return;
      }
      void alerts.success("issue.forwarded", {
        number: made.map((d) => d.issue_no).filter(Boolean).join(", "),
      });
      qc.invalidateQueries({ queryKey: ["wh-issues-OUT"] });
      setOpen(false);
      nav("/warehouse/transactions/material-issues");
    },
  });

  const rows = (arrived.data?.items ?? []).filter((r) => r.is_stock_posted);

  return (
    <Can do="issue.forward">
      <div className="mb-3 flex justify-end">
        <Button variant="soft" onClick={() => setOpen(true)}>
          <Forward className="h-4 w-4" /> Forward an arrived consignment
        </Button>
      </div>
      <ConfirmModal
        isOpen={open}
        title="Forward to the points below"
        message="Pick the consignment that arrived here. One issue draft is built per
                 indent on it — you still review and submit each one."
        confirmLabel="Close"
        busy={forward.isPending}
        error={forward.error ?? arrived.error}
        onConfirm={() => setOpen(false)}
        onClose={() => setOpen(false)}
      >
        <div className="mt-2 divide-y divide-line rounded-xl border border-line">
          {arrived.isLoading && <p className="p-3 text-sm text-muted">Loading…</p>}
          {!arrived.isLoading && rows.length === 0 && (
            <p className="p-3 text-sm text-muted">
              Nothing has arrived here and been posted to stock yet.
            </p>
          )}
          {rows.map((r) => (
            <button
              key={r.id}
              type="button"
              disabled={forward.isPending}
              onClick={() => forward.mutate(r.id)}
              className="flex w-full items-center justify-between gap-2 p-3 text-left
                         hover:bg-content2 disabled:opacity-60"
            >
              <div>
                <span className="mono text-sm font-semibold text-ink">{r.grn_no}</span>
                <p className="text-xs text-muted">
                  {r.warehouse_name} · {fmtDate(r.grn_date)}
                </p>
              </div>
              <StatusPill status={r.status} />
            </button>
          ))}
        </div>
      </ConfirmModal>
    </Can>
  );
}
