import { StatusPill } from "@/shared/components";
import { fmtDateTime } from "@/shared/datetime";
import type { ApprovalHistoryRow } from "../types";

/** Initials for the history dot — a name is what an approver recognises, and two
 *  letters of it is enough to tell one rung from the next down a timeline. */
const initialsOf = (name?: string | null) =>
  (name ?? "System").trim().split(/\s+/).slice(0, 2).map((part) => part[0] ?? "").join("").toUpperCase() || "S";

const ACTION_TONE: Record<string, string> = {
  APPROVED: "bg-ok-bg text-ok",
  REJECTED: "bg-bad-bg text-bad",
  RETURNED: "bg-warn-bg text-warn",
  DELEGATED: "bg-info-bg text-info",
};

/** What happened before this desk, as a timeline: the ladder is a sequence, and a
 *  stack of separated blocks never said which rung came first. */
export function HistoryTimeline({ rows }: { rows: ApprovalHistoryRow[] }) {
  return (
    <ol className="space-y-0">
      {rows.map((row, index) => (
        <li key={row.id} className="relative flex gap-3 px-4 py-3 sm:px-5">
          {/* The connector stops at the last entry, so the line reads as a chain that
              has ended here rather than one that trails off into the card's edge. */}
          {index < rows.length - 1 && (
            <span aria-hidden className="absolute left-[2.1rem] top-12 bottom-0 w-px bg-line sm:left-[2.35rem]" />
          )}
          <span
            className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-[11px] font-bold ${
              ACTION_TONE[row.action] ?? "bg-content2 text-muted"
            }`}
          >
            {initialsOf(row.actor_name)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-sm font-semibold text-ink">{row.actor_name ?? "System"}</strong>
              <StatusPill status={row.action} />
            </div>
            <p className="text-xs text-muted">
              {row.stage_name ?? `Stage ${row.stage_sequence}`} · {row.actor_position ?? "Position unavailable"}
              {row.acted_at ? ` · ${fmtDateTime(row.acted_at)}` : ""}
            </p>
            {row.comments && (
              <p className="mt-2 rounded-xl bg-content2 px-3 py-2 text-sm text-body">{row.comments}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
