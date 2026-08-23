import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowLeft, ArrowRight, Boxes, CalendarDays, CheckCircle2, FileDown,
  FileText, Handshake, IdCard, MapPin, Package, Paperclip, Printer, Sparkles, Truck,
  Upload, Warehouse, X,
} from "lucide-react";
import {
  Button, Can, Card, ErrorBanner, Field, Input, PageHeader, Select, StatusPill,
  useAction,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { consignmentApi, transportApi } from "../api";
import {
  headerFromConsignment, linesFromConsignment,
} from "../components/consignmentToLines";
import {
  carriageLabel, carriageTint, load, modeLabel, modeTint,
} from "../components/modeCopy";
import {
  CARRYING_LABEL, carryingFields, carryingValue,
} from "../components/gatePassFields";
import type { CarryingField } from "../components/gatePassFields";
import { OptionTiles } from "../components/OptionTiles";
import { CARRIAGE_ICON, MODE_ICON } from "../components/transportIcons";
import {
  phoneError, PHONE_HINT, problems, sanitizePhone,
} from "../components/validate";
import type {
  CarriageMode, CarriageRule, Consignment, DispatchInput, ModeRule,
  TransportMode, TransportRequest,
} from "../transportTypes";

const BLANK = {
  vehicle_number: "", driver_name: "",
  // What a provider leg records instead of a price: the licence behind the wheel,
  // beside the vehicle and the name above. A courier is booked at a published rate
  // and a tender is priced by the carriers, so there is no amount for the desk to
  // agree — but a load handed over with only a company name against it is a load
  // nobody can chase.
  driver_licence_no: "",
  // The other job the vehicle was already doing — the whole reason an own-vehicle leg
  // costs the shipment nothing. Asked here as well as on the manual form, so a
  // one-press dispatch does not lose it.
  driver_phone: "", trip_reference: "",
  handed_over_by_name: "",
  // Who took custody, pinned to a person: an employee by their employee id, anybody
  // else by an Aadhaar. A name on its own identifies nobody when the load is chased.
  handed_over_employee_id: "", handed_over_aadhaar: "", handed_over_phone: "",
  // The handle the receiving site chases the load with, and there are TWO of them
  // because they are two different papers: a hired truck travels on a consignment
  // note (the LR), a courier parcel on a docket. The service keeps both columns and
  // releases on either — this screen used to offer one box called "Docket / LR" that
  // only ever wrote the docket, so an LR could not be recorded on the press that
  // books the leg and had to be typed on the shipment screen afterwards.
  lr_no: "", docket_no: "", tracking_url: "", eway_bill_no: "",
  carrier_reference: "",
};

/** The paperwork a leg physically leaves with, on the two modes that leave with an
 *  outside carrier's driver or one of ours: the way bill it moves on, and the delivery
 *  challan the receiving site signs against the load. The categories are the
 *  backend's (`transport.TR_DOC_CATEGORIES`) — `sys_attachments` is shared by every
 *  module, and a category invented in a screen is how a panel that filters on one
 *  stops finding what another wrote. */
const TRANSPORT_DOCS = [
  {
    category: "WAY_BILL",
    label: "Way bill",
    button: "Upload way bill",
    hint: "PDF or a photo.",
  },
  {
    category: "DELIVERY_CHALLAN",
    label: "Delivery challan (DC)",
    button: "Upload DC",
    hint: "Comes back signed.",
  },
];

/** What a BOOKED leg leaves with instead. A courier takes the parcel at a published
 *  rate and hands back the counter slip — no way bill of ours and no challan to sign,
 *  so the receipt is the one paper that moment produces. */
const COURIER_DOCS = [
  {
    category: "COURIER_RECEIPT",
    label: "Courier receipt",
    button: "Upload receipt",
    hint: "The counter slip. PDF or a photo.",
  },
];

/** What the desk is asked to type, by the name the service checks it under. Read only
 *  to say WHICH field is still blank when the press is held back — the list of what a
 *  mode requires is the backend's (`/api/transport/modes`), never this screen's. */
const FIELD_LABELS: Record<string, string> = {
  carrier_id: "a provider",
  vehicle_number: "the vehicle number",
  driver_name: "the driver",
  handed_over_by_name: "who hands it over",
  handed_over_employee_id: "their employee id",
  handed_over_aadhaar: "their Aadhaar number",
  handed_over_phone: "a phone number",
  lr_no: "the LR number",
  docket_no: "the docket number",
  // Not a field on the form — the service releases on EITHER paper, so the press is
  // held back for the pair rather than for whichever box happens to be empty.
  tracking_handle: "the LR or the docket number",
};

/** The key `missing` carries when neither tracking paper has been written. Its own
 *  name because it is a rule about two fields, not a field. */
/** Who is carrying it. One of ours or somebody else — the only thing that changes is
 *  which number identifies them, because an outsider has no employee id. */
const HANDOVER_PERSONS = [
  { value: "EMPLOYEE", label: "Employee" },
  { value: "OTHERS", label: "Others" },
];

/** Twelve digits, never starting 0 or 1 — UIDAI issues neither. Local to this screen
 *  rather than in `validate.ts`: this is the only box an Aadhaar is typed into. */
const aadhaarError = (value: string): string | null => {
  const digits = value.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length !== 12) return "Aadhaar must be 12 digits";
  if (/^[01]/.test(digits)) return "Aadhaar does not start with 0 or 1";
  return null;
};

/** HOW the load physically travels — a separate question from WHO moves it, and one
 *  the shipment now REMEMBERS. Both the four carriages and which arrangements each of
 *  them allows come from `/api/transport/carriage-modes`; this screen used to hold its
 *  own copy of that table, which is a rule with two values the day somebody starts
 *  shipping by barge. Only the icons are local, and those are decoration. */
const CARRIAGE_FALLBACK: CarriageMode[] = ["ROAD", "RAIL", "AIR", "SEA"];

/** How often this screen re-asks what happened to a consignment it has already sent.
 *
 *  The same ten seconds the Dispatch queue polls on, and for the same reason: the next
 *  thing that happens to this shipment does not happen in this tab. The awarded carrier
 *  acknowledges it in their own portal — filling in the vehicle, the
 *  driver and the LR — and a desk still standing on this page would otherwise read
 *  "awaiting the provider" until somebody thought to reload. */
const LIVE_MS = 10_000;

/** The first sentence of a mode's caption, for its tile.
 *
 *  The wording is the catalogue's (`/api/transport/modes`) and stays there — this
 *  only holds a tile to one line. Four tiles of three sentences each is a paragraph,
 *  and a paragraph is not what a desk reads before pressing one of them. */
const oneLine = (help?: string) =>
  (help ?? "").match(/^[^.]*\./)?.[0] ?? (help ?? "");

const destinationOf = (row?: Consignment | null) =>
  row?.destination_office_name
  ?? row?.to_warehouse_name
  ?? row?.customer_name
  ?? row?.delivery_address
  ?? "—";

/** The transport leg this consignment travels on, flattened from whichever source
 *  knows about it: the live link the queue polls, or the answer to the press that
 *  raised it a second ago. One shape, so the panel below never has to ask which. */
interface Outcome {
  tr_id: number;
  tr_no: string;
  status: string;
  mode: string;
  carriage_mode?: string | null;
  consignment_no?: string | null;
  carrier_name?: string | null;
  vehicle_number?: string | null;
  driver_name?: string | null;
  lr_no?: string | null;
}

