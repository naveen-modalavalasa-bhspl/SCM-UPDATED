import type { ConsignmentDetail, TRInput, TRLineInput } from "../transportTypes";

/**
 * A packed consignment, turned into the transport lines a carrier can price.
 *
 * The two documents describe the same physical thing from two sides: the consignment
 * says what was picked and which carton it went into, the transport request says what
 * has to travel and what it weighs. Retyping the second from the first is how the two
 * stop agreeing — and a carrier prices off weight and package count, so a mistake here
 * is a freight dispute later.
 *
 * Each carton is counted ONCE. `package_id` on a consignment line says which carton it
 * went into, so the first line in a carton carries that carton's count, weight and
 * dimensions and the rest carry none: three lines packed in one box are one package,
 * not three. Where the warehouse recorded packages but never mapped lines to them
 * (loose cartons on an older consignment), the whole load lands on the first line
 * rather than vanishing — a zero-package request is one no carrier will quote.
 *
 * FIXED 2026-08-21 — and the same item in the same carton is ONE line. A consignment
 * records what was picked, which for a serial-tracked item is one row per unit: twelve
 * vacutainers packed in one box arrived here as twelve identical lines reading "1 NOS",
 * eleven of them carrying no packages, no weight and no dimensions. A carrier was asked
 * to price a twelve-line manifest of the same thing, and the shipment register drew the
 * same wall of repeats. Grouped on item + carton + batch: the carton keeps its own
 * weight and dimensions (that is a property of the box, not the item, so an item split
 * across two boxes is still two lines), and the quantities inside it add up.
 */
export function linesFromConsignment(doc: ConsignmentDetail): TRLineInput[] {
  const packages = doc.packages ?? [];
  const counted = new Set<number>();
  const byKey = new Map<string, TRLineInput>();
  const lines: TRLineInput[] = [];

  for (const line of doc.items ?? []) {
    const pkg = packages.find((p) => p.id === line.package_id);
    const batchNo = line.batch_no ?? null;

    // One picked row per unit is normal, so the key is what actually distinguishes a
    // manifest line: the item, the box it is in, and the batch it came from. A line
    // with no carton keys on its own `package_id` (usually null) and still merges
    // with its siblings, which is what an unmapped loose load should do.
    const key = `${line.item_id}|${line.package_id ?? "none"}|${batchNo ?? ""}`;
    const merged = byKey.get(key);
    if (merged) {
      merged.quantity = Number(merged.quantity ?? 0) + Number(line.quantity ?? 0);
      continue;
    }

    const isFirstInCarton = Boolean(pkg) && !counted.has(pkg!.id);
    if (pkg) counted.add(pkg.id);

    const built: TRLineInput = {
      item_id: line.item_id,
      item_code: line.item_code ?? null,
      item_name: line.item_name ?? null,
      uom_code: line.uom_code ?? null,
      quantity: Number(line.quantity ?? 0),
      package_count: isFirstInCarton ? 1 : 0,
      package_type: pkg?.package_type ?? null,
      weight_kg: isFirstInCarton ? pkg?.weight_kg ?? null : null,
      length_cm: isFirstInCarton ? pkg?.length_cm ?? null : null,
      width_cm: isFirstInCarton ? pkg?.width_cm ?? null : null,
      height_cm: isFirstInCarton ? pkg?.height_cm ?? null : null,
      is_fragile: pkg?.is_fragile ?? false,
      remarks: batchNo ? `Batch ${batchNo}` : null,
    };
    byKey.set(key, built);
    lines.push(built);
  }

  if (!counted.size && packages.length && lines.length) {
    lines[0].package_count = packages.length;
    lines[0].weight_kg = packages.reduce(
      (sum, pkg) => sum + Number(pkg.weight_kg ?? 0), 0,
    ) || null;
    lines[0].is_fragile = packages.some((pkg) => pkg.is_fragile);
  }
  return lines;
}

/** The header the consignment already knows: where it is going, who receives it, and
 *  what it is against. Everything else the logistics desk fills in. */
export function headerFromConsignment(doc: ConsignmentDetail): Partial<TRInput> {
  const indentNo = (doc.items ?? []).find((line) => line.indent_no)?.indent_no ?? null;
  const indentId = (doc.items ?? []).find((line) => line.indent_id)?.indent_id ?? null;
  return {
    dispatch_id: doc.id,
    consignment_no: doc.dispatch_no,
    source_type: "CONSIGNMENT",
    source_id: doc.id,
    source_no: doc.dispatch_no,
    issue_id: doc.ref_type === "ISSUE" ? doc.ref_id ?? null : null,
    indent_id: indentId,
    indent_no: indentNo,
    from_warehouse_id: doc.warehouse_id ?? null,
    from_warehouse_name: doc.warehouse_name ?? null,
    to_location_name: doc.destination_office_name
      ?? doc.to_warehouse_name ?? doc.customer_name ?? null,
    delivery_address: doc.delivery_address ?? null,
    contact_person: doc.contact_person ?? null,
    contact_phone: doc.contact_phone ?? null,
    project_id: doc.project_id ?? null,
    project_name: doc.project_name ?? null,
    expected_delivery: doc.expected_delivery ?? null,
  };
}
