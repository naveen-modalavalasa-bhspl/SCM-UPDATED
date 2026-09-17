import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Hand, Loader2, Truck, X } from "lucide-react";
import {
  Button,
  ErrorBanner,
  Field,
  Input,
  Textarea,
  TONE_DEEP_MINT,
  TONE_PINK,
} from "@/shared/components";
import { Stepper, type Step } from "@/shared/components/Stepper";
import { purchaseReturnLogisticsModes } from "../api";
import { fmtMoney, fmtQty } from "../format";
import type { LogisticsModeOption, PurchaseReturnLogisticsPayload } from "../types";

/**
 * Send to Vendor — the six-step handover.
 *
 * Replaces the one-line confirm dialog that used to stand between a reviewed draft
 * and a sent return. That dialog asked "are you sure?" and recorded nothing, so a
 * purchase return left the gate as an `out_dispatches` row that named the vendor and
 * said nothing whatever about how the goods got there: no mode, no vehicle, no
 * carrier, no LR, no signature. Every one of those columns already existed on the
 * table — the send simply never filled them.
 *
 *   Logistics → Supplier Details → Items Details → Shipment Details
 *     → Supplier Acknowledgement → Complete
 *
 * LOGISTICS COMES FIRST, and the rest of the wizard bends around the answer: a
 * hand-over asks who carried it, an own-vehicle leg asks which vehicle and who drove,
 * a third-party leg asks who was hired and for what freight. Asking all three sets on
 * one screen and greying out the irrelevant ones was the alternative, and it makes
 * every leg look like a form somebody left half-finished.
 *
 * The three cards are SERVED, from `/warehouse/returns/logistics-modes`, and so are
 * the `needs_*` flags this file branches on — which modes exist and what each one
 * must carry is a business rule, and the same rule is enforced again in
 * `_validate_return_logistics` on the way in. A screen is not a place to keep a rule.
 *
 * A MODE, NOT A DIALOG. It covers the screen rather than floating over it, because
 * six steps of data entry behind a scrim reads as an interruption to the form and
 * this is the last mile of the form.
 */

export interface WizardLine {
  key: string;
  item_name: string;
  item_code?: string | null;
  uom_code?: string | null;
  batch_no?: string | null;
  quantity: number;
  rate?: number | null;
  amount: number;
}

export interface WizardVendor {
  vendor_name?: string | null;
  vendor_code?: string | null;
  gstin?: string | null;
  contact_person?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
}

/** Every box is a STRING while it is being typed — same reason the form itself keeps
 *  its quantities as strings: an empty numeric field is "" and not 0, and storing 0
 *  makes "nothing entered" indistinguishable from "the answer is zero". */
interface Draft {
  mode: string;
  hand_carried_by: string;
  vehicle_number: string;
  driver_name: string;
  driver_phone: string;
  carrier_name: string;
  lr_no: string;
  freight_amount: string;
  delivery_address: string;
  contact_person: string;
  contact_phone: string;
  total_packages: string;
  total_weight_kg: string;
  eway_bill_no: string;
  expected_delivery: string;
  gate_pass_no: string;
  dispatch_remarks: string;
  acknowledged_by_name: string;
  acknowledged_at: string;
  pod_url: string;
}

const EMPTY_DRAFT: Draft = {
  mode: "",
  hand_carried_by: "", vehicle_number: "", driver_name: "", driver_phone: "",
  carrier_name: "", lr_no: "", freight_amount: "",
  delivery_address: "", contact_person: "", contact_phone: "",
  total_packages: "", total_weight_kg: "", eway_bill_no: "",
  expected_delivery: "", gate_pass_no: "", dispatch_remarks: "",
  acknowledged_by_name: "", acknowledged_at: "", pod_url: "",
};

const STEP_LABELS = [
  "Logistics",
  "Supplier Details",
  "Items Details",
  "Shipment Details",
  "Supplier Acknowledgement",
  "Complete",
] as const;

/** The icon on each mode card. Keyed on the served `value`, with a fallback, so a
 *  mode added to the catalogue later renders as a card rather than as a crash. */
const MODE_ICON: Record<string, JSX.Element> = {
  DIRECT: <Hand className="h-5 w-5" />,
  OWN_VEHICLE: <Truck className="h-5 w-5" />,
  THIRD_PARTY: <Truck className="h-5 w-5" />,
};

/** `<input type="datetime-local">` speaks local wall-clock with no zone; the API
 *  wants an instant. Empty in, empty out — the caller decides whether that is legal. */
