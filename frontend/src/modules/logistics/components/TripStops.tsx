import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, MapPin, Route } from "lucide-react";
import { Button, Can, ConfirmModal, Field, Input, Textarea, useAction } from "@/shared/components";
import { fmtDateTime } from "@/shared/datetime";
import { tripApi } from "../api";
import type { ConsolidatedTrip, TRItem, TripStop } from "../transportTypes";
import { quantityLabel } from "./consignmentToLines";
import { placeName, splitDocNo, stopLines } from "./manifestView";
import { STOP_STATUS_WORDS, tripProgress } from "./tripCopy";
import { safeHref } from "./tripLoad";

/**
 * A multi-drop trip, drawn INSIDE the ordinary shipment flow (2026-09-28).
 *
 * A trip is one ordinary shipment. It is arranged on the Dispatch screen, priced on
 * Provider Selection and followed on the shipment page like any other, so those
 * screens are where a desk works it, and there is no separate flow to learn. The
 * only thing a trip adds is that the load comes off in several places, and these
 * parts are how every screen of that flow says so, in one shape:
 *
 * - `TripRouteStrip`: the route in one line of place names, read out of the
 *   shipment's own lines (`stopLines`). No fetch, so it fits a form step or a header.
 * - `TripStopList`: one compact row per stop (where, which consignments, delivered or
 *   signed) with the desk's "Mark delivered" press when the truck is on the road.
 * - `DeliverStopModal`: that press. Same call as the carrier portal's.
 */

/** Short document number: the part that differs between rows. */
function shortNo(value: string | null | undefined) {
  return splitDocNo(value).tail || value || "";
}

