import { mastersApi } from "../api";
import { MasterCrud } from "../components/MasterCrud";
import type { Option } from "../components/MasterCrud";
import type { MasterVendor, MasterVendorCategory, MasterVendorItem } from "../types";
import type { Column } from "@/shared/components";
import { useQuery } from "@tanstack/react-query";
import { Active, Code } from "./common";
import { VENDOR_TYPES } from "./constants";


/** What each vendor charges for each item. Fifty of these rows were already in the
 *  live table with no screen to show them; procurement prices a PO off this. */

/** What each vendor charges for each item. Fifty of these rows were already in the
 *  live table with no screen to show them; procurement prices a PO off this. */
export function VendorItemsTab({ items }: { items: Option[] }) {
  const vendors = useQuery({
    queryKey: ["masters", "vendors", "all"],
    queryFn: () => mastersApi.vendors.list({ size: 300 }).then((r) => r.items),
  });
  const vendorOpts: Option[] = (vendors.data ?? [])
    .map((v) => ({ value: v.id, label: `${v.code} — ${v.name}` }));
  const money = (value?: number | null) =>
    value == null ? "—" : new Intl.NumberFormat(undefined, {
      minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

  return (
    <MasterCrud<MasterVendorItem>
      title="Vendor rate" queryKey="vendor-items" searchable
      managePerm="master.vendor.manage" bulk={mastersApi.vendorItems}
      columns={[
        { key: "vendor", header: "Vendor", render: (r) => r.vendor_name ?? r.vendor_id },
        { key: "item", header: "Item", render: (r) => (
            <span><Code>{r.item_code ?? "—"}</Code> {r.item_name ?? ""}</span>) },
        { key: "their_code", header: "Their code", hideOnNarrow: true,
          render: (r) => r.vendor_item_code ?? "—" },
        { key: "rate", header: "Rate", render: (r) => money(r.last_rate) },
        { key: "lead", header: "Lead days", hideOnNarrow: true,
          render: (r) => r.lead_time_days ?? "—" },
        { key: "moq", header: "Min order", hideOnNarrow: true,
          render: (r) => r.min_order_qty ?? "—" },
        { key: "preferred", header: "Preferred",
          render: (r) => r.is_preferred
            ? <span className="rounded-full bg-brand-050 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-brand">Preferred</span>
            : "—" },
      ]}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Code>{r.item_code ?? "—"}</Code>
            {r.is_preferred && <span className="text-[11px] font-semibold uppercase text-brand">Preferred</span>}
          </div>
          <div className="text-sm text-body">{r.item_name}</div>
          <div className="text-xs text-muted">
            {r.vendor_name} · {money(r.last_rate)} · {r.lead_time_days ?? "—"} days
          </div>
        </div>
      )}
      fetchList={(search) => mastersApi.vendorItems.list({ search, size: 200 })
        .then((p) => p.items)}
      fields={[
        { key: "vendor_id", label: "Vendor", type: "select", required: true,
          options: vendorOpts },
        { key: "item_id", label: "Item", type: "select", required: true,
          options: items },
        { key: "vendor_item_code", label: "Their item code", maxLength: 50 },
        { key: "last_rate", label: "Rate", type: "number", min: 0 },
        { key: "lead_time_days", label: "Lead time (days)", type: "number",
          min: 0, max: 3650 },
        { key: "min_order_qty", label: "Minimum order qty", type: "number", min: 0 },
        { key: "is_preferred", label: "Preferred supplier", type: "switch",
          hint: "Ticking this unticks whichever vendor was preferred for the item before." },
      ]}
      emptyForm={{ vendor_id: "", item_id: "", vendor_item_code: "", last_rate: "",
                   lead_time_days: "", min_order_qty: "", is_preferred: false }}
      toForm={(r) => ({ vendor_id: r.vendor_id, item_id: r.item_id,
        vendor_item_code: r.vendor_item_code ?? "", last_rate: r.last_rate ?? "",
        lead_time_days: r.lead_time_days ?? "", min_order_qty: r.min_order_qty ?? "",
        is_preferred: r.is_preferred })}
      onCreate={(v) => mastersApi.vendorItems.create(v as Partial<MasterVendorItem>)}
      onUpdate={(id, v) => mastersApi.vendorItems.update(id, v as Partial<MasterVendorItem>)}
      /* mst_vendor_items has no is_active column, so there is nothing to deactivate. */
    />
  );
}

