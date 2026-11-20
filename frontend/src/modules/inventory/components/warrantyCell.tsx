import { ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import { fmtDate } from "@/shared/datetime";
import type { LotWarranty, UnitRow } from "../types";

/**
 * Warranty on Stock Balance (MoM 2026-11-18, point 25): what a lot's units carry from
 * the GRN they arrived on. The words are the GRN's own — "In warranty", "Ends in 20
 * days", "Expired 3 days ago" — and the colour follows the worst of them.
 */

/** "3 of 5 in warranty · 1 ends soon" — the lot in one line, or null for none. */
export function lotWarrantySentence(w: LotWarranty | undefined, units: number): string | null {
  if (!w || !w.covered) return null;
  const parts = [`${w.covered === units ? "All" : `${w.covered} of`} ${units} covered`];
  if (w.expiring) parts.push(`${w.expiring} end${w.expiring === 1 ? "s" : ""} within 30 days`);
  if (w.expired) parts.push(`${w.expired} expired`);
  return parts.join(" · ");
}

export const lotWarrantyTone = (w?: LotWarranty) =>
  !w?.covered ? "muted" : w.expired ? "bad" : w.expiring ? "warn" : "ok";

const TONE = {
  ok: "bg-ok-bg text-ok", warn: "bg-warn-bg text-warn", bad: "bg-bad-bg text-bad",
  muted: "bg-content2 text-muted",
} as const;

export function LotWarrantyCell({ warranty, units }: { warranty?: LotWarranty; units: number }) {
  const sentence = lotWarrantySentence(warranty, units);
  if (!sentence) return <span className="text-xs text-muted">—</span>;
  const tone = lotWarrantyTone(warranty);
  const Icon = tone === "bad" ? ShieldOff : tone === "warn" ? ShieldAlert : ShieldCheck;
  return (
    <div className="min-w-0" title={sentence}>
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE[tone]}`}>
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {warranty!.covered}/{units}
      </span>
      {warranty!.next_end && (
        <div className="mt-0.5 text-[10px] text-muted">next ends {fmtDate(warranty!.next_end)}</div>
      )}
      {(warranty!.expiring > 0 || warranty!.expired > 0) && (
        <div className={`text-[10px] font-semibold ${warranty!.expired ? "text-bad" : "text-warn"}`}>
          {[warranty!.expiring && `${warranty!.expiring} ending soon`, warranty!.expired && `${warranty!.expired} expired`]
            .filter(Boolean).join(" · ")}
        </div>
      )}
    </div>
  );
}

/** One unit's warranty as a chip, for the lot's unit list. */
export function UnitWarrantyChip({ unit }: { unit: UnitRow }) {
  const status = unit.warranty_status ?? "NONE";
  if (status === "NONE") return <span className="text-[10px] text-muted">No warranty</span>;
  const tone = status === "EXPIRED" ? "bad" : status === "EXPIRING" ? "warn" : "ok";
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${TONE[tone]}`}
          title={[unit.warranty_start && `${fmtDate(unit.warranty_start)} – ${fmtDate(unit.warranty_end)}`,
                  unit.warranty_card_no && `card ${unit.warranty_card_no}`].filter(Boolean).join(" · ")}>
      till {fmtDate(unit.warranty_end)} · {unit.warranty_text}
    </span>
  );
}
