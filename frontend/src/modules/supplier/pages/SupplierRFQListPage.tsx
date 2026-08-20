import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import {
  Card, ErrorBanner, FilterMenu, PageHeader, ResponsiveList, StatusPill, Input,
  type Column,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { supplierApi } from "@/modules/procurement/api";
import type { RFQListRow } from "@/modules/procurement/types";
import { useDebouncedValue } from "@/shared/hooks/useDebouncedValue";
import { VENDOR_RFQ_STATUS_OPTIONS, vendorRfqLabel } from "../status";

const SIZE = 20;

/** What this vendor has been asked to quote on. The list is already filtered
 *  server-side to their own invitations — there is no "all RFQs" to fall back to. */
export function SupplierRFQListPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  // Debounce the search input to avoid spamming the API on every keystroke
  const debouncedSearch = useDebouncedValue(search);
  const [page, setPage] = useState(1);

  // Automatically reset to the first page whenever the search or filter changes
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, status]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["supplier-rfqs", debouncedSearch, status, page],
    queryFn: () => supplierApi.rfqs({
      search: debouncedSearch || undefined,
      status: status || undefined,
      page, size: SIZE,
    }),
  });

  const columns: Column<RFQListRow>[] = [
    {
      key: "rfq",
      header: "Request",
      render: (r) => (
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-ink">{r.rfq_no}</div>
          <div className="truncate text-[11px] text-muted">{r.title ?? "Untitled"}</div>
        </div>
      ),
    },
    { key: "lines", header: "Items", className: "text-right", render: (r) => r.total_items },
    {
      key: "due",
      header: "Closes",
      render: (r) => (r.due_date ? fmtDate(r.due_date) : "No deadline"),
    },
    {
      key: "status", header: "Status",
      render: (r) => <StatusPill status={r.status} label={vendorRfqLabel(r.status)} />,
    },
  ];

  return (
    <div>
      <PageHeader eyebrow="Supplier" title="Requests for Quotation" />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search RFQs, titles..."
            className="pl-9"
          />
        </div>
        <FilterMenu
          label="Status"
          value={status}
          onChange={setStatus}
          options={VENDOR_RFQ_STATUS_OPTIONS}
        />
        {(search || status) && (
          <button
            onClick={() => { setSearch(""); setStatus(""); }}
            className="h-11 rounded-lg px-3 text-sm font-medium text-muted hover:bg-content2 hover:text-ink"
          >
            Clear
          </button>
        )}
      </div>

      <ErrorBanner error={error} />

      <Card className="p-2">
        <ResponsiveList
          data={data?.items ?? []}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          onRowClick={(r) => nav(`/supplier/rfqs/${r.id}`)}
          page={page}
          totalPages={Math.max(1, Math.ceil((data?.total ?? 0) / SIZE))}
          onPageChange={setPage}
          empty="Nothing has been sent to you yet."
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-ink">{r.rfq_no}</span>
                <StatusPill status={r.status} label={vendorRfqLabel(r.status)} />
              </div>
              <div className="text-sm text-body">{r.title ?? "Untitled"}</div>
              <div className="text-xs text-muted">
                {r.total_items} item{r.total_items === 1 ? "" : "s"}
                {r.due_date ? ` · closes ${fmtDate(r.due_date)}` : ""}
              </div>
            </div>
          )}
        />
      </Card>
    </div>
  );
}
