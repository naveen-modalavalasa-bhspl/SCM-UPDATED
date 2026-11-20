import { Link } from "react-router-dom";
import { AlertCircle, CarFront, Minus, Phone, Plus, UserRound, Users } from "lucide-react";
import { Field, Input, Select } from "@/shared/components";
import type { CrewMemberInput, VehicleTypeOption } from "../transportTypes";
import { MAX_CREW, crewProblems, digitsOnly, makeDriver, resizeCrew } from "./crew";

/**
 * Own vehicle: WHAT vehicle and WHO goes with it (2026-11-20).
 *
 * The desk first says how many people are travelling — the stepper — and the screen
 * opens exactly that many person cards. Each card asks for a name and a mobile number
 * (and an employee code or ID number, optional); one person is the driver, picked on
 * the card itself. The rules are `crew.ts`, the same words the server refuses with.
 * `showErrors` holds the per-card messages back until the desk has tried to proceed,
 * so a card is not red the moment it opens.
 */
export function OwnVehicleCrew({
  vehicleTypes, vehicleTypeId, onVehicleType, count, crew, onCrew, showErrors, disabled,
}: {
  vehicleTypes: VehicleTypeOption[] | undefined;
  vehicleTypeId: number | null;
  onVehicleType: (id: number | null) => void;
  count: number;
  crew: CrewMemberInput[];
  onCrew: (count: number, crew: CrewMemberInput[]) => void;
  showErrors?: boolean;
  disabled?: boolean;
}) {
  const problems = crewProblems(count, crew);
  const chosen = vehicleTypes?.find((v) => v.id === vehicleTypeId);
  const setCount = (next: number) => {
    const size = Math.max(0, Math.min(MAX_CREW, next));
    onCrew(size, resizeCrew(crew, size));
  };
  const setPerson = (index: number, patch: Partial<CrewMemberInput>) =>
    onCrew(count, crew.map((p, i) => (i === index ? { ...p, ...patch } : p)));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Vehicle type" required
               hint={chosen && (chosen.capacity_kg || chosen.capacity_cbm)
                 ? `Carries up to ${[chosen.capacity_kg ? `${chosen.capacity_kg} kg` : null,
                     chosen.capacity_cbm ? `${chosen.capacity_cbm} m³` : null].filter(Boolean).join(" · ")}`
                 : undefined}
               error={showErrors && !vehicleTypeId ? "Pick the vehicle type." : null}>
          <Select
            value={vehicleTypeId ? String(vehicleTypeId) : ""}
            onChange={(value) => onVehicleType(value ? Number(value) : null)}
            options={(vehicleTypes ?? []).map((v) => ({ value: String(v.id), label: v.name }))}
            placeholder={vehicleTypes === undefined ? "Loading…" : "Select vehicle type"}
            ariaLabel="Vehicle type"
            isDisabled={disabled}
          />
        </Field>
        <div>
          <span className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-body">
            <Users className="h-4 w-4 text-muted" aria-hidden /> People going with the vehicle
            <span aria-hidden="true" className="text-danger">*</span>
          </span>
          <div className="flex items-center gap-2">
            <button type="button" aria-label="One person fewer" disabled={disabled || count <= 0}
                    onClick={() => setCount(count - 1)}
                    className="grid h-11 w-11 place-items-center rounded-xl border border-line bg-content1 text-ink hover:bg-content2 disabled:opacity-40">
              <Minus className="h-4 w-4" />
            </button>
            <div className="w-20 shrink-0">
              <Input type="number" inputMode="numeric" min={0} max={MAX_CREW} value={count || ""}
                     aria-label="Number of people" className="text-center text-base font-semibold"
                     disabled={disabled}
                     onChange={(event) => setCount(Number(event.target.value || 0))} />
            </div>
            <button type="button" aria-label="One person more" disabled={disabled || count >= MAX_CREW}
                    onClick={() => setCount(count + 1)}
                    className="grid h-11 w-11 place-items-center rounded-xl border border-line bg-content1 text-ink hover:bg-content2 disabled:opacity-40">
              <Plus className="h-4 w-4" />
            </button>
            <span className="text-xs text-muted">
              {count > 0 ? `Driver + ${count - 1} helper${count - 1 === 1 ? "" : "s"}` : "Include the driver"}
            </span>
          </div>
        </div>
      </div>

      {vehicleTypes && vehicleTypes.length === 0 && (
        <p className="rounded-xl border border-warn/30 bg-warn-bg/60 px-3 py-2 text-xs text-body">
          No vehicle types yet. Add them on{" "}
          <Link to="/logistics/masters" className="font-semibold text-brand underline">Logistics › Masters</Link>.
        </p>
      )}

      {crew.length > 0 && (
        <ol className="grid grid-cols-1 gap-3 lg:grid-cols-2" aria-label="People travelling">
          {crew.map((person, index) => {
            const errors = showErrors ? problems.byPerson[index] ?? [] : [];
            const driver = person.role === "DRIVER";
            return (
              <li key={index}
                  className={`rounded-2xl border p-3.5 transition-colors ${
                    errors.length ? "border-danger/50 bg-content1"
                      : driver ? "border-line bg-content1 shadow-sm" : "border-line bg-content1"}`}>
                <div className="mb-2.5 flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                    <span className={`grid h-7 w-7 place-items-center rounded-full text-xs font-bold ${
                      driver ? "bg-brand text-white" : "bg-content3 text-ink"}`}>{index + 1}</span>
                    {person.name.trim() || `Person ${index + 1}`}
                  </span>
                  <button type="button" disabled={disabled}
                          onClick={() => onCrew(count, makeDriver(crew, index))}
                          aria-pressed={driver}
                          className={`inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-xs font-semibold ${
                            driver ? "bg-brand text-white" : "border border-line text-muted hover:text-ink"}`}>
                    {driver ? <><CarFront className="h-3.5 w-3.5" /> Driver</> : <>Make driver</>}
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <label className="sm:col-span-2">
                    <span className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
                      <UserRound className="h-3 w-3" aria-hidden /> Name *
                    </span>
                    <Input value={person.name} disabled={disabled} placeholder="Full name"
                           onChange={(e) => setPerson(index, { name: e.target.value })} />
                  </label>
                  <label>
                    <span className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
                      <Phone className="h-3 w-3" aria-hidden /> Mobile *
                    </span>
                    <Input value={person.phone} disabled={disabled} inputMode="numeric"
                           placeholder="10-digit mobile"
                           onChange={(e) => setPerson(index, { phone: digitsOnly(e.target.value) })} />
                  </label>
                  <label>
                    <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted">
                      ID / Emp. code
                    </span>
                    <Input value={person.id_number ?? ""} disabled={disabled} placeholder="Optional"
                           onChange={(e) => setPerson(index, { id_number: e.target.value })} />
                  </label>
                </div>
                {errors.length > 0 && (
                  <ul className="mt-2 space-y-0.5 text-xs font-semibold text-danger">
                    {errors.map((message) => <li key={message}>{message}</li>)}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {showErrors && problems.general.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/25 bg-danger/[0.04] px-3 py-2 text-xs font-semibold text-danger">
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{problems.general.join(" ")}</span>
        </div>
      )}
    </div>
  );
}
