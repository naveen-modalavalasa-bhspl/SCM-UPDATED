import { useQuery } from "@tanstack/react-query";
import { Field, Input, Select } from "@/shared/components";
import { api } from "@/shared/api/client";
import type { POHeader, PurchaseOrder } from "../types";

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

interface PaymentTermRow extends NamedRow {
  is_active: boolean;
  advance_pct: number; advance_days: number; delivery_pct: number; delivery_days: number;
  installation_pct: number; installation_days: number;
  warranty_pct: number; warranty_days: number;
  delivery_schedule?: string | null;
}

const TERM_STAGES = [
  ["advance", "advance"], ["delivery", "against delivery"],
  ["installation", "post installation"], ["warranty", "post warranty"],
] as const;

/** The wording the server writes onto the order for a term, shown at once. */
function termWording(t: PaymentTermRow): string {
  const parts = TERM_STAGES
    .filter(([k]) => Number(t[`${k}_pct`]) > 0)
    .map(([k, label]) => {
      const days = Number(t[`${k}_days`]) || 0;
      if (k === "delivery" && t.delivery_schedule) {
        const parts = t.delivery_schedule.split(",");
        return `${Number(t[`${k}_pct`])}% ${label} in ${parts.length} instalments (${parts.join("/")} days)`;
      }
      return `${Number(t[`${k}_pct`])}% ${label}` + (days ? ` (${days} days)` : "");
    });
  return `${t.name}: ${parts.join(", ")}`;
}

export interface POHeaderValue {
  projectId: number | "";
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
  projectId: "", remarks: "", paymentTermId: "",
  payment_terms: "", delivery_terms: "", material_terms: "", logistics_terms: "",
  billing_address: "", shipping_address: "",
  discount: "", freight: "",
});

/** The header of an order already on the server, in the shape the form edits. */
export const poHeaderFrom = (po: PurchaseOrder): POHeaderValue => ({
  projectId: po.project_id ?? "",
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

export function POHeaderFields({
  value, onChange, disabled = false, showProject = true,
}: {
  value: POHeaderValue;
  onChange: (patch: Partial<POHeaderValue>) => void;
  disabled?: boolean;
  showProject?: boolean;
}) {
  const { data: projects = [] } = useQuery({
    queryKey: ["po-projects"],
    queryFn: () =>
      api.get<{ items: NamedRow[] }>("/api/projects", {
        params: { size: 200, is_active: true },
      }).then((r) => r.data.items),
  });

  const { data: terms = [] } = useQuery({
    queryKey: ["po-payment-terms"],
    queryFn: () =>
      api.get<{ items: PaymentTermRow[] }>("/api/payment-terms", { params: { size: 300 } })
        .then((r) => r.data.items.filter((t) => t.is_active)),
  });

  const set = (key: keyof POHeaderValue) => (v: string) => onChange({ [key]: v });

  return (
    <div className="space-y-5">
      {showProject && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Project" hint="What the spend is booked against.">
            <Select
              value={value.projectId === "" ? "" : String(value.projectId)}
              placeholder="Not stated"
              isDisabled={disabled}
              options={projects.map((p) => ({
                value: String(p.id), label: p.code ? `${p.code} — ${p.name}` : p.name,
              }))}
              onChange={(v) => onChange({ projectId: v ? Number(v) : "" })}
            />
          </Field>
        </div>
      )}

      <LongText
        label="Remarks" rows={2} disabled={disabled}
        hint="Anything the order should say that no other field covers."
        value={value.remarks} onChange={set("remarks")}
      />

      {/* Where the goods are invoiced and where they land. Two different places more
        * often than not, which is why they are two fields and not one. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <LongText label="Billing address" disabled={disabled} required
          value={value.billing_address} onChange={set("billing_address")} />
        <LongText label="Shipping address" disabled={disabled} required
          value={value.shipping_address} onChange={set("shipping_address")} />
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-ink">Terms and conditions</h2>
        <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Payment term"
            hint="Splits the order value into advance / delivery / installation / warranty. Accounts pays against it.">
            <Select
              value={value.paymentTermId === "" ? "" : String(value.paymentTermId)}
              placeholder="Pick a payment term"
              isDisabled={disabled}
              options={terms.map((t) => ({ value: String(t.id), label: termWording(t) }))}
              onChange={(v) => {
                const term = terms.find((t) => String(t.id) === v);
                onChange(term
                  ? { paymentTermId: term.id, payment_terms: termWording(term) }
                  : { paymentTermId: "" });
              }}
            />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <LongText label="Payment terms" disabled={disabled}
            value={value.payment_terms} onChange={set("payment_terms")} />
          <LongText label="Delivery terms" disabled={disabled}
            value={value.delivery_terms} onChange={set("delivery_terms")} />
          <LongText label="Material terms" disabled={disabled}
            value={value.material_terms} onChange={set("material_terms")} />
          <LongText label="Logistics terms" disabled={disabled}
            value={value.logistics_terms} onChange={set("logistics_terms")} />
        </div>
      </div>

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
