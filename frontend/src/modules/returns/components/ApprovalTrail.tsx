import { useQuery } from "@tanstack/react-query";
import { Card, StatusPill } from "@/shared/components";
import { returnsApi } from "../api";

/**
 * Who has signed, in order. Read straight off `wf_actions` through the engine, so it
 * is the audit trail rather than a second copy of it — a row is never deleted (rule 9),
 * which is why a rejection and a later resubmission both stay visible here.
 */
export function ApprovalTrail({ returnId }: { returnId: number }) {
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["returns", returnId, "history"],
    queryFn: () => returnsApi.history(returnId),
  });

  return (
    <Card className="p-4">
      <h2 className="mb-3 font-display text-lg font-bold text-ink">Approval trail</h2>

      {isLoading && <p className="text-sm text-muted">Loading…</p>}

      {!isLoading && rows.length === 0 && (
        <p className="text-sm text-muted">
          This return has not been submitted for approval yet.
        </p>
      )}

      <ol className="space-y-3">
        {rows.map((row, index) => (
          <li
            key={`${row.stage_sequence}-${row.acted_at}-${index}`}
            className="border-l-2 border-line pl-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={row.action} />
              <span className="text-sm font-medium text-ink">
                {row.actor_name ?? "—"}
              </span>
              {row.actor_position && (
                <span className="text-xs text-muted">{row.actor_position}</span>
              )}
            </div>
            <div className="mt-1 text-xs text-muted">
              {row.stage_name ?? "—"}
              {row.acted_at ? ` · ${new Date(row.acted_at).toLocaleString()}` : ""}
            </div>
            {row.comments && (
              <p className="mt-1 text-sm text-body">{row.comments}</p>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}
