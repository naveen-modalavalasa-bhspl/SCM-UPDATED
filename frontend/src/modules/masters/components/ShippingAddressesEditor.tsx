import { useEffect, useState } from "react";
import { MapPin, Plus, Star, Trash2 } from "lucide-react";
import { api } from "@/shared/api/client";
import { Field, Input } from "@/shared/components";
import type { Values } from "./MasterCrud";

/**
 * A warehouse's SHIPPING ADDRESSES (2026-11-23): every gate or dock a supplier may
 * deliver to, one of them the default. An RFQ and a purchase order pick one of these
 * after the warehouse; the default is what they open on.
 *
 * Held in the master form as JSON under `__addresses` (form values are scalars), and
 * saved with the warehouse as one set: an address taken off here goes inactive, never
 * deleted, so an order that named it still says what it was.
 */
export interface ShippingAddressDraft {
  id?: number | null;
  label: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  contact_name: string;
  contact_phone: string;
  is_default: boolean;
}

const blank = (n: number, isDefault: boolean): ShippingAddressDraft => ({
  id: null, label: n === 1 ? "Main gate" : `Address ${n}`, address: "", city: "", state: "",
  pincode: "", contact_name: "", contact_phone: "", is_default: isDefault,
});

export const readAddresses = (values: Values): ShippingAddressDraft[] => {
  try { return JSON.parse(String(values.__addresses ?? "[]")) as ShippingAddressDraft[]; }
  catch { return []; }
};

/** What is wrong with the set, in the words the form shows — null when it can be saved. */
export function addressesProblem(list: ShippingAddressDraft[]): string | null {
  const labels = new Set<string>();
  for (const [i, a] of list.entries()) {
    const name = a.label.trim() || `Address ${i + 1}`;
    if (!a.address.trim()) return `${name}: give the address itself.`;
    if (a.pincode.trim() && !/^\d{6}$/.test(a.pincode.trim())) return `${name}: a pincode is 6 digits.`;
    const phone = a.contact_phone.replace(/\s/g, "");
    if (phone && !/^\d{10,12}$/.test(phone)) return `${name}: the contact phone is 10 digits.`;
    if (labels.has(name.toLowerCase())) return `Two addresses are both called “${name}” — give each its own name.`;
    labels.add(name.toLowerCase());
  }
  return null;
}

/** The default's street line, mirrored onto the warehouse's single `address`. */
export const defaultLine = (list: ShippingAddressDraft[]) => {
  const d = list.find((a) => a.is_default) ?? list[0];
  if (!d) return "";
  return [d.address.trim(), d.city.trim(), d.pincode.trim(), d.state.trim()].filter(Boolean).join(", ");
};

