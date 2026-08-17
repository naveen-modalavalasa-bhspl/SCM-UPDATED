import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock, PhoneCall } from "lucide-react";
import {
  Button, Can, Card, ConfirmModal, ErrorBanner, Field, Input, PageHeader, Select,
  StatCard, StatusPill, useAction,
} from "@/shared/components";
import { fmtDate, fmtDateTime } from "@/shared/datetime";
import { transportApi } from "../api";
import { FlowStepper } from "../components/FlowStepper";
import { load, modeLabel, modeTint, money, nextMove } from "../components/modeCopy";
import { CarrierComparison } from "../components/CarrierComparison";
import { ShipmentTimeline } from "../components/ShipmentTimeline";

const CONDITIONS = [
  { value: "GOOD", label: "Received in good condition" },
  { value: "SHORT", label: "Short — something is missing" },
  { value: "DAMAGED", label: "Damaged in transit" },
];

/**
 * One consignment's transport leg, from planning to the signature at the far end.
 *
 * Dispatch is a stage here, not a second document: the gate pass, the LR and the
 * e-way bill are written on this screen, at the moment the consignment leaves, and
 * the acknowledgement lands on the same record so "what did the site say about the
 * thing we sent" is one row and not a join.
 *
 * The action bar is driven entirely by `status` — a request out to carriers offers
 * the tender, a ready one offers dispatch, a delivered one offers the signature.
 * Showing every button and disabling most of them was the alternative, and it makes
 * a screen nobody can read at a glance.
 */
