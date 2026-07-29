import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftRight, ClipboardCheck, IndianRupee, PackageCheck, PackageOpen, Send, Truck, Undo2,
} from "lucide-react";
import { Card, PageHeader, ResponsiveList, StatCard, StatusPill, type Column } from "@/shared/components";
import { ErrorBanner } from "../components/Feedback";
import { FilterBar, FilterSelect } from "../components/FilterBar";
import { getDashboard, warehouseOptions } from "../api";
import { fmtDate, fmtMoneyShort, normaliseStatus } from "../format";
import type { WarehouseDashboard as Dash } from "../types";

/**
 * The warehouse landing screen: what is waiting for someone, right now.
 *
 * Every tile is a queue depth rather than a vanity total, and every tile links to
 * the list that clears it — the point of the screen is to get a storekeeper into the
 * right queue in one click, not to be read.
 *
 * The counts come from one `/dashboard` call. The version this replaced fired eight
 * list requests and counted the rows client-side, which meant the numbers were the
 * first page of each list, not the queue.
 */

interface Tile {
  key: keyof Dash;
  label: string;
  to: string;
  icon: typeof PackageOpen;
  tone?: string;
}

const TILES: Tile[] = [
  { key: "pending_gate_entries", label: "At the gate", to: "transactions/material-inward", icon: PackageOpen },
  { key: "pending_grn", label: "GRN to raise", to: "transactions/grn", icon: PackageCheck },
  { key: "pending_inspections", label: "Awaiting QC", to: "transactions/quality-inspection", icon: ClipboardCheck, tone: "text-warn" },
  { key: "pending_putaways", label: "To put away", to: "transactions/putaway", icon: ArrowLeftRight },
  { key: "open_picklists", label: "Open picklists", to: "transactions/picklist", icon: ClipboardCheck },
  { key: "pending_issues", label: "Issues pending", to: "transactions/material-issues", icon: Send },
  { key: "in_transit_dispatches", label: "In transit", to: "transactions/dispatch", icon: Truck },
  { key: "open_returns", label: "Open returns", to: "transactions/purchase-returns", icon: Undo2, tone: "text-bad" },
];

const DOC_ROUTE: Record<string, string> = {
  RECEIPT: "transactions/grn",
  GATE_ENTRY: "transactions/material-inward",
  INSPECTION: "transactions/quality-inspection",
  PUTAWAY: "transactions/putaway",
  PICKING: "transactions/picklist",
  ISSUE: "transactions/material-issues",
  DISPATCH: "transactions/dispatch",
  RETURN: "transactions/purchase-returns",
};

export default function WarehouseDashboard() {
  const [warehouse, setWarehouse] = useState("");

  const { data: houses = [] } = useQuery({
    queryKey: ["wh-lookup", "warehouses", ""],
    queryFn: () => warehouseOptions(),
    staleTime: 5 * 60_000,
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ["wh-dashboard", warehouse],
    queryFn: () => getDashboard(warehouse ? Number(warehouse) : undefined),
  });

  type Recent = Dash["recent"][number];

  const columns: Column<Recent>[] = [
    {
      key: "doc",
      header: "Document",
      render: (r) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{r.doc_no}</div>
          <div className="text-[11px] text-muted">{r.doc_type.replace(/_/g, " ").toLowerCase()}</div>
        </div>
      ),
    },
    { key: "status", header: "Status", render: (r) => <StatusPill status={normaliseStatus(r.status)} /> },
    {
      key: "created_at",
      header: "Raised",
      hideOnNarrow: true,
      render: (r) => <span className="text-sm text-muted">{fmtDate(r.created_at)}</span>,
    },
    {
      key: "open",
      header: "",
      className: "text-right",
      render: (r) => (
        <Link
          to={`${DOC_ROUTE[r.doc_type] ?? "transactions"}/${r.id}`}
          className="text-sm font-semibold text-brand hover:underline"
        >
          Open
        </Link>
      ),
    },
  ];

  return (
    <div>
      <PageHeader eyebrow="Warehouse" title="Overview" />

      <FilterBar>
        <FilterSelect
          label="Warehouse"
          allLabel="All warehouses"
          value={warehouse}
          onChange={setWarehouse}
          options={houses.map((w) => ({ value: w.id, label: w.code ? `${w.code} — ${w.name}` : w.name }))}
          className="min-w-[240px]"
        />
      </FilterBar>

      <ErrorBanner error={error} />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {TILES.map((t) => (
          <Link key={t.key} to={t.to} className="block focus-visible:outline-none">
            <StatCard
              label={t.label}
              value={isLoading ? "—" : Number(data?.[t.key] ?? 0)}
              icon={<t.icon className="h-4 w-4" />}
              tone={t.tone}
            />
          </Link>
        ))}
      </div>

      <div className="mb-5 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <StatCard
          label="Stock value on hand"
          value={isLoading ? "—" : `₹ ${fmtMoneyShort(data?.stock_value)}`}
          icon={<IndianRupee className="h-4 w-4" />}
        />
        <StatCard
          label="Bin utilisation"
          value={isLoading ? "—" : `${Math.round(data?.bin_utilisation_percent ?? 0)}%`}
          icon={<PackageOpen className="h-4 w-4" />}
          tone={(data?.bin_utilisation_percent ?? 0) >= 90 ? "text-bad" : undefined}
        />
      </div>

      <Card className="p-4 sm:p-5">
        <h2 className="mb-4 font-display text-base font-bold text-ink">Latest activity</h2>
        <ResponsiveList
          data={data?.recent ?? []}
          columns={columns}
          keyOf={(r) => `${r.doc_type}-${r.id}`}
          loading={isLoading}
          empty="Nothing has moved through this warehouse yet."
          renderCard={(r) => (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-mono text-xs font-semibold text-ink">{r.doc_no}</div>
                <div className="text-[11px] text-muted">
                  {r.doc_type.replace(/_/g, " ").toLowerCase()} · {fmtDate(r.created_at)}
                </div>
              </div>
              <StatusPill status={normaliseStatus(r.status)} />
            </div>
          )}
        />
      </Card>
    </div>
  );
}