/** Vendor categories: how suppliers are grouped. Vendors are tagged here or on the
 *  vendor's own form — both edit the same link. */
export function VendorCategoriesTab() {
  const vendors = useQuery({
    queryKey: ["masters", "vendors", "all"],
    queryFn: () => mastersApi.vendors.list({ size: 300 }).then((r) => r.items),
  });
  const vendorOpts: Option[] = (vendors.data ?? []).map((v) => ({
    value: v.id, label: `${v.code} · ${v.name}` }));
  return (
    <MasterCrud<MasterVendorCategory>
      title="Vendor category" queryKey="vendor-categories" searchable
      managePerm="master.vendor.manage"
      columns={[
        { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
        { key: "name", header: "Name", render: (r) => r.name },
        { key: "vendors", header: "Vendors", render: (r) => r.vendor_ids.length },
        { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
      ]}
      renderCard={(r) => (
        <div className="flex items-center justify-between">
          <div><Code>{r.code}</Code><div className="text-sm text-body">{r.name}</div>
            <div className="text-xs text-muted">{r.vendor_ids.length} vendor(s)</div></div>
          <Active on={r.is_active} />
        </div>
      )}
      fetchList={() => mastersApi.vendorCategories.list({ size: 300 }).then((p) => p.items)}
      fields={[
        { key: "name", label: "Name", required: true, maxLength: 150 },
        { key: "code", label: "Code", required: true },
        { key: "description", label: "Description", maxLength: 300 },
        { key: "vendor_ids", label: "Vendors in this category", type: "multiselect",
          options: vendorOpts },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ name: "", code: "", description: "", vendor_ids: [], is_active: true }}
      toForm={(r) => ({ name: r.name, code: r.code, description: r.description ?? "",
        vendor_ids: r.vendor_ids, is_active: r.is_active })}
      bulk={mastersApi.vendorCategories} usage={mastersApi.vendorCategories.usage}
      onCreate={(v) => mastersApi.vendorCategories.create(v as Partial<MasterVendorCategory>)}
      onUpdate={(id, v) => mastersApi.vendorCategories.update(id, v as Partial<MasterVendorCategory>)}
      onDeactivate={mastersApi.vendorCategories.deactivate}
    />
  );
}

export function VendorsTab() {
  const categories = useQuery({
    queryKey: ["masters", "vendor-categories", "options"],
    queryFn: () => mastersApi.vendorCategories.list({ size: 300 }).then((p) => p.items),
  });
  const categoryOpts: Option[] = (categories.data ?? []).filter((c) => c.is_active)
    .map((c) => ({ value: c.id, label: c.name }));
  const columns: Column<MasterVendor>[] = [
    { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
    { key: "name", header: "Name", render: (r) => r.name },
    { key: "contact", header: "Contact", render: (r) => r.contact_person ?? "—", hideOnNarrow: true },
    { key: "phone", header: "Phone", render: (r) => r.phone ?? "—", hideOnNarrow: true },
    { key: "gstin", header: "GSTIN", render: (r) => r.gstin ?? "—", hideOnNarrow: true },
    { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
  ];
  return (
    <MasterCrud<MasterVendor>
      title="Vendor" queryKey="vendors" searchable managePerm="master.vendor.manage"
      columns={columns}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Code>{r.code}</Code><Active on={r.is_active} />
          </div>
          <div className="text-sm text-body">{r.name}</div>
          <div className="text-xs text-muted">{r.contact_person ?? "—"} · {r.phone ?? "—"}</div>
        </div>
      )}
      fetchList={(search) => mastersApi.vendors.list({ search, size: 100 }).then((p) => p.items)}
      fields={[
        { key: "code", label: "Vendor code", required: true, maxLength: 8,
          hint: "A number of 6 to 8 digits, e.g. 100245.",
          validate: (v, all) => {
            const text = String(v ?? "").trim();
            return /^\d{6,8}$/.test(text) || text === all._orig_code
              ? null : "Vendor code must be a number of 6 to 8 digits, e.g. 100245.";
          } },
        { key: "name", label: "Name", required: true },
        { key: "contact_person", label: "Contact person", maxLength: 150 },
        { key: "phone", label: "Phone", maxLength: 30,
          pattern: /^[0-9+\-() ]{6,}$/,
          patternMessage: "Digits, spaces and + - ( ) only, at least 6" },
        { key: "email", label: "Email", maxLength: 200,
          pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
          patternMessage: "That does not look like an email address" },
        { key: "address", label: "Address", maxLength: 500 },
        { key: "city", label: "City", maxLength: 100 },
        { key: "state", label: "State", maxLength: 100 },
        { key: "pincode", label: "PIN code", maxLength: 10,
          pattern: /^[0-9]{6}$/, patternMessage: "A PIN code is 6 digits" },
        // 2-digit state code, 10-char PAN, entity digit, Z, checksum.
        { key: "gstin", label: "GSTIN", maxLength: 15,
          pattern: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/,
          patternMessage: "A GSTIN is 15 characters, e.g. 27AAPFU0939F1ZV" },
        { key: "pan", label: "PAN", maxLength: 10,
          pattern: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
          patternMessage: "A PAN is 10 characters, e.g. AAPFU0939F" },
        { key: "vendor_type", label: "Vendor type", type: "select",
          options: VENDOR_TYPES },
        { key: "payment_terms_days", label: "Payment terms (days)", type: "number",
          min: 0, max: 365 },
        { key: "credit_limit", label: "Credit limit", type: "number", min: 0 },
        { key: "rating", label: "Rating (0–5)", type: "number", min: 0, max: 5 },
        { key: "is_approved", label: "Approved", type: "switch" },
        // Kept separate from Active: a blacklisted vendor is still a real record you
        // want to see and to keep out of procurement, not one you want to hide.
        { key: "is_blacklisted", label: "Blacklisted", type: "switch" },
        { key: "category_ids", label: "Vendor categories", type: "multiselect",
          options: categoryOpts, hint: "Add more under Masters › Vendor Categories." },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ code: "", name: "", vendor_type: "MATERIAL", contact_person: "",
                   phone: "", email: "", address: "", city: "", state: "", pincode: "",
                   gstin: "", pan: "", payment_terms_days: "", credit_limit: "",
                   rating: "", is_approved: false, is_blacklisted: false, category_ids: [],
                   is_active: true }}
      toForm={(r) => ({ code: r.code, _orig_code: r.code, name: r.name,
        category_ids: r.category_ids ?? [],
        vendor_type: r.vendor_type ?? "MATERIAL",
        contact_person: r.contact_person ?? "",
        phone: r.phone ?? "", email: r.email ?? "", address: r.address ?? "",
        city: r.city ?? "", state: r.state ?? "", pincode: r.pincode ?? "",
        gstin: r.gstin ?? "", pan: r.pan ?? "",
        payment_terms_days: r.payment_terms_days ?? "",
        credit_limit: r.credit_limit ?? "", rating: r.rating ?? "",
        is_approved: Boolean(r.is_approved),
        is_blacklisted: Boolean(r.is_blacklisted), is_active: r.is_active })}
      bulk={mastersApi.vendors} usage={mastersApi.vendors.usage}
      onCreate={(v) => mastersApi.vendors.create(v as Partial<MasterVendor>)}
      onUpdate={(id, v) => mastersApi.vendors.update(id, v as Partial<MasterVendor>)}
      onDeactivate={mastersApi.vendors.deactivate}
    />
  );
}
