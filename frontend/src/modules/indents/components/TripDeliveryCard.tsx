import { Link } from "react-router-dom";
import { CardBody } from "@heroui/react";
import { Card } from "@/shared/components";
import { CheckCircle2, MapPin, Phone, Truck } from "lucide-react";
import { fmtDate, fmtDateTime } from "@/shared/datetime";
import type { RaiserTracking } from "../types";
import { tripProgressText, tripStopLabel } from "./tripLeg";

const ARRIVED = new Set(["DELIVERED", "ACKNOWLEDGED"]);

/**
 * "Where is my material?" when it rides a SHARED truck: which trip, which stop is
 * theirs, how many drops come first, and who is driving — for each of the raiser's
 * consignments on a multi-drop trip. Drawn only for those legs; a consignment on its
 * own truck is already told by the stepper above.
 */
export function TripDeliveryCard({ indentId, shipments }: {
  indentId: number;
  shipments: RaiserTracking[] | undefined;
}) {
  const legs = (shipments ?? []).filter((leg) => leg.trip_no);
  if (!legs.length) return null;
  return (
    <Card className="mb-5">
      <CardBody className="space-y-3 p-5">
        <div className="flex items-center gap-2">
          <Truck className="h-4 w-4 text-brand" />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
            On a shared truck
          </h2>
        </div>
        {legs.map((leg) => {
          const status = String(leg.status ?? "").toUpperCase();
          const arrived = ARRIVED.has(status) || Boolean(leg.acknowledged_at);
          const total = leg.total_stops ?? 0;
          const done = leg.stops_delivered ?? 0;
          const phone = leg.driver_phone?.replace(/[^\d+]/g, "");
          return (
            <div key={`${leg.trip_id}-${leg.dispatch_id}`}
              className="rounded-xl border border-line bg-content1 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-xs text-muted">
                    {leg.consignment_no ?? leg.tr_no} · {leg.trip_no}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 font-semibold text-ink">
                    <MapPin className="h-4 w-4 shrink-0 text-brand" />
                    <span className="truncate">{tripStopLabel(leg)}</span>
                  </div>
                  <p className={`mt-1 text-sm ${arrived ? "text-ok" : "text-body"}`}>
                    {arrived && <CheckCircle2 className="mr-1 inline h-4 w-4" />}
                    {tripProgressText(leg)}
                  </p>
                </div>
                {status === "DELIVERED" && !leg.acknowledged_at && (
                  <Link to={`/indents/acknowledgements/${indentId}`}
                    className="inline-flex min-h-11 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white">
                    Count and sign
                  </Link>
                )}
              </div>

              {total > 1 && (
                <div className="mt-3" aria-label={`${done} of ${total} stops delivered`}>
                  <div className="flex gap-0.5">
                    {Array.from({ length: total }, (_, index) => {
                      const sequence = index + 1;
                      const mine = sequence === leg.stop_sequence;
                      const reached = sequence <= done || (mine && arrived);
                      return (
                        <span key={sequence} title={mine ? "Your stop" : `Stop ${sequence}`}
                          className={`h-2 flex-1 rounded-full ${mine
                            ? (arrived ? "bg-ok" : "bg-brand") : reached ? "bg-ok/50" : "bg-line"}`} />
                      );
                    })}
                  </div>
                  <div className="mt-1 text-[11px] text-muted">
                    {done} of {total} stops delivered · yours is stop {leg.stop_sequence ?? "—"}
                  </div>
                </div>
              )}

              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                <Fact label="From" value={leg.from_warehouse_name} />
                <Fact label="Carrier" value={leg.carrier_name ?? (leg.vehicle_number ? "Company vehicle" : null)} />
                <Fact label="Vehicle" value={leg.vehicle_number} mono />
                <Fact label="Tracking no." value={leg.lr_no ?? leg.docket_no} mono />
                <Fact label="Left on" value={leg.dispatched_at ? fmtDateTime(leg.dispatched_at) : leg.departure_date ? `Planned ${fmtDate(leg.departure_date)}` : null} />
                <Fact label="Delivered" value={leg.stop_delivered_at ? fmtDateTime(leg.stop_delivered_at) : null} />
                {leg.driver_name && (
                  <div>
                    <dt className="text-[11px] uppercase tracking-wide text-muted">Driver</dt>
                    <dd className="text-body">
                      {leg.driver_name}
                      {phone && (
                        <a href={`tel:${phone}`} className="ml-2 inline-flex min-h-11 items-center gap-1 text-brand sm:min-h-0">
                          <Phone className="h-3.5 w-3.5" />{leg.driver_phone}
                        </a>
                      )}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}

function Fact({ label, value, mono = false }: { label: string; value?: string | null; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className={`truncate text-body ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}
