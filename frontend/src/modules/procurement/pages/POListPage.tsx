import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import {
  Button, Can, Card, ErrorBanner, FilterBar, FilterDateRange, FilterMenu, PageHeader,
  ResponsiveList, StatusPill, type Column,
} from "@/shared/components";
import { poApi } from "../api";
import type { POListRow } from "../types";
import { fmtDate } from "@/shared/datetime";
import { formatPONo } from "@/shared/format";
import { useDebouncedValue } from "@/shared/hooks/useDebouncedValue";
import { POKpis } from "../components/ProcurementKpis";
import { useUrlFilters } from "../urlFilters";

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

/** Every filter this screen owns, so Clear knows what to drop. */
const FILTER_KEYS = ["search", "status", "vendor", "date_from", "date_to",
                     "pending_for_me"];

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

  // Filters live in the URL, not in component state (see `../urlFilters`): the KPI
  // strip above applies them, the Overview links straight into them, and a filtered
  // register is a link somebody can paste to a colleague.
  const { get, getBool, set, clear, page, setPage, activeCount } = useUrlFilters();
  const search = get("search");
  const status = get("status");
  const vendor = get("vendor");
  const dateFrom = get("date_from");
  const dateTo = get("date_to");
  const pendingForMe = getBool("pending_for_me");

  // The shared hook, not a hand-rolled setTimeout inside useMemo — that one never
  // cleared its timer (useMemo discards a returned function), so every keystroke left
  // a live timeout behind.
  const debouncedSearch = useDebouncedValue(search);

  // Combine filters for API
  const queryParams = {
    search: debouncedSearch || undefined,
    status: status || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    pending_for_me: pendingForMe || undefined,
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

      {/* The KPI strip: pressing a tile applies the filter it counts and pressing it
          again clears it. Gated on `po.view` inside the component, the same code this
          screen's endpoint checks — revoke it and the strip, its request and its
          numbers all go together. */}
      <div className="mb-4">
        <POKpis />
      </div>

      {/* One pill row, the shape the Indents filter bar uses. It was a bordered panel
        * of raw <input>s with hardcoded neutral-* colours — off the design tokens, so
        * it did not follow the theme, and it took a third of the screen above the
        * table. Vendor is filtered in the browser over the page in hand; the endpoint
        * takes no vendor parameter and at 20 rows a page it does not need one. */}
      <FilterBar
        search={search}
        onSearch={(value) => set({ search: value })}
        searchPlaceholder="Search PO, RFQ, or Quotation no…"
        active={activeCount(FILTER_KEYS)}
        onClear={() => clear(FILTER_KEYS)}
      >
        <FilterMenu
          label="Status"
          value={status}
          onChange={(value) => set({ status: value })}
          options={STATUSES.filter((o) => o.value)}
        />
        <FilterMenu label="Vendor" value={vendor}
                    onChange={(value) => set({ vendor: value })}
                    options={vendorOptions} />
        {/* The shared date pair, so it sits level with the pills and carries its own
            clear. It was two bare browser date boxes in a box of their own. */}
        <FilterDateRange
          label="Ordered"
          from={dateFrom}
          to={dateTo}
          onFrom={(value) => set({ date_from: value })}
          onTo={(value) => set({ date_to: value })}
        />
      </FilterBar>

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
            pendingForMe
              ? "Nothing is waiting for your signature."
              : status || vendor || search
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
