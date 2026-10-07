/**
 * The running number of a unit code the system MINTED, as a person reads it.
 *
 * Putaway names each unit `{item_code}-{new_flag}-{serial:8}` (the format is
 * configurable, see `platform/settings/codeformat.py`), so every unit of one item shares
 * a long prefix and differs only in its padded tail:
 * `101010-VAC-EDTA-VACUTAINER-BD-0001-1-00001980` is unit 1980. A truncated list showed
 * the prefix on every row and cut the one part that differed.
 *
 * Returns null, meaning "show the value exactly as it is", unless BOTH of these hold:
 *  - the value begins with this item's own code, so it is a code the system minted and
 *    not a maker's serial, an IMEI or a code typed in at the GRN. Without an item code
 *    the value needs at least two hyphens, which no IMEI and few maker serials have;
 *  - what follows the last hyphen is all digits.
 *
 * Display only. Search, scanning, selection and saving keep using the full value.
 */
export function unitSerialNo(value: string | null | undefined, itemCode?: string | null): string | null {
  const code = (value ?? "").trim();
  const cut = code.lastIndexOf("-");
  if (cut <= 0) return null;
  const tail = code.slice(cut + 1);
  if (!/^\d+$/.test(tail)) return null;
  const prefix = (itemCode ?? "").trim();
  if (prefix) {
    if (!code.toUpperCase().startsWith(`${prefix.toUpperCase()}-`)) return null;
  } else if ((code.match(/-/g) ?? []).length < 2) {
    return null;
  }
  return tail.replace(/^0+(?=\d)/, "");
}

/** Everything before the running number: `…-BD-0001-1-` of `…-BD-0001-1-00001980`. */
export function unitCodePrefix(value: string): string {
  const code = value.trim();
  return code.slice(0, code.lastIndexOf("-") + 1);
}
