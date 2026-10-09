import { useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  Boxes, CheckCircle2, Info, Layers, MapPin, Package, Scale, Truck,
} from "lucide-react";
import type { TRItem } from "../transportTypes";
import {
  manifestLines, packageQuantityKey, packageQuantityName, packageQuantityParts,
  quantityLabel,
} from "./consignmentToLines";
import {
  lineColor, loadShares, shareLabel, splitDocNo, stopLines, type StopLine,
} from "./manifestView";

/**
 * What travels — ONE panel, used by the desk and by the carrier portal.
 *
 * The manifest was drawn four times in four dialects: the shipment register called it
 * "Lines", the provider desk "What is being priced", the acknowledgement "Items in
 * this load", and the carrier's job sheet gave it no heading at all. This is the only
 * one now. Every screen that shows what is on the truck shows THIS.
 *
 * REDRAWN 2026-09-28 to be read at a glance rather than studied. It was a table whose
 * every row said the same three facts twice — "CON0005 → Bapulapadu (stop 1)" over
 * "CON0005 · Stop 1: Bapulapadu · indent IND0082" — in a font that made the one part
 * that differs look like the parts that do not. Four things replace it:
 *
 * 1. **The headline figures are tiles.** Quantity, packages, weight and (once it means
 *    something) delivered, each with its own word. A missing figure says so in the
 *    tile — "Not weighed" is information; a dash is a shrug.
 * 2. **A bar shows how the load is split** — one segment per line, in the same colour
 *    as the dot on its row, hovering either lights the other. Shares by quantity when
 *    every line counts in one unit, else by packages, else no bar (`loadShares`).
 * 3. **A trip reads as a ROUTE.** When every line is a consignment dropped at a stop
 *    (`stopLines`), the rows become numbered drops joined by the road, named by the
 *    place a driver goes to, with the consignment and the indent as labelled chips.
 *    A manifest of items stays a list of items.
 * 4. **It adds up on screen**, in a footer, so it can be checked against a gate pass
 *    without a calculator.
 *
 * Presentation only. It computes nothing the documents do not already carry: the
 * grouping is `manifestLines`, the per-package split is served by
 * `_attach_package_quantities`, the stops are read out of the lines' own remarks, and
 * the totals are sums of what is printed above them. One layout at every width — it
 * is opened on the phone a carrier carries, and nothing in it scrolls sideways.
 */

/** Delivery is only a question once somebody has said something about it. */
const DELIVERY_REPORTED = new Set(["DELIVERED", "ACKNOWLEDGED", "CLOSED"]);

