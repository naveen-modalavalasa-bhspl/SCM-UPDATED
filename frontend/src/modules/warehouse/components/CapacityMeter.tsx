import {
  AlertTriangle, Box, Boxes, Check, CircleHelp, Layers, Move3d, PackageMinus,
  PackagePlus, Ruler, Scale, Weight, X,
} from "lucide-react";
import type {
  CapacityGate, CapacityGateKey, CapacityStatus, LocationOccupancy,
} from "../types";

/**
 * How full a storage location is, and what the move being entered does to it.
 *
 * One component for both directions, because putaway and material issue are the same
 * question asked from either side: putaway adds to the shelf, an issue gives space
 * back, and a storekeeper reading two different-looking widgets learns the bar twice.
 *
 * The shape follows the backend's: space is measured in HANDLING UNITS — whole packs,
 * each with its own outer box and gross weight — and a location is checked on four
 * INDEPENDENT gates. So this draws four rows, not one bar. A pallet that fits the cube
 * of a bay it is too wide to enter is a real and common case, and a single volume bar
 * can only ever say the wrong thing about it.
 *
 * Everything it says in words comes from the server (`headline`, `detail`, and each
 * gate's own `detail` / `note`, all from `modules/warehouse/capacity.py`). This file
 * owns the picture and nothing else — a colour per `status`, the bars, the fit diagram
 * — so a change of wording is a change in one place and every screen follows.
 *
 * Bars are scaled to `max(capacity, projected)` rather than to capacity, so an overload
 * is drawn as the part that sticks out past the capacity mark instead of silently
 * pinning at 100%. A bay that is 140% full looks 140% full.
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
  WONT_FIT: {
    bar: "bg-bad", track: "bg-bad-bg", text: "text-bad",
    chip: "bg-bad-bg text-bad", label: "Does not fit",
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

const GATE_ICONS: Record<CapacityGateKey, typeof Box> = {
  VOLUME: Box,
  WEIGHT: Weight,
  FOOTPRINT: Move3d,
  UNITS: Layers,
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

/** A count without trailing zeros. Handling units are counted, and "3.000 cases" makes
 *  a storekeeper wonder what the decimals are hiding. */
