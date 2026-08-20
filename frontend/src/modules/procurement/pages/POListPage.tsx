import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Calendar, Download, Search } from "lucide-react";
import {
  Button, Can, Card, ErrorBanner, FilterMenu, Input, PageHeader, ResponsiveList,
  StatusPill, type Column,
} from "@/shared/components";
import { poApi } from "../api";
import type { POListRow } from "../types";
import { fmtDate } from "@/shared/datetime";
import { formatPONo } from "@/shared/format";

/** POStatus, as the backend enum spells it. */
const STATUSES = [
  { value: "", label: "All statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "PENDING_APPROVAL", label: "Pending approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "SENT_TO_VENDOR", label: "Sent to vendor" },
  { value: "ACCEPTED_BY_SUPPLIER", label: "Accepted by supplier" },
  { value: "PARTIALLY_RECEIVED", label: "Partially received" },
  { value: "RECEIVED", label: "Received" },
  { value: "REJECTED", label: "Rejected" },
  { value: "CANCELLED", label: "Cancelled" },
];

const money = (n?: number) =>
  `₹${Number(n ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const SIZE = 20;

/**
 * The purchase order list.
 *
 * Most orders are written by the chain — from an approved indent, or from the quotation
 * that won a tender — and those carry the rates the vendor actually offered. "New
 * purchase order" is the way in for the rest: a repeat buy on an agreed rate, an
 * emergency, a service already running. Those were being entered as fake indents.
 * The list reads, filters and opens; the detail screen owns every action after that.
 */
export function POListPage() {
  const nav = useNavigate();
  
  // Filter state
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [vendor, setVendor] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);

  // Debounced search text to prevent excessive API calls
  const [debouncedSearch, setDebouncedSearch] = useState("");
  
  // Update debounced search after 500ms
  useMemo(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 500);
    return () => clearTimeout(timer);
  }, [search]);

  // Combine filters for API
  const queryParams = {
    search: debouncedSearch || undefined,
    status: status || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    page,
    size: SIZE,
  };

  const { data, isLoading, error } = useQuery({
    queryKey: ["pos", queryParams],
    queryFn: () => poApi.list(queryParams),
  });

  const handleExport = () => {
    poApi.export({
      search: debouncedSearch || undefined,
      status: status || undefined,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
    });
  };

  const all = data?.items ?? [];
  // Built from the rows on screen: a vendor with no order on this page is not a filter
  // anybody can usefully pick.
  const vendorOptions = [...new Set(all.map((r) => r.vendor_name).filter(Boolean))]
    .map((v) => ({ value: v as string, label: v as string }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const rows = all.filter((r) => !vendor || r.vendor_name === vendor);
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / SIZE));

  const columns: Column<POListRow>[] = [
    {
      key: "po",
      header: "PO",
      render: (r) => (
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-ink">{formatPONo(r.po_no, r.revision_no)}</div>
          <div className="text-[11px] text-muted">
            {r.indent_no ? `from ${r.indent_no}` : "No indent"}
          </div>
        </div>
      ),
    },
    { key: "vendor", header: "Vendor", render: (r) => r.vendor_name ?? "—" },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    {
      key: "with",
      header: "Pending with",
      hideOnNarrow: true,
      // Live from the approval engine. `current_approver_name` behind it is the
      // snapshot the row used to carry, kept only as a fallback.
      render: (r) => (r.pending_with?.length
        ? r.pending_with.join(", ")
        : "—"),
    },

    {
      key: "value",
      header: "Value",
      className: "text-right",
      render: (r) => <span className="font-semibold text-ink">{money(r.total_amount)}</span>,
    },
    {
      key: "raised",
      header: "Raised",
      hideOnNarrow: true,
      render: (r) => (
        <span className="text-sm text-muted">
          {fmtDate(r.created_at)}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Procurement"
        title="Purchase Orders"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={handleExport} className="flex items-center gap-1.5">
              <Download size={16} /> Export
            </Button>
            <Can do="po.create">
              <Button onClick={() => nav("/pos/new")}>New purchase order</Button>
            </Can>
          </div>
        }
      />

      {/* One pill row, the shape the Indents filter bar uses. It was a bordered panel
        * of raw <input>s with hardcoded neutral-* colours — off the design tokens, so
        * it did not follow the theme, and it took a third of the screen above the
        * table. Vendor is filtered in the browser over the page in hand; the endpoint
        * takes no vendor parameter and at 20 rows a page it does not need one. */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-line/70 bg-content1 p-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search PO, RFQ, or Quotation no..."
            className="pl-9"
          />
        </div>
        <FilterMenu
          label="Status"
          value={status}
          onChange={(value) => { setStatus(value); setPage(1); }}
          options={STATUSES.filter((o) => o.value)}
        />
        <FilterMenu label="Vendor" value={vendor} onChange={setVendor}
                    options={vendorOptions} />
        <div className="flex items-center gap-1 rounded-lg border border-line bg-content1 px-2">
          <Calendar className="h-4 w-4 text-muted" />
          <input
            type="date"
            aria-label="Ordered from"
            value={dateFrom}
            onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
            className="h-11 bg-transparent text-sm text-ink outline-none"
          />
          <span className="text-xs text-muted">to</span>
          <input
            type="date"
            aria-label="Ordered to"
            value={dateTo}
            onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
            className="h-11 bg-transparent text-sm text-ink outline-none"
          />
        </div>
        {(search || status || vendor || dateFrom || dateTo) && (
          <button
            onClick={() => {
              setSearch(""); setStatus(""); setVendor("");
              setDateFrom(""); setDateTo(""); setPage(1);
            }}
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
          onRowClick={(r) => nav(`/pos/${r.id}`)}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          empty={
            status || vendor || search
              ? "No purchase orders match these filters."
              : "No purchase orders yet. Raise one here, or award a tender and create it from the winning quote."
          }
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-ink">{formatPONo(r.po_no, r.revision_no)}</span>
                <StatusPill status={r.status} />
              </div>
              <div className="text-sm text-body">{r.vendor_name ?? "—"}</div>
              <div className="text-xs text-muted">
                {r.indent_no ? `from ${r.indent_no} · ` : ""}{money(r.total_amount)}
              </div>
            </div>
          )}
        />
      </Card>
    </div>
  );
}
