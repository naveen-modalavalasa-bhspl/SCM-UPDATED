import { useState } from "react";
import {
  AlertTriangle, CheckCircle2, ClipboardCheck, Clock, MapPin, Navigation,
  PackageCheck, PackageX, Plus, Radar, Truck, X,
} from "lucide-react";
import {
  Button, Can, Card, ErrorBanner, Field, Input, Select, useAction,
} from "@/shared/components";
import { fmtDateTime, fmtRelative } from "@/shared/datetime";
import { transportApi } from "../api";
import { money } from "./modeCopy";
import type { ShipmentEvent } from "../transportTypes";

/** Progress scans and claims, in the order the backend records them. Damage and
 * shortage sit on the same timeline because "it arrived short" is answered by reading
 * the events in order, not by opening a second screen. */
const EVENT_TYPES = [
  { value: "IN_TRANSIT", label: "In transit" },
  { value: "OUT_FOR_DELIVERY", label: "Out for delivery" },
  { value: "DELAYED", label: "Delayed (raises a claim)" },
  { value: "DAMAGED", label: "Damaged (raises a claim)" },
  { value: "MISSING", label: "Missing (raises a claim)" },
];

/** One look per scan type: the icon a parcel tracking page would use, and the hue
 * that already stands for it everywhere else in the app (sky = moving, emerald =
 * arrived, rose = broken, amber = late). Colour never carries the meaning alone —
 * the icon and the label say it too. */
const LOOK: Record<string, { icon: typeof Truck; dot: string; text: string }> = {
  PICKED_UP: { icon: PackageCheck, dot: "bg-sky-500", text: "text-sky-600" },
  IN_TRANSIT: { icon: Truck, dot: "bg-sky-500", text: "text-sky-600" },
  OUT_FOR_DELIVERY: { icon: Navigation, dot: "bg-indigo-500", text: "text-indigo-600" },
  DELIVERED: { icon: CheckCircle2, dot: "bg-emerald-500", text: "text-emerald-600" },
  // The receiving end's signature, stamped by the acknowledgement itself — which is
  // why it is not in EVENT_TYPES above: nobody types this one in.
  ACKNOWLEDGED: { icon: ClipboardCheck, dot: "bg-emerald-600", text: "text-emerald-700" },
  DAMAGED: { icon: AlertTriangle, dot: "bg-rose-500", text: "text-rose-600" },
  MISSING: { icon: PackageX, dot: "bg-rose-500", text: "text-rose-600" },
  DELAYED: { icon: Clock, dot: "bg-amber-500", text: "text-amber-600" },
};
const FALLBACK = { icon: MapPin, dot: "bg-slate-400", text: "text-slate-500" };

const lookOf = (type: string) => LOOK[type] ?? FALLBACK;

/** `OUT_FOR_DELIVERY` -> `Out for delivery`. Sentence case, not the lowercased run
 * it used to render: a scan headline should read as a headline. */
