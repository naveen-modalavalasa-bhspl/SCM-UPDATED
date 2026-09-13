import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Handshake } from "lucide-react";
import {
  Button, Card, ErrorBanner, Field, Input, StatusPill, useAction,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { carrierPortalApi } from "../api";
import {
  carriageLabel, carriageTint, load, modeLabel, modeTint, money,
} from "../components/modeCopy";
import { CARRIAGE_ICON } from "../components/transportIcons";
import { phoneError, PHONE_HINT, problems, sanitizePhone } from "../components/validate";
import type { CarriageMode, TransportRequest, TRListRow } from "../transportTypes";
import { EmptyQueue, PortalHeading } from "./portalUi";
import { ManifestTable } from "../components/ManifestTable";

const BLANK = {
  driver_name: "", vehicle_number: "", driver_phone: "", driver_licence_no: "",
  lr_no: "", docket_no: "", tracking_url: "", eway_bill_no: "", carrier_reference: "",
};

/** The fields this portal form marks as owed before the carrier can acknowledge.
 *  The LR/docket pair is checked separately because either one is enough. */
const REQUIRED = ["driver_name", "vehicle_number", "driver_phone"] as const;
const REQUIRED_LABELS: Record<(typeof REQUIRED)[number], string> = {
  driver_name: "driver's name",
  vehicle_number: "vehicle number",
  driver_phone: "phone number",
};

/** Every rung a won job passes through after the yes. The Shipments board is the
 *  tender and nothing else, so these are listed here — collected, on the road, landed
 *  — and each row opens the job screen, which is where the LR and the delivery report
 *  are given. */
const RUNNING = "READY,IN_TRANSIT,DELIVERED,ACKNOWLEDGED";

/** What is still owed on a job already taken, said in the row rather than left to the
 *  status pill: "READY" is our word for it, "the warehouse has it packed" is theirs. */
const NEXT_STEP: Record<string, string> = {
  READY: "Ready to collect — add the LR number when you pick it up",
  IN_TRANSIT: "On the road — tell us when it lands",
  DELIVERED: "Delivered — waiting for the site to sign for it",
  ACKNOWLEDGED: "Signed for by the site",
};

/**
 * Acknowledgements — the awarded carrier saying yes, and saying what is coming.
 *
 * The tender ends with the desk awarding a price, and an award is an offer: the
 * shipment sits on AWAITING_CARRIER until this carrier answers it. What was missing
 * was the other half of that answer. The dispatch desk fills the driver, the vehicle
 * and the numbers the site chases a load on when it settles a leg itself — but on a
 * tender NOBODY on our side knows them, because the truck is the carrier's. So the
 * same boxes are asked here, of the only party who can fill them, and they travel back
 * with the yes: one press writes them onto the shipment and accepts the award, which
 * is what puts it on READY for the warehouse to load against.
 *
 * Its own screen rather than a panel on the job page, because acknowledging is a
 * different job from quoting: a carrier prices lanes all week and confirms the two
 * they won, and those two should not have to be found among the rest.
 *
 * No uploads. The paperwork is raised on our side at dispatch; what is wanted from
 * the carrier is the vehicle and the man, not a scan. Nor the carriage: road, rail,
 * air or sea was the desk's call at dispatch and the price was quoted against it.
 */
export function CarrierAckPage() {
  // Which shipment is being answered lives in the URL, so the page can be linked to
  // from a job card and a reload does not drop the carrier back to the list.
  const nav = useNavigate();
  const [search, setSearch] = useSearchParams();
  const chosenId = Number(search.get("tr") ?? 0);
  const [form, setForm] = useState({ ...BLANK });

  const { data: awarded, isLoading, error } = useQuery({
    queryKey: ["carrier-jobs", "AWAITING_CARRIER"],
    queryFn: () => carrierPortalApi.list({ status: "AWAITING_CARRIER", size: 50 }),
  });
  // What has already been answered: a carrier who filled this in yesterday should be
  // able to see WHAT they said without opening each job. It runs to ACKNOWLEDGED
  // because the Shipments board carries the tender only — once a lane is won, this is
  // the one screen the job is listed on, and adding the LR or reporting it delivered
  // is reached from these rows.
  const { data: confirmed } = useQuery({
    queryKey: ["carrier-jobs", RUNNING],
    queryFn: () => carrierPortalApi.list({ status: RUNNING, size: 20 }),
  });

  const rows = awarded?.items ?? [];
  const job = rows.find((row) => row.id === chosenId) ?? null;
  // The list row keeps the queue light; opening one acknowledgement fetches the full
  // transport request so courier and third-party logins see the same route, load,
  // item and reference data the dispatch desk sent them.
  const { data: detail, error: detailError } = useQuery({
    queryKey: ["carrier-job", chosenId],
    queryFn: () => carrierPortalApi.get(chosenId),
    enabled: chosenId > 0 && Boolean(job),
  });

  // One shipment to answer is not a list to choose from. Opened straight onto it, and
  // only while nothing else is chosen, so this never fights the carrier's own pick.
  useEffect(() => {
    if (!chosenId && rows.length === 1) {
      setSearch({ tr: String(rows[0].id) }, { replace: true });
    }
  }, [chosenId, rows, setSearch]);

  const choose = (id: number) => {
    // A fresh form per shipment: carrying one truck's number onto the next job is how
    // the wrong vehicle turns up at the gate.
    setForm({ ...BLANK });
    setSearch(id ? { tr: String(id) } : {}, { replace: true });
  };

  const acknowledge = useAction({
    run: () => carrierPortalApi.acknowledge(job!.id, {
      driver_name: form.driver_name.trim(),
      vehicle_number: form.vehicle_number.trim(),
      driver_phone: form.driver_phone || null,
      driver_licence_no: form.driver_licence_no || null,
      lr_no: form.lr_no.trim() || null,
      docket_no: form.docket_no.trim() || null,
      tracking_url: form.tracking_url.trim() || null,
      eway_bill_no: form.eway_bill_no || null,
      carrier_reference: form.carrier_reference || null,
    }),
    success: (tr) => `${tr.tr_no} acknowledged — the warehouse can load it`,
    invalidates: [["carrier-jobs"], ["carrier-summary"], ["carrier-job"]],
    onDone: () => choose(0),
  });

  const missing = REQUIRED.filter((key) => !form[key].trim());
  const courierNeedsTracking = job?.mode === "COURIER";
  const docketLabel = courierNeedsTracking ? "courier docket number" : "docket number";
  const hasTrackingHandle = Boolean(form.lr_no.trim() || form.docket_no.trim());
  const missingTrackingHandle = !hasTrackingHandle;
  const badValues = problems(phoneError(form.driver_phone, "Phone"));
  const blocked = !job || missing.length > 0 || badValues.length > 0
    || missingTrackingHandle
    || acknowledge.isPending;

  return (
    <div>
      <PortalHeading
        title="Acknowledgements"
        subtitle="Confirm the jobs you were awarded, and run them through to delivery."
      />

      <ErrorBanner error={error ?? detailError ?? acknowledge.error} />

      {isLoading ? (
        <p className="py-10 text-center text-sm text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyQueue
          title="Nothing to acknowledge"
          hint="A shipment lands here the moment the logistics desk awards it to you."
        />
      ) : (
        <div className="space-y-3">
          {/* The awarded shipments. One card each, and the chosen one carries the form
              — the answer belongs under the job it is about, not on a second screen. */}
          {rows.map((row) => (
            <Card key={row.id} className="p-0">
              <button
                type="button"
                onClick={() => choose(row.id === chosenId ? 0 : row.id)}
                className={`w-full p-4 text-left transition ${
                  row.id === chosenId ? "bg-brand/5" : "hover:bg-surface-2"
                }`}
                aria-expanded={row.id === chosenId}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="font-mono text-xs font-semibold text-ink">
                    {row.tr_no}
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Travel row={row} />
                    <StatusPill status={row.status} />
                  </div>
                </div>
                <p className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-emerald-600">
                  <Handshake className="h-3.5 w-3.5" aria-hidden />
                  You won this shipment
                  {row.freight_amount ? ` at ${money(row.freight_amount)}` : ""}
                </p>
                <Lane row={row} />
              </button>

              {row.id === chosenId && (
                <div className="border-t border-line/70 p-4">
                  <JobDetails row={row} detail={detail} />

                  <h2 className="font-display text-base font-bold text-ink">
                    What is coming for it
                  </h2>
                  <p className="mb-3 text-xs text-muted">
                    The vehicle and the driver are what the gate is expecting; the LR or
                    docket is what the receiving site tracks it on. Give either the LR
                    number or the {docketLabel}; one is enough.
                  </p>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Driver name" required>
                      <Input value={form.driver_name}
                        onChange={(e) => setForm({ ...form, driver_name: e.target.value })} />
                    </Field>
                    <Field label="Vehicle number" required>
                      <Input value={form.vehicle_number}
                        onChange={(e) => setForm({
                          ...form, vehicle_number: e.target.value,
                        })} />
                    </Field>
                    <Field label="Phone number" required
                      hint={phoneError(form.driver_phone, "Phone") ?? PHONE_HINT}>
                      <Input value={form.driver_phone} inputMode="numeric" maxLength={18}
                        onChange={(e) => setForm({
                          ...form, driver_phone: sanitizePhone(e.target.value),
                        })} />
                    </Field>
                    <Field label="Licence number" hint="Optional.">
                      <Input value={form.driver_licence_no}
                        onChange={(e) => setForm({
                          ...form, driver_licence_no: e.target.value,
                        })} />
                    </Field>
                    <Field
                      label="LR number"
                      hint={`This or the ${docketLabel} is required.`}
                      required={missingTrackingHandle}
                    >
                      <Input value={form.lr_no}
                        onChange={(e) => setForm({ ...form, lr_no: e.target.value })} />
                    </Field>
                    <Field
                      label={courierNeedsTracking ? "Courier docket number" : "Docket number"}
                      hint="This or the LR number is required."
                      required={missingTrackingHandle}
                    >
                      <Input value={form.docket_no}
                        onChange={(e) => setForm({ ...form, docket_no: e.target.value })} />
                    </Field>
                    <Field label="Tracking link"
                      hint="Optional. Your own tracking page, shown to the site.">
                      <Input value={form.tracking_url}
                        onChange={(e) => setForm({
                          ...form, tracking_url: e.target.value,
                        })} />
                    </Field>
                    <Field label="E-way bill no" hint="Optional.">
                      <Input value={form.eway_bill_no}
                        onChange={(e) => setForm({
                          ...form, eway_bill_no: e.target.value,
                        })} />
                    </Field>
                    <Field label="Your booking reference" hint="Optional.">
                      <Input value={form.carrier_reference}
                        onChange={(e) => setForm({
                          ...form, carrier_reference: e.target.value,
                        })} />
                    </Field>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <Button onClick={() => acknowledge.mutate()} disabled={blocked}>
                      {acknowledge.isPending ? "Sending…" : "Acknowledge the job"}
                    </Button>
                    {/* Why the press is held back, said before it is pressed. */}
                    {missing.length > 0 && (
                      <span className="text-xs text-muted">
                        Fill in the {missing.map((key) => (
                          REQUIRED_LABELS[key]
                        )).join(" and the ")}.
                      </span>
                    )}
                    {missingTrackingHandle && (
                      <span className="text-xs text-muted">
                        Fill in either the LR number or the {docketLabel}.
                      </span>
                    )}
                    {badValues.map((message) => (
                      <span key={message} className="text-xs text-danger">{message}</span>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {(confirmed?.items?.length ?? 0) > 0 && (
        <div className="mt-8">
          <h2 className="mb-2 flex items-center gap-2 font-display text-lg font-bold text-ink">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
            Jobs you have taken
          </h2>
          <ul className="space-y-2">
            {confirmed!.items.map((row) => (
              <li key={row.id}>
                {/* The whole row is the press: past the yes, the LR and the delivery
                    report are given on the job screen, and this is the only list the
                    job is on. */}
                <button
                  type="button"
                  onClick={() => nav(`/carrier/jobs/${row.id}`)}
                  className="w-full rounded-xl border border-line bg-content1 p-4 text-left transition hover:border-brand/40 hover:bg-surface-2"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="font-mono text-xs font-semibold text-ink">
                      {row.tr_no}
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Travel row={row} />
                      <StatusPill status={row.status} />
                    </div>
                  </div>
                  <Lane row={row} />
                  <p className="mt-1.5 text-xs text-muted">
                    {NEXT_STEP[row.status] ?? "Acknowledged"}
                    {row.lr_no || row.docket_no
                      ? ` · ${row.lr_no ?? row.docket_no}` : ""}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function JobDetails({ row, detail }: {
  row: TRListRow; detail?: TransportRequest;
}) {
  const facts: [string, string | number | null | undefined][] = [
    ["Shipment", row.tr_no],
    ["Consignment", detail?.consignment_no ?? row.consignment_no],
    ["Mode", carriageLabel(detail?.carriage_mode ?? row.carriage_mode)],
    ["Type", modeLabel(detail?.mode ?? row.mode)],
    ["From", detail?.from_warehouse_name ?? row.from_warehouse_name],
    ["To", detail?.to_location_name ?? row.to_location_name],
    ["Address", detail?.delivery_address],
    ["Contact", [detail?.contact_person, detail?.contact_phone].filter(Boolean).join(" · ")],
    ["Indent", detail?.indent_no],
    ["Project", detail?.project_name],
    ["Packages / weight", load(
      detail?.total_packages ?? row.total_packages,
      detail?.total_weight_kg ?? row.total_weight_kg,
    )],
    ["Items / quantity", detail
      ? `${detail.total_items} item(s) · ${detail.total_qty}`
      : `${row.total_items} item(s) · ${row.total_qty}`],
    ["Volume", detail ? `${detail.total_volume_cbm} cbm` : null],
    ["Expected delivery", detail?.expected_delivery ?? row.expected_delivery
      ? fmtDate(detail?.expected_delivery ?? row.expected_delivery) : null],
    ["Gate pass", detail?.gate_pass_no],
    ["Remarks", detail?.remarks],
  ];

  return (
    <section className="mb-5 rounded-xl border border-line/70 bg-content2/30 p-4">
      <h2 className="font-display text-base font-bold text-ink">Shipment details</h2>
      <p className="mb-3 text-xs text-muted">
        The complete dispatch data sent by the logistics desk.
      </p>
      <dl className="grid gap-x-5 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        {facts.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted">
              {label}
            </dt>
            <dd className="truncate text-sm font-medium text-ink">{value || "—"}</dd>
          </div>
        ))}
      </dl>

      {/* The same manifest panel as the desk and the job sheet. A carrier signing
        * for a load reads what is on it in the shape they have already read it in
        * twice — while pricing, and while collecting. */}
      {(detail?.items.length ?? 0) > 0 && (
        <ManifestTable className="mt-4" items={detail!.items} status={detail!.status} />
      )}
    </section>
  );
}

/** How this job travels, in two chips: what it goes ON, and what it was arranged as.
 *
 *  Both come off the shipment and both are the dispatch desk's: the carriage was
 *  settled before the tender went out and the award was priced against that lane, so
 *  it is read here, never offered. Shown, not asked. */
function Travel({ row }: { row: TRListRow }) {
  return (
    <>
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${carriageTint(row.carriage_mode)}`}>
        <span aria-hidden className="[&>svg]:h-3 [&>svg]:w-3">
          {CARRIAGE_ICON[(row.carriage_mode ?? "ROAD") as CarriageMode]}
        </span>
        {carriageLabel(row.carriage_mode)}
      </span>
      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${modeTint(row.mode)}`}>
        {modeLabel(row.mode)}
      </span>
    </>
  );
}

/** Where it goes and what it weighs — the same three facts the shipments board leads
 *  with, so a job reads the same on both screens. */
function Lane({ row }: { row: TRListRow }) {
  return (
    <>
      <div className="mt-2 flex items-center gap-2 text-sm">
        <span className="truncate text-muted">{row.from_warehouse_name ?? "Warehouse"}</span>
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
        <span className="truncate font-medium text-ink">
          {row.to_location_name ?? "Destination"}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span>{load(row.total_packages, row.total_weight_kg)}</span>
        {row.expected_delivery && (
          <span>needed by {fmtDate(row.expected_delivery)}</span>
        )}
      </div>
    </>
  );
}
