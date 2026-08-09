import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Card, ErrorBanner, PageHeader, ResponsiveList, StatusPill, Select, type Column,
} from "@/shared/components";
import { poApi } from "../api";
import type { POListRow } from "../types";
import { fmtDate } from "@/shared/datetime";

/** POStatus, as the backend enum spells it. */
const STATUSES = [
  { value: "", label: "All statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "PENDING_APPROVAL", label: "Pending approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "SENT_TO_VENDOR", label: "Sent to vendor" },
  { value: "PARTIALLY_RECEIVED", label: "Partially received" },
  { value: "RECEIVED", label: "Received" },
  { value: "REJECTED", label: "Rejected" },
  { value: "CANCELLED", label: "Cancelled" },
];

const money = (n?: number) =>
  `₹${Number(n ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const SIZE = 20;

/**
 * The purchase order list.
 *
 * A PO is only ever raised from an approved indent (`create_po_from_indent`), so this
 * screen has no "New" button on purpose — the chain starts one document upstream.
 * It reads, filters and opens; the detail screen owns every action.
 */
export function POListPage() {
  const nav = useNavigate();
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);

  const { data, isLoading, error } = useQuery({
    queryKey: ["pos", status, page],
    queryFn: () => poApi.list({ status: status || undefined, page, size: SIZE }),
  });

  const rows = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / SIZE));

  const columns: Column<POListRow>[] = [
    {
      key: "po",
      header: "PO",
      render: (r) => (
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-ink">{r.po_no}</div>
          <div className="text-[11px] text-muted">
            {r.indent_no ? `from ${r.indent_no}` : "No indent"}
          </div>
        </div>
      ),
    },
    { key: "vendor", header: "Vendor", render: (r) => r.vendor_name ?? "—" },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    {
      key: "value",
      header: "Value",
      className: "text-right",
      render: (r) => <span className="font-semibold text-ink">{money(r.total_amount)}</span>,
    },
    {
      key: "raised",
      header: "Raised",
      hideOnNarrow: true,
      render: (r) => (
        <span className="text-sm text-muted">
          {fmtDate(r.created_at)}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader eyebrow="Purchasing" title="Purchase Orders" />

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
          onRowClick={(r) => nav(`/pos/${r.id}`)}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          empty={
            status
              ? "No purchase orders in this status."
              : "No purchase orders yet. One is raised from an approved indent."
          }
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-ink">{r.po_no}</span>
                <StatusPill status={r.status} />
              </div>
              <div className="text-sm text-body">{r.vendor_name ?? "—"}</div>
              <div className="text-xs text-muted">
                {r.indent_no ? `from ${r.indent_no} · ` : ""}{money(r.total_amount)}
              </div>
            </div>
          )}
        />
      </Card>
    </div>
  );
}
