import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card, EmptyState, ErrorBanner, Input, PageHeader, ResponsiveList, StatusPill,
  type Column,
} from "@/shared/components";
import { returnsApi } from "../api";
import { ReturnsNav } from "../components/ReturnsNav";
import { money } from "../constants";
import type { PurchaseReturn } from "../types";

const qty = (value: string | number) => Number(value ?? 0).toLocaleString();

/**
 * The other family of return — stock going back to the vendor who supplied it.
 *
 * Read only, and deliberately so. `pro_returns` is the warehouse module's table: it is
 * written when QC rejects a GRN line, and acting on one — editing the draft, recording
 * what the vendor said, matching the credit note — belongs to that module's endpoints.
 * This screen exists because the register has to show both families in one place, and
 * because a purchase return is invisible today: nothing in the app lists them at all.
 *
 * Unlike a field return this one IS costed — the rate came off the GRN line — so the
 * value column is a real number rather than an em dash.
 */
export default function PurchaseReturnsPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["returns", "purchase", { page, search }],
    queryFn: () => returnsApi.purchaseReturns({ page, size: 20, search }),
  });

  const rows = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.size || 20)));

  const columns: Column<PurchaseReturn>[] = [
    {
      key: "return_no",
      header: "Return",
      render: (row) => (
        <div>
          <div className="font-semibold text-ink">{row.return_no}</div>
          <div className="text-xs text-muted">
            {row.return_date ? new Date(row.return_date).toLocaleDateString() : "—"}
          </div>
        </div>
      ),
    },
    {
      key: "vendor",
      header: "Vendor",
      render: (row) => (
        <div className="text-sm">
          <div className="text-ink">{row.vendor_name ?? "—"}</div>
          <div className="text-xs text-muted">{row.warehouse_name ?? ""}</div>
        </div>
      ),
    },
    {
      key: "refs",
      header: "Against",
      hideOnNarrow: true,
      render: (row) => (
        <div className="text-sm">
          <div className="text-ink">{row.po_no ?? "—"}</div>
          <div className="text-xs text-muted">{row.grn_no ? `GRN ${row.grn_no}` : ""}</div>
        </div>
      ),
    },
    {
      key: "qty",
      header: "Quantity",
      render: (row) => (
        <div className="text-sm">
          <div className="text-ink">{qty(row.total_qty)}</div>
          <div className="text-xs text-muted">
            {row.total_items} {row.total_items === 1 ? "item" : "items"}
          </div>
        </div>
      ),
    },
    {
      key: "value",
      header: "Value",
      render: (row) => <span className="text-sm text-body">{money(row.total_value)}</span>,
    },
    {
      key: "status",
      header: "Status",
      render: (row) => (
        <div className="space-y-1">
          <StatusPill status={row.status} />
          {row.credit_note_no && (
            <div className="text-xs text-muted">note {row.credit_note_no}</div>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <ReturnsNav />

      <PageHeader eyebrow="RETURN" title="Purchase returns" />

      <Card className="mb-4 p-3">
        <Input
          placeholder="Search by return no., vendor, PO or GRN…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          aria-label="Search purchase returns"
        />
        <p className="mt-2 text-xs text-muted">
          Raised in the warehouse when QC rejects a receipt line. Listed here, worked
          there — the vendor conversation and the credit note are Purchase's and Accounts'.
        </p>
      </Card>

      {error && <ErrorBanner error="Purchase returns could not be loaded." />}

      <ResponsiveList
        data={rows}
        columns={columns}
        keyOf={(row) => row.id}
        loading={isLoading}
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        empty={
          <EmptyState
            title="No purchase returns yet"
            hint="One is raised when a QC inspection rejects a line on a goods receipt."
          />
        }
        renderCard={(row) => (
          <div className="p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-ink">{row.return_no}</span>
              <StatusPill status={row.status} />
            </div>
            <div className="mt-1 text-sm text-body">{row.vendor_name ?? "—"}</div>
            <div className="mt-1 text-xs text-muted">
              {row.po_no ? `${row.po_no} · ` : ""}
              {qty(row.total_qty)} across {row.total_items}{" "}
              {row.total_items === 1 ? "item" : "items"} · {money(row.total_value)}
            </div>
          </div>
        )}
      />
    </div>
  );
}