/** Where the leg has GOT to, said in the words of this screen rather than as a status
 *  code. Keyed on the status because that is the durable fact — "you just pressed the
 *  button" is not, and a panel that can only describe itself in the seconds after a
 *  press is a panel that goes blank on the first reload. */
const OUTCOME_HEADLINE: Record<string, string> = {
  DRAFT: "Raised, not sent yet",
  PENDING_APPROVAL: "Waiting for approval",
  QUOTING: "Out to the providers for a price",
  AWAITING_CARRIER: "Awarded — waiting for the carrier to confirm",
  READY: "Ready to leave",
  IN_TRANSIT: "On its way",
  DELIVERED: "Delivered — waiting for the site to sign",
  ACKNOWLEDGED: "Signed for by the site",
  CLOSED: "Closed",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};

/**
 * The gate pass, on screen: what the press produced, laid out as the paper it stands
 * for — the pass number and the date at the top, the two parties, the load, and who is
 * carrying it.
 *
 * Dispatch is one decision, so it gets one screen and it ends on it. The desk chose the
 * mode and the providers; the providers answer in their own portal; the winner is
 * awarded; and the vehicle, the driver and the LR that come back are read HERE, off the
 * same live link the queue reads. Nothing on this panel is typed by anybody on our
 * side, which is the point: the transport details are entered once, by the party that
 * actually knows them, and every other screen reads them.
 *
 * It shows only the fields the chosen MODE actually records (`carryingFields`). A pass
 * is read at a barrier by somebody with the load already on the weighbridge, so every
 * line on it has to be a line that can be checked against the vehicle in front of them
 * — an LR number on a hand-over and an employee id on a courier parcel are ten dashes
 * to read past on the way to the two lines that matter.
 */
