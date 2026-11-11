import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Field, Input, Select } from "@/shared/components";
import { api } from "@/shared/api/client";
import type { POHeader, PurchaseOrder } from "../types";
import type { MasterPaymentTerm } from "@/modules/masters/types";
import { PaymentPlanPreview } from "@/modules/masters/components/PaymentPlanEditor";
import { planInstalments } from "@/modules/masters/paymentPlan";
import { CalendarClock, Check, Copy, FileText, MapPin, Pencil } from "lucide-react";

/**
 * Everything a purchase order says beyond its lines: what it is booked against, what
 * was agreed in words, where it is invoiced and where it lands, and the two amounts
 * that belong to the document rather than to any line.
 *
 * One component because two screens ask for them and they must be the same fields on
 * both. A PO typed by hand and a PO written from a won tender are the same document —
 * before this, only the typed one could carry a payment term, so an order raised off
 * an award printed blank and the buyer had nowhere to put what was negotiated.
 */

interface NamedRow { id: number; code?: string | null; name: string }

/** A payment-term master row. Its `wording` ("[CODE] Name" then a line per stage,
 *  each led by its milestone code) is written by the server — the same text the
 *  order stores — so the screen never composes its own version of a term. */
type PaymentTermRow = MasterPaymentTerm;

export interface POHeaderValue {
  fiscalYear: string;
  organizationName?: string;
  projectName?: string;
  departmentName?: string;
  organizationId: number | "";
  /** Booked to an organisation department instead of a project: exactly one of the two. */
  orgDepartmentId: number | "";
  projectId: number | "";
  /** HCM's department, only on an order raised before organisations (`legacy`). */
  departmentId: number | "";
  /** Raised before organisations: keeps its old fields and is asked for nothing new. */
  legacy?: boolean;
  /** Written off an RFQ: the organisation came from there. */
  orgLocked?: boolean;
  /** Past a draft: organisation, department and project are all fixed. */
  bookingLocked?: boolean;
  remarks: string;
  /** The payment-term master picked, or "" for none. */
  paymentTermId: number | "";
  payment_terms: string;
  delivery_terms: string;
  material_terms: string;
  logistics_terms: string;
  billing_address: string;
  shipping_address: string;
  discount: string;
  freight: string;
}

export const blankPOHeader = (): POHeaderValue => ({
  organizationId: "", orgDepartmentId: "", fiscalYear: "",
  projectId: "", departmentId: "", remarks: "", paymentTermId: "",
  payment_terms: "", delivery_terms: "", material_terms: "", logistics_terms: "",
  billing_address: "", shipping_address: "",
  discount: "", freight: "",
});

/** The header of an order already on the server, in the shape the form edits. */
export const poHeaderFrom = (po: PurchaseOrder): POHeaderValue => ({
  organizationId: po.organization_id ?? "",
  orgDepartmentId: po.org_department_id ?? "",
  fiscalYear: po.fiscal_year ?? "",
  organizationName: po.organization_name ?? "",
  projectName: po.project_name ?? "",
  departmentName: po.org_department_name ?? "",
  legacy: !po.organization_id,
  orgLocked: Boolean(po.rfq_id),
  bookingLocked: Boolean(po.organization_id) && po.status !== "DRAFT",
  projectId: po.project_id ?? "",
  departmentId: po.department_id ?? "",
  remarks: po.remarks ?? "",
  paymentTermId: po.payment_term_id ?? "",
  payment_terms: po.payment_terms ?? "",
  delivery_terms: po.delivery_terms ?? "",
  material_terms: po.material_terms ?? "",
  logistics_terms: po.logistics_terms ?? "",
  billing_address: po.billing_address ?? "",
  shipping_address: po.shipping_address ?? "",
  discount: String(po.discount_amount ?? 0),
  freight: String(po.freight_amount ?? 0),
});

/** What goes on the wire.
 *
 * REVISED 2026-08-23. The six term/address fields now send "" rather than null when
 * the box is empty, because the server draws its line there: null means "this payload
 * says nothing about that field, keep what is on the order", and "" means "the buyer
 * cleared it". Sending null for a blank box was what let a screen that had not loaded
 * its values wipe every term on the document just by pressing Save — and now that the
 * server ignores null, "" is the only way a buyer can still take a term back OFF.
 * See `_apply_po_header` in procurement/service.py; the two halves must agree.
 *
 * `discount` and `freight` are always sent: they are the form's own numbers, an empty
 * box genuinely means zero, and both columns are NOT NULL.
 */
