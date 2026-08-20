import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import {
  Button, Can, Card, ErrorBanner, FilterMenu, Input, PageHeader, ResponsiveList, StatCard,
  StatusPill, type Column,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { consolidationApi } from "../api";
import { money } from "./RequisitionListPage";
import type { ConsolidationListRow } from "../types";

const SIZE = 20;

const STATUSES = [
  { value: "", label: "All statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "PENDING_APPROVAL", label: "Pending approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "RFQ_RAISED", label: "RFQ raised" },
  { value: "CLOSED", label: "Closed" },
  { value: "REJECTED", label: "Rejected" },
  { value: "CANCELLED", label: "Cancelled" },
];

/**
 * Consolidated buying sheets — the month's demand as one document.
 *
 * `source_count` is on the row rather than in the detail because it is the first
 * thing anyone asks of a sheet: forty requisitions rolled into thirty lines is the
 * whole point, and a register that hides it looks like a second requisition list.
 */
export function PurchaseConsolidationListPage() {
  const nav = useNavigate();
  const [status, setStatus] = useState("");
  // The register had a status dropdown and NO search box at all, so finding one sheet
  // among a period's worth meant paging. Search and project are filtered in the
  // browser over the page already in hand — the endpoint takes neither, and adding
  // them server-side is a backend change this screen does not need at 20 rows a page.
  const [search, setSearch] = useState("");
  const [project, setProject] = useState("");
  const [page, setPage] = useState(1);

  const { data, isLoading, error } = useQuery({
    queryKey: ["consolidations", status, page],
    queryFn: () => consolidationApi.list({
      status: status || undefined, page, size: SIZE,
    }),
  });

  const { data: waiting } = useQuery({
    queryKey: ["consolidation-candidates-count"],
    queryFn: () => consolidationApi.candidates({ size: 1 }),
  });

  const all = data?.items ?? [];
  const projectOptions = [...new Set(all.map((r) => r.project_name).filter(Boolean))]
    .map((v) => ({ value: v as string, label: v as string }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const q = search.trim().toLowerCase();
  const rows = all.filter((r) =>
    (!project || r.project_name === project)
    && (!q || [r.cons_no, r.title, r.project_name, r.period_label, r.created_by_name]
      .some((f) => String(f ?? "").toLowerCase().includes(q))));
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / SIZE));

  const columns: Column<ConsolidationListRow>[] = [
    {
      key: "cons",
      header: "Sheet",
      render: (r) => (
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-ink">{r.cons_no}</div>
          <div className="truncate text-[11px] text-muted">
            {r.title ?? r.period_label ?? fmtDate(r.cons_date)}
          </div>
        </div>
      ),
    },
    {
      key: "period",
      header: "Covers",
      hideOnNarrow: true,
      render: (r) => r.period_label ?? "—",
    },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    {
      key: "rolled",
      header: "Rolled up",
      className: "text-right",
      render: (r) => (
        <span className="text-sm text-body">
          {r.source_count} req → {r.total_items} line{r.total_items === 1 ? "" : "s"}
        </span>
      ),
    },
    {
      key: "project",
      header: "Project",
      hideOnNarrow: true,
      render: (r) => r.project_name ?? "—",
    },
    {
      key: "value",
      header: "Estimated",
      className: "text-right",
      render: (r) => (
        <span className="font-semibold text-ink">{money(r.estimated_value)}</span>
      ),
    },
    {
      key: "with",
      header: "Pending with",
      hideOnNarrow: true,
      // `current_approver_name` is NEVER written on a consolidation — only cleared —
      // so this column read "—" on every sheet. `pending_with` is the live answer.
      render: (r) => (r.pending_with?.length
        ? r.pending_with.join(", ")
        : "—"),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Procurement"
        title="Consolidation"
        actions={
          <Can do="consolidation.create">
            <Button onClick={() => nav("/procurement/consolidations/new")}>
              New sheet
            </Button>
          </Can>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <StatCard
          label="Requisitions waiting to be consolidated"
          value={waiting?.total ?? 0}
        />
        <StatCard label="Sheets on the register" value={data?.total ?? 0} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-line/70 bg-content1 p-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search sheet no., title, project or period..."
            className="pl-9"
          />
        </div>
        <FilterMenu
          label="Status"
          value={status}
          onChange={(value) => { setStatus(value); setPage(1); }}
          options={STATUSES.filter((o) => o.value)}
        />
        <FilterMenu label="Project" value={project} onChange={setProject}
                    options={projectOptions} />
        {(search || status || project) && (
          <button
            onClick={() => { setSearch(""); setStatus(""); setProject(""); setPage(1); }}
            className="h-11 rounded-lg px-3 text-sm font-medium text-muted hover:bg-content2 hover:text-ink"
          >
            Clear
          </button>
        )}
      </div>

      <ErrorBanner error={error} />

      <Card className="p-2">
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          onRowClick={(r) => nav(`/procurement/consolidations/${r.id}`)}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          empty={
            status || project || search
              ? "No sheets match these filters."
              : "No consolidated sheets yet. Roll approved requisitions into one to tender them together."
          }
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-ink">{r.cons_no}</span>
                <StatusPill status={r.status} />
              </div>
              <div className="text-sm text-body">
                {r.title ?? r.period_label ?? "Untitled sheet"}
              </div>
              <div className="text-xs text-muted">
                {r.source_count} requisition{r.source_count === 1 ? "" : "s"} ·{" "}
                {r.total_items} line{r.total_items === 1 ? "" : "s"} ·{" "}
                {money(r.estimated_value)}
              </div>
            </div>
          )}
        />
      </Card>
    </div>
  );
}
