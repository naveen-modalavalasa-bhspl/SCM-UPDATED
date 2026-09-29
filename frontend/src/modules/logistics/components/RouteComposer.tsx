import { useEffect, useMemo, useRef, useState } from "react";
import { Reorder, useDragControls, useReducedMotion } from "framer-motion";
import {
  AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, CornerDownLeft, GripVertical, Plus,
  Search, Sparkles, Warehouse, X,
} from "lucide-react";
import { sameOrder } from "./plannerRoute";

/**
 * Build a route by hand, in the order the truck drives it: the warehouse, then the
 * first stop, then the next. Each stop is a place — every consignment ready for it
 * goes on together — and the list under "Add the next stop" is measured from where
 * the truck will BE at that point (the last stop), nearest first, by the server.
 *
 * Drag a stop by its handle to re-order (mouse or touch; the arrows do the same for a
 * keyboard). The order is committed when the drag ENDS, not on every swap under the
 * pointer, so the server measures the route once per decision. Whatever the order,
 * the server also says what the shortest order for the same stops would be — and the
 * screen offers it, never applies it: the person may know the road is closed.
 */

const km = (value: number | null | undefined) =>
  value == null ? "…" : `${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })} km`;
const money = (value: number | string | null | undefined) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 })
    .format(Number(value ?? 0));

export interface ComposerStop {
  id: number;
  place: string;
  name: string;
  type?: string | null;
  code?: string | null;
  consignments: number;
  packages: number;
  weight_kg: number;
  /** Drive from the previous stop (or the origin); null while it is being measured. */
  leg_km: number | null;
}

export interface NextStopRow {
  id: number;
  place: string;
  name: string;
  type?: string | null;
  code?: string | null;
  consignment_nos: string[];
  weight_kg: number;
  /** From the last stop, or from the origin for the first; null while measuring. */
  distance_km: number | null;
  saves_km?: number | null;
  fits: boolean;
  blocked_reason?: string | null;
  already: boolean;
}

export interface RouteSummary {
  distance_km: number;
  return_km: number;
  saving_amount: number;
  saving_km: number;
  order_is_optimal?: boolean;
  optimal_distance_km?: number;
}

export function RouteComposer({
  originPlace, originName, stops, options, fromPlace, onReorder, onRemove, onAdd, onClear,
  summary, onUseShortest, measuring, maxStops,
}: {
  originPlace: string;
  originName: string;
  stops: ComposerStop[];
  options: NextStopRow[];
  /** Where the next stop is measured from, for the heading. */
  fromPlace: string;
  onReorder: (order: number[]) => void;
  onRemove: (id: number) => void;
  onAdd: (id: number) => void;
  onClear: () => void;
  summary?: RouteSummary | null;
  onUseShortest: () => void;
  measuring: boolean;
  maxStops?: number;
}) {
  const ids = useMemo(() => stops.map((stop) => stop.id), [stops]);
  const byId = useMemo(() => new Map(stops.map((stop) => [stop.id, stop])), [stops]);
  // The order under the pointer while dragging; the route's own order otherwise.
  const [draft, setDraft] = useState(ids);
  const draftRef = useRef(ids);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) { setDraft(ids); draftRef.current = ids; }
  }, [ids]);
  const update = (next: number[]) => { draftRef.current = next; setDraft(next); };
  const commit = () => {
    dragging.current = false;
    if (!sameOrder(draftRef.current, ids)) onReorder(draftRef.current);
  };
  const nudge = (id: number, delta: number) => {
    const at = ids.indexOf(id);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= ids.length) return;
    const next = [...ids];
    [next[at], next[to]] = [next[to], next[at]];
    onReorder(next);
  };

  const full = maxStops != null && stops.length >= maxStops;
  const shortestKm = summary && stops.length > 1 ? summary.optimal_distance_km : undefined;
  const shorterBy = shortestKm != null && summary && !summary.order_is_optimal
    ? Math.max(0, summary.distance_km - shortestKm) : 0;

  return (
    <div className="rounded-2xl border border-line bg-content1">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-ink">Your route</div>
          <div className="text-[11px] text-muted">
            {stops.length ? `${stops.length} stop${stops.length === 1 ? "" : "s"}${measuring ? " · measuring…" : ""}` : "Pick the stops in the order the truck should go"}
          </div>
        </div>
        {!!stops.length && (
          <button type="button" onClick={onClear} className="min-h-11 rounded-lg px-2 text-xs text-muted hover:bg-content2 hover:text-ink sm:min-h-8">
            Start over
          </button>
        )}
      </div>

      <div className="px-4 pt-4">
        {/* The origin: where every route starts. */}
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-400 text-slate-900 shadow-sm">
            <Warehouse className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-ink" title={originName}>{originPlace}</div>
            <div className="text-[11px] text-muted">Start — the truck loads here</div>
          </div>
        </div>

        <Reorder.Group as="ol" axis="y" values={draft} onReorder={update} className="relative">
          {draft.map((id, index) => {
            const stop = byId.get(id);
            if (!stop) return null;
            return (
              <StopRow key={id} stop={stop} index={index} last={index === draft.length - 1}
                onDragStart={() => { dragging.current = true; }} onDragEnd={commit}
                onUp={() => nudge(id, -1)} onDown={() => nudge(id, 1)} onRemove={() => onRemove(id)} />
            );
          })}
        </Reorder.Group>

        {!!summary?.return_km && stops.length > 0 && (
          <div className="ml-4.25 flex items-center gap-2 border-l-2 border-dashed border-line py-2 pl-5 text-[11px] text-muted">
            <CornerDownLeft className="h-3.5 w-3.5" /> Back to {originPlace} · {km(summary.return_km)}
          </div>
        )}
      </div>

      {/* The verdict on this order, in one line. */}
      {summary && stops.length > 0 && (
        <div className="mx-4 mt-3 space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-xl bg-content2 px-3 py-2">
            <span className="text-sm text-body"><b className="text-ink">{km(summary.distance_km)}</b> in total</span>
            {stops.length > 1 && (summary.saving_amount > 0
              ? <span className="text-sm font-semibold text-ok">saves {money(summary.saving_amount)}</span>
              : <span className="text-xs text-warn">saves nothing over separate trucks</span>)}
          </div>
          {stops.length > 1 && (shorterBy >= 1 ? (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-warn/30 bg-warn-bg px-3 py-2 text-xs text-warn">
              <Sparkles className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1">A shorter order for these stops is {km(shorterBy)} less.</span>
              <button type="button" onClick={onUseShortest}
                className="min-h-11 rounded-md bg-content1 px-2.5 font-semibold text-warn shadow-sm hover:bg-white sm:min-h-7">
                Use shortest order
              </button>
            </div>
          ) : !measuring && (
            <div className="flex items-center gap-2 px-1 text-[11px] text-ok">
              <CheckCircle2 className="h-3.5 w-3.5" /> This is the shortest order for these stops
            </div>
          ))}
        </div>
      )}

      <NextStopPicker options={options} fromPlace={fromPlace} first={!stops.length}
        full={full} maxStops={maxStops} onAdd={onAdd} />
    </div>
  );
}