export const poHeaderPayload = (v: POHeaderValue): POHeader => ({
  project_id: v.projectId === "" ? null : Number(v.projectId),
  ...(v.legacy
    ? { department_id: v.projectId !== "" || v.departmentId === "" ? null : Number(v.departmentId) }
    : {
      organization_id: v.organizationId === "" ? null : Number(v.organizationId),
      org_department_id: v.projectId !== "" || v.orgDepartmentId === "" ? null : Number(v.orgDepartmentId),
      fiscal_year: v.fiscalYear || null,
    }),
  remarks: v.remarks || null,
  payment_term_id: v.paymentTermId === "" ? null : Number(v.paymentTermId),
  payment_terms: v.payment_terms ?? "",
  delivery_terms: v.delivery_terms ?? "",
  material_terms: v.material_terms ?? "",
  logistics_terms: v.logistics_terms ?? "",
  billing_address: v.billing_address ?? "",
  shipping_address: v.shipping_address ?? "",
  discount_amount: Number(v.discount || 0),
  freight_amount: Number(v.freight || 0),
});

/** Long text on the order: a term is what was agreed with THIS vendor, so it is typed
 *  rather than picked. Local to the module — `@/shared/components` has no textarea. */
/** BUG_SCM_016: both addresses are mandatory (`_assert_po_addresses` on the server
 *  refuses create and submit without them). The sentence to show, or null. */
export function poMissingAddresses(v: POHeaderValue): string | null {
  const missing = [
    ["Billing address", v.billing_address],
    ["Shipping address", v.shipping_address],
  ].filter(([, value]) => !(value ?? "").trim()).map(([label]) => label);
  if (!missing.length) return null;
  return `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} required.`;
}

export function LongText({
  label, hint, value, onChange, rows = 3, disabled = false, required = false,
}: {
  label: string; hint?: string; value: string;
  onChange: (v: string) => void; rows?: number; disabled?: boolean; required?: boolean;
}) {
  return (
    <Field label={label} hint={hint} required={required}>
      <textarea
        rows={rows}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-line bg-content1 p-3 text-sm text-ink disabled:opacity-60"
      />
    </Field>
  );
}

