import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import { Clock, Plus, TriangleAlert } from "lucide-react";
import {
  Button, Can, PageHeader, Card, KpiTiles, ResponsiveList, StatusPill,
  type Column, type KpiTileSpec,
} from "@/shared/components";
import { FilterBar, FilterSelect } from "../components/FilterBar";
import { listMaterialRequests } from "../api";
import type { MaterialRequestListRow } from "../types";
import { fmtDate } from "@/shared/datetime";

/**
 * Material requests raised when an approved indent could not be filled from stock.
 *
 * Most are still written by the availability check rather than by a person, so this
 * reads as a queue for procurement. It is no longer only that: the shortfall fires on
 * stock ANYWHERE, so a line the warehouse cannot serve but an LIP point can was never
 * short and never reached here. Create raises that request by hand, and so does the
 * per-line button on the allocation screen.
 */
const STATUSES = [
  { value: "PENDING_APPROVAL", label: "In approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
  { value: "ORDERED", label: "Ordered" },
  // The goods landed (GRN QC pass). Terminal, and filterable — a request that closes
  // itself and cannot be looked up afterwards reads as one that went missing.
  { value: "RECEIVED", label: "Received" },
];


/** Days until required_by. Negative means the store is already late. */
const dueIn = (s?: string | null) =>
  s ? Math.ceil((new Date(s).getTime() - Date.now()) / 86_400_000) : null;

export function MaterialRequestsPage() {
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  // The two KPIs that are not a status. `priority` and "past needed-by" are not
  // columns the endpoint filters on, and both are read off rows already in memory, so
  // the tile narrows the same list the tile counted rather than asking for a filter
  // the server does not have.
  const [flag, setFlag] = useState<"" | "urgent" | "overdue">("");
  const nav = useNavigate();

  const { data, isLoading, error } = useQuery({
    queryKey: ["material-requests", status],
    queryFn: () => listMaterialRequests({ status: status || undefined }),
  });

  const all: MaterialRequestListRow[] = data?.items ?? [];

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = all;
    if (flag === "urgent") out = out.filter((r) => r.priority === "URGENT");
    if (flag === "overdue") {
      out = out.filter((r) => (dueIn(r.required_by) ?? 1) < 0 && r.status !== "ORDERED");
    }
    if (!q) return out;
    return out.filter((r) =>
      r.mr_no?.toLowerCase().includes(q) ||
      r.indent_no?.toLowerCase().includes(q) ||
      r.department_name?.toLowerCase().includes(q) ||
      r.requested_by_name?.toLowerCase().includes(q));
  }, [all, search, flag]);

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
      <PageHeader
        eyebrow="Inventory"
        title="Material Requests"
        actions={
          <Can do="mr.create">
            <Button onClick={() => nav("/inventory/material-requests/new")}>
              <Plus size={16} /> Create MR
            </Button>
          </Can>
        }
      />

      <p className="mb-4 text-sm text-muted">
        Buy requests for what stock could not serve. Procurement picks them up here.
      </p>

      {/* THE NUMBER IS THE BUTTON — pressing a tile applies the filter it counted and
          pressing it again clears it. "In approval" is a server-side status; the other
          two narrow the rows already loaded. The three are mutually exclusive, so
          turning one on turns the others off rather than intersecting to nothing. */}
      <KpiTiles label="Material request queues" className="mb-4" tiles={[
        {
          key: "pending", label: "In approval", value: kpis.pending, icon: Clock,
          tone: kpis.pending ? "warn" : "neutral",
          active: status === "PENDING_APPROVAL",
          onPress: () => {
            setFlag("");
            setStatus((on) => (on === "PENDING_APPROVAL" ? "" : "PENDING_APPROVAL"));
          },
        },
        {
          key: "urgent", label: "Urgent", value: kpis.urgent, icon: TriangleAlert,
          tone: kpis.urgent ? "bad" : "neutral", active: flag === "urgent",
          onPress: () => { setStatus(""); setFlag((on) => (on === "urgent" ? "" : "urgent")); },
        },
        {
          key: "overdue", label: "Past needed-by", value: kpis.overdue, icon: Clock,
          tone: kpis.overdue ? "bad" : "neutral", active: flag === "overdue",
          onPress: () => { setStatus(""); setFlag((on) => (on === "overdue" ? "" : "overdue")); },
        },
      ] satisfies KpiTileSpec[]} />

      <FilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search request, indent, requester or department…"
        onClear={() => { setSearch(""); setStatus(""); setFlag(""); }}
        active={[search, status, flag].filter(Boolean).length}
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
            empty="No requests yet."
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
