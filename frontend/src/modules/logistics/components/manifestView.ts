import type { TRItem } from "../transportTypes";

/**
 * How the manifest panel READS its lines — pure, so the panel only draws.
 *
 * A trip's shipment carries one line per consignment, written by
 * `warehouse.trips` as `remarks = "Stop 3: <destination> · indent <no>"` and
 * `item_code = <consignment no>`. Read as an item table that is five rows of the
 * same three facts glued into one sentence, repeated twice per row. Read as what it
 * is — drops on a route — it is a list a driver can follow. Nothing here invents a
 * fact: every field comes out of the line the server already sent, and a line that
 * does not parse leaves the whole manifest drawn as items.
 */

export interface StopLine {
  line: TRItem;
  sequence: number;
  destination: string;
  place: string;
  consignmentNo: string | null;
  indentNo: string | null;
}

const STOP_REMARK = /^Stop\s+(\d+):\s*(.+?)(?:\s+·\s+indent\s+(.+))?$/i;

/** Every line is a stop, or the manifest is not a route. A half-parsed route would
 *  draw some items as drops and the rest as orphans, which is worse than a table. */
export function stopLines(lines: TRItem[]): StopLine[] | null {
  if (!lines.length) return null;
  const stops: StopLine[] = [];
  for (const line of lines) {
    const match = (line.remarks ?? "").trim().match(STOP_REMARK);
    if (!match) return null;
    const destination = match[2].trim();
    stops.push({
      line,
      sequence: Number(match[1]),
      destination,
      place: placeName(destination),
      consignmentNo: line.item_code?.trim() || null,
      indentNo: match[3]?.trim() || null,
    });
  }
  return stops.sort((a, b) => a.sequence - b.sequence);
}

const REGISTRATION = /\bAP\d{2}[A-Z]{1,3}\d+\b/gi;
const RUNG_TAIL = /\b(?:LIP|MDP|MAIN)\b.*$/i;
const RUNG_SUFFIX = /\s*-\s*(?:LIP|MDP|MAIN)\s*$/i;
/** Mirrors `geocoding._GENERIC`: the words in a stocking-point label that are the
 *  programme, the facility or the rung, never the place. */
const GENERIC = new Set([
  "104", "ap", "mmu", "phc", "chc", "tphc", "uphc", "ah", "colocated", "hc",
  "lip", "mdp", "main", "branch", "regional", "office", "warehouse", "ware",
  "house", "dst", "district", "backup", "back", "up", "buffer", "vehicle",
  "co", "located", "dh", "pch", "aam", "bo", "so", "ho",
]);

/** The name a person reads a stop BY — "Badangi", not
 *  "AP-104-MMU-Badangi-AP39UH4792 - LIP". The same reading as the server's
 *  `trips.place_name`; display only, the full name is always drawn beside it. */
export function placeName(name: string | null | undefined): string {
  const full = (name ?? "").trim();
  const mmu = full.match(/\bMMU\b/i);
  if (mmu) {
    let value = full.replace(REGISTRATION, " ");
    const at = value.search(/\bMMU\b/i);
    value = value.slice(at + 3).replace(RUNG_TAIL, " ");
    const words = (value.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      .map((word) => word.replace(/^(?:u?phc|chc|hc)(?=[a-z]{4,}$)/, ""))
      .filter((word) => word && !GENERIC.has(word));
    if (words.length) {
      return words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
    }
  }
  return full.replace(RUNG_SUFFIX, "") || full;
}

/** "BHS/104/2026-27/CON0005" → prefix "BHS/104/2026-27/", tail "CON0005". The tail is
 *  what tells two documents apart; the prefix is the same on every row. */
export function splitDocNo(value: string | null | undefined): { prefix: string; tail: string } {
  const text = (value ?? "").trim();
  const cut = text.lastIndexOf("/");
  if (cut <= 0 || cut === text.length - 1) return { prefix: "", tail: text };
  return { prefix: text.slice(0, cut + 1), tail: text.slice(cut + 1) };
}

/**
 * Each line's share of the load, for the bar across the top.
 *
 * By QUANTITY only when every line counts in one unit — 4 boxes and 10 litres do not
 * add up to anything — else by packages, else there is no honest bar to draw and
 * this returns null. Shares are exact; the minimum width a sliver is drawn at is the
 * screen's business, never folded into the percentage printed beside the row.
 */
export function loadShares(lines: TRItem[], sameUnit: boolean): {
  basis: "quantity" | "packages";
  shares: number[];
} | null {
  if (lines.length < 2) return null;
  const quantities = lines.map((line) => Math.max(0, Number(line.quantity ?? 0)));
  const qtyTotal = quantities.reduce((sum, value) => sum + value, 0);
  if (sameUnit && qtyTotal > 0) {
    return { basis: "quantity", shares: quantities.map((value) => value / qtyTotal) };
  }
  const packages = lines.map((line) => Math.max(0, Number(line.package_count ?? 0)));
  const pkgTotal = packages.reduce((sum, value) => sum + value, 0);
  if (pkgTotal > 0) {
    return { basis: "packages", shares: packages.map((value) => value / pkgTotal) };
  }
  return null;
}

/** "97%", "3%", and "<1%" rather than a "0%" that reads as nothing on board. */
export function shareLabel(share: number): string {
  if (share <= 0) return "0%";
  if (share < 0.01) return "<1%";
  return `${Math.round(share * 100)}%`;
}

/** Categorical slots from `index.css` — identities, not states, assigned in order and
 *  never cycled: a seventh line folds into the neutral "rest" colour. */
const CATEGORY = [
  "var(--color-cat-1)", "var(--color-cat-2)", "var(--color-cat-3)",
  "var(--color-cat-4)", "var(--color-cat-5)", "var(--color-cat-6)",
];

export function lineColor(index: number): string {
  return CATEGORY[index] ?? "var(--color-neutral)";
}

/** Is this shipment a multi-drop trip's one shipment? */
export function isTripLeg(row: { source_type?: string | null }): boolean {
  return (row.source_type ?? "").toUpperCase() === "TRIP";
}

/** Where a shipment goes, in words. A trip's `to_location_name` is only its LAST stop,
 *  and printing that alone tells the desk the whole load is going there. */
export function legDestination(row: {
  source_type?: string | null; total_items?: number | null; to_location_name?: string | null;
}): string {
  if (!isTripLeg(row)) return row.to_location_name ?? "—";
  const last = placeName(row.to_location_name);
  return `${row.total_items ?? 0} drops${last ? `, ending ${last}` : ""}`;
}
