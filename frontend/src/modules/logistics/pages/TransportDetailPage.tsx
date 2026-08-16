import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Button, Can, Card, ConfirmModal, ErrorBanner, Field, Input, PageHeader, StatCard,
  StatusPill, useAction,
} from "@/shared/components";
import { fmtDate, fmtDateTime } from "@/shared/datetime";
import { transportApi } from "../api";
import { modeLabel, modeTint, money } from "../components/modeCopy";
import { QuoteComparison } from "../components/QuoteComparison";
import { ShipmentTimeline } from "../components/ShipmentTimeline";

/**
 * One transport request, and everything that can be done to it.
 *
 * The action bar is driven entirely by `status` — a request that is out to carriers
 * offers the tender, a ready one offers dispatch, an in-transit one offers scans and
 * delivery. Showing every button and disabling most of them was the alternative, and
 * it makes a screen nobody can read at a glance.
 */
export function TransportDetailPage() {
  const nav = useNavigate();
  const { id } = useParams();
  const trId = Number(id);

  const [reject, setReject] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const [dispatching, setDispatching] = useState(false);
  const [tracking, setTracking] = useState({ lr_no: "", docket_no: "", tracking_url: "", eway_bill_no: "" });
  const [delivering, setDelivering] = useState(false);
  const [delivery, setDelivery] = useState({ delivered_to_name: "", pod_url: "" });

  const { data: doc, isLoading, error } = useQuery({
    queryKey: ["transport", id],
    queryFn: () => transportApi.get(trId),
  });

  const invalidates = [["transport"], ["transport", id]];
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
  const dispatch = useAction({
    run: () => transportApi.dispatch(trId, {
      lr_no: tracking.lr_no || null,
      docket_no: tracking.docket_no || null,
      tracking_url: tracking.tracking_url || null,
      eway_bill_no: tracking.eway_bill_no || null,
    }),
    success: "Marked dispatched", invalidates,
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

  return (
    <div>
      <PageHeader
        eyebrow="Logistics"
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

            {doc.status === "READY" && (
              <Can do="transport.track">
                <Button onClick={() => setDispatching(true)}>Mark dispatched</Button>
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
        ?? deliver.error ?? close.error ?? share.error} />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Status" value={<StatusPill status={doc.status} />} />
        <StatCard
          label="Mode"
          value={
            <span className={`rounded-full px-2 py-0.5 text-sm font-medium ${modeTint(doc.mode)}`}>
              {modeLabel(doc.mode)}
            </span>
          }
        />
        <StatCard
          label="Load"
          value={`${doc.total_packages} pkg`}
          delta={undefined}
        />
        <StatCard label="Freight" value={money(doc.freight_amount)} />
      </div>

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
            <Detail label="From" value={doc.from_warehouse_name} />
            <Detail label="To" value={doc.to_location_name} />
            <Detail label="Address" value={doc.delivery_address} />
            <Detail label="Contact" value={doc.contact_person
              ? `${doc.contact_person}${doc.contact_phone ? ` · ${doc.contact_phone}` : ""}`
              : null} />
            <Detail label="Against indent" value={doc.indent_no} />
            <Detail label="Needed by" value={fmtDate(doc.expected_delivery)} />
            <Detail label="Carrier" value={doc.carrier_name} />
            <Detail label="Vehicle" value={doc.vehicle_number} />
            <Detail label="Driver" value={doc.driver_name} />
            <Detail label="Rides on" value={doc.trip_reference} />
            <Detail label="Handed over by" value={doc.handed_over_by_name} />
            <Detail label="Received by" value={doc.received_by_name} />
            <Detail label="LR" value={doc.lr_no} />
            <Detail label="Docket" value={doc.docket_no} />
            <Detail label="E-way bill" value={doc.eway_bill_no} />
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
          <QuoteComparison trId={doc.id} status={doc.status} quotes={doc.quotes} />
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
        isOpen={dispatching}
        title="Mark dispatched"
        message="Record what the field will be given to track the consignment."
        confirmLabel="Dispatch"
        busy={dispatch.isPending}
        onConfirm={() => dispatch.mutate()}
        onClose={() => setDispatching(false)}
      >
        <div className="space-y-3">
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
        message="Every line is recorded as delivered in full. Raise a claim first if anything arrived short or damaged."
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

function Detail({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="text-body">{value}</dd>
    </div>
  );
}
