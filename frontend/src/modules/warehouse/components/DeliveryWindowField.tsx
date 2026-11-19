import { ArrowRight, CalendarRange } from "lucide-react";
import { Input } from "@/shared/components";
import { fmtDateRange } from "@/shared/datetime";
import { deliveryWindowIssue, windowDays } from "./deliveryWindow";

/**
 * The expected delivery WINDOW on a consignment (2026-11-19): when the goods can
 * start arriving and the last day they should. Two dates, one field — read as one
 * sentence under it ("Arrives 22 – 25 Nov 2026 · a 4-day window"), so the person
 * filling it sees the promise they are making, not two loose boxes.
 *
 * The rules are `deliveryWindowIssue`, the screen's copy of the server's
 * `_guard_delivery_window`: neither end before the goods leave, the end never
 * before the start. The start box moves the end box's floor with it.
 */
export function DeliveryWindowField({
  from, to, leaves, disabled, onChange,
}: {
  from: string | null | undefined;
  to: string | null | undefined;
  /** The consignment date — nothing can arrive before it leaves. */
  leaves?: string | null;
  disabled?: boolean;
  onChange: (next: { from: string | null; to: string | null }) => void;
}) {
  const issue = deliveryWindowIssue(from, to, leaves);
  const days = windowDays(from, to);
  const startFloor = leaves || undefined;
  const endFloor = from || leaves || undefined;

  return (
    <div className="block">
      <span className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-body">
        <CalendarRange className="h-4 w-4 text-muted" aria-hidden />
        Expected delivery window
        <span aria-hidden="true" className="text-danger">*</span>
        <span className="sr-only"> (required)</span>
      </span>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <label className="min-w-0">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted">
            Arrives from
          </span>
          <Input type="date" value={from ?? ""} disabled={disabled} aria-required="true"
                 aria-label="Expected delivery — from"
                 min={startFloor}
                 onChange={(event) => {
                   const value = event.target.value || null;
                   // Moving the start past the end drags the end along, rather than
                   // leaving a window that runs backwards for the person to untangle.
                   const end = value && to && to < value ? value : (to ?? null);
                   onChange({ from: value, to: end });
                 }} />
        </label>
        <ArrowRight className="mt-5 h-4 w-4 text-muted" aria-hidden />
        <label className="min-w-0">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted">
            Arrives by
          </span>
          <Input type="date" value={to ?? ""} disabled={disabled} aria-required="true"
                 aria-label="Expected delivery — to"
                 min={endFloor}
                 onChange={(event) => onChange({ from: from ?? null, to: event.target.value || null })} />
        </label>
      </div>
      {issue ? (
        <span className="mt-1 block text-xs font-semibold text-danger">{issue}</span>
      ) : from && to ? (
        <span className="mt-1 block text-xs text-muted">
          Arrives <b className="font-semibold text-ink">{fmtDateRange(from, to)}</b>
          {days && days > 1 ? ` · a ${days}-day window` : " · on the day"}
        </span>
      ) : (
        <span className="mt-1 block text-xs text-muted">
          The first and the last day the destination should expect it.
        </span>
      )}
    </div>
  );
}
