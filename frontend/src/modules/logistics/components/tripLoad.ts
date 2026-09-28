import type { DistanceBasis, LoadBasis, PlanConsignment } from "../transportTypes";

/**
 * How the planner's figures are worded — one place, so the trip cards, the manifest
 * and the console never describe the same basis two ways.
 *
 * The planner serves every figure WITH its basis (`warehouse/trips.py`); nothing here
 * decides a basis, it only says it.
 */

export const kg = (value: number | string | null | undefined) =>
  `${Number(value ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })} kg`;

export const cbm = (value: number | string | null | undefined) =>
  `${Number(value ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })} m³`;

/** "~" in front of any figure that is not firm — read before the number is. */
export function approx(basis: LoadBasis): string {
  return basis === "ESTIMATED" || basis === "ASSUMED" ? "~" : "";
}

export const LOAD_BASIS_WORDS: Record<string, string> = {
  WEIGHED: "weighed",
  MEASURED: "measured",
  ESTIMATED: "estimated from items",
  ASSUMED: "assumed per package",
};

/** The weight of one consignment in a sentence fragment: "20 kg weighed",
 *  "~36 kg assumed per package", "weight not recorded". */
export function weightText(row: Pick<PlanConsignment, "weight_kg" | "weight_basis">): string {
  if (!row.weight_basis || !row.weight_kg) return "weight not recorded";
  return `${approx(row.weight_basis)}${kg(row.weight_kg)} ${LOAD_BASIS_WORDS[row.weight_basis] ?? ""}`.trim();
}

export function volumeText(row: Pick<PlanConsignment, "volume_cbm" | "volume_basis">): string {
  if (!row.volume_basis || !row.volume_cbm) return "size not recorded";
  return `${approx(row.volume_basis)}${cbm(row.volume_cbm)} ${LOAD_BASIS_WORDS[row.volume_basis] ?? ""}`.trim();
}

/** Is anything about this consignment's load a guess the desk could fix by weighing? */
export function needsMeasuring(row: Pick<PlanConsignment, "weight_basis" | "volume_basis">): boolean {
  return row.weight_basis !== "WEIGHED" || row.volume_basis !== "MEASURED";
}

export const DISTANCE_BASIS_WORDS: Record<DistanceBasis, string> = {
  ROAD: "Road km",
  MIXED: "Road km, partly estimated",
  ESTIMATE: "Estimated km",
};

export function distanceWord(basis: DistanceBasis | null | undefined): string {
  return DISTANCE_BASIS_WORDS[basis ?? "ESTIMATE"] ?? DISTANCE_BASIS_WORDS.ESTIMATE;
}

/** A link typed by somebody outside the company (a carrier's proof of delivery) is
 *  only ever rendered as a link when it is plain http(s) — never `javascript:`. */
export function safeHref(url: string | null | undefined): string | null {
  const value = (url ?? "").trim();
  return /^https?:\/\/[^\s]+$/i.test(value) ? value : null;
}

/** Tone for a utilisation bar: over is bad, nearly full is a warning. */
export function fillTone(pct: number | null | undefined): "bad" | "warn" | "ok" {
  const value = Number(pct ?? 0);
  if (value > 100) return "bad";
  if (value > 85) return "warn";
  return "ok";
}