function StopRow({ stop, index, last, onDragStart, onDragEnd, onUp, onDown, onRemove }: {
  stop: ComposerStop; index: number; last: boolean;
  onDragStart: () => void; onDragEnd: () => void;
  onUp: () => void; onDown: () => void; onRemove: () => void;
}) {
  const controls = useDragControls();
  const reduce = useReducedMotion();
  return (
    <Reorder.Item value={stop.id} dragListener={false} dragControls={controls}
      onDragStart={onDragStart} onDragEnd={onDragEnd}
      transition={reduce ? { duration: 0 } : undefined}
      whileDrag={{ scale: 1.02, boxShadow: "0 12px 28px rgba(15,23,42,.18)" }}
      className="relative ml-4.25 list-none border-l-2 border-dashed border-line pb-1 pl-5 pt-3">
      <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-muted">
        <span className="rounded bg-content2 px-1.5 py-0.5">{km(stop.leg_km)}</span>
        <span>drive{index === 0 ? " from the start" : ""}</span>
      </div>
      <span className="absolute -left-3.25 top-8.5 flex h-6 w-6 items-center justify-center rounded-full bg-brand text-[11px] font-bold text-white ring-4 ring-content1">
        {index + 1}
      </span>
      <div className="flex items-center gap-1 rounded-xl border border-line bg-content1 p-2 pl-1">
        <button type="button" aria-label={`Drag ${stop.place} to change the order`} title="Drag to re-order"
          onPointerDown={(event) => controls.start(event)}
          className="flex h-11 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted hover:text-ink active:cursor-grabbing sm:h-9">
          <GripVertical className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-ink" title={stop.name}>{stop.place}</div>
          <div className="truncate text-[11px] text-muted">
            {[stop.type, stop.code].filter(Boolean).join(" · ")}
            {" · "}{stop.consignments} consignment{stop.consignments === 1 ? "" : "s"}
            {stop.weight_kg > 0 ? ` · ${Math.round(stop.weight_kg).toLocaleString("en-IN")} kg` : ""}
          </div>
        </div>
        <div className="flex shrink-0 items-center">
          <SmallBtn label={`Visit ${stop.place} earlier`} disabled={index === 0} onClick={onUp}><ArrowUp className="h-3.5 w-3.5" /></SmallBtn>
          <SmallBtn label={`Visit ${stop.place} later`} disabled={last} onClick={onDown}><ArrowDown className="h-3.5 w-3.5" /></SmallBtn>
          <SmallBtn label={`Take ${stop.place} off the route`} onClick={onRemove}><X className="h-3.5 w-3.5" /></SmallBtn>
        </div>
      </div>
    </Reorder.Item>
  );
}

