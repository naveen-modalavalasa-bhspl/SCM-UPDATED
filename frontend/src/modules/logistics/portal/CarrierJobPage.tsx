import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, PackageCheck } from "lucide-react";
import {
  Button, Card, ErrorBanner, Field, Input, Select, StatusPill, useAction,
} from "@/shared/components";
import { fmtDate, fmtDateTime } from "@/shared/datetime";
import { carrierPortalApi } from "../api";
import { load, money } from "../components/modeCopy";

const SCANS = [
  { value: "", label: "No scan, just save the numbers" },
  { value: "PICKED_UP", label: "Picked up" },
  { value: "IN_TRANSIT", label: "In transit" },
  { value: "OUT_FOR_DELIVERY", label: "Out for delivery" },
  { value: "DELAYED", label: "Delayed" },
];

/**
 * One job, from the carrier's side of the fence.
 *
 * The screen is one panel deep by design: whatever the shipment's status is, there is
 * exactly one thing this carrier can do next, and it is the only form on the page.
 * Quote it, take it, tell us where it is, or say it arrived.
 *
 * A carrier cannot mark their own delivery as accepted — that stops at DELIVERED and
 * the receiving site signs for it. That signature is exactly what a shortage claim
 * would need to be missing.
 */
export function CarrierJobPage() {
  const nav = useNavigate();
  const { id } = useParams();
  const jobId = Number(id);

  const [quote, setQuote] = useState({
    freight_amount: "", other_charges: "", tax_percent: "", transit_days: "",
    vehicle_type: "", remarks: "",
  });
  const [reference, setReference] = useState("");
  const [declineReason, setDeclineReason] = useState("");
  const [track, setTrack] = useState({
    lr_no: "", docket_no: "", event_type: "", location_name: "", description: "",
  });
  const [pod, setPod] = useState({ delivered_to_name: "", pod_url: "", remarks: "" });

  const { data: job, isLoading, error } = useQuery({
    queryKey: ["carrier-job", id],
    queryFn: () => carrierPortalApi.get(jobId),
  });

  // The portal serves this carrier's own quote and nobody else's, so there is at most
  // one row here and it is always theirs.
  const myQuote = job?.quotes[0];

  // A revision starts from what they last sent, not from an empty form. Seeded once,
  // on the first load that has a price: re-seeding on every refetch would wipe out
  // what the carrier is typing the moment anything else invalidates the query.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || myQuote?.freight_amount == null) return;
    seeded.current = true;
    setQuote({
      freight_amount: String(myQuote.freight_amount),
      other_charges: myQuote.other_charges ? String(myQuote.other_charges) : "",
      tax_percent: myQuote.tax_percent != null ? String(myQuote.tax_percent) : "",
      transit_days: myQuote.transit_days != null ? String(myQuote.transit_days) : "",
      vehicle_type: myQuote.vehicle_type ?? "",
      remarks: myQuote.remarks ?? "",
    });
  }, [myQuote]);

  const invalidates = [["carrier-job", id], ["carrier-jobs"], ["carrier-summary"]];

  const sendQuote = useAction({
    run: () => carrierPortalApi.quote(jobId, {
      freight_amount: Number(quote.freight_amount || 0),
      other_charges: Number(quote.other_charges || 0),
      tax_percent: quote.tax_percent ? Number(quote.tax_percent) : null,
      transit_days: quote.transit_days ? Number(quote.transit_days) : null,
      vehicle_type: quote.vehicle_type || null,
      remarks: quote.remarks || null,
    }),
    success: "Quote sent", invalidates,
    // Straight back to the queue they answered. Staying on the form after the press
    // left the screen looking exactly as it did before it — same fields, same button —
    // which is why a sent quote read as an unsent one.
    onDone: () => nav("/carrier/jobs?queue=QUOTING"),
  });
  const accept = useAction({
    run: () => carrierPortalApi.accept(jobId, reference),
    success: "Job accepted — the warehouse can load it", invalidates,
  });
  const decline = useAction({
    run: () => carrierPortalApi.decline(jobId, declineReason),
    success: "Declined", invalidates,
    onDone: () => nav("/carrier/jobs"),
  });
  const saveTracking = useAction({
    run: () => carrierPortalApi.track(jobId, {
      lr_no: track.lr_no || null,
      docket_no: track.docket_no || null,
      event_type: track.event_type || null,
      location_name: track.location_name || null,
      description: track.description || null,
    }),
    success: "Updated", invalidates,
    onDone: () => setTrack({ ...track, event_type: "", location_name: "", description: "" }),
  });
  const deliver = useAction({
    run: () => carrierPortalApi.deliver(jobId, {
      delivered_to_name: pod.delivered_to_name || null,
      pod_url: pod.pod_url || null,
      remarks: pod.remarks || null,
    }),
    success: "Reported delivered", invalidates,
  });

  if (isLoading) return <p className="py-10 text-center text-sm text-muted">Loading…</p>;
  if (!job) return <ErrorBanner error={error} />;

  const quoted = !!myQuote && myQuote.status !== "INVITED";
  // The desk sent the price back with a note. It is the first thing to read: it is
  // the only reason this job is on the "quote for it" list a second time.
  const askedAgain = myQuote && myQuote.status === "INVITED"
    && myQuote.remarks && myQuote.freight_amount != null ? myQuote : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-xs font-semibold text-muted">{job.tr_no}</p>
          <h1 className="flex flex-wrap items-center gap-2 font-display text-2xl font-bold text-ink">
            <span className="truncate">{job.from_warehouse_name ?? "Warehouse"}</span>
            <ArrowRight className="h-4 w-4 text-muted" />
            <span className="truncate">{job.to_location_name ?? "Destination"}</span>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill status={job.status} />
          {/* Back to the queue this job is actually on, not to whatever tab the board
              defaults to — landing somewhere the job isn't reads as it having vanished. */}
          <Button variant="ghost" onClick={() => nav(`/carrier/jobs?queue=${
            ["DELIVERED", "ACKNOWLEDGED"].includes(job.status)
              ? "DELIVERED,ACKNOWLEDGED" : job.status}`)}>Back</Button>
        </div>
      </div>

      <ErrorBanner error={sendQuote.error ?? accept.error ?? decline.error
        ?? saveTracking.error ?? deliver.error} />

      <Card className="p-5">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Row label="Load" value={load(job.total_packages, job.total_weight_kg)} />
          <Row label="Volume" value={`${Number(job.total_volume_cbm ?? 0)} m³`} />
          <Row label="Pick up from" value={job.from_warehouse_name} />
          <Row label="Deliver to" value={job.delivery_address ?? job.to_location_name} />
          <Row label="Site contact" value={job.contact_person
            ? `${job.contact_person}${job.contact_phone ? ` · ${job.contact_phone}` : ""}`
            : null} />
          <Row label="Needed by" value={fmtDate(job.expected_delivery)} />
          <Row label="Distance" value={job.distance_km ? `${job.distance_km} km` : null} />
          <Row label="Agreed price" value={job.freight_amount
            ? money(job.freight_amount) : null} />
          <Row label="Your reference" value={job.carrier_reference} />
          {/* What this load is FOR. Already in the payload the portal has always been
              served — `indent_no` is on TROut — it simply was never drawn, so a carrier
              had a shipment number and no idea which request it answered. Rendered
              through `Row`, which hides itself when the field is empty: a leg raised
              against a consolidated consignment names a dispatch rather than any one
              indent, and an ambiguous number is worse here than none. */}
          <Row label="Against request" value={job.indent_no} />
          <Row label="LR / docket" value={job.lr_no ?? job.docket_no} />
          <Row label="Note" value={job.remarks} />
        </dl>

        {job.items.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="py-2">Item</th>
                  <th className="py-2 text-right">Qty</th>
                  <th className="py-2 text-right">Pkgs</th>
                  <th className="py-2 text-right">Weight</th>
                </tr>
              </thead>
              <tbody>
                {job.items.map((line) => (
                  <tr key={line.id} className="border-b border-line/50">
                    <td className="py-2">
                      {line.item_name ?? "—"}
                      {line.is_fragile && (
                        <span className="ml-2 text-[11px] text-amber-600">Fragile</span>
                      )}
                    </td>
                    <td className="py-2 text-right">{Number(line.quantity)}</td>
                    <td className="py-2 text-right">{line.package_count}</td>
                    <td className="py-2 text-right">
                      {line.weight_kg != null ? `${Number(line.weight_kg)} kg` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Whatever this carrier's next move is — and only that. */}
      {job.status === "QUOTING" && (
        <Card className="space-y-3 p-5">
          <div>
            <h2 className="font-display text-lg font-semibold text-ink">
              {quoted
                ? "Quote submitted"
                : askedAgain ? "Revise your quote" : "Quote for this lane"}
            </h2>
            <p className="text-xs text-muted">
              {myQuote?.submitted_at
                ? `You quoted ${money(myQuote.freight_amount)} on ${fmtDateTime(myQuote.submitted_at)}.`
                : "Your price to move it, anything on top, and how many days you need."}
            </p>
          </div>

          {quoted && (
            <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-900/20 dark:text-emerald-200">
              <span className="font-semibold">Your quote is in. </span>
              {money(myQuote?.freight_amount)} is with the logistics desk — they will
              either award it or ask you for a better number.
            </div>
          )}

          {askedAgain && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
              <span className="font-semibold">They asked for a new price: </span>
              {askedAgain.remarks}
              {askedAgain.freight_amount != null && (
                <span className="block text-xs">
                  Your last offer was {money(askedAgain.freight_amount)}.
                </span>
              )}
            </div>
          )}
          {!quoted && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                {/* "Freight" is the trade word and the API field, but this form is read by
                    a truck operator, not a logistics desk — the label says what to type.
                    The field stays `freight_amount`; only the words changed. */}
                <Field label="Transport charge" hint="Your price to move this load">
                  <Input type="number" value={quote.freight_amount}
                    onChange={(e) => setQuote({ ...quote, freight_amount: e.target.value })} />
                </Field>
                <Field label="Other charges" hint="Loading, detention">
                  <Input type="number" value={quote.other_charges}
                    onChange={(e) => setQuote({ ...quote, other_charges: e.target.value })} />
                </Field>
                <Field label="Tax %">
                  <Input type="number" value={quote.tax_percent}
                    onChange={(e) => setQuote({ ...quote, tax_percent: e.target.value })} />
                </Field>
                <Field label="Transit days">
                  <Input type="number" value={quote.transit_days}
                    onChange={(e) => setQuote({ ...quote, transit_days: e.target.value })} />
                </Field>
                <Field label="Vehicle type">
                  <Input value={quote.vehicle_type}
                    onChange={(e) => setQuote({ ...quote, vehicle_type: e.target.value })} />
                </Field>
                <Field label="Note">
                  <Input value={quote.remarks}
                    onChange={(e) => setQuote({ ...quote, remarks: e.target.value })} />
                </Field>
              </div>
              <Button
                onClick={() => sendQuote.mutate()}
                disabled={sendQuote.isPending || !quote.freight_amount}
              >
                {sendQuote.isPending ? "Sending…" : "Send quote"}
              </Button>
            </>
          )}
        </Card>
      )}

      {job.status === "AWAITING_CARRIER" && (
        <Card className="space-y-4 p-5">
          <div>
            <h2 className="font-display text-lg font-semibold text-ink">
              You won this shipment
            </h2>
            <p className="text-sm text-body">
              {money(job.freight_amount)} agreed. Accept it and the warehouse will load
              against your booking; decline it and it goes back out to the others.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Your booking reference" hint="Optional">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => accept.mutate()} disabled={accept.isPending}>
              {accept.isPending ? "Accepting…" : "Accept the job"}
            </Button>
          </div>
          <div className="rounded-lg border border-line p-3">
            <Field label="Cannot take it? Tell us why">
              <Input value={declineReason}
                placeholder="No vehicle for that lane this week"
                onChange={(e) => setDeclineReason(e.target.value)} />
            </Field>
            <div className="mt-2">
              <Button
                variant="dangerSoft"
                onClick={() => decline.mutate()}
                disabled={decline.isPending || !declineReason.trim()}
              >
                Decline
              </Button>
            </div>
          </div>
        </Card>
      )}

      {["READY", "IN_TRANSIT"].includes(job.status) && (
        <Card className="space-y-3 p-5">
          <div>
            <h2 className="font-display text-lg font-semibold text-ink">
              Where is it?
            </h2>
            <p className="text-xs text-muted">
              The LR or docket is what the site is given to track the consignment.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="LR number">
              <Input value={track.lr_no}
                placeholder={job.lr_no ?? ""}
                onChange={(e) => setTrack({ ...track, lr_no: e.target.value })} />
            </Field>
            <Field label="Docket number">
              <Input value={track.docket_no}
                placeholder={job.docket_no ?? ""}
                onChange={(e) => setTrack({ ...track, docket_no: e.target.value })} />
            </Field>
            <Field label="Scan">
              <Select value={track.event_type} options={SCANS}
                onChange={(value) => setTrack({ ...track, event_type: value })} />
            </Field>
            <Field label="Where">
              <Input value={track.location_name}
                onChange={(e) => setTrack({ ...track, location_name: e.target.value })} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Note">
                <Input value={track.description}
                  onChange={(e) => setTrack({ ...track, description: e.target.value })} />
              </Field>
            </div>
          </div>
          <Button onClick={() => saveTracking.mutate()} disabled={saveTracking.isPending}>
            {saveTracking.isPending ? "Saving…" : "Update"}
          </Button>
        </Card>
      )}

      {job.status === "IN_TRANSIT" && (
        <Card className="space-y-3 p-5">
          <div className="flex items-center gap-2">
            <PackageCheck className="h-4 w-4 text-brand" />
            <h2 className="font-display text-lg font-semibold text-ink">
              Report it delivered
            </h2>
          </div>
          <p className="text-xs text-muted">
            The site still signs for it separately — this is your proof of delivery,
            not their acknowledgement.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Who took it">
              <Input value={pod.delivered_to_name}
                onChange={(e) => setPod({ ...pod, delivered_to_name: e.target.value })} />
            </Field>
            <Field label="POD link" hint="A photo or a scan of the signed copy">
              <Input value={pod.pod_url}
                onChange={(e) => setPod({ ...pod, pod_url: e.target.value })} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Note">
                <Input value={pod.remarks}
                  onChange={(e) => setPod({ ...pod, remarks: e.target.value })} />
              </Field>
            </div>
          </div>
          <Button onClick={() => deliver.mutate()} disabled={deliver.isPending}>
            {deliver.isPending ? "Sending…" : "Delivered"}
          </Button>
        </Card>
      )}

      {["DELIVERED", "ACKNOWLEDGED"].includes(job.status) && (
        <Card className="p-5">
          <p className="text-sm text-body">
            Delivered {fmtDateTime(job.delivered_at)}
            {job.delivered_to_name ? ` to ${job.delivered_to_name}` : ""}.
            {job.acknowledged_at
              ? ` The site signed for it on ${fmtDateTime(job.acknowledged_at)}.`
              : " Waiting for the site to sign for it."}
          </p>
        </Card>
      )}

      {job.events.length > 0 && (
        <Card className="space-y-2 p-5">
          <h2 className="font-display text-lg font-semibold text-ink">Timeline</h2>
          <ol className="space-y-2">
            {job.events.map((event) => (
              <li key={event.id} className="flex gap-3 text-sm">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" aria-hidden />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium text-ink">
                      {event.event_type.replace(/_/g, " ").toLowerCase()}
                    </span>
                    <span className="text-[11px] text-muted">
                      {fmtDateTime(event.event_at)}
                    </span>
                  </div>
                  {event.description && (
                    <p className="text-xs text-muted">{event.description}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="text-body">{value}</dd>
    </div>
  );
}
