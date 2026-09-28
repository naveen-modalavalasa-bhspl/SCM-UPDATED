import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { LayoutGroup, motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle, CheckCircle2, ChevronDown, CornerDownLeft, Hand, IndianRupee, MapPin,
  MapPinned, Package, Pencil, RefreshCw, Route, Scale, Settings2, Sparkles, Truck, Warehouse, X,
} from "lucide-react";
import {
  Alert, Button, Card, ConfirmModal, ErrorBanner, Field, Input, KpiTiles, PageHeader,
  ResponsiveList, Select, StatusPill, Textarea, useAction, type Column, type KpiTileSpec,
} from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { fmtDate, todayIst } from "@/shared/datetime";
import { tripApi } from "../api";
import { ApMap3D, ROUTE_COLORS, type MapPin as MapPinSpec, type MapRoute } from "../components/ApMap3D";
import { insideAp, parseCoordinates } from "../components/apGeo";
import { TRIP_STATUS_WORDS, tripProgress } from "../components/tripCopy";
import { MeasureModal, PointLocatorModal } from "../components/PlannerModals";
import { FillMeter, PlannerSuggestions, fullness } from "../components/PlannerSuggestions";
import { RouteComposer, type ComposerStop, type NextStopRow } from "../components/RouteComposer";
import {
  addStop, destinationsOf, placeOf, removeStop, routeOrder, toggleStop, type RouteState,
} from "../components/plannerRoute";
import {
  cbm, distanceWord, kg, needsMeasuring, volumeText, weightText,
} from "../components/tripLoad";
import type {
  ConsolidatedTrip, PlanConsignment, PlannedTrip, PolicyOverrides,
} from "../transportTypes";

/**
 * Smart Load Planner — "these ten packed consignments, which of them share a road?"
 *
 * Pick where the truck starts, then one of two doors onto the same manifest:
 *   - SUGGESTED: the planner groups the consignments on the same road into as few
 *     vehicles as fit (`PlannerSuggestions`) — take one as it is, or change it.
 *   - BUILD MY OWN: the desk names the stops in the order the truck drives them
 *     (`RouteComposer`), each measured from the last; the order is sent in full, so
 *     the server measures exactly the route that was arranged.
 * A beam on the map is the same edit as the builder. Then Plan trip: the consignments
 * are reserved and ONE shipment is drafted for the whole run. From there it is the ordinary Dispatch screen — mode, provider,
 * price — and every site signs for its own consignment when the truck calls.
 *
 * Every number on this page is the server's (`warehouse/trips.py`); the page only
 * says which consignments and which order.
 */

const money = (value: number | string | null | undefined) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 })
    .format(Number(value ?? 0));
const km = (value: number | string | null | undefined) =>
  `${Number(value ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 1 })} km`;
const num = (value: unknown) => (value == null || value === "" ? null : Number(value));
const RANK: Record<string, number> = { MAIN: 0, MDP: 1, LIP: 2 };

type Tab = "plan" | "trips";

export function SmartLoadPlannerPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "trips" ? "trips" : "plan";
  const setTab = (next: Tab) => {
    const copy = new URLSearchParams(params);
    if (next === "plan") copy.delete("tab"); else copy.set("tab", next);
    setParams(copy, { replace: true });
  };
  const trips = useQuery({
    queryKey: ["consolidated-trips", "active-count"],
    queryFn: () => tripApi.list({ status: "ACTIVE", size: 1 }),
  });

  return (
    <div>
      <PageHeader eyebrow="Logistics" title="Smart Load Planner" actions={
        <div className="flex rounded-lg border border-line bg-content1 p-1" role="tablist">
          {([["plan", "Plan a trip", Sparkles], ["trips", "Trips", Route]] as const).map(([key, label, Icon]) => (
            <button key={key} type="button" role="tab" aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`flex min-h-11 items-center gap-2 rounded-md px-3 text-sm font-medium transition sm:min-h-9 ${
                tab === key ? "bg-brand text-white shadow-sm" : "text-muted hover:text-ink"}`}>
              <Icon className="h-4 w-4" />{label}
              {key === "trips" && !!trips.data?.total && (
                <span className={`rounded-full px-1.5 text-[11px] ${tab === key ? "bg-white/25" : "bg-brand-050 text-brand"}`}>
                  {trips.data.total}
                </span>
              )}
            </button>
          ))}
        </div>
      } />
      {tab === "plan" ? <PlanTab onPlanned={() => trips.refetch()} /> : <TripsTab />}
    </div>
  );
}

// --------------------------------------------------------------------------- //
//  Plan
// --------------------------------------------------------------------------- //

type Mode = "suggested" | "manual";

