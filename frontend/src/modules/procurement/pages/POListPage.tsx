import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Download, Search, Filter } from "lucide-react";
import {
  Button, Can, Card, ErrorBanner, PageHeader, ResponsiveList, StatusPill, Select,
  type Column,
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

  const rows = data?.items ?? [];
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

      <div className="mb-6 rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-700">
          <Filter size={16} /> Filters
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
          <div className="md:col-span-5">
            <label className="mb-1 block text-xs font-medium text-neutral-600">Search</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={16} />
              <input
                type="text"
                placeholder="Search PO, RFQ, or Quotation no..."
                className="w-full rounded-md border border-neutral-300 py-1.5 pl-9 pr-3 text-sm placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              />
            </div>
          </div>
          <div className="md:col-span-3">
            <label className="mb-1 block text-xs font-medium text-neutral-600">Status</label>
            <Select
              value={status}
              options={STATUSES}
              onChange={(value) => { setStatus(String(value)); setPage(1); }}
            />
          </div>
          <div className="md:col-span-4">
            <label className="mb-1.5 block text-xs font-semibold text-neutral-600 uppercase tracking-wider">Date Range</label>
            <div className="flex w-full items-center gap-2">
              <input 
                type="date" 
                className="w-full rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm text-neutral-700 shadow-sm outline-none transition-all focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                value={dateFrom}
                onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
              />
              <span className="text-xs font-medium text-neutral-400">to</span>
              <input 
                type="date" 
                className="w-full rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm text-neutral-700 shadow-sm outline-none transition-all focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                value={dateTo}
                onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
              />
            </div>
          </div>
        </div>
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
            status
              ? "No purchase orders in this status."
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
