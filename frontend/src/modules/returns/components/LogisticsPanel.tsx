import { Link } from "react-router-dom";
import { Truck } from "lucide-react";
import { SectionCard } from "./DetailChrome";
import { PHASE, RETURN_LEG, RETURN_STATUS } from "../constants";
import type { StockReturn } from "../types";

/**
 * Where the material is, once the final approval has released it.
 *
 * This panel drives nothing. The leg is a real `lgs_transport_requests` row and every
 * press that moves it on — submitting it, tendering it, awarding a carrier, releasing the
 * load, recording the delivery, taking the receiving end's signature — belongs to the
 * logistics desk on Logistics > Shipments. Returns only reads the two facts that change
 * stock, and both arrive through the hooks logistics already publishes. So what this
 * shows is a status and a link to the document that owns it, never a second set of
 * buttons for the same job.
 *
 * Renders nothing at all for a return that never travels: two of the six outcomes move
 * no material, and scrap and controlled disposal are written off at the branch. A card
 * saying "no shipment" on those would be noise on the majority of returns.
 */
export function LogisticsPanel({ doc }: { doc: StockReturn }) {
  if (!doc.leg) return null;

  const isSupplier = doc.leg === RETURN_LEG.SUPPLIER;
  const travelling = doc.phase === PHASE.LOGISTICS;
  const gone = doc.status === RETURN_STATUS.DISPATCHED
    || doc.status === RETURN_STATUS.RECEIVED;

  const state = !doc.transport
    ? "No shipment has been raised yet."
    : !gone
      ? "Waiting for the logistics desk to dispatch it."
      : travelling
        ? "On the road."
        : isSupplier
          ? "The supplier has acknowledged it."
          : "Received and inspected at the destination.";

  return (
    <SectionCard icon={<Truck className="h-4 w-4" />} title="Logistics">
      <div className="flex items-start gap-2">
        <div className="min-w-0 text-sm">
          <div className="font-medium text-ink">{doc.leg_label ?? "Return leg"}</div>
          <p className="mt-0.5 text-muted">{state}</p>

          {doc.transport?.transport_request_no && (
            <Link
              to={`/logistics/shipments/${doc.transport.transport_request_id}`}
              className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-brand hover:underline"
            >
              {doc.transport.transport_request_no}
            </Link>
          )}
          {/* CHANGED 2026-09-10: this used to send the receiving side into Logistics to
            * sign the shipment, which was the only door to the receipt when it was
            * written. It is not any more — the receipt lives on Returns > Sign-off, and
            * on this page's own Acknowledge button, where it asks how much arrived and
            * for a photo of it. Pointing at the shipment now sends somebody to a screen
            * their permissions may not even reach for a press they can make here. */}
          {doc.status === RETURN_STATUS.DISPATCHED && travelling && doc.transport && (
            <div className="mt-3 rounded-lg bg-warn-bg p-3 text-xs text-warn">
              On its way to{" "}
              <strong>{doc.to_warehouse_name ?? "the receiving point"}</strong>. Whoever
              takes delivery signs for it — here, or on Returns &gt; Sign-off — saying how
              much of each line arrived. That receipt is what puts the material on that
              point&rsquo;s stock balance and raises the purchase return against it.
            </div>
          )}
        </div>
      </div>

      <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
        {isSupplier
          ? "The material leaves the company on this leg. The supplier's acknowledgement is what ends our custody of it."
          : "Stock leaves the branch when the load is released and lands on the receiving shelf when that site signs for it — not before. The final Acknowledge button on this return appears only for the original raiser after the receiving site has signed for the shipment."}
      </p>
    </SectionCard>
  );
}
