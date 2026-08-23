import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Card, ErrorBanner, FilterBar, FilterMenu, PageHeader, ResponsiveList, StatusPill,
  type Column,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { rfqApi } from "../api";
import { money } from "./RequisitionListPage";
import type { QuoteListRow } from "../types";
import { useDebouncedValue } from "@/shared/hooks/useDebouncedValue";
import { QuotationKpis } from "../components/ProcurementKpis";
import { useUrlFilters } from "../urlFilters";

const SIZE = 20;

/** Every filter this screen owns, so Clear knows what to drop. */
const FILTER_KEYS = ["status", "search", "vendor"];

/**
 * Every quotation across every RFQ.
 *
 * Behind `rfq.compare` rather than `rfq.view`: this is the one screen that shows
 * what every vendor charges, side by side, with no RFQ to scope it.
 */
export function QuotationListPage() {
  const nav = useNavigate();
  // Filters live in the URL — see `../urlFilters`. The KPI strip above sets them.
  const { get, set, clear, page, setPage, activeCount } = useUrlFilters();
  const search = get("search");
  // Status is a SERVER filter now (2026-08-23): a KPI tile counts every row in a
  // bucket, and filtering in the browser would only have narrowed the twenty rows in
  // hand — so the tile said 41 and the list showed 6. Vendor stays in the browser:
  // its options are built from the rows themselves, and a vendor who has never quoted
  // is not a filter worth offering.
  const status = get("status");
  const vendor = get("vendor");
  // Debounce the search input to avoid spamming the API on every keystroke
  const debouncedSearch = useDebouncedValue(search);

  const { data, isLoading, error } = useQuery({
    queryKey: ["quotations", debouncedSearch, status, page],
    queryFn: () => rfqApi.quotations({
      search: debouncedSearch || undefined,
      status: status || undefined,
      page, size: SIZE,
    }),
  });

  const all = data?.items ?? [];
  const vendorOptions = [...new Map(all
    .filter((r) => r.vendor_name)
    .map((r) => [String(r.vendor_id), r.vendor_name!])).entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const statusOptions = [...new Set(all.map((r) => r.status).filter(Boolean))]
    .map((v) => ({ value: v as string, label: (v as string).replace(/_/g, " ") }));
  const rows = all.filter((r) => !vendor || String(r.vendor_id) === vendor);
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

      {/* The KPI strip. Gated inside the component on `rfq.compare` — the same code
          this screen's endpoint checks, because these numbers are vendor PRICES. */}
      <div className="mb-4">
        <QuotationKpis />
      </div>

      {/* Shared filter strip — see RequisitionListPage for why the local copies went. */}
      <FilterBar
        search={search}
        onSearch={(value) => set({ search: value })}
        searchPlaceholder="Search quotation, vendor or RFQ no…"
        active={activeCount(FILTER_KEYS)}
        onClear={() => clear(FILTER_KEYS)}
      >
        <FilterMenu label="Status" value={status}
                    onChange={(value) => set({ status: value })} options={statusOptions} />
        <FilterMenu label="Vendor" value={vendor}
                    onChange={(value) => set({ vendor: value })} options={vendorOptions} />
      </FilterBar>

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
