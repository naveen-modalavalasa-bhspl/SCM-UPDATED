import { Button, ErrorBanner, Field, Input, PageHeader, Select } from "@/shared/components";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@heroui/react";
import { ArrowLeft } from "lucide-react";
import { Section } from "../../components/DocumentMeta";
import { Lookup } from "../../components/Lookup";
import { createWarehouse, employeeOptions, getWarehouse, updateWarehouse } from "../../api";
import type { WarehouseWrite } from "../../types";
import { usePointLabel } from "../../usePointLabel";

/**
 * Create or edit a warehouse.
 *
 * `is_bin_managed` is the consequential field on this form: flipping it decides
 * whether putaway asks for a bin or drops everything into bulk (`bin_id = 0`). It is
 * therefore spelled out rather than left as a bare toggle label, and turning it off
 * on a site that already has stock in bins is warned about here — the backend is
 * what actually refuses it.
 */

const TYPES = [
  { value: "CENTRAL", label: "Central warehouse" },
  { value: "MAIN", label: "Main store" },
  { value: "TRANSIT", label: "Transit" },
  { value: "QUARANTINE", label: "Quarantine" },
  { value: "SCRAP", label: "Scrap" },
  { value: "COLD", label: "Cold storage" },
];

const EMPTY: WarehouseWrite = {
  code: "",
  name: "",
  facility_id: null,
  office_id: null,
  warehouse_type: "MAIN",
  address: "",
  latitude: null,
  longitude: null,
  incharge_id: null,
  is_bin_managed: false,
  requires_inward: null,
  is_active: true,
};

/** Three states, not a toggle: "nobody has decided for this point" is a real and
 *  common answer, and it has to stay distinguishable from a deliberate No. */
const INWARD_CHOICES = [
  { value: "", label: "Follow the company default" },
  { value: "true", label: "Yes — inward, GRN and QC first" },
  { value: "false", label: "No — acknowledging posts the stock" },
];