function NextStopPicker({ options, fromPlace, first, full, maxStops, onAdd }: {
  options: NextStopRow[]; fromPlace: string; first: boolean; full: boolean;
  maxStops?: number; onAdd: (id: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const needle = query.trim().toLowerCase();
  const rows = needle
    ? options.filter((row) => [row.place, row.name, row.code ?? "", ...row.consignment_nos]
      .some((text) => text.toLowerCase().includes(needle)))
    : options;
  const visible = showAll || needle ? rows : rows.slice(0, 6);
  // The nearest place that can still go on — the one a person would pick next.
  const nearest = options.find((row) => !row.already && row.fits && row.distance_km != null);

  return (
    <div className="mt-4 border-t border-line p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-dashed border-brand/50 text-brand">
          <Plus className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink">{first ? "Add the first stop" : "Add the next stop"}</div>
          <div className="truncate text-[11px] text-muted">Nearest to {fromPlace} first</div>
        </div>
      </div>
      {full ? (
        <p className="rounded-lg bg-content2 px-3 py-2 text-xs text-muted">
          The route has the most stops one truck may make ({maxStops}). Take one off to add another, or change Max stops under Rules.
        </p>
      ) : !options.length ? (
        <p className="rounded-lg bg-content2 px-3 py-2 text-xs text-muted">Nothing else is packed and waiting at this origin.</p>
      ) : (
        <>
          {options.length > 6 && (
            <label className="mb-2 flex min-h-11 items-center gap-2 rounded-lg border border-line bg-content1 px-3 focus-within:border-brand sm:min-h-9">
              <Search className="h-3.5 w-3.5 text-muted" />
              <input value={query} onChange={(event) => setQuery(event.target.value)}
                placeholder="Search a place, code or consignment" aria-label="Search stops"
                className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-muted" />
            </label>
          )}
          <ul className="space-y-1.5">
            {visible.map((row) => {
              const isNearest = row === nearest;
              return (
                <li key={row.id}>
                  <button type="button" disabled={!row.fits} onClick={() => onAdd(row.id)}
                    title={row.fits ? `Add ${row.name}` : row.blocked_reason ?? "Won't fit"}
                    className={`group flex min-h-11 w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition ${!row.fits
                      ? "cursor-not-allowed border-line bg-content2/50 opacity-70"
                      : isNearest ? "border-brand/40 bg-brand-050/60 hover:border-brand"
                        : "border-line bg-content1 hover:border-brand/50 hover:bg-brand-050/40"}`}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-ink">{row.place}</span>
                        {isNearest && <span className="shrink-0 rounded-full bg-brand px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-white">Nearest</span>}
                      </div>
                      <div className="truncate text-[11px] text-muted">
                        {row.already ? "Already a stop — " : ""}
                        {row.consignment_nos.length} consignment{row.consignment_nos.length === 1 ? "" : "s"}
                        {row.weight_kg > 0 ? ` · ${Math.round(row.weight_kg).toLocaleString("en-IN")} kg` : ""}
                        {row.type ? ` · ${row.type}` : ""}
                      </div>
                      {!row.fits && row.blocked_reason && (
                        <div className="flex items-center gap-1 text-[11px] text-bad"><AlertTriangle className="h-3 w-3" /> Won't fit: {row.blocked_reason}</div>
                      )}
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-sm font-semibold text-ink">{row.already ? "+0 km" : km(row.distance_km)}</div>
                      {row.saves_km != null && !row.already && row.fits && (
                        <div className={`text-[10px] ${row.saves_km > 0 ? "text-ok" : "text-warn"}`}>
                          {row.saves_km > 0 ? `saves ${km(row.saves_km)}` : `${km(-row.saves_km)} extra`}
                        </div>
                      )}
                    </div>
                    <Plus className="h-4 w-4 shrink-0 text-muted transition group-hover:text-brand" />
                  </button>
                </li>
              );
            })}
          </ul>
          {!needle && rows.length > 6 && (
            <button type="button" onClick={() => setShowAll((on) => !on)}
              className="mt-2 min-h-11 w-full rounded-lg text-xs font-medium text-brand hover:bg-brand-050 sm:min-h-8">
              {showAll ? "Show fewer" : `Show all ${rows.length} places`}
            </button>
          )}
          {needle && !rows.length && <p className="px-1 text-xs text-muted">No place matches “{query}”.</p>}
        </>
      )}
    </div>
  );
}

function SmallBtn({ label, onClick, disabled, children }: {
  label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled}
      className="flex h-11 w-9 items-center justify-center rounded-md text-muted transition hover:bg-content2 hover:text-ink disabled:opacity-25 sm:h-8 sm:w-7">
      {children}
    </button>
  );
}
