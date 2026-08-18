import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Truck, X } from "lucide-react";
import {
  Button, Can, Card, ErrorBanner, Field, Input, PageHeader, Select, StatusPill,
  useAction,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { consignmentApi, transportApi } from "../api";
import {
  headerFromConsignment, linesFromConsignment,
} from "../components/consignmentToLines";
import { load, modeLabel, modeTint } from "../components/modeCopy";
import {
  numberError, phoneError, PHONE_HINT, problems, sanitizePhone,
} from "../components/validate";
import type {
  Consignment, DispatchInput, ModeRule, TransportMode,
} from "../transportTypes";

const BLANK = {
  freight_amount: "", vehicle_number: "", driver_name: "",
  // The other job the vehicle was already doing — the whole reason an own-vehicle leg
  // costs the shipment nothing. Asked here as well as on the manual form, so a
  // one-press dispatch does not lose it.
  driver_phone: "", trip_reference: "",
  handed_over_by_name: "", received_by_name: "",
  // The handle the receiving site chases the parcel with. Written here, on the slip
  // the counter just gave you — a docket typed in tomorrow is a docket nobody has.
  docket_no: "", tracking_url: "", eway_bill_no: "",
};

/** What the desk is asked to type, by the name the service checks it under. Read only
 *  to say WHICH field is still blank when the press is held back — the list of what a
 *  mode requires is the backend's (`/api/transport/modes`), never this screen's. */
const FIELD_LABELS: Record<string, string> = {
  carrier_id: "a provider",
  vehicle_number: "the vehicle number",
  driver_name: "the driver",
  handed_over_by_name: "who hands it over",
  received_by_name: "who receives it",
  docket_no: "the docket / LR number",
};

const destinationOf = (row?: Consignment | null) =>
  row?.destination_office_name
  ?? row?.to_warehouse_name
  ?? row?.customer_name
  ?? row?.delivery_address
  ?? "—";

/**
 * Confirm dispatch — the warehouse packed it, this says how it travels.
 *
 * The same screen the storekeeper knew (pick the ready consignment, write the gate
 * pass, press once), with the one question that was missing from it: the MODE. The
 * warehouse's own confirm-dispatch screen is untouched and still reached from
 * Warehouse; this is the logistics desk's front door to the same moment, and it never
 * leaves `/logistics/*` — walking a consignment through here used to hand the user
 * over to the warehouse module halfway.
 *
 * The mode decides where it lands, and the backend decides the mode rules
 * (`/api/transport/modes`) — this form only asks for what the service will check:
 *
 *   * THIRD_PARTY — the providers are being ASKED, not told. Pick as MANY as should
 *     price the job: the same consignment lands in each of their portals, they quote
 *     independently, and the prices come back side by side on Provider Selection —
 *     which is where the comparison is read and the award is made. Asking
 *     one and calling the answer a comparison is the thing the three-quote norm
 *     exists to prevent. No amount is sent to any of them.
 *   * everything else — settled the moment it is chosen (a courier's rate is
 *     published, a company vehicle costs nothing, a hand-over hires nobody), so
 *     exactly one provider is named and the load LEAVES on this press. Every check
 *     the release runs is answered by this form, so stopping at READY and asking for
 *     a second "it has left" only held the moment the receiving site can sign for it.
 */
export function DispatchConfirmPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const preselected = Number(params.get("consignment_id") ?? 0);

  const [consignmentId, setConsignmentId] = useState(
    preselected > 0 ? String(preselected) : "");
  const [gatePass, setGatePass] = useState("");
  const [mode, setMode] = useState<TransportMode>("THIRD_PARTY");
  const [form, setForm] = useState({ ...BLANK });
  // One list for both cases. A booking names one provider and a tender names several,
  // but "who is this going to" is one answer either way, and keeping a separate
  // singular field beside it is how the two quietly disagree about who was chosen.
  const [carrierIds, setCarrierIds] = useState<number[]>([]);

  const id = Number(consignmentId || 0);

  // Only packed consignments: nothing else is a thing that can be sent anywhere.
  const { data: ready, isLoading } = useQuery({
    queryKey: ["lgs-packed-consignments"],
    queryFn: () => consignmentApi.list({ status: "PACKED", size: 100 }),
  });
  const { data: modes } = useQuery({
    queryKey: ["transport-modes"], queryFn: transportApi.modes,
  });
  const { data: carriers } = useQuery({
    queryKey: ["transport-carriers"], queryFn: () => transportApi.carriers(),
  });
  // The packing list is what the transport lines are built from — weights, cartons
  // and the indent behind them are read off the consignment, never retyped.
  const { data: doc } = useQuery({
    queryKey: ["lgs-consignment", consignmentId],
    queryFn: () => consignmentApi.get(id),
    enabled: id > 0,
  });
  // Dispatching the same consignment twice raises a second transport request for one
  // physical load. Ask first, and offer the one that exists.
  const { data: links } = useQuery({
    queryKey: ["lgs-consignment-links", consignmentId],
    queryFn: () => transportApi.forConsignments([id]),
    enabled: id > 0,
  });
  const already = links?.[0];

  const rule: ModeRule | undefined = useMemo(
    () => modes?.find((m) => m.value === mode), [modes, mode],
  );
  const needs = (field: string) => rule?.required_fields.includes(field) ?? false;
  // `carriers` is undefined while it loads; only an empty ARRAY means the register is
  // actually empty, so the pointer to Settings never flashes on a slow connection.
  const noPartners = Array.isArray(carriers) && carriers.length === 0;

  const chosen = (ready?.items ?? []).find((row) => row.id === id) ?? doc ?? null;

  // What this mode still has blank. The MODE says which fields it needs — that list is
  // the backend's — and this only reads them off the form, so a hand-over and an
  // own-vehicle leg are each held back for their own missing answers instead of being
  // sent and refused by the service.
  const missing = useMemo(() => {
    const gaps = (rule?.required_fields ?? []).filter((field) => (
      field === "carrier_id"
        ? carrierIds.length === 0
        : !String(form[field as keyof typeof form] ?? "").trim()
    ));
    // Released on this press, so the number it travels with is needed on this press.
    // The service refuses a hired leg with no LR or docket on it, and this is the same
    // rule read forward — the desk is told before the press, not after.
    if (rule?.needs_carrier && !rule.needs_quotes && !form.docket_no.trim()) {
      gaps.push("docket_no");
    }
    return gaps;
  }, [rule, form, carrierIds]);

  // "Provider identified based on distance, weight, items" (doc E3). The backend owns
  // the thresholds and answers null when the consignment carried neither a distance
  // nor a weight — advice off no evidence reads as an answer.
  const { data: suggestion } = useQuery({
    queryKey: ["transport-suggest", chosen?.total_weight_kg, chosen?.total_packages],
    queryFn: () => transportApi.suggestMode({
      weight_kg: chosen?.total_weight_kg ?? null,
      packages: chosen?.total_packages ?? null,
    }),
    enabled: Boolean(chosen),
  });

  const send = useAction({
    run: async () => {
      const detail = doc ?? await consignmentApi.get(id);
      const body: DispatchInput = {
        ...headerFromConsignment(detail),
        mode,
        lines: linesFromConsignment(detail),
        gate_pass_no: gatePass.trim() || null,
        carrier_ids: carrierIds,
        evaluation_method: null,
        freight_amount: form.freight_amount ? Number(form.freight_amount) : null,
        vehicle_number: form.vehicle_number || null,
        driver_name: form.driver_name || null,
        driver_phone: form.driver_phone || null,
        trip_reference: form.trip_reference || null,
        handed_over_by_name: form.handed_over_by_name || null,
        received_by_name: form.received_by_name || null,
        docket_no: form.docket_no || null,
        tracking_url: form.tracking_url || null,
        eway_bill_no: form.eway_bill_no || null,
        // A settled mode leaves on this press. Everything the release checks is on
        // this form, so sending it to READY and asking for a second "it has left"
        // only delayed the moment the receiving site can sign for it — and the indent
        // behind it stayed open in the gap. A tender has no carrier yet, so it waits.
        release_now: !rule?.needs_quotes,
      };
      return transportApi.dispatchConsignment(body);
    },
    success: (tr) => (tr.status === "QUOTING"
      ? `${tr.tr_no} sent to ${carrierIds.length} provider${carrierIds.length === 1 ? "" : "s"} for a price`
      : `${tr.tr_no} is on its way — the site can acknowledge it now`),
    invalidates: [["lgs-dispatch-queue"], ["lgs-consignment-links"],
      ["lgs-packed-consignments"], ["transport"], ["transport-summary"],
      ["transport-provider-board"]],
    // A tender goes to Provider Selection, which is where the prices arrive and the
    // award is made; anything else goes to the shipment, whose next press is "it has
    // left". Landing every dispatch on the transport document sent the desk to a
    // screen with nothing on it yet and no sign of where the answers would turn up.
    onDone: (tr) => nav(tr.status === "QUOTING"
      ? `/logistics/providers?tr=${tr.id}`
      : `/logistics/transport/${tr.id}`),
  });

  /** Values that are WRONG rather than merely absent. `missing` says what has not been
   *  answered; this says what has been answered badly, and either one holds the press.
   *  The service checks all of it again — this only saves the round trip. */
  const badValues = problems(
    phoneError(form.driver_phone, "Driver phone"),
    numberError(form.freight_amount, "Freight", { min: 0 }),
  );

  const blocked = !id
    || Boolean(already)
    || missing.length > 0
    || badValues.length > 0
    || send.isPending;

  return (
    <div>
      <PageHeader
        eyebrow="Logistics"
        title="Confirm dispatch"
        actions={
          <>
            <Button variant="ghost" onClick={() => nav("/logistics/dispatch")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Can do="transport.create">
              <Button onClick={() => send.mutate()} disabled={blocked}>
                <Truck className="h-4 w-4" />
                {send.isPending
                  ? "Sending..."
                  : rule?.needs_quotes
                    ? `Send for a price${carrierIds.length > 1 ? ` (${carrierIds.length})` : ""}`
                    : "Dispatch it"}
              </Button>
            </Can>
          </>
        }
      />

      <ErrorBanner error={send.error} />

      <div className="space-y-4">
        <Card className="p-5">
          <h2 className="font-display text-base font-bold text-ink">Ready consignment</h2>
          <p className="mb-4 text-xs text-muted">
            Only packed consignments are available for dispatch confirmation.
          </p>

          <div className="grid gap-4 lg:grid-cols-2">
            <Field label="Consignment">
              <Select
                value={consignmentId}
                onChange={setConsignmentId}
                options={(ready?.items ?? []).map((row) => ({
                  value: String(row.id),
                  label: `${row.dispatch_no} — ${destinationOf(row)} · ${load(row.total_packages, row.total_weight_kg)}`,
                }))}
                placeholder={isLoading ? "Loading..." : "Select packed consignment"}
                ariaLabel="Consignment"
              />
            </Field>
            <Field
              label="Gate pass no"
              hint="Optional. Recorded on the transport request — the gate pass belongs to the leg, not to the packing."
            >
              <Input value={gatePass} onChange={(e) => setGatePass(e.target.value)} />
            </Field>
          </div>

          {chosen && (
            <div className="mt-4 grid gap-x-6 gap-y-2 rounded-lg border border-line bg-content2/60 px-4 py-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <div className="text-[11px] uppercase text-muted">Going to</div>
                <div className="truncate text-body">{destinationOf(chosen)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase text-muted">From</div>
                <div className="truncate text-body">{chosen.warehouse_name ?? "—"}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase text-muted">Load</div>
                <div className="text-body">
                  {load(chosen.total_packages, chosen.total_weight_kg)}
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase text-muted">Packed</div>
                <div className="text-body">{fmtDate(chosen.dispatch_date)}</div>
              </div>
            </div>
          )}

          {already && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warn/30 bg-warn-bg px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 text-sm text-body">
                <span className="font-semibold text-warn">Already dispatched.</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${modeTint(already.mode)}`}>
                  {modeLabel(already.mode)}
                </span>
                <StatusPill status={already.status} />
                <span className="font-mono text-xs">{already.tr_no}</span>
              </div>
              <Button variant="soft" onClick={() => nav(`/logistics/transport/${already.tr_id}`)}>
                Open the shipment
              </Button>
            </div>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="font-display text-base font-bold text-ink">How does it travel?</h2>
          <p className="mb-4 text-xs text-muted">
            The mode decides what happens next. Everything else on the transport
            request is filled in from the packing list.
          </p>

          <div className="grid gap-4 lg:grid-cols-2">
            <Field label="Mode" hint={rule?.help}>
              <Select
                value={mode}
                onChange={(value) => {
                  if (!value) return;
                  setMode(value as TransportMode);
                  // Everything below the mode is mode-specific, the provider set
                  // included: three carriers chosen for a tender are not three
                  // couriers, and carrying them across would send a booking to a
                  // provider nobody picked for it.
                   setForm({ ...BLANK });
                   setCarrierIds([]);
                 }}
                options={(modes ?? []).map((option) => ({
                  value: option.value, label: modeLabel(option.value),
                }))}
                ariaLabel="Transport mode"
              />
              {/* Advice, never a decision — whatever is picked is validated the same
                  way. Hidden once it agrees with the pick, so it stops being noise. */}
              {suggestion && suggestion.mode !== mode && (
                <p className="mt-2 text-xs text-muted">
                  This load looks like{" "}
                  <button
                    type="button"
                    className="font-semibold text-brand underline"
                    onClick={() => {
                      setMode(suggestion.mode);
                      setForm({ ...BLANK });
                      setCarrierIds([]);
                    }}
                  >
                    {suggestion.label}
                  </button>
                  {" "}— {suggestion.reason}.
                </p>
              )}
            </Field>

            {/* The provider list is the carrier vendors — whoever is on the master.
                A tender takes as many as should price the job; a booking takes one. */}
            {rule?.needs_carrier && (
              <Field
                label={rule.needs_quotes ? "Logistics partners" : "Courier"}
                hint={rule.needs_quotes
                  ? "Pick everyone who should price this job. It lands in each of their portals, they quote independently, and the prices come back side by side on Provider Selection for you to award — no amount is sent to them."
                  : "Booked at their published rate."}
              >
                <Select
                  value={rule.needs_quotes ? "" : (carrierIds[0] ? String(carrierIds[0]) : "")}
                  onChange={(value) => {
                    const picked = Number(value);
                    if (!picked) return;
                    // A tender ADDS; a booking REPLACES. Same control, and the mode
                    // is the only thing that decides which, so there is one place to
                    // read what "choose a provider" means here.
                    setCarrierIds(rule.needs_quotes
                      ? (carrierIds.includes(picked) ? carrierIds : [...carrierIds, picked])
                      : [picked]);
                  }}
                  options={(carriers ?? [])
                    .filter((carrier) => !(rule.needs_quotes
                      && carrierIds.includes(carrier.id)))
                    .map((carrier) => ({
                      value: String(carrier.id), label: carrier.name,
                    }))}
                  placeholder={noPartners
                    ? "No logistics vendors registered yet"
                    : rule.needs_quotes
                      ? "Add a provider to the tender"
                      : "Select the provider"}
                  ariaLabel="Provider"
                />

                {/* The chosen set, as chips. A tender's whole point is that it went to
                    several, so who is on it has to be readable without opening a
                    second screen — and removable before it is sent, not after. */}
                {rule.needs_quotes && carrierIds.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {carrierIds.map((carrierId) => (
                      <span
                        key={carrierId}
                        className="inline-flex items-center gap-1.5 rounded-full bg-brand/10 px-3 py-1 text-xs font-medium text-brand"
                      >
                        {carriers?.find((c) => c.id === carrierId)?.name ?? carrierId}
                        <button
                          type="button"
                          aria-label={`Remove ${carriers?.find((c) => c.id === carrierId)?.name ?? carrierId}`}
                          className="text-brand/70 hover:text-brand"
                          onClick={() => setCarrierIds(
                            carrierIds.filter((c) => c !== carrierId))}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {rule.needs_quotes && carrierIds.length === 1 && (
                  <p className="mt-2 text-xs text-amber-600">
                    One provider is a rate, not a tender. Add a second so there is
                    something to compare — or send it anyway if this is a
                    single-carrier lane.
                  </p>
                )}

                {/* An empty dropdown used to be a dead end: it named the problem
                    (nothing on the master) and not the screen that fixes it, so the
                    dispatch stopped here. */}
                {noPartners && (
                  <p className="mt-2 text-xs text-muted">
                    Register the providers you ship with — Amazon, Flipkart, Alibaba,
                    Misaba, a truck operator — in{" "}
                    <Link to="/logistics/vendors"
                      className="font-semibold text-brand underline">
                      Logistics › Logistics Vendors
                    </Link>
                    . They appear here as soon as they are added.
                  </p>
                )}
              </Field>
            )}

            {rule?.needs_carrier && !rule.needs_quotes && (
              <>
                <Field label="Agreed freight"
                  hint={numberError(form.freight_amount, "Freight", { min: 0 })
                    ?? "Their published rate"}>
                  <Input type="number" min={0} value={form.freight_amount}
                    onChange={(e) => setForm({ ...form, freight_amount: e.target.value })} />
                </Field>
                {/* The service refuses to release a hired leg with no number on it:
                    it is the only thing the receiving site can chase the parcel
                    with, and it is on the booking slip in your hand right now. */}
                <Field label="Docket / LR number"
                  hint="From the booking slip. The site tracks the parcel on this.">
                  <Input value={form.docket_no}
                    onChange={(e) => setForm({ ...form, docket_no: e.target.value })} />
                </Field>
                <Field label="Tracking link"
                  hint="Optional. The carrier's own tracking page, shown to the requester.">
                  <Input value={form.tracking_url} placeholder="https://..."
                    onChange={(e) => setForm({ ...form, tracking_url: e.target.value })} />
                </Field>
                <Field label="E-way bill no" hint="Optional.">
                  <Input value={form.eway_bill_no}
                    onChange={(e) => setForm({ ...form, eway_bill_no: e.target.value })} />
                </Field>
              </>
            )}

            {needs("vehicle_number") && (
              <>
                <Field label="Vehicle number">
                  <Input value={form.vehicle_number}
                    onChange={(e) => setForm({ ...form, vehicle_number: e.target.value })} />
                </Field>
                <Field label="Driver">
                  <Input value={form.driver_name}
                    onChange={(e) => setForm({ ...form, driver_name: e.target.value })} />
                </Field>
                <Field label="Driver phone"
                  hint={phoneError(form.driver_phone, "Driver phone") ?? PHONE_HINT}>
                  <Input value={form.driver_phone} inputMode="numeric" maxLength={18}
                    onChange={(e) => setForm({
                      ...form, driver_phone: sanitizePhone(e.target.value),
                    })} />
                </Field>
                {/* The other job the vehicle was already doing — the whole reason this
                    mode costs the shipment nothing. Asked here as well as on the manual
                    form, so a one-press dispatch does not lose it. */}
                <Field label="Trip reference"
                  hint="The other job the vehicle was already doing">
                  <Input value={form.trip_reference}
                    onChange={(e) => setForm({ ...form, trip_reference: e.target.value })} />
                </Field>
              </>
            )}

            {needs("handed_over_by_name") && (
              <>
                <Field label="Handed over by">
                  <Input value={form.handed_over_by_name}
                    onChange={(e) => setForm({ ...form, handed_over_by_name: e.target.value })} />
                </Field>
                <Field label="Received by">
                  <Input value={form.received_by_name}
                    onChange={(e) => setForm({ ...form, received_by_name: e.target.value })} />
                </Field>
              </>
            )}
          </div>

          {/* Why the press is held back. A disabled button with no reason beside it
              reads as a broken screen. */}
          {id > 0 && !already && (missing.length > 0 || badValues.length > 0) && (
            <p className="mt-4 text-xs text-muted">
              {missing.length > 0 && (
                <>
                  {modeLabel(mode)} still needs{" "}
                  {missing.map((field) => FIELD_LABELS[field] ?? field).join(", ")}.
                </>
              )}
              {badValues.length > 0 && (
                <span className="text-danger">
                  {missing.length > 0 ? " " : ""}{badValues.join(" · ")}.
                </span>
              )}
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
