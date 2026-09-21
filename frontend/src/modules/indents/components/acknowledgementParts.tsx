import {
  Boxes, Camera, CheckCircle2, Circle, Clock, ExternalLink, FileText, PackageCheck,
  ShoppingCart, Trash2, Truck,
} from "lucide-react";
import { Input } from "@/shared/components";
import { INDENT_STATUS } from "../constants";
import type {
  Acknowledgement, AcknowledgementLine, RaiserTracking, ReceiptAttachment,
} from "../types";

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
 */
export const STAGE: Record<LineStage, {
  label: string;
  tone: string;
  icon: typeof Truck;
  caption: string;
}> = {
  received: {
    label: "Received", tone: "bg-ok-bg text-ok", icon: CheckCircle2, caption: "",
  },
  arrived: {
    // Label is the quantity — this is the one stage with something to press.
    label: "", tone: "bg-brand-050 text-brand", icon: PackageCheck,
    caption: "On the way to you",
  },
  packed: {
    label: "Packed to send", tone: "bg-info-bg text-info", icon: Boxes,
    caption: "Issued, waiting to be dispatched",
  },
  on_order: {
    label: "On order", tone: "bg-warn-bg text-warn", icon: ShoppingCart,
    caption: "With procurement",
  },
  waiting: {
    label: "Not dispatched", tone: "bg-neutral-bg text-neutral", icon: Clock,
    caption: "In the warehouse, not yet issued",
  },
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

export function AttachmentRow({ attachment, onDelete, busy }: {
  attachment: ReceiptAttachment;
  onDelete: () => void;
  busy: boolean;
}) {
  const isBill = attachment.doc_category === BILL;
  return (
    <li className="flex items-center gap-2.5 rounded-xl border border-line bg-content1 px-3 py-2 text-sm">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-ok-bg text-ok">
        {isBill ? <FileText className="h-4 w-4" /> : <Camera className="h-4 w-4" />}
      </span>
      <span className="min-w-0 flex-1 truncate text-ink">{attachment.file_name}</span>
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted">
        {isBill ? "Bill" : "Photo"}
      </span>
      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        aria-label={`Remove ${attachment.file_name}`}
        className="shrink-0 rounded-lg p-1.5 text-muted transition hover:bg-bad-bg hover:text-bad disabled:opacity-50"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </li>
  );
}

/**
 * One item of the indent: how far it has got, and the box to say what turned up.
 *
 * A card rather than a table row — the table needed 520px and slid sideways on a phone,
 * which is exactly where someone standing at the delivery confirms it.
 */
export function LineCard({ line, value, onChange }: {
  line: AcknowledgementLine;
  value: string;
  onChange: (value: string) => void;
}) {
  const max = receivable(line);
  const approved = Number(line.approved_quantity ?? 0);
  const settled = outstanding(line) === 0;
  const ordered = onOrder(line);
  const stage = lineStage(line);
  const { tone, icon: StageIcon, caption } = STAGE[stage];
  const serials = line.serial_numbers?.filter(Boolean) ?? [];
  // What the labels on the goods actually say, SERVED — a serial, an IMEI, an asset
  // tag and a consumable lot code are fifteen characters of upper case apiece, and
  // only the item knows which one the person holding the box is being asked to read.
  const tracking = TRACKING[line.tracking_type ?? ""]
    ?? (line.is_serial_tracked ? TRACKING.SERIAL : null);
  // Nothing has been issued against this line, so there is nothing that could have
  // been recorded. Saying "Not recorded" there reads as a defect in the dispatch.
  const trackable = Boolean(tracking) && Number(line.issued_quantity ?? 0) > 0;
  const showSerials = serials.length > 0 || trackable;
  // The one stage with something to press names its quantity instead of itself.
  const label = stage === "arrived" ? `${qty(max)} to acknowledge` : STAGE[stage].label;
  // Approved is the whole bar; each band is the stage that far along, so the bar and
  // the numbers under it are the same facts read two ways.
  const share = (amount: number) =>
    (approved > 0 ? Math.min(100, Math.max(0, (Number(amount ?? 0) / approved) * 100)) : 0);
  const width = (amount: number) => `${share(amount)}%`;

  return (
    <li className="rounded-xl border border-line bg-content1 p-3 sm:p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-ink">{line.item_name ?? line.item_code}</div>
          <div className="font-mono text-[11px] text-muted">{line.item_code}</div>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${tone}`}
        >
          <StageIcon className="h-3.5 w-3.5" aria-hidden />
          {label}
        </span>
      </div>

      <div className="relative mt-3 h-1.5 overflow-hidden rounded-full bg-content3">
        {/* On order is not progress — it is a promise from procurement — so it wears
            its own colour and starts where the physical bands END, rather than being
            drawn over them. Overlapping the two showed a line that was fully
            accounted for (5 sent, 15 being bought) as three quarters of a bar. */}
        <div className="absolute inset-y-0 bg-warn/40"
             style={{ left: width(line.issued_quantity),
                      width: `${Math.min(share(ordered), 100 - share(line.issued_quantity))}%` }} />
        <div className="absolute inset-y-0 left-0 bg-brand/20"
             style={{ width: width(line.issued_quantity) }} />
        <div className="absolute inset-y-0 left-0 bg-brand/45"
             style={{ width: width(line.dispatched_quantity) }} />
        <div className="absolute inset-y-0 left-0 bg-ok"
             style={{ width: width(line.received_quantity) }} />
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        <span>Approved <b className="font-semibold tabular-nums text-ink">
          {qty(line.approved_quantity)}</b></span>
        {/* Shown only when there is one: a column of zeroes on every other line is
            noise, and "On order 20" is the whole answer to "where is my stuff" on
            the one line that has it. */}
        {ordered > 0 && (
          <span>On order <b className="font-semibold tabular-nums text-warn">
            {qty(ordered)}</b></span>
        )}
        <span>Sent <b className="font-semibold tabular-nums text-ink">
          {qty(line.dispatched_quantity)}</b></span>
        <span>Received <b className="font-semibold tabular-nums text-ink">
          {qty(line.received_quantity)}</b></span>
      </div>

      {!settled && (
        <div className="mt-1.5 text-[11px] text-muted">
          {/* The server's sentence, so the screen and the documents behind it cannot
              word the same state differently. */}
          <span className="font-medium text-body">{line.pending_with || caption}</span>
          {STAGE_HINT[stage] && (
            <span className="mt-0.5 block">{STAGE_HINT[stage]}</span>
          )}
        </div>
      )}

      {showSerials && (
        <div className="mt-3 rounded-lg border border-line bg-content2/70 px-3 py-2">
          <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px]">
            <span className="font-semibold text-body">
              {(tracking ?? TRACKING.SERIAL).heading}
            </span>
            <span className="tabular-nums text-muted">
              {serials.length > 0 ? serials.length : "Not recorded"}
            </span>
          </div>
          {serials.length > 0 ? (
            <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto pr-1">
              {serials.map((serial) => (
                <span
                  key={serial}
                  className="rounded-md border border-line bg-content1 px-2 py-1 font-mono text-[11px] text-ink"
                >
                  {serial}
                </span>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-muted">
              {`No ${(tracking ?? TRACKING.SERIAL).unit}s were recorded against what `
                + "was sent to you."}
            </div>
          )}
        </div>
      )}

      {max > 0 && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-content2 p-2">
          <span className="pl-1 text-sm font-medium text-body">Arrived now</span>
          {/* Fixed-width wrapper, not a class on the Input: `className` only reaches
              HeroUI's inputWrapper, so the field itself stays 100% wide. */}
          <div className="ml-auto w-24">
            <Input
              type="number"
              min={0}
              max={max}
              step="any"
              aria-label={`Received now for ${line.item_name ?? line.item_code}`}
              value={value}
              onChange={(event) => onChange(event.target.value)}
            />
          </div>
          <button
            type="button"
            onClick={() => onChange(String(max))}
            className="h-11 shrink-0 rounded-lg border border-line bg-content1 px-3 text-xs font-semibold text-brand transition hover:border-brand hover:bg-brand-050"
          >
            All {qty(max)}
          </button>
        </div>
      )}
    </li>
  );
}

/** The handle a requester actually chases a parcel with, whichever the mode issued. */
export const trackingHandle = (leg: { lr_no?: string | null; docket_no?: string | null }) =>
  leg.lr_no ?? leg.docket_no ?? null;

/**
 * How this delivery is travelling — the answer to "where is my stuff".
 *
 * Logistics knows the courier, the docket and the carrier's tracking page; the person
 * waiting on the goods held none of it, and had no screen they were permitted to read
 * it on. It rides on this row instead: told once, on the same card as the button that
 * says it arrived.
 */
export function ShipmentCard({ leg }: { leg: RaiserTracking }) {
  const handle = trackingHandle(leg);
  // An outside company is carrying it — a courier or a third-party truck. That is
  // exactly when "how is it coming" stops being obvious to the person waiting for it,
  // and it is read off the carrier rather than off a list of mode names, because this
  // module may not import logistics' mode tables (rule 5). A hand-over and a company
  // vehicle have no carrier, and their answer to "where is it" is the driver below.
  const outside = Boolean(leg.carrier_name);

  const who = leg.carrier_name
    || [leg.vehicle_number, leg.driver_name].filter(Boolean).join(" · ");
  const landed = leg.acknowledged_at ?? leg.delivered_at;
  const latest = [...(leg.events ?? [])].sort(
    (left, right) => Date.parse(right.event_at) - Date.parse(left.event_at),
  )[0];
  return (
    <li className="rounded-xl border border-line bg-content1 p-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-050 text-brand">
          <Truck className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-xs font-semibold text-ink">{leg.tr_no}</span>
            <span className="text-[11px] uppercase tracking-wide text-muted">
              {leg.status.replace(/_/g, " ").toLowerCase()}
            </span>
          </div>
          <div className="text-sm text-body">{who || "Hand delivery"}</div>
          {outside && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <span className="rounded-full bg-content2 px-2 py-0.5 text-[11px] font-medium text-body">
                {leg.carriage_label ?? "Road"}
              </span>
              <span className="rounded-full bg-brand-050 px-2 py-0.5 text-[11px] font-medium text-brand">
                {leg.mode_label ?? leg.mode}
              </span>
            </div>
          )}
          {handle && (
            <div className="mt-0.5 text-xs text-muted">
              Docket <span className="font-mono text-ink">{handle}</span>
            </div>
          )}
          <div className="mt-0.5 text-[11px] text-muted">
            {landed
              ? `Arrived ${landed.slice(0, 10)}`
              : leg.dispatched_at
                ? `Sent ${leg.dispatched_at.slice(0, 10)}${
                  leg.expected_delivery ? ` · due ${leg.expected_delivery}` : ""}`
                : "Not yet sent"}
          </div>
          {latest && (
            <div className={`mt-2 rounded-lg px-2.5 py-2 text-xs ${
              latest.is_exception ? "bg-bad-bg text-bad" : "bg-content2 text-body"
            }`}>
              <span className="font-semibold capitalize">
                {latest.event_type.replace(/_/g, " ").toLowerCase()}
              </span>
              {latest.location_name ? ` · ${latest.location_name}` : ""}
              {latest.description && (
                <span className="mt-0.5 block text-[11px] text-muted">{latest.description}</span>
              )}
            </div>
          )}
        </div>
        {leg.tracking_url && (
          <a
            href={leg.tracking_url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-11 shrink-0 items-center gap-1 rounded-lg border border-line px-3 text-xs font-semibold text-brand transition hover:border-brand hover:bg-brand-050"
          >
            Track <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>

    </li>
  );
}

/** One line of the "before you acknowledge" list — ticked green the moment it is satisfied. */
export function Requirement({ met, label }: { met: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-2 text-xs ${met ? "text-ok" : "text-muted"}`}>
      {met ? <CheckCircle2 className="h-4 w-4 shrink-0" />
        : <Circle className="h-4 w-4 shrink-0" />}
      <span>{label}</span>
    </li>
  );
}
