import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import { PageHeader, Card, ResponsiveGrid, ResponsiveList, StatCard, StatusPill, type Column } from "@/shared/components";
import { FilterBar, FilterSelect } from "../components/FilterBar";
import { listMaterialRequests } from "../api";
import type { MaterialRequestListRow } from "../types";

/**
 * Material requests raised when an approved indent could not be filled from stock.
 * Nobody types these: the availability check creates them, so the list is a queue for
 * procurement rather than a place to add a row.
 */
const STATUSES = [
  { value: "PENDING_APPROVAL", label: "In approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
  { value: "ORDERED", label: "Ordered" },
];

const fmtDate = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) : "—";

/** Days until required_by. Negative means the store is already late. */
const dueIn = (s?: string | null) =>
  s ? Math.ceil((new Date(s).getTime() - Date.now()) / 86_400_000) : null;

export function MaterialRequestsPage() {
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const nav = useNavigate();

  const { data, isLoading, error } = useQuery({
    queryKey: ["material-requests", status],
    queryFn: () => listMaterialRequests({ status: status || undefined }),
  });

  const all: MaterialRequestListRow[] = data?.items ?? [];

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) =>
      r.mr_no?.toLowerCase().includes(q) ||
      r.indent_no?.toLowerCase().includes(q) ||
      r.department_name?.toLowerCase().includes(q) ||
      r.requested_by_name?.toLowerCase().includes(q));
  }, [all, search]);

  const kpis = useMemo(() => ({
    pending: all.filter((r) => r.status === "PENDING_APPROVAL").length,
    urgent: all.filter((r) => r.priority === "URGENT").length,
    overdue: all.filter((r) => (dueIn(r.required_by) ?? 1) < 0 && r.status !== "ORDERED").length,
  }), [all]);

  const columns: Column<MaterialRequestListRow>[] = [
    {
      key: "no",
      header: "Request",
      render: (r) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{r.mr_no}</div>
          <div className="text-[11px] text-muted">for {r.indent_no ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "who",
      header: "Raised by",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-ink">{r.requested_by_name ?? "—"}</div>
          <div className="truncate text-[11px] text-muted">{r.department_name ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "priority",
      header: "Priority",
      render: (r) =>
        r.priority ? (
          <Chip size="sm" variant="flat" color={r.priority === "URGENT" ? "danger" : "default"}>{r.priority}</Chip>
        ) : "—",
    },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    {
      key: "required_by",
      header: "Needed By",
      render: (r) => {
        const d = dueIn(r.required_by);
        if (d === null) return <span className="text-muted">—</span>;
        return (
          <div>
            <div className="text-sm text-body">{fmtDate(r.required_by)}</div>
            <div className={`text-[11px] ${d < 0 ? "text-danger" : d <= 3 ? "text-warning" : "text-muted"}`}>
              {d < 0 ? `${Math.abs(d)}d overdue` : `in ${d}d`}
            </div>
          </div>
        );
      },
    },
    {
      key: "approver",
      header: "With",
      hideOnNarrow: true,
      render: (r) => r.current_approver_name ?? "—",
    },
    {
      key: "date",
      header: "Raised",
      hideOnNarrow: true,
      render: (r) => <span className="text-muted">{fmtDate(r.created_at)}</span>,
    },
  ];

  return (
    <div>
      <PageHeader eyebrow="Inventory" title="Material Requests" />

      <p className="mb-4 text-sm text-muted">
        Raised automatically when an approved indent runs short of stock. Procurement picks them up from here.
      </p>

      <ResponsiveGrid cols={3} className="mb-4">
        <StatCard label="In Approval" value={kpis.pending} tone={kpis.pending ? "text-warning" : "text-muted"} />
        <StatCard label="Urgent" value={kpis.urgent} tone={kpis.urgent ? "text-danger" : "text-muted"} />
        <StatCard label="Past Needed-By" value={kpis.overdue} tone={kpis.overdue ? "text-danger" : "text-muted"} />
      </ResponsiveGrid>

      <FilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search request, indent, requester or department…"
        onClear={() => { setSearch(""); setStatus(""); }}
        active={[search, status].filter(Boolean).length}
      >
        <FilterSelect value={status} onChange={setStatus} placeholder="All statuses" options={STATUSES} />
      </FilterBar>

      {error ? (
        <p className="rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          {(error as Error).message}
        </p>
      ) : (
        <Card className="p-2">
          <ResponsiveList
            data={rows}
            loading={isLoading}
            keyOf={(r) => r.id}
            onRowClick={(r) => nav(`/inventory/material-requests/${r.id}`)}
            columns={columns}
            empty="No store requests yet. One appears here when an approved indent cannot be filled from stock."
            renderCard={(r) => (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm font-semibold text-ink">{r.mr_no}</span>
                  <StatusPill status={r.status} />
                </div>
                <p className="text-sm text-body">For {r.indent_no ?? "—"} · {r.department_name ?? "—"}</p>
                <p className="text-xs text-muted">
                  Raised {fmtDate(r.created_at)}{r.required_by ? ` · needed by ${fmtDate(r.required_by)}` : ""}
                </p>
              </div>
            )}
          />
        </Card>
      )}
    </div>
  );
}
