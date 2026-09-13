import { Package } from "lucide-react";
import type { TRItem } from "../transportTypes";
import {
  manifestLines, packageQuantityKey, packageQuantityName, packageQuantityParts,
  quantityLabel,
} from "./consignmentToLines";

/**
 * What travels — ONE panel, used by the desk and by the carrier portal.
 *
 * The manifest was drawn four times in four dialects: the shipment register called it
 * "Lines", the provider desk "What is being priced", the acknowledgement "Items in
 * this load", and the carrier's job sheet gave it no heading at all. Same numbers,
 * same table, four sets of words — so a desk and the carrier it is arguing with about
 * a short delivery were reading two differently-shaped documents. This is the only
 * one now. Every screen that shows what is on the truck shows THIS.
 *
 * Three rules make it readable, and all three are about not saying more than the
 * document knows:
 *
 * 1. **A column with nothing to say is not drawn.** Nobody enters weights on a
 *    packing list for stationery, so the register printed a column of em-dashes down
 *    the page, and a delivered column of amber zeroes on a shipment that has not left
 *    the yard — which reads as an alarm about a load that is simply still sitting
 *    there. Weight, packing and delivery each appear only once there is an answer,
 *    and the header strip says out loud which ones are missing. "Weight not recorded"
 *    is information; a dash is a shrug.
 * 2. **The quantity is the loud number.** A package label is a dozen characters of
 *    mono that looks like every other code on the screen; how much is in the box is
 *    what is being read. So the chip carries the label quietly and the quantity in
 *    bold — "PKG-01 2", not "PKG-01: 2".
 * 3. **It adds up on screen.** A total row, so a manifest can be checked against a
 *    gate pass without a calculator, and so a line lost in the grouping would show as
 *    a total that does not match the document.
 *
 * Presentation only. It computes nothing the documents do not already carry: the
 * grouping is `manifestLines`, the per-package split is served by
 * `_attach_package_quantities`, and the totals are sums of what is printed above
 * them. Table from `md` up, cards below — a manifest is never scrolled sideways on
 * the phone a carrier opens it on.
 */

/** Delivery is only a question once somebody has said something about it. */
const DELIVERY_REPORTED = new Set(["DELIVERED", "ACKNOWLEDGED", "CLOSED"]);

