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
