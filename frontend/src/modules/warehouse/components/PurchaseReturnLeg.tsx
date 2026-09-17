import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2, Clock, MapPin, Package, Phone, Truck, UserRound, Warehouse, XCircle,
} from "lucide-react";
import {
  Button, Can, Card, ErrorBanner, Field, Input, useToast, TONE_DEEP_MINT,
} from "@/shared/components";
import { arrangeReturnTransport, purchaseReturnVehicleArrangements } from "../api";
import { fmtDate, fmtDateTime, fmtMoney } from "../format";
import type {
  PurchaseReturn, PurchaseReturnJourneyLeg, ReturnVehicleArrangement,
} from "../types";

/**
 * THE RETURN LEG — everything that happens to a purchase return after it has gone to the
 * vendor, on one band of the review screen.
 *
 *     SENT_TO_VENDOR  ──vendor rejects──▶  REJECTED
 *                     ──vendor approves─▶  VENDOR_APPROVED
 *                        ├ vendor takes a refund ──▶ REFUNDED (money, terminal)
 *                        └ vendor asks for a replacement ──▶ REPLACEMENT_AGREED
 *                              └ WE choose the transport
 *                                   ├ vendor's vehicle  ▶ they accept ▶ they collect
 *                                   └ our Logistics leg ▶ released
 *                              ▶ vendor signs for it ▶ they dispatch the replacement
 *                              ▶ the store books it in on the GRN the dispatch note
 *                                raised ▶ QC ▶ putaway ▶ the return closes itself
 *
 * THE TAIL IS THE ORDINARY INWARD PATH. Nothing about a replacement is received,
 * inspected or placed differently from any other delivery, so there are no presses for it
 * here — the store works the goods receipt, the inspection and the putaway on the screens
 * it already works, and this band SAYS where that has got to (`replacement_intake_stage`,
 * served) so nobody has to open three documents to find out.
 *
 * WHOSE SCREEN THIS IS, and what changed on 2026-09-12. This band used to carry four
 * presses of ours: approve, reject, refund, and record the vendor's vehicle. None of them
 * were ours to make — they are answers only the VENDOR can give, and our desk was
 * answering on their behalf from a phone call. They now live on the supplier portal.
 *
 * What is left here is ONE press: whose vehicle carries the goods to the vendor. That is
 * the only question the business actually asks this warehouse, and it is the one that
 * commits us to freight.
 *
 * So the band has two jobs now. It SHOWS where the return is standing — including which
 * press the vendor still owes us, so a storekeeper chasing one knows whether to ring
 * them — and it TAKES the transport decision when that decision is open.
 *
 * NOTHING HERE DECIDES WHAT IS LEGAL. `can_arrange_transport`, `replacement_intake_stage`
 * and every `awaiting_*` flag are SERVED: they are the service's own status guards, and
 * re-deriving them from the status string in a screen would be a second copy of the
 * ladder drifting from the first. `<Can>` on top is the UX gate only; the permission that
 * matters is checked on the route (rule 6).
 *
 * ANSWERED IS NOT DISABLED. Once a decision is recorded its buttons come OFF the screen
 * rather than greying out, and what was decided is stated in its place. A greyed-out
 * Confirm next to the words "Arranged by Rekha" is an invitation to wonder whether the
 * press failed.
 */

/** What a served leg's state looks like on the rail. */
const LEG_TONE: Record<string, string> = {
  completed: "border-ok/40 bg-ok-bg text-ok",
  current: "border-warn/50 bg-warn-bg text-warn",
  rejected: "border-bad/40 bg-bad-bg text-bad",
  cancelled: "border-line bg-content2 text-muted",
  pending: "border-line bg-content2 text-muted",
};

const LEG_MARK: Record<string, React.ReactNode> = {
  completed: "✓",
  current: <Clock className="h-2.5 w-2.5" />,
  rejected: <XCircle className="h-2.5 w-2.5" />,
  cancelled: "–",
};

/**
 * The tracker, drawn from the SERVED journey.
 *
 * The rungs used to be a hard-coded list in this file, keyed off status strings. They are
 * the server's now (`GET /returns/{id}/dossier` → `journey`), for the reason every other
 * catalogue in this module is served: the flow the screen describes and the flow the
 * guards enforce must be one flow. A leg this particular return will never reach — a
 * refund never travels — arrives as `cancelled` with a caption saying why, rather than
 * being dropped, so the band always describes the whole process.
 */
