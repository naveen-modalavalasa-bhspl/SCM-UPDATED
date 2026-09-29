import { useState } from "react";
import { CheckCircle2, MapPin, Phone, Route } from "lucide-react";
import { Button, Card, ErrorBanner, Field, Input, useAction } from "@/shared/components";
import { fmtDateTime } from "@/shared/datetime";
import { carrierPortalApi } from "../api";
import { safeHref } from "../components/tripLoad";
import type { CarrierTrip, CarrierTripStop } from "../transportTypes";

const km = (value: unknown) =>
  `${Number(value ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 1 })} km`;

const OPEN = new Set(["PLANNED", "IN_TRANSIT"]);

/**
 * A multi-drop run, from the driver's side: every stop in the order the truck calls,
 * who to ring at the gate, what comes off there — and ONE Delivered press per stop,
 * with the proof of delivery for that stop.
 *
 * One press for the whole run was how a stop still on the truck came to read
 * delivered, so there is none while more than one stop is left. The site at each stop
 * still signs for its own consignment; this is the carrier's word that it was put down.
 */
export function CarrierTripStops({ jobId, trip, canReport, invalidates }: {
  jobId: number;
  trip: CarrierTrip;
  /** The truck is on the road (READY or IN_TRANSIT). */
  canReport: boolean;
  invalidates: unknown[][];
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [pod, setPod] = useState({ delivered_to_name: "", pod_url: "", remarks: "" });
  const deliver = useAction({
    run: () => carrierPortalApi.deliverStop(jobId, open!, {
      delivered_to_name: pod.delivered_to_name || null,
      pod_url: pod.pod_url.trim() || null,
      remarks: pod.remarks || null,
    }),
    success: (job) => {
      const left = job.trip?.stops.filter((row) => OPEN.has(row.status)).length ?? 0;
      return left ? `Stop reported delivered — ${left} still to go` : "Last stop delivered — the run is complete";
    },
    invalidates,
    onDone: () => { setOpen(null); setPod({ delivered_to_name: "", pod_url: "", remarks: "" }); },
  });
  const podValid = !pod.pod_url.trim() || !!safeHref(pod.pod_url);

  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Route className="h-4 w-4 text-brand" />
          <h2 className="font-display text-lg font-semibold text-ink">
            Multi-drop run · {trip.stops_delivered} of {trip.total_stops} stops delivered
          </h2>
        </div>
        <span className="font-mono text-xs text-muted">{trip.trip_no}</span>
      </div>
      <p className="text-xs text-muted">
        Report each stop as the truck reaches it. Each site still signs for its own
        consignment — this is your proof it was put down.
      </p>
      <ErrorBanner error={deliver.error} />
      <ol className="space-y-2">
        {trip.stops.map((stop) => (
          <StopRow key={stop.id} stop={stop} isNext={stop.id === trip.next_stop_id}
            canReport={canReport && OPEN.has(stop.status)}
            expanded={open === stop.id} onToggle={() => setOpen(open === stop.id ? null : stop.id)}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Who took it">
                <Input value={pod.delivered_to_name}
                  onChange={(e) => setPod({ ...pod, delivered_to_name: e.target.value })} />
              </Field>
              <Field label="POD link" hint="A photo or a scan of the signed copy for this stop">
                <Input value={pod.pod_url} placeholder="https://…"
                  onChange={(e) => setPod({ ...pod, pod_url: e.target.value })} />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Note">
                  <Input value={pod.remarks}
                    onChange={(e) => setPod({ ...pod, remarks: e.target.value })} />
                </Field>
              </div>
            </div>
            {!podValid && <p className="text-xs text-bad">The POD link has to start with http:// or https://</p>}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => deliver.mutate()} disabled={deliver.isPending || !podValid}>
                {deliver.isPending ? "Sending…" : `Delivered at stop ${stop.sequence}`}
              </Button>
              <Button variant="ghost" onClick={() => setOpen(null)}>Not yet</Button>
            </div>
          </StopRow>
        ))}
      </ol>
    </Card>
  );
}

function StopRow({ stop, isNext, canReport, expanded, onToggle, children }: {
  stop: CarrierTripStop; isNext: boolean; canReport: boolean; expanded: boolean;
  onToggle: () => void; children: React.ReactNode;
}) {
  const done = !OPEN.has(stop.status);
  const proof = safeHref(stop.pod_url);
  return (
    <li className={`rounded-xl border p-3 ${done ? "border-ok/30 bg-ok-bg/30"
      : isNext ? "border-brand/40 bg-brand-050" : "border-line bg-content1"}`}>
      <div className="flex flex-wrap items-start gap-3">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
          done ? "bg-ok text-white" : isNext ? "bg-brand text-white" : "bg-content2 text-muted"}`}>
          {done ? <CheckCircle2 className="h-4 w-4" /> : stop.sequence}
        </span>
        <div className="min-w-0 flex-1 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ink">{stop.destination_name}</span>
            {isNext && !done && <span className="rounded-full bg-brand px-2 py-0.5 text-[10px] font-semibold text-white">Next stop</span>}
          </div>
          <div className="mt-0.5 text-xs text-muted">
            {km(stop.distance_from_previous_km)} from the previous stop
            {stop.delivery_address ? ` · ${stop.delivery_address}` : ""}
          </div>
          {stop.contact_phone && (
            <a href={`tel:${stop.contact_phone.replace(/[^\d+]/g, "")}`}
              className="mt-1 inline-flex min-h-11 items-center gap-1 text-xs text-brand sm:min-h-0">
              <Phone className="h-3.5 w-3.5" />{stop.contact_person ? `${stop.contact_person} · ` : ""}{stop.contact_phone}
            </a>
          )}
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {stop.consignments.map((row) => (
              <span key={row.consignment_no} className="rounded-md bg-content2 px-2 py-0.5 font-mono text-[11px] text-body">
                {row.consignment_no} · {row.packages} pkg
              </span>
            ))}
          </div>
          {done && stop.delivered_at && (
            <p className="mt-1.5 text-xs text-ok">
              Delivered {fmtDateTime(stop.delivered_at)}
              {stop.received_by_name ? ` to ${stop.received_by_name}` : ""}
              {proof && <> · <a className="underline" href={proof} target="_blank" rel="noreferrer">proof</a></>}
            </p>
          )}
        </div>
        {canReport && !expanded && (
          <Button variant={isNext ? "primary" : "subtle"} onClick={onToggle}>
            <MapPin className="h-4 w-4" /> Report delivered
          </Button>
        )}
      </div>
      {expanded && <div className="mt-3 space-y-3 border-t border-line pt-3">{children}</div>}
    </li>
  );
}
