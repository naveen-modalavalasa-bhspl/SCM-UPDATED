import { useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { Chip, Tab, Tabs } from "@heroui/react";
import { IndianRupee, History, TriangleAlert, RefreshCw } from "lucide-react";
import { Button, Card, PageHeader, ResponsiveList, StatCard, type Column } from "@/shared/components";
import { getStockValuation, getStockAgeing, getNearExpiryAlerts } from "../api";

const inr = (n: number) => `₹${Number(n ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

// ponytail: rows are shaped by the report endpoints and used only here — one loose
// row type beats three near-identical interfaces nobody else imports.
type Row = Record<string, any>;

const bucketColor = (b: string) =>
  b === "0-30" ? "success" : b === "31-60" ? "primary" : b === "61-90" ? "warning" : "danger";

export function StockValuationView() {
  const [tab, setTab] = useState("valuation");
  const qc = useQueryClient();

  const [val, age, exp] = useQueries({
    queries: [
      { queryKey: ["stock-valuation"], queryFn: () => getStockValuation() },
      { queryKey: ["stock-ageing"], queryFn: () => getStockAgeing() },
      { queryKey: ["near-expiry"], queryFn: () => getNearExpiryAlerts(90) },
    ],
  });

  const loading = val.isLoading || age.isLoading || exp.isLoading;
  const valuationRows: Row[] = val.data?.items ?? [];
  const ageingRows: Row[] = age.data?.items ?? [];
  const expiryRows: Row[] = exp.data ?? [];

  const valuationCols: Column<Row>[] = [
    { key: "item_code", header: "Item Code", render: (r) => <strong>{r.item_code}</strong> },
    { key: "item_name", header: "Item", render: (r) => r.item_name },
    { key: "warehouse_name", header: "Warehouse", render: (r) => r.warehouse_name, hideOnNarrow: true },
    { key: "total_qty", header: "Qty", render: (r) => r.total_qty },
    { key: "moving_avg_cost", header: "Avg Cost", render: (r) => inr(r.moving_avg_cost) },
    { key: "total_stock_value", header: "Value", render: (r) => <strong>{inr(r.total_stock_value)}</strong> },
  ];

  const ageingCols: Column<Row>[] = [
    { key: "item_code", header: "Item Code", render: (r) => <strong>{r.item_code}</strong> },
    { key: "warehouse_name", header: "Warehouse", render: (r) => r.warehouse_name, hideOnNarrow: true },
    { key: "batch_no", header: "Batch", render: (r) => r.batch_no ?? "-" },
    { key: "days_in_stock", header: "Days in Stock", render: (r) => r.days_in_stock },
    {
      key: "age_bucket",
      header: "Age Bucket",
      render: (r) => (
        <Chip size="sm" variant="flat" color={bucketColor(r.age_bucket)}>{r.age_bucket} days</Chip>
      ),
    },
    { key: "expiry_date", header: "Expiry", render: (r) => r.expiry_date ?? "-", hideOnNarrow: true },
  ];

  const expiryCols: Column<Row>[] = [
    { key: "item_code", header: "Item Code", render: (r) => <strong>{r.item_code}</strong> },
    { key: "item_name", header: "Item", render: (r) => r.item_name },
    { key: "warehouse_name", header: "Warehouse", render: (r) => r.warehouse_name, hideOnNarrow: true },
    { key: "batch_no", header: "Batch", render: (r) => r.batch_no ?? "-" },
    { key: "expiry_date", header: "Expiry", render: (r) => r.expiry_date },
    {
      key: "days_to_expiry",
      header: "Days Left",
      render: (r) => (
        <Chip size="sm" variant="flat" color={r.days_to_expiry <= 30 ? "danger" : r.days_to_expiry <= 60 ? "warning" : "default"}>
          {r.days_to_expiry} days
        </Chip>
      ),
    },
    { key: "quantity", header: "Available", render: (r) => r.quantity },
  ];

  const card = (r: Row) => (
    <div className="space-y-1">
      <div className="font-semibold text-ink">{r.item_name ?? r.item_code}</div>
      <div className="text-xs text-muted">{r.item_code} · {r.warehouse_name}</div>
      {r.total_stock_value !== undefined && <div className="text-sm">Value: <strong>{inr(r.total_stock_value)}</strong></div>}
      {r.age_bucket && <Chip size="sm" variant="flat" color={bucketColor(r.age_bucket)}>{r.age_bucket} days</Chip>}
      {r.days_to_expiry !== undefined && <div className="text-sm">Expires in {r.days_to_expiry} days</div>}
    </div>
  );

  const refresh = () =>
    ["stock-valuation", "stock-ageing", "near-expiry"].forEach((k) =>
      qc.invalidateQueries({ queryKey: [k] }),
    );

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title="Valuation, Ageing & Expiry"
        actions={
          <Button variant="subtle" onClick={refresh}>
            <RefreshCw size={14} /> Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Portfolio Valuation" value={inr(val.data?.total_portfolio_value ?? 0)} icon={<IndianRupee size={16} />} />
        <StatCard label="Fresh Stock (0-30 d)" value={age.data?.bucket_0_30_qty ?? 0} icon={<History size={16} />} tone="text-success" />
        <StatCard label="Aged Stock (90+ d)" value={age.data?.bucket_90_plus_qty ?? 0} icon={<History size={16} />} tone="text-danger" />
        <StatCard label="Near-Expiry (≤90 d)" value={expiryRows.length} icon={<TriangleAlert size={16} />} tone="text-warning" />
      </div>

      <Card className="mt-4 p-3">
        <Tabs
          aria-label="Reports"
          selectedKey={tab}
          onSelectionChange={(k) => setTab(String(k))}
          variant="underlined"
        >
          <Tab key="valuation" title="Stock Valuation" />
          <Tab key="ageing" title="Stock Ageing" />
          <Tab key="expiry" title={`Near Expiry (${expiryRows.length})`} />
        </Tabs>

        {tab === "expiry" && (
          <div className="mb-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-body">
            Items below expire within 90 days. Issue them first (FEFO).
          </div>
        )}

        <ResponsiveList
          data={tab === "valuation" ? valuationRows : tab === "ageing" ? ageingRows : expiryRows}
          columns={tab === "valuation" ? valuationCols : tab === "ageing" ? ageingCols : expiryCols}
          keyOf={(r) => r.stock_id ?? r.item_id ?? `${r.item_code}-${r.warehouse_name}`}
          loading={loading}
          empty="Nothing to report."
          renderCard={card}
        />
      </Card>
    </div>
  );
}
