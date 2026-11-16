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
import {
  carriageLabel, carriageTint, load, modeLabel, modeTint, money, nextMove,
} from "../components/modeCopy";
import {
  custodyOf, custodyProblems, HandoverCustody, personKindOf,
} from "../components/HandoverCustody";
import type { CustodyValue, PersonKind } from "../components/HandoverCustody";
import { ShipmentTimeline } from "../components/ShipmentTimeline";
import { ManifestTable } from "../components/ManifestTable";
import { TripRouteStrip, TripStopsPanel } from "../components/TripStops";
import { TONE_APPROVE, TONE_REJECT, TONE_SUBMIT, TONE_YELLOW } from "@/shared/components/tones";

/**
 * One consignment's transport leg, from planning to the signature at the far end.
 *
 * Dispatch is a stage here, not a second document: the gate pass, the LR and the
 * e-way bill are written on this screen, at the moment the consignment leaves, and
 * the acknowledgement lands on the same record so "what did the site say about the
 * thing we sent" is one row and not a join.
 *
 * The action bar is driven entirely by `status`, and it offers only the move that
 * status actually has: a request out to providers offers their answer, a ready one
 * offers dispatch, a moving one offers tracking. Showing every button and disabling
 * most of them was the alternative, and it makes a screen nobody can read at a
 * glance — so a button this desk cannot honestly press is not drawn at all. The
 * signature at the end is one of those: it belongs to whoever raised the indent, and
 * it is made on Indents > Acknowledgements, not here.
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
  // A hand-over records a person, not a paper. Held beside `tracking` rather than
  // inside it because the two are alternatives — a leg fills one or the other — and
  // folding them together makes a nine-field object no press ever answers whole.
  const [custody, setCustody] = useState<CustodyValue>(custodyOf(null));
  const [handoverPerson, setHandoverPerson] = useState<PersonKind>("EMPLOYEE");
  const [declining, setDeclining] = useState(false);
  const [declineNote, setDeclineNote] = useState("");
  const [downloadingEvidence, setDownloadingEvidence] = useState<number | null>(null);
  const [evidenceDownloadError, setEvidenceDownloadError] = useState<unknown>(null);
  const [downloadingDocument, setDownloadingDocument] = useState<number | null>(null);
  const [documentDownloadError, setDocumentDownloadError] = useState<unknown>(null);

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
  // The paperwork uploaded when the load went out (DOD, invoice, LR…) — SCM_0073:
  // the upload step on Dispatch already filed these (DispatchConfirmPage), and the
  // endpoint to read them back has always existed (`transportApi.documents`), but
  // nothing on this screen ever called it, so an attached DOD was invisible on the
  // very record it was filed against.
  const documents = useQuery({
    queryKey: ["transport", id, "documents"],
    queryFn: () => transportApi.documents(trId),
    enabled: Boolean(doc),
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
      // Blank, not a made-up GP/ number: the release issues the dispatch its own.
      gate_pass_no: doc.gate_pass_no || "",
    });
    // What the booking recorded, brought forward so the desk edits an answer rather
    // than retyping one. Which id was filled is itself which kind of person it was.
    setCustody(custodyOf(doc));
    setHandoverPerson(personKindOf(doc));
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
    success: "Award confirmed — the provider has been asked to acknowledge it",
    invalidates,
  });
  const rejectAward = useAction({
    run: () => transportApi.rejectAward(trId, awardRejectNote),
    success: "Award overruled — back out to the carriers", invalidates,
    onDone: () => { setAwardReject(false); setAwardRejectNote(""); },
  });
  // Which arrangement this is decides what the release press records, and it is the
  // ONE branch: a hand-over carries a person, everything else carries paper.
  const isHandover = doc?.mode === "DIRECT";
  const dispatch = useAction({
    run: () => transportApi.dispatch(trId, isHandover ? {
      // The gate pass is still security's, whoever carries the load out.
      gate_pass_no: tracking.gate_pass_no || null,
      handed_over_by_name: custody.handed_over_by_name || null,
      // Only the id the chosen kind of person actually has. Sending both — one of
      // them empty — is what tells the service to replace the pair, so the number
      // left behind by a switch from Others to Employee is cleared rather than
      // printed on the gate pass beside the new one.
      handed_over_employee_id: handoverPerson === "EMPLOYEE"
        ? custody.handed_over_employee_id || null : null,
      handed_over_aadhaar: handoverPerson === "OTHERS"
        ? custody.handed_over_aadhaar || null : null,
      handed_over_phone: custody.handed_over_phone || null,
    } : {
      lr_no: tracking.lr_no || null,
      docket_no: tracking.docket_no || null,
      tracking_url: tracking.tracking_url || null,
      eway_bill_no: tracking.eway_bill_no || null,
      gate_pass_no: tracking.gate_pass_no || null,
    }),
    success: "Dispatched — it has left the yard", invalidates,
    onDone: () => setDispatching(false),
  });
  // Read forward off the same rule the service enforces, so the press says which box
  // is wrong before the round trip rather than after it.
  const custodyGaps = isHandover ? custodyProblems(handoverPerson, custody) : [];
  const carrierDeclined = useAction({
    run: () => transportApi.carrierDeclined(trId, declineNote),
    success: "Back out to the other carriers", invalidates,
    onDone: () => { setDeclining(false); setDeclineNote(""); },
  });
  const share = useAction({
    run: () => transportApi.shareTracking(trId),
    success: "Tracking shared with the field", invalidates,
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
  const downloadDocument = async (attachmentId: number, fileName: string) => {
    setDownloadingDocument(attachmentId);
    setDocumentDownloadError(null);
    try {
      const blob = await transportApi.downloadDocument(trId, attachmentId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
    } catch (downloadError) {
      setDocumentDownloadError(downloadError);
    } finally {
      setDownloadingDocument(null);
    }
  };

  if (isLoading) return <div className="p-6 text-muted">Loading…</div>;
  if (!doc) return <ErrorBanner error={error} />;

  const openClaims = doc.events.filter((e) => e.is_exception && !e.resolved_at).length;
  // A carrier has been picked and this desk has not yet confirmed it. The request
  // stays at QUOTING until it does — so there is no status to read it off. A won
  // tender is the only thing that stamps `awarded_at` while still at QUOTING: an
  // unwind (overruled, or the carrier dropped it) clears the stamp on its way back to
  // the tender. This is the state the Confirm award press exists for, and nothing
  // reaches the carrier's portal while the shipment is in it.
  const awardPending = doc.status === "QUOTING" && Boolean(doc.awarded_at);
  const isTrip = (doc.source_type ?? "").toUpperCase() === "TRIP";
  const tripDeparted = ["IN_TRANSIT", "DELIVERED", "ACKNOWLEDGED", "CLOSED"].includes(doc.status);
  const trackingHandleMissing = !isHandover
    && ["COURIER", "THIRD_PARTY"].includes(doc.mode)
    && !(tracking.lr_no.trim() || tracking.docket_no.trim()
      || doc.lr_no || doc.docket_no);

  return (
    <div>
      <PageHeader
        back={{ to: "/logistics/shipments", label: "Back to Shipments" }}
        eyebrow={doc.consignment_no
          ? `Logistics · Consignment ${doc.consignment_no}`
          : "Logistics"}
        title={doc.tr_no}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav("/logistics/shipments")}>Back</Button>

            {/* The pass, on every mode and for the whole life of the leg. It was
                printable only off the confirm screen, and only on the press that asked
                to stay there — press the primary button instead and the desk was
                navigated to Provider Selection or here, with the paper the gate reads
                behind it and no door back to it. A hired vehicle, an own vehicle, a
                courier, a hand-over and a tender all leave through the same gate, so
                the door is unconditional past DRAFT; a draft leg has nothing arranged
                on it yet, which is the one state the pass would print empty in.

                Same `TONE_YELLOW` pill, glyph and one-word label as the confirm
                screen's and the indent's — one PDF button, everywhere. */}
            {doc.status !== "DRAFT" && (
              <Button variant="secondary" className={TONE_YELLOW}
                onClick={() => window.open(
                  `/logistics/shipments/${doc.id}/gate-pass`, "_blank", "noopener")}>
                <FileText className="h-4 w-4" /> PDF
              </Button>
            )}

            {/* A multi-drop trip's shipment is arranged on the Dispatch screen, like a
                return leg — its lines are the trip's manifest, not something to edit
                here — and its stops are followed right here, below. */}
            {isTrip && doc.status === "DRAFT" && (
              <Can do="transport.create">
                <Button onClick={() => nav(`/logistics/dispatch/new?tr_id=${doc.id}`)}>
                  Arrange transport
                </Button>
              </Can>
            )}
            {!isTrip && doc.status === "DRAFT" && (
              <Can do="transport.create">
                <Button variant="ghost" onClick={() => nav(`/logistics/shipments/${doc.id}/edit`)}>
                  Edit
                </Button>
                <Button className={TONE_SUBMIT} onClick={() => submit.mutate()} disabled={submit.isPending}>
                  Send for approval
                </Button>
              </Can>
            )}

            {doc.status === "PENDING_APPROVAL" && (
              <Can do="transport.approve">
                <Button className={TONE_REJECT} variant="ghost" onClick={() => setReject(true)}>Reject</Button>
                <Button className={TONE_APPROVE} onClick={() => approve.mutate()} disabled={approve.isPending}>
                  Approve
                </Button>
              </Can>
            )}

            {/* Our half of "Provider accepts". The carrier hears nothing until this
                is pressed, so it is the press the whole rung waits on. */}
            {awardPending && (
              <Can do="transport.approve">
                <Button className={TONE_REJECT} variant="ghost" onClick={() => setAwardReject(true)}>
                  Reject award
                </Button>
                <Button onClick={() => approveAward.mutate()}
                  disabled={approveAward.isPending}>
                  Confirm award
                </Button>
              </Can>
            )}

            {/* Their answer, and only the "no" half of it. Accepting is the
                provider's own press in their portal — they name the vehicle and the
                driver with it, and the shipment goes READY on its own — so a desk
                button that said yes for them booked a truck nobody had confirmed and
                left those columns empty. Declining stays, because a provider who
                drops out by phone still has to be recorded somewhere. */}
            {doc.status === "AWAITING_CARRIER" && (
              <Can do="transport.award">
                <Button variant="dangerSoft" onClick={() => setDeclining(true)}>
                  Carrier declined
                </Button>
              </Can>
            )}

            {doc.status === "READY" && (
              <Can do="transport.track">
                <Button onClick={openDispatch}>Dispatch it</Button>
              </Can>
            )}

            {/* On the road, and the only signature left is the site's. "Mark
                delivered" used to sit here and it bought nothing: `acknowledge_tr`
                stamps the delivery itself, so the desk ticking it first was a
                keystroke nobody at the destination can make, holding the indent open
                until somebody here remembered. Tracking is still shared from here,
                because that IS this desk's job while it moves. */}
            {["IN_TRANSIT", "DELIVERED"].includes(doc.status) && (
              <Can do="transport.track">
                <Button variant="ghost" onClick={() => share.mutate()} disabled={share.isPending}>
                  Share tracking
                </Button>
              </Can>
            )}

            {/* NO CLOSE PRESS (2026-09-16). The receiver signing for the load IS the
                end of the leg — `acknowledge_tr` lands it on CLOSED — so this button
                sat in front of somebody who had already finished, could be pressed
                exactly one way, and left every leg nobody remembered to press parked
                in a queue that reads as unfinished work. An open claim does not hold
                it either: a claim is settled on the claim, in the timeline below.
                `transportApi.close` and `POST /{id}/close` both stay, for the legs
                acknowledged before this landed. */}
          </>
        }
      />

      <ErrorBanner error={submit.error ?? approve.error ?? dispatch.error
        ?? share.error
        ?? carrierDeclined.error ?? approveAward.error
        ?? rejectAward.error ?? evidence.error ?? evidenceDownloadError
        ?? documents.error ?? documentDownloadError} />

      {/* A trip is this same shipment with several drops: the route in one line, and
          once the truck leaves, each stop marked delivered from here. */}
      {isTrip && !tripDeparted && (
        <TripRouteStrip className="mb-4" items={doc.items} from={doc.from_warehouse_name} />
      )}

      <FlowStepper
        mode={doc.mode}
        status={doc.status}
        awardPending={awardPending}
        manualCourier={doc.mode === "COURIER" && !doc.carrier_id && Boolean(doc.carrier_name)}
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Status"
          value={<StatusPill status={doc.status} />}
        />
        {/* Both halves of "how does this travel": what it goes ON, and what it was
            arranged as. The carriage may be the CARRIER's answer rather than the
            desk's — a tendered lane can be sent by rail — so it is read off the
            shipment, never inferred from the arrangement beside it. */}
        <StatCard
          label="Mode"
          value={
            <span className="flex flex-wrap items-center gap-1.5">
              <span className={`rounded-full px-2 py-0.5 text-sm font-medium ${carriageTint(doc.carriage_mode)}`}>
                {carriageLabel(doc.carriage_mode)}
              </span>
              <span className={`rounded-full px-2 py-0.5 text-sm font-medium ${modeTint(doc.mode)}`}>
                {modeLabel(doc.mode)}
              </span>
            </span>
          }
        />
        <StatCard label="Load" value={load(doc.total_packages, doc.total_weight_kg)} />
        <StatCard label="Freight" value={money(doc.freight_amount)} />
      </div>

      {/* What to do next, said in one line. The status names the state; a desk
          working a queue needs the move. */}
      {!["CLOSED", "CANCELLED", "REJECTED"].includes(doc.status) && (
        <Card className="mb-4 flex items-center justify-between gap-3 border-brand/30 bg-brand/5 p-4">
          <div className="flex items-center gap-3">
            <Clock className="h-4 w-4 shrink-0 text-brand" />
            <p className="text-sm font-medium text-ink">
              {awardPending
                ? "Confirm the award — then the provider is asked to acknowledge it"
                : nextMove(doc.status)}
            </p>
          </div>
          {/* FIX 2026-09-10: it carries `invite=1`. The press says "Invite carriers",
              and it used to land on the tender sheet with the invite control collapsed
              behind a quiet "Invite more" in the corner — on a shipment nobody has
              quoted yet that is a screen with a heading and an empty table, which reads
              as "this took me nowhere". The parameter opens the partner picker for this
              shipment on arrival, so the button lands on the thing it named. */}
          {doc.status === "QUOTING" && (
            <Button variant="subtle"
                    onClick={() => nav(`/logistics/providers?tr=${doc.id}&invite=1`)}>
              Invite carriers & award
            </Button>
          )}
        </Card>
      )}

      {/* The prices carriers have sent in, read-only. The award itself stays on
          Provider Selection; this only stops a submitted quote looking lost. */}
      {doc.status === "QUOTING" && doc.quotes.length > 0 && (
        <Card className="mb-4 p-4">
          <p className="mb-2 text-sm font-semibold text-ink">
            Quotes — {doc.quotes.filter((q) => q.status !== "INVITED").length} of{" "}
            {doc.quotes.length} carriers replied
          </p>
          <div className="divide-y divide-line">
            {doc.quotes.map((q) => (
              <div key={q.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="font-medium text-ink">{q.carrier_name ?? `Carrier ${q.carrier_id}`}</span>
                {q.status === "INVITED" ? (
                  <span className="text-muted">Awaiting price</span>
                ) : (
                  <span className="text-body">
                    {money(q.freight_amount)}
                    {q.other_charges ? ` + ${money(q.other_charges)}` : ""}
                    {q.tax_percent != null ? ` · ${q.tax_percent}% tax` : ""}
                    {q.transit_days != null ? ` · ${q.transit_days} d` : ""}
                    {q.submitted_at ? ` · ${fmtDateTime(q.submitted_at)}` : ""}
                  </span>
                )}
              </div>
            ))}
          </div>
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

      {(documents.isLoading || (documents.data ?? []).length > 0) && (
        <Card className="mb-4 p-4">
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-ink">Shipping documents</h2>
            <p className="mt-0.5 text-xs text-muted">
              The DOD, invoice or LR uploaded when this load was dispatched.
            </p>
          </div>
          {documents.isLoading ? (
            <p className="text-xs text-muted">Loading shipping documents…</p>
          ) : (
            <ul className="space-y-2">
              {(documents.data ?? []).map((attachment) => (
                <li key={attachment.id}
                  className="flex items-center gap-3 rounded-xl border border-line px-3 py-2">
                  <FileText className="h-4 w-4 shrink-0 text-brand" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-ink">
                      {attachment.file_name}
                    </div>
                    <div className="text-[11px] text-muted">
                      {attachment.doc_category ?? "Document"}
                      {attachment.uploaded_by_name
                        ? ` · uploaded by ${attachment.uploaded_by_name}` : ""}
                    </div>
                  </div>
                  <Button variant="ghost"
                    disabled={downloadingDocument === attachment.id}
                    onClick={() => downloadDocument(attachment.id, attachment.file_name)}>
                    <Download className="h-4 w-4" />
                    {downloadingDocument === attachment.id ? "Opening…" : "Open"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
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
            Settle {openClaims === 1 ? "it" : "them"} with the provider on the claim
            itself, in Tracking below. The leg is closed either way — where the goods
            got to and what the carrier still owes for them are two questions.
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
              // Filled by the carrier when they acknowledged the award on a tender,
              // and by the desk on a leg it settled itself. Same columns either way.
              ["Driver phone", doc.driver_phone],
              ["Licence", doc.driver_licence_no],
              ["Rides on", doc.trip_reference],
            ]} />
            <Section title="Dispatch" rows={[
              ["Gate pass", doc.gate_pass_no],
              ["LR", doc.lr_no],
              ["Docket", doc.docket_no],
              ["E-way bill", doc.eway_bill_no],
              ["Handed over by", doc.handed_over_by_name],
              // The number that pins that person down, and the one to ring about the
              // load. On a hand-over these ARE the tracking handle — there is no LR
              // above them to chase it on — and `Section` drops whichever is empty,
              // so a hired leg is unchanged by their being listed here.
              ["Employee ID", doc.handed_over_employee_id],
              ["Aadhaar", doc.handed_over_aadhaar],
              ["Custody phone", doc.handed_over_phone],
              ["Released by", doc.dispatched_by_name],
              ["Dispatched", fmtDateTime(doc.dispatched_at, "")],
              ["Delivered", fmtDateTime(doc.delivered_at, "")],
              ["Tracking shared", fmtDateTime(doc.tracking_shared_at, "")],
            ]} />
            {/* Nobody entered a weight on the packing list, so the total came out
              * zero — that is "not stated", not "weighs nothing". Printing 0 kg reads
              * as a measurement the desk never took. */}
            <Section title="Load" rows={[
              ["Weight", measure(doc.total_weight_kg, "kg")],
              ["Volume", measure(doc.total_volume_cbm, "m³")],
            ]} />
          </div>

          {/* What travels. One panel, shared with the provider desk and with the
            * carrier's own job sheet — a short delivery is argued over the same
            * document from both sides, so it cannot be a different table on each. */}
          {/* A trip on the road is followed by where each drop is, not by what was
              loaded — so the stops (and the press that marks one reached) take the
              manifest's place once the truck has left the gate. */}
          {isTrip && tripDeparted && doc.source_id ? (
            <TripStopsPanel className="mt-4" tripId={doc.source_id} />
          ) : (
            <ManifestTable
              className="mt-4"
              items={doc.items}
              status={doc.status}
            />
          )}
        </Card>

        <div className="space-y-4">
          <ShipmentTimeline trId={doc.id} events={doc.events} status={doc.status} />
        </div>
      </div>

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
        <Field label="Reason" required>
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
        <Field label="Reason" required>
          <Input value={awardRejectNote}
            onChange={(e) => setAwardRejectNote(e.target.value)} />
        </Field>
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
        <Field label="What did they say" required>
          <Input value={declineNote} onChange={(e) => setDeclineNote(e.target.value)} />
        </Field>
      </ConfirmModal>

      {/* What this press RECORDS depends on how the load travels, and a hand-over is
          the one arrangement with no paper to record. It has no LR, no docket and no
          tracking link — nobody issues a lorry receipt for a storekeeper walking a
          carton out — so the desk was being shown four boxes it could only leave
          blank while the one fact the leg does carry, who took the goods, was frozen
          at booking with no way to fix it at the gate. The person who actually
          collects is frequently not the one named the day before. */}
      <ConfirmModal
        isOpen={dispatching}
        title={isHandover ? "Hand this consignment over" : "Dispatch this consignment"}
        message={isHandover
          ? "Record the gate pass and who is taking custody of it."
          : "Record the gate pass and what the field will be given to track it."}
        confirmLabel="It has left"
        busy={dispatch.isPending}
        confirmDisabled={custodyGaps.length > 0}
        onConfirm={() => dispatch.mutate()}
        onClose={() => setDispatching(false)}
      >
        <div className="space-y-3">
          <Field label="Gate pass number" hint="What security wrote it out against">
            <Input value={tracking.gate_pass_no}
              onChange={(e) => setTracking({ ...tracking, gate_pass_no: e.target.value })} />
          </Field>

          {isHandover ? (
            <HandoverCustody
              person={handoverPerson}
              onPerson={setHandoverPerson}
              value={custody}
              onChange={setCustody}
            />
          ) : (
            <>
              <Field
                label="LR number"
                required={trackingHandleMissing}
                hint={trackingHandleMissing ? "This or the docket number is required." : "For a truck"}
              >
                <Input value={tracking.lr_no}
                  onChange={(e) => setTracking({ ...tracking, lr_no: e.target.value })} />
              </Field>
              <Field
                label="Docket number"
                required={trackingHandleMissing}
                hint={trackingHandleMissing ? "This or the LR number is required." : "For a courier"}
              >
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
            </>
          )}

          {/* Why the button is off, rather than an off button and no reason. */}
          {custodyGaps.length > 0 && (
            <ul className="space-y-1 text-xs text-muted">
              {custodyGaps.map((gap) => (
                <li key={gap}>• {gap}</li>
              ))}
            </ul>
          )}
        </div>
      </ConfirmModal>

    </div>
  );
}

/** One labelled block of the consignment. An empty row is dropped rather than
 *  printed as an em-dash, and a block with every row empty draws nothing at all —
 *  a screen of placeholders reads as a screen full of data that is not there. */
const measure = (value: number | null | undefined, unit: string) =>
  value == null || Number(value) === 0
    ? "—"
    : `${Number(value).toLocaleString("en-IN")} ${unit}`;

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
