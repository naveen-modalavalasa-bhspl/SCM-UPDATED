import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { IndianRupee, TriangleAlert, CalendarClock, Lock, History } from "lucide-react";
import { Button, Card, PageHeader, StatCard } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { getOverviewKPIs } from "../api";
import type { StockOverviewKPIs } from "../types";

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

export function InventoryOverviewPage() {
  const { can } = useAuth();
  const canViewValuation = can("stock.valuation.view");
  const { data: k, isLoading } = useQuery<StockOverviewKPIs>({
    queryKey: ["stock-overview-kpis"],
    queryFn: getOverviewKPIs,
  });

  const onHand = (k?.total_reserved_qty ?? 0) + (k?.total_available_qty ?? 0);

  return (
    <div>
      <PageHeader eyebrow="Inventory" title="Overview & Analytics" />

      {isLoading ? (
        <div className="p-6 text-sm text-muted">Loading inventory KPIs…</div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {canViewValuation && (
              <StatCard label="Total Stock Value" value={inr(k?.total_stock_value ?? 0)} icon={<IndianRupee size={16} />} />
            )}
            <StatCard
              label="Items Below Reorder"
              value={k?.items_below_reorder ?? 0}
              icon={<TriangleAlert size={16} />}
              tone={k?.items_below_reorder ? "text-danger" : "text-success"}
            />
            <StatCard
              label="Near Expiry (30 / 60 / 90 d)"
              value={`${k?.near_expiry_30_days ?? 0} / ${k?.near_expiry_60_days ?? 0} / ${k?.near_expiry_90_days ?? 0}`}
              icon={<CalendarClock size={16} />}
              tone="text-warning"
            />
            <StatCard
              label="Reserved / Available"
              value={`${k?.total_reserved_qty ?? 0} / ${k?.total_available_qty ?? 0}`}
              icon={<Lock size={16} />}
            />
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
                <History size={16} /> Dead Stock (no movement 60+ days)
              </div>
              <p className="text-sm text-body">
                <strong>{k?.dead_stock_count ?? 0}</strong> items have not moved in over 60 days.
              </p>
              <p className="mt-1 text-xs text-muted">Total on-hand across all warehouses: {onHand.toFixed(2)}</p>
            </Card>

            <Card className="p-5">
              <div className="mb-3 text-sm font-semibold text-ink">Quick Actions</div>
              <div className="flex flex-wrap gap-2">
                <Link to="/inventory/stock-balance"><Button>Stock Balance</Button></Link>
                <Link to="/inventory/ledger"><Button variant="ghost">Stock Ledger</Button></Link>
                <Link to="/inventory/replenishment"><Button variant="ghost">Replenishment</Button></Link>
                {canViewValuation && (
                  <Link to="/inventory/valuation"><Button variant="ghost">Valuation</Button></Link>
                )}
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
