import { useState, type ReactNode } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { ChevronRight, type LucideIcon } from "lucide-react";

/**
 * The pieces the approvals dashboard and the approvals inbox both draw.
 *
 * They live here rather than in either page because the two screens must not
 * drift: the inbox's header band and the Overview's tiles are the same numbers
 * answering the same question, and the moment they are two copies one of them
 * starts lying. Every one of them is approval-scoped by its CALLER — nothing in
 * this file fetches, so nothing here can widen a scope.
 *
 * CHART RULES (from the dataviz skill — do not re-pick these by eye):
 *   * Slice colour is IDENTITY, so it comes from the categorical tokens, assigned
 *     in fixed order and never cycled. A 7th document type folds into "Other"
 *     rather than inventing a hue.
 *   * The status tokens (ok/warn/bad) are reserved for STATE and never used as
 *     "series 4" — a reader must not learn that green means good on one card and
 *     "purchase orders" on the next.
 *   * The legend carries a label AND a count for every slice, so identity is never
 *     colour-alone. That is also what licenses the one adjacent pair sitting in the
 *     6–8 CVD band.
 */

/** Fixed order. Index 6 is the "Other" bucket — deliberately the last slot. */
export const CATEGORICAL_SLOTS = [
  "var(--color-cat-1)",
  "var(--color-cat-2)",
  "var(--color-cat-3)",
  "var(--color-cat-4)",
  "var(--color-cat-5)",
  "var(--color-cat-6)",
] as const;
/** Everything past the sixth type. Neutral on purpose: "Other" is not an identity. */
export const OTHER_SLOT = "var(--color-neutral)";

export interface Slice {
  key: string;
  label: string;
  count: number;
}

/**
 * Folds a long tail into "Other" so the donut never needs a seventh hue.
 * Sorted by size first — the tail is the tail, not whatever happened to be last.
 */
export function foldSlices(entries: Slice[], keep = CATEGORICAL_SLOTS.length): Slice[] {
  const sorted = [...entries].filter((s) => s.count > 0).sort((a, b) => b.count - a.count);
  if (sorted.length <= keep) return sorted;
  const head = sorted.slice(0, keep - 1);
  const tail = sorted.slice(keep - 1);
  return [
    ...head,
    { key: "__other__", label: "Other", count: tail.reduce((sum, s) => sum + s.count, 0) },
  ];
}

export function colourFor(index: number, key: string) {
  return key === "__other__" ? OTHER_SLOT : CATEGORICAL_SLOTS[index % CATEGORICAL_SLOTS.length];
}

/**
 * The donut plus its legend.
 *
 * A donut and not a bar chart because the question is "what is this queue MADE
 * of" — a part-to-whole — and the total in the middle is half the answer. Every
 * legend row is clickable straight through to that slice's own list.
 *
 * MATCHED to the Indents donut, 2026-08-23 (`indents/components/StatusBreakdownChart`).
 * The two sit one rail apart and answer the same shape of question, and they were
 * drawn to different geometry — a 62%/100% ring with 2 degrees of padding here
 * against 69%/90% with none there — so the same data read as a different KIND of
 * chart depending on which module you were in. Same ring, same 12 o'clock start,
 * same clockwise sweep, same centre type, and the same "dim what you are not
 * pointing at" hover. Deliberately NOT a copy of that file: it carries a bespoke
 * `<Sector>` with an anchored tooltip this card has no room for. The GEOMETRY is
 * what had to agree, not the implementation.
 */
export function BreakdownDonut({
  slices, total, totalLabel, onPick, emptyText = "Nothing to show.",
}: {
  slices: Slice[];
  total: number;
  totalLabel: string;
  onPick?: (key: string) => void;
  emptyText?: string;
}) {
  if (!slices.length || total === 0) {
    return <p className="py-10 text-center text-sm text-muted">{emptyText}</p>;
  }

  const data = slices.map((slice, index) => ({
    ...slice,
    fill: colourFor(index, slice.key),
  }));

  return <DonutBody data={data} total={total} totalLabel={totalLabel} onPick={onPick} />;
}

