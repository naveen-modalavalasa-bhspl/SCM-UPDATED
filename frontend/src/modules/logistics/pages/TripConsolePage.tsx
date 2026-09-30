import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2, Circle, Clock, FileText, Package, Route, ShieldCheck, Truck, User, XCircle,
} from "lucide-react";
import {
  Alert, BackLink, Button, Can, Card, ConfirmModal, ErrorBanner, Field, Input, PageHeader,
  StatusPill, useAction,
} from "@/shared/components";
import { fmtDate, fmtDateTime } from "@/shared/datetime";
import { tripApi } from "../api";
import { ApMap3D } from "../components/ApMap3D";
import { TripStopList } from "../components/TripStops";
import {
  TRIP_STATUS_WORDS, stopMapState, tripHeadline, tripProgress, truckLeg,
} from "../components/tripCopy";
import { cbm, distanceWord } from "../components/tripLoad";

/**
 * One multi-drop trip, as a STATUS page (simplified 2026-09-28).
 *
 * A trip is one ordinary shipment, and it is worked in the ordinary flow: arranged on
 * the Dispatch screen, priced on Provider Selection, released and followed stop by
 * stop on the shipment page. This page does none of that work; every press here hands
 * over to the screen where it is done. What it keeps is what only a trip has — the
 * route on a map, and one sentence saying where the whole run stands ("On the road",
 * "Trip delivered") — so it can be read in a glance and left.
 */

const km = (value: unknown) =>
  `${Number(value ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 1 })} km`;
const kg = (value: unknown) =>
  `${Number(value ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })} kg`;
const money = (value: unknown) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 })
    .format(Number(value ?? 0));

const LIVE_MS = 15_000;
const ARRANGED = ["READY", "IN_TRANSIT", "DELIVERED", "ACKNOWLEDGED", "CLOSED"];

const HEADLINE_TONE = {
  ok: "border-ok/30 bg-ok-bg text-ok",
  info: "border-info/30 bg-info-bg text-info",
  warn: "border-warn/30 bg-warn-bg text-warn",
  bad: "border-bad/30 bg-bad-bg text-bad",
  neutral: "border-line bg-content2 text-ink",
} as const;

