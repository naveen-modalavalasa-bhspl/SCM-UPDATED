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

/** Every number the desk needs before it can compare this offer against another.
 *
 * A quote missing the tax or the transit days is not a cheaper quote — it is an
 * unrankable one: the landed cost and the lead time are what the comparison scores,
 * and a blank there silently becomes a zero that flatters the bid. So the portal will
 * not send one. The note stays optional; it is the only field that carries no number.
 */
const QUOTE_REQUIRED = [
  "freight_amount", "other_charges", "tax_percent", "transit_days", "vehicle_type",
] as const;

/** The one quote status that means the job is theirs. Anything else on a settled
 *  request — outbid, declined, or never priced — is a tender they did not win. */
const WON = "AWARDED";

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
  const [declineReason, setDeclineReason] = useState("");
  // A quote already sent can be sent again, right up until the desk awards the lane —
  // `record_quote` overwrites the row whenever the request is still QUOTING, and the
  // desk's own "ask for a revised quote" has no other way of being answered. The form
  // is folded away rather than gone, because the common case on an answered tender is
  // reading what you sent, not retyping it; this opens it back up, seeded with the
  // last price. The board has always offered "Revise your price" on these rows — it
  // opened a screen with no form on it.
  const [revising, setRevising] = useState(false);
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

  // The tender is over and it went to somebody else. Read off THEIR quote, never off
  // the shipment's status: past the award the status is describing another carrier's
  // truck, and the portal serves this screen with the winner's half — price, vehicle,
  // LR, scans — blanked out. So the answer has to come from the one row that is still
  // theirs. Every action panel below is gated on it: a losing carrier was being shown
  // "You won this shipment" the moment the award landed, because that card keyed on
  // AWAITING_CARRIER alone.
  const lost = !!myQuote && myQuote.status !== WON && job.status !== "QUOTING";

  const quoted = !!myQuote && myQuote.status !== "INVITED";
  // "0" is an answer; "" is not. Nothing is inferred for them — a zero they typed and
  // a zero we assumed read identically on the comparison sheet.
  const quoteReady = QUOTE_REQUIRED.every((key) => quote[key].trim() !== "");
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
          <StatusPill status={lost ? "NOT_AWARDED" : job.status} />
          {/* Back to the queue this job is actually on, not to whatever tab the board
              defaults to — landing somewhere the job isn't reads as it having vanished.
              An awarded job is not on the board at all: it lives on Acknowledgements,
              which is where taking it is done, so Back goes there. */}
          <Button variant="ghost" onClick={() => nav(backTo(job.status, lost))}>
            Back
          </Button>
        </div>
      </div>

      <ErrorBanner error={sendQuote.error ?? decline.error
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

      {lost && (
        <Card className="space-y-2 p-5">
          <h2 className="font-display text-lg font-semibold text-ink">
            {myQuote?.status === "DECLINED" ? "You declined this job"
              : myQuote?.status === "INVITED" ? "The tender has closed"
                : "Not awarded"}
          </h2>
          <p className="text-sm text-body">
            {myQuote?.status === "DECLINED"
              ? "You turned this shipment down, and the desk placed it with another carrier."
              : myQuote?.status === "INVITED"
                ? "This lane was placed with another carrier before your price came in."
                : "The logistics desk placed this shipment with another carrier. "
                  + "Nothing more is needed from you on it."}
          </p>
          {myQuote?.freight_amount != null && (
            <p className="text-xs text-muted">
              You quoted {money(myQuote.freight_amount)}
              {myQuote.submitted_at ? ` on ${fmtDateTime(myQuote.submitted_at)}` : ""}.
            </p>
          )}
          {/* What it went for, and to whom, is not shown: a tender where the losing
              bidders can read the winning price is not a tender. */}
        </Card>
      )}

      {/* Whatever this carrier's next move is — and only that. */}
      {!lost && job.status === "QUOTING" && (
        <Card className="space-y-3 p-5">
          <div>
            <h2 className="font-display text-lg font-semibold text-ink">
              {revising
                ? "Revise your quote"
                : quoted
                  ? "Quote submitted"
                  : askedAgain ? "Revise your quote" : "Quote for this lane"}
            </h2>
            <p className="text-xs text-muted">
              {myQuote?.submitted_at
                ? `You quoted ${money(myQuote.freight_amount)} on ${fmtDateTime(myQuote.submitted_at)}.`
                : "Your price to move it, anything on top, and how many days you need. "
                  + "Every field marked * has to be answered — 0 where nothing applies."}
            </p>
          </div>

          {quoted && (
            <div className="rounded-lg border border-ok/25 bg-ok-bg p-3 text-sm text-ok">
              <span className="font-semibold">Your quote is in. </span>
              {money(myQuote?.freight_amount)} is with the logistics desk — they will
              either award it or ask you for a better number.
              {!revising && (
                <span className="mt-2 block">
                  <Button variant="ghost" onClick={() => setRevising(true)}>
                    Revise your price
                  </Button>
                </span>
              )}
            </div>
          )}

          {askedAgain && (
            <div className="rounded-lg border border-warn/25 bg-warn-bg p-3 text-sm text-warn">
              <span className="font-semibold">They asked for a new price: </span>
              {askedAgain.remarks}
              {askedAgain.freight_amount != null && (
                <span className="block text-xs">
                  Your last offer was {money(askedAgain.freight_amount)}.
                </span>
              )}
            </div>
          )}
          {(!quoted || revising) && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                {/* "Freight" is the trade word and the API field, but this form is read by
                    a truck operator, not a logistics desk — the label says what to type.
                    The field stays `freight_amount`; only the words changed. */}
                <Field label="Transport charge" hint="Your price to move this load" required>
                  <Input type="number" value={quote.freight_amount}
                    onChange={(e) => setQuote({ ...quote, freight_amount: e.target.value })} />
                </Field>
                <Field label="Other charges" hint="Loading, detention" required>
                  <Input type="number" value={quote.other_charges}
                    onChange={(e) => setQuote({ ...quote, other_charges: e.target.value })} />
                </Field>
                <Field label="Tax %" required>
                  <Input type="number" value={quote.tax_percent}
                    onChange={(e) => setQuote({ ...quote, tax_percent: e.target.value })} />
                </Field>
                <Field label="Transit days" required>
                  <Input type="number" value={quote.transit_days}
                    onChange={(e) => setQuote({ ...quote, transit_days: e.target.value })} />
                </Field>
                <Field label="Vehicle type" required>
                  <Input value={quote.vehicle_type}
                    onChange={(e) => setQuote({ ...quote, vehicle_type: e.target.value })} />
                </Field>
                <Field label="Note">
                  <Input value={quote.remarks}
                    onChange={(e) => setQuote({ ...quote, remarks: e.target.value })} />
                </Field>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  onClick={() => sendQuote.mutate()}
                  disabled={sendQuote.isPending || !quoteReady}
                >
                  {sendQuote.isPending
                    ? "Sending…"
                    : revising || askedAgain ? "Send new price" : "Send quote"}
                </Button>
                {revising && (
                  <Button variant="ghost" onClick={() => setRevising(false)}>
                    Keep my last price
                  </Button>
                )}
                {!quoteReady && (
                  <span className="text-xs text-muted">
                    Fill every field marked * — put 0 where nothing applies.
                  </span>
                )}
              </div>
            </>
          )}
        </Card>
      )}

      {!lost && job.status === "AWAITING_CARRIER" && (
        <Card className="space-y-4 p-5">
          <div>
            <h2 className="font-display text-lg font-semibold text-ink">
              You won this shipment
            </h2>
            <p className="text-sm text-body">
              {money(job.freight_amount)} agreed. Acknowledge it — naming the vehicle
              and the driver coming for the load — and the warehouse will load against
              your booking; decline it and it goes back out to the others.
            </p>
          </div>
          {/* One place to say yes, and it is the one that asks what is coming. Accepting
              here as well would put shipments on READY with no vehicle against them,
              which is a booking nobody can meet at the gate. */}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => nav(`/carrier/acknowledgements?tr=${job.id}`)}>
              Acknowledge the job
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

      {!lost && ["READY", "IN_TRANSIT"].includes(job.status) && (
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

      {!lost && job.status === "IN_TRANSIT" && (
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

      {!lost && ["DELIVERED", "ACKNOWLEDGED"].includes(job.status) && (
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

/** Where "Back" lands: the one list this shipment is on right now. Kept beside the
 *  queues it mirrors — the board carries a chip per rung except AWAITING_CARRIER,
 *  whose rows are worked on the Acknowledgements screen. */
function backTo(status: string, lost: boolean): string {
  if (lost) return "/carrier/jobs?queue=NOT_AWARDED";
  if (status === "AWAITING_CARRIER") return "/carrier/acknowledgements";
  if (["DELIVERED", "ACKNOWLEDGED"].includes(status)) {
    return "/carrier/jobs?queue=DELIVERED,ACKNOWLEDGED";
  }
  return `/carrier/jobs?queue=${status}`;
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
