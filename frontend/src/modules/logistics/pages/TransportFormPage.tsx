import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Handshake, Package, Search, Truck, Users } from "lucide-react";
import {
  Button, Card, ErrorBanner, Field, Input, PageHeader, Select, useAction,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { consignmentApi, indentLookupApi, transportApi } from "../api";
import { headerFromConsignment, linesFromConsignment } from "../components/consignmentToLines";
import {
  notPastError, numberError, phoneError, PHONE_HINT, problems, requiredError,
  sanitizePhone, todayISO,
} from "../components/validate";
import type {
  ModeRule, TransportMode, TRInput, TRLineInput,
} from "../transportTypes";

const BLANK_LINE: TRLineInput = {
  item_name: "", uom_code: "", quantity: 0, package_count: 1, package_type: "",
  weight_kg: null, length_cm: null, width_cm: null, height_cm: null, is_fragile: false,
};

const num = (value: string) => (value === "" ? null : Number(value));

/** One icon per mode. Presentation only — the RULES come from `/api/transport/modes`. */
const MODE_ICON: Record<string, typeof Truck> = {
  DIRECT: Handshake,
  COURIER: Package,
  OWN_VEHICLE: Truck,
  THIRD_PARTY: Users,
};

const BLANK_HEADER = {
  to_location_name: "", delivery_address: "", contact_person: "", contact_phone: "",
  from_warehouse_name: "", indent_no: "", distance_km: "", expected_delivery: "",
  remarks: "",
};

/**
 * Plan the movement of a consignment: one screen, top to bottom.
 *
 * Dispatch used to be a second document raised after this one. It is a stage of this
 * one now, so this form is where a leg starts and the detail screen is where it is
 * worked — and the first thing it asks is the first thing that happens in the real
 * world: WHICH packed consignment are we moving? Pick it and the destination, the
 * contact, the indent it is against and every line with its carton weights arrive
 * filled in. Nobody retypes a packing list.
 *
 * The mode tiles are the second question and they change the form: the rules
 * (what each mode requires, whether it is tendered) come from the backend, so the
 * form asks for exactly what the service will validate.
 */
export function TransportFormPage() {
  const nav = useNavigate();
  const { id } = useParams();
  const [params] = useSearchParams();
  const editing = Boolean(id);

  const [consignmentId, setConsignmentId] = useState<number | null>(() => {
    const raw = params.get("consignment");
    return raw && /^\d+$/.test(raw) ? Number(raw) : null;
  });
  const [picking, setPicking] = useState(false);
  const [pickSearch, setPickSearch] = useState("");

  const [mode, setMode] = useState<TransportMode>("THIRD_PARTY");
  // Which WAY this leg runs (doc E7). An outward leg leaves a warehouse; a return
  // comes back to one, and it is the same document, the same modes and the same
  // statuses — only the two ends swap. The returns module owns the DECISION to send
  // something back; this is only the trip it has to travel.
  //
  // Decided by the URL, not by a control on the form. `?direction=return` is what the
  // "Return leg" button opens, so the desk has already answered "which way" before it
  // sees a field — a checkbox halfway down a section headed "Where it goes" made the
  // direction look like an afterthought on the outward form, and a leg raised with it
  // unticked by mistake is a collection booked as a delivery.
  const [isReturn, setIsReturn] = useState(
    () => (params.get("direction") ?? "").toLowerCase() === "return");
  const [header, setHeader] = useState({ ...BLANK_HEADER });
  const [linked, setLinked] = useState<Partial<TRInput>>({});
  const [provider, setProvider] = useState({
    carrier_id: "", vehicle_number: "", driver_name: "", driver_phone: "",
    trip_reference: "", handed_over_by_name: "",
  });
  const [lines, setLines] = useState<TRLineInput[]>([{ ...BLANK_LINE }]);

  const { data: modes } = useQuery({
    queryKey: ["transport-modes"],
    queryFn: transportApi.modes,
  });
  const { data: carriers } = useQuery({
    queryKey: ["transport-carriers"],
    queryFn: () => transportApi.carriers(),
  });
  const { data: existing, error: loadError } = useQuery({
    queryKey: ["transport", id],
    queryFn: () => transportApi.get(Number(id)),
    enabled: editing,
  });
  /** The packed queue, for the picker. Only ever read — see api.ts. */
  const { data: packed } = useQuery({
    queryKey: ["lgs-consignments", "packed", pickSearch],
    queryFn: () => consignmentApi.list({
      status: "PACKED", search: pickSearch.trim() || undefined, size: 10,
    }),
    enabled: picking,
  });
  const { data: consignment, error: consignmentError } = useQuery({
    queryKey: ["lgs-consignment", consignmentId],
    queryFn: () => consignmentApi.get(consignmentId!),
    enabled: Boolean(consignmentId) && !editing,
  });

  // Loading an existing draft wins over any consignment prefill: what was saved is
  // what the person came back to, even if the lines have since been edited by hand.
  useEffect(() => {
    if (!existing) return;
    setMode(existing.mode);
    // Reopening a return must reopen as a return, or saving it would quietly turn it
    // back into an outward leg and swap both ends of the trip.
    setIsReturn((existing.source_type ?? "").toUpperCase() === "RETURN");
    setHeader({
      to_location_name: existing.to_location_name ?? "",
      delivery_address: existing.delivery_address ?? "",
      contact_person: existing.contact_person ?? "",
      contact_phone: existing.contact_phone ?? "",
      from_warehouse_name: existing.from_warehouse_name ?? "",
      indent_no: existing.indent_no ?? "",
      distance_km: existing.distance_km?.toString() ?? "",
      expected_delivery: existing.expected_delivery ?? "",
      remarks: existing.remarks ?? "",
    });
    setLinked({
      dispatch_id: existing.dispatch_id, consignment_no: existing.consignment_no,
      source_type: existing.source_type, source_id: existing.source_id,
      source_no: existing.source_no, issue_id: existing.issue_id,
      indent_id: existing.indent_id, from_warehouse_id: existing.from_warehouse_id,
      project_id: existing.project_id, project_name: existing.project_name,
    });
    setProvider({
      carrier_id: existing.carrier_id?.toString() ?? "",
      vehicle_number: existing.vehicle_number ?? "",
      driver_name: existing.driver_name ?? "",
      driver_phone: existing.driver_phone ?? "",
      trip_reference: existing.trip_reference ?? "",
      handed_over_by_name: existing.handed_over_by_name ?? "",
    });
    if (existing.items.length) {
      setLines(existing.items.map((item) => ({
        item_id: item.item_id, item_code: item.item_code, item_name: item.item_name,
        uom_code: item.uom_code, quantity: item.quantity,
        package_count: item.package_count, package_type: item.package_type,
        weight_kg: item.weight_kg, length_cm: item.length_cm,
        width_cm: item.width_cm, height_cm: item.height_cm,
        is_fragile: item.is_fragile, remarks: item.remarks,
      })));
    }
  }, [existing]);

  useEffect(() => {
    if (!consignment || editing) return;
    const prefill = headerFromConsignment(consignment);
    setLinked(prefill);
    setHeader((current) => ({
      ...current,
      to_location_name: prefill.to_location_name ?? "",
      delivery_address: prefill.delivery_address ?? "",
      contact_person: prefill.contact_person ?? "",
      contact_phone: prefill.contact_phone ?? "",
      from_warehouse_name: prefill.from_warehouse_name ?? "",
      indent_no: prefill.indent_no ?? "",
      expected_delivery: prefill.expected_delivery ?? "",
    }));
    const built = linesFromConsignment(consignment);
    if (built.length) setLines(built);
  }, [consignment, editing]);

  const rule: ModeRule | undefined = useMemo(
    () => modes?.find((m) => m.value === mode), [modes, mode],
  );
  const needs = (field: string) => rule?.required_fields.includes(field) ?? false;

  const totals = useMemo(() => lines.reduce((acc, line) => ({
    packages: acc.packages + Number(line.package_count ?? 0),
    weight: acc.weight + Number(line.weight_kg ?? 0),
    qty: acc.qty + Number(line.quantity ?? 0),
  }), { packages: 0, weight: 0, qty: 0 }), [lines]);

  // The lines came off a packing list, so they are NOT the desk's to retype. A packed
  // consignment has been picked, counted and sealed by the warehouse; changing the
  // quantity here would make the carrier price a load that does not match what is in
  // the cartons, and the receiving site sign for a number nobody packed. Amend the
  // consignment in Warehouse if it is wrong — that is the document that owns it.
  const fromPackingList = Boolean(linked.dispatch_id) && !isReturn;

  // The indents this leg can point at. Free-typing this number is how a leg ends up
  // against an indent that does not exist, and the raiser's own tracking then shows
  // nothing with no error anywhere. Locked once a consignment supplies it: the
  // consignment already knows which indent it was packed for, and letting the desk
  // overwrite that is letting two documents disagree about the same fact.
  const indentLocked = Boolean(linked.indent_id) || fromPackingList;
  const { data: indentOptions } = useQuery({
    queryKey: ["lgs-indent-options"],
    queryFn: () => indentLookupApi.options(),
    enabled: !indentLocked,
  });
  // An empty list means the picker could not load — most likely this profile holds no
  // `indent.view` — so the field stays a text box rather than becoming a dead dropdown.
  const canPickIndent = Boolean(indentOptions?.length);

  /** What is WRONG, as opposed to merely unfinished.
   *
   *  A malformed phone number or a delivery promised into the past is wrong whatever the
   *  person does next, so these block the DRAFT as well. Anything a draft is simply
   *  allowed to be missing lives in `submitProblems` instead.
   *
   *  Collected in one place and shown at the foot beside the buttons rather than each
   *  field shouting on its own: a long form with six red boxes scattered down it makes
   *  the person hunt, and a disabled button with no reason beside it reads as broken.
   *
   *  These mirror what `service.py` enforces — never a second set of rules. */
  const dataProblems = useMemo(() => problems(
    phoneError(header.contact_phone, "Contact phone"),
    phoneError(provider.driver_phone, "Driver phone"),
    notPastError(header.expected_delivery, "Needed by"),
    numberError(header.distance_km, "Distance", { min: 0 }),
    lines.some((line) => Number(line.quantity) < 0 || Number(line.package_count) < 0)
      ? "Quantities and package counts cannot be negative" : null,
    lines.some((line) => Number(line.weight_kg) < 0)
      ? "A weight cannot be negative" : null,
  ), [header, provider, lines]);

  /** What must be answered before this can go for APPROVAL.
   *
   *  A draft is allowed to be incomplete — that is the whole point of a draft, and the
   *  service says so in `_check_mode_fields`. So these gate the submit and not the save.
   *
   *  `carrier_id` is dropped for a TENDERED mode for exactly the reason the service
   *  drops it: a third-party carrier is AWARDED off the quotes, so demanding one up
   *  front would make a third-party leg impossible to submit, while the form beside it
   *  correctly tells the desk to leave the carrier blank. */
  const submitProblems = useMemo(() => {
    const labels: Record<string, string> = {
      vehicle_number: "Vehicle number",
      driver_name: "Driver name",
      handed_over_by_name: "Who hands it over",
    };
    const modeFields = (rule?.required_fields ?? [])
      .filter((field) => !(field === "carrier_id" && rule?.needs_quotes));
    return problems(
      requiredError(header.to_location_name,
        isReturn ? "The warehouse it comes back to" : "Destination"),
      lines.some((line) => line.item_name || line.item_id || Number(line.quantity))
        ? null : "Add at least one line",
      // A line that exists must say WHAT and HOW MANY: a nameless line prices nothing,
      // and a zero-quantity line is one somebody started and walked away from.
      lines.some((line) => (line.item_name || line.item_id) && !Number(line.quantity))
        ? "Every line needs a quantity" : null,
      ...modeFields.map((field) => (
        field === "carrier_id"
          ? requiredError(provider.carrier_id, "A carrier")
          : requiredError(
              (provider as unknown as Record<string, string>)[field],
              labels[field] ?? field)
      )),
    );
  }, [header, provider, lines, rule, isReturn]);

  const payload = (): TRInput => ({
    ...linked,
    mode,
    // A return leg runs the other way (doc E7). `linked` carries the source of a leg
    // raised FROM a consignment, so this only ever overrides a leg raised by hand.
    ...(isReturn ? { source_type: "RETURN" } : {}),
    to_location_name: header.to_location_name || null,
    delivery_address: header.delivery_address || null,
    contact_person: header.contact_person || null,
    contact_phone: header.contact_phone || null,
    from_warehouse_name: header.from_warehouse_name || null,
    indent_no: header.indent_no || null,
    distance_km: header.distance_km ? Number(header.distance_km) : null,
    expected_delivery: header.expected_delivery || null,
    remarks: header.remarks || null,
    carrier_id: provider.carrier_id ? Number(provider.carrier_id) : null,
    vehicle_number: provider.vehicle_number || null,
    driver_name: provider.driver_name || null,
    driver_phone: provider.driver_phone || null,
    trip_reference: provider.trip_reference || null,
    handed_over_by_name: provider.handed_over_by_name || null,
    lines: lines.filter((line) => line.item_name || line.item_id || line.quantity),
  });

  const save = useAction({
    run: () => (editing
      ? transportApi.update(Number(id), payload())
      : transportApi.create(payload())),
    success: editing ? "Shipment saved" : "Shipment raised",
    invalidates: [["transport"], ["lgs-consignment-links"]],
    onDone: (doc) => nav(`/logistics/shipments/${doc.id}`),
  });

  // Save and submit in one press. Two buttons for "I am done with this form" is the
  // reason drafts sit unsubmitted for a week.
  const saveAndSubmit = useAction({
    run: async () => {
      const doc = editing
        ? await transportApi.update(Number(id), payload())
        : await transportApi.create(payload());
      return transportApi.submit(doc.id);
    },
    success: "Sent for approval",
    invalidates: [["transport"], ["lgs-consignment-links"]],
    onDone: (doc) => nav(`/logistics/shipments/${doc.id}`),
  });

  const setLine = (index: number, patch: Partial<TRLineInput>) =>
    setLines((all) => all.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  const busy = save.isPending || saveAndSubmit.isPending;
  // A draft may be unfinished but must not be malformed; a submission must be both.
  const cannotSave = busy || dataProblems.length > 0;
  const cannotSubmit = cannotSave || submitProblems.length > 0;
  const shown = dataProblems.length ? dataProblems : submitProblems;

  /** The step numbers, counted rather than written in.
   *
   *  A return leg has no consignment to pick, so section 1 is not on the form — and
   *  hardcoding the numbers meant the return form opened at "2 How it travels" with no
   *  1 above it, which reads as a screen that failed to load half of itself. */
  const step = isReturn
    ? { travel: 1, where: 2, load: 3 }
    : { moving: 1, travel: 2, where: 3, load: 4 };

  /** Flip the direction, and clear the two ends with it.
   *
   *  The fields do not mean the same thing on the other side: a warehouse typed into
   *  "Back to warehouse" is not a site, and carrying it across left the form asserting
   *  that material was going out to a warehouse it had just come back from. Everything
   *  else — mode, lines, contact, dates — is direction-agnostic and stays. */
  const flipDirection = (next: boolean) => {
    setIsReturn(next);
    setHeader((current) => ({
      ...current, to_location_name: "", from_warehouse_name: "",
    }));
  };

  return (
    <div className="pb-24">
      <PageHeader
        eyebrow="Logistics"
        title={editing
          ? `Edit ${existing?.tr_no ?? "shipment"}`
          : isReturn ? "Plan a return leg" : "Plan a movement"}
        actions={
          <Button variant="ghost" onClick={() => nav(-1)}>Back</Button>
        }
      />

      <ErrorBanner error={loadError ?? consignmentError ?? save.error
        ?? saveAndSubmit.error} />

      {/* Which way the leg runs, asked FIRST and as a plain either/or.
          It was a link at the foot of section 3 reading "make this an outward leg",
          which is a sentence, not a control: you could not see which of the two you
          were on without reading the paragraph beside it. A return travels exactly like
          an outward leg — same modes, same statuses, both ends swapped (doc E7) — so
          this is one document with a direction, and the direction is the first thing to
          settle. Locked once saved: flipping an existing leg would swap both its ends
          under a document already in approval. */}
      {!editing && (
        <div className="mb-4 inline-flex rounded-xl border border-line bg-surface-2 p-1">
          {[
            { value: false, label: "Outward", hint: "Warehouse → field" },
            { value: true, label: "Return", hint: "Field → warehouse" },
          ].map((option) => (
            <button
              key={option.label}
              type="button"
              onClick={() => flipDirection(option.value)}
              aria-pressed={isReturn === option.value}
              className={`min-h-11 rounded-lg px-4 py-1.5 text-left transition ${
                isReturn === option.value
                  ? "bg-content1 shadow-sm ring-1 ring-brand/30"
                  : "hover:bg-content1/60"
              }`}
            >
              <span className={`block text-sm font-semibold ${
                isReturn === option.value ? "text-brand" : "text-body"
              }`}>
                {option.label}
              </span>
              <span className="block text-[11px] text-muted">{option.hint}</span>
            </button>
          ))}
        </div>
      )}

      {/* 1 — what is moving.
          Hidden on a return: a packed consignment is something the WAREHOUSE built to
          send out, and there is never one behind material coming back from a site. The
          lines are typed in section 4 instead, which is what a collection is — you
          write down what the site is handing over. */}
      {!editing && !isReturn && (
        <Card className="mb-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-display text-lg font-semibold text-ink">
                <span className="mr-2 text-brand">1</span>What is moving
              </h2>
              {consignment ? (
                <div className="mt-1 text-sm text-body">
                  <span className="font-mono font-semibold text-ink">
                    {consignment.dispatch_no}
                  </span>
                  {" · "}
                  {consignment.total_packages} pkg · {consignment.items?.length ?? 0} lines
                  {consignment.expected_delivery
                    ? ` · needed by ${fmtDate(consignment.expected_delivery)}`
                    : ""}
                </div>
              ) : (
                <p className="mt-1 text-sm text-muted">
                  Pick the packed consignment and everything below fills itself in — or
                  move something the warehouse has not packed as a consignment.
                </p>
              )}
            </div>
            <Button
              variant={consignment ? "ghost" : "soft"}
              onClick={() => setPicking(!picking)}
            >
              {consignment ? "Choose another" : "Pick a consignment"}
            </Button>
          </div>

          {picking && (
            <div className="mt-4 space-y-3 rounded-lg border border-line p-3">
              <div className="flex items-center gap-2">
                <Search className="h-4 w-4 shrink-0 text-muted" />
                <Input
                  value={pickSearch}
                  placeholder="Consignment no, issue or destination…"
                  onChange={(e) => setPickSearch(e.target.value)}
                />
              </div>
              <ul className="space-y-2">
                {(packed?.items ?? []).map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setConsignmentId(row.id);
                        setPicking(false);
                      }}
                      className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-left transition hover:border-brand hover:bg-surface-2"
                    >
                      <span className="min-w-0">
                        <span className="block font-mono text-xs font-semibold text-ink">
                          {row.dispatch_no}
                        </span>
                        <span className="block truncate text-xs text-muted">
                          {row.destination_office_name ?? row.to_warehouse_name
                            ?? row.delivery_address ?? "No destination"}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-body">
                        {row.total_packages} pkg
                      </span>
                    </button>
                  </li>
                ))}
                {packed && packed.items.length === 0 && (
                  <li className="py-3 text-center text-sm text-muted">
                    Nothing packed is waiting.
                  </li>
                )}
              </ul>
            </div>
          )}
        </Card>
      )}

      {/* 2 — how it travels */}
      <Card className="mb-4 p-5">
        <h2 className="font-display text-lg font-semibold text-ink">
          <span className="mr-2 text-brand">{step.travel}</span>How it travels
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(modes ?? []).map((option) => {
            const Icon = MODE_ICON[option.value] ?? Truck;
            const active = option.value === mode;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setMode(option.value)}
                className={`min-h-11 rounded-xl border p-4 text-left transition ${
                  active
                    ? "border-brand bg-brand/5 ring-2 ring-brand/20"
                    : "border-line hover:border-brand/50 hover:bg-surface-2"
                }`}
              >
                <Icon className={`h-5 w-5 ${active ? "text-brand" : "text-muted"}`} />
                <div className="mt-2 text-sm font-semibold text-ink">{option.label}</div>
                <div className="mt-0.5 text-[11px] leading-snug text-muted">
                  {option.help}
                </div>
                {option.needs_quotes && (
                  <div className="mt-2 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                    Quoted &amp; awarded
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {(rule?.needs_carrier || needs("vehicle_number")
          || needs("handed_over_by_name")) && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {rule?.needs_carrier && (
              <Field
                label={rule.needs_quotes ? "Carrier (optional until awarded)" : "Carrier"}
                hint={rule.needs_quotes
                  ? "Leave blank — the carrier is chosen from the quotes."
                  : undefined}
              >
                <Select
                  value={provider.carrier_id}
                  placeholder="Choose a transport provider"
                  options={(carriers ?? []).map((c) => ({ value: c.id, label: c.name }))}
                  onChange={(value) => setProvider({ ...provider, carrier_id: value })}
                />
              </Field>
            )}
            {needs("vehicle_number") && (
              <>
                <Field label="Vehicle number">
                  <Input value={provider.vehicle_number}
                    onChange={(e) => setProvider({ ...provider, vehicle_number: e.target.value })} />
                </Field>
                <Field label="Driver">
                  <Input value={provider.driver_name}
                    onChange={(e) => setProvider({ ...provider, driver_name: e.target.value })} />
                </Field>
                <Field label="Driver phone">
                  <Input value={provider.driver_phone}
                    onChange={(e) => setProvider({ ...provider, driver_phone: e.target.value })} />
                </Field>
                <Field label="Trip it rides on"
                  hint="The other job the vehicle was already doing">
                  <Input value={provider.trip_reference}
                    onChange={(e) => setProvider({ ...provider, trip_reference: e.target.value })} />
                </Field>
              </>
            )}
            {needs("handed_over_by_name") && (
              <Field label="Handed over by"
                hint="Receipt is confirmed later by the indent requester with photos and bills.">
                <Input value={provider.handed_over_by_name}
                  onChange={(e) => setProvider({ ...provider, handed_over_by_name: e.target.value })} />
              </Field>
            )}
          </div>
        )}
      </Card>

      {/* 3 — where it goes */}
      <Card className="mb-4 space-y-4 p-5">
        <h2 className="font-display text-lg font-semibold text-ink">
          <span className="mr-2 text-brand">{step.where}</span>
          {isReturn ? "Where it comes back to" : "Where it goes"}
        </h2>


        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            required
            label={isReturn ? "Back to warehouse" : "Destination"}
            hint={isReturn ? "Which warehouse receives it" : undefined}
          >
            <Input value={header.to_location_name}
              placeholder={isReturn ? "Warehouse name" : "Site or office name"}
              onChange={(e) => setHeader({ ...header, to_location_name: e.target.value })} />
          </Field>
          <Field label={isReturn ? "Collected from" : "From warehouse"}>
            <Input value={header.from_warehouse_name}
              placeholder={isReturn ? "Site or office sending it back" : undefined}
              onChange={(e) => setHeader({ ...header, from_warehouse_name: e.target.value })} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Delivery address" hint="What the carrier is given">
              <Input value={header.delivery_address}
                onChange={(e) => setHeader({ ...header, delivery_address: e.target.value })} />
            </Field>
          </div>
          <Field label="Contact person">
            <Input value={header.contact_person}
              onChange={(e) => setHeader({ ...header, contact_person: e.target.value })} />
          </Field>
          {/* The message replaces the hint rather than sitting beside it: `Field` takes
              a hint and nothing else, and widening the shared kit is not this module's
              to do. The footer carries the blocking list either way. */}
          <Field label="Contact phone"
            hint={phoneError(header.contact_phone, "Contact phone") ?? PHONE_HINT}>
            <Input value={header.contact_phone} inputMode="numeric" maxLength={18}
              onChange={(e) => setHeader({
                ...header, contact_phone: sanitizePhone(e.target.value),
              })} />
          </Field>

          {/* Against indent. Picked, not typed: this pointer is what the RAISER's own
              tracking reads (`/api/transport/for-indent/{id}`), and a number typed from
              memory that matches no indent breaks that screen silently — nothing errors,
              the material simply never appears for the person waiting on it.

              Read-only once a consignment supplies it: the consignment already knows
              which indent it was packed against, and letting the desk overwrite that is
              letting two documents disagree about the same fact. */}
          {indentLocked ? (
            <Field label="Against indent"
              hint="From the consignment — amend it in Warehouse if it is wrong">
              <Input value={header.indent_no} readOnly disabled />
            </Field>
          ) : canPickIndent ? (
            <Field label="Against indent" hint="Links the leg back to what asked for it">
              <Select
                value={header.indent_no}
                onChange={(value) => setHeader({ ...header, indent_no: String(value ?? "") })}
                options={[
                  { value: "", label: "Not against an indent" },
                  ...(indentOptions ?? []).map((row) => ({
                    value: row.indent_no,
                    label: `${row.indent_no} · ${row.status}${
                      row.department_name ? ` · ${row.department_name}` : ""}`,
                  })),
                ]}
                ariaLabel="Against indent"
              />
            </Field>
          ) : (
            // The picker could not load — most likely no `indent.view` on this profile.
            // A text box is worse, but a dropdown with nothing in it is a dead end.
            <Field label="Against indent" hint="Links the leg back to what asked for it">
              <Input value={header.indent_no}
                onChange={(e) => setHeader({ ...header, indent_no: e.target.value })} />
            </Field>
          )}

          {/* A delivery is always promised FORWARD. `min` greys out the earlier days in
              the picker; `notPastError` catches the date typed in by keyboard, which no
              browser blocks. */}
          <Field label="Needed by"
            hint={notPastError(header.expected_delivery, "Needed by")
              ?? "Today or later"}>
            <Input type="date" value={header.expected_delivery} min={todayISO()}
              onChange={(e) => setHeader({ ...header, expected_delivery: e.target.value })} />
          </Field>
          <Field label="Distance (km)"
            hint={numberError(header.distance_km, "Distance", { min: 0 })
              ?? "Used when comparing carrier quotes"}>
            <Input type="number" min={0} value={header.distance_km}
              onChange={(e) => setHeader({ ...header, distance_km: e.target.value })} />
          </Field>
          <div className="sm:col-span-2 lg:col-span-3">
            <Field label="Note for the carrier">
              <Input value={header.remarks}
                onChange={(e) => setHeader({ ...header, remarks: e.target.value })} />
            </Field>
          </div>
        </div>
      </Card>

      {/* 4 — the load */}
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-lg font-semibold text-ink">
              <span className="mr-2 text-brand">{step.load}</span>
              {isReturn ? "What is coming back" : "What is in the consignment"}
            </h2>
            <p className="text-xs text-muted">
              {fromPackingList
                ? "Read from the packing list — the warehouse picked, counted and sealed these cartons, so item and quantity are not editable here (amend the consignment in Warehouse if one is wrong). Weight and L×W×H stay open: they are what a carrier prices, and a packer rarely measures them."
                : "Weight and dimensions are what a carrier prices. Filled in from the packing list when this came from a consignment — each carton counted once."}
            </p>
          </div>
          {/* A packed consignment's line-up is the warehouse's, so nothing may be added
              to it here either: an extra line would be freight quoted for a carton that
              is not on the pallet. */}
          {!fromPackingList && (
            <Button variant="ghost" onClick={() => setLines([...lines, { ...BLANK_LINE }])}>
              Add line
            </Button>
          )}
        </div>

        <div className="space-y-3">
          {lines.map((line, index) => (
            <div
              key={index}
              className="grid gap-3 rounded-lg border border-line/70 p-3 sm:grid-cols-2 lg:grid-cols-7"
            >
              <div className="lg:col-span-2">
                <Field label="Item">
                  <Input value={line.item_name ?? ""} readOnly={fromPackingList}
                    disabled={fromPackingList}
                    onChange={(e) => setLine(index, { item_name: e.target.value })} />
                </Field>
              </div>
              {/* Quantity and cartons come from the packing list on a consignment leg.
                  Editing them would have the carrier price a load that does not match
                  what is in the cartons, and the receiving site sign for a number
                  nobody packed. */}
              <Field label="Qty" required={!fromPackingList}>
                <Input type="number" min={0} value={line.quantity?.toString() ?? ""}
                  readOnly={fromPackingList} disabled={fromPackingList}
                  onChange={(e) => setLine(index, { quantity: Number(e.target.value) })} />
              </Field>
              <Field label="Packages">
                <Input type="number" min={0} value={line.package_count?.toString() ?? ""}
                  readOnly={fromPackingList} disabled={fromPackingList}
                  onChange={(e) => setLine(index, { package_count: Number(e.target.value) })} />
              </Field>
              {/* Weight and dimensions stay EDITABLE even off a packing list, and that
                  is the line between the two documents: the warehouse counted and sealed
                  the cartons, so what is in them is theirs — but a packer records weight
                  and almost never records L×W×H, and those are exactly what a carrier
                  prices. Locking them left every leg quoting against 0 m³. */}
              <Field label="Weight (kg)">
                <Input type="number" min={0} value={line.weight_kg?.toString() ?? ""}
                  onChange={(e) => setLine(index, { weight_kg: num(e.target.value) })} />
              </Field>
              <Field label="L×W×H (cm)">
                <div className="flex gap-1">
                  <Input type="number" min={0} value={line.length_cm?.toString() ?? ""}
                    onChange={(e) => setLine(index, { length_cm: num(e.target.value) })} />
                  <Input type="number" min={0} value={line.width_cm?.toString() ?? ""}
                    onChange={(e) => setLine(index, { width_cm: num(e.target.value) })} />
                  <Input type="number" min={0} value={line.height_cm?.toString() ?? ""}
                    onChange={(e) => setLine(index, { height_cm: num(e.target.value) })} />
                </div>
              </Field>
              <div className="flex items-end justify-between gap-2">
                <label className="flex min-h-11 items-center gap-2 text-sm text-body">
                  <input type="checkbox" checked={line.is_fragile ?? false}
                    disabled={fromPackingList}
                    onChange={(e) => setLine(index, { is_fragile: e.target.checked })} />
                  Fragile
                </label>
                {lines.length > 1 && !fromPackingList && (
                  <Button variant="ghost"
                    onClick={() => setLines(lines.filter((_, i) => i !== index))}>
                    Remove
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* The running total and the two ways out, pinned so they are reachable from
          anywhere in a long form. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-content1/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-350 flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-4 text-sm">
            <span className="flex items-center gap-1.5 text-body">
              <Boxes className="h-4 w-4 text-muted" />
              <strong className="text-ink">{totals.packages}</strong> pkg
            </span>
            <span className="text-body">
              <strong className="text-ink">
                {totals.weight.toLocaleString("en-IN")}
              </strong> kg
            </span>
            <span className="hidden text-body sm:inline">
              <strong className="text-ink">{lines.length}</strong> lines
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Why a press is held back. A draft may be UNFINISHED — that is what a
                draft is for — so only a malformed value stops the save; a submission
                has to be complete as well, which is the rule `submit_tr` enforces. */}
            {shown.length > 0 && (
              <p className="w-full text-xs text-danger sm:w-auto sm:max-w-md">
                {shown.join(" · ")}
              </p>
            )}
            <Button variant="ghost" onClick={() => save.mutate()} disabled={cannotSave}>
              {save.isPending ? "Saving…" : "Save draft"}
            </Button>
            <Button onClick={() => saveAndSubmit.mutate()} disabled={cannotSubmit}>
              {saveAndSubmit.isPending ? "Sending…" : "Save & send for approval"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
