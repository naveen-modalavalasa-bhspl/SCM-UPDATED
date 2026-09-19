import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import {
  Card, ErrorBanner, PageHeader, ResponsiveList, StatusPill, Input,
  type Column,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { supplierApi } from "@/modules/procurement/api";
import type { VendorReturnListRow } from "@/modules/procurement/types";
import { useDebouncedValue } from "@/shared/hooks/useDebouncedValue";
import { vendorReturnLabel } from "../status";

const SIZE = 20;

const money = (value: number | null | undefined) => new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(value ?? 0);

/**
 * Goods we have sent BACK to this supplier.
 *
 * A TAB OF ITS OWN, beside Orders (2026-09-11). It used to be a section under the
 * orders list, hidden when there were none — which meant a supplier who had a return
 * had to scroll past their whole order board to find it, and one who was told on the
 * phone that material was coming back had nowhere to go and look. A return is its own
 * document with its own number, its own reason and its own consignment; it now has its
 * own door.
 *
 * Filtered server-side to this vendor's own returns and only to ones actually SENT to
 * them (`_VENDOR_VISIBLE_RETURN_STATUSES`) — a draft or a return still in our own
 * approval is internal and the supplier is not a party to it.
 *
 * NO status filter, deliberately. Two of the three statuses a supplier may see
 * (SENT_TO_VENDOR and DISPATCHED) read as the same word to them — "Draft", a return
 * they have not answered yet — so a dropdown offering that word twice would be asking
 * the reader to pick between our internal bookkeeping states. The search box covers the
 * numbers they actually hold: the return no, the order it is against, the GRN.
 */
export function SupplierReturnListPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["supplier-returns", debouncedSearch, page],
    queryFn: () => supplierApi.returns({
      search: debouncedSearch || undefined,
      page, size: SIZE,
    }),
  });
  const rows = data?.items ?? [];

  /* Deliberately NOT the same five columns as the orders board.
     The two documents answer different questions — an order asks "what do we owe you
     and have you sent it", a return asks "what is coming back, why, and how is it
     arriving" — and giving them matching grids would invite the reader to compare
     columns that do not mean the same thing. Value is present on both because it is
     the one figure that does. */
  const columns: Column<VendorReturnListRow>[] = [
    {
      key: "return",
      header: "Return",
      render: (r) => (
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-ink">{r.return_no}</div>
          <div className="text-[11px] text-muted">
            {[fmtDate(r.return_date), r.po_no ? `against ${r.po_no}` : r.grn_no ? `against ${r.grn_no}` : null]
              .filter(Boolean).join(" · ")}
          </div>
        </div>
      ),
    },
    {
      key: "reason",
      header: "Reason",
      hideOnNarrow: true,
      render: (r) => r.reason_label || "—",
    },
    {
      key: "qty",
      header: "Quantity",
      render: (r) => (
        <span className="tabular">
          {r.total_qty}
          <span className="ml-1 text-[11px] text-muted">
            in {r.total_items} line{r.total_items === 1 ? "" : "s"}
          </span>
        </span>
      ),
    },
    {
      key: "value",
      header: "Value",
      render: (r) => <span className="tabular">₹ {money(r.total_value)}</span>,
    },
    {
      key: "arriving",
      header: "Arriving",
      hideOnNarrow: true,
      // A manual return raises no consignment, so every logistics field is null. That
      // is not "not despatched yet" — the goods are genuinely on their way and this
      // system simply never held the paperwork, so it must not read as a gap.
      render: (r) => (r.transport_mode_label ? (
        <div className="min-w-0">
          <div className="text-body">{r.transport_mode_label}</div>
          <div className="text-[11px] text-muted">
            {[r.carrier_name ?? r.vehicle_number ?? r.driver_name,
              r.lr_no ? `LR ${r.lr_no}` : null,
              r.expected_delivery ? `by ${fmtDate(r.expected_delivery)}` : null]
              .filter(Boolean).join(" · ") || "—"}
          </div>
        </div>
      ) : <span className="text-muted">Being arranged</span>),
    },
    {
      key: "status", header: "",
      render: (r) => <StatusPill status={r.status}
                                 label={vendorReturnLabel(r.status, r.vendor_response_label)} />,
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Supplier portal"
        title="Goods returned to you"
      />
      <p className="mb-4 text-sm text-muted">
        Material we have sent back, and how each consignment is travelling.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search return, order or GRN no..."
            className="pl-9"
          />
        </div>
        {search && (
          <button
            onClick={() => setSearch("")}
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
          loading={isLoading}
          keyOf={(r) => r.id}
          columns={columns}
          onRowClick={(r) => nav(`/supplier/returns/${r.id}`)}
          empty={search ? "No returns match this search." : "Nothing has been returned to you."}
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-sm font-semibold text-ink">
                  {r.return_no}
                </span>
                <StatusPill status={r.status}
                            label={vendorReturnLabel(r.status, r.vendor_response_label)} />
              </div>
              <div className="text-xs text-muted">
                {[fmtDate(r.return_date),
                  r.po_no ? `against ${r.po_no}` : r.grn_no ? `against ${r.grn_no}` : null,
                  r.reason_label].filter(Boolean).join(" · ")}
              </div>
              <div className="text-xs text-muted">
                {r.total_qty} in {r.total_items} line{r.total_items === 1 ? "" : "s"}
                {" · ₹ "}{money(r.total_value)}
              </div>
              <div className="text-xs text-muted">
                {r.transport_mode_label
                  ? [r.transport_mode_label,
                     r.carrier_name ?? r.vehicle_number ?? r.driver_name,
                     r.expected_delivery ? `by ${fmtDate(r.expected_delivery)}` : null]
                    .filter(Boolean).join(" · ")
                  : "Transport being arranged"}
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
