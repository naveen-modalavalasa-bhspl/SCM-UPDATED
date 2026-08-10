export type RaisedRange = "" | "24h" | "7d" | "30d" | "custom";

export const PRIMARY_APPROVAL_TYPES = ["INDENT", "MR", "ALLOCATION"] as const;

export function approvalTypeCounts(rows: Array<{ doc_type: string }>): Array<[string, number]> {
  const counts = new Map<string, number>();
  rows.forEach((row) => counts.set(row.doc_type, (counts.get(row.doc_type) ?? 0) + 1));

  const ordered = new Set<string>(PRIMARY_APPROVAL_TYPES);
  [...counts.keys()].sort().forEach((type) => ordered.add(type));
  return [...ordered].map((type) => [type, counts.get(type) ?? 0]);
}

const DAY = 86_400_000;

/** Returns the inclusive start and exclusive end used by the Raised filter. */
export function raisedWindow(
  range: RaisedRange,
  from = "",
  to = "",
  now = Date.now(),
): [number, number] | null {
  if (range === "24h") return [now - DAY, Infinity];
  if (range === "7d") return [now - (7 * DAY), Infinity];
  if (range === "30d") return [now - (30 * DAY), Infinity];
  if (range !== "custom" || (!from && !to)) return null;

  const localMidnight = (value: string) => {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day).getTime();
  };

  return [
    from ? localMidnight(from) : -Infinity,
    to ? localMidnight(to) + DAY : Infinity,
  ];
}
