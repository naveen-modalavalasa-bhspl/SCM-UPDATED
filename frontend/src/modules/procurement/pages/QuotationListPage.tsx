import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import {
  Card, ErrorBanner, FilterMenu, PageHeader, ResponsiveList, StatusPill, Input,
  type Column,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { rfqApi } from "../api";
import { money } from "./RequisitionListPage";
import type { QuoteListRow } from "../types";
import { useDebouncedValue } from "@/shared/hooks/useDebouncedValue";

const SIZE = 20;

/**
 * Every quotation across every RFQ.
 *
 * Behind `rfq.compare` rather than `rfq.view`: this is the one screen that shows
 * what every vendor charges, side by side, with no RFQ to scope it.
 */
export function QuotationListPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState("");
  // Filtered in the BROWSER, not on the server: this list is capped at 20 rows a page
  // and the endpoint takes no status or vendor parameter, so adding one would be a
  // backend change for a screen that already has the page in hand. Vendor options are
  // built from the rows themselves — a vendor who has never quoted is not a filter.
  const [status, setStatus] = useState("");
  const [vendor, setVendor] = useState("");
  // Debounce the search input to avoid spamming the API on every keystroke
  const debouncedSearch = useDebouncedValue(search);
  const [page, setPage] = useState(1);

  // Automatically reset to the first page whenever the search query changes
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["quotations", debouncedSearch, page],
    queryFn: () => rfqApi.quotations({ search: debouncedSearch || undefined, page, size: SIZE }),
  });

  const all = data?.items ?? [];
  const vendorOptions = [...new Map(all
    .filter((r) => r.vendor_name)
    .map((r) => [String(r.vendor_id), r.vendor_name!])).entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const statusOptions = [...new Set(all.map((r) => r.status).filter(Boolean))]
    .map((v) => ({ value: v as string, label: (v as string).replace(/_/g, " ") }));
  const rows = all.filter((r) =>
    (!status || r.status === status)
    && (!vendor || String(r.vendor_id) === vendor));
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / SIZE));

  const columns: Column<QuoteListRow>[] = [
    {
      key: "quote",
      header: "Quotation",
      render: (r) => (
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-ink">{r.quotation_no}</div>
          <div className="text-[11px] text-muted">against {r.rfq_no ?? `RFQ ${r.rfq_id}`}</div>
        </div>
      ),
    },
    { key: "vendor", header: "Vendor", render: (r) => r.vendor_name ?? `Vendor ${r.vendor_id}` },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    {
      key: "total",
      header: "Grand total",
      className: "text-right",
      render: (r) => <span className="font-semibold text-ink">{money(r.grand_total)}</span>,
    },
    {
      key: "rank",
      header: "Rank",
      className: "text-right",
      hideOnNarrow: true,
      render: (r) => r.rank_position ?? "—",
    },
    {
      key: "submitted",
      header: "Submitted",
      hideOnNarrow: true,
      render: (r) => (r.submitted_at ? fmtDate(r.submitted_at) : "Not yet"),
    },
  ];

  return (
    <div>
      <PageHeader eyebrow="Procurement" title="Quotations" />

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-line/70 bg-content1 p-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search quotation, vendor or RFQ no..."
            className="pl-9"
          />
        </div>
        <FilterMenu label="Status" value={status} onChange={setStatus} options={statusOptions} />
        <FilterMenu label="Vendor" value={vendor} onChange={setVendor} options={vendorOptions} />
        {(search || status || vendor) && (
          <button
            onClick={() => { setSearch(""); setStatus(""); setVendor(""); }}
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
          onRowClick={(r) => nav(`/procurement/rfqs/${r.rfq_id}`)}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          empty={status || vendor || search ? "No quotations match these filters." : "No quotations yet. They arrive once an RFQ is published."}
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-ink">{r.quotation_no}</span>
                <StatusPill status={r.status} />
              </div>
              <div className="text-sm text-body">{r.vendor_name ?? "—"}</div>
              <div className="text-xs text-muted">
                {r.rfq_no ?? `RFQ ${r.rfq_id}`} · {money(r.grand_total)}
              </div>
            </div>
          )}
        />
      </Card>
    </div>
  );
}
