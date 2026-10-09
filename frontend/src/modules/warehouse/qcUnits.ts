/**
 * Which units a QC line is keeping, repaired for lines raised before every
 * kind was seeded.
 *
 * An auto-raised outward inspection used to seed unit identifiers for
 * serial-tracked lines only, so an IMEI / asset / consumable line was stored
 * with nothing while its accepted quantity covered the whole offered set. The
 * picker reads a stored empty list as "every unit rejected", which is how an
 * untouched line opened at 0/N with the save refusing until each unit was
 * re-accepted by hand.
 *
 * A stored empty list is therefore ambiguous — untouched, or genuinely
 * rejected — and the accepted quantity disambiguates it: a line that rejected
 * everything carries accepted 0, while an untouched line still accepts the
 * whole offered set. Only the second case is repaired, back to the full
 * offered set; anything else (genuinely rejected, or inconsistent) is left
 * alone so the save validation can say so instead of masking it.
 */
export function resolveAcceptedUnits(
  stored: string[] | null | undefined,
  available: string[] | null | undefined,
  acceptedQty: number,
): string[] {
  if (stored && stored.length > 0) return stored;
  const total = available?.length ?? 0;
  if (total > 0 && acceptedQty >= total) return [...(available ?? [])];
  return stored ?? [];
}

/**
 * The units a QC line keeps after its accepted quantity changes.
 *
 * Every unit is accepted by default, and moving the numbers never decides WHICH units
 * failed — only the inspector holding them can. So: accepting the whole line again
 * accepts every unit; rejecting fewer than are already ticked re-accepts the most
 * recently rejected ones; rejecting MORE leaves the set as it is, and the screen asks
 * for the rest to be ticked (see `unitsStillToReject`). Always in offered order.
 */
export function unitsForAccepted(
  stored: string[] | null | undefined,
  offered: string[],
  previousAccepted: number,
  nextAccepted: number,
): string[] {
  const target = Math.floor(nextAccepted);
  if (target >= offered.length) return [...offered];
  const kept = new Set(resolveAcceptedUnits(stored, offered, previousAccepted));
  if (kept.size > target) return offered.filter((unit) => kept.has(unit));
  const rejected = offered.filter((unit) => !kept.has(unit));
  rejected.slice(rejected.length - (target - kept.size)).forEach((unit) => kept.add(unit));
  return offered.filter((unit) => kept.has(unit));
}

/** How many more units the inspector has to tick as rejected on a line. */
export function unitsStillToReject(kept: number, accepted: number): number {
  return Math.max(kept - Math.floor(accepted), 0);
}
