import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftRight, ClipboardCheck, IndianRupee, PackageCheck, PackageOpen, Send, Truck,
} from "lucide-react";
import {
  Card, ContextStrip, ErrorBanner, KpiTiles, PageHeader, ResponsiveList, StatusPill,
  type Column, type ContextStatSpec, type KpiTileSpec, type Tone,
} from "@/shared/components";
import { FilterBar, FilterSelect } from "../components/FilterBar";
import { getDashboard, warehouseOptions } from "../api";
import { fmtDate, fmtMoneyShort, normaliseStatus } from "../format";
import type { WarehouseDashboard as Dash } from "../types";
import { usePointLabel } from "../usePointLabel";
import { useAuth } from "@/shared/auth/AuthContext";

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
  /** A shared KPI tone, not a raw text colour — the strip owns the palette. */
  tone?: Tone;
  /** The permission that opens the queue behind the tile. A tile whose list the
   *  user cannot open is a dead link and a number they were never meant to read —
   *  the data is already scoped, but scoping is about WHOSE rows, not WHICH queues. */
  can: string;
}

const TILES: Tile[] = [
  { key: "pending_gate_entries", label: "At the gate", to: "transactions/material-inward", icon: PackageOpen, can: "receipt.view" },
  { key: "pending_grn", label: "GRN to raise", to: "transactions/grn", icon: PackageCheck, can: "receipt.view" },
  { key: "pending_inspections", label: "Awaiting QC", to: "transactions/quality-inspection", icon: ClipboardCheck, tone: "warn", can: "inspection.view" },
  { key: "pending_putaways", label: "To put away", to: "transactions/putaway", icon: ArrowLeftRight, can: "putaway.view" },
  { key: "open_picklists", label: "Open fulfilments", to: "transactions/fulfilment", icon: ClipboardCheck, can: "picking.view" },
  { key: "pending_issues", label: "Issues pending", to: "transactions/material-issues", icon: Send, can: "issue.view" },
  { key: "in_transit_dispatches", label: "In transit", to: "transactions/dispatch", icon: Truck, can: "dispatch.view" },
];

const DOC_ROUTE: Record<string, string> = {
  RECEIPT: "transactions/grn",
  GATE_ENTRY: "transactions/material-inward",
  INSPECTION: "transactions/quality-inspection",
  PUTAWAY: "transactions/putaway",
  PICKING: "transactions/fulfilment",
  ISSUE: "transactions/material-issues",
  DISPATCH: "transactions/dispatch",
};

export default function WarehouseDashboard() {
  const nav = useNavigate();
  const pointLabel = usePointLabel();
  const { can } = useAuth();
  // Only the queues this login can actually open. Scoping the numbers was half the
  // job: a store keeper with no QC grant still saw an "Awaiting QC" tile.
  const tiles = TILES.filter((t) => can(t.can));
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

  // Queue tiles: the number IS the button, and it opens the list that clears it.
  const kpiTiles: KpiTileSpec[] = tiles.map((tile) => ({
    key: String(tile.key),
    label: tile.label,
    icon: tile.icon,
    tone: tile.tone ?? "brand",
    // `undefined` while loading — the strip draws a skeleton. Passing 0 would render
    // a real zero and read as "nothing waiting", which is a different fact.
    value: isLoading ? undefined : Number(data?.[tile.key] ?? 0),
    onPress: () => nav(tile.to),
  }));

  // The quiet numbers underneath: read, not acted on.
  const contextStats: ContextStatSpec[] = [
    { key: "value", label: "Stock value on hand", icon: IndianRupee,
      value: isLoading ? "–" : `₹ ${fmtMoneyShort(data?.stock_value)}` },
    { key: "bins", label: "Bin utilisation", icon: PackageOpen,
      value: isLoading ? "–" : `${Math.round(data?.bin_utilisation_percent ?? 0)}%` },
  ];

  return (
    <div>
      <PageHeader eyebrow={pointLabel} title="Overview" />

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

      {/* The shared KPI strip (2026-08-23), the same one Indents, Approvals and
          Procurement lead with — one app, one shape for "here is a queue". Pressing a
          tile still opens the list that clears it; `undefined` while loading draws a
          skeleton rather than a "—" that reads like a real zero. */}
      <KpiTiles label="Warehouse queues" tiles={kpiTiles} className="mb-5" />

      {can("stock.view") && <ContextStrip stats={contextStats} className="mb-5" />}

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