function DonutBody({
  data, total, totalLabel, onPick,
}: {
  data: (Slice & { fill: string })[];
  total: number;
  totalLabel: string;
  onPick?: (key: string) => void;
}) {
  // Which slice the pointer is on, from EITHER the ring or its legend row — the two
  // are one control, so pointing at a legend lights its slice and the other way
  // round. Same 0.45 dim the Indents donut uses for everything you are not asking
  // about. Its own component because a hook cannot sit below the caller's early
  // return for an empty queue.
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:gap-6">
      <div className="relative h-52 w-52 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="count"
              nameKey="label"
              cx="50%"
              cy="50%"
              // The Indents geometry, exactly. A thinner ring inside a wider margin
              // reads as the same object across the two modules.
              innerRadius="69%"
              outerRadius="90%"
              // No padding and no rounding: the separation comes from the fills, and
              // 2 degrees of gap on a queue with one dominant slice showed as a wedge
              // missing out of the ring rather than as a boundary.
              paddingAngle={0}
              cornerRadius={0}
              // Twelve o'clock, clockwise — the direction a reader expects a
              // part-to-whole to run, and what the Indents donut already did.
              startAngle={90}
              endAngle={-270}
              stroke="none"
              isAnimationActive={false}
            >
              {data.map((slice) => (
                <Cell
                  key={slice.key}
                  fill={slice.fill}
                  fillOpacity={hovered && hovered !== slice.key ? 0.45 : 1}
                  className="transition-opacity duration-200"
                  onMouseEnter={() => setHovered(slice.key)}
                  onMouseLeave={() => setHovered(null)}
                  {...(onPick ? { onClick: () => onPick(slice.key),
                                  style: { cursor: "pointer" } } : {})}
                />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        {/* The hole is not decoration — it carries the total the slices sum to. */}
        <div
          aria-label={`${total} ${totalLabel}`}
          className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center text-center"
        >
          <span className="text-3xl font-bold leading-none tabular-nums text-ink">{total}</span>
          <span className="mt-1 text-xs font-medium text-muted">{totalLabel}</span>
        </div>
      </div>

      <ul className="w-full min-w-0 flex-1 space-y-0.5">
        {data.map((slice) => {
          const Row = onPick ? "button" : "div";
          return (
            <li key={slice.key}>
              <Row
                {...(onPick ? {
                  type: "button" as const,
                  onClick: () => onPick(slice.key),
                } : {})}
                onMouseEnter={() => setHovered(slice.key)}
                onMouseLeave={() => setHovered(null)}
                className={`flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-opacity ${
                  hovered && hovered !== slice.key ? "opacity-45" : ""
                } ${
                  onPick ? "transition-colors hover:bg-content2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand" : ""
                }`}
              >
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: slice.fill }}
                />
                <span className="min-w-0 flex-1 truncate text-sm text-body">{slice.label}</span>
                <span className="shrink-0 font-mono text-sm font-bold text-ink">{slice.count}</span>
                <span className="w-9 shrink-0 text-right text-xs text-muted">
                  {Math.round((slice.count / total) * 100)}%
                </span>
              </Row>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A KPI tile. The number IS the button — the whole card is the target. */
export function Kpi({
  label, value, icon: Icon, tint, onOpen, muted = false,
}: {
  label: string;
  value: ReactNode;
  icon: LucideIcon;
  tint: string;
  onOpen: () => void;
  /** Empty queue: still drawn, so the row does not reflow as work arrives, but it
   *  stops competing for attention. */
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group flex min-h-[88px] items-center gap-3 rounded-2xl border border-line/70 bg-content1 p-4 text-left transition-colors hover:border-brand/40 hover:bg-content2/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
        muted ? "opacity-70" : ""
      }`}
    >
      <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${tint}`}>
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-display text-3xl font-bold leading-none text-ink">{value}</span>
        <span className="mt-1 block truncate text-sm text-muted">{label}</span>
      </span>
      <ChevronRight className="h-5 w-5 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

export function CardTitle({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">{title}</h2>
      {action}
    </div>
  );
}
