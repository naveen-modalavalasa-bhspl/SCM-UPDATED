import type {
  CycleLedger, CycleLedgerItem, DecisionLedgerQuantityChange,
} from "./types";

/**
 * A cycle's roll-up, read back the other way: by INDENT instead of by item.
 *
 * The register of indents used to be a list of links. Every row said what the
 * approver gave that site in total and then sent them to another page to find out
 * which items that total was made of — and for a MONTHLY indent that page is this
 * page again, re-fetched against a different anchor, with the same eleven rows in
 * it. So the reader left the month to look at one member of it and arrived back at
 * the month.
 *
 * Nothing had to be fetched for that. `cycle_ledger` already serves every line of
 * every member: `items[].sites[]` is the whole cross-product, keyed by item because
 * that is what the roll-up is for. Re-keying it by `indent_id` is this file, and it
 * is the ONLY thing standing between the register and opening a row in place.
 *
 * NOTHING IS SUMMED HERE, deliberately, and this is the load-bearing part. The
 * indent's own totals (`requested`, `approved`, `change`, `line_count`) are served
 * on the row itself, computed on the server off the same `_item_snapshot` these
 * lines come from. Adding these lines up in the browser to get a second copy of
 * that total is how the panel and the row it opened out of come to disagree — and
 * the browser's copy would be the wrong one, because a reader who can only see part
 * of the cycle sees only part of each item's sites.
 */

export interface CycleIndentLine {
  line_id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  /** What reached THIS approver on this line, never what the indent was raised with. */
  requested: number;
  /** `null` while this line is still waiting for this approver. */
  approved?: number | null;
  change?: number | null;
  decision: string;
  is_excluded: boolean;
  reason?: string | null;
  /** Empty for a line nobody changed, which is the common case and is why the
   *  panel draws no disclosure at all rather than one saying there is nothing in
   *  it. Served, and already cut to what this login may read. */
  quantity_history: DecisionLedgerQuantityChange[];
}

/** Every member's lines, keyed by indent id, in the order the roll-up puts the
 *  items in — biggest ask first, which is the order somebody checking a decision
 *  reads a document in. */
export function linesByIndent(items: CycleLedgerItem[]): Map<number, CycleIndentLine[]> {
  const byIndent = new Map<number, CycleIndentLine[]>();
  for (const item of items) {
    for (const site of item.sites) {
      const lines = byIndent.get(site.indent_id) ?? [];
      lines.push({
        line_id: site.line_id,
        item_id: item.item_id,
        item_code: item.item_code,
        item_name: item.item_name,
        uom_code: item.uom_code,
        requested: site.requested,
        approved: site.approved,
        change: site.change,
        decision: site.decision,
        is_excluded: site.is_excluded,
        reason: site.reason,
        quantity_history: site.quantity_history ?? [],
      });
      byIndent.set(site.indent_id, lines);
    }
  }
  return byIndent;
}

/**
 * Why the indent came out the way it did, in the approver's own words.
 *
 * `reason` on a line is the COMMENT ON THE ACTION, stamped onto every line that
 * action covered — so a six-line indent carries the same sentence six times and
 * printing it per line is the same sentence six times on the screen. It is one
 * comment about one press, so it is said once, above the lines.
 *
 * Several distinct sentences means the cycle reached this login more than once,
 * which is a fact about the ladder and is kept rather than flattened to the first
 * one. Blank comments are not "no comment recorded" six times over; they are
 * absent, and the panel simply does not draw the band.
 */
export function reasonsOf(lines: CycleIndentLine[]): string[] {
  const seen = new Set<string>();
  for (const line of lines) {
    const text = (line.reason ?? "").trim();
    if (text) seen.add(text);
  }
  return [...seen];
}

/**
 * How many indents this cycle holds per requester.
 *
 * A month is MEANT to be one indent per site, and the rule that would enforce it is
 * not written yet — so the live cycles carry several from one requester and the
 * register has to be readable that way round. A row that is one of several says so;
 * a row that is the only one says nothing, because "1 of 1" on every line of an
 * eleven-row list is eleven lines of noise. Keyed on the requester ID, never the
 * name: two people share a name long before they share an employee id.
 */
export function indentsPerRequester(data: Pick<CycleLedger, "indents">): Map<number, number> {
  const counts = new Map<number, number>();
  for (const row of data.indents) {
    if (row.requested_by_id === null || row.requested_by_id === undefined) continue;
    counts.set(row.requested_by_id, (counts.get(row.requested_by_id) ?? 0) + 1);
  }
  return counts;
}
