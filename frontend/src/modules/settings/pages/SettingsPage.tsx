import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, Moon, Save, Sun } from "lucide-react";
import { Button, Card, Field, Input, PageHeader, Select } from "@/shared/components";
import { getTheme, setTheme, THEME_OPTIONS, type ThemeChoice } from "@/shared/theme";
import { mastersApi } from "@/modules/masters/api";
import { settingsApi } from "../api";
import { alerts } from "@/modules/alerts";
import type { AppSettings } from "../types";

const DATE_FORMATS = ["DD-MM-YYYY", "YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"]
  .map((value) => ({ value, label: value }));
const CURRENCIES = ["INR", "USD", "EUR", "GBP"].map((value) => ({ value, label: value }));
const RESET_POLICIES = ["NEVER", "YEARLY", "MONTHLY"].map((value) => ({ value, label: value }));
const TIMEZONES = ["Asia/Kolkata", "UTC", "Asia/Dubai", "Europe/London"]
  .map((value) => ({ value, label: value }));

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

const THEME_ICONS: Record<ThemeChoice, React.ReactNode> = {
  light: <Sun className="h-4 w-4" />,
  dark: <Moon className="h-4 w-4" />,
  system: <Monitor className="h-4 w-4" />,
};

/** Appearance is per-device (this browser), not company data — it applies the
 * moment it is pressed and is never part of the saved settings form. */
function ThemePicker() {
  const [choice, setChoice] = useState<ThemeChoice>(() => getTheme());
  return (
    <div className="flex flex-wrap gap-2 md:col-span-2">
      {THEME_OPTIONS.map((option) => {
        const active = choice === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => {
              setChoice(option.value);
              setTheme(option.value);
            }}
            className={`flex min-h-11 items-center gap-2 rounded-xl border px-4 text-sm font-semibold transition ${
              active
                ? "border-brand/40 bg-brand-050 text-brand"
                : "border-line bg-content1 text-body hover:bg-content2"
            }`}
          >
            {THEME_ICONS[option.value]}
            {option.label}
          </button>
        );
      })}
    </div>
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
      setForm(data);
      qc.invalidateQueries({ queryKey: ["settings"] });
      // Offers a refresh: date format and currency are read at render time all over
      // the app, and screens already mounted keep the old ones until reloaded.
      void alerts.info("settings.changed").then((refreshNow) => {
        if (refreshNow) window.location.reload();
      });
    },
  });

  useEffect(() => {
    if (settings.data) setForm(settings.data);
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
        <Section title="Appearance">
          <ThemePicker />
        </Section>

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

        <Section title="Fallback">
          <Toggle label="Workflow fallback" checked={form.fallback.workflow_fallback_enabled}
                  onChange={(value) => set("fallback", "workflow_fallback_enabled", value)} />
          <Toggle label="Notify admin" checked={form.fallback.notify_admin_on_fallback}
                  onChange={(value) => set("fallback", "notify_admin_on_fallback", value)} />
          <Toggle label="Auto admin fallback" checked={form.fallback.allow_auto_admin_fallback}
                  onChange={(value) => set("fallback", "allow_auto_admin_fallback", value)} />
        </Section>
      </div>
    </>
  );
}