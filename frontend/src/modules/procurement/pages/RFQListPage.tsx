import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Button, Can, Card, ErrorBanner, FilterBar, FilterMenu, PageHeader, ResponsiveList,
  StatusPill, type Column,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { rfqApi } from "../api";
import type { RFQListRow } from "../types";
import { useDebouncedValue } from "@/shared/hooks/useDebouncedValue";
import { RFQKpis } from "../components/ProcurementKpis";
import { useUrlFilters } from "../urlFilters";

/** RFQStatus, as the backend enum spells it. */
const STATUSES = [
  { value: "", label: "All statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "PENDING_APPROVAL", label: "Pending approval" },
  { value: "PUBLISHED", label: "Open to vendors" },
  { value: "CLOSED", label: "Closed" },
  { value: "AWARDED", label: "Awarded" },
  { value: "CANCELLED", label: "Cancelled" },
];

/** How soon an RFQ shuts. Overdue is its own row: a tender past its date with no
 *  quotes in is the one a buyer has to act on today. */
const CLOSING = [
  { value: "overdue", label: "Past due" },
  { value: "7", label: "Next 7 days" },
  { value: "30", label: "Next 30 days" },
];

const SIZE = 20;

/** Every filter this screen owns, so Clear knows what to drop. */
const FILTER_KEYS = ["status", "search", "closing", "pending_for_me", "ready_to_award"];

export function RFQListPage() {
  const nav = useNavigate();
  // Filters live in the URL — see `../urlFilters`. The KPI strip above sets them.
  const { get, getBool, set, clear, page, setPage, activeCount } = useUrlFilters();
  const status = get("status");
  // Closing window, filtered in the browser: the endpoint takes no date parameter, and
  // "what shuts this week" is the question a buyer actually asks of this register.
  const closing = get("closing");
  const search = get("search");
  const pendingForMe = getBool("pending_for_me");
  const readyToAward = getBool("ready_to_award");
  // Debounce the search input to avoid spamming the API on every keystroke
  const debouncedSearch = useDebouncedValue(search);

  const { data, isLoading, error } = useQuery({
    queryKey: ["rfqs", status, debouncedSearch, pendingForMe, readyToAward, page],
    queryFn: () => rfqApi.list({
      status: status || undefined,
      search: debouncedSearch || undefined,
      pending_for_me: pendingForMe || undefined,
      ready_to_award: readyToAward || undefined,
      page, size: SIZE,
    }),
  });

  const all = data?.items ?? [];
  const rows = all.filter((r) => {
    if (!closing) return true;
    if (!r.due_date) return false;
    const due = new Date(r.due_date);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (closing === "overdue") return due < today;
    const limit = new Date(today);
    limit.setDate(limit.getDate() + Number(closing));
    return due >= today && due <= limit;
  });
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / SIZE));

  const columns: Column<RFQListRow>[] = [
    {
      key: "rfq",
      header: "RFQ",
      render: (r) => (
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-ink">{r.rfq_no}</div>
          <div className="truncate text-[11px] text-muted">{r.title ?? "Untitled"}</div>
        </div>
      ),
    },
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

    {
      key: "responses",
      header: "Responses",
      className: "text-right",
      // The pair, not a percentage: "2 of 5" is what a buyer chases, and 40% is not.
      render: (r) => (
        <span className="text-sm text-body">
          {r.response_count} of {r.vendor_count}
        </span>
      ),
    },
    { key: "lines", header: "Lines", className: "text-right", hideOnNarrow: true, render: (r) => r.total_items },
    {
      key: "due",
      header: "Closes",
      render: (r) => (r.due_date ? fmtDate(r.due_date) : "—"),
    },
    {
      key: "awarded",
      header: "Awarded to",
      hideOnNarrow: true,
      render: (r) => r.awarded_vendor_name ?? "—",
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Procurement"
        title="Requests for Quotation"
        actions={
          <Can do="rfq.create">
            <Button onClick={() => nav("/procurement/rfqs/new")}>New RFQ</Button>
          </Can>
        }
      />

      {/* The KPI strip. Gated inside the component on `rfq.view`, the same code this
          screen's endpoint checks. */}
      <div className="mb-4">
        <RFQKpis />
      </div>

      {/* Shared filter strip — see RequisitionListPage for why the local copies went. */}
      <FilterBar
        search={search}
        onSearch={(value) => set({ search: value })}
        searchPlaceholder="Search RFQ no. or title…"
        active={activeCount(FILTER_KEYS)}
        onClear={() => clear(FILTER_KEYS)}
      >
        <FilterMenu label="Status" value={status}
                    onChange={(value) => set({ status: value })}
                    options={STATUSES.filter((o) => o.value)} />
        <FilterMenu label="Closes" value={closing}
                    onChange={(value) => set({ closing: value })} options={CLOSING} />
      </FilterBar>

      <ErrorBanner error={error} />

      <Card className="p-2">
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          onRowClick={(r) => nav(`/procurement/rfqs/${r.id}`)}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          empty={
            pendingForMe
              ? "Nothing is waiting for your signature."
              : readyToAward
                ? "No tender has replies waiting to be awarded."
                : status ? "No RFQs in this status." : "No RFQs yet."
          }
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-ink">{r.rfq_no}</span>
                <StatusPill status={r.status} />
              </div>
              <div className="text-sm text-body">{r.title ?? "Untitled"}</div>
              <div className="text-xs text-muted">
                {r.response_count} of {r.vendor_count} replied
                {r.due_date ? ` · closes ${fmtDate(r.due_date)}` : ""}
              </div>
            </div>
          )}
        />
      </Card>
    </div>
  );
}