export function fmtCount(value: number | null | undefined): string {
  if (value == null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

/** `18.5 kg`, or a dash. */
export function weight(value: number | null | undefined): string {
  return value == null ? "—" : `${fmtCount(value)} kg`;
}

/** Whatever a gate measures, in that gate's own unit. One function so the four rows
 *  cannot format the same kind of number two different ways. */
function gateValue(gate: CapacityGate, value: number | null | undefined): string {
  if (value == null) return "—";
  if (gate.unit === "m³") return volume(value);
  if (gate.unit === "kg") return weight(value);
  if (gate.unit) return `${fmtCount(value)} ${gate.unit}`;
  return fmtCount(value);
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
 * The inline form: a slim bar and a word, for a chip or a table cell where a whole card
 * would not fit. Says nothing it cannot say in one line — but it does say when the
 * DISCRETE limit is what is full, because a bay with cube to spare and no pallet slot
 * left reads as "room" on a volume bar and is not.
 */
export function CapacityBadge({
  capacity, occupied, status, units, capacityUnits, className = "",
}: {
  capacity?: number | null;
  occupied?: number | null;
  status?: CapacityStatus | null;
  units?: number | null;
  capacityUnits?: number | null;
  className?: string;
}) {
  const tone = TONES[status ?? "OK"] ?? TONES.OK;
  const slotted = capacityUnits != null && capacityUnits > 0;

  if (capacity == null || capacity <= 0) {
    if (!slotted) return null;
    // No cube, but a stated unit limit — draw that instead of nothing.
    const used = Number(units ?? 0);
    return (
      <span className={`inline-flex items-center gap-1.5 ${className}`}>
        <span className={`h-1.5 w-10 overflow-hidden rounded-full ${tone.track}`} aria-hidden>
          <span className={`block h-full rounded-full ${tone.bar}`}
                style={{ width: `${pct(used, capacityUnits!)}%` }} />
        </span>
        <span className={`text-[11px] font-semibold ${tone.text}`}>
          {fmtCount(used)}/{fmtCount(capacityUnits)} units
        </span>
      </span>
    );
  }

  const used = Number(occupied ?? 0);
  const free = capacity - used;
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span className={`h-1.5 w-10 overflow-hidden rounded-full ${tone.track}`} aria-hidden>
        <span className={`block h-full rounded-full ${tone.bar}`}
              style={{ width: `${pct(used, capacity)}%` }} />
      </span>
      <span className={`text-[11px] font-semibold ${tone.text}`}>
        {free > 0 ? `${volume(free)} free` : "full"}
      </span>
      {slotted && (
        <span className="text-[11px] text-muted">
          · {fmtCount(units ?? 0)}/{fmtCount(capacityUnits)}
        </span>
      )}
    </span>
  );
}

/**
 * The pack against the opening, drawn to scale from the front.
 *
 * Worth the pixels because the FOOTPRINT gate is the one verdict a number cannot carry:
 * "0.6 m³ into a 2 m³ bay" reads as ample room right up until the pallet is 10 cm too
 * wide for the bay. Two rectangles at the same scale settle it at a glance, and the
 * outline sticking out past the frame is exactly what is wrong.
 */
function FitDiagram({ data, className = "" }: {
  data: LocationOccupancy; className?: string;
}) {
  const binW = Number(data.location_width_cm ?? 0);
  const binH = Number(data.location_height_cm ?? 0);
  const w = Number(data.pack_width_cm ?? 0);
  const h = Number(data.pack_height_cm ?? 0);
  // Only a single-line move draws one: a document with five different cartons has no
  // one box to picture, and drawing the biggest would depict something nobody is
  // holding. Both boxes have to be measured or there is nothing to compare.
  if (!binW || !binH || !w || !h || (data.lines ?? []).length !== 1) return null;

  const scale = 92 / Math.max(binW, binH, w, h);
  const fits = w <= binW && h <= binH;
  const [bw, bh, pw, ph] = [binW * scale, binH * scale, w * scale, h * scale];
  const floor = 100;

  return (
    <figure className={`shrink-0 ${className}`}>
      <svg viewBox="0 0 116 116" className="h-[104px] w-[104px]" role="img"
           aria-label={
             `A ${w} by ${h} cm pack against a ${binW} by ${binH} cm opening — ` +
             (fits ? "it fits" : "it does not fit")
           }>
        {/* The opening, seen from the front, both boxes standing on the same floor. */}
        <rect x={8} y={floor - bh} width={bw} height={bh} rx={2}
              className="fill-content2 stroke-line" strokeWidth={1.5} />
        <rect x={8} y={floor - ph} width={pw} height={ph} rx={2}
              className={fits ? "fill-ok-bg stroke-ok" : "fill-bad-bg stroke-bad"}
              strokeWidth={1.5} strokeDasharray={fits ? undefined : "4 3"} />
        <line x1={4} y1={floor} x2={112} y2={floor}
              className="stroke-line" strokeWidth={1} />
      </svg>
      <figcaption className="mt-1 text-center text-[10px] leading-tight text-muted">
        <span className={fits ? "text-ok" : "text-bad"}>
          {fmtCount(w)} × {fmtCount(h)}
        </span>
        {" in "}
        {fmtCount(binW)} × {fmtCount(binH)} cm
      </figcaption>
    </figure>
  );
}

/** One gate: a label, a bar where the gate is a fraction, and the sentence the server
 *  wrote for it. A verdict gate (FOOTPRINT) shows a tick or a cross instead of a bar. */
function Gate({ gate }: { gate: CapacityGate }) {
  const tone = TONES[gate.status] ?? TONES.OK;
  const Icon = GATE_ICONS[gate.key] ?? Box;
  const measurable = gate.capacity != null && gate.projected != null;
  const capacity = Number(gate.capacity ?? 0);
  const projected = Number(gate.projected ?? 0);
  const occupied = Number(gate.occupied ?? 0);
  const over = measurable && projected > capacity;
  // Scaled to whatever is bigger, so an overload sticks out past the capacity mark
  // instead of pinning at 100% and looking merely full.
  const scale = Math.max(capacity, projected, occupied) || 1;
  const outward = projected < occupied;
  const stays = outward ? projected : occupied;
  const moving = Math.abs(projected - occupied);

  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-2.5">
        <span className={`mt-px rounded-md p-1 ${tone.chip}`}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span className="text-xs font-bold uppercase tracking-wide text-ink">
              {gate.label}
            </span>
            {measurable ? (
              <span className="tabular text-xs font-semibold text-muted">
                <span className={over ? "text-bad" : "text-ink"}>
                  {gateValue(gate, projected)}
                </span>
                {" / "}{gateValue(gate, capacity)}
                {gate.pct != null && (
                  <span className={`ml-1.5 ${tone.text}`}>{gate.pct.toFixed(0)}%</span>
                )}
              </span>
            ) : (
              <span className={`inline-flex items-center gap-1 text-xs font-semibold ${tone.text}`}>
                {gate.status === "OK" ? <Check className="h-3.5 w-3.5" />
                  : gate.status === "WONT_FIT" ? <X className="h-3.5 w-3.5" />
                    : <CircleHelp className="h-3.5 w-3.5" />}
                {gate.status === "OK" ? "Fits"
                  : gate.status === "WONT_FIT" ? "Will not fit" : tone.label}
              </span>
            )}
          </div>

          {measurable && (
            <div className="relative mt-1.5">
              <div className={`flex h-2 w-full overflow-hidden rounded-full ${tone.track}`}>
                <span className={`h-full ${tone.bar} transition-[width] duration-300`}
                      style={{ width: `${pct(stays, scale)}%` }} />
                {moving > 0 && (
                  <span
                    // The part in play. Striped rather than a second flat colour so it
                    // reads as "about to change" instead of as another kind of stock.
                    className={`h-full transition-[width] duration-300 ${
                      outward ? "opacity-40" : "opacity-75"
                    } ${over ? "bg-bad" : tone.bar}`}
                    style={{
                      width: `${pct(moving, scale)}%`,
                      backgroundImage:
                        "repeating-linear-gradient(45deg, rgba(255,255,255,.55) 0 3px, transparent 3px 7px)",
                    }}
                  />
                )}
              </div>
              {/* Where the rated limit sits. Only worth drawing when the bar runs past
                * it — otherwise it is the right-hand edge and says nothing. */}
              {over && (
                <span className="pointer-events-none absolute -top-1 bottom-[-4px] w-px bg-ink"
                      style={{ left: `${pct(capacity, scale)}%` }} aria-hidden />
              )}
            </div>
          )}

          <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{gate.detail}</p>
          {gate.note && (
            <p className="mt-0.5 text-[11px] italic leading-relaxed text-muted/80">
              {gate.note}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * What is actually being moved, in the pack it moves in.
 *
 * The single most important line on the panel and the one the old volume-only meter
 * could not draw: `12 × Carton (50 EA)` is the arithmetic every gate below is built
 * from, and showing the cube without showing the packs it came from is how a
 * storekeeper ends up not believing the number.
 */
function LoadStrip({ data }: { data: LocationOccupancy }) {
  const outward = data.direction === "OUT";
  const units = data.move_units ?? null;
  if (units == null || Number(units) === 0) return null;
  const perPack = data.pack_base_qty ?? null;
  const single = (data.lines ?? []).length === 1 ? data.lines[0] : null;

  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5 ${
      outward ? "bg-ok-bg/30" : "bg-brand/[0.04]"
    }`}>
      <div className="flex items-baseline gap-1.5">
        <span className={`tabular font-display text-xl font-black leading-none ${
          outward ? "text-ok" : "text-ink"
        }`}>
          {outward ? "−" : ""}{fmtCount(units)}
        </span>
        <span className="text-xs font-semibold text-body">
          {data.pack_name ?? "handling unit"}
          {Number(units) === 1 ? "" : "s"}
        </span>
      </div>
      {perPack != null && single && (
        <span className="rounded-full bg-content2 px-2 py-0.5 text-[11px] text-muted">
          {fmtCount(single.qty)} {single.uom_code ?? "units"} ÷ {fmtCount(perPack)} per
          pack
        </span>
      )}
      <div className="ml-auto flex items-center gap-4">
        <span className="tabular text-xs text-muted">
          <Box className="mr-1 inline h-3 w-3" />
          {volume(data.move_volume)}
        </span>
        {data.move_weight != null && (
          <span className="tabular text-xs text-muted">
            <Scale className="mr-1 inline h-3 w-3" />
            {weight(data.move_weight)}
          </span>
        )}
      </div>
    </div>
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
  /** Drops the summary figures and the fit diagram, keeping the gates. For a column of
   *  several locations, where four full cards would bury the one that matters. */
  compact?: boolean;
}) {
  if (loading) {
    return (
      <div className={`animate-pulse rounded-xl border border-line bg-content2 px-4 py-5 ${className}`}>
        <div className="h-3 w-40 rounded bg-line" />
        <div className="mt-4 h-2 w-full rounded-full bg-line" />
        <div className="mt-3 h-2 w-3/4 rounded-full bg-line" />
      </div>
    );
  }
  if (!data) return null;

  const tone = TONES[data.status] ?? TONES.OK;
  const outward = data.direction === "OUT";
  const adverse = data.status === "OVER" || data.status === "WONT_FIT";

  const Icon = data.status === "NO_CAPACITY"
    ? Ruler
    : data.status === "UNMEASURED"
      ? CircleHelp
      : data.status === "WONT_FIT"
        ? Move3d
        : adverse
          ? AlertTriangle
          : outward
            ? PackageMinus
            : PackagePlus;

  return (
    <div
      className={`overflow-hidden rounded-xl border bg-content1 ${
        adverse ? "border-bad/40 shadow-[0_0_0_1px_rgba(0,0,0,0.02)]" : "border-line"
      } ${className}`}
      // The whole panel is one announcement; a storekeeper using a screen reader should
      // hear it change when they pick a different bin, not hunt for it.
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className={`mt-0.5 rounded-lg px-1.5 py-1.5 ${tone.chip}`}>
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="font-display text-sm font-bold text-ink">{data.headline}</div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted">{data.detail}</p>
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${tone.chip}`}>
          {tone.label}
        </span>
      </div>

      <LoadStrip data={data} />

      {/* One row per gate that could be evaluated. Divided rather than boxed: they are
        * four readings of one shelf, not four unrelated cards. */}
      {/* Defensive on the array itself: this panel sits on the putaway desk, and a
        * payload one field short has to degrade rather than white-screen a storekeeper
        * mid-placement. The bin is a real thing whatever the JSON says. */}
      {(data.gates ?? []).length > 0 && (
        <div className="divide-y divide-line/70">
          {data.gates.map((gate) => <Gate key={gate.key} gate={gate} />)}
        </div>
      )}

      {!compact && (
        <div className="flex items-start gap-4 border-t border-line px-4 py-3">
        <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
          <Figure
            label="Stored now"
            value={volume(data.occupied_volume)}
            hint={data.capacity_volume ? `${(data.utilisation_pct ?? 0).toFixed(1)}% used` : undefined}
          />
          <Figure
            label="Handling units"
            value={
              data.capacity_units != null
                ? `${fmtCount(data.projected_units)} / ${fmtCount(data.capacity_units)}`
                : fmtCount(data.projected_units)
            }
            hint={data.capacity_units != null ? "after this" : "in this location"}
          />
          <Figure
            label="On the shelf"
            value={weight(data.projected_weight_kg)}
            hint={data.capacity_weight_kg != null
              ? `of ${weight(data.capacity_weight_kg)}` : "no limit set"}
          />
          <Figure
            label={data.status === "OVER" ? "Over by" : "Free after"}
            value={data.status === "OVER" ? volume(data.over_by) : volume(data.projected_free_volume)}
            tone={data.status === "OVER" ? "text-bad" : "text-ink"}
            hint={data.projected_pct == null ? undefined : `${data.projected_pct.toFixed(1)}% after`}
          />
        </div>
        <FitDiagram data={data} className="hidden sm:block" />
        </div>
      )}

      {/* Honesty, not decoration. The bars are built from measured packs alone, so
        * anything they could not count has to be named — otherwise a half-counted shelf
        * reads as a shelf with room. */}
      {data.is_partial && (
        <div className="flex items-start gap-2 border-t border-line bg-warn-bg/40 px-4 py-2.5 text-[11px] leading-relaxed text-warn">
          <Boxes className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            {data.unmeasured_items > 0 && (
              <>
                {data.unmeasured_items} item{data.unmeasured_items === 1 ? "" : "s"} already
                here {data.unmeasured_items === 1 ? "has" : "have"} no measured pack
                {data.unmeasured_qty ? ` (${fmtCount(data.unmeasured_qty)} in stock)` : ""}
                {data.unmeasured_lines > 0 ? ", and " : ". "}
              </>
            )}
            {data.unmeasured_lines > 0 && (
              <>
                {data.unmeasured_lines} line{data.unmeasured_lines === 1 ? "" : "s"} on this
                document {data.unmeasured_lines === 1 ? "is" : "are"} unmeasured too.{" "}
              </>
            )}
            The bars count only measured packs, so the real figure is higher. Measure the
            container type under Masters &gt; Packages to close the gap.
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

export { FitDiagram };
