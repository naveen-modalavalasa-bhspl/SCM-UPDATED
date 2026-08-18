import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import {
  Button, Can, Card, ErrorBanner, PageHeader, ResponsiveList, Select, StatusPill,
  Input, type Column,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { rfqApi } from "../api";
import type { RFQListRow } from "../types";
import { useDebouncedValue } from "@/shared/hooks/useDebouncedValue";

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

const SIZE = 20;

export function RFQListPage() {
  const nav = useNavigate();
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  // Debounce the search input to avoid spamming the API on every keystroke
  const debouncedSearch = useDebouncedValue(search);
  const [page, setPage] = useState(1);

  // Automatically reset to the first page whenever the search query or status filter changes
  useEffect(() => {
    setPage(1);
  }, [status, debouncedSearch]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["rfqs", status, debouncedSearch, page],
    queryFn: () => rfqApi.list({ status: status || undefined, search: debouncedSearch || undefined, page, size: SIZE }),
  });

  const rows = data?.items ?? [];
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

      <div className="mb-4 flex max-w-2xl flex-col gap-4 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search RFQs, titles..."
            className="pl-9"
          />
        </div>
        <div className="w-full sm:w-64">
          <Select
            value={status}
            options={STATUSES}
            onChange={(value) => { setStatus(String(value)); }}
          />
        </div>
      </div>

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
          empty={status ? "No RFQs in this status." : "No RFQs yet."}
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
