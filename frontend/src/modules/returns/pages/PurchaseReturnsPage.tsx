import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, ResponsiveList,
  Select, StatusPill, type Column,
} from "@/shared/components";
import { returnsApi } from "../api";
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
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  // Where the material came from, which is the question the buying desk actually asks
  // about a purchase return — our own upper-tier stock going back, a branch pushing
  // material up the chain, or something that failed on the inspection bench.
  const [source, setSource] = useState("");

  const { data: sources } = useQuery({
    queryKey: ["returns", "purchase", "sources"],
    queryFn: () => returnsApi.purchaseReturnSources(),
    staleTime: Infinity,
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ["returns", "purchase", { page, search, source }],
    queryFn: () => returnsApi.purchaseReturns({ page, size: 20, search, source }),
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
      key: "source",
      header: "Source",
      hideOnNarrow: true,
      render: (row) => (
        <div className="text-sm">
          {/* Null on every row raised before 2026-09-08 and on ones raised by hand at
            * the warehouse. Rendered as an honest gap, never as a fourth category. */}
          <div className="text-ink">{row.source_category_label ?? "Not stated"}</div>
          {row.source_return_no && (
            <div className="text-xs text-muted">from {row.source_return_no}</div>
          )}
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
      <PageHeader
        eyebrow="RETURN"
        title="Purchase returns"
        actions={
          <Button onClick={() => navigate("/warehouse/purchase-returns/new")}>New Purchase Return</Button>
        }
      />

      <Card className="mb-4 p-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[2fr_1fr]">
          <Input
            placeholder="Search by return no., vendor, PO or GRN…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            aria-label="Search purchase returns"
          />
          <Field label="Source">
            <Select
              value={source}
              onChange={(value) => {
                setSource(value);
                setPage(1);
              }}
              options={[
                { value: "", label: "Any source" },
                ...(sources ?? []).map((option) => ({
                  value: option.value,
                  label: option.label,
                })),
              ]}
              ariaLabel="Filter by source"
            />
          </Field>
        </div>
        <p className="mt-2 text-xs text-muted">
          Warehouse → Vendor flow: pick a purchase transaction, vendor & item details auto-fetch, enter quantity, pick
          reason and press <span className="font-semibold">Send to Vendor</span>. Existing Logistics carries it — no new
          master, no duplicate logistics.
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
            <div className="mt-1 text-xs text-muted">
              {row.source_category_label ?? "Source not stated"}
              {row.source_return_no ? ` · from ${row.source_return_no}` : ""}
            </div>
          </div>
        )}
      />
    </div>
  );
}