export function ManifestTable({ items, status, className = "" }: {
  items: TRItem[] | undefined | null;
  /** The shipment's own status, so the delivered column appears when it starts to
   *  mean something. A part-delivered line forces it on regardless. */
  status?: string | null;
  className?: string;
}) {
  const lines = manifestLines(items);
  const sum = totals(lines);

  const showDelivered = DELIVERY_REPORTED.has(status ?? "") || sum.delivered > 0;
  const showWeight = sum.weighed > 0;
  const showPacked = sum.packages > 0;

  return (
    <section
      className={`overflow-hidden rounded-2xl border border-line/70 bg-content1 ${className}`}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line/70 bg-content2/50 px-4 py-3">
        <h3 className="font-display text-sm font-semibold text-ink">Items in this load</h3>
        {/* An empty manifest has no numbers to summarise, and "0 items · 0 ·
          * packing not recorded" is four ways of saying the one sentence below. */}
        {lines.length > 0 && (
          <p className="text-xs text-muted">{summary(sum, showWeight, showDelivered)}</p>
        )}
      </header>

      {lines.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">
          No lines on this shipment.
        </p>
      ) : (
        <>
          {/* Desk and tablet. */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line/70 text-[11px] uppercase tracking-wider text-muted">
                  <th className="px-4 py-2 text-left font-semibold">Item</th>
                  <th className="px-3 py-2 text-right font-semibold">Quantity</th>
                  {showPacked && (
                    <th className="px-3 py-2 text-left font-semibold">Packed in</th>
                  )}
                  {showWeight && (
                    <th className="px-3 py-2 text-right font-semibold">Weight</th>
                  )}
                  {showDelivered && (
                    <th className="px-4 py-2 text-right font-semibold">Delivered</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id} className="border-b border-line/40 last:border-0">
                    <td className="px-4 py-3">
                      <ItemCell line={line} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right">
                      <Qty value={line.quantity} uom={line.uom_code} />
                    </td>
                    {showPacked && (
                      <td className="px-3 py-3">
                        <Packing line={line} />
                      </td>
                    )}
                    {showWeight && (
                      <td className="whitespace-nowrap px-3 py-3 text-right">
                        <Weight value={line.weight_kg} />
                      </td>
                    )}
                    {showDelivered && (
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <Delivered line={line} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              {/* The check against the gate pass. Only worth drawing once there is
                * more than one row to add up. */}
              {lines.length > 1 && (
                <tfoot>
                  <tr className="border-t border-line/70 bg-content2/40 text-[13px]">
                    <td className="px-4 py-2.5 font-semibold text-ink">Total</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular text-ink">
                      {quantityLabel(sum.qty)}
                      {sum.uom && <span className="ml-1 font-normal text-muted">{sum.uom}</span>}
                    </td>
                    {showPacked && (
                      <td className="whitespace-nowrap px-3 py-2.5 text-muted">
                        {sum.packages} package{sum.packages === 1 ? "" : "s"}
                      </td>
                    )}
                    {showWeight && (
                      <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular text-ink">
                        {quantityLabel(sum.weight)} kg
                      </td>
                    )}
                    {showDelivered && (
                      <td className="whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular text-ink">
                        {quantityLabel(sum.delivered)}
                      </td>
                    )}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {/* Phone. The same facts, stacked — this is read at a loading bay. */}
          <ul className="divide-y divide-line/40 md:hidden">
            {lines.map((line) => (
              <li key={line.id} className="space-y-2 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <ItemCell line={line} />
                  <Qty value={line.quantity} uom={line.uom_code} />
                </div>
                {showPacked && <Packing line={line} />}
                {(showWeight || showDelivered) && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                    {showWeight && (
                      <span className="inline-flex items-center gap-1">
                        Weight <Weight value={line.weight_kg} />
                      </span>
                    )}
                    {showDelivered && (
                      <span className="inline-flex items-center gap-1">
                        Delivered <Delivered line={line} />
                      </span>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** The item, and the two things that tell one row from an identical-looking one: the
 *  code, and the batch it was picked from. The batch lives in `remarks` ("Batch B12")
 *  and is what `manifestLines` splits on, so without it the same item out of two
 *  batches drew two rows a reader could not tell apart. */
function ItemCell({ line }: { line: TRItem }) {
  const meta = [line.item_code, line.remarks].filter(Boolean).join(" · ");
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">{line.item_name ?? "—"}</span>
        {line.is_fragile && (
          <span className="rounded bg-warn-bg px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warn">
            Fragile
          </span>
        )}
      </div>
      {meta && <div className="mt-0.5 font-mono text-[11px] text-muted">{meta}</div>}
    </div>
  );
}

function Qty({ value, uom }: { value: number | string; uom?: string | null }) {
  return (
    <span className="whitespace-nowrap">
      <span className="font-semibold tabular text-ink">{quantityLabel(value)}</span>
      {uom && <span className="ml-1 text-xs text-muted">{uom}</span>}
    </span>
  );
}

/** Which box holds how much. The label is quiet, the quantity is not: the reader is
 *  checking an amount against a carton in their hands, not reading a code. */
function Packing({ line }: { line: TRItem }) {
  const parts = packageQuantityParts(line);
  if (parts.length) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {parts.map((part, index) => (
          <PackageChip
            key={`${packageQuantityKey(part)}-${index}`}
            label={packageQuantityName(part, index)}
            quantity={part.quantity}
            uom={line.uom_code}
          />
        ))}
      </div>
    );
  }
  // Cartons the warehouse counted but never mapped to lines. A count is still an
  // answer, and which box it is in is not something this document knows.
  const count = Number(line.package_count ?? 0);
  return count > 0 ? (
    <span
      className="text-xs text-muted"
      title="Counted as loose cartons — the packing list does not say which box holds this item."
    >
      {quantityLabel(count)} carton{count === 1 ? "" : "s"}, unmapped
    </span>
  ) : (
    <span className="text-xs text-muted">—</span>
  );
}

function PackageChip({ label, quantity, uom }: {
  label: string; quantity: number | string; uom?: string | null;
}) {
  return (
    <span
      title={`${quantityLabel(quantity)}${uom ? ` ${uom}` : ""} in package ${label}`}
      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface py-0.5 pl-1.5 pr-1 text-[11px]"
    >
      <Package className="h-3 w-3 shrink-0 text-muted" aria-hidden />
      <span className="font-mono text-muted">{label}</span>
      <span className="rounded-md bg-content1 px-1.5 font-semibold tabular text-ink">
        {quantityLabel(quantity)}
      </span>
    </span>
  );
}

/** Nobody weighed it is not "it weighs nothing", and a printed 0 kg reads as a
 *  measurement somebody took. */
function Weight({ value }: { value?: number | null }) {
  if (value == null) {
    return (
      <span className="tabular text-muted" title="Not recorded on the packing list.">
        —
      </span>
    );
  }
  return <span className="tabular text-body">{quantityLabel(value)} kg</span>;
}

/** "2 of 3", because a delivered quantity means nothing without what was sent. Short
 *  delivery is the one number worth spotting from a metre away, so it is the only
 *  thing in the table that changes colour. */
function Delivered({ line }: { line: TRItem }) {
  const sent = Number(line.quantity ?? 0);
  const got = Number(line.delivered_qty ?? 0);
  const tone = got >= sent ? "text-ok" : got > 0 ? "text-warn" : "text-bad";
  return (
    <span className={`whitespace-nowrap font-semibold tabular ${tone}`}>
      {quantityLabel(got)}
      <span className="font-normal text-muted"> of {quantityLabel(sent)}</span>
    </span>
  );
}

interface Totals {
  items: number;
  qty: number;
  delivered: number;
  weight: number;
  weighed: number;
  unweighed: number;
  packages: number;
  uom: string | null;
}

/** Sums of what is printed above them — nothing derived, nothing fetched.
 *
 *  Packages are counted DISTINCT across lines, never added: the per-package split is
 *  attached per ITEM, so an item picked from two batches carries the same breakdown on
 *  both of its rows and adding them would report the load as twice its size. Where no
 *  line was mapped to a box, `package_count` is the freight count (each carton counted
 *  on exactly one line) and summing that is correct. */
function totals(lines: TRItem[]): Totals {
  const seenItems = new Set<string>();
  const seenPackages = new Set<string>();
  const uoms = new Set<string>();
  let qty = 0, delivered = 0, weight = 0, weighed = 0, unweighed = 0, counted = 0;

  for (const line of lines) {
    seenItems.add(String(line.item_id ?? line.item_code ?? line.item_name ?? line.id));
    qty += Number(line.quantity ?? 0);
    delivered += Number(line.delivered_qty ?? 0);
    if (line.weight_kg == null) unweighed += 1;
    else {
      weight += Number(line.weight_kg);
      weighed += 1;
    }
    counted += Number(line.package_count ?? 0);
    for (const part of packageQuantityParts(line)) {
      seenPackages.add(packageQuantityKey(part) || "loose");
    }
    const uom = (line.uom_code ?? "").trim();
    if (uom) uoms.add(uom);
  }

  return {
    items: seenItems.size,
    qty,
    delivered,
    weight,
    weighed,
    unweighed,
    packages: seenPackages.size || counted,
    // A total quantity can only wear a unit when every line shares one.
    uom: uoms.size === 1 ? [...uoms][0] : null,
  };
}

/** The header strip: what the load is, and which of its numbers nobody recorded.
 *  Saying "weight not recorded" once is worth more than a column of dashes. */
function summary(sum: Totals, showWeight: boolean, showDelivered: boolean): string {
  const parts = [
    `${sum.items} item${sum.items === 1 ? "" : "s"}`,
    `${quantityLabel(sum.qty)}${sum.uom ? ` ${sum.uom}` : ""}`,
    sum.packages > 0
      ? `${sum.packages} package${sum.packages === 1 ? "" : "s"}`
      : "packing not recorded",
    showWeight
      ? (sum.unweighed > 0
        ? `${quantityLabel(sum.weight)} kg (${sum.unweighed} unweighed)`
        : `${quantityLabel(sum.weight)} kg`)
      : "weight not recorded",
  ];
  if (showDelivered) {
    parts.push(`${quantityLabel(sum.delivered)} of ${quantityLabel(sum.qty)} delivered`);
  }
  return parts.join(" · ");
}
