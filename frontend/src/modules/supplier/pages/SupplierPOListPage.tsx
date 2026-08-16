import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Card, ErrorBanner, PageHeader, ResponsiveList, StatusPill, type Column,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { supplierApi } from "@/modules/procurement/api";
import type { VendorPOListRow } from "@/modules/procurement/types";

const SIZE = 20;

const money = (value: number) => new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(value);

/**
 * The orders this vendor has been sent.
 *
 * Filtered server-side to their own, and only to orders that have actually been
 * despatched to them — a draft or an unapproved PO is not a commitment and the vendor
 * must never see one. There is no "all orders" to fall back to.
 */
export function SupplierPOListPage() {
  const nav = useNavigate();
  const [page, setPage] = useState(1);

  const { data, isLoading, error } = useQuery({
    queryKey: ["supplier-pos", page],
    queryFn: () => supplierApi.pos({ page, size: SIZE }),
  });

  const columns: Column<VendorPOListRow>[] = [
    {
      key: "po",
      header: "Order",
      render: (r) => (
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-ink">{r.po_no}</div>
          <div className="text-xs text-muted">{fmtDate(r.po_date)}</div>
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
    { key: "status", header: "", render: (r) => <StatusPill status={r.status} /> },
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
      <ErrorBanner error={error} />
      <Card className="p-2">
        <ResponsiveList
          data={data?.items ?? []}
          loading={isLoading}
          keyOf={(r) => r.id}
          columns={columns}
          onRowClick={(r) => nav(`/supplier/pos/${r.id}`)}
          empty="No orders have been sent to you yet."
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-sm font-semibold text-ink">{r.po_no}</span>
                <StatusPill status={r.status} />
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
