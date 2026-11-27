import { ArrowRight, CalendarCheck2, Truck } from "lucide-react";
import { Input } from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { deliveryWindowIssue, windowDays } from "./deliveryWindow";

/**
 * When the consignment LEAVES and when it should ARRIVE (2026-11-20) — two dates the
 * desk and the receiving site both plan by, so each is its own field with its own
 * name: **Dispatch date** and **Expected delivery**. On the wire they are
 * `expected_delivery_from` and `expected_delivery`.
 *
 * Read as one sentence under them ("Leaves 22 Nov 2026 → arrives by 25 Nov 2026 ·
 * 3 days on the road"), so the person filling it sees the promise being made. The
 * rules are `deliveryWindowIssue`, the screen's copy of the server's guard: neither
 * date before the consignment date, and delivery never before dispatch. Moving the
 * dispatch date past the delivery date drags delivery along with it.
 */
export function DispatchScheduleField({
  dispatch, delivery, consignmentDate, disabled, onChange,
}: {
  dispatch: string | null | undefined;
  delivery: string | null | undefined;
  /** The consignment's own date — neither date may fall before it. */
  consignmentDate?: string | null;
  disabled?: boolean;
  onChange: (next: { dispatch: string | null; delivery: string | null }) => void;
}) {
  const issue = deliveryWindowIssue(dispatch, delivery, consignmentDate);
  const days = windowDays(dispatch, delivery);

  return (
    <div className="block">
      <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_auto_1fr] sm:gap-2">
        <label className="min-w-0">
          <span className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-body">
            <Truck className="h-4 w-4 text-muted" aria-hidden /> Dispatch date
            <span aria-hidden="true" className="text-danger">*</span>
            <span className="sr-only"> (required)</span>
          </span>
          <Input type="date" value={dispatch ?? ""} disabled={disabled} aria-required="true"
                 aria-label="Dispatch date" min={consignmentDate || undefined}
                 onChange={(event) => {
                   const value = event.target.value || null;
                   const end = value && delivery && delivery < value ? value : (delivery ?? null);
                   onChange({ dispatch: value, delivery: end });
                 }} />
        </label>
        <ArrowRight className="mb-3.5 hidden h-4 w-4 text-muted sm:block" aria-hidden />
        <label className="min-w-0">
          <span className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-body">
            <CalendarCheck2 className="h-4 w-4 text-muted" aria-hidden /> Expected delivery
            <span aria-hidden="true" className="text-danger">*</span>
            <span className="sr-only"> (required)</span>
          </span>
          <Input type="date" value={delivery ?? ""} disabled={disabled} aria-required="true"
                 aria-label="Expected delivery" min={dispatch || consignmentDate || undefined}
                 onChange={(event) => onChange({ dispatch: dispatch ?? null, delivery: event.target.value || null })} />
        </label>
      </div>
      {issue ? (
        <span className="mt-1 block text-xs font-semibold text-danger">{issue}</span>
      ) : dispatch && delivery ? (
        <span className="mt-1 block text-xs text-muted">
          Leaves <b className="font-semibold text-ink">{fmtDate(dispatch)}</b>
          {" → "}arrives by <b className="font-semibold text-ink">{fmtDate(delivery)}</b>
          {days === 0 ? " · same day" : days ? ` · ${days} day${days === 1 ? "" : "s"} on the road` : ""}
        </span>
      ) : (
        <span className="mt-1 block text-xs text-muted">
          When the goods leave, and the day the destination should have them.
        </span>
      )}
    </div>
  );
}