function DispatchOutcome({
  leg, doc, rule, justSent, providers, onAnother,
}: {
  leg: Outcome;
  /** The shipment itself, once it has been read back. Every field on the pass comes
   *  from here: what this desk answered on the form and what the carrier answered in
   *  their own portal are the same document, and the panel does not care which half
   *  filled in which. Absent for the moment between the press and the read. */
  doc?: TransportRequest | null;
  /** The mode's own rule, as served — what decides which lines the pass carries.
   *  Undefined only while the mode table is in flight, and then every field shows. */
  rule?: ModeRule | null;
  /** True only for the press that raised it. Changes the wording, nothing else — the
   *  panel itself is the same whether you pressed a second ago or opened the link
   *  tomorrow, which is what makes it survive a reload. */
  justSent: boolean;
  /** How many were asked for a price. Only meaningful on the press that asked. */
  providers: number;
  onAnother: () => void;
}) {
  const tendered = leg.status === "QUOTING";
  const providerPending = leg.status === "AWAITING_CARRIER";
  const gatePassNo = doc?.gate_pass_no || `GP/${leg.consignment_no ?? leg.tr_no}`;
  const headline = justSent && tendered
    ? `Sent to ${providers} provider${providers === 1 ? "" : "s"} for a price`
    : OUTCOME_HEADLINE[leg.status] ?? "Dispatched";
  const note = providerPending
    ? "The provider confirms in their own login. Their details land here."
    : leg.status === "READY"
      ? "Confirmed. Continue the shipment when it leaves the gate."
      : tendered
        ? "They price it in their portal. Award the winner on Provider Selection."
        : "The load has left. The receiving site signs for it.";

  // The pass, in a new tab: dispatch ends on THIS screen, and a print view that
  // replaced it would take the desk off the shipment it is still watching.
  const sheet = (save: boolean) => window.open(
    `/logistics/shipments/${leg.tr_id}/gate-pass${save ? "?save=1" : ""}`,
    "_blank", "noopener");

  // Only what this mode records, and only ever one half of the identity pair. The
  // press itself answers some of these and the far side answers the rest; both are
  // read the same way.
  const carrying = carryingFields(rule, doc).map((field) => ({
    field, label: CARRYING_LABEL[field], value: carriedValue(field, doc, leg),
  }));
  const anyAnswered = carrying.some((row) => Boolean(row.value));
  const priced = doc?.quotes.filter((q) => q.freight_amount != null).length ?? 0;
  const contact = [doc?.contact_person, doc?.contact_phone].filter(Boolean).join(" · ");

  return (
    <Card className="overflow-hidden p-0">
      {/* The head of the pass. The number is the biggest thing on it because it is
          what gets read out at the barrier and written into the gate register. */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-ink/20 px-5 py-4">
        <div className="min-w-0">
          <p className={PASS_LABEL}>Gate pass</p>
          <p className="mono mt-1 truncate text-lg font-bold leading-tight text-ink">
            {gatePassNo}
          </p>
          <p className="mt-1 text-xs text-muted">
            Issued {fmtDate(doc?.tr_date ?? doc?.created_at)}
            {doc?.requested_by_name ? ` · ${doc.requested_by_name}` : ""}
          </p>
        </div>
        {/* How it travels and with whom — kept on the pass, where the guard checks it
            against the vehicle at the gate. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${carriageTint(doc?.carriage_mode ?? leg.carriage_mode)}`}>
            {carriageLabel(doc?.carriage_mode ?? leg.carriage_mode)}
          </span>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${modeTint(doc?.mode ?? leg.mode)}`}>
            {modeLabel(doc?.mode ?? leg.mode)}
          </span>
          <StatusPill status={leg.status} />
        </div>
      </div>

      {/* Where it has got to, in one line, and what happens next. */}
      <div className="flex items-start gap-2.5 border-b border-line/70 bg-ok-bg/60 px-5 py-3">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-tight text-ink">{headline}</p>
          <p className="mt-0.5 text-xs leading-snug text-muted">{note}</p>
        </div>
      </div>

      {/* The papers this one pass answers for. A gate pass with no consignment number
          on it cannot be checked against the packing list. */}
      <div className="grid divide-y divide-line/70 border-b border-line/70 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <PassRef label="Consignment" value={leg.consignment_no} />
        <PassRef label="Shipment" value={leg.tr_no} />
        <PassRef label="Indent" value={doc?.indent_no} />
      </div>

      {/* The two parties. */}
      <div className="grid items-start gap-4 border-b border-line/70 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <div className="min-w-0">
          <p className={PASS_LABEL}>From</p>
          <p className="mt-1 text-sm font-semibold text-ink">
            {doc?.from_warehouse_name || "—"}
          </p>
        </div>
        <ArrowRight className="mt-6 hidden h-4 w-4 shrink-0 text-muted sm:block" aria-hidden />
        <div className="min-w-0">
          <p className={PASS_LABEL}>To</p>
          <p className="mt-1 text-sm font-semibold text-ink">
            {doc?.to_location_name || "—"}
          </p>
          {doc?.delivery_address && (
            <p className="mt-0.5 text-xs leading-snug text-muted">{doc.delivery_address}</p>
          )}
          {contact && <p className="mt-0.5 text-xs text-muted">{contact}</p>}
        </div>
      </div>

      {/* What is on the vehicle, counted the way the packing list counts it. */}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line/70 px-5 py-3">
        <p className={PASS_LABEL}>The load</p>
        <p className="text-sm font-semibold text-ink">
          {doc ? load(doc.total_packages, doc.total_weight_kg) : "—"}
        </p>
        {doc && (
          <p className="text-xs text-muted">
            {doc.total_items} item{doc.total_items === 1 ? "" : "s"} · qty {doc.total_qty}
          </p>
        )}
        {doc?.project_name && <p className="text-xs text-muted">{doc.project_name}</p>}
      </div>

      <div className="px-5 py-4">
        <p className={PASS_LABEL}>Who is carrying it</p>
        {anyAnswered ? (
          // Every line this mode records, blanks included: a vehicle number nobody has
          // filled in is information at the barrier — it says the load should not go
          // out on one yet.
          <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {carrying.map((row) => (
              <div key={row.field} className="flex items-baseline gap-2">
                <dt className="shrink-0 text-xs text-muted">{row.label}</dt>
                <dd className="min-w-0 truncate text-sm font-medium text-ink">
                  {row.value || "—"}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="mt-1.5 text-xs leading-snug text-muted">
            Fills in when the provider answers.
          </p>
        )}

        {/* What the tender has come back with, as a count. The prices themselves, and
            the award, belong to Provider Selection — linked below rather than copied
            onto the pass. */}
        {doc?.quotes.length ? (
          <p className="mt-3 text-xs text-muted">
            {doc.quotes.length} provider{doc.quotes.length === 1 ? "" : "s"} asked ·{" "}
            {priced} priced so far.
          </p>
        ) : null}

        {doc?.remarks && (
          <p className="mt-3 text-xs leading-snug text-muted">
            <span className="font-semibold">Remarks</span> · {doc.remarks}
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2 border-t border-line/70 pt-4">
          {/* The paper the load leaves with. Both buttons open the same sheet — the
              browser's own dialog is the PDF writer, which is how the purchase order
              has always printed, so there is no second renderer to keep in step. */}
          <Button variant="soft" onClick={() => sheet(false)}>
            <Printer className="h-4 w-4" /> Print gate pass
          </Button>
          <Button variant="soft" onClick={() => sheet(true)}>
            <FileDown className="h-4 w-4" /> Download PDF
          </Button>
          {/* The pass is the end of this desk's press. Where the shipment goes next —
              the tender on Provider Selection, the leg on Shipments — is
              reached from the tabs above, not from a link on the paper. */}
          <Button variant="ghost" onClick={onAnother}>
            <Truck className="h-4 w-4" /> Dispatch another
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** The small-caps label every block on the pass is headed with. */
const PASS_LABEL = "text-[10px] font-semibold uppercase tracking-wider text-muted";

/** One document number off the pass, big enough to read out over a phone. */
function PassRef({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="px-5 py-3">
      <p className={PASS_LABEL}>{label}</p>
      <p className="mono mt-0.5 truncate text-sm font-semibold text-ink">{value || "—"}</p>
    </div>
  );
}

/** What a carried field READS as. The two sources are the same document — `doc` is the
 *  shipment read back in full, `leg` the flattened link the queue already had — so the
 *  fuller one wins and the other stands in for the second it takes to arrive. */
function carriedValue(
  field: CarryingField, doc?: TransportRequest | null, leg?: Outcome,
): string | null {
  const own = carryingValue(field, doc);
  if (own) return own;
  switch (field) {
    case "carrier_name": return leg?.carrier_name ?? null;
    case "vehicle_number": return leg?.vehicle_number ?? null;
    case "driver_name": return leg?.driver_name ?? null;
    case "lr_no": return leg?.lr_no ?? null;
    default: return null;
  }
}


/** One numbered stage of the form. The screen asks three questions in a fixed order —
 *  which load, how it travels, who has it — and numbering them is what turns a page of
 *  eighteen boxes into three short decisions. */
function Step({
  n, title, subtitle, children,
}: { n: number; title: string; subtitle?: string; children: ReactNode }) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-start gap-3 border-b border-line/70 bg-content2/40 px-5 py-3.5">
        <span
          className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-[11px] font-bold text-white"
          aria-hidden
        >
          {n}
        </span>
        <div className="min-w-0">
          <h2 className="font-display text-[15px] font-bold leading-tight text-ink">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs leading-snug text-muted">{subtitle}</p>}
        </div>
      </div>
      <div className="p-5">{children}</div>
    </Card>
  );
}

/** A heading inside a step, so the details below it read as one subject — the provider,
 *  the vehicle, the tracking numbers — instead of a run of unrelated boxes. */
function Group({
  icon, title, hint, first = false,
}: { icon: ReactNode; title: string; hint?: string; first?: boolean }) {
  return (
    <div
      className={`col-span-full flex flex-wrap items-baseline gap-x-2 ${
        first ? "" : "mt-3 border-t border-line/70 pt-4"
      }`}
    >
      <span className="flex items-center gap-1.5 text-brand" aria-hidden>{icon}</span>
      <h3 className="text-[13px] font-bold uppercase tracking-wide text-ink-700">{title}</h3>
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}

/** One paper, picked but not yet posted. Shaped like a `Field` rather than built with
 *  one on purpose: `Field` wraps its children in a `<label>`, and a label holding a
 *  hidden file input opens the picker a second time when the button inside it is
 *  clicked. The file is HELD until the shipment exists — there is nothing to file it
 *  against until the press below raises the transport request. */
function DocPicker({
  label, button, hint, chosen, onChoose, onClear,
}: {
  label: string; button: string; hint: string; chosen: File | null;
  onChoose: (file: File) => void; onClear: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium text-body">{label}</span>
      <input
        ref={input}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onChoose(file);
          // Clearing the input is what lets the same file be picked again after it
          // was removed, or after an upload failed.
          event.target.value = "";
        }}
      />
      {chosen ? (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-line/70 bg-content2/40 px-3 py-2">
          <span className="flex min-w-0 items-center gap-2">
            <Paperclip className="h-4 w-4 shrink-0 text-muted" aria-hidden />
            <span className="truncate text-sm font-medium text-ink">{chosen.name}</span>
            <span className="shrink-0 text-xs text-muted">
              {Math.max(1, Math.round(chosen.size / 1024))} KB
            </span>
          </span>
          <button
            type="button"
            aria-label={`Remove ${chosen.name}`}
            className="shrink-0 text-muted hover:text-danger"
            onClick={onClear}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <Button variant="subtle" onClick={() => input.current?.click()}>
          <Upload className="h-4 w-4" /> {button}
        </Button>
      )}
      <span className="mt-1 block text-xs text-muted">{hint}</span>
    </div>
  );
}

/** One fact about the consignment, in the summary rail. */
function Fact({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 text-muted" aria-hidden>{icon}</span>
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
        <div className="truncate text-sm font-medium text-body">{value}</div>
      </div>
    </div>
  );
}

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
 * LAID OUT as three numbered decisions beside a summary rail, which is presentation
 * only — every field, rule and press below is the one that was here before. The flat
 * version put eighteen boxes and their prose captions in one column, so the two
 * questions that actually decide the dispatch (which load, and how it travels) looked
 * exactly like the twelve that follow from them, and whether the button could be
 * pressed yet was a sentence at the bottom of the page. The rail carries the load, the
 * choice and the reason the press is held back, and stays put while the form is filled.
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
  const [carriage, setCarriage] = useState<CarriageMode>("ROAD");
  // Road, handed over: the plainest leg there is, and the one the desk changes
  // FROM rather than the one it lands on by accident.
  const [mode, setMode] = useState<TransportMode>("DIRECT");
  const [form, setForm] = useState({ ...BLANK });
  const [handoverPerson, setHandoverPerson] = useState("EMPLOYEE");
  // One list for both cases. A booking names one provider and a tender names several,
  // but "who is this going to" is one answer either way, and keeping a separate
  // singular field beside it is how the two quietly disagree about who was chosen.
  const [carrierIds, setCarrierIds] = useState<number[]>([]);
  // The way bill and the delivery challan, held by category until the press below
  // raises the shipment they are filed against. Nothing to attach them to before that.
  const [papers, setPapers] = useState<Record<string, File | null>>({});
  // Which of them the upload refused, read by the toast: a file that will not go up
  // must not cost the dispatch that already happened.
  const rejectedPapers = useRef<string[]>([]);
  // Both presses save the same editable form. This flag only decides whether the
  // successful save stays on the form or opens the generated gate-pass view.
  const revealGatePassAfterSave = useRef(false);
  // The shipment this press just raised. Held for the gate-pass view, which stays on
  // this screen; every other press navigates on. See `onDone`.
  const [sent, setSent] = useState<TransportRequest | null>(null);
  // Opening Dispatch always starts on the form/review screen. The completed gate-pass
  // view is intentionally revealed only by the explicit action below.
  const [showGatePass, setShowGatePass] = useState(false);

  const id = Number(consignmentId || 0);

  // Only packed consignments: nothing else is a thing that can be sent anywhere.
  const { data: ready, isLoading } = useQuery({
    queryKey: ["lgs-packed-consignments"],
    queryFn: () => consignmentApi.list({ status: "PACKED", size: 100 }),
  });
  const { data: modes } = useQuery({
    queryKey: ["transport-modes"], queryFn: transportApi.modes,
  });
  // Which carriages exist, and what can be arranged under each. The backend's table,
  // not this screen's — see CARRIAGE_FALLBACK above.
  const { data: carriages } = useQuery({
    queryKey: ["transport-carriage-modes"], queryFn: transportApi.carriageModes,
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
    // Polled so the carrier's answer LANDS here rather than waiting for a reload, and
    // refetched on focus for the same reason: the desk that just rang the carrier
    // comes back to this tab to see whether they answered. See LIVE_MS.
    refetchInterval: LIVE_MS,
    refetchOnWindowFocus: true,
  });
  const already = links?.[0];

  const carriageRule: CarriageRule | undefined = useMemo(
    () => carriages?.find((row) => row.value === carriage), [carriages, carriage],
  );
  // Nothing is narrowed until the table has arrived: filtering against a catalogue
  // that has not loaded yet would draw the arrangement step with no tiles on it.
  const typeAllowed = (value: TransportMode) =>
    !carriageRule || carriageRule.allowed_modes.includes(value);

  // Everything below the type is type-specific, the provider set included: three
  // carriers chosen for a tender are not three couriers, and carrying them across
  // would send a booking to a provider nobody picked for it. One helper, because the
  // type is now changed from three places — the picker, the suggestion, and a
  // carriage mode that no longer allows what was picked.
  const chooseType = (next: TransportMode) => {
    setMode(next);
    setForm({ ...BLANK });
    setCarrierIds([]);
    setPapers({});
    setHandoverPerson("EMPLOYEE");
  };

  const rule: ModeRule | undefined = useMemo(
    () => modes?.find((m) => m.value === mode), [modes, mode],
  );
  const needs = (field: string) => rule?.required_fields.includes(field) ?? false;
  // A human takes the load on two modes: a direct hand-over, and an own vehicle whose
  // driver it travels with. The question is the same one both times — is this one of
  // ours, and what number identifies them — so it is asked once, here.
  const asksPerson = needs("handed_over_by_name") || needs("vehicle_number");
  // `carriers` is undefined while it loads; only an empty ARRAY means the register is
  // actually empty, so the pointer to Settings never flashes on a slow connection.
  const noPartners = Array.isArray(carriers) && carriers.length === 0;

  const chosen = (ready?.items ?? []).find((row) => row.id === id) ?? doc ?? null;

  /** The leg this consignment already travels on, if it travels on one.
   *
   *  Read from the SERVER first and from the press only as a stand-in for the second
   *  it takes the refetch to land. That ordering is the whole point: `sent` is React
   *  state and React state does not survive a reload — and this page gets reloaded
   *  plenty (the dev server alone was doing it 21 times a session). Keyed on the
   *  consignment having a transport leg, the outcome is the same thing whether you
   *  pressed the button a second ago, refreshed, or opened the link tomorrow.
   */
  const outcome: Outcome | null = useMemo(() => {
    if (already) {
      return {
        tr_id: already.tr_id, tr_no: already.tr_no, status: already.status,
        mode: already.mode, carriage_mode: already.carriage_mode,
        // The link points at the consignment by id; its NUMBER is on the consignment
        // itself, which this page is already holding.
        consignment_no: chosen?.dispatch_no ?? null,
        carrier_name: already.carrier_name,
        vehicle_number: already.vehicle_number,
        driver_name: already.driver_name,
        lr_no: already.lr_no,
      };
    }
    if (sent) {
      return {
        tr_id: sent.id, tr_no: sent.tr_no, status: sent.status,
        mode: sent.mode, carriage_mode: sent.carriage_mode,
        consignment_no: sent.consignment_no,
        carrier_name: sent.carrier_name,
        vehicle_number: sent.vehicle_number,
        driver_name: sent.driver_name,
        lr_no: sent.lr_no ?? sent.docket_no,
      };
    }
    return null;
  }, [already, sent, chosen]);

  /** The mode rule the PASS is drawn from — the shipment's own mode, never the
   *  picker's. They agree the moment the button is pressed and part company on the
   *  next reload, where the picker is back on its default and the shipment is
   *  whatever it was dispatched as. Which fields a pass carries is a fact about the
   *  shipment. */
  const outcomeRule: ModeRule | undefined = useMemo(
    () => modes?.find((m) => m.value === (outcome?.mode ?? mode)),
    [modes, outcome, mode],
  );

  /** The shipment itself, once there is one.
   *
   *  The panel above needs more than the queue's link carries: the gate pass number,
   *  the lane, the load and every box the carrier fills in from their own portal when
   *  they acknowledge the job. Polled on the same ten seconds as the link, because
   *  that acknowledgement does not happen in this tab — a courier or a third party
   *  answers in theirs, and this screen is where the answer is READ. The two we drive
   *  ourselves were answered on the form and come straight back the same way.
   */
  const { data: shipment } = useQuery({
    queryKey: ["transport", String(outcome?.tr_id ?? "")],
    queryFn: () => transportApi.get(outcome!.tr_id),
    enabled: Boolean(outcome?.tr_id),
    refetchInterval: LIVE_MS,
    refetchOnWindowFocus: true,
  });
  const hydratedTransport = useRef<string | null>(null);
  useEffect(() => {
    if (!shipment) return;
    // A provider acknowledgement updates this same request id. Keying only by id
    // kept the blank fields blank forever; this signature changes when their answer
    // lands, while repeated polling of an unchanged request cannot overwrite edits.
    const signature = [
      shipment.id, shipment.status, shipment.mode, shipment.carriage_mode,
      shipment.carrier_id, shipment.vehicle_number, shipment.driver_name,
      shipment.driver_phone, shipment.driver_licence_no, shipment.lr_no,
      shipment.docket_no, shipment.tracking_url, shipment.eway_bill_no,
      shipment.carrier_reference,
    ].join("|");
    if (hydratedTransport.current === signature) return;
    hydratedTransport.current = signature;
    setMode(shipment.mode);
    setCarriage((shipment.carriage_mode ?? "ROAD") as CarriageMode);
    setGatePass(shipment.gate_pass_no ?? "");
    setCarrierIds(shipment.quotes.length
      ? shipment.quotes.map((quote) => quote.carrier_id)
      : shipment.carrier_id ? [shipment.carrier_id] : []);
    setHandoverPerson(shipment.handed_over_aadhaar ? "OTHERS" : "EMPLOYEE");
    setForm({
      vehicle_number: shipment.vehicle_number ?? "",
      driver_name: shipment.driver_name ?? "",
      driver_licence_no: shipment.driver_licence_no ?? "",
      driver_phone: shipment.driver_phone ?? "",
      trip_reference: shipment.trip_reference ?? "",
      handed_over_by_name: shipment.handed_over_by_name ?? "",
      handed_over_employee_id: shipment.handed_over_employee_id ?? "",
      handed_over_aadhaar: shipment.handed_over_aadhaar ?? "",
      handed_over_phone: shipment.handed_over_phone ?? "",
      lr_no: shipment.lr_no ?? "",
      docket_no: shipment.docket_no ?? "",
      tracking_url: shipment.tracking_url ?? "",
      eway_bill_no: shipment.eway_bill_no ?? "",
      carrier_reference: shipment.carrier_reference ?? "",
    });
  }, [shipment]);

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
    // Released on this press, so the paper it travels with is needed on this press.
    // The service refuses a hired leg carrying NEITHER an LR nor a docket, and this is
    // that rule read forward — either one satisfies it, because a truck is given a
    // consignment note and a parcel is given a docket, and demanding the docket of a
    // truck was asking for a paper that leg never produces.
    // A hand-over records who took custody, and a name alone identifies nobody: the
    // id depends on which kind of person it is, and there has to be a number to ring
    // on the day. Same shape as the docket rule above — read forward off the mode.
    if (asksPerson) {
      const idField = handoverPerson === "EMPLOYEE"
        ? "handed_over_employee_id" : "handed_over_aadhaar";
      if (!form[idField].trim()) gaps.push(idField);
      // An own vehicle's driver is rung on the driver phone that mode already asks
      // for; only a hand-over carries a number of its own.
      if (needs("handed_over_by_name") && !form.handed_over_phone.trim()) {
        gaps.push("handed_over_phone");
      }
    }
    return gaps;
  }, [rule, form, carrierIds, handoverPerson]);

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
        // Both halves of "how does it travel". The carriage was asked on this screen
        // from the day it was built and thrown away on every press — a rail leg read
        // back as a plain third-party truck, and the carrier's portal could not tell
        // the winner which way the job was going.
        carriage_mode: carriage,
        lines: linesFromConsignment(detail),
        gate_pass_no: gatePass.trim() || `GP/${detail.dispatch_no}`,
        carrier_ids: carrierIds,
        evaluation_method: null,
        vehicle_number: form.vehicle_number || null,
        driver_name: form.driver_name || null,
        driver_phone: form.driver_phone || null,
        driver_licence_no: form.driver_licence_no || null,
        trip_reference: form.trip_reference || null,
        handed_over_by_name: form.handed_over_by_name || null,
        // Typed on this form since it was built and, until now, dropped on the way
        // out: a name with no number behind it identifies nobody once the load is
        // being chased.
        handed_over_employee_id: form.handed_over_employee_id || null,
        handed_over_aadhaar: form.handed_over_aadhaar || null,
        handed_over_phone: form.handed_over_phone || null,
        // Both papers go with the press. `lr_no` was accepted by the service all
        // along (it is on `TRCreate`) and simply never asked for here.
        lr_no: form.lr_no || null,
        docket_no: form.docket_no || null,
        tracking_url: form.tracking_url || null,
        eway_bill_no: form.eway_bill_no || null,
        carrier_reference: form.carrier_reference || null,
        // A settled mode leaves on this press. Everything the release checks is on
        // this form, so sending it to READY and asking for a second "it has left"
        // only delayed the moment the receiving site can sign for it — and the indent
        // behind it stayed open in the gap. A tender has no carrier yet, so it waits.
        // Courier and third-party providers complete the same acknowledgement fields
        // in their own login. Only hand-over and own vehicle are entered manually and
        // leave on this press.
        release_now: false,
      };
      const tr = outcome
        ? await transportApi.update(outcome.tr_id, body)
        : await transportApi.dispatchConsignment(body);

      // Posted only now: `sys_attachments` is keyed by document id, so the papers
      // could not be filed before there was a shipment. Each is tried on its own and
      // a refusal is REPORTED rather than thrown — the load has left, and failing the
      // whole press over a scan would say it had not.
      rejectedPapers.current = [];
      for (const doc of [...TRANSPORT_DOCS, ...COURIER_DOCS]) {
        const file = papers[doc.category];
        if (!file) continue;
        try {
          await transportApi.uploadDocument(tr.id, file, doc.category);
        } catch {
          rejectedPapers.current.push(doc.label.toLowerCase());
        }
      }
      return tr;
    },
    success: (tr) => {
      const sent = tr.status === "AWAITING_CARRIER"
        ? `${tr.tr_no} sent to ${tr.carrier_name ?? "the courier"} for acknowledgement`
        : tr.status === "QUOTING"
        ? `${tr.tr_no} sent to ${carrierIds.length} provider${carrierIds.length === 1 ? "" : "s"} for a price`
        : `${tr.tr_no} is ready for final dispatch in Shipments`;
      // Said plainly, because the shipment went either way and nobody would otherwise
      // know the paper did not.
      return rejectedPapers.current.length
        ? `${sent} — but the ${rejectedPapers.current.join(" and ")} could not be attached`
        : sent;
    },
    invalidates: [["lgs-dispatch-queue"], ["lgs-consignment-links"],
      ["lgs-packed-consignments"], ["transport"], ["transport-summary"],
      ["transport-provider-board"]],
    // Where the press LANDS the desk, read off the shipment's own status rather than
    // off the picker: the mode decides who answers next, and the desk should be
    // standing where that answer arrives instead of hunting for the screen.
    //
    //   * QUOTING / AWAITING_CARRIER — somebody outside has been asked (a tender's
    //     providers, or the courier) and Provider Selection is where their answer is
    //     read and the award is made. `?tr=` opens this shipment on arrival.
    //   * everything else — a hand-over or an own vehicle hires nobody, so there is
    //     no answer to wait for and the leg is now just a document: Transport
    //     Requests.
    //
    // Nothing is retyped on either — the screen it lands on already holds what this
    // press wrote, and coming BACK to this one re-reads the leg off the live link
    // (see `outcome`), so the dispatch reads exactly as it does today.
    //
    // Generate gate pass is the exception: it asked to stay and see the pass, so it
    // does.
    onDone: (tr) => {
      setSent(tr);
      setShowGatePass(revealGatePassAfterSave.current);
      const stay = revealGatePassAfterSave.current;
      revealGatePassAfterSave.current = false;
      if (stay) {
        // Keep the review form visible; Generate gate pass reveals the outcome next.
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      nav(tr.status === "QUOTING" || tr.status === "AWAITING_CARRIER"
        ? `/logistics/providers?tr=${tr.id}`
        : `/logistics/shipments/${tr.id}`);
    },
  });

  const press = (showGatePass: boolean) => {
    revealGatePassAfterSave.current = showGatePass;
    send.mutate();
  };

  /** Values that are WRONG rather than merely absent. `missing` says what has not been
   *  answered; this says what has been answered badly, and either one holds the press.
   *  The service checks all of it again — this only saves the round trip. */
  const badValues = problems(
    phoneError(form.driver_phone, "Driver phone"),
    phoneError(form.handed_over_phone, "Phone"),
    aadhaarError(form.handed_over_aadhaar),
  );

  /** WHICH KIND of person has the load. Both modes that ask mean the same thing by
   *  it — is this one of ours — so the control is written once and only its aria
   *  label says whose hands it is in. */
  const personChoice = (aria: string) => (
    // FIXED 2026-08-21 — every field `missing` will hold the press back for is now
    // MARKED. The asterisks are driven off the same served mode rule
    // (`rule.required_fields`, plus the hand-over id rule below it), never a second
    // hand-written list, so the form cannot advertise a requirement the service does
    // not have — or stay silent about one it does.
    <Field label="Person" required>
      <Select
        value={handoverPerson}
        onChange={(value) => {
          if (!value) return;
          setHandoverPerson(value);
          // The id boxes are exclusive: keeping the one that is no longer asked for
          // is how an Aadhaar ends up filed against an employee.
          setForm((f) => ({
            ...f, handed_over_employee_id: "", handed_over_aadhaar: "",
          }));
        }}
        options={HANDOVER_PERSONS}
        ariaLabel={aria}
      />
    </Field>
  );

  /** The number behind that choice. An outsider has no employee id, and an employee's
   *  Aadhaar is not ours to hold when HCM already knows who they are. */
  const personId = () => (handoverPerson === "EMPLOYEE" ? (
    <Field label="Employee ID" required>
      <Input value={form.handed_over_employee_id}
        onChange={(e) => setForm({
          ...form, handed_over_employee_id: e.target.value,
        })} />
    </Field>
  ) : (
    <Field label="Aadhaar number" required
      hint={aadhaarError(form.handed_over_aadhaar) ?? "12 digits"}>
      <Input value={form.handed_over_aadhaar} inputMode="numeric" maxLength={12}
        onChange={(e) => setForm({
          ...form,
          handed_over_aadhaar: e.target.value.replace(/\D/g, "").slice(0, 12),
        })} />
    </Field>
  ));

  /** The papers the load leaves with. WHICH ones depends on how it travels — a truck
   *  leaves with a way bill and a challan, a courier with the counter's receipt — so
   *  the list is passed in and everything below it is written once, for the same
   *  reason the person question is. */
  const paperwork = (asked: typeof TRANSPORT_DOCS) => (
    <>
      <Group
        icon={<Paperclip className="h-4 w-4" />}
        title="Paperwork it leaves with"
        hint="Filed on this press"
      />
      {asked.map((doc) => (
        <DocPicker
          key={doc.category}
          label={doc.label}
          button={doc.button}
          hint={doc.hint}
          chosen={papers[doc.category] ?? null}
          onChoose={(file) => setPapers((p) => ({ ...p, [doc.category]: file }))}
          onClear={() => setPapers((p) => ({ ...p, [doc.category]: null }))}
        />
      ))}
    </>
  );

  const lockedAfterFinalDispatch = Boolean(shipment && ![
    "DRAFT", "PENDING_APPROVAL", "QUOTING", "AWAITING_CARRIER", "READY",
  ].includes(shipment.status));

  const blocked = !id
    || (Boolean(outcome) && !shipment && !sent)
    || lockedAfterFinalDispatch
    || missing.length > 0
    || badValues.length > 0
    || send.isPending;

  /** The words on the press, in one place: the header carries it and so does the rail,
   *  and a button that reads differently in two places reads as two buttons. */
  const pressLabel = send.isPending
    ? "Sending..."
    : rule?.needs_quotes
      ? `Send for a price${carrierIds.length > 1 ? ` (${carrierIds.length})` : ""}`
      : rule?.needs_carrier
        ? "Send to courier"
        : "Dispatch now";

  // Does this mode ask anything past the two pickers? A hand-over asks who took it, a
  // vehicle asks who is driving, a hired leg asks who carries it and under what
  // number — and if the mode asks for none of them the step is not drawn at all rather
  // than drawn empty.
  const asksDetails = Boolean(
    rule?.needs_carrier || needs("vehicle_number") || needs("handed_over_by_name"));

  return (
    <div>
      <PageHeader
        eyebrow="Logistics"
        title="Confirm dispatch"
        actions={
          /* Back, and only back. The two presses live ONCE, in the summary rail
             beside the line that says whether they can be pressed yet. The header
             carried the same pair, so one screen offered "Send for a price" and
             "Generate gate pass" twice over and the desk was left working out whether
             the second copy of each did something different. */
          <Button variant="ghost" onClick={() => nav("/logistics/dispatch")}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        }
      />

      <ErrorBanner error={send.error} />

      {/* The form and the rail. Below `xl` the rail stacks under the form, which puts
          the load, the choice and the press at the end of the page, where a phone
          expects them. */}
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          {/* One decision, one screen, and it ends here. The three steps are the ASK;
              once it has been answered they are history, and redrawing them under the
              result is what made the same consignment look like three pages. */}
          {outcome && showGatePass ? (
            <DispatchOutcome
              leg={outcome}
              doc={shipment ?? sent}
              rule={outcomeRule}
              justSent={Boolean(sent)}
              providers={carrierIds.length}
              onAnother={() => nav("/logistics/dispatch")}
            />
          ) : (
          <fieldset disabled={lockedAfterFinalDispatch} className="contents">
          <Step
            n={1}
            title="Which consignment"
            subtitle="Packed consignments only."
          >
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
              <Field label="Gate pass no" hint="Optional.">
                <Input value={gatePass} onChange={(e) => setGatePass(e.target.value)} />
              </Field>
            </div>

          </Step>

          <Step
            n={2}
            title="How does it travel?"
            subtitle="The one decision here — everything below follows from it."
          >
            <div className="space-y-5">
              <div>
                <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-medium text-body">Mode</span>
                  <span className="text-xs text-muted">How it travels.</span>
                </div>
                <OptionTiles
                  ariaLabel="Carriage mode"
                  columns={4}
                  size="sm"
                  value={carriage}
                  options={(carriages ?? CARRIAGE_FALLBACK.map((value) => ({
                    value, label: carriageLabel(value), allowed_modes: [],
                  }))).map((row) => ({
                    value: row.value,
                    label: row.label,
                    icon: CARRIAGE_ICON[row.value],
                  }))}
                  onChange={(value) => {
                    const next = value as CarriageMode;
                    setCarriage(next);
                    // An arrangement the new carriage cannot be made under has to go,
                    // or the form would keep asking for a driver on a sea leg. Falls
                    // to the first that carriage DOES allow, and clears with it. The
                    // allowed list is the backend's, so nothing here decides it.
                    const allowed = carriages?.find((row) => row.value === next)
                      ?.allowed_modes ?? [];
                    if (allowed.length && !allowed.includes(mode)) {
                      chooseType(allowed[0]);
                    }
                  }}
                />
              </div>

              <div>
                <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-medium text-body">Arrangement</span>
                  <span className="text-xs text-muted">Who moves it.</span>
                </div>
                <OptionTiles
                  ariaLabel="Transport type"
                  columns={2}
                  value={mode}
                  onChange={(value) => chooseType(value as TransportMode)}
                  options={(modes ?? [])
                    .filter((option) => typeAllowed(option.value))
                    .map((option) => ({
                      value: option.value,
                      label: modeLabel(option.value),
                      help: oneLine(option.help),
                      icon: MODE_ICON[option.value],
                      // What the press does, read off the mode's own rule rather than
                      // listed here: a tendered mode goes out for prices, everything
                      // else leaves on the press (`release_now`).
                      badge: option.needs_quotes ? "Tender" : "Leaves now",
                    }))}
                />

                {/* Advice, never a decision — whatever is picked is validated the same
                    way. Hidden once it agrees with the pick, so it stops being noise,
                    and hidden outright when this carriage mode rules it out: offering a
                    courier on a leg that cannot be one is advice nobody can take. */}
                {suggestion && suggestion.mode !== mode
                  && typeAllowed(suggestion.mode) && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-lg border border-info/25 bg-info-bg/70 px-3 py-2 text-xs text-body">
                    <Sparkles className="h-3.5 w-3.5 shrink-0 text-info" aria-hidden />
                    <span>This load looks like</span>
                    <button
                      type="button"
                      className="font-semibold text-brand underline underline-offset-2 hover:text-brand-600"
                      onClick={() => chooseType(suggestion.mode)}
                    >
                      {suggestion.label}
                    </button>
                    <span className="text-muted">— {suggestion.reason}.</span>
                  </div>
                )}
              </div>
            </div>
          </Step>

          {asksDetails && (
            <Step
              n={3}
              title={rule?.needs_carrier ? "Which provider handles it?" : "Who has it, and how it is chased"}
              subtitle={rule?.needs_carrier
                ? "The provider fills in the journey details when they acknowledge."
                : `What a ${modeLabel(mode).toLowerCase()} leg records.`}
            >
              <div className="grid gap-4 lg:grid-cols-2">
                {/* The provider list is the carrier vendors — whoever is on the master.
                    A tender takes as many as should price the job; a booking takes one. */}
                {rule?.needs_carrier && (
                  <>
                    <Group
                      first
                      icon={<Package className="h-4 w-4" />}
                      title={rule.needs_quotes ? "The tender" : "The booking"}
                      hint={rule.needs_quotes
                        ? "Everyone who should price this job"
                        : "Booked at their published rate"}
                    />
                    <div className="col-span-full">
                      <Field
                        label={rule.needs_quotes ? "Logistics partners" : "Courier"}
                        hint={rule.needs_quotes
                          ? "Prices come back side by side on Provider Selection."
                          : undefined}
                      >
                        <Select
                          value={rule.needs_quotes ? "" : (carrierIds[0] ? String(carrierIds[0]) : "")}
                          onChange={(value) => {
                            const picked = Number(value);
                            if (!picked) return;
                            // A tender ADDS; a booking REPLACES. Same control, and the
                            // mode is the only thing that decides which, so there is one
                            // place to read what "choose a provider" means here.
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

                        {/* The chosen set, as chips. A tender's whole point is that it
                            went to several, so who is on it has to be readable without
                            opening a second screen — and removable before it is sent,
                            not after. */}
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
                          <p className="mt-2 flex items-start gap-1.5 text-xs text-warn">
                            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                            <span>
                              One provider is a rate, not a tender — add a second to
                              compare.
                            </span>
                          </p>
                        )}

                        {/* An empty dropdown used to be a dead end: it named the problem
                            (nothing on the master) and not the screen that fixes it, so
                            the dispatch stopped here. */}
                        {noPartners && (
                          <p className="mt-2 text-xs text-muted">
                            Register them in{" "}
                            <Link to="/logistics/vendors"
                              className="font-semibold text-brand underline">
                              Logistics Vendors
                            </Link>
                            {" "}— they appear here at once.
                          </p>
                        )}
                      </Field>
                    </div>

                    <div className="contents">

                    {/* Who actually came for it. Asked on every leg that leaves with an
                        outside provider — a courier's rate is published and a tender's
                        price comes back from the carriers, so the price is never the
                        thing typed here; the person the load was handed to is what
                        nobody else records. Blank on a tender until somebody is awarded
                        and turns up, and kept either way, because the collection happens
                        on this document. */}
                    <Group
                      icon={<IdCard className="h-4 w-4" />}
                      title="Who collected it"
                      hint="Blank until somebody turns up"
                    />
                    {/* A tender leaves with a hired truck and the man behind its
                        wheel; a courier sends whoever is on the round for a parcel.
                        Same box, and the label says which of the two turned up. */}
                    <Field label={rule.needs_quotes ? "Driver name" : "Collected by"}
                      required={needs("driver_name")}>
                      <Input value={form.driver_name}
                        onChange={(e) => setForm({ ...form, driver_name: e.target.value })} />
                    </Field>
                    {/* A courier's man comes for a parcel and signs for it — the van
                        he came in and the licence he holds are the courier's business,
                        not ours. A hired truck is the other way round: it leaves with
                        the whole load, so the vehicle and the licence behind the wheel
                        are the two things worth having when it is chased. */}
                    <Field label="Vehicle number" hint="Optional.">
                      <Input value={form.vehicle_number}
                        onChange={(e) => setForm({
                          ...form, vehicle_number: e.target.value,
                        })} />
                    </Field>
                    <Field label="Phone number" required={needs("driver_phone")}
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

                    {/* The tracking papers, BOTH of them, on the press that books the
                        leg. A hired truck travels on a consignment note and a courier
                        parcel on a docket; they are different documents, the shipment
                        keeps a column for each, and the service releases on either. One
                        box called "Docket / LR" wrote only the docket, so the LR — the
                        number a truck is actually chased on — could not be recorded
                        here at all and had to be typed on the shipment screen after the
                        load had already gone.

                        On a tender both are optional: a shipment awarded later gets its
                        number then. On a booked leg one of the two is required, which
                        is exactly what the service checks. */}
                    <Group
                      icon={<FileText className="h-4 w-4" />}
                      title="How it is chased"
                      hint="What the site tracks it on"
                    />
                    <Field label="LR number"
                      hint={rule.needs_quotes ? "Optional." : "The consignment note."}>
                      <Input value={form.lr_no}
                        onChange={(e) => setForm({ ...form, lr_no: e.target.value })} />
                    </Field>
                    <Field label="Docket number"
                      hint={rule.needs_quotes ? "Optional." : "Either this or the LR."}>
                      <Input value={form.docket_no}
                        onChange={(e) => setForm({ ...form, docket_no: e.target.value })} />
                    </Field>
                    <Field label="Tracking link" hint="Optional.">
                      <Input value={form.tracking_url}
                        onChange={(e) => setForm({ ...form, tracking_url: e.target.value })} />
                    </Field>
                    <Field label="E-way bill no" hint="Optional.">
                      <Input value={form.eway_bill_no}
                        onChange={(e) => setForm({ ...form, eway_bill_no: e.target.value })} />
                    </Field>
                    <Field label="Carrier reference" hint="Optional.">
                      <Input value={form.carrier_reference}
                        onChange={(e) => setForm({
                          ...form, carrier_reference: e.target.value,
                        })} />
                    </Field>

                    {paperwork(rule.needs_quotes ? TRANSPORT_DOCS : COURIER_DOCS)}
                    </div>
                  </>
                )}

                {needs("vehicle_number") && (
                  <>
                    {/* Who is behind the wheel, pinned to a number, and asked FIRST: the
                        vehicle is ours but the driver on the day may not be, and which
                        number identifies them is decided before it can be typed. The
                        choice and the box it decides sit side by side — a row apart, the
                        Aadhaar looks like it belongs to whatever is above it. */}
                    <Group
                      first
                      icon={<IdCard className="h-4 w-4" />}
                      title="Who is driving"
                      hint="Ours, or a driver on the day"
                    />
                    {personChoice("Who is driving")}
                    {personId()}
                    <Field label="Vehicle number" required={needs("vehicle_number")}>
                      <Input value={form.vehicle_number}
                        onChange={(e) => setForm({ ...form, vehicle_number: e.target.value })} />
                    </Field>
                    <Field label="Driver name" required={needs("driver_name")}>
                      <Input value={form.driver_name}
                        onChange={(e) => setForm({ ...form, driver_name: e.target.value })} />
                    </Field>
                    <Field label="Driver phone" required={needs("driver_phone")}
                      hint={phoneError(form.driver_phone, "Driver phone") ?? PHONE_HINT}>
                      <Input value={form.driver_phone} inputMode="numeric" maxLength={18}
                        onChange={(e) => setForm({
                          ...form, driver_phone: sanitizePhone(e.target.value),
                        })} />
                    </Field>
                    {/* The other job the vehicle was already doing — the whole reason
                        this mode costs the shipment nothing. Asked here as well as on
                        the manual form, so a one-press dispatch does not lose it. */}
                    <Field label="Trip reference" hint="The job it was already on.">
                      <Input value={form.trip_reference}
                        onChange={(e) => setForm({ ...form, trip_reference: e.target.value })} />
                    </Field>

                    {paperwork(TRANSPORT_DOCS)}
                  </>
                )}

                {needs("handed_over_by_name") && (
                  <>
                    <Group
                      first
                      icon={<Handshake className="h-4 w-4" />}
                      title="Who takes custody"
                      hint="A name alone identifies nobody"
                    />
                    {personChoice("Who hands it over")}

                    <Field label="Handed over by"
                      required={needs("handed_over_by_name")}>
                      <Input value={form.handed_over_by_name}
                        onChange={(e) => setForm({ ...form, handed_over_by_name: e.target.value })} />
                    </Field>

                    {personId()}

                    <Field label="Phone number"
                      required={needs("handed_over_phone")}
                      hint={phoneError(form.handed_over_phone, "Phone") ?? PHONE_HINT}>
                      <Input value={form.handed_over_phone} inputMode="numeric"
                        maxLength={18}
                        onChange={(e) => setForm({
                          ...form, handed_over_phone: sanitizePhone(e.target.value),
                        })} />
                    </Field>
                  </>
                )}
              </div>
            </Step>
          )}
          </fieldset>
          )}
        </div>

        {/* The rail: what is being sent, how, and whether the press is ready. Sticky
            under the app header on a wide screen, so the answer to "can I send this
            yet" never scrolls away while the form beside it is filled. */}
        <aside className="min-w-0 xl:sticky xl:top-[7.5rem]">
          <Card className="overflow-hidden p-0">
            <div className="border-b border-line/70 bg-content2/40 px-4 py-3">
              <h2 className="font-display text-[15px] font-bold text-ink">Dispatch summary</h2>
              {chosen ? (
                <p className="mono mt-0.5 truncate text-xs font-semibold text-brand">
                  {chosen.dispatch_no}
                </p>
              ) : (
                <p className="mt-0.5 text-xs text-muted">Nothing picked yet</p>
              )}
            </div>

            <div className="space-y-3.5 p-4">
              {chosen ? (
                <>
                  <Fact icon={<MapPin className="h-4 w-4" />} label="Going to"
                    value={destinationOf(chosen)} />
                  <Fact icon={<Warehouse className="h-4 w-4" />} label="From"
                    value={chosen.warehouse_name ?? "—"} />
                  <Fact icon={<Boxes className="h-4 w-4" />} label="Load"
                    value={load(chosen.total_packages, chosen.total_weight_kg)} />
                  <Fact icon={<CalendarDays className="h-4 w-4" />} label="Packed"
                    value={fmtDate(chosen.dispatch_date)} />
                </>
              ) : (
                <p className="text-sm text-muted">
                  Pick a consignment to see its details.
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2 border-t border-line/70 pt-3.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                  Travels by
                </span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${carriageTint(carriage)}`}>
                  {carriageRule?.label ?? carriageLabel(carriage)}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${modeTint(mode)}`}>
                  {modeLabel(mode)}
                </span>
              </div>

              {/* Why the press is held back. A disabled button with no reason beside it
                  reads as a broken screen — and at the bottom of a long form, the reason
                  sat somewhere the eye had already left. */}
              <div className="border-t border-line/70 pt-3.5">
                {outcome ? (
                  <p className="flex items-start gap-1.5 text-xs font-medium text-ok">
                    <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span>
                      {showGatePass
                        ? `${outcome.tr_no} carries this consignment.`
                        : `${outcome.tr_no} is ready — generate the gate pass.`}
                    </span>
                  </p>
                ) : !id ? (
                  <p className="text-xs text-muted">Choose a consignment to begin.</p>
                ) : missing.length > 0 || badValues.length > 0 ? (
                  <>
                    <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
                      {modeLabel(mode)} still needs
                    </p>
                    <ul className="space-y-1">
                      {missing.map((field) => (
                        <li key={field} className="flex items-start gap-1.5 text-xs text-body">
                          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warn"
                            aria-hidden />
                          {FIELD_LABELS[field] ?? field}
                        </li>
                      ))}
                      {badValues.map((problem) => (
                        <li key={problem} className="flex items-start gap-1.5 text-xs text-danger">
                          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
                            aria-hidden />
                          {problem}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="flex items-start gap-1.5 text-xs font-medium text-ok">
                    <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span>
                      {rule?.needs_quotes
                        ? `Ready to go out to ${carrierIds.length} provider${carrierIds.length === 1 ? "" : "s"} for a price.`
                        : rule?.needs_carrier
                          ? "Ready to send to the courier for acknowledgement."
                          : "Ready for final dispatch in Shipments."}
                    </span>
                  </p>
                )}
              </div>

              {/* The only place either press appears, directly under the reason it is
                  held back. It goes with the form it belonged to — the outcome is not
                  something to be pressed again. */}
              {!showGatePass && (
                <Can do="transport.create">
                  <div className="grid gap-2 border-t border-line/70 pt-3.5">
                    <Button className="w-full" onClick={() => press(false)} disabled={blocked}>
                      <Truck className="h-4 w-4" />
                      {pressLabel}
                    </Button>
                    <Button className="w-full" variant="soft"
                      onClick={() => press(true)} disabled={blocked}>
                      <FileText className="h-4 w-4" /> Generate gate pass
                    </Button>
                  </div>
                </Can>
              )}
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}
