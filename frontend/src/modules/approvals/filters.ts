export type RaisedRange = "" | "24h" | "7d" | "30d" | "custom";

export const PRIMARY_APPROVAL_TYPES = ["INDENT", "MR", "ALLOCATION"] as const;

/**
 * The doc-type chips, in a stable order: the three that always show first, then
 * whatever else is in the queue, alphabetically.
 *
 * Takes counts rather than rows — the server counts the queue now, so the browser
 * never has to hold it. The three primaries appear at 0 on purpose: a chip that
 * disappears when its queue empties makes the row jump about as work is cleared.
 */
export function approvalTypeCounts(counts: Record<string, number>): Array<[string, number]> {
  const ordered = new Set<string>(PRIMARY_APPROVAL_TYPES);
  Object.keys(counts).sort().forEach((type) => ordered.add(type));
  return [...ordered].map((type) => [type, counts[type] ?? 0]);
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
