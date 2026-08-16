import { useState } from "react";
import {
  Button, Can, Card, ErrorBanner, Field, Input, Select, useAction,
} from "@/shared/components";
import { fmtDateTime } from "@/shared/datetime";
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

const TONE: Record<string, string> = {
  PICKED_UP: "bg-sky-500",
  IN_TRANSIT: "bg-sky-500",
  OUT_FOR_DELIVERY: "bg-indigo-500",
  DELIVERED: "bg-emerald-500",
  DAMAGED: "bg-rose-500",
  MISSING: "bg-rose-500",
  DELAYED: "bg-amber-500",
};

export function ShipmentTimeline({
  trId, events, status,
}: {
  trId: number;
  events: ShipmentEvent[];
  status: string;
}) {
  const [adding, setAdding] = useState(false);
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

  const isClaim = ["DAMAGED", "MISSING", "DELAYED"].includes(form.event_type);
  const trackable = !["DRAFT", "PENDING_APPROVAL", "CLOSED", "CANCELLED", "REJECTED"]
    .includes(status);

  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold text-ink">Tracking</h2>
        {trackable && (
          <Can do="transport.track">
            <Button variant="ghost" onClick={() => setAdding(!adding)}>
              {adding ? "Cancel" : "Add event"}
            </Button>
          </Can>
        )}
      </div>

      <ErrorBanner error={add.error} />

      {adding && (
        <div className="space-y-3 rounded-lg border border-line p-3">
          <Field label="What happened">
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
        <p className="py-4 text-center text-sm text-muted">
          Nothing recorded yet.
        </p>
      ) : (
        <ol className="space-y-3">
          {events.map((event) => (
            <li key={event.id} className="flex gap-3">
              <span
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TONE[event.event_type] ?? "bg-slate-400"}`}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-ink">
                    {event.event_type.replace(/_/g, " ").toLowerCase()}
                  </span>
                  <span className="text-[11px] text-muted">
                    {fmtDateTime(event.event_at)}
                  </span>
                </div>
                {event.location_name && (
                  <div className="text-xs text-muted">{event.location_name}</div>
                )}
                {event.description && (
                  <div className="text-sm text-body">{event.description}</div>
                )}
                {event.is_exception && (
                  <div className="mt-1 text-xs">
                    {event.affected_item_name && (
                      <span className="text-body">
                        {event.affected_item_name}
                        {event.affected_qty ? ` × ${Number(event.affected_qty)}` : ""}
                        {event.claim_amount ? ` · ${money(event.claim_amount)}` : ""}
                      </span>
                    )}
                    <div className={event.resolved_at ? "text-emerald-600" : "text-rose-600"}>
                      {event.resolved_at
                        ? `Settled: ${event.resolution}`
                        : "Open claim"}
                    </div>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