function PlanTab({ onPlanned }: { onPlanned: () => void }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const [originId, setOriginId] = useState<number | null>(null);
  const [profileCode, setProfileCode] = useState<string>("");
  const [overrides, setOverrides] = useState<PolicyOverrides>({});
  const [departure, setDeparture] = useState(todayIst());
  const [tuning, setTuning] = useState(false);
  // Two ways to the same manifest: take a suggestion, or build the route by hand.
  const [mode, setMode] = useState<Mode>("suggested");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selection, setSelection] = useState<number[]>([]);
  // Destination ids in the order the desk arranged them. null = the server orders.
  const [stopOrder, setStopOrder] = useState<number[] | null>(null);
  const [pinning, setPinning] = useState<{ id: number; name: string } | null>(null);
  const [pinned, setPinned] = useState<{ lat: number; lon: number } | null>(null);
  const [pinText, setPinText] = useState("");
  const [pinLabel, setPinLabel] = useState<string | null>(null);
  // The locator opens first; the map's pick mode only once the desk asks for it.
  const [locating, setLocating] = useState(false);
  const [measuring, setMeasuring] = useState<{ dispatch_id: number; consignment_no: string } | null>(null);
  const [remarks, setRemarks] = useState("");
  const manifestRef = useRef<HTMLDivElement>(null);
  const startPin = (target: { id: number; name: string }) => {
    setPinning(target); setPinned(null); setPinText(""); setPinLabel(null); setLocating(true);
  };

  const network = useQuery({
    queryKey: ["trip-map-network"], queryFn: tripApi.network, staleTime: 10 * 60_000,
  });
  const policyQuery = useQuery({ queryKey: ["trip-planner-policy"], queryFn: tripApi.policy });
  const profiles = policyQuery.data?.vehicle_profiles ?? [];
  const profile = profiles.find((row) => row.code === profileCode);

  // The vehicle sets capacity, package limit and rate; a tuned value wins over both.
  const effective: PolicyOverrides = useMemo(() => ({
    ...(profile ? {
      capacity_kg: profile.capacity_kg, max_packages: profile.max_packages,
      capacity_cbm: profile.capacity_cbm ?? 0,
      cost_per_km: profile.cost_per_km || undefined,
    } : {}),
    ...overrides,
  }), [profile, overrides]);

  const points = network.data?.points ?? [];
  const mapped = useMemo(() => points.filter((p) => num(p.latitude) != null && num(p.longitude) != null), [points]);
  const origins = useMemo(() => [...points].sort((a, b) =>
    (RANK[a.warehouse_type ?? ""] ?? 3) - (RANK[b.warehouse_type ?? ""] ?? 3)
    || a.name.localeCompare(b.name)), [points]);
  const origin = points.find((p) => p.id === originId) ?? null;
  const originMapped = origin != null && num(origin.latitude) != null;

  // Default to the first central warehouse ON THE MAP — that is where multi-drop runs
  // start, and one that is not located can plan nothing. Only if none is, the first.
  useEffect(() => {
    if (originId == null && origins.length) {
      setOriginId((origins.find((row) => num(row.latitude) != null) ?? origins[0]).id);
    }
  }, [origins, originId]);
  useEffect(() => {
    if (!profileCode && profiles.length) {
      const site = policyQuery.data?.policy.capacity_kg;
      setProfileCode((profiles.find((row) => row.capacity_kg === site) ?? profiles[Math.min(2, profiles.length - 1)]).code);
    }
  }, [profiles, profileCode, policyQuery.data]);

  const recommend = useQuery({
    queryKey: ["trip-recommendations", originId, effective, departure],
    queryFn: () => tripApi.recommend({ warehouse_id: originId!, departure_date: departure, ...effective }),
    enabled: originId != null && originMapped,
    placeholderData: keepPreviousData,
  });
  const plan = recommend.data?.origin.id === originId ? recommend.data : undefined;
  const candidates = useMemo(() => plan?.candidates ?? [], [plan]);
  const destinations = useMemo(() => destinationsOf(candidates), [candidates]);
  const originPlace = plan?.origin.place || origin?.name || "Origin";

  // The order actually on the route — the desk's, less any place nothing rides to.
  const order = useMemo(() => stopOrder ? routeOrder(stopOrder, selection, candidates) : null,
    [stopOrder, selection, candidates]);

  const evaluation = useQuery({
    queryKey: ["trip-evaluate", originId, selection, order, effective, departure],
    queryFn: () => tripApi.evaluate({
      warehouse_id: originId!, dispatch_ids: selection, stop_order: order,
      departure_date: departure, ...effective,
    }),
    enabled: originId != null && originMapped && selection.length > 0,
    placeholderData: keepPreviousData,
  });
  const built = selection.length ? evaluation.data : undefined;
  // The figures describe THIS route only once the server has answered for it.
  const fresh = !!built && !evaluation.isPlaceholderData;

  // A new origin is a new morning: nothing chosen carries over.
  useEffect(() => { setSelectedKey(null); setSelection([]); setStopOrder(null); }, [originId]);

  const current = (): RouteState => ({
    selection,
    order: order ?? routeOrder(built?.stops.map((stop) => stop.destination_warehouse_id) ?? [],
      selection, candidates),
  });
  const setRoute = (next: RouteState) => {
    setSelectedKey(null); setSelection(next.selection); setStopOrder(next.order);
  };
  const showManifest = () => window.setTimeout(() =>
    manifestRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);

  const choose = (trip: PlannedTrip) => {
    setSelectedKey(trip.key ?? null);
    setSelection(trip.consignments.map((row) => row.dispatch_id));
    setStopOrder(null);
    showManifest();
  };
  const editTrip = (trip: PlannedTrip) => {
    setMode("manual");
    setSelectedKey(null);
    setSelection(trip.consignments.map((row) => row.dispatch_id));
    setStopOrder(trip.stops.map((stop) => stop.destination_warehouse_id));
  };
  const switchMode = (next: Mode) => {
    // Going manual keeps whatever is on the truck, in the order it is being driven.
    if (next === "manual" && stopOrder == null && selection.length) setStopOrder(current().order);
    setMode(next);
  };
  const addPlace = (destId: number) => {
    const base = current();
    setMode("manual");
    setRoute(addStop(base, destId, candidates));
  };
  const removePlace = (destId: number) => setRoute(removeStop(current(), destId, candidates));
  const clearRoute = () => {
    setSelection([]); setSelectedKey(null); setStopOrder(mode === "manual" ? [] : null);
  };
  const toggleConsignment = (dispatchId: number) => {
    setSelectedKey(null);
    setSelection((now) => now.includes(dispatchId) ? now.filter((id) => id !== dispatchId) : [...now, dispatchId]);
  };

  const create = useAction({
    run: () => tripApi.create({
      warehouse_id: originId!, dispatch_ids: selection, stop_order: order,
      departure_date: departure, policy_name: built?.label || "Smart Load Planner",
      vehicle_profile: profile?.label ?? null, remarks: remarks || null, ...effective,
    }),
    success: (trip) => ({
      title: `${trip.trip_no} planned`,
      message: `${trip.total_consignments} consignments reserved on one truck. Shipment ${trip.tr_no} is drafted — choose how it travels on the Dispatch screen.`,
    }),
    invalidates: [["trip-recommendations"], ["trip-evaluate"], ["consolidated-trips"],
      ["lgs-dispatch-queue"], ["lgs-consignment-links"], ["transport"]],
    // Straight into the ordinary flow: a trip is one shipment, arranged on the same
    // Dispatch screen as any consignment, then priced and followed like any other.
    onDone: (trip) => {
      onPlanned();
      nav(trip.tr_id ? `/logistics/dispatch/new?tr_id=${trip.tr_id}` : `/logistics/load-planner/trips/${trip.id}`);
    },
  });

  const pin = useAction({
    run: () => tripApi.pin(pinning!.id, { latitude: pinned!.lat, longitude: pinned!.lon, label: pinLabel }),
    success: (point) => `${point.name} pinned on the map`,
    invalidates: [["trip-map-network"], ["trip-recommendations"], ["trip-evaluate"]],
    onDone: () => { setPinning(null); setPinned(null); setPinText(""); setPinLabel(null); },
  });
  const rematch = useAction({
    run: tripApi.rematch,
    success: (result) => result.mapped
      ? `${result.mapped} more stocking point${result.mapped === 1 ? "" : "s"} placed; ${result.still_unresolved} still need a pin`
      : `No new matches — ${result.still_unresolved} points still need a pin`,
    invalidates: [["trip-map-network"], ["trip-recommendations"]],
  });

  // ------------------------------------------------------------ the hand-built route
  const composerStops: ComposerStop[] = useMemo(() => {
    const byDest = new Map(destinations.map((dest) => [dest.id, dest]));
    return (order ?? []).flatMap((destId) => {
      const dest = byDest.get(destId);
      if (!dest) return [];
      const riding = candidates.filter((row) => row.destination_warehouse_id === destId
        && selection.includes(row.dispatch_id));
      const served = fresh ? built!.stops.find((stop) => stop.destination_warehouse_id === destId) : undefined;
      return [{
        id: destId, place: dest.place, name: dest.name, type: dest.type, code: dest.code,
        consignments: riding.length,
        packages: riding.reduce((sum, row) => sum + (row.packages || 0), 0),
        weight_kg: riding.reduce((sum, row) => sum + (row.weight_kg || 0), 0),
        leg_km: served?.distance_from_previous_km ?? null,
      }];
    });
  }, [order, destinations, candidates, selection, fresh, built]);

  const nextStops: NextStopRow[] = useMemo(() => {
    if (!order?.length) {
      return destinations.map((dest) => ({
        id: dest.id, place: dest.place, name: dest.name, type: dest.type, code: dest.code,
        consignment_nos: dest.consignment_nos, weight_kg: dest.weight_kg,
        distance_km: dest.direct_km, saves_km: null, fits: true, already: false,
      }));
    }
    if (fresh && built?.next_stops) {
      return built.next_stops.map((row) => ({
        id: row.destination_warehouse_id, place: row.destination_place, name: row.destination_name,
        type: row.destination_type, code: row.destination_code, consignment_nos: row.consignment_nos,
        weight_kg: row.weight_kg, distance_km: row.from_last_km, saves_km: row.saves_km,
        fits: row.fits, blocked_reason: row.blocked_reason, already: row.already_a_stop,
      }));
    }
    // Still measuring from the new last stop: the same places, distances pending.
    return destinations.filter((dest) => dest.dispatch_ids.some((id) => !selection.includes(id)))
      .map((dest) => ({
        id: dest.id, place: dest.place, name: dest.name, type: dest.type, code: dest.code,
        consignment_nos: dest.consignment_nos.filter((_, i) => !selection.includes(dest.dispatch_ids[i])),
        weight_kg: dest.weight_kg, distance_km: null, saves_km: null, fits: true,
        already: order.includes(dest.id),
      }));
  }, [order, destinations, fresh, built, selection]);
  const lastStop = composerStops[composerStops.length - 1];

  // ------------------------------------------------------------ the map
  const routes: MapRoute[] = useMemo(() => {
    const out: MapRoute[] = [];
    // Building by hand, the suggestions are noise on the map; picking, they are the menu.
    if (mode === "suggested") {
      (plan?.trips ?? []).forEach((trip, index) => {
        if (trip.key === selectedKey && built) return;
        out.push({
          key: trip.key ?? String(index), emphasis: built ? "ghost" : (trip.key === (selectedKey ?? plan?.trips[0]?.key) ? "active" : "ghost"),
          returnToOrigin: plan?.policy.return_to_origin, colors: ROUTE_COLORS[index % ROUTE_COLORS.length],
          stops: trip.stops.map((stop) => ({
            key: stop.destination_warehouse_id, lat: stop.latitude, lon: stop.longitude,
            label: stop.destination_name, sequence: stop.sequence, count: stop.consignments.length,
          })),
        });
      });
    }
    if (built && built.stops.length) {
      const index = (plan?.trips ?? []).findIndex((trip) => trip.key === selectedKey);
      out.push({
        key: "built", emphasis: "active", returnToOrigin: built.policy.return_to_origin,
        colors: index >= 0 ? ROUTE_COLORS[index % ROUTE_COLORS.length] : ["#f472b6", "#facc15"],
        stops: built.stops.map((stop) => ({
          key: stop.destination_warehouse_id, lat: stop.latitude, lon: stop.longitude,
          label: stop.destination_name, sequence: stop.sequence, count: stop.consignments.length,
        })),
      });
    }
    return out;
  }, [plan, built, selectedKey, mode]);

  const pins: MapPinSpec[] = useMemo(() => {
    const byDest = new Map<number, { rows: PlanConsignment[] }>();
    for (const row of candidates) {
      const entry = byDest.get(row.destination_warehouse_id) ?? { rows: [] };
      entry.rows.push(row);
      byDest.set(row.destination_warehouse_id, entry);
    }
    return [...byDest.values()].map(({ rows }) => {
      const picked = rows.some((row) => selection.includes(row.dispatch_id));
      return {
        key: rows[0].dispatch_id, lat: rows[0].latitude, lon: rows[0].longitude,
        label: `${rows[0].destination_name} — ${rows.map((row) => row.consignment_no).join(", ")}`,
        weight: rows.reduce((sum, row) => sum + (row.weight_kg || 0) + row.packages * 8, 0),
        tone: picked ? "picked" : selection.length ? "dim" : "ready",
      } satisfies MapPinSpec;
    });
  }, [candidates, selection]);

  // A beam is a stocking point: clicking it puts that stop on the route next, or
  // takes it off — the same edit as the route builder, so the two never disagree.
  const pinClick = (key: string | number) => {
    const row = candidates.find((c) => c.dispatch_id === key);
    if (!row) return;
    const base = current();
    setMode("manual");
    setRoute(toggleStop(base, row.destination_warehouse_id, candidates));
  };

  const totals = plan?.totals;
  const tiles: KpiTileSpec[] = [
    { key: "ready", label: "Ready to dispatch", icon: Package, tone: "brand",
      value: originMapped ? totals?.consignments : 0, hint: "Packed consignments at this origin that can be routed" },
    { key: "trucks", label: "Trucks: separately → planned", icon: Truck, tone: "info",
      value: totals ? `${totals.vehicles_before} → ${totals.vehicles_after}` : originMapped ? undefined : "—" },
    { key: "km", label: `${plan?.policy.routing?.routed_pairs ? "Road" : "Estimated"} km saved`, icon: Route, tone: "ok",
      value: totals ? `${Math.round(totals.saving_km).toLocaleString("en-IN")} (${totals.saving_pct}%)` : originMapped ? undefined : "—" },
    { key: "money", label: "Estimated freight saved", icon: IndianRupee, tone: "ok",
      value: totals ? money(totals.saving_amount) : originMapped ? undefined : "—" },
  ];

  const pickMode = pinning && !locating ? {
    label: `Click where ${pinning.name} actually is — zoom in first for accuracy`,
    onPick: (lat: number, lon: number) => { setPinned({ lat, lon }); setPinText(`${lat}, ${lon}`); setPinLabel(null); },
    onCancel: () => setPinning(null),
  } : null;
  const rechecked = network.data?.rechecked;
  const updatedAt = recommend.dataUpdatedAt
    ? new Date(recommend.dataUpdatedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : null;

  return (
    <div className="space-y-5">
      <Card className="p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_minmax(0,.8fr)_auto]">
          <Field label="Truck starts from">
            <Select value={originId ?? ""} ariaLabel="Origin stocking point" searchable
              onChange={(value) => setOriginId(value ? Number(value) : null)}
              placeholder={network.isLoading ? "Locating stocking points…" : "Choose the origin"}
              options={origins.map((row) => ({
                value: row.id,
                label: `${row.warehouse_type ?? ""} · ${row.name} (${row.code})${num(row.latitude) == null
                  ? " — not on map yet" : row.coordinate_source === "MANUAL" ? " · pinned"
                    : row.coordinate_source === "HCM" ? " · GPS from HCM" : ""}`,
              }))} />
          </Field>
          <Field label="Vehicle">
            <Select value={profileCode} ariaLabel="Vehicle" onChange={(value) => {
              setProfileCode(value);
              setOverrides(({ capacity_kg: _c, max_packages: _p, cost_per_km: _r, capacity_cbm: _v, ...rest }) => rest);
            }} options={profiles.map((row) => ({ value: row.code, label: row.label }))}
              placeholder={policyQuery.isLoading ? "Loading fleet…" : "Choose a vehicle"} />
          </Field>
          <Field label="Leaves on">
            <Input type="date" value={departure} min={todayIst()} onChange={(e) => setDeparture(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button variant="subtle" onClick={() => setTuning((on) => !on)} className="w-full">
              <Settings2 className="h-4 w-4" /> Rules
              <ChevronDown className={`h-4 w-4 transition ${tuning ? "rotate-180" : ""}`} />
            </Button>
          </div>
        </div>
        {tuning && <PolicyPanel base={{ ...policyQuery.data?.policy, ...(plan ? { distance_basis: plan.policy.distance_basis } : {}), ...effective }} onChange={(patch) =>
          setOverrides((now) => ({ ...now, ...patch }))}
          onReset={() => setOverrides({})} canSave={can("admin.settings.manage")} />}
      </Card>

      <KpiTiles label="Planning summary" tiles={tiles} />
      <ErrorBanner error={network.error ?? policyQuery.error ?? recommend.error ?? rematch.error} />
      {!!rechecked && (rechecked.moved > 0 || rechecked.withdrawn > 0 || rechecked.mapped > 0) && (
        <Alert tone="info">
          The map matcher improved and re-checked every automatic point: {rechecked.mapped} newly placed,
          {" "}{rechecked.moved} moved into their own district, {rechecked.withdrawn} withdrawn because they
          could not be confirmed there. Pins set by hand were not touched.
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.75fr)_minmax(340px,1fr)]">
        <div className="relative">
          <ApMap3D
            nodes={mapped.map((p) => ({ id: p.id, lat: Number(p.latitude), lon: Number(p.longitude),
              name: p.name, code: p.code, kind: p.warehouse_type }))}
            origin={originMapped ? { lat: Number(origin!.latitude), lon: Number(origin!.longitude), name: origin!.name } : null}
            routes={routes} pins={pins} height={560}
            focusKey={`${originId}|${selectedKey ?? ""}|${built ? "built" : ""}|${plan ? "plan" : ""}`}
            title="Andhra Pradesh stocking network"
            subtitle={network.data ? `${network.data.mapped.toLocaleString("en-IN")} of ${network.data.total.toLocaleString("en-IN")} points on the map` : "Locating stocking points…"}
            badge={built ? <span className="rounded-full border border-pink-300/40 bg-pink-500/20 px-3 py-1 text-[11px] text-pink-50">
              Building: {built.total_consignments} consignments · {built.stops.length} stops
            </span> : null}
            pickMode={pickMode} onPinClick={pinClick}
            onRouteClick={(key) => { const trip = plan?.trips.find((t) => t.key === key); if (trip) choose(trip); }}
          >
          {origin && !originMapped && !pinning && (
            <div className="absolute inset-x-6 bottom-14 mx-auto max-w-lg rounded-xl border border-amber-300/40 bg-slate-950/85 p-4 text-sm text-amber-50 backdrop-blur">
              <div className="flex items-start gap-3">
                <MapPinned className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{origin.name} is not on the map yet</div>
                  <p className="mt-1 text-xs text-amber-100/80">The planner measures every route from the origin's gate, so it needs that one point. Pin it once — it is kept on the warehouse master.</p>
                  {can("master.location.manage")
                    ? <Button className="mt-3" onClick={() => startPin({ id: origin.id, name: origin.name })}><MapPin className="h-4 w-4" /> Pin {origin.warehouse_type === "MAIN" ? "the central warehouse" : "it"} on the map</Button>
                    : <p className="mt-2 text-xs">Ask an administrator to pin it, or to enter its coordinates in Warehouse Masters.</p>}
                </div>
              </div>
            </div>
          )}
          </ApMap3D>
        </div>

        <div className="space-y-3">
          <ModeSwitch mode={mode} onChange={switchMode} suggestions={plan?.trips.length ?? 0} stops={order?.length ?? 0} />
          <div className="flex items-center justify-between gap-2 px-1 text-[11px] text-muted">
            <span className={`flex min-w-0 items-center gap-1 ${plan?.policy.routing?.service_error ? "text-warn" : ""}`}>
              <Route className="h-3 w-3 shrink-0" />
              <span className="truncate">{plan?.policy.routing?.text ?? "Distances from the planner"}</span>
            </span>
            {originMapped && (
              <button type="button" onClick={() => recommend.refetch()} disabled={recommend.isFetching}
                title="Read what is packed and waiting again"
                className="flex min-h-11 shrink-0 items-center gap-1 rounded px-1 hover:text-brand disabled:opacity-60 sm:min-h-0">
                <RefreshCw className={`h-3 w-3 ${recommend.isFetching ? "animate-spin" : ""}`} />
                {recommend.isFetching ? "Updating…" : updatedAt ? `Updated ${updatedAt}` : "Refresh"}
              </button>
            )}
          </div>

          {!originMapped && <Card className="p-5 text-sm text-muted">Choose an origin that is on the map to see what can travel together.</Card>}
          {originMapped && !plan && recommend.isLoading && (
            <div className="space-y-3" aria-busy>
              {[0, 1].map((i) => <div key={i} className="h-44 animate-pulse rounded-2xl bg-content2" />)}
            </div>
          )}
          {originMapped && plan && mode === "suggested" && (
            <PlannerSuggestions plan={plan} originPlace={originPlace} selectedKey={selectedKey}
              onUse={choose} onEdit={editTrip} onAddSingle={addPlace}
              onLocate={startPin} canLocate={can("master.location.manage")}
              onRematch={() => rematch.mutate()} rematching={rematch.isPending}
              unresolved={network.data?.unresolved ?? 0} />
          )}
          {originMapped && plan && mode === "manual" && (
            <RouteComposer originPlace={originPlace} originName={origin?.name ?? ""}
              stops={composerStops} options={nextStops}
              fromPlace={lastStop ? lastStop.place : originPlace}
              onReorder={(next) => { setSelectedKey(null); setStopOrder(next); }}
              onRemove={removePlace} onAdd={addPlace} onClear={clearRoute}
              summary={fresh && built ? {
                distance_km: built.estimated_distance_km, return_km: built.return_km,
                saving_amount: built.estimated_saving_amount, saving_km: built.estimated_saving_km,
                order_is_optimal: built.order_is_optimal, optimal_distance_km: built.optimal_distance_km,
              } : null}
              onUseShortest={() => { if (built?.optimal_order) setStopOrder(built.optimal_order); }}
              measuring={evaluation.isFetching || (selection.length > 0 && !fresh)}
              maxStops={built?.policy.max_stops ?? plan.policy.max_stops} />
          )}
        </div>
      </div>

      {selection.length > 0 && (
        <div ref={manifestRef} className="scroll-mt-4">
          <TripBuilder
            evaluation={built} loading={evaluation.isFetching} error={evaluation.error}
            onRemove={toggleConsignment}
            onEditRoute={mode === "manual" ? undefined : () => switchMode("manual")}
            onClear={clearRoute}
            remarks={remarks} setRemarks={setRemarks}
            canPlan={can("transport.create")} planning={create.isPending} planError={create.error}
            onPlan={() => create.mutate()} departure={departure} originPlace={originPlace}
            onMeasure={can("dispatch.create") ? setMeasuring : undefined}
          />
        </div>
      )}
      {selection.length === 0 && originMapped && !!plan?.candidates.length && (
        <Alert tone="info">
          {mode === "suggested"
            ? "Pick a suggested trip, or switch to Build my own and choose the stops in the order the truck should go. Clicking a beam on the map adds that stop too."
            : "Add the first stop from the list, or click a beam on the map. Each stop you add goes after the last one; drag a stop to change the order."}
        </Alert>
      )}

      <PointLocatorModal point={locating ? pinning : null}
        onUse={(at) => { setPinned({ lat: at.lat, lon: at.lon }); setPinText(`${at.lat}, ${at.lon}`); setPinLabel(at.label); setLocating(false); }}
        onPickOnMap={() => setLocating(false)}
        onClose={() => { setLocating(false); setPinning(null); }} />
      <MeasureModal consignment={measuring} onClose={() => setMeasuring(null)} />
      <ConfirmModal isOpen={!!pinning && !!pinned} title={`Pin ${pinning?.name ?? ""}`}
        confirmLabel="Save location" busy={pin.isPending} error={pin.error}
        confirmDisabled={!parseCoordinates(pinText)}
        onClose={() => { setPinned(null); }}
        onConfirm={() => { const at = parseCoordinates(pinText); if (at) { setPinned(at); pin.mutate(); } }}>
        <div className="space-y-3 text-sm">
          <p className="text-muted">Saved on the warehouse master as a verified pin, and used by every plan from now on.</p>
          {pinLabel && <p className="text-xs text-body">From the gazetteer: <b>{pinLabel}</b></p>}
          <Field label="Coordinates" hint="Adjust if you have the exact gate — a Google Maps link or “lat, lon” both work.">
            <Input value={pinText} onChange={(e) => setPinText(e.target.value)} placeholder="16.5062, 80.6480" />
          </Field>
          {(() => { const at = parseCoordinates(pinText); return at && !insideAp(at.lat, at.lon)
            ? <Alert tone="warning">That point is outside Andhra Pradesh. Check it before saving.</Alert> : null; })()}
        </div>
      </ConfirmModal>
    </div>
  );
}

/** Suggested or hand-built: two doors onto the same manifest. */
function ModeSwitch({ mode, onChange, suggestions, stops }: {
  mode: Mode; onChange: (mode: Mode) => void; suggestions: number; stops: number;
}) {
  const reduce = useReducedMotion();
  const items: [Mode, string, typeof Sparkles, number][] = [
    ["suggested", "Suggested", Sparkles, suggestions],
    ["manual", "Build my own", Hand, stops],
  ];
  return (
    <LayoutGroup id="planner-mode">
      <div role="tablist" aria-label="How to plan" className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-content2 p-1">
        {items.map(([key, label, Icon, count]) => {
          const on = mode === key;
          return (
            <button key={key} type="button" role="tab" aria-selected={on} onClick={() => onChange(key)}
              className={`relative flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold transition-colors ${on ? "text-white" : "text-muted hover:text-ink"}`}>
              {on && <motion.span layoutId="planner-mode-pill" className="absolute inset-0 rounded-lg bg-brand shadow-sm"
                transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 38 }} />}
              <Icon className="relative h-4 w-4" />
              <span className="relative">{label}</span>
              {count > 0 && (
                <span className={`relative rounded-full px-1.5 text-[11px] ${on ? "bg-white/25" : "bg-content1 text-brand"}`}>{count}</span>
              )}
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}

function PolicyPanel({ base, onChange, onReset, canSave }: {
  base: PolicyOverrides & { distance_basis?: string }; onChange: (patch: PolicyOverrides) => void;
  onReset: () => void; canSave: boolean;
}) {
  const save = useAction({
    run: () => { const { distance_basis: _basis, ...values } = base; return tripApi.savePolicy(values); },
    success: "Saved as this site's planning defaults",
    invalidates: [["trip-planner-policy"]],
  });
  const field = (key: keyof PolicyOverrides, label: string, hint: string, step = 1) => (
    <Field label={label} hint={hint}>
      <Input type="number" step={step} min={0} value={String(base[key] ?? "")}
        onChange={(e) => onChange({ [key]: e.target.value === "" ? undefined : Number(e.target.value) })} />
    </Field>
  );
  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {field("capacity_kg", "Capacity (kg)", "What the vehicle may carry")}
        {field("capacity_cbm", "Cargo box (m³)", "0 = not limited by volume", 0.1)}
        {field("volume_fill_pct", "Box usable (%)", "Cartons do not fill a box solid")}
        {field("max_packages", "Max packages", "0 = weight decides")}
        {field("max_stops", "Max stops", "Drops on one run")}
        {field("max_detour_pct", "Detour allowed (%)", "How far off the road is still “on the way”")}
        {field("detour_floor_km", "Detour floor (km)", "Always fine to call this close")}
        {field("cost_per_km", "Cost per km (₹)", "For the saving estimate")}
        {field("road_factor", "Road factor", "For estimated legs only — road km per straight-line km", 0.01)}
        {field("default_package_kg", "Unweighed package (kg)", "Assumed when nobody weighed it · 0 = no assumption", 0.5)}
        {field("default_package_cbm", "Unmeasured package (m³)", "Assumed when nobody measured it · 0 = none", 0.01)}
        <Field label="Vehicle returns" hint="Count the empty run home">
          <Select value={base.return_to_origin === false ? "no" : "yes"} ariaLabel="Vehicle returns"
            onChange={(value) => onChange({ return_to_origin: value === "yes" })}
            options={[{ value: "yes", label: "Yes — round trip" }, { value: "no", label: "No — one way" }]} />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={onReset}>Reset to site defaults</Button>
        {canSave && <Button variant="subtle" onClick={() => save.mutate()} disabled={save.isPending}>Save as site defaults</Button>}
        <span className="text-xs text-muted">{base.distance_basis ?? "Distances are estimated road km (straight line × road factor)."} Only weighed and measured loads can refuse a trip; estimates warn.</span>
      </div>
      <ErrorBanner error={save.error} />
    </div>
  );
}

/**
 * Review and plan: what goes on the truck, stop by stop, and the one press that
 * reserves it. Ordering the stops is the route builder's job — this is where the
 * load is checked, a carton weighed, and a consignment taken off.
 */
function TripBuilder({
  evaluation, loading, error, onRemove, onEditRoute, onClear, remarks, setRemarks, canPlan,
  planning, planError, onPlan, departure, originPlace, onMeasure,
}: {
  evaluation?: import("../transportTypes").TripEvaluation;
  loading: boolean; error: unknown;
  onRemove: (dispatchId: number) => void;
  onEditRoute?: () => void; onClear: () => void;
  remarks: string; setRemarks: (value: string) => void; canPlan: boolean;
  planning: boolean; planError: unknown; onPlan: () => void; departure: string;
  originPlace: string;
  onMeasure?: (row: { dispatch_id: number; consignment_no: string }) => void;
}) {
  const [showChecks, setShowChecks] = useState(false);
  // Served by the planner: only firm figures (and counts) refuse a trip.
  const blockers = evaluation?.blockers ?? [];
  const checks = (evaluation?.warnings ?? []).filter((text) => !blockers.includes(text));
  const unmeasured = (evaluation?.consignments ?? []).filter(needsMeasuring).length;
  const tooFew = (evaluation?.total_consignments ?? 0) < 2;
  const gone = evaluation?.unavailable.length ?? 0;
  const fill = evaluation ? fullness(evaluation) : null;
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line p-4">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-wider text-brand">Review and plan</div>
          <h2 className="mt-0.5 font-display text-lg font-semibold text-ink">
            {evaluation ? `${evaluation.stops.length} stop${evaluation.stops.length === 1 ? "" : "s"} · ${evaluation.total_consignments} consignments` : "Working out the route…"}
          </h2>
          {evaluation && (
            <p className="text-xs text-muted">
              {km(evaluation.estimated_distance_km)} on one truck instead of {km(evaluation.separate_distance_km)} on separate ones
              {" "}· {distanceWord(evaluation.distance_basis).toLowerCase()} · leaves {fmtDate(departure)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {evaluation && evaluation.estimated_saving_amount > 0 && (
            <span className="rounded-full bg-ok-bg px-3 py-1 font-semibold text-ok">Saves {money(evaluation.estimated_saving_amount)}</span>
          )}
          {onEditRoute && (
            <button type="button" onClick={onEditRoute}
              className="flex min-h-11 items-center gap-1.5 rounded-full border border-line px-3 text-body hover:border-brand/50 hover:text-brand sm:min-h-8">
              <Pencil className="h-3.5 w-3.5" /> Change route
            </button>
          )}
          <button type="button" onClick={onClear} className="min-h-11 rounded-full px-3 text-muted hover:bg-content2 sm:min-h-8">Clear</button>
        </div>
      </div>
      <ErrorBanner error={error} className="m-4" />

      <div className="grid grid-cols-1 gap-0 lg:grid-cols-[minmax(0,1.6fr)_minmax(300px,1fr)]">
        <ol className="relative space-y-0 p-4">
          <li className="flex items-center gap-3 pb-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-400 text-slate-900"><Warehouse className="h-4 w-4" /></span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-ink">{originPlace}</div>
              <div className="text-[11px] text-muted">Loads every consignment below</div>
            </div>
          </li>
          {(evaluation?.stops ?? []).map((stop) => (
            <li key={stop.destination_warehouse_id} className="relative ml-4 border-l-2 border-dashed border-line pb-4 pl-6">
              <span className="absolute -left-[13px] top-0 flex h-6 w-6 items-center justify-center rounded-full bg-brand text-[11px] font-bold text-white">{stop.sequence}</span>
              <div className="rounded-xl border border-line bg-content1 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-ink" title={stop.destination_name}>{placeOf(stop)}</div>
                    <div className="text-[11px] text-muted">{[stop.destination_type, stop.destination_code].filter(Boolean).join(" · ")}</div>
                  </div>
                  <div className="text-right text-[11px] text-muted">
                    <b className="text-body">{km(stop.distance_from_previous_km)}</b>{stop.distance_basis === "ESTIMATE" ? " est." : ""} drive · {km(stop.cumulative_km)} in
                  </div>
                </div>
                <div className="mt-2 space-y-1">
                  {stop.consignments.map((row) => (
                    <div key={row.dispatch_id} className="flex items-center gap-2 rounded-lg bg-content2 px-2.5 py-1.5 text-xs">
                      <span className="font-mono font-semibold text-ink">{row.consignment_no}</span>
                      <span className="ml-auto shrink-0 text-right text-muted">{row.packages} pkg · {weightText(row)}
                        <span className="hidden md:inline"> · {volumeText(row)}</span></span>
                      {onMeasure && needsMeasuring(row) && (
                        <IconBtn label={`Weigh and measure ${row.consignment_no}`} onClick={() => onMeasure(row)}><Scale className="h-3.5 w-3.5" /></IconBtn>
                      )}
                      <IconBtn label={`Take ${row.consignment_no} off this trip`} onClick={() => onRemove(row.dispatch_id)}><X className="h-3.5 w-3.5" /></IconBtn>
                    </div>
                  ))}
                </div>
              </div>
            </li>
          ))}
          {!!evaluation?.return_km && (
            <li className="ml-4 flex items-center gap-2 pl-6 text-[11px] text-muted">
              <CornerDownLeft className="h-3.5 w-3.5" /> Back to {originPlace} · {km(evaluation.return_km)}
            </li>
          )}
          {loading && <li className="mt-2 text-xs text-muted">Re-routing…</li>}
        </ol>

        <div className="space-y-4 border-t border-line bg-content2/40 p-4 lg:border-l lg:border-t-0">
          {evaluation && fill && (
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between text-xs">
                <span className="font-semibold text-ink">Truck load</span>
                <span className="text-muted">{kg(evaluation.total_weight_kg)}
                  {evaluation.volume_utilisation_pct != null ? ` · ${cbm(evaluation.total_volume_cbm)}` : ""} · {evaluation.total_packages} packages</span>
              </div>
              <FillMeter {...fill} />
            </div>
          )}
          {!!blockers.length && (
            <div className="space-y-1.5">
              {blockers.map((text) => (
                <div key={text} className="flex items-start gap-2 rounded-lg bg-bad-bg px-3 py-2 text-xs text-bad">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{text}
                </div>
              ))}
            </div>
          )}
          {gone > 0 && (
            <div className="flex items-start gap-2 rounded-lg bg-warn-bg px-3 py-2 text-xs text-warn">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {gone} consignment{gone === 1 ? " is" : "s are"} no longer packed and waiting here, and {gone === 1 ? "was" : "were"} left off.
            </div>
          )}
          {!!checks.length && (
            <div className="rounded-lg border border-warn/30 bg-content1">
              <button type="button" onClick={() => setShowChecks((on) => !on)} aria-expanded={showChecks}
                className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-warn">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1">{checks.length} thing{checks.length === 1 ? "" : "s"} to check before it leaves</span>
                <ChevronDown className={`h-3.5 w-3.5 transition ${showChecks ? "rotate-180" : ""}`} />
              </button>
              {showChecks && (
                <ul className="space-y-1.5 border-t border-line px-3 py-2 text-xs text-body">
                  {checks.map((text) => <li key={text} className="flex gap-2"><span className="text-warn">•</span>{text}</li>)}
                  {unmeasured > 0 && onMeasure && (
                    <li className="flex gap-2 text-muted"><Scale className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Use the scale button beside a consignment to record its cartons.</li>
                  )}
                </ul>
              )}
            </div>
          )}
          <Field label="Note for the trip (optional)">
            <Textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} minRows={2}
              placeholder="e.g. Unload stop 2 before 11 am" />
          </Field>
          <ErrorBanner error={planError} />
          {canPlan ? (
            <Button className="w-full" onClick={onPlan} disabled={!evaluation || planning || !!blockers.length || tooFew || loading}>
              <CheckCircle2 className="h-4 w-4" />
              {planning ? "Reserving consignments…" : tooFew ? "Add at least two consignments"
                : `Plan trip & proceed to dispatch · ${evaluation?.total_consignments ?? 0} consignments`}
            </Button>
          ) : <p className="text-xs text-muted">Planning a trip needs the transport create permission.</p>}
          <p className="text-[11px] leading-relaxed text-muted">
            Planning reserves these consignments and drafts one shipment for the whole run. Next you choose the mode and provider on the usual Dispatch screen; each site then signs for its own consignment.
          </p>
        </div>
      </div>
    </Card>
  );
}

function IconBtn({ label, onClick, disabled, children }: {
  label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-content2 hover:text-ink disabled:opacity-30 sm:h-7 sm:w-7">
      {children}
    </button>
  );
}

// --------------------------------------------------------------------------- //
//  Trips
// --------------------------------------------------------------------------- //

const TRIP_FILTERS = [
  { value: "ACTIVE", label: "Active" },
  { value: "PLANNED", label: "Planned" },
  { value: "IN_TRANSIT,PARTIALLY_DELIVERED", label: "On the road" },
  { value: "DELIVERED", label: "Waiting on sign-off" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "", label: "All" },
];

function TripsTab() {
  const nav = useNavigate();
  const [status, setStatus] = useState("ACTIVE");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ["consolidated-trips", status, search, page],
    queryFn: () => tripApi.list({ status: status || undefined, search: search || undefined, page, size: 20 }),
    placeholderData: keepPreviousData,
    refetchInterval: 20_000,
  });
  const columns: Column<ConsolidatedTrip>[] = [
    { key: "trip", header: "Trip", render: (row) => (
      <div><div className="font-mono text-sm font-semibold text-ink">{row.trip_no}</div>
        <div className="text-[11px] text-muted">{fmtDate(row.departure_date)} · {row.tr_no}</div></div>
    ) },
    { key: "route", header: "Route", render: (row) => (
      <div className="max-w-[360px] text-xs text-body">
        <span className="font-medium">{row.from_warehouse_name}</span> → {row.stops.map((stop) => stop.destination_name).join(" → ")}
      </div>
    ) },
    { key: "load", header: "Load", hideOnNarrow: true, render: (row) => (
      <div className="text-xs text-body">{row.total_consignments} consignments<div className="text-muted">{row.total_packages} pkg · {kg(row.total_weight_kg)}</div></div>
    ) },
    { key: "progress", header: "Stops", render: (row) => <StopsProgress trip={row} /> },
    { key: "shipment", header: "Shipment", hideOnNarrow: true, render: (row) => (
      <div className="space-y-1">{row.shipment_status && <StatusPill status={row.shipment_status} />}
        <div className="text-[11px] text-muted">{row.carrier_name ?? row.vehicle_number ?? "—"}</div></div>
    ) },
    { key: "status", header: "Trip", render: (row) => <StatusPill status={row.status} label={TRIP_STATUS_WORDS[row.status]} /> },
    { key: "saving", header: "Saving", hideOnNarrow: true, className: "text-right", render: (row) => (
      <div className="text-right text-xs"><b className="text-ok">{money(row.estimated_saving_amount)}</b><div className="text-muted">{km(row.estimated_saving_km)}</div></div>
    ) },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {TRIP_FILTERS.map((filter) => (
          <button key={filter.label} type="button" onClick={() => { setStatus(filter.value); setPage(1); }}
            className={`min-h-11 rounded-full border px-3 text-sm transition sm:min-h-9 ${status === filter.value
              ? "border-brand bg-brand-050 text-brand" : "border-line bg-content1 text-muted hover:text-ink"}`}>
            {filter.label}
          </button>
        ))}
        <div className="ml-auto w-full sm:w-72">
          <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Trip, consignment, indent or stop" aria-label="Search trips" />
        </div>
      </div>
      <ErrorBanner error={list.error} />
      <ResponsiveList
        data={list.data?.items ?? []} columns={columns} keyOf={(row) => row.id}
        loading={list.isLoading} onRowClick={(row) => nav(`/logistics/load-planner/trips/${row.id}`)}
        empty={<div className="py-6 text-center text-sm text-muted"><Route className="mx-auto mb-2 h-6 w-6" />No trips here yet — plan one from the Plan tab.</div>}
        page={page} totalPages={Math.ceil((list.data?.total ?? 0) / 20)} onPageChange={setPage}
        renderCard={(row) => (
          <div className="space-y-2 p-1">
            <div className="flex items-start justify-between gap-2">
              <div><div className="font-mono text-sm font-semibold text-ink">{row.trip_no}</div>
                <div className="text-[11px] text-muted">{fmtDate(row.departure_date)} · {row.total_consignments} consignments</div></div>
              <StatusPill status={row.status} label={TRIP_STATUS_WORDS[row.status]} />
            </div>
            <div className="text-xs text-body">{row.from_warehouse_name} → {row.stops.map((s) => s.destination_name).join(" → ")}</div>
            <StopsProgress trip={row} />
          </div>
        )}
      />
    </div>
  );
}

export function StopsProgress({ trip }: { trip: ConsolidatedTrip }) {
  const { delivered, signed, total } = tripProgress(trip);
  return (
    <div className="min-w-[140px]">
      <div className="flex gap-0.5">
        {trip.stops.map((stop) => (
          <span key={stop.id} title={`${stop.sequence}. ${stop.destination_name} — ${stop.status.toLowerCase().replace(/_/g, " ")}`}
            className={`h-2 flex-1 rounded-full ${stop.status === "ACKNOWLEDGED" ? "bg-ok"
              : stop.status === "DELIVERED" ? "bg-ok/50" : stop.status === "IN_TRANSIT" ? "bg-info/60"
              : stop.status === "CANCELLED" ? "bg-bad/40" : "bg-line"}`} />
        ))}
      </div>
      <div className="mt-1 text-[11px] text-muted">{delivered}/{total} delivered · {signed}/{total} signed</div>
    </div>
  );
}
