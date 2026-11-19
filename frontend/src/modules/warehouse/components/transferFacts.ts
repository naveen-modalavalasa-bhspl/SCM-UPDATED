import type { TransferContext } from "../types";

/**
 * Which facts the transfer card shows, pure (2026-11-19). The card used to draw all
 * six boxes on every consignment, so a load going to a warehouse or an MDP carried
 * an empty "Service area code —" and "Vehicle —", and a document scoped to a project
 * carried an empty "Department —" beside it. An empty box reads as something
 * somebody forgot to fill in. These rules say instead what applies:
 *
 * - **Vehicle and SAC** belong to an LIP only (`destination_needs_vehicle_and_sac`,
 *   served off the destination's tier). Unknown (null) keeps both, as before.
 * - **Project OR department**, never both: the scope the earlier document carried.
 *   A project wins — it is what the document number prints, and the department
 *   beside it is the same question answered more loosely.
 */
export type ScopeFact = { kind: "project" | "department"; value: string };

export function scopeFact(context: Pick<TransferContext, "project_name" | "department_name">): ScopeFact | null {
  const project = context.project_name?.trim();
  if (project) return { kind: "project", value: project };
  const department = context.department_name?.trim();
  if (department) return { kind: "department", value: department };
  return null;
}

/** Vehicle and SAC apply to this destination (an LIP), or nobody knows it is not. */
export function showsVehicleAndSac(
  context: Pick<TransferContext, "destination_needs_vehicle_and_sac"> | null | undefined,
): boolean {
  return context?.destination_needs_vehicle_and_sac !== false;
}

export type SmallFact = "scope" | "sac" | "vehicle";

/** The small facts under the route, in order, only those that apply. */
export function smallFacts(context: TransferContext): SmallFact[] {
  const out: SmallFact[] = [];
  if (scopeFact(context)) out.push("scope");
  if (showsVehicleAndSac(context)) out.push("sac", "vehicle");
  return out;
}

/** "Main warehouse", "MDP", "LIP" — what a point IS, for the line under its name. */
export function tierLabel(type?: string | null): string | null {
  const value = (type ?? "").toUpperCase();
  if (!value) return null;
  if (value === "LIP") return "LIP";
  if (value === "MDP") return "MDP";
  if (value === "MAIN") return "Main warehouse";
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, " ");
}
