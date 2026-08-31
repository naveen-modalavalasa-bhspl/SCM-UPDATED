import { AlertTriangle, Boxes, CircleHelp, PackageMinus, PackagePlus, Ruler } from "lucide-react";
import type { CapacityStatus, LocationOccupancy } from "../types";

/**
 * How full a storage location is, and what the move being entered does to it.
 *
 * One component for both directions, because putaway and material issue are the same
 * question asked from either side: putaway adds to the shelf, an issue gives space
 * back, and a storekeeper reading two different-looking widgets learns the bar twice.
 *
 * Everything it says in words comes from the server (`headline`, `detail`, served by
 * `modules/warehouse/capacity.py`). This file owns the picture and nothing else — a
 * colour per `status`, a bar, four numbers — so a change of wording is a change in one
 * place and both screens follow.
 *
 * The bar is scaled to `max(capacity, projected)` rather than to capacity, so an
 * overload is drawn as the part that sticks out past the capacity mark instead of
 * silently pinning at 100%. A bin that is 140% full looks 140% full.
 */

const TONES: Record<CapacityStatus, {
  bar: string; track: string; text: string; chip: string; label: string;
}> = {
  OK: {
    bar: "bg-ok", track: "bg-ok-bg", text: "text-ok",
    chip: "bg-ok-bg text-ok", label: "Room",
  },
  TIGHT: {
    bar: "bg-warn", track: "bg-warn-bg", text: "text-warn",
    chip: "bg-warn-bg text-warn", label: "Nearly full",
  },
  FULL: {
    bar: "bg-warn", track: "bg-warn-bg", text: "text-warn",
    chip: "bg-warn-bg text-warn", label: "Full",
  },
  OVER: {
    bar: "bg-bad", track: "bg-bad-bg", text: "text-bad",
    chip: "bg-bad-bg text-bad", label: "Over capacity",
  },
  NO_CAPACITY: {
    bar: "bg-neutral", track: "bg-neutral-bg", text: "text-muted",
    chip: "bg-neutral-bg text-muted", label: "No capacity set",
  },
  UNMEASURED: {
    bar: "bg-neutral", track: "bg-neutral-bg", text: "text-muted",
    chip: "bg-neutral-bg text-muted", label: "Not measured",
  },
};

/**
 * Cubic metres, trimmed. A pallet is 1.2 and a washer is 0.000004, so a fixed number
 * of decimals reads as either false precision or a flat zero; this keeps three
 * significant places on small numbers and three decimals on ordinary ones.
 */
export function fmtVol(value: number | null | undefined): string {
  if (value == null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  const text = abs >= 1 ? n.toFixed(3) : abs >= 0.001 ? n.toFixed(4) : n.toPrecision(3);
  return text.includes("e") ? text : text.replace(/\.?0+$/, "");
}

/** `0.42 m³`, or a dash. The unit is written once, here. */
export function volume(value: number | null | undefined): string {
  return value == null ? "—" : `${fmtVol(value)} m³`;
}

function pct(part: number, whole: number): number {
  if (!whole || whole <= 0) return 0;
  return Math.max(0, Math.min(100, (part / whole) * 100));
}

/** One number and its label, tabular so a column of them lines up. */
function Figure({ label, value, tone, hint }: {
  label: string; value: string; tone?: string; hint?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className={`tabular truncate text-sm font-semibold ${tone ?? "text-ink"}`}>
        {value}
      </div>
      {hint && <div className="truncate text-[11px] text-muted">{hint}</div>}
    </div>
  );
}

/**
 * The inline form: a slim bar and a percentage, for a chip or a table cell where a
 * whole card would not fit. Says nothing it cannot say in one line.
 */
export function CapacityBadge({
  capacity, occupied, status, className = "",
}: {
  capacity?: number | null;
  occupied?: number | null;
  status?: CapacityStatus | null;
  className?: string;
}) {
  if (capacity == null || capacity <= 0) return null;
  const used = Number(occupied ?? 0);
  const tone = TONES[status ?? "OK"] ?? TONES.OK;
  const free = capacity - used;
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span
        className={`h-1.5 w-10 overflow-hidden rounded-full ${tone.track}`}
        aria-hidden
      >
        <span
          className={`block h-full rounded-full ${tone.bar}`}
          style={{ width: `${pct(used, capacity)}%` }}
        />
      </span>
      <span className={`text-[11px] font-semibold ${tone.text}`}>
        {free > 0 ? `${fmtVol(free)} free` : "full"}
      </span>
    </span>
  );
}

