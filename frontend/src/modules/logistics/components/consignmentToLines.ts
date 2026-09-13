import type {
  ConsignmentDetail, PackageQuantity, TRInput, TRItem, TRLineInput,
} from "../transportTypes";

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
    // The consignment's OWN destination, never the indent's office.
    //
    // `destination_office_name` is derived from the indent (`_issue_destination`), so
    // it always names the point that RAISED the request. On a direct WH -> LIP run
    // that is also where the lorry goes, which is why reading it first survived; on a
    // relay hop (WH -> MDP -> LIP) it is not, and the leg was stamped — and stored —
    // with the final LIP while the load was driving to the MDP. `to_location_name` is
    // written once at creation, so every shipment raised that way keeps the wrong
    // destination for the rest of its life.
    //
    // The office name stays as the fallback for a dispatch with no receiving
    // warehouse at all: a customer delivery or a vendor return.
    to_location_name: doc.to_warehouse_name
      ?? doc.destination_office_name ?? doc.customer_name ?? null,
    delivery_address: doc.delivery_address ?? null,
    contact_person: doc.contact_person ?? null,
    contact_phone: doc.contact_phone ?? null,
    project_id: doc.project_id ?? null,
    project_name: doc.project_name ?? null,
    expected_delivery: doc.expected_delivery ?? null,
  };
}

/**
 * The same collapse, applied to a shipment that is already raised.
 *
 * `linesFromConsignment` stops a NEW request being built one row per unit, but every
 * request raised before it still carries them, and the screens that read a shipment —
 * the register's line table, the sheet a carrier prices off — are exactly where the
 * wall of repeats shows up. A manifest is a statement about what travels, so it is
 * grouped for READING rather than rewritten in the database: `out_dispatch_items` names
 * every serial in the box on purpose (that IS the packing list) and nothing here erases
 * it.
 *
 * Grouped on item and batch, and the cartons and weights inside a group are ADDED, not
 * taken from whichever row happened to be first — one line carries the count and the
 * rest carry none, so keeping the first would report a twelve-unit shipment as
 * weighing nothing. There is no `package_id` on a stored line, so this cannot tell one
 * carton from two; the totals it prints are right either way, which is what the table
 * shows. Rows that merge with nothing come through untouched.
 */
export function manifestLines(items: TRItem[] | undefined | null): TRItem[] {
  const byKey = new Map<string, TRItem>();
  const lines: TRItem[] = [];

  for (const line of items ?? []) {
    const key = `${line.item_id ?? line.item_code ?? line.item_name}|${line.remarks ?? ""}`;
    const merged = byKey.get(key);
    if (merged) {
      merged.quantity = Number(merged.quantity ?? 0) + Number(line.quantity ?? 0);
      merged.delivered_qty = Number(merged.delivered_qty ?? 0) + Number(line.delivered_qty ?? 0);
      merged.package_count = Number(merged.package_count ?? 0) + Number(line.package_count ?? 0);
      if (line.weight_kg != null) {
        merged.weight_kg = Number(merged.weight_kg ?? 0) + Number(line.weight_kg);
      }
      merged.package_quantities = mergePackageQuantities(
        merged.package_quantities, line.package_quantities,
      );
      merged.is_fragile = merged.is_fragile || line.is_fragile;
      continue;
    }
    const copy = { ...line };
    byKey.set(key, copy);
    lines.push(copy);
  }
  return lines;
}

function mergePackageQuantities(
  left: PackageQuantity[] | undefined,
  right: PackageQuantity[] | undefined,
): PackageQuantity[] | undefined {
  if (!left?.length) return right?.length ? [...right] : left;
  if (!right?.length) return left;
  const seen = new Set(left.map(packageQuantityKey));
  const merged = [...left];
  for (const part of right) {
    const key = packageQuantityKey(part);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(part);
  }
  return merged;
}

/** Which physical package a per-package quantity belongs to. Exported because the
 *  manifest panel counts packages DISTINCT across lines and must agree with the
 *  merge above about what "the same package" means. */
export function packageQuantityKey(part: PackageQuantity) {
  return `${part.package_id ?? ""}|${part.package_no ?? ""}|${part.package_type ?? ""}`;
}

export function packageQuantityParts(line: TRItem): PackageQuantity[] {
  return (line.package_quantities ?? [])
    .filter((part) => Number(part.quantity ?? 0) > 0);
}

export function quantityLabel(value: number | string | null | undefined): string {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return "0";
  return amount.toLocaleString("en-IN", {
    maximumFractionDigits: 3,
    minimumFractionDigits: Number.isInteger(amount) ? 0 : undefined,
  });
}

export function packageQuantityName(part: PackageQuantity, index: number): string {
  const packageNo = part.package_no?.trim();
  const suffix = packageNo?.match(/(?:^|[-/|])((?:PKG|P)\d+)$/i)?.[1];
  return suffix || packageNo || part.package_type || `Package ${index + 1}`;
}

export function packageQuantityFallback(line: TRItem): string {
  const count = Number(line.package_count ?? 0);
  return count > 0 ? `${quantityLabel(count)} pkg` : "—";
}
