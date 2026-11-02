/**
 * Splitting one quantity across the people asking for it. Mirror of `share_out` in
 * backend/app/shared/uom.py — same rule, same rounding, same tie-breaks.
 *
 * It lives in shared, not in a module, because two modules split the same way: the
 * approver divides an approved total across the indents that asked for an item, and
 * the storekeeper divides stock across the lines competing for it. One implementation
 * means the number somebody is shown is the number the server ends up storing.
 */

/** Split `total` across `weights` in proportion, never past `caps`, losing nothing.
 *
 *  Largest remainder (Hamilton): everyone takes their whole units first, then the
 *  units left over go to the biggest fractions. 45 across five equal 10s is 9/9/9/9/9;
 *  43 is 9/9/9/8/8 — never 8.6 five times, because an indent line is a quantity a
 *  storekeeper has to physically issue.
 *
 *  `caps` is what makes leaving somebody out safe. Their share goes to the rest, but
 *  no one may be pushed past their OWN ceiling doing it: with two indents asking 20
 *  and 10, dropping the second used to offer the first all 22 — two more than it ever
 *  asked for, which the server then refused. A share that would overflow is trimmed
 *  and what it could not take is re-offered to whoever still has room. A total bigger
 *  than every cap combined simply comes back short, which is the honest answer.
 *
 *  `decimals` is the unit's step (`uom_decimals` on the item): 0 for anything counted
 *  in whole numbers, 3 for anything measured. Left out, it falls back to guessing from
 *  the total, which is still right for a caller with no item to hand.
 */
export function splitQuantity(
  total: number, weights: number[], caps?: (number | null)[], decimals?: number,
): number[] {
  const scale = 10 ** Math.max(0, decimals ?? (Number.isInteger(total) ? 0 : 3));
  // Rounded before the floor: 5.7 * 1000 is 5699.999… in binary floating point, and
  // flooring that loses a whole step of the unit.
  const step = (value: number) => Math.floor(Math.round(value * scale * 1000) / 1000);

  const given = weights.map(() => 0);
  const capUnits = weights.map((_, i) => {
    const cap = caps?.[i];
    return cap === undefined || cap === null ? null : Math.max(0, step(cap));
  });
  let left = Math.max(0, step(total));
  let open = weights
    .map((weight, index) => ({ weight: Math.max(0, weight), index }))
    .filter((row) => row.weight > 0 && capUnits[row.index] !== 0)
    .map((row) => row.index);

  while (left > 0 && open.length > 0) {
    const sum = open.reduce((acc, i) => acc + Math.max(0, weights[i]), 0);
    if (sum <= 0) break;
    const raw = new Map(open.map((i) => [i, (Math.max(0, weights[i]) / sum) * left]));
    const base = new Map(open.map((i) => [i, Math.floor(raw.get(i)!)]));
    let spare = left - open.reduce((acc, i) => acc + base.get(i)!, 0);

    // Biggest fraction first; a tie goes to the bigger request, then to the earlier
    // row, so the same numbers always produce the same split.
    const order = [...open].sort((a, b) =>
      ((raw.get(b)! - base.get(b)!) - (raw.get(a)! - base.get(a)!))
      || (weights[b] - weights[a]) || (a - b));
    for (const index of order) {
      if (spare <= 0) break;
      base.set(index, base.get(index)! + 1);
      spare -= 1;
    }

    let moved = false;
    for (const index of [...open]) {
      const cap = capUnits[index];
      const room = cap === null
        ? base.get(index)!
        : Math.min(base.get(index)!, cap - given[index]);
      if (room > 0) {
        given[index] += room;
        left -= room;
        moved = true;
      }
      if (cap !== null && given[index] >= cap) open = open.filter((i) => i !== index);
    }
    // Nobody could take any more: everyone still open is at their ceiling.
    if (!moved) break;
  }
  return given.map((units) => units / scale);
}

/**
 * Keystroke filter for a quantity typed into a plain text box (the ones that are
 * deliberately not `type="number"` — no spinner, no wheel stepping).
 *
 * A text box takes whatever it is given, so letters used to land in the field and only
 * an error message afterwards said they should not be there. Run the typed or pasted
 * value through this in `onChange` and they never appear: only digits and a single
 * decimal point survive, the fraction is cut to the unit's `decimals`, and a whole-unit
 * unit (NOS, BOX — `decimals` 0) loses the point and everything after it.
 *
 * A half-typed number is allowed to exist ("5." and "" and ".5"): the keyboard filters,
 * validation still judges.
 */
export function sanitizeQuantityInput(raw: string, decimals = 3): string {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const [whole, ...rest] = cleaned.split(".");
  if (decimals <= 0) return whole;
  if (rest.length === 0) return whole;
  return `${whole}.${rest.join("").slice(0, decimals)}`;
}