/** The route in one line: origin, then each drop by the place a driver goes to. */
export function TripRouteStrip({ items, from, className = "" }: {
  items: TRItem[] | null | undefined; from?: string | null; className?: string;
}) {
  const stops = stopLines(items ?? []);
  if (!stops?.length) return null;
  return (
    <div className={`rounded-xl border border-brand/20 bg-brand-050/60 p-3 ${className}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1 rounded-full bg-brand px-2 py-0.5 font-semibold text-white">
          <Route className="h-3 w-3" aria-hidden /> Multi-drop
        </span>
        <span className="text-body">
          <b className="text-ink">{stops.length} drops</b> on one truck: one freight, and each site signs for its own consignment.
        </span>
      </div>
      <ol className="flex flex-wrap items-center gap-y-2 text-xs" aria-label="Route">
        {from && (
          <li className="flex items-center">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-content1 py-1 pl-1 pr-2.5">
              <span className="grid h-5 w-5 place-items-center rounded-full bg-amber-400 text-[9px] font-bold text-slate-900">GO</span>
              <span className="max-w-[12rem] truncate text-body" title={from}>{placeName(from)}</span>
            </span>
            <Arrow />
          </li>
        )}
        {stops.map((stop, index) => (
          <li key={stop.line.id} className="flex items-center">
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-content1 py-1 pl-1 pr-2.5"
              title={`Stop ${stop.sequence}: ${stop.destination}${stop.consignmentNo ? ` · ${stop.consignmentNo}` : ""}`}
            >
              <span className="grid h-5 w-5 place-items-center rounded-full bg-ink text-[10px] font-bold text-content1">
                {stop.sequence}
              </span>
              <span className="font-medium text-ink">{stop.place}</span>
              <span className="tabular text-muted">{quantityLabel(stop.line.quantity)}</span>
            </span>
            {index < stops.length - 1 && <Arrow />}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Arrow() {
  return <span aria-hidden className="mx-1 h-px w-3 bg-muted/50 sm:w-4" />;
}

/** Tone of a stop: grey waiting, blue on the truck, green reached, solid green signed. */
function stopTone(status: string) {
  if (status === "ACKNOWLEDGED") return { dot: "bg-ok text-white", word: "text-ok" };
  if (status === "DELIVERED") return { dot: "bg-ok-bg text-ok", word: "text-ok" };
  if (status === "IN_TRANSIT") return { dot: "bg-info-bg text-info", word: "text-info" };
  if (status === "CANCELLED") return { dot: "bg-bad-bg text-bad", word: "text-bad" };
  return { dot: "bg-content2 text-muted", word: "text-muted" };
}

/**
 * Every stop, one row each. `onDeliver` is offered only while the truck is on the
 * road and the stop is still ahead of it. A screen that must not deliver (the trip's
 * own status page) simply does not pass it.
 */
export function TripStopList({ trip, onDeliver, title = "Stops", mapLink = false }: {
  trip: ConsolidatedTrip;
  onDeliver?: (stop: TripStop) => void;
  title?: string;
  /** Link to the trip's map page, for screens that do not draw the map themselves. */
  mapLink?: boolean;
}) {
  const { delivered, signed, total } = tripProgress(trip);
  const onTheRoad = ["IN_TRANSIT", "PARTIALLY_DELIVERED"].includes(trip.status);
  return (
    <section className="overflow-hidden rounded-2xl border border-line/70 bg-content1">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <MapPin className="h-4 w-4 text-brand" aria-hidden />
          <h3 className="font-display text-[15px] font-semibold text-ink">{title}</h3>
          <span className="text-xs text-muted">
            {delivered}/{total} reached · {signed}/{total} signed
          </span>
        </div>
        {mapLink && (
          <Link
            to={`/logistics/load-planner/trips/${trip.id}`}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-brand hover:underline"
          >
            <Route className="h-3.5 w-3.5" aria-hidden /> {trip.trip_no} on the map
          </Link>
        )}
      </header>
      <ol className="divide-y divide-line/50">
        {trip.stops.map((stop) => {
          const tone = stopTone(stop.status);
          const canDeliver = Boolean(onDeliver) && onTheRoad
            && ["PLANNED", "IN_TRANSIT"].includes(stop.status);
          return (
            <li key={stop.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-bold ${tone.dot}`}>
                {stop.status === "ACKNOWLEDGED" ? <CheckCircle2 className="h-4 w-4" /> : stop.sequence}
              </span>
              <div className="min-w-0 flex-1 basis-56">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-semibold text-ink" title={stop.destination_name}>
                    {placeName(stop.destination_name)}
                  </span>
                  <span className={`text-xs font-medium ${tone.word}`}>
                    {STOP_STATUS_WORDS[stop.status] ?? stop.status}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {stop.consignments.map((row) => {
                    const flagged = row.ack_condition && row.ack_condition !== "GOOD";
                    return (
                      <span
                        key={row.id}
                        title={[
                          row.consignment_no,
                          row.indent_nos ?? row.indent_no ? `indent ${row.indent_nos ?? row.indent_no}` : null,
                          `${row.packages} pkg`,
                          row.acknowledged_at
                            ? `signed by ${row.acknowledged_by_name ?? "the site"} ${fmtDateTime(row.acknowledged_at)}`
                            : "not signed yet",
                        ].filter(Boolean).join(" · ")}
                        className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 font-mono text-[11px] ${
                          row.acknowledged_at
                            ? flagged ? "border-warn/40 bg-warn-bg text-warn" : "border-ok/30 bg-ok-bg text-ok"
                            : "border-line bg-surface text-body"}`}
                      >
                        {row.acknowledged_at && (flagged
                          ? <AlertTriangle className="h-3 w-3" aria-hidden />
                          : <CheckCircle2 className="h-3 w-3" aria-hidden />)}
                        {shortNo(row.consignment_no)}
                        <span className="font-sans text-muted">· {row.packages} pkg</span>
                      </span>
                    );
                  })}
                </div>
                {stop.delivered_at && (
                  <div className="mt-1 text-[11px] text-muted">
                    Reached {fmtDateTime(stop.delivered_at)}
                    {stop.received_by_name ? ` · received by ${stop.received_by_name}` : ""}
                    {stop.delivered_via === "CARRIER" ? " · reported by the carrier" : ""}
                    {safeHref(stop.pod_url) && (
                      <> · <a href={safeHref(stop.pod_url)!} target="_blank" rel="noreferrer" className="underline">proof</a></>
                    )}
                  </div>
                )}
              </div>
              {canDeliver && (
                <Can do="transport.track">
                  <Button variant="subtle" onClick={() => onDeliver!(stop)}>
                    <MapPin className="h-4 w-4" /> Mark delivered
                  </Button>
                </Can>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** The desk's "the truck has called here". The site still signs for itself. */
export function DeliverStopModal({ trip, stop, onClose }: {
  trip: ConsolidatedTrip; stop: TripStop | null; onClose: () => void;
}) {
  const [receivedBy, setReceivedBy] = useState("");
  const [note, setNote] = useState("");
  const [podUrl, setPodUrl] = useState("");
  const deliver = useAction({
    run: () => tripApi.deliverStop(trip.id, stop!.id, {
      received_by_name: receivedBy || null, remarks: note || null, pod_url: podUrl.trim() || null,
    }),
    success: () => `Stop ${stop?.sequence ?? ""} delivered. The site now signs for its consignment${
      (stop?.consignments.length ?? 0) === 1 ? "" : "s"}`,
    invalidates: [["consolidated-trip", trip.id], ["consolidated-trips"], ["transport"]],
    onDone: () => { setReceivedBy(""); setNote(""); setPodUrl(""); onClose(); },
  });
  return (
    <ConfirmModal
      isOpen={!!stop}
      title={stop ? `Stop ${stop.sequence}: ${placeName(stop.destination_name)}` : ""}
      confirmLabel="Mark delivered" busy={deliver.isPending} error={deliver.error} tone="warning"
      onClose={onClose} onConfirm={() => deliver.mutate()}
    >
      <div className="space-y-3 text-sm">
        <p className="text-muted">
          The truck has called here and put these down. The site still signs for each one
          itself, with photos, on its Acknowledgements screen.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {stop?.consignments.map((row) => (
            <span key={row.id} className="rounded-md bg-content2 px-2 py-1 font-mono text-xs" title={row.consignment_no}>
              {shortNo(row.consignment_no)} · {row.packages} pkg
            </span>
          ))}
        </div>
        <Field label="Received by (optional)">
          <Input value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} placeholder="Name of the person at the gate" />
        </Field>
        <Field label="Proof of delivery link (optional)" hint="A photo or scan of the signed copy for THIS stop">
          <Input value={podUrl} onChange={(e) => setPodUrl(e.target.value)} placeholder="https://…" />
        </Field>
        <Field label="Note (optional)">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} minRows={2} />
        </Field>
      </div>
    </ConfirmModal>
  );
}

/** The stops of the trip a shipment carries, with the delivery press, for the
 *  shipment page: where the desk follows the load, stop by stop. */
export function TripStopsPanel({ tripId, className = "" }: { tripId: number; className?: string }) {
  const [delivering, setDelivering] = useState<TripStop | null>(null);
  const { data: trip } = useQuery({
    queryKey: ["consolidated-trip", tripId],
    queryFn: () => tripApi.get(tripId),
    enabled: tripId > 0,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
  if (!trip) return null;
  return (
    <div className={className}>
      <TripStopList trip={trip} title="Drops on this truck" mapLink onDeliver={setDelivering} />
      <DeliverStopModal trip={trip} stop={delivering} onClose={() => setDelivering(null)} />
    </div>
  );
}
