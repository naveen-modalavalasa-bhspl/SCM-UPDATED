import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  CalendarClock,
  ClipboardList,
  History,
  Lock,
  IndianRupee,
  RefreshCw,
  Snowflake,
  ArrowLeftRight,
  Boxes,
  PackageX,
  TriangleAlert,
} from "lucide-react";
import { Chip, Skeleton } from "@heroui/react";
import {
  Button, Can, Card, ContextStrip, KpiTiles, PageHeader,
  type ContextStatSpec, type KpiTileSpec,
} from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import {
  getNearExpiryAlerts,
  getOverviewKPIs,
  getStockAgeing,
} from "../api";
import type { StockOverviewKPIs } from "../types";
import { fmtTime } from "@/shared/datetime";
import type { ReactNode } from "react";
import {
  AgeingChart,
  ChartLegend,
  StockSplitChart,
  CHART_COLORS,
  type AgeingBucket,
} from "../components/OverviewCharts";

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

const QUICK_ACTIONS = [
  { to: "/inventory/stock-balance", perm: "page.inv_balance.view", label: "Stock Balance",
    desc: "What is on the shelf", icon: ClipboardList },
  { to: "/inventory/ledger", perm: "page.inv_ledger.view", label: "Stock Ledger",
    desc: "Movements in and out", icon: History },
  { to: "/inventory/adjustments", perm: "stock.adjust", label: "Adjustments",
    desc: "Correct counts", icon: ArrowLeftRight },
  { to: "/inventory/replenishment", perm: "page.inv_replenishment.view", label: "Replenishment",
    desc: "Reorder levels", icon: RefreshCw },
] as const;

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
      {children}
    </div>
  );
}

