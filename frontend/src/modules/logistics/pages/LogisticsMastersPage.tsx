import { Truck } from "lucide-react";
import { PageHeader } from "@/shared/components";
import { MasterCrud } from "@/modules/masters/components/MasterCrud";
import { Active, Code } from "@/modules/masters/tabs/common";
import { mastersApi } from "@/modules/masters/api";
import type { VehicleTypeMaster } from "@/modules/masters/types";

/**
 * Logistics › Masters (2026-11-20) — the lists the logistics desk picks from.
 *
 * Vehicle Types first: the kinds of vehicle the company runs its own loads in (Tata
 * Ace, Bolero Pickup, Eicher 14 ft), picked on every own-vehicle dispatch. Built on
 * the same master screen every other master uses, so it gets search, add / edit,
 * switch off (after showing what still uses a type) and the Excel template, export
 * and import for free. Capacity is optional and only informs: the dispatch screen
 * shows it under the picked type.
 */
const CODE_RULE = {
  maxLength: 10,
  pattern: /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/,
  patternMessage: "Letters and numbers, joined by single hyphens — e.g. TATA-ACE.",
};

const capacity = (r: VehicleTypeMaster) =>
  [r.capacity_kg ? `${r.capacity_kg} kg` : null, r.capacity_cbm ? `${r.capacity_cbm} m³` : null]
    .filter(Boolean).join(" · ") || "—";

export function LogisticsMastersPage() {
  const api = mastersApi.vehicleTypes;
  return (
    <div>
      <PageHeader eyebrow="Logistics" title="Masters" />
      <section className="mb-3 flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-brand/10 text-brand">
          <Truck className="h-4 w-4" aria-hidden />
        </span>
        <div>
          <h2 className="font-display text-base font-bold text-ink">Vehicle Types</h2>
          <p className="text-xs text-muted">Picked when a load goes in a company vehicle.</p>
        </div>
      </section>
      <MasterCrud<VehicleTypeMaster>
        title="Vehicle type" queryKey="vehicle-types" searchable
        managePerm="master.vehicle_type.manage"
        columns={[
          { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
          { key: "name", header: "Vehicle type", render: (r) => <span className="font-semibold text-ink">{r.name}</span> },
          { key: "capacity", header: "Carries up to", render: (r) => capacity(r) },
          { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
        ]}
        renderCard={(r) => (
          <div>
            <Code>{r.code}</Code>
            <div className="font-semibold text-ink">{r.name}</div>
            <div className="text-xs text-muted">{capacity(r)}</div>
          </div>
        )}
        fetchList={(search) => api.listAll({ search })}
        fields={[
          { key: "code", label: "Code", required: true, ...CODE_RULE },
          { key: "name", label: "Vehicle type", required: true, maxLength: 200 },
          { key: "capacity_kg", label: "Carries up to (kg)", type: "number", min: 0 },
          { key: "capacity_cbm", label: "Carries up to (m³)", type: "number", min: 0 },
          { key: "description", label: "Description", maxLength: 300 },
          { key: "is_active", label: "Active", type: "switch" },
        ]}
        emptyForm={{ code: "", name: "", capacity_kg: "", capacity_cbm: "", description: "", is_active: true }}
        toForm={(r) => ({
          code: r.code, name: r.name, capacity_kg: r.capacity_kg ?? "", capacity_cbm: r.capacity_cbm ?? "",
          description: r.description ?? "", is_active: r.is_active,
        })}
        bulk={api} usage={api.usage}
        onCreate={(v) => api.create(clean(v))}
        onUpdate={(id, v) => api.update(id, clean(v))}
        onDeactivate={api.deactivate}
      />
    </div>
  );
}

/** Blank capacity boxes mean "not stated", never 0. */
function clean(v: Record<string, unknown>): Partial<VehicleTypeMaster> {
  const num = (x: unknown) => (x === "" || x === null || x === undefined ? null : Number(x));
  return { ...v, capacity_kg: num(v.capacity_kg), capacity_cbm: num(v.capacity_cbm) } as Partial<VehicleTypeMaster>;
}
