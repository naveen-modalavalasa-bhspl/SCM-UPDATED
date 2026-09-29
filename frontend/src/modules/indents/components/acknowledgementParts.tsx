import {
  Boxes, CheckCircle2, Clock, PackageCheck, ShoppingCart, Truck,
} from "lucide-react";
import { INDENT_STATUS } from "../constants";
import type { Acknowledgement, AcknowledgementLine } from "../types";

/**
 * The pieces both acknowledgement screens are built from.
 *
 * The list and the screen that confirms one delivery are two routes now, and every
 * one of these reads the same fact the same way on both. Kept here rather than
 * exported from a page, so neither screen owns the other's wording.
 */


/** The two kinds of paperwork a receipt carries: what the goods looked like, and the
 *  vendor's bill if one came with them. */
export const PHOTO = "RECEIPT_PHOTO";
export const BILL = "RECEIPT_BILL";


export const qty = (value: number) => Number(value ?? 0).toLocaleString();

/** The most it makes sense to confirm today: what reached you but is unconfirmed. */
export const receivable = (line: AcknowledgementLine) =>
  Math.max(line.dispatched_quantity - line.received_quantity, 0);

export const outstanding = (line: AcknowledgementLine) =>
  Math.max(line.approved_quantity - line.received_quantity, 0);

/** What of this line somebody is already buying in. Absent on an older backend. */
export const onOrder = (line: AcknowledgementLine) =>
  Math.max(Number(line.on_order_quantity ?? 0), 0);

/**
 * Where one line's goods actually are.
 *
 * Read top-down, the same order the server reads it in: the nearest place the goods
 * have got to is the honest answer, and a stage is only ever claimed by the number
 * that proves it. The pill used to fall through to "On the way" for everything that
 * was neither settled nor confirmable, so a line still sitting with procurement — not
 * picked, not packed, not loaded — told the person waiting for it that it was
 * travelling. Nothing here says a thing has moved unless something was dispatched.
 */
export type LineStage = "received" | "arrived" | "packed" | "on_order" | "waiting";

export function lineStage(line: AcknowledgementLine): LineStage {
  if (outstanding(line) === 0) return "received";
  if (receivable(line) > 0) return "arrived";
  if (Number(line.issued_quantity ?? 0) > Number(line.dispatched_quantity ?? 0)) {
    return "packed";
  }
  if (onOrder(line) > 0) return "on_order";
  return "waiting";
}

/**
 * How each stage reads, and what colour it wears.
 *
 * `caption` is only a fallback: the server derives the sentence (`pending_with`) and
 * it is the one that shows, so the wording cannot drift between the screen and the
 * documents behind it. These are here for a line an older backend served without one.
 *
 * `bar` is the same stage as a SOLID fill, for the stage bar. It never uses the solid
 * brand fill, which carries the brand sweep as a background image and would draw a
 * slice of gradient inside a 6px band.
 */
export const STAGE: Record<LineStage, {
  label: string;
  tone: string;
  bar: string;
  icon: typeof Truck;
  caption: string;
}> = {
  received: {
    label: "Received", tone: "bg-ok-bg text-ok", bar: "bg-ok",
    icon: CheckCircle2, caption: "",
  },
  arrived: {
    // Label is the quantity — this is the one stage with something to press.
    label: "", tone: "bg-brand-050 text-brand", bar: "bg-step-live",
    icon: PackageCheck, caption: "On the way to you",
  },
  packed: {
    label: "Packed to send", tone: "bg-info-bg text-info", bar: "bg-info/55",
    icon: Boxes, caption: "Issued, waiting to be dispatched",
  },
  on_order: {
    label: "On order", tone: "bg-warn-bg text-warn", bar: "bg-warn/60",
    icon: ShoppingCart, caption: "With procurement",
  },
  waiting: {
    label: "Not dispatched", tone: "bg-neutral-bg text-neutral", bar: "bg-content3",
    icon: Clock, caption: "In the warehouse, not yet issued",
  },
};

/** The order the bar is drawn in: furthest along first, so it fills left to right. */
const STAGE_ORDER: LineStage[] = ["received", "arrived", "packed", "on_order", "waiting"];

/** What each stage is called in the bar's legend and tooltip. */
const STAGE_WORD: Record<LineStage, string> = {
  received: "received",
  arrived: "ready to confirm",
  packed: "packed",
  on_order: "on order",
  waiting: "not dispatched",
};

/**
 * How each kind of unit identifier is named on this screen.
 *
 * Keyed on `tracking_type`, which the server derives from the item (the same answer
 * the issue picker is given) — so the requester matching units in their hands is
 * told which of the two numbers printed on the box is the one being checked.
 */
export const TRACKING: Record<string, { heading: string; unit: string }> = {
  SERIAL: { heading: "Serial numbers", unit: "serial number" },
  IMEI: { heading: "IMEI numbers", unit: "IMEI" },
  ASSET: { heading: "Asset tags", unit: "asset tag" },
  CONSUMABLE: { heading: "Lot codes", unit: "lot code" },
};

/** The one line of reassurance a stage owes someone who cannot act on it yet. */
export const STAGE_HINT: Partial<Record<LineStage, string>> = {
  on_order: "Being bought in. It appears here to confirm once it is dispatched to you.",
  waiting: "Nothing to confirm yet. It appears here once the warehouse dispatches it.",
  packed: "Picked and packed. It appears here to confirm once it leaves the warehouse.",
};