export function InventoryOverviewPage() {
  const { can } = useAuth();
  const canViewValuation = can("stock.valuation.view");
  // A dashboard nobody has to reload: the numbers move whenever stock does, so the
  // page refetches on focus and on a slow tick rather than serving whatever was
  // cached when it first mounted.
  const { data: k, isLoading, isFetching, dataUpdatedAt, refetch } = useQuery<StockOverviewKPIs>({
    queryKey: ["stock-overview-kpis"],
    queryFn: getOverviewKPIs,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  });
  const { data: ageing, isLoading: ageingLoading } = useQuery({
    queryKey: ["stock-ageing", "overview"],
    queryFn: () => getStockAgeing(),
  });
  const { data: nearExpiry, isLoading: expiryLoading } = useQuery<
    { stock_id: number; item_name?: string | null; warehouse_name?: string | null;
      batch_no?: string | null; expiry_date: string; days_to_expiry: number; quantity: number }[]
  >({
    queryKey: ["near-expiry-alerts", "overview"],
    queryFn: () => getNearExpiryAlerts(90),
  });

  const buckets: AgeingBucket[] = [
    { label: "0–30 d", qty: ageing?.bucket_0_30_qty ?? 0 },
    { label: "31–60 d", qty: ageing?.bucket_31_60_qty ?? 0 },
    { label: "61–90 d", qty: ageing?.bucket_61_90_qty ?? 0 },
    { label: "90+ d", qty: ageing?.bucket_90_plus_qty ?? 0 },
  ];
  const expiryRows = (nearExpiry ?? []).slice(0, 6);

  const nav = useNavigate();

  /* --- the strip -----------------------------------------------------------
   * Two tiles only, because only two of these numbers are somebody's to ACT on:
   * an item under its reorder level, and stock about to expire. Both open the
   * list that clears them. Value and reserved/available are read-outs and sit in
   * the quiet strip underneath — a tile that cannot be pressed is a read-out
   * wearing a button's clothes.
   * ------------------------------------------------------------------------ */
  const kpiTiles: KpiTileSpec[] = [
    { key: "reorder", label: "Below reorder level", icon: TriangleAlert,
      tone: (k?.items_below_reorder ?? 0) > 0 ? "bad" : "ok",
      value: isLoading ? undefined : (k?.items_below_reorder ?? 0),
      onPress: () => nav("/inventory/replenishment") },
    { key: "expiry", label: "Expiring in 30 days", icon: CalendarClock,
      tone: (k?.near_expiry_30_days ?? 0) > 0 ? "warn" : "neutral",
      value: isLoading ? undefined : (k?.near_expiry_30_days ?? 0),
      // The balance screen is where an expiring batch is acted on; the 60/90-day
      // horizons stay in the context strip because nobody works them today.
      onPress: () => nav("/inventory/stock-balance?expiring=30") },
    { key: "reserved", label: "Reserved", icon: Lock, tone: "info",
      value: isLoading ? undefined : Math.round(k?.total_reserved_qty ?? 0),
      onPress: () => nav("/inventory/fulfilment") },
    { key: "dead", label: "Dead stock", icon: PackageX, tone: "neutral",
      value: isLoading ? undefined : (k?.dead_stock_count ?? 0),
      onPress: () => nav("/inventory/stock-balance?dead=1") },
  ];

  const contextStats: ContextStatSpec[] = [
    // Valuation exposes purchase cost, so it is its own permission and its own tile
    // — see `stock.valuation.view`. Absent, not zeroed, when the login lacks it.
    ...(canViewValuation ? [{
      key: "value", label: "Stock value", icon: IndianRupee,
      value: isLoading ? "–" : inr(k?.total_stock_value ?? 0),
    }] : []),
    { key: "available", label: "Available", icon: Boxes,
      value: isLoading ? "–" : (k?.total_available_qty ?? 0).toLocaleString("en-IN") },
    { key: "e60", label: "Expiring in 60 days", icon: CalendarClock,
      value: isLoading ? "–" : (k?.near_expiry_60_days ?? 0) },
    { key: "e90", label: "Expiring in 90 days", icon: CalendarClock,
      value: isLoading ? "–" : (k?.near_expiry_90_days ?? 0) },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title="Overview & Analytics"
        actions={
          <Button variant="subtle" disabled={isFetching} onClick={() => refetch()}>
            <RefreshCw size={14} className={isFetching ? "animate-spin" : ""} />
            {dataUpdatedAt ? `Updated ${fmtTime(dataUpdatedAt)}` : "Refresh"}
          </Button>
        }
      />

      {/* The shared KPI strip (2026-08-23) — the same one Indents, Approvals,
          Procurement and the Warehouse lead with. `undefined` while loading draws a
          skeleton: rendering 0 0 0 0 read as a real answer ("no stock, nothing
          expiring") on a screen that had not finished loading. */}
      <KpiTiles label="Stock queues" tiles={kpiTiles} />
      <ContextStrip stats={contextStats} className="mt-3" />

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <SectionTitle><History size={16} /> Stock age profile</SectionTitle>
          <AgeingChart buckets={buckets} loading={ageingLoading || (!ageing && isLoading)} />
          <ChartLegend
            items={[
              { label: "Fresh", color: CHART_COLORS.OK },
              { label: "Watch", color: CHART_COLORS.BRAND },
              { label: "Slow-moving", color: CHART_COLORS.WARN },
              { label: "Stale", color: CHART_COLORS.BAD },
            ]}
          />
        </Card>

        <Card className="p-5">
          <SectionTitle><Lock size={16} /> Reserved vs available</SectionTitle>
          <StockSplitChart
            slices={[
              { label: "Available", value: k?.total_available_qty ?? 0, color: CHART_COLORS.BRAND },
              { label: "Reserved", value: k?.total_reserved_qty ?? 0, color: CHART_COLORS.WARN },
            ]}
            loading={!k && isLoading}
          />
          <ChartLegend
            items={[
              { label: "Available", color: CHART_COLORS.BRAND,
                value: (k?.total_available_qty ?? 0).toLocaleString("en-IN") },
              { label: "Reserved", color: CHART_COLORS.WARN,
                value: (k?.total_reserved_qty ?? 0).toLocaleString("en-IN") },
            ]}
          />
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <SectionTitle><CalendarClock size={16} /> Expiry watchlist (next 90 days)</SectionTitle>
          {expiryLoading ? (
            <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-lg" />
            ))}</div>
          ) : expiryRows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted">Nothing expiring in the next 90 days.</p>
          ) : (
            <ul className="divide-y divide-line/70">
              {expiryRows.map((row) => {
                const days = row.days_to_expiry;
                return (
                  <li key={row.stock_id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-ink">{row.item_name}</div>
                      <div className="truncate text-[11px] text-muted">
                        {row.warehouse_name}{row.batch_no ? ` · Batch ${row.batch_no}` : ""}
                        {" · "}Qty {row.quantity.toLocaleString("en-IN")}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-[11px] text-muted">{row.expiry_date}</span>
                      <Chip size="sm" variant="flat" color={days <= 0 ? "danger" : days <= 30 ? "warning" : "default"}>
                        {days <= 0 ? "Expired" : `${days}d`}
                      </Chip>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <Can do="page.inv_balance.view">
            <Link to="/inventory/ledger" className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-brand hover:underline">
              Open stock ledger <ArrowRight size={14} />
            </Link>
          </Can>
        </Card>

        <div className="flex flex-col gap-4">
          <Card className="p-5">
            <SectionTitle><Snowflake size={16} /> Dead stock</SectionTitle>
            <div className="flex items-end justify-between gap-3">
              <p className="text-sm text-body">
                <strong className="font-display text-3xl font-bold text-ink">{k?.dead_stock_count ?? 0}</strong>
                <span className="ml-1">items not moved in 60+ days.</span>
              </p>
            </div>
            {(k?.dead_stock_count ?? 0) > 0 && (
              <Can do="page.inv_balance.view">
                <Link to="/inventory/replenishment" className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-brand hover:underline">
                  Review replenishment <ArrowRight size={14} />
                </Link>
              </Can>
            )}
          </Card>

          <Card className="flex-1 p-5">
            <SectionTitle>Quick actions</SectionTitle>
            {/* Gated on the same page permissions as the nav. These used to be
                plain links, so a login without Stock Adjustments or Replenishment
                was still invited to open them and met the Forbidden screen. */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {QUICK_ACTIONS.map(({ to, perm, label, desc, icon: Icon }) => (
                <Can key={to} do={perm}>
                  <Link
                    to={to}
                    className="group flex min-h-[44px] items-start gap-3 rounded-xl border border-line/70 p-3 transition-colors hover:border-brand/40 hover:bg-brand-050/50"
                  >
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-050 text-brand transition-colors group-hover:bg-brand group-hover:text-white">
                      <Icon size={16} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-ink">{label}</span>
                      <span className="block truncate text-xs text-muted">{desc}</span>
                    </span>
                  </Link>
                </Can>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
