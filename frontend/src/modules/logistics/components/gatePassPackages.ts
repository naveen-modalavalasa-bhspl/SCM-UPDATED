import type { PackageQuantity } from "../transportTypes";

/**
 * What the DC/DOD gate pass says about packages (SCM_0130).
 *
 * A shipment line's `package_count` is a FREIGHT figure: a carton holding three items
 * credits one of them, so the pass printed 0 packages against the other two and its
 * total was whatever the lines added up to. The gate counts cartons, so the pass now
 * says which cartons each item is in — read off the consignment
 * (`package_quantities`) — and totals the consignment's own carton count.
 */

/** The cartons an item is in, in natural order ("P-2" before "P-10"), each once. */
export function cartonsOf(quantities: readonly PackageQuantity[] | null | undefined): string[] {
  const names = new Set<string>();
  for (const row of quantities ?? []) {
    const name = (row.package_no ?? "").trim();
    if (name) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** "Carton P-1" / "3 cartons" — the figure for the Packages column. */
export function cartonCountLabel(cartons: readonly string[]): string {
  return cartons.length === 1 ? "1 carton" : `${cartons.length} cartons`;
}

/** The pass's total: the consignment's own carton count when there is one, else the
 *  lines' freight count (a leg raised by hand, with no consignment behind it). */
export function passPackageTotal(doc: {
  consignment_package_total?: number | null; total_packages?: number | null;
}): number {
  return doc.consignment_package_total ?? doc.total_packages ?? 0;
}