export function TripConsolePage() {
  const { id } = useParams();
  const tripId = Number(id);
  const nav = useNavigate();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");

  const query = useQuery({
    queryKey: ["consolidated-trip", tripId],
    queryFn: () => tripApi.get(tripId),
    enabled: tripId > 0,
    refetchInterval: LIVE_MS,
    refetchOnWindowFocus: true,
  });
  const network = useQuery({
    queryKey: ["trip-map-network"], queryFn: tripApi.network, staleTime: 10 * 60_000,
  });
  const trip = query.data;

  const cancel = useAction({
    run: () => tripApi.cancel(tripId, reason),
    success: (result) => `${result.trip_no} cancelled — its consignments are back in the Dispatch queue`,
    invalidates: [["consolidated-trip", tripId], ["consolidated-trips"], ["lgs-dispatch-queue"],
      ["lgs-consignment-links"], ["trip-recommendations"], ["transport"]],
    onDone: () => { setCancelling(false); setReason(""); },
  });

  const nodes = useMemo(() => (network.data?.points ?? [])
    .filter((p) => p.latitude != null && p.longitude != null)
    .map((p) => ({ id: p.id, lat: Number(p.latitude), lon: Number(p.longitude), name: p.name,
      code: p.code, kind: p.warehouse_type })), [network.data]);

  if (query.error) return <div className="space-y-4"><BackLink to="/logistics/load-planner?tab=trips" label="Trips" /><ErrorBanner error={query.error} /></div>;
  if (!trip) return <div className="p-8 text-center text-sm text-muted">Loading the trip…</div>;

  const { delivered, signed, total } = tripProgress(trip);
  const shipment = trip.shipment;
  const next = trip.next_action;
  const headline = tripHeadline(trip);

  /** Where the next press is made — always a screen of the ordinary shipment flow. */
  const nextStep: { label: string; to: string } | null = !trip.tr_id ? null
    : next.code === "ARRANGE" ? { label: next.label, to: `/logistics/dispatch/new?tr_id=${trip.tr_id}` }
    : next.code === "PROVIDER" ? { label: next.label, to: `/logistics/providers?tr=${trip.tr_id}` }
    : next.code === "RELEASE" ? { label: next.label, to: `/logistics/shipments/${trip.tr_id}` }
    : next.code === "DELIVER" ? { label: "Mark stops delivered", to: `/logistics/shipments/${trip.tr_id}` }
    : null;

  const onTheRoad = ["IN_TRANSIT", "PARTIALLY_DELIVERED"].includes(trip.status);
  const steps = [
    { label: "Planned", sub: fmtDate(trip.created_at), done: true },
    { label: "Transport arranged", sub: shipment?.carrier_name ?? shipment?.mode?.replace(/_/g, " ").toLowerCase() ?? "",
      done: !!shipment && ARRANGED.includes(shipment.status), live: !!shipment && !ARRANGED.includes(shipment.status) && trip.status !== "CANCELLED" },
    { label: "Left the gate", sub: trip.dispatched_at ? fmtDateTime(trip.dispatched_at) : "", done: !!trip.dispatched_at,
      live: !!shipment && shipment.status === "READY" },
    { label: `Delivered ${delivered}/${total}`, sub: "stop by stop", done: total > 0 && delivered === total, live: onTheRoad },
    { label: `Signed ${signed}/${total}`, sub: "by each site", done: total > 0 && signed === total, live: delivered > signed },
    { label: "Closed", sub: trip.completed_at ? fmtDate(trip.completed_at) : "", done: trip.status === "COMPLETED" },
  ];

  return (
    <div className="space-y-5">
      <BackLink to="/logistics/load-planner?tab=trips" label="All trips" />
      <PageHeader eyebrow="Logistics · Multi-drop trip" title={trip.trip_no} actions={
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={trip.status} label={TRIP_STATUS_WORDS[trip.status]} />
          {trip.tr_id && (
            <Link to={`/logistics/shipments/${trip.tr_id}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-line px-3 text-sm text-body hover:border-brand/40 sm:min-h-9">
              <FileText className="h-4 w-4" /> {trip.tr_no}{shipment && <StatusPill status={shipment.status} />}
            </Link>
          )}
          {nextStep && (
            <Can do={next.code === "DELIVER" ? "transport.track" : "transport.create"}>
              <Button onClick={() => nav(nextStep.to)}><Truck className="h-4 w-4" />{nextStep.label}</Button>
            </Can>
          )}
        </div>
      } />

      {/* Where the whole run stands, in one sentence. */}
      <div className={`flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 ${HEADLINE_TONE[headline.tone]}`}>
        {headline.tone === "ok" ? <CheckCircle2 className="h-6 w-6 shrink-0" />
          : headline.tone === "bad" ? <XCircle className="h-6 w-6 shrink-0" />
          : <Truck className="h-6 w-6 shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="font-display text-lg font-semibold">{headline.title}</div>
          <div className="text-sm text-body">
            {trip.status === "CANCELLED" && trip.remarks ? trip.remarks : headline.detail}
          </div>
        </div>
        <Can do="transport.create">
          {trip.status === "PLANNED" && (
            <Button variant="dangerSoft" onClick={() => setCancelling(true)}>
              <XCircle className="h-4 w-4" /> Cancel trip
            </Button>
          )}
        </Can>
      </div>

      <Card className="overflow-x-auto p-4">
        <ol className="flex min-w-[640px] items-start">
          {steps.map((step, index) => (
            <li key={step.label} className="relative flex flex-1 flex-col items-center text-center">
              {index > 0 && <span className={`absolute right-1/2 top-3.5 h-0.5 w-full ${step.done || step.live ? "bg-ok/60" : "bg-line"}`} />}
              <span className={`relative z-10 flex h-7 w-7 items-center justify-center rounded-full border-2 ${
                step.done ? "border-ok bg-ok text-white" : step.live ? "border-info bg-info-bg text-info" : "border-line bg-content1 text-muted"}`}>
                {step.done ? <CheckCircle2 className="h-4 w-4" /> : step.live ? <Clock className="h-3.5 w-3.5" /> : <Circle className="h-3 w-3" />}
              </span>
              <span className={`mt-2 text-xs font-semibold ${step.done || step.live ? "text-ink" : "text-muted"}`}>{step.label}</span>
              {step.sub && <span className="mt-0.5 max-w-[140px] truncate text-[11px] capitalize text-muted">{step.sub}</span>}
            </li>
          ))}
        </ol>
      </Card>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(320px,1fr)]">
        <ApMap3D nodes={nodes} height={470}
          origin={{ lat: Number(trip.origin_latitude), lon: Number(trip.origin_longitude), name: trip.from_warehouse_name ?? "Origin" }}
          routes={[{
            key: "trip", emphasis: "active", returnToOrigin: trip.returns_to_origin, truckLeg: truckLeg(trip),
            stops: trip.stops.map((stop) => ({
              key: stop.id, lat: Number(stop.latitude), lon: Number(stop.longitude), label: stop.destination_name,
              sequence: stop.sequence, state: stopMapState(stop.status), count: stop.consignments.length,
            })),
          }]}
          focusKey={`trip-${trip.id}`} title="Route" subtitle={`${trip.from_warehouse_name} → ${total} stops · ${km(trip.estimated_distance_km)} (${distanceWord(trip.distance_basis).toLowerCase()})`}
          badge={onTheRoad ? <span className="rounded-full border border-emerald-300/40 bg-emerald-500/20 px-3 py-1 text-[11px] text-emerald-50">
            Truck heading to stop {Math.min(total, (truckLeg(trip) ?? 0) + 1)}</span> : null}
        />
        <div className="space-y-3">
          <Card className="grid grid-cols-2 gap-3 p-4 text-sm">
            <Fact icon={Route} label={distanceWord(trip.distance_basis)} value={km(trip.estimated_distance_km)} sub={`vs ${km(trip.separate_distance_km)} separately`} />
            <Fact icon={ShieldCheck} label="Estimated saving" value={money(trip.estimated_saving_amount)} sub={km(trip.estimated_saving_km)} />
            <Fact icon={Package} label="Load" value={`${trip.total_consignments} consignments`}
              sub={`${trip.total_packages} pkg · ${kg(trip.total_weight_kg)}${Number(trip.total_volume_cbm ?? 0) > 0 ? ` · ${cbm(trip.total_volume_cbm)}${trip.vehicle_capacity_cbm ? ` of ${cbm(trip.vehicle_capacity_cbm)}` : ""}` : ""}`} />
            <Fact icon={Truck} label="Vehicle" value={trip.vehicle_number ?? "—"} sub={trip.vehicle_profile ?? (shipment?.carrier_name ?? "")} />
            <Fact icon={User} label="Driver" value={trip.driver_name ?? "—"} sub={trip.driver_phone ?? ""} />
            <Fact icon={FileText} label="LR / gate pass" value={shipment?.lr_no ?? shipment?.docket_no ?? "—"} sub={trip.gate_pass_no ?? ""} />
          </Card>
          {!!shipment?.open_claims && (
            <Alert tone="warning" title={`${shipment.open_claims} open claim${shipment.open_claims > 1 ? "s" : ""}`}>
              Worked on the shipment's timeline. <Link className="underline" to={`/logistics/shipments/${trip.tr_id}`}>Open {trip.tr_no}</Link>
            </Alert>
          )}
        </div>
      </div>

      {/* Read-only: a stop is marked delivered on the shipment, with everything else. */}
      <TripStopList trip={trip} title="Stops and consignments" />

      <ConfirmModal isOpen={cancelling} title={`Cancel ${trip.trip_no}?`} danger confirmLabel="Cancel trip"
        busy={cancel.isPending} error={cancel.error} confirmDisabled={!reason.trim()}
        onClose={() => setCancelling(false)} onConfirm={() => cancel.mutate()}
        message={`Its shipment ${trip.tr_no ?? ""} is cancelled too, and all ${trip.total_consignments} consignments go back to the Dispatch queue exactly as packed.`}>
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this run is not going" /></Field>
      </ConfirmModal>
    </div>
  );
}

function Fact({ icon: Icon, label, value, sub }: {
  icon: typeof Route; label: string; value: React.ReactNode; sub?: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] text-muted"><Icon className="h-3.5 w-3.5" />{label}</div>
      <div className="truncate font-semibold text-ink">{value}</div>
      {sub && <div className="truncate text-[11px] text-muted">{sub}</div>}
    </div>
  );
}
