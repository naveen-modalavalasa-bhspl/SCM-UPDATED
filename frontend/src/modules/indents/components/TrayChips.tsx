import { Inbox } from "lucide-react";
import type { IssueTray } from "../types";

/**
 * The trays a pick went into at the issue desk (MoM 2026-11-18, point 14), as one row
 * of chips: "Tray T-04 · 5". Hovering a chip lists the codes inside it. Read-only — the
 * consignment, the dispatch and the acknowledgement all draw trays this way, and the
 * Delivery Challan never does.
 *
 * `highlight` names one unit's code: its tray is drawn solid, so a row listing one
 * handset says which tray to open.
 */
export function TrayChips({ trays, uom, highlight, className = "" }: {
  trays?: IssueTray[] | null; uom?: string | null; highlight?: string | null; className?: string;
}) {
  if (!trays?.length) return null;
  const mine = highlight ? trays.find((t) => t.codes?.includes(highlight))?.tray_no : null;
  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`} aria-label="Trays">
      <Inbox className="h-3.5 w-3.5 text-muted" aria-hidden />
      {trays.map((tray, index) => {
        const on = mine === tray.tray_no;
        const codes = tray.codes ?? [];
        return (
          <span key={`${tray.tray_no}-${tray.issue_no ?? ""}-${index}`}
                title={[
                  `Tray ${tray.tray_no}: ${tray.quantity}${uom ? ` ${uom}` : ""}`,
                  tray.issue_no && `from ${tray.issue_no}`,
                  codes.length ? `Codes: ${codes.join(", ")}` : null,
                ].filter(Boolean).join("\n")}
                className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${
                  on ? "bg-brand text-white" : "bg-brand/[0.08] text-brand"}`}>
            Tray <span className="mono">{tray.tray_no}</span>
            <span className={on ? "text-white/80" : "text-muted"}>· {tray.quantity}</span>
          </span>
        );
      })}
    </div>
  );
}

/** "T-01, T-02" — the trays a code list touches, for one-line summaries. */
export const trayNumbers = (trays?: IssueTray[] | null) =>
  (trays ?? []).map((t) => t.tray_no).filter(Boolean).join(", ");
