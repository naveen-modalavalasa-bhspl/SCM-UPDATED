import { fmtDate, todayIst } from "@/shared/datetime";
import { dueHint, type DueTone } from "./deliveryWindow";

const TONE: Record<DueTone, string> = {
  ok: "text-ok",
  soon: "text-warn",
  late: "font-semibold text-danger",
  muted: "text-muted",
};

/**
 * One schedule date in a list cell (2026-11-20): the date, and under it how it reads
 * against today — "In 3 days", "Today", "2 days late". `pending` marks a date the
 * goods still have to meet (not yet dispatched / not yet delivered), which is the only
 * case "late" is said. Used for the Dispatch date and Expected delivery columns on
 * Consignments, Dispatch and Shipments, so all three read alike.
 */
export function ScheduleDate({ date, pending = false }: { date?: string | null; pending?: boolean }) {
  if (!date) return <span className="text-sm text-muted">—</span>;
  const hint = dueHint(date, todayIst(), { pending });
  return (
    <div className="whitespace-nowrap">
      <div className="text-sm text-ink">{fmtDate(date)}</div>
      {hint && <div className={`text-[11px] ${TONE[hint.tone]}`}>{hint.text}</div>}
    </div>
  );
}
