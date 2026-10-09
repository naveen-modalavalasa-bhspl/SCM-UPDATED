import { useMemo } from "react";
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Skeleton } from "@heroui/react";

/**
 * Charts for the Inventory Overview. Read-only pictures over data the page already
 * fetches — nothing here writes, filters or navigates; the cards beside them do that.
 *
 * Colours are the design tokens from index.css, so the charts follow the theme
 * rather than recharts' defaults.
 */

const BRAND = "#3e63dd";
const OK = "#0f9d6b";
const WARN = "#f0872b";
const BAD = "#d64550";
const NEUTRAL = "#5a6377";

export interface AgeingBucket {
  label: string;
  qty: number;
}

/** Stock age profile — how much of what we hold is fresh vs going stale. */
export function AgeingChart({ buckets, loading }: { buckets: AgeingBucket[]; loading?: boolean }) {
  const data = useMemo(
    () => buckets.map((b) => ({ ...b, display: b.qty.toLocaleString("en-IN", { maximumFractionDigits: 2 }) })),
    [buckets],
  );
  const colors = [OK, BRAND, WARN, BAD];

  if (loading) return <Skeleton className="h-[220px] w-full rounded-lg" />;

  if (!data.some((d) => d.qty > 0)) {
    return (
      <div className="flex h-[220px] items-center justify-center text-sm text-muted">
        No ageing data yet.
      </div>
    );
  }

  return (
    <div className="h-[220px] w-full" role="img" aria-label="Stock quantity by age bucket">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: "#697187" }}
            axisLine={{ stroke: "#e5e8ef" }}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "#697187" }}
            axisLine={false}
            tickLine={false}
            width={56}
          />
          <Tooltip
            cursor={{ fill: "rgba(62, 99, 221, 0.06)" }}
            contentStyle={{
              borderRadius: 10,
              border: "1px solid #e5e8ef",
              fontSize: 12,
            }}
            formatter={(value: number | string) => [Number(value).toLocaleString("en-IN"), "Qty"]}
          />
          <Bar dataKey="qty" radius={[6, 6, 0, 0]} maxBarSize={56} isAnimationActive={false}>
            {data.map((_, i) => (
              <Cell key={i} fill={colors[i % colors.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface SplitSlice {
  label: string;
  value: number;
  color: string;
}

/** Reserved vs available — the split rule 7 draws on stk_balance, drawn. */
export function StockSplitChart({ slices, loading }: { slices: SplitSlice[]; loading?: boolean }) {
  const total = slices.reduce((s, x) => s + x.value, 0);

  if (loading) return <Skeleton className="h-[220px] w-full rounded-lg" />;

  return (
    <div className="relative h-[220px] w-full" role="img"
         aria-label={`Reserved ${slices[0]?.value ?? 0} of ${total} on hand`}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={slices}
            dataKey="value"
            nameKey="label"
            cx="50%"
            cy="50%"
            innerRadius="66%"
            outerRadius="90%"
            startAngle={90}
            endAngle={-270}
            stroke="none"
            isAnimationActive={false}
          >
            {slices.map((s) => (
              <Cell key={s.label} fill={s.color} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{ borderRadius: 10, border: "1px solid #e5e8ef", fontSize: 12 }}
            formatter={(value: number | string) => [Number(value).toLocaleString("en-IN"), undefined]}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display text-3xl font-bold tabular-nums text-ink">
          {total.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
        </span>
        <span className="text-xs font-medium text-muted">On hand</span>
      </div>
    </div>
  );
}

export function ChartLegend({ items }: { items: { label: string; color: string; value?: string }[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5 text-xs text-body">
          <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: i.color }} />
          {i.label}
          {i.value !== undefined && <strong className="tabular-nums text-ink">{i.value}</strong>}
        </span>
      ))}
    </div>
  );
}

export const CHART_COLORS = { BRAND, OK, WARN, BAD, NEUTRAL };