const scanLabel = (type: string) => {
  const words = type.replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export function ShipmentTimeline({
  trId, events, status,
}: {
  trId: number;
  events: ShipmentEvent[];
  status: string;
}) {
  const [adding, setAdding] = useState(false);
  // Closing a claim lives here, on the claim itself, because the Exceptions desk that
  // used to own it is gone: its list is a filter on the Activity Ledger now, and a
  // ledger is a record — you read it, you do not work from it. The claim is raised on
  // this timeline and settled on the same one.
  const [settling, setSettling] = useState<number | null>(null);
  const [resolution, setResolution] = useState("");
  const [form, setForm] = useState({
    event_type: "IN_TRANSIT", location_name: "", description: "",
    affected_item_name: "", affected_qty: "", claim_amount: "",
  });

  const add = useAction({
    run: () => transportApi.addEvent(trId, {
      event_type: form.event_type,
      location_name: form.location_name || null,
      description: form.description || null,
      affected_item_name: form.affected_item_name || null,
      affected_qty: form.affected_qty ? Number(form.affected_qty) : null,
      claim_amount: form.claim_amount ? Number(form.claim_amount) : null,
    }),
    success: "Event recorded",
    invalidates: [["transport", String(trId)], ["transport-exceptions"]],
    onDone: () => setAdding(false),
  });

  const settle = useAction({
    run: () => transportApi.resolveException(settling!, resolution.trim()),
    success: "Claim settled",
    invalidates: [["transport", String(trId)], ["transport-exceptions"],
      ["transport-activity"]],
    onDone: () => { setSettling(null); setResolution(""); },
  });

  const isClaim = ["DAMAGED", "MISSING", "DELAYED"].includes(form.event_type);
  const trackable = !["DRAFT", "PENDING_APPROVAL", "CLOSED", "CANCELLED", "REJECTED"]
    .includes(status);

  const latest = events.length ? events[events.length - 1] : null;
  // A shipment still on the road gets a live marker; one that has landed or been
  // closed does not, because a pulsing dot on a finished job reads as an alarm.
  const live = latest != null && trackable
    && !["DELIVERED", "ACKNOWLEDGED", "DAMAGED", "MISSING"].includes(latest.event_type);

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold text-ink">Tracking</h2>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
            {live && (
              <span className="relative flex h-2 w-2" aria-hidden>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-500" />
              </span>
            )}
            {latest
              ? <>{scanLabel(latest.event_type)} · {fmtRelative(latest.event_at)}</>
              : "No scans yet"}
          </p>
        </div>
        {trackable && (
          <Can do="transport.track">
            <Button variant="ghost" onClick={() => setAdding(!adding)}>
              {adding
                ? <><X size={15} className="mr-1" />Cancel</>
                : <><Plus size={15} className="mr-1" />Add event</>}
            </Button>
          </Can>
        )}
      </div>

      <div className="mt-3 empty:mt-0">
        <ErrorBanner error={add.error ?? settle.error} />
      </div>

      {adding && (
        <div className="mt-3 space-y-3 rounded-xl border border-line bg-surface/60 p-3">
          <Field label="What happened" required>
            <Select
              value={form.event_type}
              options={EVENT_TYPES}
              onChange={(value) => setForm({ ...form, event_type: value })}
            />
          </Field>
          <Field label="Where">
            <Input value={form.location_name}
              onChange={(e) => setForm({ ...form, location_name: e.target.value })} />
          </Field>
          <Field label="Note">
            <Input value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          {isClaim && (
            <>
              <Field label="Item affected">
                <Input value={form.affected_item_name}
                  onChange={(e) => setForm({ ...form, affected_item_name: e.target.value })} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Qty">
                  <Input type="number" value={form.affected_qty}
                    onChange={(e) => setForm({ ...form, affected_qty: e.target.value })} />
                </Field>
                <Field label="Claim value">
                  <Input type="number" value={form.claim_amount}
                    onChange={(e) => setForm({ ...form, claim_amount: e.target.value })} />
                </Field>
              </div>
            </>
          )}
          <Button onClick={() => add.mutate()} disabled={add.isPending}>
            Record
          </Button>
        </div>
      )}

      {events.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <span className="grid h-10 w-10 place-items-center rounded-full bg-surface text-muted">
            <Radar size={18} aria-hidden />
          </span>
          <p className="text-sm text-muted">Nothing recorded yet.</p>
          <p className="text-xs text-muted">Scans appear here as the consignment moves.</p>
        </div>
      ) : (
        <ol className="mt-4">
          {events.map((event, index) => {
            const look = lookOf(event.event_type);
            const Icon = look.icon;
            const last = index === events.length - 1;
            return (
              <li key={event.id} className="relative flex gap-3 pb-5 last:pb-0">
                {/* The rail joins one scan to the next, so the eye reads a route
                 * rather than a stack of unrelated rows. */}
                {!last && (
                  <span className="absolute bottom-0 left-[15px] top-9 w-px bg-line" aria-hidden />
                )}
                <span
                  className={`relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full text-white ring-4 ring-white ${look.dot}`}
                  aria-hidden
                >
                  <Icon size={15} strokeWidth={2.4} />
                </span>
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                    <span className={`text-sm font-semibold ${look.text}`}>
                      {scanLabel(event.event_type)}
                    </span>
                    <span className="font-mono text-[11px] text-muted">
                      {fmtDateTime(event.event_at)}
                    </span>
                  </div>
                  {event.location_name && (
                    <div className="mt-0.5 flex items-start gap-1 text-xs text-muted">
                      <MapPin size={12} className="mt-[2px] shrink-0" aria-hidden />
                      <span className="break-words">{event.location_name}</span>
                    </div>
                  )}
                  {event.description && (
                    <div className="mt-1 text-sm text-body">{event.description}</div>
                  )}
                  {event.is_exception && (
                    <div className="mt-2 rounded-lg border border-line bg-surface/70 px-2.5 py-1.5 text-xs">
                      {event.affected_item_name && (
                        <div className="text-body">
                          {event.affected_item_name}
                          {event.affected_qty ? ` × ${Number(event.affected_qty)}` : ""}
                          {event.claim_amount ? ` · ${money(event.claim_amount)}` : ""}
                        </div>
                      )}
                      <div className={`mt-0.5 flex flex-wrap items-center gap-1 font-medium ${
                        event.resolved_at ? "text-emerald-600" : "text-rose-600"}`}>
                        {event.resolved_at
                          ? <><CheckCircle2 size={12} aria-hidden />Settled: {event.resolution}</>
                          : <><AlertTriangle size={12} aria-hidden />Open claim</>}
                        {!event.resolved_at && settling !== event.id && (
                          <Can do="transport.exception">
                            <button
                              type="button"
                              onClick={() => { setSettling(event.id); setResolution(""); }}
                              className="ml-1 rounded-md border border-line px-2 py-0.5 text-[11px] font-semibold text-body"
                            >
                              Settle
                            </button>
                          </Can>
                        )}
                      </div>
                      {settling === event.id && (
                        <div className="mt-2 space-y-2">
                          <Field label="How was it settled" required>
                            <Input
                              value={resolution}
                              placeholder="Credit note 4,500 received from the carrier"
                              onChange={(e) => setResolution(e.target.value)}
                            />
                          </Field>
                          <div className="flex gap-2">
                            <Button
                              onClick={() => settle.mutate()}
                              disabled={settle.isPending || !resolution.trim()}
                            >
                              Close the claim
                            </Button>
                            <Button variant="ghost" onClick={() => setSettling(null)}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
