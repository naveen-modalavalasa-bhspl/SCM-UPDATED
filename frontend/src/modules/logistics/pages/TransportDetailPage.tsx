import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowRight, Camera, CheckCircle2, Clock, Download, FileText,
  MapPin, PhoneCall, Warehouse,
} from "lucide-react";
import {
  Button, Can, Card, ConfirmModal, ErrorBanner, Field, Input, PageHeader,
  StatCard, StatusPill, useAction,
} from "@/shared/components";
import { fmtDate, fmtDateTime } from "@/shared/datetime";
import { transportApi } from "../api";
import { FlowStepper } from "../components/FlowStepper";
import { load, modeLabel, modeTint, money, nextMove } from "../components/modeCopy";
import { CarrierComparison } from "../components/CarrierComparison";
import { ShipmentTimeline } from "../components/ShipmentTimeline";

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
  const [downloadingEvidence, setDownloadingEvidence] = useState<number | null>(null);
  const [evidenceDownloadError, setEvidenceDownloadError] = useState<unknown>(null);

  // Half of this document is written by somebody who is not in this tab: the provider
  // sends a price, accepts the job or declines it, and the driver's leg is tracked from
  // their portal. Left to load once, the desk watches a shipment that has already moved.
  const { data: doc, isLoading, error } = useQuery({
    queryKey: ["transport", id],
    queryFn: () => transportApi.get(trId),
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  });
  const evidence = useQuery({
    queryKey: ["transport", id, "receipt-evidence"],
    queryFn: () => transportApi.receiptEvidence(trId),
    enabled: Boolean(doc?.indent_id && doc?.acknowledged_at),
  });

  const openDispatch = () => {
    if (!doc) return;
    const reference = doc.consignment_no || doc.tr_no;
    setTracking({
      // Fetch anything recorded during booking. A company vehicle has no outside
      // carrier to issue an LR, so SCM's own consignment reference becomes its LR.
      lr_no: doc.lr_no || (doc.mode === "OWN_VEHICLE" ? `LR/${reference}` : ""),
      docket_no: doc.docket_no || "",
      tracking_url: doc.tracking_url || "",
      eway_bill_no: doc.eway_bill_no || "",
      gate_pass_no: doc.gate_pass_no || `GP/${reference}`,
    });
    setDispatching(true);
  };

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
  const share = useAction({
    run: () => transportApi.shareTracking(trId),
    success: "Tracking shared with the field", invalidates,
  });
  const close = useAction({
    run: () => transportApi.close(trId),
    success: "Shipment closed", invalidates,
  });

  const downloadEvidence = async (attachmentId: number, fileName: string) => {
    setDownloadingEvidence(attachmentId);
    setEvidenceDownloadError(null);
    try {
      const blob = await transportApi.downloadReceiptEvidence(trId, attachmentId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
    } catch (downloadError) {
      setEvidenceDownloadError(downloadError);
    } finally {
      setDownloadingEvidence(null);
    }
  };

  if (isLoading) return <div className="p-6 text-muted">Loading…</div>;
  if (!doc) return <ErrorBanner error={error} />;

  const openClaims = doc.events.filter((e) => e.is_exception && !e.resolved_at).length;
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
                <Button onClick={openDispatch}>Dispatch it</Button>
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
              <span className="text-sm font-medium text-muted">
                Waiting for the indent requester
              </span>
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
        ?? carrierDeclined.error ?? approveAward.error
        ?? rejectAward.error ?? evidence.error ?? evidenceDownloadError} />

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

      {["IN_TRANSIT", "DELIVERED"].includes(doc.status) && doc.indent_id && (
        <Card className="mb-4 border-brand/30 bg-brand/5 p-4">
          <p className="text-sm font-semibold text-ink">
            Waiting for {doc.indent_no ?? "the indent"} requester to confirm receipt
          </p>
          <p className="mt-1 text-xs text-muted">
            Logistics can record delivery, but only the person who raised the indent can
            confirm the received quantities and attach the delivery photo and bill.
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

      {doc.acknowledged_at && (
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

      {doc.acknowledged_at && doc.indent_id && (
        <Card className="mb-4 p-4">
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-ink">Requester receipt evidence</h2>
            <p className="mt-0.5 text-xs text-muted">
              Uploaded by the indent requester while confirming the received quantities.
            </p>
          </div>
          {evidence.isLoading ? (
            <p className="text-xs text-muted">Loading receipt evidence…</p>
          ) : (evidence.data ?? []).length > 0 ? (
            <ul className="space-y-2">
              {(evidence.data ?? []).map((attachment) => {
                const isBill = attachment.doc_category === "RECEIPT_BILL";
                return (
                  <li key={attachment.id}
                    className="flex items-center gap-3 rounded-xl border border-line px-3 py-2">
                    {isBill
                      ? <FileText className="h-4 w-4 shrink-0 text-brand" />
                      : <Camera className="h-4 w-4 shrink-0 text-brand" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-ink">
                        {attachment.file_name}
                      </div>
                      <div className="text-[11px] text-muted">
                        {isBill ? "Bill" : "Delivery photo"}
                        {attachment.uploaded_by_name
                          ? ` · uploaded by ${attachment.uploaded_by_name}` : ""}
                      </div>
                    </div>
                    <Button variant="ghost"
                      disabled={downloadingEvidence === attachment.id}
                      onClick={() => downloadEvidence(attachment.id, attachment.file_name)}>
                      <Download className="h-4 w-4" />
                      {downloadingEvidence === attachment.id ? "Opening…" : "Open"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-muted">No receipt photo or bill is attached.</p>
          )}
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
        <Card className="p-5 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg font-semibold text-ink">Consignment</h2>
            {doc.consignment_no && (
              <span className="rounded-md bg-surface px-2 py-1 font-mono text-xs text-ink-500"
                title="Packed as">
                {doc.consignment_no}
              </span>
            )}
          </div>

          {/* The leg itself, read left to right. Where it came from and where it is
           * going were two label/value rows lost among twenty-four others; they are
           * the first question anyone asks of a consignment. */}
          <div className="mt-4 rounded-xl border border-line bg-surface/60 p-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
              <div className="min-w-0">
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
                  <Warehouse size={12} aria-hidden />From
                </div>
                <div className="break-words text-sm font-semibold text-ink">
                  {doc.from_warehouse_name ?? "—"}
                </div>
              </div>
              <div className="flex items-center justify-center gap-1 text-brand" aria-hidden>
                <span className="hidden h-px w-6 bg-brand/30 sm:block" />
                <ArrowRight size={16} className="rotate-90 sm:rotate-0" />
                <span className="hidden h-px w-6 bg-brand/30 sm:block" />
              </div>
              <div className="min-w-0">
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
                  <MapPin size={12} aria-hidden />To
                </div>
                <div className="break-words text-sm font-semibold text-ink">
                  {doc.to_location_name ?? "—"}
                </div>
                {/* Only when it says something the destination name did not. */}
                {doc.delivery_address && doc.delivery_address !== doc.to_location_name && (
                  <div className="mt-0.5 break-words text-xs text-muted">
                    {doc.delivery_address}
                  </div>
                )}
                {doc.contact_person && (
                  <div className="mt-1 flex items-center gap-1 text-xs text-muted">
                    <PhoneCall size={12} aria-hidden />
                    {doc.contact_person}
                    {doc.contact_phone ? ` · ${doc.contact_phone}` : ""}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Grouped, and a group with nothing in it does not draw itself: a booking
           * with no carrier yet should not show four empty carrier rows. */}
          <div className="mt-1 divide-y divide-line/70">
            <Section title="Reference" rows={[
              ["Against indent", doc.indent_no],
              ["Needed by", fmtDate(doc.expected_delivery, "")],
            ]} />
            <Section title="Carrier & vehicle" rows={[
              ["Carrier", doc.carrier_name],
              ["Booking ref", doc.carrier_reference],
              ["Carrier accepted", fmtDateTime(doc.carrier_accepted_at, "")],
              ["Confirmed by the desk", doc.carrier_confirmed_by_name],
              ["Vehicle", doc.vehicle_number],
              ["Driver", doc.driver_name],
              ["Rides on", doc.trip_reference],
            ]} />
            <Section title="Dispatch" rows={[
              ["Gate pass", doc.gate_pass_no],
              ["LR", doc.lr_no],
              ["Docket", doc.docket_no],
              ["E-way bill", doc.eway_bill_no],
              ["Handed over by", doc.handed_over_by_name],
              ["Released by", doc.dispatched_by_name],
              ["Dispatched", fmtDateTime(doc.dispatched_at, "")],
              ["Delivered", fmtDateTime(doc.delivered_at, "")],
              ["Tracking shared", fmtDateTime(doc.tracking_shared_at, "")],
            ]} />
            <Section title="Load" rows={[
              ["Weight", `${Number(doc.total_weight_kg ?? 0)} kg`],
              ["Volume", `${Number(doc.total_volume_cbm ?? 0)} m³`],
            ]} />
          </div>

          <div className="mt-4 border-t border-line/70 pt-4">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
              Lines
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted">
                    <th className="py-2 font-semibold">Item</th>
                    <th className="py-2 text-right font-semibold">Qty</th>
                    <th className="py-2 text-right font-semibold">Pkgs</th>
                    <th className="py-2 text-right font-semibold">Weight</th>
                    <th className="py-2 text-right font-semibold">Delivered</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.items.map((line) => (
                    <tr key={line.id} className="border-b border-line/50 last:border-0">
                      <td className="py-2.5 pr-3 text-body">
                        {line.item_name ?? "—"}
                        {line.is_fragile && (
                          <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                            Fragile
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 text-right font-mono text-body">
                        {Number(line.quantity)}
                      </td>
                      <td className="py-2.5 text-right font-mono text-body">
                        {line.package_count}
                      </td>
                      <td className="py-2.5 text-right font-mono text-muted">
                        {line.weight_kg != null ? `${Number(line.weight_kg)} kg` : "—"}
                      </td>
                      {/* Short delivery is the one number worth spotting from a
                        * metre away, so it is the only one that changes colour. */}
                      <td className={`py-2.5 text-right font-mono font-semibold ${
                        Number(line.delivered_qty) < Number(line.quantity)
                          ? "text-amber-600" : "text-emerald-600"}`}>
                        {Number(line.delivered_qty)}
                      </td>
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

    </div>
  );
}

/** One labelled block of the consignment. An empty row is dropped rather than
 *  printed as an em-dash, and a block with every row empty draws nothing at all —
 *  a screen of placeholders reads as a screen full of data that is not there. */
function Section({
  title, rows,
}: {
  title: string;
  rows: [string, string | null | undefined][];
}) {
  const shown = rows.filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (!shown.length) return null;
  return (
    <div className="py-4 first:pt-2 last:pb-0">
      <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
        {title}
      </h3>
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {shown.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
            <dd className="break-words text-sm text-body">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
