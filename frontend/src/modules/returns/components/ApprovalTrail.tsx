import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { StatusPill } from "@/shared/components";
import { returnsApi } from "../api";
import { SectionCard } from "./DetailChrome";

/**
 * Who has signed, in order. Read straight off `wf_actions` through the engine, so it
 * is the audit trail rather than a second copy of it — a row is never deleted (rule 9),
 * which is why a rejection and a later resubmission both stay visible here.
 *
 * Drawn as a timeline rather than as a list of bordered blocks (2026-09-10): a trail is a
 * sequence, and a rail with a node per press says so at a glance — where a repeated
 * left-hand border only said "these rows are related". The person is named in FULL here
 * on purpose. The tracker above reduces an approver to their rank because it has ninety
 * pixels per dot; this column has room, and "who actually pressed it" is the whole
 * question an audit trail answers.
 */
export function ApprovalTrail({ returnId }: { returnId: number }) {
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["returns", returnId, "history"],
    queryFn: () => returnsApi.history(returnId),
  });

  return (
    <SectionCard
      icon={<History className="h-4 w-4" />}
      title="Approval trail"
      aside={rows.length > 0 ? (
        <span className="tabular rounded-full bg-content2 px-2.5 py-1 text-xs font-semibold text-muted">
          {rows.length}
        </span>
      ) : undefined}
    >
      {isLoading && <p className="text-sm text-muted">Loading…</p>}

      {!isLoading && rows.length === 0 && (
        <p className="text-sm text-muted">
          This return has not been submitted for approval yet.
        </p>
      )}

      <ol className="space-y-0">
        {rows.map((row, index) => (
          <li
            key={`${row.stage_sequence}-${row.acted_at}-${index}`}
            className="relative flex gap-3 pb-5 last:pb-0"
          >
            {/* The rail, drawn per row so the last press has no tail hanging off it. */}
            {index < rows.length - 1 && (
              <span
                aria-hidden="true"
                className="absolute left-[5px] top-3.5 h-[calc(100%-0.5rem)] w-0.5 bg-line"
              />
            )}
            <span
              aria-hidden="true"
              className="relative z-10 mt-2 h-2.5 w-2.5 shrink-0 rounded-full border-2 border-content1 bg-step-done-rail ring-1 ring-line"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={row.action} />
                <span className="text-sm font-semibold text-ink">
                  {row.actor_name ?? "—"}
                </span>
                {row.actor_position && (
                  <span className="rounded-full bg-content2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                    {row.actor_position}
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-muted">
                {row.stage_name ?? "—"}
                {row.acted_at ? ` · ${new Date(row.acted_at).toLocaleString()}` : ""}
              </div>
              {row.comments && (
                <p className="mt-1.5 break-words rounded-lg bg-content2/60 px-2.5 py-1.5 text-sm text-body">
                  {row.comments}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </SectionCard>
  );
}