function Rail({ legs }: { legs: PurchaseReturnJourneyLeg[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-2">
      {legs.map((leg, index) => (
        <li key={leg.key} className="flex items-center gap-1">
          {index > 0 && (
            <span aria-hidden
                  className={`h-px w-4 ${
                    leg.state === "completed" ? "bg-ok" : "bg-line"}`} />
          )}
          <span
            title={leg.detail ?? undefined}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1
                        text-[11px] font-semibold ${
              LEG_TONE[leg.state] ?? LEG_TONE.pending} ${
              leg.state === "cancelled" ? "line-through" : ""}`}
          >
            <span aria-hidden
                  className={`flex h-4 w-4 items-center justify-center rounded-full
                              text-[9px] font-bold ${
                    leg.state === "completed"
                      ? "bg-ok text-white"
                      : leg.state === "current"
                        ? "bg-warn text-white"
                        : leg.state === "rejected"
                          ? "bg-bad text-white"
                          : "bg-line text-muted"}`}>
              {LEG_MARK[leg.state] ?? index + 1}
            </span>
            {leg.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** A settled fact, stated once. */
function Note({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-sm text-body">
      {icon && <span className="mt-0.5 shrink-0 text-muted">{icon}</span>}
      <span>{children}</span>
    </p>
  );
}

/**
 * What the VENDOR still owes us, said plainly.
 *
 * Its own panel rather than a disabled version of the old buttons, because these are not
 * our presses at all. A storekeeper chasing a return needs to know the difference between
 * "nobody has done anything" and "we are waiting on them", and that is the whole content
 * of this box.
 */
function AwaitingVendor({ doc }: { doc: PurchaseReturn }) {
  const waiting =
    doc.awaiting_vendor_decision
      ? "to approve or reject this return against the GRN, PO and QC we sent them"
      : doc.awaiting_vendor_settlement
        ? "to tell us whether they are refunding the value or sending a replacement"
        : doc.awaiting_vendor_transport
          ? "to accept the collection and name the vehicle they are sending"
          : doc.awaiting_vendor_receipt
            ? "to sign for the goods at their own dock"
            : doc.awaiting_replacement_dispatch
              ? "to dispatch the replacement and tell us what is in the carton"
              : null;
  if (!waiting) return null;
  return (
    <div className="rounded-xl border border-warn/30 bg-warn-bg/40 p-4">
      <p className="flex items-start gap-2 text-sm text-body">
        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
        <span>
          <span className="font-semibold">
            Waiting on {doc.vendor_name ?? "the vendor"}
          </span>{" "}
          {waiting}. They answer on their own supplier portal — there is nothing to press
          here.
        </span>
      </p>
    </div>
  );
}

/**
 * No `basePath` and nothing that navigates, on purpose. This screen is opened from two
 * module rails (see `PurchaseReturnDetail`), and every press in this band is worked in
 * place — so there is no route to keep on the right side of.
 */
export function PurchaseReturnLeg(
  { doc, journey = [] }: { doc: PurchaseReturn; journey?: PurchaseReturnJourneyLeg[] },
) {
  const qc = useQueryClient();
  const toast = useToast();

  const [picked, setPicked] = useState<ReturnVehicleArrangement | "">("");
  const [pickupAddress, setPickupAddress] = useState(doc.warehouse_name ?? "");
  const [readyDate, setReadyDate] = useState("");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["warehouse", "purchase-return"] });
    qc.invalidateQueries({ queryKey: ["warehouse-purchase-returns"] });
  };

  // The two cards, served. Only fetched where the question is actually open, so a
  // read-only reader costs nothing.
  const { data: arrangements = [] } = useQuery({
    queryKey: ["warehouse", "purchase-return", "vehicle-arrangements"],
    queryFn: purchaseReturnVehicleArrangements,
    enabled: !!doc.can_arrange_transport,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const arrange = useMutation({
    mutationFn: () => arrangeReturnTransport(doc.id, {
      arrangement: picked as ReturnVehicleArrangement,
      pickup_address: pickupAddress.trim() || null,
      ready_date: readyDate || null,
    }),
    onSuccess: (row) => {
      invalidate();
      toast.success(
        row.vehicle_arrangement === "WAREHOUSE_REQUESTS"
          ? `Return leg ${row.outbound_tr_no ?? ""} raised with Logistics.`.trim()
          : "Recorded — the vendor is sending a vehicle to collect.");
    },
  });

  // The band has nothing to say about a return that has not gone anywhere.
  if (!doc.sent_at && !doc.vendor_decision) return null;

  const rejected = doc.vendor_decision === "REJECTED";
  const refunded = doc.status === "REFUNDED";
  const stripe = rejected ? "bg-bad"
    : refunded || doc.received_at ? "bg-ok"
      : doc.vendor_decision ? "bg-info" : "bg-warn";
  const hasVehicle = !!(doc.inbound_vehicle_no || doc.inbound_driver_name
    || doc.inbound_transporter_name || doc.outbound_tr_no);

  return (
    <Card className="overflow-hidden p-0">
      <div className={`h-1 w-full ${stripe}`} />
      <div className="space-y-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">
            The return journey
          </h2>
          {doc.status_label && (
            <span className="rounded-full border border-line bg-content2 px-2.5 py-1
                             text-[11px] font-semibold text-body">
              {doc.status_label}
            </span>
          )}
        </div>

        {journey.length > 0 && <Rail legs={journey} />}

        {/* ---- what is already settled, stated as fact ---- */}
        {doc.vendor_decision && (
          <div className="space-y-2 rounded-xl border border-line bg-content2/50 p-4">
            <Note icon={rejected ? <XCircle className="h-4 w-4" />
              : <CheckCircle2 className="h-4 w-4" />}>
              <span className="font-semibold">
                {rejected ? "Rejected" : "Approved"} by{" "}
                {doc.vendor_decision_by_name ?? "the vendor"}
              </span>
              {doc.vendor_decision_at && ` on ${fmtDateTime(doc.vendor_decision_at)}`}
              {doc.vendor_decision_note && <> — “{doc.vendor_decision_note}”</>}
            </Note>

            {refunded && doc.vendor_refund_amount != null && (
              <Note icon={<CheckCircle2 className="h-4 w-4" />}>
                Settled with a refund of{" "}
                <span className="font-semibold">
                  ₹ {fmtMoney(doc.vendor_refund_amount)}
                </span>
                . Nothing travels — track the credit note against this return.
              </Note>
            )}

            {doc.vehicle_arrangement_label && (
              <Note icon={<Truck className="h-4 w-4" />}>
                {doc.vehicle_arrangement_label}
                {doc.vehicle_arrangement_by_name
                  && ` — arranged by ${doc.vehicle_arrangement_by_name}`}
                {doc.vehicle_arrangement_at
                  && ` on ${fmtDateTime(doc.vehicle_arrangement_at)}`}
              </Note>
            )}

            {doc.outbound_tr_no && (
              <Note icon={<Truck className="h-4 w-4" />}>
                Logistics return leg{" "}
                <span className="font-semibold">{doc.outbound_tr_no}</span>
                {doc.inbound_tr_status && ` — ${doc.inbound_tr_status}`}
              </Note>
            )}

            {doc.vendor_receipt_confirmed_at && (
              <Note icon={<CheckCircle2 className="h-4 w-4" />}>
                {doc.vendor_name ?? "The vendor"} signed for the goods
                {doc.vendor_receipt_by_name && ` — received by ${doc.vendor_receipt_by_name}`}
                {` on ${fmtDateTime(doc.vendor_receipt_confirmed_at)}`}
                {doc.vendor_receipt_remarks && <> — “{doc.vendor_receipt_remarks}”</>}
              </Note>
            )}

            {doc.replacement_dispatched_at && (
              <Note icon={<Package className="h-4 w-4" />}>
                Replacement dispatched
                {doc.replacement_dispatch_no && ` on note ${doc.replacement_dispatch_no}`}
                {doc.replacement_dispatch_date
                  && ` — left ${fmtDate(doc.replacement_dispatch_date)}`}
                {doc.replacement_expected_date
                  && `, expected ${fmtDate(doc.replacement_expected_date)}`}
                {doc.vendor_followup_receipt_no && (
                  <> · book it in against{" "}
                    <span className="font-semibold">
                      {doc.vendor_followup_receipt_no}
                    </span>
                  </>
                )}
              </Note>
            )}

            {doc.received_at && (
              <Note icon={<Warehouse className="h-4 w-4" />}>
                Received at {doc.warehouse_name ?? "the warehouse"}
                {doc.received_by_name && `, signed by ${doc.received_by_name}`}
                {` on ${fmtDateTime(doc.received_at)}`}
                {doc.received_remarks && <> — “{doc.received_remarks}”</>}
              </Note>
            )}
          </div>
        )}

        {/* ---- the vehicle, whichever branch named it ---- */}
        {hasVehicle && (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl border border-line
                         p-4 sm:grid-cols-3">
            {([
              ["Vehicle", doc.inbound_vehicle_no, <Truck className="h-3.5 w-3.5" />],
              ["Driver", doc.inbound_driver_name, <UserRound className="h-3.5 w-3.5" />],
              ["Driver phone", doc.inbound_driver_phone, <Phone className="h-3.5 w-3.5" />],
              ["Transporter", doc.inbound_transporter_name, null],
              ["LR / docket", doc.inbound_lr_no, null],
              ["Expected", doc.inbound_expected_date
                ? fmtDate(doc.inbound_expected_date) : null, null],
            ] as [string, string | null | undefined, React.ReactNode][])
              .filter(([, value]) => !!value)
              .map(([label, value, icon]) => (
                <div key={label}>
                  <dt className="flex items-center gap-1 text-[11px] font-semibold
                                 uppercase tracking-wide text-muted">
                    {icon}{label}
                  </dt>
                  <dd className="mt-0.5 text-sm text-body">{value}</dd>
                </div>
              ))}
          </dl>
        )}

        {/* ---- waiting on them ---- */}
        <AwaitingVendor doc={doc} />

        {/* ---- OUR one press: whose vehicle carries the goods ---- */}
        {doc.can_arrange_transport && (
          <Can do="return.approve">
            <div className="space-y-4 rounded-xl border border-line p-4">
              <div>
                <h3 className="text-sm font-semibold text-body">
                  {doc.vendor_name ?? "The vendor"} has agreed a replacement — who moves
                  the goods?
                </h3>
                <p className="mt-1 text-xs text-muted">
                  The returned material is still on your floor. Choose once: the answer
                  decides whether Logistics is given a return leg, and it cannot be
                  changed afterwards.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {arrangements.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setPicked(option.value as ReturnVehicleArrangement)}
                    className={`rounded-xl border p-3 text-left transition ${
                      picked === option.value
                        ? "border-brand bg-brand/5 ring-1 ring-brand"
                        : "border-line hover:border-brand/50"}`}
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold text-body">
                      <Truck className="h-4 w-4 text-muted" />
                      {option.label}
                    </span>
                    <span className="mt-1 block text-xs text-muted">{option.help}</span>
                    {option.raises_vehicle_request && (
                      <span className="mt-2 inline-block rounded-full bg-info-bg px-2
                                       py-0.5 text-[10px] font-semibold text-info">
                        Raises a Logistics return leg
                      </span>
                    )}
                  </button>
                ))}
              </div>

              {picked && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Collect from" hint="Where the vehicle loads.">
                    <Input value={pickupAddress}
                           onChange={(e) => setPickupAddress(e.target.value)}
                           placeholder="Dock / gate the load is ready at" />
                  </Field>
                  <Field label="Ready from"
                         hint="The earliest the load may leave. Not a delivery date.">
                    <Input type="date" value={readyDate}
                           onChange={(e) => setReadyDate(e.target.value)} />
                  </Field>
                </div>
              )}

              <ErrorBanner error={arrange.error} />
              <div className="flex justify-end">
                <Button className={TONE_DEEP_MINT}
                        disabled={!picked || arrange.isPending}
                        onClick={() => arrange.mutate()}>
                  <MapPin className="h-4 w-4" />
                  Confirm transport
                </Button>
              </div>
            </div>
          </Can>
        )}

        {/* ---- the replacement's way back onto the shelf ----
             NO BUTTON HERE, removed 2026-09-14. This panel used to carry a "Received at
             the warehouse" press, which asserted an arrival the store was ALREADY
             recording minutes later on the inbound receipt through the ordinary GRN
             path. Two documents for one lorry, and this was the copy nobody had a reason
             to open — so a replacement could be received, inspected and put away with the
             return still reading "Replacement dispatched".

             The GRN settles the arrival (`_settle_return_on_receipt`) and the PUTAWAY
             closes the return (`_close_return_on_intake_complete`), so this panel says
             what is still owed and gets out of the way.

             THE SENTENCE IS SERVED. `replacement_intake_stage` is composed on the server
             off the receipt, its inspection and its putaway tasks — the same read the
             journey tracker above is drawn from — so the band and the rail cannot word one
             document two ways. It goes null once the return is closed, which is what takes
             this panel off the screen rather than leaving a stale instruction on it. */}
        {doc.replacement_intake_stage && (
          <div className="rounded-xl border border-line bg-content2/40 p-4">
            <p className="flex items-start gap-2 text-sm text-body">
              <Warehouse className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
              <span>{doc.replacement_intake_stage}</span>
            </p>
            {(doc.replacement_grn_no || doc.replacement_inspection_no) && (
              <dl className="mt-3 grid gap-3 sm:grid-cols-3">
                {([
                  ["Goods receipt", doc.replacement_grn_no],
                  ["QC inspection", doc.replacement_inspection_no],
                  ["Putaway", doc.replacement_putaway_total
                    ? `${doc.replacement_putaway_done ?? 0} of ${
                        doc.replacement_putaway_total} placed`
                    : null],
                ] as [string, string | null | undefined][])
                  .filter(([, value]) => !!value)
                  .map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-[11px] font-semibold uppercase tracking-wide
                                     text-muted">
                        {label}
                      </dt>
                      <dd className="mt-0.5 text-sm font-medium text-body">{value}</dd>
                    </div>
                  ))}
              </dl>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

export default PurchaseReturnLeg;