/**
 * What the status says to the person who raised it. CLOSED reads as FULFILLED (the
 * badge does that wording), and anything that landed short of what was approved reads
 * as PARTIALLY FULFILLED — "closed" is a system word, and a requester who got 8 of 10
 * has not been fulfilled.
 */
export function displayStatus(row: Acknowledgement) {
  if (row.status !== INDENT_STATUS.CLOSED) return row.status;
  return row.lines.some((line) => outstanding(line) > 0)
    ? INDENT_STATUS.PARTIALLY_FULFILLED
    : INDENT_STATUS.CLOSED;
}

/** One line of summary for a whole indent, so the row says something without opening. */
export function summarise(row: Acknowledgement) {
  const waiting = row.lines.reduce((sum, line) => sum + receivable(line), 0);
  const open = row.lines.filter((line) => outstanding(line) > 0).length;
  if (waiting > 0) return `${qty(waiting)} waiting for you to acknowledge`;
  if (open === 0) return "Everything received";
  // Every remaining line is stuck at the same place more often than not; naming the
  // commonest is more use than counting them.
  const reasons = row.lines
    .filter((line) => outstanding(line) > 0)
    .map((line) => line.pending_with)
    .filter(Boolean) as string[];
  const commonest = reasons
    .sort((a, b) =>
      reasons.filter((r) => r === b).length - reasons.filter((r) => r === a).length)[0];
  return commonest ?? `${open} item${open === 1 ? "" : "s"} outstanding`;
}

/** The handle a requester actually chases a parcel with, whichever the mode issued. */
export const trackingHandle = (leg: { lr_no?: string | null; docket_no?: string | null }) =>
  leg.lr_no ?? leg.docket_no ?? null;

/* ---------------------------------------------------------------------------
 * Dates, read the same way on both screens.
 * ------------------------------------------------------------------------ */

/** Local midnight of a date or a timestamp, so `2026-09-18` never lands on the 17th
 *  west of Greenwich. NaN for anything unparseable, and every caller checks. */
export function dayStamp(value?: string | null) {
  const parts = (value ?? "").slice(0, 10).split("-").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return NaN;
  return new Date(parts[0], parts[1] - 1, parts[2]).getTime();
}

export function shortDate(value?: string | null) {
  const stamped = dayStamp(value);
  if (!Number.isFinite(stamped)) return (value ?? "").slice(0, 10);
  return new Date(stamped).toLocaleDateString(undefined, {
    day: "numeric", month: "short",
  });
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * "Needed by 12 Sep", or "3 days overdue" once that day has gone and something is
 * still owed. A needed-by date that has passed is the one date on the row that asks
 * somebody to chase, so it is the one that is allowed to be red — and only while the
 * indent is still owed something: a fulfilled indent is never overdue.
 */
export function neededBy(row: Acknowledgement): { text: string; overdue: boolean } | null {
  const due = dayStamp(row.required_date);
  if (!Number.isFinite(due)) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.round((today - due) / 86_400_000);
  const owed = row.lines.some((line) => outstanding(line) > 0);
  if (owed && days > 0) {
    return { text: `${plural(days, "day")} overdue · needed ${shortDate(row.required_date)}`, overdue: true };
  }
  if (owed && days === 0) return { text: "Needed today", overdue: true };
  return { text: `Needed by ${shortDate(row.required_date)}`, overdue: false };
}

/**
 * Where every item of one indent has got to, as one bar.
 *
 * One band per STAGE, as wide as the share of the indent's items at that stage —
 * counted in ITEMS, never in quantities: ten cables and one server are not eleven of
 * anything, and a bar summing them would say the server is a rounding error. The
 * legend under it is the same numbers in words, so the bar is never the only place
 * the answer is written.
 */
export function StageBar({ lines, legend = false }: {
  lines: AcknowledgementLine[];
  legend?: boolean;
}) {
  const counts = STAGE_ORDER
    .map((stage) => ({ stage, count: lines.filter((line) => lineStage(line) === stage).length }))
    .filter((entry) => entry.count > 0);
  const total = lines.length;
  if (total === 0) return null;
  const words = counts.map(({ stage, count }) => `${count} ${STAGE_WORD[stage]}`).join(", ");
  return (
    <div className="min-w-0">
      <div
        role="img"
        aria-label={`${plural(total, "item")}: ${words}`}
        className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full"
      >
        {counts.map(({ stage, count }) => (
          <span
            key={stage}
            title={`${count} ${STAGE_WORD[stage]}`}
            className={`h-full first:rounded-l-full last:rounded-r-full ${STAGE[stage].bar}`}
            style={{ width: `${(count / total) * 100}%` }}
          />
        ))}
      </div>
      {legend && (
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
          {counts.map(({ stage, count }) => (
            <li key={stage} className="inline-flex items-center gap-1.5">
              <span aria-hidden className={`h-2 w-2 rounded-full ${STAGE[stage].bar}`} />
              <span><b className="font-semibold tabular-nums text-body">{count}</b> {STAGE_WORD[stage]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "3 of 5 items received" — the bar's headline, in items like the bar itself. */
export function itemsReceived(row: Acknowledgement) {
  const total = row.lines.length;
  const done = row.lines.filter((line) => outstanding(line) === 0).length;
  return `${done} of ${plural(total, "item")} received`;
}
