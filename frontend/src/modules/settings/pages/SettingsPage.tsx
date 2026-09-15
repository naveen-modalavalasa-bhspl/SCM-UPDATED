import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { Button, Card, Field, Input, PageHeader, Select } from "@/shared/components";
import { mastersApi } from "@/modules/masters/api";
import { settingsApi } from "../api";
import { alerts } from "@/modules/alerts";
import type { AppSettings } from "../types";

const DATE_FORMATS = ["DD-MM-YYYY", "YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"]
  .map((value) => ({ value, label: value }));
const CURRENCIES = ["INR", "USD", "EUR", "GBP"].map((value) => ({ value, label: value }));
const RESET_POLICIES = ["NEVER", "YEARLY", "MONTHLY"].map((value) => ({ value, label: value }));

/** The windows an admin may pick for a vendor's one-time code. A list rather than a
 *  free number box: the server floors at 30 seconds and caps at an hour, and a typed
 *  "5" that comes back as 30 reads as the screen ignoring what was entered. The two
 *  the business named — 30 seconds and 1 minute — are first. */
const OTP_WINDOWS = [
  { value: "30", label: "30 seconds" },
  { value: "60", label: "1 minute" },
  { value: "120", label: "2 minutes" },
  { value: "300", label: "5 minutes" },
  { value: "600", label: "10 minutes" },
  { value: "1800", label: "30 minutes" },
];

/** And for a reset link, which is a different wait: the person is locked out and may
 *  not be at their desk. Minutes, and none of them short. */
const RESET_WINDOWS = [
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "1 hour" },
  { value: "240", label: "4 hours" },
  { value: "1440", label: "24 hours" },
];
const TIMEZONES = ["Asia/Kolkata", "UTC", "Asia/Dubai", "Europe/London"]
  .map((value) => ({ value, label: value }));

const LOGISTICS_DEFAULTS: AppSettings["logistics"] = {
  manual_courier_dispatch: false,
};

const SECURITY_DEFAULTS: AppSettings["security"] = {
  vendor_quote_otp_seconds: 300,
  password_reset_minutes: 30,
};

function normalizeSettings(data: AppSettings): AppSettings {
  const incoming = data as AppSettings & {
    logistics?: Partial<AppSettings["logistics"]> | null;
    security?: Partial<AppSettings["security"]> | null;
  };
  return {
    ...data,
    logistics: {
      ...LOGISTICS_DEFAULTS,
      ...(incoming.logistics ?? {}),
    },
    security: {
      ...SECURITY_DEFAULTS,
      ...(incoming.security ?? {}),
    },
  };
}