export function ManifestTable({ items, status, className = "" }: {
  items: TRItem[] | undefined | null;
  /** The shipment's own status, so delivery appears when it starts to mean something.
   *  A part-delivered line forces it on regardless. */
  status?: string | null;
  className?: string;
}) {
  const lines = manifestLines(items);
  const stops = stopLines(lines);
  const ordered = stops ? stops.map((stop) => stop.line) : lines;
  const sum = totals(ordered);
  // A trip's lines carry "CON" as a unit, but the figure is the consignment's item
  // count — "4 CON" reads as four consignments. They are units of goods.
  const unit = stops ? "units" : sum.uom;

  const showDelivered = DELIVERY_REPORTED.has(status ?? "") || sum.delivered > 0;
  const split = loadShares(ordered, Boolean(unit));
  const [hovered, setHovered] = useState<number | null>(null);

  return (
    <section
      className={`overflow-hidden rounded-2xl border border-line/70 bg-content1 ${className}`}
    >
      <header className="flex items-center gap-3 px-4 pb-3 pt-4">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-info-bg text-info">
          {stops ? <Truck className="h-5 w-5" aria-hidden /> : <Boxes className="h-5 w-5" aria-hidden />}
        </span>
        <div className="min-w-0">
          <h3 className="font-display text-[15px] font-semibold text-ink">Items in this load</h3>
          {lines.length > 0 && (
            <p className="text-xs text-muted">{headline(sum, stops)}</p>
          )}
        </div>
      </header>

      {lines.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 pb-8 pt-4 text-center">
          <Package className="h-6 w-6 text-muted/60" aria-hidden />
          <p className="text-sm text-muted">No lines on this shipment.</p>
        </div>
      ) : (
        <>
          <FactTiles sum={sum} unit={unit} stops={stops} showDelivered={showDelivered} />

          {split && (
            <LoadBar
              lines={ordered}
              shares={split.shares}
              basis={split.basis}
              stops={stops}
              hovered={hovered}
              onHover={setHovered}
            />
          )}

          {stops ? (
            <RouteList
              stops={stops}
              shares={split?.shares}
              showDelivered={showDelivered}
              hovered={hovered}
              onHover={setHovered}
            />
          ) : (
            <ItemList
              lines={ordered}
              shares={split?.shares}
              showDelivered={showDelivered}
              hovered={hovered}
              onHover={setHovered}
            />
          )}

          {/* The check against the gate pass. Only worth drawing once there is more
            * than one row to add up. */}
          {lines.length > 1 && (
            <footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line/70 bg-content2/40 px-4 py-2.5 text-[13px]">
              <span className="font-semibold text-ink">Total</span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 tabular">
                <span className="font-semibold text-ink">
                  {quantityLabel(sum.qty)}
                  {unit && <span className="ml-1 font-normal text-muted">{unit}</span>}
                </span>
                {sum.packages > 0 && (
                  <span className="text-muted">{plural(sum.packages, "package")}</span>
                )}
                {sum.weighed > 0 && (
                  <span className="text-muted">{quantityLabel(sum.weight)} kg</span>
                )}
                {showDelivered && (
                  <span className="text-muted">
                    {quantityLabel(sum.delivered)} of {quantityLabel(sum.qty)} delivered
                  </span>
                )}
              </span>
            </footer>
          )}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ tiles */

function FactTiles({ sum, unit, stops, showDelivered }: {
  sum: Totals; unit: string | null; stops: StopLine[] | null; showDelivered: boolean;
}) {
  const weight = sum.weighed > 0
    ? {
      value: `${quantityLabel(sum.weight)} kg`,
      note: sum.unweighed > 0 ? `${sum.unweighed} not weighed` : null,
    }
    : { value: null, note: "Not weighed" };
  return (
    <div
      className={`grid grid-cols-2 gap-2 px-4 pb-4 ${
        showDelivered ? "sm:grid-cols-3 lg:grid-cols-5" : "sm:grid-cols-4"}`}
    >
      <Tile icon={stops ? <MapPin /> : <Layers />} label={stops ? "Drops" : "Items"}>
        {stops ? stops.length : sum.items}
      </Tile>
      <Tile icon={<Boxes />} label="Quantity">
        {quantityLabel(sum.qty)}
        {unit && <span className="ml-1 text-xs font-normal text-muted">{unit}</span>}
      </Tile>
      <Tile icon={<Package />} label="Packages" empty={sum.packages > 0 ? null : "Not recorded"}>
        {sum.packages}
      </Tile>
      <Tile icon={<Scale />} label="Weight" empty={weight.value ? null : weight.note} note={weight.value ? weight.note : null}>
        {weight.value}
      </Tile>
      {showDelivered && (
        <Tile icon={<CheckCircle2 />} label="Delivered">
          {quantityLabel(sum.delivered)}
          <span className="ml-1 text-xs font-normal text-muted">of {quantityLabel(sum.qty)}</span>
          <Progress value={sum.delivered} of={sum.qty} className="mt-1.5" />
        </Tile>
      )}
    </div>
  );
}

function Tile({ icon, label, children, empty, note }: {
  icon: ReactNode; label: string; children: ReactNode;
  /** Said in place of the figure when nobody recorded one. */
  empty?: string | null;
  note?: string | null;
}) {
  return (
    <div className="rounded-xl border border-line/60 bg-surface/60 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted [&_svg]:h-3.5 [&_svg]:w-3.5">
        {icon}
        {label}
      </div>
      {empty ? (
        <div className="mt-1 text-sm italic text-muted">{empty}</div>
      ) : (
        <div className="mt-0.5 text-lg font-semibold leading-tight tabular text-ink">{children}</div>
      )}
      {note && <div className="text-[11px] text-warn">{note}</div>}
    </div>
  );
}

/* --------------------------------------------------------------- load bar */

function LoadBar({ lines, shares, basis, stops, hovered, onHover }: {
  lines: TRItem[]; shares: number[]; basis: "quantity" | "packages";
  stops: StopLine[] | null; hovered: number | null; onHover: (id: number | null) => void;
}) {
  const reduce = useReducedMotion();
  const name = (index: number) => stops
    ? `Stop ${stops[index].sequence} · ${stops[index].place}`
    : lines[index].item_name ?? `Line ${index + 1}`;
  return (
    <div className="px-4 pb-4">
      <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted">
        <span className="font-medium uppercase tracking-wide">
          {stops ? "Where the load comes off" : "How the load is made up"}
        </span>
        <span>by {basis}</span>
      </div>
      <motion.div
        role="img"
        aria-label={lines.map((_, i) => `${name(i)}: ${shareLabel(shares[i])}`).join(", ")}
        className="flex h-3.5 gap-0.75 overflow-hidden rounded-full"
        initial={reduce ? false : { clipPath: "inset(0 100% 0 0 round 999px)" }}
        animate={{ clipPath: "inset(0 0% 0 0 round 999px)" }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
      >
        {lines.map((line, index) => (
          <span
            key={line.id}
            title={`${name(index)} — ${shareLabel(shares[index])} of the load`}
            onMouseEnter={() => onHover(line.id)}
            onMouseLeave={() => onHover(null)}
            className="h-full cursor-default transition-opacity duration-150"
            style={{
              // A sliver still gets a few pixels, so a 4-of-1,030 drop is visible.
              flex: `${shares[index]} 1 0%`,
              minWidth: 6,
              backgroundColor: lineColor(index),
              opacity: hovered == null || hovered === line.id ? 1 : 0.3,
            }}
          />
        ))}
      </motion.div>
    </div>
  );
}

/* ------------------------------------------------------------------ route */

function RouteList({ stops, shares, showDelivered, hovered, onHover }: {
  stops: StopLine[]; shares?: number[]; showDelivered: boolean;
  hovered: number | null; onHover: (id: number | null) => void;
}) {
  const reduce = useReducedMotion();
  return (
    <ol className="border-t border-line/60 px-4 py-3" aria-label="Drops, in delivery order">
      {stops.map((stop, index) => {
        const { line } = stop;
        const color = lineColor(index);
        const done = showDelivered && Number(line.delivered_qty ?? 0) >= Number(line.quantity ?? 0)
          && Number(line.quantity ?? 0) > 0;
        const last = index === stops.length - 1;
        return (
          <motion.li
            key={line.id}
            initial={reduce ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: reduce ? 0 : 0.05 * index }}
            onMouseEnter={() => onHover(line.id)}
            onMouseLeave={() => onHover(null)}
            className="relative flex gap-3"
          >
            {/* The road to the next drop. */}
            {!last && (
              <span
                aria-hidden
                className="absolute bottom-0 left-4.25 top-10 border-l-2 border-dashed border-line"
              />
            )}
            <span
              aria-hidden
              className={`relative z-1 mt-2 grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-bold text-white shadow-sm ring-4 ring-content1 transition-transform ${
                hovered === line.id ? "scale-110" : ""}`}
              // The ring is the panel's own surface, so the dashed road stops at it.
              style={{ backgroundColor: done ? "var(--color-ok)" : color }}
            >
              {done ? <CheckCircle2 className="h-4.5 w-4.5" /> : stop.sequence}
            </span>

            <div
              className={`mb-2 flex min-w-0 flex-1 flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-xl px-3 py-2.5 transition-colors ${
                hovered === line.id ? "bg-content2/70" : ""}`}
            >
              <div className="min-w-0 flex-1 basis-56">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-semibold text-ink">{stop.place}</span>
                  <span className="rounded-full bg-neutral-bg px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral">
                    Stop {stop.sequence}{last && stops.length > 1 ? " · last" : ""}
                  </span>
                  {line.is_fragile && <FragileTag />}
                </div>
                <div className="mt-0.5 truncate text-xs text-muted" title={stop.destination}>
                  {stop.destination}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {stop.consignmentNo && <DocChip label="Consignment" value={stop.consignmentNo} />}
                  {stop.indentNo && <DocChip label="Indent" value={stop.indentNo} />}
                </div>
              </div>

              <Figures
                line={line}
                unit="units"
                share={shares?.[index]}
                color={color}
                showDelivered={showDelivered}
              />
            </div>
          </motion.li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ items */

function ItemList({ lines, shares, showDelivered, hovered, onHover }: {
  lines: TRItem[]; shares?: number[]; showDelivered: boolean;
  hovered: number | null; onHover: (id: number | null) => void;
}) {
  const reduce = useReducedMotion();
  return (
    <ul className="divide-y divide-line/50 border-t border-line/60">
      {lines.map((line, index) => {
        const color = lineColor(index);
        return (
          <motion.li
            key={line.id}
            initial={reduce ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: reduce ? 0 : 0.04 * Math.min(index, 10) }}
            onMouseEnter={() => onHover(line.id)}
            onMouseLeave={() => onHover(null)}
            className={`flex gap-3 px-4 py-3 transition-colors ${
              hovered === line.id ? "bg-content2/60" : ""}`}
          >
            {/* The row's colour, matching its slice of the bar. */}
            {shares && (
              <span
                aria-hidden
                className="w-1 shrink-0 self-stretch rounded-full"
                style={{ backgroundColor: color }}
              />
            )}
            <div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <div className="min-w-0 flex-1 basis-56">
                <ItemCell line={line} />
                <div className="mt-2">
                  <Packing line={line} />
                </div>
              </div>
              <Figures
                line={line}
                unit={line.uom_code ?? null}
                share={shares?.[index]}
                color={color}
                showDelivered={showDelivered}
              />
            </div>
          </motion.li>
        );
      })}
    </ul>
  );
}

/** The item, and the two things that tell one row from an identical-looking one: the
 *  code, and the batch it was picked from. The batch lives in `remarks` ("Batch B12")
 *  and is what `manifestLines` splits on, so without it the same item out of two
 *  batches drew two rows a reader could not tell apart. */
function ItemCell({ line }: { line: TRItem }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-semibold text-ink">{line.item_name ?? "—"}</span>
        {line.is_fragile && <FragileTag />}
      </div>
      {(line.item_code || line.remarks) && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {line.item_code && (
            <span className="rounded-md bg-content2 px-1.5 py-0.5 font-mono text-[11px] text-muted">
              {line.item_code}
            </span>
          )}
          {line.remarks && (
            <span className="rounded-md bg-info-bg px-1.5 py-0.5 text-[11px] font-medium text-info">
              {line.remarks}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- shared parts */

/** The numbers on a row: the quantity loud, its share of the truck, and what it is
 *  packed in / weighs / was delivered — each only when it has an answer. */
function Figures({ line, unit, share, color, showDelivered }: {
  line: TRItem; unit: string | null; share?: number; color: string; showDelivered: boolean;
}) {
  const count = Number(line.package_count ?? 0);
  const parts = packageQuantityParts(line);
  return (
    <div className="flex shrink-0 flex-col items-end gap-1 text-right">
      <div className="whitespace-nowrap">
        <span className="text-xl font-bold leading-none tabular text-ink">
          {quantityLabel(line.quantity)}
        </span>
        {unit && <span className="ml-1 text-xs text-muted">{unit}</span>}
      </div>
      {share != null && (
        <span className="inline-flex items-center gap-1.5 text-[11px] text-muted">
          <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
          {shareLabel(share)} of load
        </span>
      )}
      <div className="flex flex-wrap justify-end gap-x-3 gap-y-0.5 text-xs text-muted">
        {/* Items with a per-box split show it as chips under the name instead. */}
        {!parts.length && count > 0 && (
          <span
            className="inline-flex items-center gap-1"
            title="Counted as cartons — the packing list does not say which box holds what."
          >
            <Package className="h-3.5 w-3.5" aria-hidden />
            {plural(count, "carton")}
          </span>
        )}
        {line.weight_kg != null && (
          <span className="inline-flex items-center gap-1">
            <Scale className="h-3.5 w-3.5" aria-hidden />
            {quantityLabel(line.weight_kg)} kg
          </span>
        )}
      </div>
      {showDelivered && <Delivered line={line} />}
    </div>
  );
}

/** A document number with its shared prefix quiet and the part that differs loud. */
function DocChip({ label, value }: { label: string; value: string }) {
  const { prefix, tail } = splitDocNo(value);
  return (
    <span
      title={`${label} ${value}`}
      className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1 text-[11px]"
    >
      <span className="font-medium text-muted">{label}</span>
      <span className="truncate font-mono">
        {prefix && <span className="text-muted/70">{prefix}</span>}
        <span className="font-semibold text-ink">{tail}</span>
      </span>
    </span>
  );
}

function FragileTag() {
  return (
    <span className="rounded bg-warn-bg px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warn">
      Fragile
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
  // Cartons the warehouse counted but never mapped to lines are shown beside the
  // quantity; saying nothing here is right — which box it is in is not known.
  if (Number(line.package_count ?? 0) > 0) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted">
      <Info className="h-3 w-3" aria-hidden />
      Packing not recorded
    </span>
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

/** "2 of 3", because a delivered quantity means nothing without what was sent. Short
 *  delivery is the one number worth spotting from a metre away, so it is the one
 *  thing on a row that changes colour. */
function Delivered({ line }: { line: TRItem }) {
  const sent = Number(line.quantity ?? 0);
  const got = Number(line.delivered_qty ?? 0);
  const tone = got >= sent ? "text-ok" : got > 0 ? "text-warn" : "text-bad";
  return (
    <div className="w-28">
      <div className={`whitespace-nowrap text-xs font-semibold tabular ${tone}`}>
        {quantityLabel(got)}
        <span className="font-normal text-muted"> of {quantityLabel(sent)} delivered</span>
      </div>
      <Progress value={got} of={sent} className="mt-1" />
    </div>
  );
}

function Progress({ value, of, className = "" }: { value: number; of: number; className?: string }) {
  const ratio = of > 0 ? Math.min(1, Math.max(0, value / of)) : 0;
  const tone = ratio >= 1 ? "bg-ok" : ratio > 0 ? "bg-warn" : "bg-bad";
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-content2 ${className}`}>
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(ratio * 100, ratio > 0 ? 4 : 0)}%` }} />
    </div>
  );
}

/* ----------------------------------------------------------------- totals */

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

/** One plain sentence under the heading: what this load IS. */
function headline(sum: Totals, stops: StopLine[] | null): string {
  if (stops) {
    return stops.length === 1
      ? "One drop on this truck."
      : `${stops.length} drops on one truck, delivered in the order below.`;
  }
  const items = plural(sum.items, "item");
  return sum.packages > 0 ? `${items} packed in ${plural(sum.packages, "package")}.` : `${items} on this load.`;
}

function plural(count: number, word: string): string {
  return `${quantityLabel(count)} ${word}${count === 1 ? "" : "s"}`;
}