export function CapacityMeter({
  data,
  loading,
  className = "",
  compact = false,
}: {
  data?: LocationOccupancy | null;
  loading?: boolean;
  className?: string;
  compact?: boolean;
}) {
  if (loading) {
    return (
      <div
        className={`animate-pulse rounded-xl border border-line bg-content2 px-4 py-5 ${className}`}
      >
        <div className="h-3 w-40 rounded bg-line" />
        <div className="mt-4 h-3 w-full rounded-full bg-line" />
      </div>
    );
  }
  if (!data) return null;

  const tone = TONES[data.status] ?? TONES.OK;
  const capacity = data.capacity_volume ?? null;
  const occupied = Number(data.occupied_volume ?? 0);
  const projected = Number(data.projected_volume ?? occupied);
  const move = data.move_volume ?? null;
  const outward = data.direction === "OUT";

  // Scaled to whatever is bigger, so an overload sticks out past the capacity mark
  // instead of pinning at 100% and looking merely full.
  const scale = Math.max(capacity ?? 0, projected, occupied) || 1;
  // What stays on the shelf either way, and the part this move adds or removes. An
  // outward move draws its segment at the END of the bar: it is the piece coming off.
  const stays = outward ? projected : occupied;
  const moving = Math.max(0, Math.abs(projected - occupied));

  const overCapacity = capacity != null && projected > capacity;
  const noCapacity = data.status === "NO_CAPACITY";

  const Icon = noCapacity
    ? Ruler
    : data.status === "UNMEASURED"
      ? CircleHelp
      : overCapacity
        ? AlertTriangle
        : outward
          ? PackageMinus
          : PackagePlus;

  return (
    <div
      className={`overflow-hidden rounded-xl border border-line bg-content1 ${className}`}
      // The whole panel is one announcement; a storekeeper using a screen reader
      // should hear it change when they pick a different bin, not hunt for it.
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className={`mt-0.5 rounded-lg px-1.5 py-1.5 ${tone.chip}`}>
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="truncate font-display text-sm font-bold text-ink">
              {data.headline}
            </div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted">{data.detail}</p>
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${tone.chip}`}
        >
          {tone.label}
        </span>
      </div>

      {!noCapacity && (
        <div className="px-4 pb-1 pt-4">
          <div className="relative">
            <div
              className={`flex h-3 w-full overflow-hidden rounded-full ${tone.track}`}
              role="img"
              aria-label={
                capacity == null
                  ? `${fmtVol(projected)} cubic metres stored`
                  : `${fmtVol(projected)} of ${fmtVol(capacity)} cubic metres used`
              }
            >
              <span
                className={`h-full ${tone.bar} transition-[width] duration-300`}
                style={{ width: `${pct(stays, scale)}%` }}
              />
              {moving > 0 && (
                <span
                  // The part in play. Striped rather than a second flat colour so it
                  // reads as "about to change" instead of as another kind of stock.
                  className={`h-full transition-[width] duration-300 ${
                    outward ? "opacity-40" : "opacity-70"
                  } ${overCapacity ? "bg-bad" : tone.bar}`}
                  style={{
                    width: `${pct(moving, scale)}%`,
                    backgroundImage:
                      "repeating-linear-gradient(45deg, rgba(255,255,255,.55) 0 3px, transparent 3px 7px)",
                  }}
                />
              )}
            </div>

            {/* Where the shelf's stated capacity sits. Only worth drawing when the bar
              * runs past it — otherwise it is the right-hand edge and says nothing. */}
            {capacity != null && projected > capacity && (
              <span
                className="pointer-events-none absolute -top-1 bottom-[-4px] w-px bg-ink"
                style={{ left: `${pct(capacity, scale)}%` }}
                aria-hidden
              >
                <span className="absolute -top-4 -translate-x-1/2 whitespace-nowrap text-[10px] font-semibold text-ink">
                  capacity
                </span>
              </span>
            )}
          </div>
        </div>
      )}

      <div
        className={`grid gap-3 px-4 pb-4 pt-3 ${
          compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4"
        }`}
      >
        <Figure label="Capacity" value={volume(capacity)} />
        <Figure
          label="Stored now"
          value={volume(occupied)}
          hint={
            capacity != null && capacity > 0
              ? `${(data.utilisation_pct ?? 0).toFixed(1)}% used`
              : undefined
          }
        />
        <Figure
          label={outward ? "Leaving" : "This move"}
          value={move == null ? "—" : `${outward ? "−" : "+"}${volume(move)}`}
          tone={outward ? "text-ok" : tone.text}
          hint={
            data.unit_volume_cbm != null && data.qty != null
              ? `${fmtVol(data.qty)} × ${fmtVol(data.unit_volume_cbm)}`
              : data.lines.length > 1
                ? `${data.lines.length} lines`
                : undefined
          }
        />
        <Figure
          label={overCapacity ? "Over by" : "Free after"}
          value={
            overCapacity
              ? volume(data.over_by)
              : volume(data.projected_free_volume)
          }
          tone={overCapacity ? "text-bad" : "text-ink"}
          hint={
            data.projected_pct == null ? undefined : `${data.projected_pct.toFixed(1)}% after`
          }
        />
      </div>

      {/* Honesty, not decoration. The bar is built from measured stock alone, so
        * anything it could not count has to be named — otherwise a half-counted shelf
        * reads as a shelf with room. */}
      {data.is_partial && (
        <div className="flex items-start gap-2 border-t border-line bg-warn-bg/40 px-4 py-2.5 text-[11px] leading-relaxed text-warn">
          <Boxes className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            {data.unmeasured_items > 0 && (
              <>
                {data.unmeasured_items} item{data.unmeasured_items === 1 ? "" : "s"} already
                here {data.unmeasured_items === 1 ? "has" : "have"} no measured volume
                {data.unmeasured_qty ? ` (${fmtVol(data.unmeasured_qty)} in stock)` : ""}
                {data.unmeasured_lines > 0 ? ", and " : ". "}
              </>
            )}
            {data.unmeasured_lines > 0 && (
              <>
                {data.unmeasured_lines} line{data.unmeasured_lines === 1 ? "" : "s"} on this
                document {data.unmeasured_lines === 1 ? "is" : "are"} unmeasured too.{" "}
              </>
            )}
            The bar counts only what has been measured, so the real figure is higher.
            Add dimensions under Masters &gt; Items to close the gap.
          </span>
        </div>
      )}

      {data.counts_locations > 1 && (
        <div className="border-t border-line px-4 py-2 text-[11px] text-muted">
          This capacity covers {data.counts_locations} locations — everything stored under{" "}
          <span className="font-mono text-ink">{data.location_code}</span>.
        </div>
      )}
    </div>
  );
}
