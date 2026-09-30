import { useState } from "react";
import {
  AlertTriangle, ChevronDown, MapPin, Pencil, RefreshCw, Truck, Warehouse,
} from "lucide-react";
import { ROUTE_COLORS } from "./ApMap3D";
import { fillTone } from "./tripLoad";
import { placeOf } from "./plannerRoute";
import type { PlannedTrip, TripRecommendations } from "../transportTypes";

/**
 * The planner's suggestions, said the way a dispatcher says them: "Truck 1 goes
 * Badangi → Bapulapadu → Chataparru and saves ₹19,641." One card per truck, one line
 * of facts, one bar for how full it is — every figure the server's. The route colour
 * on each card is the colour of that route on the map, so the two read as one thing.
 *
 * What the planner could NOT put on a truck is one tucked-away list, not two cards
 * competing with the suggestions for attention.
 */

const money = (value: number | string | null | undefined) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 })
    .format(Number(value ?? 0));
const km = (value: number | string | null | undefined) =>
  `${Number(value ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })} km`;

/** How full the truck is by whichever of weight and volume is fuller — the one
 *  that stops the next carton going on. */
export function fullness(trip: Pick<PlannedTrip, "capacity_utilisation_pct" | "volume_utilisation_pct">) {
  const weight = Number(trip.capacity_utilisation_pct ?? 0);
  const volume = trip.volume_utilisation_pct == null ? null : Number(trip.volume_utilisation_pct);
  return volume != null && volume > weight
    ? { pct: volume, by: "space" as const } : { pct: weight, by: "weight" as const };
}