export default function WarehouseForm() {
  const label = usePointLabel();
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const editing = !!id && id !== "new";

  const [form, setForm] = useState<WarehouseWrite>(EMPTY);
  const [touched, setTouched] = useState(false);

  const { data: existing, isLoading } = useQuery({
    queryKey: ["wh-warehouse", id],
    queryFn: () => getWarehouse(Number(id)),
    enabled: editing,
  });

  useEffect(() => {
    if (existing) {
      setForm({
        code: existing.code,
        name: existing.name,
        facility_id: existing.facility_id ?? null,
        office_id: existing.office_id ?? null,
        warehouse_type: existing.warehouse_type,
        address: existing.address ?? "",
        latitude: existing.latitude ?? null,
        longitude: existing.longitude ?? null,
        incharge_id: existing.incharge_id ?? null,
        is_bin_managed: existing.is_bin_managed,
        requires_inward: existing.requires_inward ?? null,
        is_active: existing.is_active,
      });
    }
  }, [existing]);

  const set = <K extends keyof WarehouseWrite>(key: K, value: WarehouseWrite[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const save = useMutation({
    mutationFn: () =>
      editing ? updateWarehouse(Number(id), form) : createWarehouse(form),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["wh-warehouses"] });
      qc.invalidateQueries({ queryKey: ["wh-warehouse", String(saved.id)] });
      nav(`/warehouse/masters/warehouses/${saved.id}`);
    },
  });

  const codeError = touched && !form.code.trim() ? "A code is required." : undefined;
  const nameError = touched && !form.name.trim() ? "A name is required." : undefined;

  const submit = () => {
    setTouched(true);
    if (!form.code.trim() || !form.name.trim()) return;
    save.mutate();
  };

  if (editing && isLoading) return <div className="py-16 text-center text-muted">Loading…</div>;

  return (
    <div>
      <PageHeader
        eyebrow={`${label} master`}
        title={editing ? `Edit ${existing?.code ?? "warehouse"}` : "New warehouse"}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav(-1)}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Button onClick={submit} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save warehouse"}
            </Button>
          </>
        }
      />

      <ErrorBanner error={save.error} />

      <Section title="Identity">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Code" hint="Short and stable — it appears on every document.">
            <Input
              value={form.code}
              onChange={(e) => set("code", e.target.value.toUpperCase())}
              placeholder="WH-MAIN"
              isInvalid={!!codeError}
              errorMessage={codeError}
            />
          </Field>
          <Field label="Name">
            <Input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Main store"
              isInvalid={!!nameError}
              errorMessage={nameError}
            />
          </Field>
          <Field label="Type">
            <Select
              value={form.warehouse_type}
              onChange={(v) => set("warehouse_type", v || "MAIN")}
              options={TYPES}
              ariaLabel="Warehouse type"
            />
          </Field>
        </div>
      </Section>

      <Section title="Where it sits" hint="Facility and office come from HCM and are read-only there.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="In charge">
            <Lookup
              name="employees"
              load={employeeOptions}
              value={form.incharge_id ?? ""}
              onChange={(v) => set("incharge_id", v === "" ? null : v)}
              placeholder="Pick a storekeeper"
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Address">
              <Input
                value={form.address ?? ""}
                onChange={(e) => set("address", e.target.value)}
                placeholder="Street, city, pin"
              />
            </Field>
          </div>
          <Field label="Latitude" hint="Verified gate coordinate used by Smart Load Planner.">
            <Input
              type="number"
              step="0.0000001"
              value={form.latitude ?? ""}
              onChange={(e) => set("latitude", e.target.value === "" ? null : Number(e.target.value))}
              placeholder="16.5062"
            />
          </Field>
          <Field label="Longitude" hint="Enter both coordinates, or leave both blank.">
            <Input
              type="number"
              step="0.0000001"
              value={form.longitude ?? ""}
              onChange={(e) => set("longitude", e.target.value === "" ? null : Number(e.target.value))}
              placeholder="80.6480"
            />
          </Field>
        </div>
      </Section>

      <Section title="How it stores">
        <div className="space-y-4">
          <label className="flex items-start gap-3">
            <Switch
              isSelected={form.warehouse_type === "CENTRAL"}
              onValueChange={(value) => set(
                "warehouse_type",
                value ? "CENTRAL" : "MAIN",
              )}
              aria-label="Central warehouse"
            />
            <span>
              <span className="block text-sm font-medium text-body">Central warehouse</span>
              <span className="block text-xs text-muted">
                Marks the primary warehouse in the hierarchy.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3">
            <Switch
              isSelected={form.is_bin_managed}
              onValueChange={(v) => set("is_bin_managed", v)}
              aria-label="Bin managed"
            />
            <span>
              <span className="block text-sm font-medium text-body">Bin managed</span>
              <span className="block text-xs text-muted">
                On: putaway and picking ask for a bin, and stock is tracked per bin. Off: the
                site stocks in bulk and every document leaves the bin empty. Changing this on a
                site that already holds stock is refused.
              </span>
            </span>
          </label>

          <Field label="Goods arriving here">
            <Select
              value={form.requires_inward == null ? "" : String(form.requires_inward)}
              onChange={(v) => set("requires_inward", v === "" ? null : v === "true")}
              options={INWARD_CHOICES}
              ariaLabel="Inward policy"
            />
            <span className="mt-1 block text-xs text-muted">
              Yes: a consignment landing here waits for Material Inward, a GRN and QC —
              the GRN is what posts the stock. No: the receiver acknowledges the
              delivery and the stock is credited there and then, with no GRN at all.
            </span>
          </Field>

          <label className="flex items-start gap-3">
            <Switch
              isSelected={form.is_active}
              onValueChange={(v) => set("is_active", v)}
              aria-label="Active"
            />
            <span>
              <span className="block text-sm font-medium text-body">Active</span>
              <span className="block text-xs text-muted">
                An inactive warehouse stops appearing on new documents; existing ones keep it.
              </span>
            </span>
          </label>
        </div>
      </Section>
    </div>
  );
}
