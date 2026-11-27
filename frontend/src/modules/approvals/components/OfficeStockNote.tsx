import { History, PackageCheck } from "lucide-react";
import { fmtDate } from "@/shared/datetime";
import type { IndentOfficeStockLine } from "../types";

/**
 * Under each line on the indent approval screen (2026-11-20, MoM point 3): what the
 * raising office was LAST GIVEN of this item, and what it has IN HAND now — so the
 * approver weighs the request against the office's own shelf, not in the dark.
 *
 * Two chips. "Last given" names the quantity, the date and the document it came on;
 * "In hand" is the balance at the office's stocking point. An office with no stocking
 * point says so in words — "no record" is not "holds none".
 */
export function OfficeStockNote({
  line, hasPoint, unit, loading,
}: {
  line?: IndentOfficeStockLine;
  hasPoint: boolean;
  unit: string;
  loading?: boolean;
}) {
  if (loading) return <span className="mt-1.5 block h-5 w-56 animate-pulse rounded-full bg-content2" aria-hidden />;
  if (!hasPoint) {
    return <p className="mt-1.5 text-[11px] text-muted">No stock record for this office</p>;
  }
  const qty = (n?: number) => (n ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 3 });
  const given = line?.last_given;
  const balance = line?.balance ?? 0;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <span className="inline-flex min-h-6 items-center gap-1 rounded-full bg-info-bg px-2 text-[11px] font-medium text-info"
            title={given?.ref_no ? `Received on ${given.ref_no}` : undefined}>
        <History className="h-3 w-3" aria-hidden />
        {given
          ? <>Last given <b className="font-semibold">{qty(given.quantity)} {unit}</b>{given.date ? ` · ${fmtDate(given.date)}` : ""}</>
          : "Never given to this office"}
      </span>
      <span className={`inline-flex min-h-6 items-center gap-1 rounded-full px-2 text-[11px] font-medium ${
        balance > 0 ? "bg-ok-bg text-ok" : "bg-content2 text-muted"}`}>
        <PackageCheck className="h-3 w-3" aria-hidden />
        In hand <b className="font-semibold">{qty(balance)} {unit}</b>
      </span>
    </div>
  );
}
