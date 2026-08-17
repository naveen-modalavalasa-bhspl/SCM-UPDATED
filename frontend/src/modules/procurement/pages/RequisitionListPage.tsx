import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Button, Can, Card, ErrorBanner, PageHeader, ResponsiveList, Select, StatusPill,
  type Column,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { requisitionApi } from "../api";
import type { ReqListRow } from "../types";

/** RequisitionStatus, as the backend enum spells it. */
const STATUSES = [
  { value: "", label: "All statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "PENDING_APPROVAL", label: "Pending approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "RFQ_RAISED", label: "RFQ raised" },
  { value: "ORDERED", label: "Ordered" },
  { value: "REJECTED", label: "Rejected" },
  { value: "CANCELLED", label: "Cancelled" },
];

export const money = (n?: number | null) =>
  `₹${Number(n ?? 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

const SIZE = 20;

/**
 * The requisition register — what procurement wants to buy.
 *
 * Unlike a PO this one DOES have a New button: a requisition is where the buying
 * chain starts, and it can be raised cold rather than off an indent.
 */
export function RequisitionListPage() {
  const nav = useNavigate();
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);

  const { data, isLoading, error } = useQuery({
    queryKey: ["requisitions", status, page],
    queryFn: () => requisitionApi.list({ status: status || undefined, page, size: SIZE }),
  });

  const rows = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / SIZE));

  const columns: Column<ReqListRow>[] = [
    {
      key: "req",
      header: "Requisition",
      render: (r) => (
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-ink">{r.req_no}</div>
          <div className="text-[11px] text-muted">
            {r.warehouse_name ?? "No warehouse"}
          </div>
        </div>
      ),
    },
    { key: "project", header: "Project", hideOnNarrow: true, render: (r) => r.project_name ?? "—" },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    { key: "lines", header: "Lines", className: "text-right", render: (r) => r.total_items },
    {
      key: "value",
      header: "Estimated",
      className: "text-right",
      render: (r) => <span className="font-semibold text-ink">{money(r.estimated_value)}</span>,
    },
    {
      key: "raised",
      header: "Raised",
      hideOnNarrow: true,
      render: (r) => <span className="text-sm text-muted">{fmtDate(r.created_at)}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Procurement"
        title="Requisitions"
        actions={
          <Can do="requisition.create">
            {/* The usual way in: the demand already exists as approved material
              * requests, and this gathers them into one document to tender. */}
            <Button
              variant="subtle"
              onClick={() => nav("/procurement/requisitions/from-mrs")}
            >
              Consolidate material requests
            </Button>
            <Button onClick={() => nav("/procurement/requisitions/new")}>
              New requisition
            </Button>
          </Can>
        }
      />

      <div className="mb-4 max-w-xs">
        <Select
          value={status}
          options={STATUSES}
          onChange={(value) => { setStatus(String(value)); setPage(1); }}
        />
      </div>

      <ErrorBanner error={error} />

      <Card className="p-2">
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          onRowClick={(r) => nav(`/procurement/requisitions/${r.id}`)}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          empty={
            status
              ? "No requisitions in this status."
              : "No requisitions yet. Raise one to start the buying chain."
          }
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-ink">{r.req_no}</span>
                <StatusPill status={r.status} />
              </div>
              <div className="text-sm text-body">{r.warehouse_name ?? "—"}</div>
              <div className="text-xs text-muted">
                {r.total_items} line{r.total_items === 1 ? "" : "s"} · {money(r.estimated_value)}
              </div>
            </div>
          )}
        />
      </Card>
    </div>
  );
}