export function FillMeter({ pct, by }: { pct: number; by: "weight" | "space" }) {
  const tone = fillTone(pct);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-content2" role="meter"
        aria-label={`Truck full by ${by}`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full rounded-full ${tone === "bad" ? "bg-bad" : tone === "warn" ? "bg-warn" : "bg-ok"}`}
          style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} />
      </div>
      <span className="shrink-0 text-[11px] text-muted">{Math.round(pct)}% full</span>
    </div>
  );
}

export function PlannerSuggestions({
  plan, originPlace, selectedKey, onUse, onEdit, onAddSingle, onLocate, canLocate,
  onRematch, rematching, unresolved,
}: {
  plan: TripRecommendations;
  originPlace: string;
  selectedKey: string | null;
  onUse: (trip: PlannedTrip) => void;
  onEdit: (trip: PlannedTrip) => void;
  onAddSingle: (destinationId: number) => void;
  onLocate: (target: { id: number; name: string }) => void;
  canLocate: boolean;
  onRematch: () => void;
  rematching: boolean;
  unresolved: number;
}) {
  const [showLeftOut, setShowLeftOut] = useState(false);
  const leftOut = plan.singles.length + plan.excluded.length;

  return (
    <div className="space-y-3">
      {!plan.trips.length && (
        <div className="rounded-2xl border border-dashed border-line bg-content1 p-5 text-center">
          <Truck className="mx-auto h-6 w-6 text-muted" />
          <div className="mt-2 font-semibold text-ink">Nothing combines today</div>
          <p className="mt-1 text-sm text-muted">{plan.candidates.length < 2
            ? "A trip needs at least two packed consignments going to places on the map."
            : "The ready consignments are going in different directions, so each one is cheaper on its own truck. You can still combine them yourself under Build my own."}</p>
        </div>
      )}

      {plan.trips.map((trip, index) => {
        const active = trip.key === selectedKey;
        const [from, to] = ROUTE_COLORS[index % ROUTE_COLORS.length];
        const fill = fullness(trip);
        const shown = trip.stops.slice(0, 4);
        const more = trip.stops.length - shown.length;
        return (
          <article key={trip.key}
            className={`rounded-2xl border bg-content1 p-4 transition ${active
              ? "border-brand shadow-md ring-2 ring-brand/15" : "border-line hover:border-brand/40 hover:shadow-sm"}`}>
            <button type="button" className="block w-full text-left" onClick={() => onUse(trip)}
              aria-pressed={active} aria-label={`Truck ${index + 1}: ${trip.stops.map(placeOf).join(", then ")}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: `linear-gradient(135deg, ${from}, ${to})` }} />
                  <span className="font-display text-base font-semibold text-ink">Truck {index + 1}</span>
                  {index === 0 && plan.trips.length > 1 && (
                    <span className="rounded-full bg-ok-bg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ok">Best</span>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-lg font-bold leading-tight text-ok">{money(trip.estimated_saving_amount)}</div>
                  <div className="text-[11px] text-muted">saved · {trip.saving_pct}% less driving</div>
                </div>
              </div>

              <ol className="mt-3 flex flex-wrap items-center gap-x-1 gap-y-1.5 text-xs" aria-hidden>
                <li className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-900 dark:bg-amber-400/15 dark:text-amber-200">
                  <Warehouse className="h-3 w-3" />{originPlace}
                </li>
                {shown.map((stop) => (
                  <li key={stop.destination_warehouse_id} className="flex items-center gap-1">
                    <span className="text-muted">→</span>
                    <span className="flex items-center gap-1 rounded-full bg-content2 px-2 py-0.5 text-body" title={stop.destination_name}>
                      <b className="text-[10px] text-brand">{stop.sequence}</b>{placeOf(stop)}
                    </span>
                  </li>
                ))}
                {more > 0 && <li className="text-muted">→ +{more} more</li>}
              </ol>

              <div className="mt-3 text-xs text-body">
                <b>{trip.stops.length} stop{trip.stops.length === 1 ? "" : "s"}</b> · {trip.total_consignments} consignments
                {" "}· <b>{km(trip.estimated_distance_km)}</b>
                <span className="text-muted"> instead of {km(trip.separate_distance_km)}</span>
              </div>
              <div className="mt-2"><FillMeter {...fill} /></div>
              {!!trip.warnings.length && (
                <div className="mt-2 flex items-center gap-1.5 text-[11px] text-warn" title={trip.warnings.join("\n")}>
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{trip.blockers?.length ? trip.blockers[0] : "Loads are estimated — weigh cartons to be sure"}</span>
                </div>
              )}
            </button>
            <div className="mt-3 flex gap-2 border-t border-line pt-3">
              <button type="button" onClick={() => onUse(trip)}
                className={`min-h-11 flex-1 rounded-lg px-3 text-sm font-semibold transition sm:min-h-9 ${active
                  ? "bg-brand text-white" : "bg-brand-050 text-brand hover:bg-brand hover:text-white"}`}>
                {active ? "Selected — review below" : "Use this trip"}
              </button>
              <button type="button" onClick={() => onEdit(trip)}
                className="flex min-h-11 items-center gap-1.5 rounded-lg border border-line px-3 text-sm text-body transition hover:border-brand/50 hover:text-brand sm:min-h-9">
                <Pencil className="h-3.5 w-3.5" /> Change
              </button>
            </div>
          </article>
        );
      })}

      {leftOut > 0 && (
        <div className="rounded-2xl border border-line bg-content1">
          <button type="button" onClick={() => setShowLeftOut((on) => !on)} aria-expanded={showLeftOut}
            className="flex min-h-11 w-full items-center justify-between gap-2 px-4 py-3 text-left">
            <span className="text-sm font-semibold text-ink">
              Not in a suggested trip <span className="ml-1 rounded-full bg-content2 px-2 py-0.5 text-xs text-muted">{leftOut}</span>
            </span>
            <ChevronDown className={`h-4 w-4 text-muted transition ${showLeftOut ? "rotate-180" : ""}`} />
          </button>
          {showLeftOut && (
            <div className="space-y-4 border-t border-line px-4 pb-4 pt-3">
              {!!plan.singles.length && (
                <section>
                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Better on their own truck</div>
                  <ul className="space-y-2">
                    {plan.singles.map((row) => (
                      <li key={row.dispatch_id} className="flex items-start gap-2 text-xs">
                        <Truck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
                        <div className="min-w-0 flex-1">
                          <div><b className="text-ink" title={row.destination_name}>{placeOf(row)}</b> <span className="font-mono text-muted">{row.consignment_no}</span></div>
                          <div className="text-muted">{row.reason}</div>
                        </div>
                        <button type="button" onClick={() => onAddSingle(row.destination_warehouse_id)}
                          className="min-h-11 shrink-0 text-brand hover:underline sm:min-h-0">Add to my route</button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {!!plan.excluded.length && (
                <section>
                  <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted">
                    Can't be routed yet
                    {canLocate && unresolved > 0 && (
                      <button type="button" disabled={rematching} onClick={onRematch}
                        className="flex min-h-11 items-center gap-1 normal-case tracking-normal text-brand hover:underline disabled:opacity-50 sm:min-h-0"
                        title={`Match the ${unresolved} unmapped stocking points against the gazetteer again`}>
                        <RefreshCw className={`h-3 w-3 ${rematching ? "animate-spin" : ""}`} /> Re-match names
                      </button>
                    )}
                  </div>
                  <ul className="space-y-2">
                    {plan.excluded.map((row) => (
                      <li key={row.dispatch_id} className="flex items-start gap-2 text-xs">
                        <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
                        <div className="min-w-0 flex-1">
                          <div>{row.destination_name && <b className="text-ink" title={row.destination_name}>{placeOf(row)} </b>}
                            <span className="font-mono text-muted">{row.consignment_no}</span></div>
                          <div className="text-muted">{row.reason}</div>
                        </div>
                        {row.can_pin && row.destination_warehouse_id && canLocate && (
                          <button type="button" className="min-h-11 shrink-0 text-brand hover:underline sm:min-h-0"
                            onClick={() => onLocate({ id: row.destination_warehouse_id!, name: row.destination_name ?? "this point" })}>
                            Locate
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
