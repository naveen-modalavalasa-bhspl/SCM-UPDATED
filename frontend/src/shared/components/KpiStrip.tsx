import type { ComponentType, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Card } from "./ui";

/**
 * The KPI strip every procurement screen leads with.
 *
 * THE NUMBER IS THE BUTTON. A tile is not a decoration above the list — pressing it
 * applies the filter it counts, and pressing it again clears it, so the strip is the
 * fastest filter on the screen and the register underneath always explains the number
 * that was just read. `active` is what makes that a toggle rather than a one-way
 * door: a tile that has been pressed says so, and there is no state the strip can
 * show that the list below it is not already in.
 *
 * PROMOTED TO `shared/` on 2026-08-23. It began as procurement's own, on the argument
 * that a shared primitive invites the next module to bend it. That argument loses the
 * moment FIVE modules need the same strip — procurement, warehouse, material inward,
 * inventory and logistics — because the alternative is five copies that drift, which
 * is the exact problem the rule exists to prevent. The layout is the Indents
 * Overview's, deliberately: one app, one shape for "here is a queue".
 *
 * Import it, do not re-style it (rule 12). A module that needs a different KPI needs a
 * different `tone` or `icon`, not a fork of this file.
 *
 * RBAC: a tile renders where its caller decides, and every caller wraps the strip in
 * `<Can do="...">` or renders it only when the stats query it feeds off succeeded.
 * The strip itself never fetches — it is handed numbers or handed `undefined`, and
 * `undefined` draws as a skeleton, never as a zero. A login that cannot read the
 * document family gets no request, no tile and no number, and the endpoint behind it
 * would 403 anyway.
 */

/** The urgency tints, named rather than typed inline so five screens cannot each
 *  invent a slightly different amber. These are the same tokens `StatusPill` uses. */
export const TONES = {
  brand: "bg-brand-050 text-brand",
  warn: "bg-warn-bg text-warn",
  ok: "bg-ok-bg text-ok",
  bad: "bg-bad-bg text-bad",
  info: "bg-info-bg text-info",
  neutral: "bg-neutral-bg text-neutral",
} as const;

export type Tone = keyof typeof TONES;

export interface KpiTileSpec {
  /** Stable id — used as the React key and to decide which tile reads as active. */
  key: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  tone?: Tone;
  /** The number. `undefined` while it is still loading; 0 is a real answer. */
  value: number | string | undefined;
  /** The request behind this number failed. Draws an em dash rather than an endless
   *  skeleton: a tile that pulses forever is indistinguishable from a slow network,
   *  and the caller shows the real message beside the strip. */
  failed?: boolean;
  /** Pressing the tile. Omit for a tile that is a read-out and not a filter. */
  onPress?: () => void;
  /** The filter this tile applies is the one currently on. */
  active?: boolean;
  /** Screen-reader sentence, when the label alone does not carry the meaning. */
  hint?: string;
}

/** A skeleton while loading, an em dash if the request failed, the number once it
 *  lands. 0 must render as 0, never as "no answer yet". */
function display(value: number | string | undefined, failed?: boolean): ReactNode {
  if (failed) return <span className="text-muted">—</span>;
  if (value === undefined || value === null) {
    return <span className="inline-block h-6 w-10 animate-pulse rounded bg-line align-middle" />;
  }
  return typeof value === "number" ? value.toLocaleString("en-IN") : value;
}