function Toggle({
  label, checked, onChange,
}: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-line bg-content1 px-3 py-2">
      <span className="text-sm font-medium text-body">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-brand"
      />
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-4">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted">{title}</h2>
      <div className="grid gap-4 md:grid-cols-2">{children}</div>
    </Card>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState<AppSettings | null>(null);
  const settings = useQuery({ queryKey: ["settings"], queryFn: settingsApi.get });
  const warehouses = useQuery({
    queryKey: ["settings", "warehouses"],
    queryFn: () => mastersApi.warehouses.list({ size: 300 }).then((r) => r.items),
  });
  const save = useMutation({
    mutationFn: settingsApi.update,
    onSuccess: (data) => {
      setForm(normalizeSettings(data));
      qc.invalidateQueries({ queryKey: ["settings"] });
      // The dispatch desk reads the manual-courier choice from its own small policy
      // endpoint rather than from all of Company Settings, so that cache is a second
      // copy of this answer and has to be dropped with this one. Without it a desk
      // already sitting on Dispatch keeps the form for the OLD setting until it is
      // reloaded, which is exactly the "I turned it on and nothing changed" report.
      qc.invalidateQueries({ queryKey: ["transport-dispatch-policy"] });
      qc.invalidateQueries({ queryKey: ["transport-flow"] });
      // Offers a refresh: date format and currency are read at render time all over
      // the app, and screens already mounted keep the old ones until reloaded.
      void alerts.info("settings.changed").then((refreshNow) => {
        if (refreshNow) window.location.reload();
      });
    },
  });

  useEffect(() => {
    if (settings.data) setForm(normalizeSettings(settings.data));
  }, [settings.data]);

  if (!form) {
    return (
      <>
        <PageHeader eyebrow="Settings" title="Company settings" />
        <Card className="p-6 text-sm text-muted">Loading...</Card>
      </>
    );
  }

  const whOptions = [
    { value: "", label: "None" },
    ...(warehouses.data ?? []).map((w) => ({ value: w.id, label: `${w.code} - ${w.name}` })),
  ];
  const set = <G extends keyof AppSettings, K extends keyof AppSettings[G]>(
    group: G, key: K, value: AppSettings[G][K],
  ) => setForm({ ...form, [group]: { ...form[group], [key]: value } });

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Company settings"
        actions={
          <Button onClick={() => save.mutate(form)} disabled={save.isPending}>
            <Save className="h-4 w-4" /> Save
          </Button>
        }
      />

      <div className="space-y-4">
        <Section title="Company">
          <Field label="Company name">
            <Input value={form.company.name} onChange={(e) => set("company", "name", e.target.value)} />
          </Field>
          <Field label="Legal name">
            <Input value={form.company.legal_name} onChange={(e) => set("company", "legal_name", e.target.value)} />
          </Field>
          <Field label="GSTIN">
            <Input value={form.company.gstin} onChange={(e) => set("company", "gstin", e.target.value)} />
          </Field>
          <Field label="Email">
            <Input value={form.company.email} onChange={(e) => set("company", "email", e.target.value)} />
          </Field>
          <Field label="Phone">
            <Input value={form.company.phone} onChange={(e) => set("company", "phone", e.target.value)} />
          </Field>
          <Field label="Address">
            <Input value={form.company.address} onChange={(e) => set("company", "address", e.target.value)} />
          </Field>
        </Section>

        <Section title="Regional">
          <Field label="Fiscal year">
            <Input value={form.regional.fiscal_year} onChange={(e) => set("regional", "fiscal_year", e.target.value)} />
          </Field>
          <Field label="Default warehouse">
            <Select
              value={form.regional.default_warehouse_id ?? ""}
              options={whOptions}
              onChange={(value) => set("regional", "default_warehouse_id", value ? Number(value) : null)}
            />
          </Field>
          <Field label="Currency">
            <Select value={form.regional.currency} options={CURRENCIES}
                    onChange={(value) => set("regional", "currency", value)} />
          </Field>
          <Field label="Date format">
            <Select value={form.regional.date_format} options={DATE_FORMATS}
                    onChange={(value) => set("regional", "date_format", value)} />
          </Field>
          <Field label="Timezone">
            <Select value={form.regional.timezone} options={TIMEZONES}
                    onChange={(value) => set("regional", "timezone", value)} />
          </Field>
        </Section>

        <Section title="HCM Sync">
          <Toggle label="Enabled" checked={form.hcm_sync.enabled}
                  onChange={(value) => set("hcm_sync", "enabled", value)} />
          <Field label="Interval minutes">
            <Input type="number" value={form.hcm_sync.interval_minutes}
                   onChange={(e) => set("hcm_sync", "interval_minutes", Number(e.target.value))} />
          </Field>
        </Section>

        <Section title="Numbering">
          <Field label="Fiscal year prefix">
            <Input value={form.numbering.fiscal_year_prefix}
                   onChange={(e) => set("numbering", "fiscal_year_prefix", e.target.value)} />
          </Field>
          <Field label="Default pattern">
            <Input value={form.numbering.default_pattern}
                   onChange={(e) => set("numbering", "default_pattern", e.target.value)} />
          </Field>
          <Field label="Reset policy">
            <Select value={form.numbering.reset_policy} options={RESET_POLICIES}
                    onChange={(value) => set("numbering", "reset_policy", value)} />
          </Field>
        </Section>

        <Section title="Notifications">
          <Toggle label="In-app" checked={form.notifications.in_app_enabled}
                  onChange={(value) => set("notifications", "in_app_enabled", value)} />
          <Toggle label="Email" checked={form.notifications.email_enabled}
                  onChange={(value) => set("notifications", "email_enabled", value)} />
        </Section>

        <Section title="Receiving">
          <Toggle
            label="Stocking points need an inward process by default"
            checked={form.warehouse.requires_inward_default}
            onChange={(value) => set("warehouse", "requires_inward_default", value)}
          />
          <p className="text-xs text-muted md:col-span-2">
            On: a consignment arriving at an MDP or LIP waits for Material Inward, a GRN
            and QC, and the GRN is what posts the stock. Off: the receiver acknowledges
            the delivery and the stock is credited immediately. This is only the default
            — a stocking point that has answered for itself on the warehouse master
            overrides it.
          </p>
        </Section>

        <Section title="Security">
          <Field label="Vendor quotation OTP expiry">
            <Select
              value={String(form.security.vendor_quote_otp_seconds)}
              options={OTP_WINDOWS}
              onChange={(value) =>
                set("security", "vendor_quote_otp_seconds", Number(value))}
            />
          </Field>
          <Field label="Password reset link expiry">
            <Select
              value={String(form.security.password_reset_minutes)}
              options={RESET_WINDOWS}
              onChange={(value) =>
                set("security", "password_reset_minutes", Number(value))}
            />
          </Field>
          <p className="text-xs text-muted md:col-span-2">
            How long the emailed code lasts before a vendor has to ask for another.
            Enforced on the server when the code is checked, so a shorter window bites
            immediately — including on a screen that is already open. Codes already
            issued keep the window they were issued with. The reset link is a separate
            window on purpose — somebody locked out of their account may be away from
            their desk, and a tender code dying in 30 seconds should not force a reset
            link to.
          </p>
        </Section>

        <Section title="Fallback">
          <Toggle label="Workflow fallback" checked={form.fallback.workflow_fallback_enabled}
                  onChange={(value) => set("fallback", "workflow_fallback_enabled", value)} />
          <Toggle label="Notify admin" checked={form.fallback.notify_admin_on_fallback}
                  onChange={(value) => set("fallback", "notify_admin_on_fallback", value)} />
          <Toggle label="Auto admin fallback" checked={form.fallback.allow_auto_admin_fallback}
                  onChange={(value) => set("fallback", "allow_auto_admin_fallback", value)} />
        </Section>

        <Section title="Dispatch">
          <Toggle
            label="Manual courier dispatch"
            checked={form.logistics.manual_courier_dispatch}
            onChange={(value) => set("logistics", "manual_courier_dispatch", value)}
          />
          <p className="text-xs text-muted md:col-span-2">
            On: Courier dispatches use a typed courier name and move through approval
            and final dispatch at the desk — the collector, their phone number and the
            LR or docket are recorded on the dispatch press, because a typed courier
            has no login to fill them in later. Off: Courier keeps the
            registered-vendor selection and carrier acknowledgement flow.
          </p>
          {/* Said here because this is where somebody would expect otherwise. The two
              flows differ in who fills the journey details in, so a shipment cannot be
              moved between them halfway: changing this would either strand a typed
              courier's name with a vendor dropdown that has nothing to offer it, or
              detach a registered carrier that had already accepted the job. */}
          <p className="text-xs text-muted md:col-span-2">
            Applies to dispatches raised from now on. Shipments already raised keep the
            arrangement they went out with.
          </p>
        </Section>
      </div>
    </>
  );
}
