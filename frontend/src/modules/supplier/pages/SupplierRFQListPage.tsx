import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import {
  Card, ErrorBanner, FilterMenu, ResponsiveList, StatusPill, Input,
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
          <div className="truncate text-[11px] text-muted">{r.title && r.title.trim() !== "" && r.title !== "Untitled" ? r.title : null}</div>
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
      render: (r) => {
        if (r.has_pending_change_request || r.vendor_status === "CHANGE_PROPOSED") {
          return (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 border border-amber-500/30 px-3 py-1 text-xs font-bold text-amber-700 shadow-sm">
              <span className="h-2 w-2 rounded-full bg-amber-500 animate-ping" />
              Change Proposed (Action Required)
            </span>
          );
        }
        if (r.vendor_status === "SUBMITTED" || r.vendor_status === "REVISED") {
          return <StatusPill status="SUBMITTED" label="Quote submitted" />;
        }
        return <StatusPill status={r.status} label={vendorRfqLabel(r.status)} />;
      }
    },
  ];

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      {/* Premium Hero Header */}
      <div className="relative mb-8 overflow-hidden rounded-3xl bg-gradient-to-br from-brand via-brand/90 to-brand/80 p-8 sm:p-10 text-white shadow-xl">
        <div className="absolute -right-20 -top-20 h-64 w-64 rounded-full bg-white/10 blur-3xl transition-transform duration-700 hover:scale-110" />
        <div className="absolute -bottom-20 -left-20 h-48 w-48 rounded-full bg-white/10 blur-2xl transition-transform duration-700 hover:scale-110" />
        <div className="relative z-10">
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-white/80">
            <span className="h-1.5 w-1.5 rounded-full bg-white/80 animate-pulse" />
            Supplier Portal
          </p>
          <h1 className="font-display text-4xl font-extrabold tracking-tight sm:text-5xl">
            Requests for Quotation
          </h1>
          <p className="mt-4 max-w-xl text-lg text-white/90 leading-relaxed">
            Review your incoming requests, submit competitive quotes, and win more business.
          </p>
        </div>
      </div>

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line/40">
        <div className="flex flex-1 flex-wrap items-center gap-3">
          <div className="relative min-w-[240px] flex-1 sm:max-w-md">
            <Search className="absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-muted transition-colors group-focus-within:text-brand" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search RFQ number or title..."
              className="h-11 rounded-xl bg-surface-2/50 pl-11 shadow-inner focus:bg-surface focus:ring-2 focus:ring-brand/50 transition-all"
            />
          </div>
          <FilterMenu
            label="Status"
            value={status}
            onChange={setStatus}
            options={VENDOR_RFQ_STATUS_OPTIONS}
          />
        </div>
        {(search || status) && (
          <button
            onClick={() => { setSearch(""); setStatus(""); }}
            className="h-11 whitespace-nowrap rounded-xl bg-surface-2 px-4 text-sm font-semibold text-muted transition-colors hover:bg-content2 hover:text-ink focus:outline-none focus:ring-2 focus:ring-brand"
          >
            Clear filters
          </button>
        )}
      </div>

      <ErrorBanner error={error} />

      <Card className="overflow-hidden border-none shadow-xl shadow-brand/5 ring-1 ring-line/40 rounded-2xl">
        <ResponsiveList
          data={data?.items ?? []}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          onRowClick={(r) => nav(`/supplier/rfqs/${r.id}`)}
          page={page}
          totalPages={Math.max(1, Math.ceil((data?.total ?? 0) / SIZE))}
          onPageChange={setPage}
          empty={
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="mb-4 rounded-full bg-surface-2 p-6 ring-8 ring-surface-2/50">
                <Search className="h-8 w-8 text-muted" />
              </div>
              <h3 className="text-lg font-bold text-ink">No requests found</h3>
              <p className="mt-2 text-sm text-muted">Nothing has been sent to you yet, or no matches found.</p>
            </div>
          }
          renderCard={(r) => (
            <div className="space-y-2 p-1">
              <div className="flex items-start justify-between gap-3">
                <span className="font-mono text-sm font-bold text-ink">{r.rfq_no}</span>
                {r.has_pending_change_request || r.vendor_status === "CHANGE_PROPOSED" ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 border border-amber-500/30 px-3 py-1 text-xs font-bold text-amber-700 shadow-sm">
                    <span className="h-2 w-2 rounded-full bg-amber-500 animate-ping" />
                    Change Proposed (Action Required)
                  </span>
                ) : r.vendor_status === "SUBMITTED" || r.vendor_status === "REVISED" ? (
                  <StatusPill status="SUBMITTED" label="Quote submitted" />
                ) : (
                  <StatusPill status={r.status} label={vendorRfqLabel(r.status)} />
                )}
              </div>
              <div className="text-base font-medium text-body">{r.title && r.title.trim() !== "" && r.title !== "Untitled" ? r.title : null}</div>
              <div className="flex items-center gap-3 text-xs text-muted">
                <span className="flex items-center gap-1 rounded-md bg-surface-2 px-2 py-1">
                  {r.total_items} item{r.total_items === 1 ? "" : "s"}
                </span>
                {r.due_date && (
                  <span className="flex items-center gap-1">
                    <span className="h-1 w-1 rounded-full bg-brand/40" />
                    Closes {fmtDate(r.due_date)}
                  </span>
                )}
              </div>
            </div>
          )}
        />
      </Card>
    </div>
  );
}
