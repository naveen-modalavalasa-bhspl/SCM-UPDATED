import type { ReactNode } from "react";
import { AlertTriangle, Check, Circle } from "lucide-react";
import { fmtDateTime, humanise } from "../format";
import type { ApprovalEvent, DispatchEvent } from "../types";

/**
 * The vertical trail used for a dispatch's custody/cold-chain events and for a
 * document's own progress.
 *
 * A breach (`is_breach`) is called out in red rather than mixed into the same grey
 * list: a temperature excursion on a cold-chain consignment is the one thing anyone
 * opens this panel to find.
 */

export interface TimelineEntry {
  id: string | number;
  title: string;
  at?: string | null;
  by?: string | null;
  detail?: ReactNode;
  tone?: "default" | "done" | "bad";
}

export function Timeline({ entries, empty = "Nothing recorded yet." }: {
  entries: TimelineEntry[];
  empty?: string;
}) {
  if (entries.length === 0) {
    return <div className="py-8 text-center text-sm text-muted">{empty}</div>;
  }

  return (
    <ol className="relative space-y-5 border-l border-line pl-6">
      {entries.map((e) => {
        const tone = e.tone ?? "default";
        const Icon = tone === "bad" ? AlertTriangle : tone === "done" ? Check : Circle;
        const ring =
          tone === "bad" ? "bg-bad-bg text-bad" : tone === "done" ? "bg-ok-bg text-ok" : "bg-content2 text-muted";
        return (
          <li key={e.id} className="relative">
            <span
              className={`absolute -left-[31px] flex h-5 w-5 items-center justify-center rounded-full ring-4 ring-content1 ${ring}`}
            >
              <Icon className="h-3 w-3" />
            </span>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className={`text-sm font-semibold ${tone === "bad" ? "text-bad" : "text-ink"}`}>
                {e.title}
              </span>
              <span className="text-[11px] text-muted">{fmtDateTime(e.at)}</span>
            </div>
            {e.by && <div className="text-xs text-muted">{e.by}</div>}
            {e.detail && <div className="mt-1 text-xs text-body">{e.detail}</div>}
          </li>
        );
      })}
    </ol>
  );
}

// SUBMITTED is dropped: the "Raised" entry the screens build from the document's own
// created_at already says it, and showing both reads as two separate events.
const APPROVAL_VERB: Record<string, string> = {
  APPROVED: "approved",
  REJECTED: "rejected",
  RETURNED: "returned for changes",
  DELEGATED: "delegated",
  FALLBACK: "routed by fallback",
  MOVED: "moved to another approval chain",
};

/**
 * Maps the engine's `wf_actions` rows onto the trail.
 *
 * Every rung, not just the last one. A document's own `approved_at`/`approved_by_name`
 * are written when the WHOLE ladder finishes, so on a two-rung ladder the first
 * approver's decision is recorded here and nowhere else — a panel built from the
 * document's columns alone silently loses it.
 */
export function approvalsToTimeline(events: ApprovalEvent[] = []): TimelineEntry[] {
  return events
    .filter((e) => e.action !== "SUBMITTED")
    .map((e, index) => {
      const verb = APPROVAL_VERB[e.action] ?? humanise(e.action).toLowerCase();
      const stage = e.stage_name?.trim();
      return {
        id: `wf-${e.stage_sequence}-${index}`,
        title: stage ? `${stage} ${verb}` : humanise(e.action),
        at: e.acted_at,
        by: [e.actor_name, e.actor_position].filter(Boolean).join(" · ") || null,
        tone: e.action === "REJECTED" ? ("bad" as const) : ("done" as const),
        detail: e.comments ? <span className="text-muted">{e.comments}</span> : undefined,
      };
    });
}

/** Maps `out_dispatch_events` rows onto the trail. */
export function toTimeline(events: DispatchEvent[] = []): TimelineEntry[] {
  return [...events]
    .sort((a, b) => new Date(a.event_at).getTime() - new Date(b.event_at).getTime())
    .map((e) => {
      const readings = [
        e.temperature_c != null ? `${e.temperature_c}°C` : null,
        e.humidity_percent != null ? `${e.humidity_percent}% RH` : null,
      ].filter(Boolean);
      return {
        id: e.id,
        title: humanise(e.event_type),
        at: e.event_at,
        by: [e.recorded_by_name, e.location_name].filter(Boolean).join(" · ") || null,
        tone: e.is_breach ? ("bad" as const) : ("done" as const),
        detail: (
          <>
            {readings.length > 0 && <span className="mr-2 tabular">{readings.join(" · ")}</span>}
            {e.is_breach && <span className="font-semibold text-bad">Threshold breach</span>}
            {e.notes && <div className="text-muted">{e.notes}</div>}
          </>
        ),
      };
    });
}
