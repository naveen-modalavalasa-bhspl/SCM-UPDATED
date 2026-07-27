import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Tab, Tabs } from "@heroui/react";
import { PageHeader, ResponsiveList, StatusPill, type Column } from "@/shared/components";
import { listMaterialRequests } from "../api";
import type { MaterialRequestListRow } from "../types";

/**
 * Material requests raised when an approved indent could not be filled from stock.
 * Nobody types these: the availability check creates them, so the list is a queue for
 * procurement rather than a place to add a row.
 */
const FILTERS = [
  { key: "all", label: "All" },
  { key: "PENDING_APPROVAL", label: "In approval" },
  { key: "APPROVED", label: "Approved" },
  { key: "REJECTED", label: "Rejected" },
  { key: "ORDERED", label: "Ordered" },
];

function fmtDate(s?: string | null) {
  return s ? new Date(s).toLocaleDateString(undefined, { day: "2-digit", month: "short" }) : "—";
}

export function MaterialRequestsPage() {
  const [status, setStatus] = useState("");
  const nav = useNavigate();
  const { data, isLoading, error } = useQuery({
    queryKey: ["material-requests", status],
    queryFn: () => listMaterialRequests({ status: status || undefined }),
  });

  const columns: Column<MaterialRequestListRow>[] = [
    {
      key: "no",
      header: "MR",
      render: (r) => <span className="mono font-semibold text-ink">{r.mr_no}</span>,
    },
    {
      key: "indent",
      header: "Raised for",
      render: (r) => <span className="mono text-muted">{r.indent_no ?? "—"}</span>,
    },
    { key: "dept", header: "Department", render: (r) => r.department_name ?? "—", hideOnNarrow: true },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    {
      key: "approver",
      header: "With",
      render: (r) => r.current_approver_name ?? "—",
      hideOnNarrow: true,
    },
    {
      key: "date",
      header: "Raised",
      render: (r) => <span className="text-muted">{fmtDate(r.created_at)}</span>,
      hideOnNarrow: true,
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Inventory"
        title="Material requests"
      />

      <p className="mb-4 text-sm text-muted">
        Raised automatically when an approved indent runs short of stock.
      </p>

      <Tabs
        aria-label="Filter by status"
        variant="solid"
        color="primary"
        radius="full"
        selectedKey={status || "all"}
        onSelectionChange={(k) => setStatus(k === "all" ? "" : String(k))}
        classNames={{ base: "mb-4", tabList: "bg-content2 p-1" }}
      >
        {FILTERS.map((f) => (
          <Tab key={f.key} title={f.label} />
        ))}
      </Tabs>

      {error ? (
        <p className="rounded-lg bg-danger-50 p-4 text-danger">{(error as Error).message}</p>
      ) : (
        <ResponsiveList
          data={data?.items ?? []}
          loading={isLoading}
          keyOf={(r) => r.id}
          onRowClick={(r) => nav(`/inventory/material-requests/${r.id}`)}
          columns={columns}
          empty="No material requests yet. One appears here when an approved indent cannot be filled from stock."
          renderCard={(r) => (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="mono font-semibold text-ink">{r.mr_no}</span>
                <StatusPill status={r.status} />
              </div>
              <p className="text-sm text-muted">
                For {r.indent_no ?? "—"} · {r.department_name ?? "—"}
              </p>
              <p className="text-xs text-muted">Raised {fmtDate(r.created_at)}</p>
            </div>
          )}
        />
      )}
    </>
  );
}
