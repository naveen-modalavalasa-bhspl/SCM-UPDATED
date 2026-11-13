import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Can, Card, ErrorBanner, FilterBar, FilterMenu, PageHeader, ResponsiveList, StatusPill, type Column } from "@/shared/components";
import { Button } from "../components/ActionButton";
import { fmtDate } from "@/shared/datetime";
import { requisitionApi } from "../api";
import type { ReqListRow } from "../types";
import { useDebouncedValue } from "@/shared/hooks/useDebouncedValue";
import { RequisitionKpis } from "../components/ProcurementKpis";
import { useUrlFilters } from "../urlFilters";

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
/** Every filter this screen owns, so Clear knows what to drop. */
const FILTER_KEYS = ["status", "search", "project", "raiser", "pending_for_me"];

export function RequisitionListPage() {
  const nav = useNavigate();
  // Filters live in the URL, not in component state (see `../urlFilters`): the KPI
  // strip above applies them, the Overview links straight into them, and a filtered
  // register is a link somebody can paste to a colleague.
  const { get, getBool, set, clear, page, setPage, activeCount } = useUrlFilters();
  const status = get("status");
  // Project and raiser, filtered in the browser over the page in hand — the endpoint
  // takes neither, and these are the two things a buyer narrows by after status.
  const project = get("project");
  const raiser = get("raiser");
  const search = get("search");
  const pendingForMe = getBool("pending_for_me");
  // Debounce the search input to avoid spamming the API on every keystroke
  const debouncedSearch = useDebouncedValue(search);

  const { data, isLoading, error } = useQuery({
    queryKey: ["requisitions", status, debouncedSearch, pendingForMe, page],
    queryFn: () => requisitionApi.list({
      status: status || undefined,
      search: debouncedSearch || undefined,
      pending_for_me: pendingForMe || undefined,
      page, size: SIZE,
    }),
  });

  const all = data?.items ?? [];
  const optionsOf = (pick: (r: typeof all[number]) => string | null | undefined) =>
    [...new Set(all.map(pick).filter(Boolean))]
      .map((v) => ({ value: v as string, label: v as string }))
      .sort((a, b) => a.label.localeCompare(b.label));
  const projectOptions = optionsOf((r) => r.project_name);
  const raiserOptions = optionsOf((r) => r.created_by_name);
  const rows = all.filter((r) =>
    (!project || r.project_name === project)
    && (!raiser || r.created_by_name === raiser));
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
    { key: "organisation", header: "Organisation", hideOnNarrow: true, render: (r) => r.organization_name ?? "—" },
    { key: "project", header: "Project", hideOnNarrow: true, render: (r) => r.project_name ?? "—" },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    {
      key: "with",
      header: "Pending with",
      hideOnNarrow: true,
      // Live from the approval engine. `current_approver_name` behind it is the
      // snapshot the row used to carry, kept only as a fallback.
      render: (r) => (r.pending_with?.length
        ? r.pending_with.join(", ")
        : (r.current_approver_name ?? "—")),
    },
    { key: "lines", header: "Number of Items", className: "text-right", render: (r) => r.total_items },
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

      {/* The KPI strip: pressing a tile applies the filter it counts and pressing it
          again clears it. Gated on `requisition.view` inside the component, which is
          the same code this screen's endpoint checks. */}
      <div className="mb-4">
        <RequisitionKpis />
      </div>

      {/* The shared strip, not a fourth hand-rolled copy of it (2026-08-22). Every
          procurement list carried its own search box and its own Clear button, all at
          slightly different heights; the count on Clear now says how many are set. */}
      <FilterBar
        search={search}
        onSearch={(value) => set({ search: value })}
        searchPlaceholder="Search requisition, project or raiser…"
        active={activeCount(FILTER_KEYS)}
        onClear={() => clear(FILTER_KEYS)}
      >
        <FilterMenu label="Status" value={status}
                    onChange={(value) => set({ status: value })}
                    options={STATUSES.filter((o) => o.value)} />
        <FilterMenu label="Project" value={project}
                    onChange={(value) => set({ project: value })}
                    options={projectOptions} />
        <FilterMenu label="Raised by" value={raiser}
                    onChange={(value) => set({ raiser: value })}
                    options={raiserOptions} />
      </FilterBar>

      <ErrorBanner error={error} />

      <Card className="p-2">
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          onRowClick={(r) => nav(r.status === "DRAFT" ? `/procurement/requisitions/${r.id}/edit` : `/procurement/requisitions/${r.id}`)}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          empty={
            pendingForMe
              ? "Nothing is waiting for your signature."
              : status
                ? "No requisitions in this status."
                : "No requisitions yet. Raise one to start the buying chain."
          }
          renderCard={(r) => (
            <div
              className="space-y-1.5 cursor-pointer"
              onClick={() => nav(r.status === "DRAFT" ? `/procurement/requisitions/${r.id}/edit` : `/procurement/requisitions/${r.id}`)}
            >
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
