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
import type { VendorPOListRow } from "@/modules/procurement/types";
import { useDebouncedValue } from "@/shared/hooks/useDebouncedValue";
import { formatPONo } from "@/shared/format";
import { VENDOR_PO_STATUS_OPTIONS, vendorPoLabel } from "../status";

const SIZE = 20;

const money = (value: number | null | undefined) => new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(value ?? 0);

/**
 * The orders this vendor has been sent.
 *
 * Filtered server-side to their own, and only to orders that have actually been sent
 * to them — a draft or an unapproved PO is not a commitment and the vendor must never
 * see one. There is no "all orders" to fall back to.
 *
 * Completed orders are IN the list (RECEIVED / CLOSED / CANCELLED). They used to drop
 * off it the moment the last GRN landed, which left a supplier unable to look up work
 * they had already delivered. The status filter is how they separate the two, and it
 * only ever narrows what the server already decided they may see.
 */
export function SupplierPOListPage() {
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
    queryKey: ["supplier-pos", debouncedSearch, status, page],
    queryFn: () => supplierApi.pos({
      search: debouncedSearch || undefined,
      status: status || undefined,
      page, size: SIZE,
    }),
  });

  const columns: Column<VendorPOListRow>[] = [
    {
      key: "po",
      header: "Order",
      render: (r) => (
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-ink">{formatPONo(r.po_no, r.revision_no)}</div>
          <div className="text-[11px] text-muted">{fmtDate(r.po_date)}</div>
        </div>
      ),
    },
    {
      key: "expected",
      header: "Wanted by",
      hideOnNarrow: true,
      render: (r) => (r.expected_date ? fmtDate(r.expected_date) : "—"),
    },
    {
      key: "value",
      header: "Value",
      render: (r) => <span className="tabular">₹ {money(r.total_amount)}</span>,
    },
    {
      key: "despatch",
      header: "Despatch notes",
      render: (r) => (r.despatch_note_count
        ? <span className="text-body">{r.despatch_note_count} filed</span>
        : <span className="text-muted">None yet</span>),
    },
    {
      key: "status", header: "",
      render: (r) => <StatusPill status={r.status} label={vendorPoLabel(r.status)} />,
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Supplier portal"
        title="Purchase orders"
      />
      <p className="mb-4 text-sm text-muted">
        Tell us what you are sending before the vehicle leaves.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search order, RFQ or quotation no..."
            className="pl-9"
          />
        </div>
        <FilterMenu
          label="Status"
          value={status}
          onChange={setStatus}
          options={VENDOR_PO_STATUS_OPTIONS}
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
          loading={isLoading}
          keyOf={(r) => r.id}
          columns={columns}
          onRowClick={(r) => nav(`/supplier/pos/${r.id}`)}
          empty={search || status ? "No orders match this search." : "No orders have been sent to you yet."}
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-sm font-semibold text-ink">{formatPONo(r.po_no, r.revision_no)}</span>
                <StatusPill status={r.status} label={vendorPoLabel(r.status)} />
              </div>
              <div className="text-xs text-muted">
                {fmtDate(r.po_date)} · ₹ {money(r.total_amount)}
              </div>
              <div className="text-xs text-muted">
                {r.despatch_note_count
                  ? `${r.despatch_note_count} despatch note(s) filed`
                  : "No despatch note yet"}
              </div>
            </div>
          )}
        />
      </Card>
      {data && data.total > SIZE && (
        <div className="mt-3 flex items-center justify-between text-sm">
          <button
            className="min-h-11 px-3 text-muted disabled:opacity-40"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </button>
          <span className="text-muted">
            Page {page} of {Math.ceil(data.total / SIZE)}
          </span>
          <button
            className="min-h-11 px-3 text-muted disabled:opacity-40"
            disabled={page >= Math.ceil(data.total / SIZE)}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
    </>
  );
}