const rupeesText = (n: number) =>
  `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Copies a field's text — an address is usually wanted somewhere else verbatim. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={`Copy ${label.toLowerCase()}`}
      aria-label={`Copy ${label.toLowerCase()}`}
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }).catch(() => undefined);
      }}
      className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[10px] font-semibold normal-case tracking-normal text-muted transition-colors hover:bg-content2 hover:text-ink"
    >
      {done ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      {done ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * A saved address or term, read. Every character is shown — long unbroken text wraps
 * anywhere rather than running out of its card — and the server's term wording
 * ("[CODE] Name", then "• ADV: …" per stage) is drawn as a heading and a list with the
 * milestone code as a chip, instead of one dense paragraph.
 */
function ReadText({ text }: { text: string }) {
  if (!text.trim()) return <div className="text-sm italic text-muted">Not stated</div>;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const blocks: ReactNode[] = [];
  let bullets: ReactNode[] = [];
  const flush = () => {
    if (!bullets.length) return;
    blocks.push(<ul key={`ul-${blocks.length}`} className="space-y-1.5">{bullets}</ul>);
    bullets = [];
  };
  lines.forEach((line, i) => {
    const bullet = line.match(/^[•\-*·]\s*(.*)$/);
    if (bullet) {
      const coded = bullet[1].match(/^([A-Z]{2,6}):\s*(.*)$/);
      bullets.push(
        <li key={i} className="flex min-w-0 items-start gap-2">
          {coded ? (
            <span className="mt-0.5 shrink-0 rounded bg-violet-100 px-1.5 py-0.5 font-mono text-[10px] font-bold text-violet-700 dark:bg-violet-500/20 dark:text-violet-200">{coded[1]}</span>
          ) : (
            <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-40" />
          )}
          <span className="min-w-0 flex-1">{coded ? coded[2] : bullet[1]}</span>
        </li>,
      );
      return;
    }
    flush();
    const head = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    blocks.push(head ? (
      <div key={i} className="flex min-w-0 flex-wrap items-start gap-2 font-semibold">
        <span className="shrink-0 rounded-md bg-content2 px-1.5 py-0.5 font-mono text-[11px] font-bold">{head[1]}</span>
        <span className="min-w-0 flex-1">{head[2]}</span>
      </div>
    ) : <p key={i}>{line}</p>);
  });
  flush();
  return (
    <div className="space-y-2 text-sm font-medium leading-6 text-ink [overflow-wrap:anywhere]">{blocks}</div>
  );
}

export type AddressTermKey = "billing_address" | "shipping_address" | "payment_terms"
  | "delivery_terms" | "material_terms" | "logistics_terms";
const ADDRESS_FIELDS = [
  { key: "billing_address", label: "Billing address", placeholder: "Company name, street, city, state, PIN, GSTIN" },
  { key: "shipping_address", label: "Shipping address", placeholder: "Where the goods are to be delivered" },
] as const;
const TERM_FIELDS = [
  { key: "payment_terms", label: "Payment terms", placeholder: "e.g. 30 days from receipt of invoice" },
  { key: "delivery_terms", label: "Delivery terms", placeholder: "e.g. Door delivery within 10 days of PO" },
  { key: "material_terms", label: "Material terms", placeholder: "e.g. Minimum 80% shelf life on receipt" },
  { key: "logistics_terms", label: "Logistics terms", placeholder: "e.g. Freight and unloading by the supplier" },
] as const;

/**
 * Addresses and Terms & conditions as the PO page draws them (2026-10-26): a rose
 * card and a violet card, the payment-term master picker with the plan it makes, and
 * every field a box while it may be edited. One component for the draft page's inline
 * edit, Edit draft, a correction and a new order — so they all read alike.
 */
export function AddressesTermsCards({
  value, onChange, editable, orderTotal, changed = [], editableNote,
}: {
  value: Pick<POHeaderValue, AddressTermKey | "paymentTermId">;
  onChange: (patch: Partial<POHeaderValue>) => void;
  editable: boolean;
  orderTotal?: number;
  /** Fields that differ from what is saved, tagged "edited". */
  changed?: string[];
  /** The note beside each card's title while editable. */
  editableNote?: string;
}) {
  const { data: terms = [] } = useQuery({
    queryKey: ["po-payment-terms"],
    queryFn: () =>
      api.get<{ items: PaymentTermRow[] }>("/api/payment-terms", { params: { size: 300 } })
        .then((r) => r.data.items.filter((t) => t.is_active)),
  });
  const pickedTerm = terms.find((t) => String(t.id) === String(value.paymentTermId));

  const box = (key: AddressTermKey, label: string, placeholder: string,
               ring: string, tone: string, rows: number, wide = false) => {
    const edited = changed.includes(key);
    const text = value[key] ?? "";
    return (
      <div key={key}
           className={`flex min-w-0 flex-col rounded-xl bg-white p-3.5 ring-1 dark:bg-content1 ${edited ? "ring-brand/50" : ring} ${wide ? "sm:col-span-2" : ""}`}>
        <div className={`flex min-h-6 items-center justify-between gap-2 text-[11px] font-bold uppercase tracking-widest ${tone}`}>
          <span>{label}</span>
          <span className="flex items-center gap-1.5">
            {edited && <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-brand">edited</span>}
            {!editable && text.trim() && <CopyButton text={text} label={label} />}
          </span>
        </div>
        {editable ? (
          <textarea
            value={text}
            rows={rows}
            placeholder={placeholder}
            aria-label={label}
            onChange={(e) => onChange({ [key]: e.target.value })}
            className="mt-1.5 w-full resize-y rounded-lg border border-line/70 bg-content1 px-3 py-2 text-sm leading-6 text-ink outline-none transition-colors [field-sizing:content] [overflow-wrap:anywhere] placeholder:text-muted/70 focus:border-brand focus:ring-2 focus:ring-brand/15"
            style={{ minHeight: `${rows * 1.5 + 1}rem` }}
          />
        ) : (
          <div className="mt-1.5"><ReadText text={text} /></div>
        )}
      </div>
    );
  };
  /** A term long enough to be cramped in half the card takes the whole row. */
  const isLong = (key: AddressTermKey) => {
    const t = value[key] ?? "";
    return t.length > 220 || t.split("\n").length > 4;
  };
  const note = editable && editableNote ? (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold opacity-80">
      <Pencil className="h-3 w-3" /> {editableNote}
    </span>
  ) : null;

  return (
    <div className="space-y-4">
      {/* ── Addresses — rose block ── */}
      <div className="overflow-hidden rounded-2xl border border-rose-200 bg-gradient-to-br from-rose-50 via-pink-50 to-white shadow-sm">
        <div className="h-1 w-full bg-gradient-to-r from-rose-400 via-pink-400 to-rose-500" />
        <div className="p-4 sm:p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-rose-700">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-rose-500 text-white"><MapPin className="h-4 w-4" /></div>
              <h2 className="text-sm font-extrabold uppercase tracking-widest">Addresses</h2>
            </div>
            {note}
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {ADDRESS_FIELDS.map((f) => box(f.key, f.label, f.placeholder, "ring-rose-100", "text-rose-700/80", 4))}
          </div>
        </div>
      </div>

      {/* ── Terms — violet block ── */}
      <div className="overflow-hidden rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 via-purple-50 to-white shadow-sm">
        <div className="h-1 w-full bg-gradient-to-r from-violet-500 via-purple-500 to-fuchsia-500" />
        <div className="p-4 sm:p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-violet-700">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-violet-600 text-white"><FileText className="h-4 w-4" /></div>
              <h2 className="text-sm font-extrabold uppercase tracking-widest">Terms & conditions</h2>
            </div>
            {note}
          </div>

          {/* The payment-term master: picking one fills the wording below and puts its
              milestones on the order when it is saved. */}
          {(editable || pickedTerm) && (
            <div className={`mb-4 rounded-xl bg-white p-3.5 ring-1 dark:bg-content1 ${changed.includes("payment_term_id") ? "ring-brand/50" : "ring-violet-100"}`}>
              <div className="min-w-0 space-y-2">
                <div>
                  <div className="mb-1.5 flex items-center justify-between text-[11px] font-bold uppercase tracking-widest text-violet-700/80">
                    Payment term
                    {changed.includes("payment_term_id") && <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-brand">edited</span>}
                  </div>
                  {editable ? (
                    <Select
                      value={value.paymentTermId === "" ? "" : String(value.paymentTermId)}
                      placeholder="Pick a payment term"
                      ariaLabel="Payment term"
                      options={terms.map((t) => ({ value: String(t.id), label: `${t.code} — ${t.name}` }))}
                      onChange={(v) => {
                        const term = terms.find((t) => String(t.id) === String(v));
                        onChange(term
                          ? { paymentTermId: term.id, payment_terms: term.wording ?? value.payment_terms }
                          : { paymentTermId: "" });
                      }}
                    />
                  ) : pickedTerm ? (
                    <div className="flex min-w-0 flex-wrap items-start gap-2">
                      <span className="shrink-0 rounded-md bg-violet-600 px-2 py-0.5 font-mono text-xs font-bold text-white">{pickedTerm.code}</span>
                      <span className="min-w-0 flex-1 text-[15px] font-semibold leading-6 text-ink [overflow-wrap:anywhere]">{pickedTerm.name}</span>
                    </div>
                  ) : (
                    <div className="text-sm italic text-muted">Not stated</div>
                  )}
                </div>
                {/* What the term does, in a full-width sentence — it was a tiny grey
                    column beside the name, and the part people actually needed to read. */}
                <p className="rounded-lg bg-violet-50/70 px-3 py-2 text-sm leading-6 text-ink/80 [overflow-wrap:anywhere] dark:bg-violet-500/10">
                  {pickedTerm?.summary ?? "Splits the order value into advance / delivery / installation / warranty — accounts pays against it."}
                </p>
              </div>
              {pickedTerm && (
                <div className="mt-3 rounded-xl border border-line bg-content1 p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <CalendarClock className="h-4 w-4 text-brand" />
                    <h3 className="text-sm font-semibold text-ink">How this order will be paid</h3>
                    <span className="rounded-md bg-content2 px-2 py-0.5 font-mono text-xs font-bold text-ink">{pickedTerm.code}</span>
                    {orderTotal && orderTotal > 0 ? (
                      <span className="ml-auto text-xs text-muted">on an order of <b className="tabular-nums text-ink">{rupeesText(orderTotal)}</b></span>
                    ) : null}
                  </div>
                  <PaymentPlanPreview instalments={planInstalments(pickedTerm)}
                                      amount={orderTotal && orderTotal > 0 ? orderTotal : 0} />
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {TERM_FIELDS.map((f) => box(f.key, f.label, f.placeholder, "ring-violet-100", "text-violet-700/80", 3,
                                        !editable && isLong(f.key)))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function POHeaderFields({
  value, onChange, disabled = false, showProject = true, orderTotal,
  requireOne = false, showInvalid = false,
}: {
  value: POHeaderValue;
  /** Project OR department is mandatory here (a hand-raised order). */
  requireOne?: boolean;
  /** Mark both boxes once a save was refused for having neither. */
  showInvalid?: boolean;
  onChange: (patch: Partial<POHeaderValue>) => void;
  disabled?: boolean;
  showProject?: boolean;
  /** The order's grand total, when the page knows it — the timeline then shows rupees. */
  orderTotal?: number;
}) {
  const { data: projects = [] } = useQuery({
    queryKey: ["po-projects"],
    queryFn: () =>
      api.get<{ items: NamedRow[] }>("/api/projects", {
        params: { size: 200, is_active: true },
      }).then((r) => r.data.items),
  });

  const legacy = Boolean(value.legacy);
  const { data: departments = [] } = useQuery({
    queryKey: ["po-departments"],
    enabled: legacy,
    queryFn: () =>
      api.get<{ items: NamedRow[] }>("/api/departments").then((r) => {
        // The HCM mirror repeats a name across offices; one option per name.
        const seen = new Map<string, NamedRow>();
        for (const row of r.data.items) if (!seen.has(row.name)) seen.set(row.name, row);
        return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
      }),
  });

  const set = (key: keyof POHeaderValue) => (v: string) => onChange({ [key]: v });
  const chosenDepartment = value.departmentId;
  const neither = value.projectId === "" && chosenDepartment === "";
  const bookingDisabled = disabled || Boolean(value.bookingLocked);

  return (
    <div className="space-y-5">
      {/* An organised order states all of this on the DocumentNumberCard. */}
      {showProject && legacy && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* A project OR a department — exactly one (2026-11-04). Picking one
            * clears the other; the server refuses both, and a new order with neither. */}
          <Field label={requireOne ? "Project *" : "Project"}
                 hint={chosenDepartment !== "" ? "Booked to a department instead."
                   : "What the spend is booked against — or pick a department."}>
            <Select
              value={value.projectId === "" ? "" : String(value.projectId)}
              placeholder="Not stated"
              isDisabled={bookingDisabled}
              isInvalid={requireOne && showInvalid && neither}
              options={projects.map((p) => ({
                value: String(p.id), label: p.code ? `${p.code} — ${p.name}` : p.name,
              }))}
              onChange={(v) => onChange(v ? { projectId: Number(v), departmentId: "" }
                                          : { projectId: "" })}
            />
          </Field>
          <Field label={requireOne ? "Department *" : "Department"}
                 hint={value.projectId !== "" ? "Booked to a project instead."
                   : "Or book it to a department — one of the two."}>
            <Select
              value={chosenDepartment === "" ? "" : String(chosenDepartment)}
              placeholder="Not stated"
              isDisabled={bookingDisabled}
              isInvalid={requireOne && showInvalid && neither}
              options={departments.map((d) => ({ value: String(d.id), label: d.name }))}
              onChange={(v) => onChange(v ? { departmentId: Number(v), projectId: "" }
                                          : { departmentId: "" })}
            />
          </Field>
        </div>
      )}

      <LongText
        label="Remarks" rows={2} disabled={disabled}
        hint="Anything the order should say that no other field covers."
        value={value.remarks} onChange={set("remarks")}
      />

      {/* Addresses and terms — the same cards the PO page shows (2026-10-26). */}
      <AddressesTermsCards value={value} onChange={onChange} editable={!disabled}
                           orderTotal={orderTotal} />

      {/* Document money. The sub-total and the tax are the sum of the lines and are
        * never typed; these two are applied to the order as a whole. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Discount" hint="Off the whole order, before tax is added.">
          <Input type="number" min="0" step="0.01" placeholder="0.00"
            value={value.discount} disabled={disabled}
            onChange={(e) => onChange({ discount: e.target.value })} />
        </Field>
        <Field label="Freight" hint="Carriage the company pays on this order.">
          <Input type="number" min="0" step="0.01" placeholder="0.00"
            value={value.freight} disabled={disabled}
            onChange={(e) => onChange({ freight: e.target.value })} />
        </Field>
      </div>
    </div>
  );
}