export function KpiTile({ spec }: { spec: KpiTileSpec }) {
  const {
    label, icon: Icon, tone = "neutral", value, onPress, active, hint, failed,
  } = spec;
  const chip = TONES[tone];

  const body = (
    <>
      <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${chip}`}>
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="block font-display text-[26px] font-bold leading-none tabular text-ink">
          {display(value, failed)}
        </span>
        <span className="mt-1 block truncate text-xs font-medium text-muted">{label}</span>
      </span>
    </>
  );

  // A tile whose number never arrived must not filter: pressing it would narrow the
  // register to a bucket nobody can see the size of.
  if (!onPress || failed) {
    return (
      <div className="flex min-h-20 w-full items-center gap-3 rounded-xl border border-line/70 bg-content1 p-4 shadow-sm">
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onPress}
      // aria-pressed, not just a ring: a filter that is on has to be announced, and
      // colour alone fails anyone who cannot see it.
      aria-pressed={active}
      aria-label={hint ?? `${label}: ${value ?? "loading"}. ${
        active ? "Filter is on — press to clear" : "Press to filter the list"}`}
      className={`group flex min-h-20 w-full items-center gap-3 rounded-xl border p-4 text-left
        shadow-sm transition duration-150 focus-visible:outline-none
        focus-visible:ring-2 focus-visible:ring-brand/40 active:translate-y-0 active:scale-[0.99]
        ${active
          ? "border-brand bg-brand-050/60 ring-1 ring-brand/30"
          : "border-line/70 bg-content1 hover:-translate-y-px hover:border-brand/40 hover:shadow-md"}`}
    >
      {body}
      <ChevronRight
        className={`ml-auto h-4 w-4 shrink-0 text-brand transition-opacity ${
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
        }`}
      />
    </button>
  );
}

/** The row of work queues. Two columns on a phone, one per tile from `xl`. */
export function KpiTiles({ label, tiles, className = "" }: {
  label: string;
  tiles: KpiTileSpec[];
  className?: string;
}) {
  if (!tiles.length) return null;
  return (
    <section
      aria-label={label}
      className={`grid grid-cols-2 gap-3 ${
        tiles.length >= 4 ? "xl:grid-cols-4" : "sm:grid-cols-3"
      } ${className}`}
    >
      {tiles.map((spec) => <KpiTile key={spec.key} spec={spec} />)}
    </section>
  );
}

export interface ContextStatSpec {
  key: string;
  label: string;
  value: ReactNode;
  icon: ComponentType<{ className?: string }>;
  /** Optional: a context number can be a link too, when there is one list to open. */
  onPress?: () => void;
}

/** The quiet strip under the queues: totals that inform but need no decision. */
export function ContextStrip({ stats, className = "" }: {
  stats: ContextStatSpec[];
  className?: string;
}) {
  if (!stats.length) return null;
  return (
    <Card className={`grid grid-cols-2 gap-y-1 px-3 py-2 sm:gap-0 sm:divide-x sm:divide-line/60 ${
      stats.length >= 4 ? "sm:grid-cols-4" : "sm:grid-cols-3"
    } ${className}`}>
      {stats.map(({ key, label, value, icon: Icon, onPress }) => {
        const body = (
          <>
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
              <Icon className="h-3.5 w-3.5 text-muted/80" />
              {label}
            </span>
            <span className="mt-0.5 block text-lg font-bold tabular text-ink">{value}</span>
          </>
        );
        if (!onPress) {
          return <div key={key} className="min-w-0 px-1 py-2 sm:px-4">{body}</div>;
        }
        return (
          <button
            key={key}
            type="button"
            onClick={onPress}
            className="min-w-0 rounded-lg px-1 py-2 text-left transition hover:bg-content2 sm:px-4"
          >
            {body}
          </button>
        );
      })}
    </Card>
  );
}

/* --- formatting, shared by every strip ------------------------------------ */

/** Rupees, short. A KPI has room for the magnitude, never for the paise: an open
 *  commitment of ₹1,24,50,000 reads as ₹1.2Cr and stays on one line on a phone. */
export function shortMoney(value?: number | null): string {
  const n = Number(value ?? 0);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)}K`;
  return `${sign}₹${abs.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

/** Quantities, in the same spirit. Three decimals only when there are any. */
export function shortQty(value?: number | null): string {
  const n = Number(value ?? 0);
  if (Math.abs(n) >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  return n.toLocaleString("en-IN", { maximumFractionDigits: 3 });
}