export function TransportDetailPage() {
  const nav = useNavigate();
  const { id } = useParams();
  const trId = Number(id);

  const [reject, setReject] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const [awardReject, setAwardReject] = useState(false);
  const [awardRejectNote, setAwardRejectNote] = useState("");
  const [dispatching, setDispatching] = useState(false);
  const [tracking, setTracking] = useState({
    lr_no: "", docket_no: "", tracking_url: "", eway_bill_no: "", gate_pass_no: "",
  });
  const [delivering, setDelivering] = useState(false);
  const [delivery, setDelivery] = useState({ delivered_to_name: "", pod_url: "" });
  const [confirming, setConfirming] = useState(false);
  const [confirm, setConfirm] = useState({ confirmed_by: "", carrier_reference: "" });
  const [declining, setDeclining] = useState(false);
  const [declineNote, setDeclineNote] = useState("");
  const [acking, setAcking] = useState(false);
  const [ack, setAck] = useState({
    acknowledged_by_name: "", condition: "GOOD", remarks: "", pod_url: "",
    affected_item_name: "", affected_qty: "", claim_amount: "",
  });

  // Half of this document is written by somebody who is not in this tab: the provider
  // sends a price, accepts the job or declines it, and the driver's leg is tracked from
  // their portal. Left to load once, the desk watches a shipment that has already moved.
  const { data: doc, isLoading, error } = useQuery({
    queryKey: ["transport", id],
    queryFn: () => transportApi.get(trId),
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  });

  const invalidates = [["transport"], ["transport", id], ["lgs-consignment-links"]];
  const submit = useAction({
    run: () => transportApi.submit(trId),
    success: "Sent for approval", invalidates,
  });
  const approve = useAction({
    run: () => transportApi.approve(trId),
    success: "Approved", invalidates,
  });
  const doReject = useAction({
    run: () => transportApi.reject(trId, rejectNote),
    success: "Rejected", invalidates,
    onDone: () => { setReject(false); setRejectNote(""); },
  });
  const approveAward = useAction({
    run: () => transportApi.approveAward(trId),
    success: "Award approved — waiting on the carrier now", invalidates,
  });
  const rejectAward = useAction({
    run: () => transportApi.rejectAward(trId, awardRejectNote),
    success: "Award overruled — back out to the carriers", invalidates,
    onDone: () => { setAwardReject(false); setAwardRejectNote(""); },
  });
  const dispatch = useAction({
    run: () => transportApi.dispatch(trId, {
      lr_no: tracking.lr_no || null,
      docket_no: tracking.docket_no || null,
      tracking_url: tracking.tracking_url || null,
      eway_bill_no: tracking.eway_bill_no || null,
      gate_pass_no: tracking.gate_pass_no || null,
    }),
    success: "Dispatched — it has left the yard", invalidates,
    onDone: () => setDispatching(false),
  });
  const deliver = useAction({
    run: () => transportApi.deliver(trId, {
      delivered_to_name: delivery.delivered_to_name || null,
      pod_url: delivery.pod_url || null,
    }),
    success: "Marked delivered", invalidates,
    onDone: () => setDelivering(false),
  });
  const confirmCarrier = useAction({
    run: () => transportApi.confirmCarrier(trId, confirm.confirmed_by,
      confirm.carrier_reference),
    success: "Carrier confirmed", invalidates,
    onDone: () => setConfirming(false),
  });
  const carrierDeclined = useAction({
    run: () => transportApi.carrierDeclined(trId, declineNote),
    success: "Back out to the other carriers", invalidates,
    onDone: () => { setDeclining(false); setDeclineNote(""); },
  });
  const acknowledge = useAction({
    run: () => transportApi.acknowledge(trId, {
      acknowledged_by_name: ack.acknowledged_by_name || null,
      condition: ack.condition,
      remarks: ack.remarks || null,
      pod_url: ack.pod_url || null,
      affected_item_name: ack.affected_item_name || null,
      affected_qty: ack.affected_qty ? Number(ack.affected_qty) : null,
      claim_amount: ack.claim_amount ? Number(ack.claim_amount) : null,
    }),
    success: "Acknowledged", invalidates,
    onDone: () => setAcking(false),
  });
  const share = useAction({
    run: () => transportApi.shareTracking(trId),
    success: "Tracking shared with the field", invalidates,
  });
  const close = useAction({
    run: () => transportApi.close(trId),
    success: "Shipment closed", invalidates,
  });

  if (isLoading) return <div className="p-6 text-muted">Loading…</div>;
  if (!doc) return <ErrorBanner error={error} />;

  const openClaims = doc.events.filter((e) => e.is_exception && !e.resolved_at).length;
  const isClaim = ack.condition !== "GOOD";
  // Awarding freight starts its OWN approval (CARRIER_AWARD sanctions the spend), and
  // the request stays at QUOTING until that is signed — so there is no status to read
  // it off. A won tender is the only thing that stamps `awarded_at` while still at
  // QUOTING: an unwind (overruled, or the carrier dropped it) clears the stamp on its
  // way back to the tender. Without this the award had nowhere to be decided and the
  // shipment sat at QUOTING forever, invisible to the carrier's portal.
  const awardPending = doc.status === "QUOTING" && Boolean(doc.awarded_at);

  return (
    <div>
      <PageHeader
        eyebrow={doc.consignment_no
          ? `Logistics · Consignment ${doc.consignment_no}`
          : "Logistics"}
        title={doc.tr_no}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav("/logistics/transport")}>Back</Button>

            {doc.status === "DRAFT" && (
              <Can do="transport.create">
                <Button variant="ghost" onClick={() => nav(`/logistics/transport/${doc.id}/edit`)}>
                  Edit
                </Button>
                <Button onClick={() => submit.mutate()} disabled={submit.isPending}>
                  Send for approval
                </Button>
              </Can>
            )}

            {doc.status === "PENDING_APPROVAL" && (
              <Can do="transport.approve">
                <Button variant="ghost" onClick={() => setReject(true)}>Reject</Button>
                <Button onClick={() => approve.mutate()} disabled={approve.isPending}>
                  Approve
                </Button>
              </Can>
            )}

            {awardPending && (
              <Can do="transport.approve">
                <Button variant="ghost" onClick={() => setAwardReject(true)}>
                  Reject award
                </Button>
                <Button onClick={() => approveAward.mutate()}
                  disabled={approveAward.isPending}>
                  Approve award
                </Button>
              </Can>
            )}

            {doc.status === "AWAITING_CARRIER" && (
              <Can do="transport.award">
                <Button variant="dangerSoft" onClick={() => setDeclining(true)}>
                  Carrier declined
                </Button>
                <Button onClick={() => setConfirming(true)}>
                  Confirm on the phone
                </Button>
              </Can>
            )}

            {doc.status === "READY" && (
              <Can do="transport.track">
                <Button onClick={() => setDispatching(true)}>Dispatch it</Button>
              </Can>
            )}

            {doc.status === "IN_TRANSIT" && (
              <Can do="transport.track">
                <Button variant="ghost" onClick={() => share.mutate()} disabled={share.isPending}>
                  Share tracking
                </Button>
                <Button onClick={() => setDelivering(true)}>Mark delivered</Button>
              </Can>
            )}

            {doc.status === "DELIVERED" && (
              <>
                <Can do="transport.acknowledge">
                  <Button onClick={() => setAcking(true)}>Acknowledge receipt</Button>
                </Can>
                <Can do="transport.track">
                  <Button variant="ghost" onClick={() => close.mutate()}
                    disabled={close.isPending}>
                    Close without signature
                  </Button>
                </Can>
              </>
            )}

            {doc.status === "ACKNOWLEDGED" && (
              <Can do="transport.track">
                <Button onClick={() => close.mutate()} disabled={close.isPending}>
                  Close shipment
                </Button>
              </Can>
            )}
          </>
        }
      />

      <ErrorBanner error={submit.error ?? approve.error ?? dispatch.error
        ?? deliver.error ?? close.error ?? share.error ?? confirmCarrier.error
        ?? carrierDeclined.error ?? acknowledge.error ?? approveAward.error
        ?? rejectAward.error} />

      <FlowStepper mode={doc.mode} status={doc.status} />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Status"
          value={<StatusPill status={doc.status} />}
        />
        <StatCard
          label="Mode"
          value={
            <span className={`rounded-full px-2 py-0.5 text-sm font-medium ${modeTint(doc.mode)}`}>
              {modeLabel(doc.mode)}
            </span>
          }
        />
        <StatCard label="Load" value={load(doc.total_packages, doc.total_weight_kg)} />
        <StatCard label="Freight" value={money(doc.freight_amount)} />
      </div>

      {/* What to do next, said in one line. The status names the state; a desk
          working a queue needs the move. */}
      {!["CLOSED", "CANCELLED", "REJECTED"].includes(doc.status) && (
        <Card className="mb-4 flex items-center gap-3 border-brand/30 bg-brand/5 p-4">
          <Clock className="h-4 w-4 shrink-0 text-brand" />
          <p className="text-sm font-medium text-ink">
            {awardPending ? "Waiting on sign-off for the freight" : nextMove(doc.status)}
          </p>
        </Card>
      )}

      {awardPending && (
        <Card className="mb-4 border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-900/20">
          <div className="flex items-start gap-3">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="text-sm text-amber-900 dark:text-amber-200">
              <p className="font-semibold">
                {doc.carrier_name} won this lane at {money(doc.freight_amount)}
                {doc.awarded_by_name ? `, awarded by ${doc.awarded_by_name}` : ""} —
                the spend is waiting for approval.
              </p>
              <p className="mt-0.5 text-xs">
                Nothing reaches the carrier until it is approved. Rejecting it puts every
                quote back on the sheet so a different carrier can be picked.
              </p>
            </div>
          </div>
        </Card>
      )}

      {doc.status === "AWAITING_CARRIER" && (
        <Card className="mb-4 border-orange-300 bg-orange-50 p-4 dark:border-orange-900 dark:bg-orange-900/20">
          <div className="flex items-start gap-3">
            <PhoneCall className="mt-0.5 h-4 w-4 shrink-0 text-orange-600" />
            <div className="text-sm text-orange-900 dark:text-orange-200">
              <p className="font-semibold">
                {doc.carrier_name} has been awarded {money(doc.freight_amount)} and has
                not confirmed yet.
              </p>
              <p className="mt-0.5 text-xs">
                They accept it in their own portal. If they confirmed by phone instead,
                record that here — it is stored as a desk confirmation, not as theirs.
              </p>
            </div>
          </div>
        </Card>
      )}

      {doc.carrier_declined_at && doc.status === "QUOTING" && (
        <Card className="mb-4 border-rose-200 bg-rose-50 p-4 dark:border-rose-900 dark:bg-rose-900/20">
          <p className="text-sm text-rose-900 dark:text-rose-200">
            <strong>The awarded carrier dropped this job.</strong>{" "}
            {doc.carrier_decline_reason} — award it to somebody else below.
          </p>
        </Card>
      )}

      {doc.status === "ACKNOWLEDGED" && (
        <Card className="mb-4 border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-900/20">
          <div className="flex items-start gap-3">
            {doc.ack_condition === "GOOD"
              ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />}
            <div className="text-sm text-emerald-900 dark:text-emerald-200">
              <p className="font-semibold">
                Signed for by {doc.acknowledged_by_name ?? "the site"} on{" "}
                {fmtDateTime(doc.acknowledged_at)} — {doc.ack_condition?.toLowerCase()}
              </p>
              {doc.ack_remarks && <p className="mt-0.5 text-xs">{doc.ack_remarks}</p>}
            </div>
          </div>
        </Card>
      )}

      {openClaims > 0 && (
        <Card className="mb-4 border-amber-300 bg-amber-50 p-4 dark:bg-amber-900/20">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
            {openClaims} open claim{openClaims === 1 ? "" : "s"} on this consignment.
            It cannot be closed until they are settled with the provider.
          </p>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="space-y-3 p-5 lg:col-span-2">
          <h2 className="font-display text-lg font-semibold text-ink">Consignment</h2>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Detail label="Packed as" value={doc.consignment_no} />
            <Detail label="From" value={doc.from_warehouse_name} />
            <Detail label="To" value={doc.to_location_name} />
            <Detail label="Address" value={doc.delivery_address} />
            <Detail label="Contact" value={doc.contact_person
              ? `${doc.contact_person}${doc.contact_phone ? ` · ${doc.contact_phone}` : ""}`
              : null} />
            <Detail label="Against indent" value={doc.indent_no} />
            <Detail label="Needed by" value={fmtDate(doc.expected_delivery)} />
            <Detail label="Carrier" value={doc.carrier_name} />
            <Detail label="Carrier's booking ref" value={doc.carrier_reference} />
            <Detail label="Carrier accepted" value={fmtDateTime(doc.carrier_accepted_at)} />
            <Detail label="Confirmed by the desk" value={doc.carrier_confirmed_by_name} />
            <Detail label="Vehicle" value={doc.vehicle_number} />
            <Detail label="Driver" value={doc.driver_name} />
            <Detail label="Rides on" value={doc.trip_reference} />
            <Detail label="Handed over by" value={doc.handed_over_by_name} />
            <Detail label="Received by" value={doc.received_by_name} />
            <Detail label="Gate pass" value={doc.gate_pass_no} />
            <Detail label="LR" value={doc.lr_no} />
            <Detail label="Docket" value={doc.docket_no} />
            <Detail label="E-way bill" value={doc.eway_bill_no} />
            <Detail label="Dispatched" value={fmtDateTime(doc.dispatched_at)} />
            <Detail label="Released by" value={doc.dispatched_by_name} />
            <Detail label="Delivered" value={fmtDateTime(doc.delivered_at)} />
            <Detail label="Weight" value={`${Number(doc.total_weight_kg ?? 0)} kg`} />
            <Detail label="Volume" value={`${Number(doc.total_volume_cbm ?? 0)} m³`} />
            <Detail label="Tracking shared" value={fmtDateTime(doc.tracking_shared_at)} />
          </dl>

          <div className="pt-2">
            <h3 className="mb-2 text-sm font-semibold text-ink">Lines</h3>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th className="py-2">Item</th>
                    <th className="py-2 text-right">Qty</th>
                    <th className="py-2 text-right">Pkgs</th>
                    <th className="py-2 text-right">Weight</th>
                    <th className="py-2 text-right">Delivered</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.items.map((line) => (
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
                      <td className="py-2 text-right">{Number(line.delivered_qty)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Card>

        <div className="space-y-4">
          <ShipmentTimeline trId={doc.id} events={doc.events} status={doc.status} />
        </div>
      </div>

      {/* The tender only exists for a mode that is actually quoted. */}
      {doc.mode === "THIRD_PARTY" && (
        <div className="mt-4">
          <CarrierComparison trId={doc.id} status={doc.status} quotes={doc.quotes}
            awardPending={awardPending} />
        </div>
      )}

      <ConfirmModal
        isOpen={reject}
        title={`Reject ${doc.tr_no}?`}
        message="The raiser is told why. Say what has to change."
        confirmLabel="Reject"
        danger
        busy={doReject.isPending}
        confirmDisabled={!rejectNote.trim()}
        onConfirm={() => doReject.mutate()}
        onClose={() => setReject(false)}
      >
        <Field label="Reason">
          <Input value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} />
        </Field>
      </ConfirmModal>

      <ConfirmModal
        isOpen={awardReject}
        title={`Reject the award on ${doc.tr_no}?`}
        message="The shipment goes back out to the carriers — every quote returns to the comparison sheet. Say why this one was not accepted."
        confirmLabel="Reject award"
        danger
        busy={rejectAward.isPending}
        confirmDisabled={!awardRejectNote.trim()}
        onConfirm={() => rejectAward.mutate()}
        onClose={() => setAwardReject(false)}
      >
        <Field label="Reason">
          <Input value={awardRejectNote}
            onChange={(e) => setAwardRejectNote(e.target.value)} />
        </Field>
      </ConfirmModal>

      <ConfirmModal
        isOpen={confirming}
        title="Confirm the carrier accepted"
        message="Use this only when the carrier confirmed outside the portal. It is recorded as a desk confirmation."
        confirmLabel="Confirm"
        busy={confirmCarrier.isPending}
        confirmDisabled={!confirm.confirmed_by.trim()}
        onConfirm={() => confirmCarrier.mutate()}
        onClose={() => setConfirming(false)}
      >
        <div className="space-y-3">
          <Field label="Who at the carrier confirmed it">
            <Input value={confirm.confirmed_by}
              onChange={(e) => setConfirm({ ...confirm, confirmed_by: e.target.value })} />
          </Field>
          <Field label="Their booking reference" hint="Optional">
            <Input value={confirm.carrier_reference}
              onChange={(e) => setConfirm({ ...confirm, carrier_reference: e.target.value })} />
          </Field>
        </div>
      </ConfirmModal>

      <ConfirmModal
        isOpen={declining}
        title="The carrier dropped this job"
        message="The award is undone and the shipment goes back out to the other carriers who quoted."
        confirmLabel="Put it back out"
        danger
        busy={carrierDeclined.isPending}
        confirmDisabled={!declineNote.trim()}
        onConfirm={() => carrierDeclined.mutate()}
        onClose={() => setDeclining(false)}
      >
        <Field label="What did they say">
          <Input value={declineNote} onChange={(e) => setDeclineNote(e.target.value)} />
        </Field>
      </ConfirmModal>

      <ConfirmModal
        isOpen={dispatching}
        title="Dispatch this consignment"
        message="Record the gate pass and what the field will be given to track it."
        confirmLabel="It has left"
        busy={dispatch.isPending}
        onConfirm={() => dispatch.mutate()}
        onClose={() => setDispatching(false)}
      >
        <div className="space-y-3">
          <Field label="Gate pass number" hint="What security wrote it out against">
            <Input value={tracking.gate_pass_no}
              onChange={(e) => setTracking({ ...tracking, gate_pass_no: e.target.value })} />
          </Field>
          <Field label="LR number" hint="For a truck">
            <Input value={tracking.lr_no}
              onChange={(e) => setTracking({ ...tracking, lr_no: e.target.value })} />
          </Field>
          <Field label="Docket number" hint="For a courier">
            <Input value={tracking.docket_no}
              onChange={(e) => setTracking({ ...tracking, docket_no: e.target.value })} />
          </Field>
          <Field label="Tracking link">
            <Input value={tracking.tracking_url}
              onChange={(e) => setTracking({ ...tracking, tracking_url: e.target.value })} />
          </Field>
          <Field label="E-way bill">
            <Input value={tracking.eway_bill_no}
              onChange={(e) => setTracking({ ...tracking, eway_bill_no: e.target.value })} />
          </Field>
        </div>
      </ConfirmModal>

      <ConfirmModal
        isOpen={delivering}
        title="Mark delivered"
        message="Every line is recorded as delivered in full. The site still has to sign for it."
        confirmLabel="Delivered"
        busy={deliver.isPending}
        onConfirm={() => deliver.mutate()}
        onClose={() => setDelivering(false)}
      >
        <div className="space-y-3">
          <Field label="Received by">
            <Input value={delivery.delivered_to_name}
              onChange={(e) => setDelivery({ ...delivery, delivered_to_name: e.target.value })} />
          </Field>
          <Field label="Proof of delivery link">
            <Input value={delivery.pod_url}
              onChange={(e) => setDelivery({ ...delivery, pod_url: e.target.value })} />
          </Field>
        </div>
      </ConfirmModal>

      <ConfirmModal
        isOpen={acking}
        title="Acknowledge receipt"
        message="What the receiving site actually found. Short or damaged raises a claim against the provider."
        confirmLabel="Sign for it"
        busy={acknowledge.isPending}
        confirmDisabled={isClaim && !ack.remarks.trim()}
        onConfirm={() => acknowledge.mutate()}
        onClose={() => setAcking(false)}
      >
        <div className="space-y-3">
          <Field label="Who received it">
            <Input value={ack.acknowledged_by_name}
              onChange={(e) => setAck({ ...ack, acknowledged_by_name: e.target.value })} />
          </Field>
          <Field label="Condition">
            <Select
              value={ack.condition}
              options={CONDITIONS}
              onChange={(value) => setAck({ ...ack, condition: value })}
            />
          </Field>
          <Field label={isClaim ? "What was wrong (required)" : "Note"}>
            <Input value={ack.remarks}
              onChange={(e) => setAck({ ...ack, remarks: e.target.value })} />
          </Field>
          {isClaim && (
            <>
              <Field label="Item affected">
                <Input value={ack.affected_item_name}
                  onChange={(e) => setAck({ ...ack, affected_item_name: e.target.value })} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Qty">
                  <Input type="number" value={ack.affected_qty}
                    onChange={(e) => setAck({ ...ack, affected_qty: e.target.value })} />
                </Field>
                <Field label="Claim value">
                  <Input type="number" value={ack.claim_amount}
                    onChange={(e) => setAck({ ...ack, claim_amount: e.target.value })} />
                </Field>
              </div>
            </>
          )}
          <Field label="Signed acknowledgement link" hint="Optional — a scan or a photo">
            <Input value={ack.pod_url}
              onChange={(e) => setAck({ ...ack, pod_url: e.target.value })} />
          </Field>
        </div>
      </ConfirmModal>
    </div>
  );
}

function Detail({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="text-body">{value}</dd>
    </div>
  );
}