export function ShippingAddressesEditor({ values, patch, error }: {
  values: Values;
  patch: (next: Values) => void;
  error?: string;
}) {
  const warehouseId = Number(values.__id) || null;
  const loaded = values.__addresses_loaded === true;
  const [loadError, setLoadError] = useState<string | null>(null);
  const list = readAddresses(values);
  const write = (next: ShippingAddressDraft[]) => patch({ __addresses: JSON.stringify(next) });

  useEffect(() => {
    if (loaded) return;
    if (!warehouseId) { patch({ __addresses_loaded: true, __addresses: "[]" }); return; }
    let live = true;
    api.get<ShippingAddressDraft[]>(`/api/procurement/warehouse-addresses/${warehouseId}`)
      .then((r) => {
        if (!live) return;
        const rows = r.data.map((a) => ({
          id: a.id, label: a.label ?? "", address: a.address ?? "", city: a.city ?? "",
          state: a.state ?? "", pincode: a.pincode ?? "", contact_name: a.contact_name ?? "",
          contact_phone: a.contact_phone ?? "", is_default: Boolean(a.is_default),
        }));
        patch({ __addresses_loaded: true, __addresses: JSON.stringify(rows) });
      })
      .catch(() => live && setLoadError("The shipping addresses could not be loaded — they are left as they are."));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehouseId, loaded]);

  const set = (index: number, change: Partial<ShippingAddressDraft>) =>
    write(list.map((a, i) => (i === index ? { ...a, ...change } : a)));
  const makeDefault = (index: number) =>
    write(list.map((a, i) => ({ ...a, is_default: i === index })));
  const remove = (index: number) => {
    const next = list.filter((_, i) => i !== index);
    if (next.length && !next.some((a) => a.is_default)) next[0] = { ...next[0], is_default: true };
    write(next);
  };

  return (
    <section className="space-y-3 rounded-2xl border border-line bg-content2/30 p-3.5" aria-label="Shipping addresses">
      <header className="flex flex-wrap items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-rose-500 text-white">
          <MapPin className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-ink">Shipping addresses</h3>
          <p className="text-xs text-muted">
            Where suppliers deliver to. RFQs and purchase orders pick one; the <b>default</b> is offered first.
          </p>
        </div>
        {loaded && list.length > 0 && (
          <span className="rounded-full bg-content1 px-2.5 py-1 text-[11px] font-semibold text-muted ring-1 ring-line">
            {list.length} address{list.length === 1 ? "" : "es"}
          </span>
        )}
      </header>

      {loadError && <p className="rounded-lg bg-warn-bg/40 px-3 py-2 text-xs font-semibold text-warn">{loadError}</p>}
      {!loaded && !loadError && <p className="text-xs text-muted">Loading addresses…</p>}

      {loaded && list.length === 0 && (
        <p className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-sm text-muted">
          No shipping address yet. Add one so an RFQ or a purchase order can be delivered here.
        </p>
      )}

      {loaded && list.map((a, index) => (
        <article key={a.id ?? `new-${index}`}
                 className={`space-y-3 rounded-xl bg-content1 p-3 ring-1 ${a.is_default ? "ring-rose-300" : "ring-line"}`}>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 basis-48">
              <Field label="Name of this address" hint="What a buyer sees in the dropdown, e.g. “Main gate”, “Dock 2”.">
                <Input value={a.label} maxLength={100} aria-label={`Address ${index + 1} name`}
                       onChange={(e) => set(index, { label: e.target.value })} />
              </Field>
            </div>
            <button type="button" role="radio" aria-checked={a.is_default}
                    onClick={() => makeDefault(index)}
                    className={`inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold transition-colors ${
                      a.is_default ? "bg-rose-500 text-white" : "border border-line text-muted hover:border-rose-300 hover:text-rose-600"}`}>
              <Star className={`h-4 w-4 ${a.is_default ? "fill-current" : ""}`} aria-hidden />
              {a.is_default ? "Default" : "Make default"}
            </button>
            <button type="button" onClick={() => remove(index)} aria-label={`Remove ${a.label || `address ${index + 1}`}`}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-muted hover:bg-bad-bg hover:text-bad">
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <Field label="Address *">
            <textarea value={a.address} rows={2} maxLength={500} aria-label={`Address ${index + 1}`}
                      placeholder="Door / plot, street, area, landmark"
                      onChange={(e) => set(index, { address: e.target.value })}
                      className="w-full resize-y rounded-xl border border-line bg-content1 px-3 py-2 text-sm text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20" />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="City / town"><Input value={a.city} maxLength={100} onChange={(e) => set(index, { city: e.target.value })} /></Field>
            <Field label="State"><Input value={a.state} maxLength={100} onChange={(e) => set(index, { state: e.target.value })} /></Field>
            <Field label="Pincode" error={a.pincode.trim() && !/^\d{6}$/.test(a.pincode.trim()) ? "6 digits" : undefined}>
              <Input value={a.pincode} inputMode="numeric" maxLength={6}
                     onChange={(e) => set(index, { pincode: e.target.value.replace(/\D/g, "") })} />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Contact at the gate" hint="Who the driver asks for.">
              <Input value={a.contact_name} maxLength={150} onChange={(e) => set(index, { contact_name: e.target.value })} />
            </Field>
            <Field label="Contact phone" error={a.contact_phone && !/^\d{10,12}$/.test(a.contact_phone.replace(/\s/g, "")) ? "10 digits" : undefined}>
              <Input value={a.contact_phone} inputMode="tel" maxLength={14}
                     onChange={(e) => set(index, { contact_phone: e.target.value.replace(/[^\d ]/g, "") })} />
            </Field>
          </div>
        </article>
      ))}

      {loaded && (
        <button type="button" onClick={() => write([...list, blank(list.length + 1, list.length === 0)])}
                className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-rose-300 text-sm font-semibold text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10">
          <Plus className="h-4 w-4" aria-hidden /> Add shipping address
        </button>
      )}
      {error && <p className="text-xs font-semibold text-bad" role="alert">{error}</p>}
    </section>
  );
}
