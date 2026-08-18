import { useQuery } from "@tanstack/react-query";
import { Check, Clock, Minus, Undo2, X } from "lucide-react";
import { Card, StatusPill } from "@/shared/components";
import { CardBody, Skeleton } from "@heroui/react";
import {
  approvalTrailApi, approvalTrailKey, type ProcurementDocType,
} from "../api";
import type { ApprovalEventRow } from "../types";

/**
 * Where a procurement document is waiting, and every rung it has already passed.
 *
 * One component for all four buying documents, because the answer comes from the
 * approval ENGINE and the engine does not care which document asked. Nothing about a
 * ladder is known here: rung names, approver names and the order of the rungs are all
 * whatever the server resolved, so renaming a rung on Settings > Approvals Config or
 * re-pointing it at a different post shows through with no change to this file.
 *
 * "Waiting with" is read live rather than from the document's own
 * `current_approver_name` — that column is a snapshot written at submit, and a ladder
 * edited afterwards leaves it naming somebody who can no longer sign.
 *
 * Read-only by design. It never offers an Approve button: who MAY sign is a different
 * question from who the document is with, and the screens that own the decision
 * already ask it properly.
 */

const ACTION_ICON: Record<string, typeof Check> = {
  APPROVED: Check,
  SUBMITTED: Clock,
  REJECTED: X,
  RETURNED: Undo2,
  DELEGATED: Undo2,
  CANCELLED: Minus,
};

/** Edge colour only — the row carries no second tick mark. */
const ACTION_TONE: Record<string, string> = {
  APPROVED: "border-ok/40 bg-ok-bg text-ok",
  SUBMITTED: "border-line bg-content2 text-muted",
  REJECTED: "border-bad/40 bg-bad-bg text-bad",
  RETURNED: "border-warn/40 bg-warn-bg text-warn",
  DELEGATED: "border-warn/40 bg-warn-bg text-warn",
  CANCELLED: "border-line bg-content2 text-muted",
};

const ACTION_LABEL: Record<string, string> = {
  APPROVED: "Approved",
  SUBMITTED: "Submitted",
  REJECTED: "Rejected",
  RETURNED: "Returned for correction",
  DELEGATED: "Delegated",
  CANCELLED: "Cancelled",
};

function formatWhen(value?: string | null) {
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleString(undefined, {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function EventRow({ event, isLast }: { event: ApprovalEventRow; isLast: boolean }) {
  const action = (event.action || "").toUpperCase();
  const Icon = ACTION_ICON[action] ?? Clock;
  const tone = ACTION_TONE[action] ?? "border-line bg-content2 text-muted";
  const when = formatWhen(event.acted_at);
  return (
    <li className="relative flex gap-3">
      <div className="flex flex-col items-center">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full border ${tone}`}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        {!isLast && <span className="mt-1 h-full min-h-6 w-px bg-line" />}
      </div>
      <div className="min-w-0 flex-1 pb-4">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-sm font-semibold text-body">
            {ACTION_LABEL[action] ?? action}
          </span>
          {event.stage_name && (
            <span className="text-sm text-muted">· {event.stage_name}</span>
          )}
        </div>
        {(event.actor_name || event.actor_position) && (
          <p className="mt-0.5 break-words text-sm text-muted">
            {event.actor_name}
            {event.actor_name && event.actor_position ? ` · ${event.actor_position}` : (event.actor_position ?? "")}
          </p>
        )}
        {when && <p className="mt-0.5 text-xs text-muted">{when}</p>}
        {event.comments && (
          <p className="mt-1 break-words rounded-md bg-content2 px-2 py-1 text-sm text-body">
            {event.comments}
          </p>
        )}
      </div>
    </li>
  );
}

export function ApprovalTrail({
  docType, docId,
}: { docType: ProcurementDocType; docId: number }) {
  const { data, isLoading, error } = useQuery({
    queryKey: approvalTrailKey(docType, docId),
    queryFn: () => approvalTrailApi.get(docType, docId),
    enabled: Number.isFinite(docId) && docId > 0,
    staleTime: 30_000,
  });

  if (isLoading) return <Skeleton className="h-32 rounded-2xl" />;

  // A document nobody can read the trail of is not an error worth a red banner on a
  // screen that already rendered — the detail above it is the point of the page.
  if (error || !data) return null;

  const waiting = data.pending_with.map((p) => p.name).filter(Boolean);
  const neverSubmitted = !data.instance_status && data.history.length === 0;

  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Approvals
          </h2>
          {data.instance_status && <StatusPill status={data.instance_status} />}
        </div>

        {neverSubmitted ? (
          <p className="text-sm text-muted">
            Not submitted for approval yet.
          </p>
        ) : waiting.length > 0 ? (
          <p className="rounded-lg border border-warn/30 bg-warn-bg px-3 py-2 text-sm text-warn">
            <span className="font-semibold">Waiting with</span>{" "}
            {waiting.join(", ")}
            {data.stage_name ? ` · ${data.stage_name}` : ""}
          </p>
        ) : (
          <p className="text-sm text-muted">
            {/* No pending row and a finished instance is the normal end state. A
                document still IN_PROGRESS with nobody pending is the stranded case
                worth naming out loud rather than showing as a blank. */}
            {data.instance_status === "IN_PROGRESS"
              ? "In approval, but no approver is currently assigned — check the ladder on Settings > Approvals Config."
              : "No approval pending."}
          </p>
        )}

        {data.history.length > 0 && (
          <ol className="mt-1">
            {data.history.map((event, index) => (
              <EventRow
                key={`${event.stage_sequence ?? 0}-${event.acted_at ?? index}-${index}`}
                event={event}
                isLast={index === data.history.length - 1}
              />
            ))}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}