const toInstant = (local: string): string | null => {
  if (!local.trim()) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Now, in the shape `datetime-local` accepts, so "the supplier signed just now" —
 *  overwhelmingly the common case — is one click and not a date picker. */
const nowLocal = (): string => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

const numOrNull = (raw: string): number | null => {
  const t = (raw ?? "").trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

const txt = (raw: string): string | null => (raw ?? "").trim() || null;

export interface SendToVendorWizardProps {
  open: boolean;
  onClose: () => void;
  /** Posts the block and, on success, navigates away — the wizard never closes itself
   *  on success, because the screen it would return to no longer exists. */
  onSubmit: (logistics: PurchaseReturnLogisticsPayload) => void;
  busy?: boolean;
  error?: unknown;
  returnNo?: string | null;
  vendor: WizardVendor;
  lines: WizardLine[];
  totalQty: number;
  totalValue: number;
  reasonLabel: string;
  remarks?: string | null;
  /** A manual return raises no consignment, so what is captured here lives only on
   *  the audit trail. Said on the last step rather than discovered afterwards. */
  manualEntry?: boolean;
}

export default function SendToVendorWizard({
  open, onClose, onSubmit, busy = false, error,
  returnNo, vendor, lines, totalQty, totalValue, reasonLabel, remarks,
  manualEntry = false,
}: SendToVendorWizardProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  // Only the steps the reader has actually tried to leave show their errors. A wizard
  // that opens with four fields already red has told the reader they did something
  // wrong before they touched anything.
  const [tried, setTried] = useState<Record<number, boolean>>({});

  const { data: modes = [], isLoading: modesLoading, error: modesError } = useQuery({
    queryKey: ["warehouse", "purchase-return", "logistics-modes"],
    queryFn: purchaseReturnLogisticsModes,
    enabled: open,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const set = <K extends keyof Draft>(field: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [field]: value }));

  // Seeded once per opening, not on every render: the delivery point defaults to the
  // vendor on file and the package count to the number of lines, both of which are
  // right often enough to be worth pre-filling — but a reader who cleared a box must
  // find it still cleared when they step back to it.
  useEffect(() => {
    if (!open) return;
    setStepIndex(0);
    setTried({});
    setDraft({
      ...EMPTY_DRAFT,
      delivery_address: vendor.address ?? "",
      contact_person: vendor.contact_person ?? "",
      contact_phone: vendor.phone ?? "",
      total_packages: lines.length ? String(lines.length) : "",
      acknowledged_at: nowLocal(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const chosen: LogisticsModeOption | undefined =
    modes.find((m) => m.value === draft.mode);

  /** What is missing on each step, in the order the boxes are read. Computed for
   *  EVERY step rather than just the current one, so the rail can mark a step behind
   *  the reader as an error and Complete can refuse a wizard that was stepped through
   *  with the browser's back button. */
  const problems = useMemo<Record<number, string[]>>(() => {
    const p: Record<number, string[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [] };

    if (!draft.mode) p[0].push("Choose how the return travels");
    if (chosen?.needs_bearer && !draft.hand_carried_by.trim())
      p[0].push("Enter who is carrying the goods");
    if (chosen?.needs_vehicle && !draft.vehicle_number.trim())
      p[0].push("Enter the vehicle number");
    if (chosen?.needs_carrier && !draft.carrier_name.trim())
      p[0].push("Enter the carrier");

    if (!draft.delivery_address.trim())
      p[1].push("Enter where the goods are being sent back to");

    if (lines.length === 0) p[2].push("There are no lines to return");

    // The one physical count on the shipment step, and it opens pre-filled with the
    // line count — so this asks the packing bench to confirm a number, not invent one.
    const pkgs = numOrNull(draft.total_packages);
    if (pkgs === null || pkgs < 1) p[3].push("Enter how many packages are going");

    // THE SIGNATURE IS ONLY ASKED FOR WHERE IT CAN ALREADY EXIST (2026-09-11).
    //
    // A hand-over and a third-party handover both happen at the gate in the same breath
    // as this press: somebody walked out with the carton, or the hired truck drove off
    // with it, so there is a real signature to record. `raises_shipment` is the other
    // case — our own vehicle, which has not left the yard — and the served flag says so
    // rather than this screen testing for the mode code. Demanding an acknowledgement
    // there made the storekeeper certify a signature that could not exist, and the
    // backend then closed the consignment on the strength of it, so the load never
    // reached Logistics at all. The supplier signs later, on the leg.
    if (!chosen?.raises_shipment) {
      if (!draft.acknowledged_by_name.trim())
        p[4].push("Enter who at the supplier acknowledged the return");
      if (!toInstant(draft.acknowledged_at))
        p[4].push("Enter when the supplier acknowledged it");
    }

    return p;
  }, [draft, chosen, lines.length]);

  const stepClean = (i: number) => problems[i].length === 0;
  // Complete is reachable only once all five behind it are answered.
  const allClean = [0, 1, 2, 3, 4].every(stepClean);

  const steps: Step[] = STEP_LABELS.map((label, i) => ({
    id: String(i),
    label,
    status:
      i === stepIndex ? "current"
        : tried[i] && !stepClean(i) ? "error"
          : i < stepIndex ? "complete"
            : "upcoming",
  }));

  const goNext = () => {
    setTried((t) => ({ ...t, [stepIndex]: true }));
    if (!stepClean(stepIndex)) return;
    setStepIndex((i) => Math.min(i + 1, STEP_LABELS.length - 1));
  };
  const goBack = () => setStepIndex((i) => Math.max(i - 1, 0));

  /** Jump straight to a step from the rail — but only backwards, or to one already
   *  answered. Forward into an unanswered step would show Complete with blanks. */
  const jumpTo = (i: number) => {
    if (i <= stepIndex) { setStepIndex(i); return; }
    for (let s = stepIndex; s < i; s += 1) {
      if (!stepClean(s)) { setTried((t) => ({ ...t, [s]: true })); setStepIndex(s); return; }
    }
    setStepIndex(i);
  };

  const submit = () => {
    setTried({ 0: true, 1: true, 2: true, 3: true, 4: true });
    if (!allClean || busy) return;
    // Only the fields the chosen mode owns are posted. The service drops the rest
    // too, but sending a carrier name from an abandoned third-party branch and
    // relying on the far end to ignore it is how the two ends drift apart.
    const payload: PurchaseReturnLogisticsPayload = {
      mode: draft.mode,
      hand_carried_by: chosen?.needs_bearer ? txt(draft.hand_carried_by) : null,
      vehicle_number: chosen?.needs_vehicle ? txt(draft.vehicle_number) : null,
      driver_name: chosen?.needs_vehicle ? txt(draft.driver_name) : null,
      driver_phone: chosen?.needs_vehicle ? txt(draft.driver_phone) : null,
      carrier_name: chosen?.needs_carrier ? txt(draft.carrier_name) : null,
      lr_no: chosen?.needs_carrier ? txt(draft.lr_no) : null,
      freight_amount: chosen?.needs_carrier ? numOrNull(draft.freight_amount) : null,
      delivery_address: txt(draft.delivery_address),
      contact_person: txt(draft.contact_person),
      contact_phone: txt(draft.contact_phone),
      total_packages: numOrNull(draft.total_packages),
      total_weight_kg: numOrNull(draft.total_weight_kg),
      eway_bill_no: txt(draft.eway_bill_no),
      expected_delivery: txt(draft.expected_delivery),
      gate_pass_no: txt(draft.gate_pass_no),
      dispatch_remarks: txt(draft.dispatch_remarks),
      // Null on a leg that goes to Logistics, for the same reason the carrier fields
      // above are null off a third-party branch that was abandoned: the acknowledgement
      // boxes open pre-filled with "now", and posting that stamp for a truck still
      // standing in the yard would record a handover that has not happened. The service
      // ignores them on this mode too — sending them anyway and trusting the far end to
      // drop them is how the two ends drift apart.
      acknowledged_by_name: chosen?.raises_shipment
        ? null : txt(draft.acknowledged_by_name),
      acknowledged_at: chosen?.raises_shipment
        ? null : toInstant(draft.acknowledged_at),
      pod_url: txt(draft.pod_url),
    };
    onSubmit(payload);
  };

  if (!open) return null;

  const showProblems = tried[stepIndex] && !stepClean(stepIndex);
  const vendorName = vendor.vendor_name?.trim() || "the vendor";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Send this purchase return to the vendor"
      className="fixed inset-0 z-50 flex flex-col bg-content2"
    >
      {/* The band. Names the document and who it is going to, and stays put — six
          steps is long enough that "which return am I sending?" becomes a real
          question halfway down. */}
      <header className="shrink-0 border-b border-line bg-content1 px-4 py-3 md:px-6">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted">
              Send to Vendor
            </p>
            <h2 className="truncate font-display text-xl font-bold text-ink">
              {returnNo ? `Purchase Return ${returnNo}` : "Purchase Return"}
              <span className="ml-2 text-base font-medium text-muted">→ {vendorName}</span>
            </h2>
          </div>
          <button
            type="button"
            onClick={() => { if (!busy) onClose(); }}
            disabled={busy}
            aria-label="Close without sending"
            className="rounded-lg border border-line p-2 text-muted transition
                       hover:border-bad hover:text-bad disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* The shared rail, deliberately — four rails in this product that disagree
          about what "done" looks like is worse than any one of them being wrong.
          Wrapped in its own buttons so a reader can step back to fix an answer. */}
      <div className="shrink-0 border-b border-line bg-content1">
        <div className="relative mx-auto max-w-5xl">
          <Stepper steps={steps} />
          {/* Overlaid hit targets, one per column: `Stepper` renders an <ol> and takes
              no click handler, and giving it one for this single caller would have
              made every other rail in the product look pressable. */}
          <div
            className="pointer-events-none absolute inset-0 grid px-2 py-4"
            style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
          >
            {STEP_LABELS.map((label, i) => (
              <button
                key={label}
                type="button"
                onClick={() => jumpTo(i)}
                disabled={busy}
                aria-label={`Go to ${label}`}
                className="pointer-events-auto rounded-lg focus:outline-none
                           focus-visible:ring-2 focus-visible:ring-brand"
              />
            ))}
          </div>
        </div>
      </div>

      {/* The step itself */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-6">
        <div className="mx-auto max-w-5xl">
          {error != null && <ErrorBanner error={error} />}

          {showProblems && (
            <ul className="mb-4 space-y-1 rounded-xl border border-bad/30 bg-bad-bg px-4 py-3
                           text-sm text-bad">
              {problems[stepIndex].map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}

          {stepIndex === 0 && (
            <StepLogistics
              draft={draft} set={set} modes={modes} chosen={chosen}
              loading={modesLoading} loadError={modesError} busy={busy}
            />
          )}
          {stepIndex === 1 && (
            <StepSupplier draft={draft} set={set} vendor={vendor} busy={busy} />
          )}
          {stepIndex === 2 && (
            <StepItems lines={lines} totalQty={totalQty} totalValue={totalValue}
                       reasonLabel={reasonLabel} remarks={remarks} />
          )}
          {stepIndex === 3 && <StepShipment draft={draft} set={set} busy={busy} />}
          {stepIndex === 4 && (
            <StepAcknowledgement draft={draft} set={set} busy={busy}
                                 toLogistics={Boolean(chosen?.raises_shipment)} />
          )}
          {stepIndex === 5 && (
            <StepComplete
              draft={draft} chosen={chosen} vendor={vendor} lines={lines}
              totalQty={totalQty} totalValue={totalValue} reasonLabel={reasonLabel}
              manualEntry={manualEntry}
            />
          )}
        </div>
      </div>

      {/* The controls, pinned. On a long step the Continue button was below the fold,
          which on the Items step meant scrolling a table to find out how to leave it. */}
      <footer className="shrink-0 border-t border-line bg-content1 px-4 py-3 md:px-6">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
          <span className="text-xs font-medium text-muted">
            Step {stepIndex + 1} of {STEP_LABELS.length} · {STEP_LABELS[stepIndex]}
          </span>
          <div className="flex flex-wrap gap-2">
            <Button variant="soft" className={TONE_PINK}
                    disabled={busy}
                    onClick={() => { if (stepIndex === 0) onClose(); else goBack(); }}>
              {stepIndex === 0 ? "Cancel" : "Back"}
            </Button>
            {stepIndex < STEP_LABELS.length - 1 ? (
              <Button variant="soft" disabled={busy} onClick={goNext}>Continue</Button>
            ) : (
              <Button className={TONE_DEEP_MINT} disabled={busy || !allClean}
                      onClick={submit}>
                {busy
                  ? <span className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" /> Sending…
                    </span>
                  : "Send to Vendor"}
              </Button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ the steps -- */

type SetFn = <K extends keyof Draft>(field: K, value: Draft[K]) => void;

/** A section heading inside a step. The wizard has no cards — a card inside a
 *  full-screen step is a box drawn around the only thing on the screen. */
function Legend({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-4">
      <h3 className="text-base font-bold text-ink">{title}</h3>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
    </div>
  );
}

function StepLogistics({ draft, set, modes, chosen, loading, loadError, busy }: {
  draft: Draft; set: SetFn; modes: LogisticsModeOption[];
  chosen?: LogisticsModeOption; loading: boolean; loadError: unknown; busy: boolean;
}) {
  return (
    <section>
      <Legend
        title="How is this return travelling back?"
        hint="Pick one. What the next steps ask for depends on the answer."
      />

      {loadError ? (
        <p className="rounded-xl border border-bad/30 bg-bad-bg px-4 py-3 text-sm text-bad">
          The delivery methods could not be loaded, and one has to be chosen. Reload the
          page — the list is served, so it cannot be typed in here.
        </p>
      ) : loading ? (
        <p className="text-sm text-muted">Loading delivery methods…</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {modes.map((m) => {
            const on = draft.mode === m.value;
            return (
              <button
                key={m.value}
                type="button"
                disabled={busy}
                aria-pressed={on}
                onClick={() => set("mode", m.value)}
                className={`flex h-full flex-col gap-2 rounded-xl border p-4 text-left transition
                  ${on
                    ? "border-brand bg-brand-050 ring-2 ring-brand/25"
                    : "border-line bg-content1 hover:border-brand/50"}`}
              >
                <span className={`flex h-10 w-10 items-center justify-center rounded-lg
                  ${on ? "bg-brand text-white" : "bg-content2 text-muted"}`}>
                  {MODE_ICON[m.value] ?? <Truck className="h-5 w-5" />}
                </span>
                <span className="text-sm font-bold text-ink">{m.label}</span>
                <span className="text-xs leading-5 text-muted">{m.help}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Only the questions this mode actually asks. */}
      {chosen?.needs_bearer && (
        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Carried by" required
                 hint="The person handing the goods over at the supplier.">
            <Input value={draft.hand_carried_by} disabled={busy}
                   onChange={(e) => set("hand_carried_by", e.target.value)}
                   placeholder="Name of the person carrying it"
                   aria-label="Carried by"
                   isInvalid={!draft.hand_carried_by.trim()} />
          </Field>
        </div>
      )}

      {chosen?.needs_vehicle && (
        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Vehicle number" required>
            <Input value={draft.vehicle_number} disabled={busy}
                   onChange={(e) => set("vehicle_number", e.target.value)}
                   placeholder="e.g. TS09AB1234" aria-label="Vehicle number"
                   isInvalid={!draft.vehicle_number.trim()} />
          </Field>
          <Field label="Driver name">
            <Input value={draft.driver_name} disabled={busy}
                   onChange={(e) => set("driver_name", e.target.value)}
                   placeholder="Optional" aria-label="Driver name" />
          </Field>
          <Field label="Driver phone">
            <Input value={draft.driver_phone} disabled={busy}
                   onChange={(e) => set("driver_phone", e.target.value)}
                   placeholder="Optional" aria-label="Driver phone" />
          </Field>
        </div>
      )}

      {chosen?.needs_carrier && (
        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Carrier" required
                 hint="Typed, not picked — a return often goes with whoever the supplier nominated.">
            <Input value={draft.carrier_name} disabled={busy}
                   onChange={(e) => set("carrier_name", e.target.value)}
                   placeholder="Who is carrying it" aria-label="Carrier"
                   isInvalid={!draft.carrier_name.trim()} />
          </Field>
          <Field label="LR / docket number" hint="If it has not been issued yet, leave it.">
            <Input value={draft.lr_no} disabled={busy}
                   onChange={(e) => set("lr_no", e.target.value)}
                   placeholder="Optional" aria-label="LR number" />
          </Field>
          <Field label="Freight amount (₹)">
            <Input type="number" min="0" value={draft.freight_amount} disabled={busy}
                   onChange={(e) => set("freight_amount", e.target.value)}
                   placeholder="Optional" aria-label="Freight amount" />
          </Field>
        </div>
      )}
    </section>
  );
}

function StepSupplier({ draft, set, vendor, busy }: {
  draft: Draft; set: SetFn; vendor: WizardVendor; busy: boolean;
}) {
  return (
    <section>
      <Legend
        title="Supplier details"
        hint="Who the goods go back to, and where they are actually being delivered."
      />

      {/* Read-only: the vendor is bound to the purchase and cannot be changed here —
          the same rule the form states beside its own vendor block. */}
      <dl className="mb-6 grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl border border-line
                     bg-content1 p-4 text-sm md:grid-cols-4">
        {([
          ["Supplier", vendor.vendor_name],
          ["Code", vendor.vendor_code],
          ["GSTIN", vendor.gstin],
          ["Email", vendor.email],
        ] as const).map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="break-words text-ink">{value?.trim() || "—"}</dd>
          </div>
        ))}
      </dl>

      {/* Editable: goods go back to a gate or a stores address that is frequently not
          the billing address on file, so these are pre-filled and typed over. */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <Field label="Delivery address" required
                 hint="Pre-filled from the supplier master. Change it if the goods go somewhere else.">
            <Textarea value={draft.delivery_address} disabled={busy} minRows={2}
                      onChange={(e) => set("delivery_address", e.target.value)}
                      placeholder="Where the goods are being returned to"
                      aria-label="Delivery address"
                      isInvalid={!draft.delivery_address.trim()} />
          </Field>
        </div>
        <Field label="Contact person">
          <Input value={draft.contact_person} disabled={busy}
                 onChange={(e) => set("contact_person", e.target.value)}
                 placeholder="Who to ask for on arrival" aria-label="Contact person" />
        </Field>
        <Field label="Contact phone">
          <Input value={draft.contact_phone} disabled={busy}
                 onChange={(e) => set("contact_phone", e.target.value)}
                 placeholder="Optional" aria-label="Contact phone" />
        </Field>
      </div>
    </section>
  );
}

function StepItems({ lines, totalQty, totalValue, reasonLabel, remarks }: {
  lines: WizardLine[]; totalQty: number; totalValue: number;
  reasonLabel: string; remarks?: string | null;
}) {
  return (
    <section>
      <Legend
        title="Items being returned"
        hint="Read back from the form. Step back out of the wizard to change a quantity."
      />

      <div className="overflow-x-auto rounded-xl border border-line bg-content1">
        <table className="min-w-[720px] w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase text-muted">
              <th className="px-4 py-2.5">Item</th>
              <th className="px-4 py-2.5 text-right">Return qty</th>
              <th className="px-4 py-2.5 text-right">Unit price</th>
              <th className="px-4 py-2.5 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.key} className="border-b border-line/60 last:border-0">
                <td className="px-4 py-2.5">
                  <div className="font-medium text-ink">{l.item_name || l.item_code}</div>
                  <div className="text-xs text-muted">
                    {[l.item_code, l.uom_code, l.batch_no ? `Batch ${l.batch_no}` : null]
                      .filter(Boolean).join(" · ")}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-right font-semibold tabular">{fmtQty(l.quantity)}</td>
                <td className="px-4 py-2.5 text-right tabular">{l.rate ? fmtMoney(l.rate) : "—"}</td>
                <td className="px-4 py-2.5 text-right tabular">{l.amount ? fmtMoney(l.amount) : "—"}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-line bg-content2 text-sm">
              <td className="px-4 py-2.5 font-semibold text-ink">
                {lines.length} line{lines.length === 1 ? "" : "s"}
              </td>
              <td className="px-4 py-2.5 text-right font-bold tabular text-ink">{fmtQty(totalQty)}</td>
              <td />
              <td className="px-4 py-2.5 text-right font-bold tabular text-ink">₹ {fmtMoney(totalValue)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
        <div>
          <div className="text-xs text-muted">Return reason</div>
          <div className="text-ink">{reasonLabel || "—"}</div>
        </div>
        <div>
          <div className="text-xs text-muted">Remarks</div>
          <div className="text-ink">{remarks?.trim() || "—"}</div>
        </div>
      </div>
    </section>
  );
}

function StepShipment({ draft, set, busy }: { draft: Draft; set: SetFn; busy: boolean }) {
  const pkgs = numOrNull(draft.total_packages);
  return (
    <section>
      <Legend
        title="Shipment details"
        hint="What physically leaves the gate. Everything but the package count is optional."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Packages" required hint="Pre-filled with the line count — correct it.">
          <Input type="number" min="1" value={draft.total_packages} disabled={busy}
                 onChange={(e) => set("total_packages", e.target.value)}
                 placeholder="0" aria-label="Number of packages"
                 isInvalid={pkgs === null || pkgs < 1} />
        </Field>
        <Field label="Total weight (kg)">
          <Input type="number" min="0" value={draft.total_weight_kg} disabled={busy}
                 onChange={(e) => set("total_weight_kg", e.target.value)}
                 placeholder="Optional" aria-label="Total weight in kilograms" />
        </Field>
        <Field label="Expected delivery">
          <Input type="date" value={draft.expected_delivery} disabled={busy}
                 onChange={(e) => set("expected_delivery", e.target.value)}
                 aria-label="Expected delivery date" />
        </Field>
        <Field label="E-way bill number">
          <Input value={draft.eway_bill_no} disabled={busy}
                 onChange={(e) => set("eway_bill_no", e.target.value)}
                 placeholder="Optional" aria-label="E-way bill number" />
        </Field>
        <Field label="Gate pass number">
          <Input value={draft.gate_pass_no} disabled={busy}
                 onChange={(e) => set("gate_pass_no", e.target.value)}
                 placeholder="Optional" aria-label="Gate pass number" />
        </Field>
        <div className="md:col-span-3">
          <Field label="Shipment remarks"
                 hint="Anything the person receiving it needs to know. Kept on the consignment, not on the return.">
            <Textarea value={draft.dispatch_remarks} disabled={busy} minRows={2}
                      onChange={(e) => set("dispatch_remarks", e.target.value)}
                      placeholder="Optional" aria-label="Shipment remarks" />
          </Field>
        </div>
      </div>
    </section>
  );
}

function StepAcknowledgement({ draft, set, busy, toLogistics }: {
  draft: Draft; set: SetFn; busy: boolean; toLogistics: boolean;
}) {
  // OUR OWN VEHICLE HAS NOT LEFT THE YARD YET, so there is no signature to record and
  // the step says so instead of showing two boxes that cannot honestly be filled. The
  // trip is arranged on the Logistics Dispatch board and the supplier signs there, at
  // the end of it. Rendered as a statement rather than skipped outright: a wizard whose
  // step count changes under the reader is worse than one that explains itself.
  if (toLogistics) {
    return (
      <section>
        <Legend
          title="Supplier acknowledgement"
          hint="Nothing to record yet — this load has not left."
        />
        <div className="rounded-xl border border-line bg-content2/60 p-4 text-sm text-body">
          <p>
            The goods are going on <strong>our own vehicle</strong>, so the trip still
            has to be arranged. Sending this return drops a <strong>draft shipment on
            the Logistics Dispatch board</strong>, and the desk there assigns the
            vehicle, writes the gate pass and releases the load.
          </p>
          <p className="mt-2 text-muted">
            The supplier signs for it when it reaches them — recorded on that shipment,
            not here. Nothing on this step is required.
          </p>
        </div>
        <div className="mt-4">
          <Field label="Proof of delivery"
                 hint="Where the signed copy lives, if one already exists. Normally filled in later, on the shipment.">
            <Input value={draft.pod_url} disabled={busy}
                   onChange={(e) => set("pod_url", e.target.value)}
                   placeholder="Optional" aria-label="Proof of delivery reference" />
          </Field>
        </div>
      </section>
    );
  }

  return (
    <section>
      <Legend
        title="Supplier acknowledgement"
        hint="Who at the supplier signed for the goods, and when. Required — the acknowledgement is what closes the handover."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Acknowledged by" required
               hint="The name on the signed copy.">
          <Input value={draft.acknowledged_by_name} disabled={busy}
                 onChange={(e) => set("acknowledged_by_name", e.target.value)}
                 placeholder="Name of the person at the supplier"
                 aria-label="Acknowledged by"
                 isInvalid={!draft.acknowledged_by_name.trim()} />
        </Field>
        <Field label="Acknowledged at" required
               hint="Opens at the current time — change it if they signed earlier.">
          <Input type="datetime-local" value={draft.acknowledged_at} disabled={busy}
                 onChange={(e) => set("acknowledged_at", e.target.value)}
                 aria-label="Acknowledged at"
                 isInvalid={!toInstant(draft.acknowledged_at)} />
        </Field>
        <div className="md:col-span-2">
          <Field label="Proof of delivery"
                 hint="Where the signed copy lives — a link, or the reference it was filed under.">
            <Input value={draft.pod_url} disabled={busy}
                   onChange={(e) => set("pod_url", e.target.value)}
                   placeholder="Optional" aria-label="Proof of delivery reference" />
          </Field>
        </div>
      </div>
    </section>
  );
}

function StepComplete({
  draft, chosen, vendor, lines, totalQty, totalValue, reasonLabel, manualEntry,
}: {
  draft: Draft; chosen?: LogisticsModeOption; vendor: WizardVendor;
  lines: WizardLine[]; totalQty: number; totalValue: number;
  reasonLabel: string; manualEntry: boolean;
}) {
  /** The mode's own row, so a hand-over is not summarised with three empty vehicle
   *  fields underneath it. */
  const modeFacts: [string, string | null][] =
    chosen?.needs_carrier
      ? [["Carrier", txt(draft.carrier_name)],
         ["LR / docket", txt(draft.lr_no)],
         ["Freight", draft.freight_amount.trim()
           ? `₹ ${fmtMoney(Number(draft.freight_amount))}` : null]]
      : chosen?.needs_vehicle
        ? [["Vehicle", txt(draft.vehicle_number)],
           ["Driver", txt(draft.driver_name)],
           ["Driver phone", txt(draft.driver_phone)]]
        : [["Carried by", txt(draft.hand_carried_by)]];

  const ackAt = toInstant(draft.acknowledged_at);
  // An own-vehicle leg is handed on rather than finished here, so the last step has to
  // say which of the two this press is about to do. A manual return is neither: it
  // raises no consignment at all, and the note at the foot already explains that.
  const toLogistics = Boolean(chosen?.raises_shipment) && !manualEntry;

  return (
    <section>
      <Legend
        title="Ready to send"
        hint={toLogistics
          ? "Check it over. Sending hands the load to Logistics and cannot be undone."
          : "Check it over. Sending records the return as gone and cannot be undone."}
      />

      <div className="rounded-xl border border-brand/30 bg-brand-050 px-4 py-3 text-sm text-ink">
        Returning <b>{fmtQty(totalQty)}</b> across <b>{lines.length}</b>{" "}
        line{lines.length === 1 ? "" : "s"}
        {totalValue > 0 && <> worth <b>₹ {fmtMoney(totalValue)}</b></>} to{" "}
        <b>{vendor.vendor_name?.trim() || "the vendor"}</b>, {reasonLabel
          ? <>because of <b>{reasonLabel.toLowerCase()}</b></>
          : "with the reason recorded on the return"}.
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        <SummaryBlock title="Logistics" facts={[
          ["Method", chosen?.label ?? null],
          ...modeFacts,
        ]} />
        <SummaryBlock title="Delivering to" facts={[
          ["Address", txt(draft.delivery_address)],
          ["Contact", txt(draft.contact_person)],
          ["Phone", txt(draft.contact_phone)],
        ]} />
        <SummaryBlock title="Shipment" facts={[
          ["Packages", txt(draft.total_packages)],
          ["Weight", draft.total_weight_kg.trim() ? `${draft.total_weight_kg} kg` : null],
          ["E-way bill", txt(draft.eway_bill_no)],
          ["Gate pass", txt(draft.gate_pass_no)],
          ["Expected", txt(draft.expected_delivery)],
        ]} />
        <div className="md:col-span-3">
          {toLogistics ? (
            <div className="rounded-xl border border-info/30 bg-info-bg px-4 py-3 text-sm text-ink">
              <b>What happens next.</b> The consignment is raised and approved, and a{" "}
              <b>draft shipment appears on the Logistics Dispatch board</b>. The desk
              there assigns the vehicle, writes the gate pass and releases the load —
              and that release is what takes the stock out of the warehouse. The
              supplier's signature is recorded on the shipment when it arrives.
            </div>
          ) : (
            <SummaryBlock title="Supplier acknowledgement" facts={[
              ["Acknowledged by", txt(draft.acknowledged_by_name)],
              ["Acknowledged at", ackAt ? new Date(ackAt).toLocaleString() : null],
              ["Proof of delivery", txt(draft.pod_url)],
            ]} />
          )}
        </div>
      </div>

      {manualEntry && (
        <p className="mt-4 rounded-xl border border-warn/30 bg-warn-bg px-4 py-3 text-xs text-warn">
          This return was entered by hand, so no consignment is raised in Logistics —
          those goods were never on this system's books. Everything captured above is
          kept on the return's audit trail instead, and the return itself is recorded
          as sent with the time it went.
        </p>
      )}
    </section>
  );
}

function SummaryBlock({ title, facts }: {
  title: string; facts: [string, string | null][];
}) {
  return (
    <div className="rounded-xl border border-line bg-content1 p-4">
      <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">{title}</h4>
      <dl className="space-y-1.5 text-sm">
        {facts.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3">
            <dt className="shrink-0 text-xs text-muted">{label}</dt>
            <dd className="min-w-0 break-words text-right text-ink">{value ?? "—"}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
