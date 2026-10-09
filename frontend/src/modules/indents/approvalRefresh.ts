import type { Query, QueryClient } from "@tanstack/react-query";
import { INDENT_QUERY_ROOT, indentKeys, type IndentAccountScope } from "./api";
import { INDENT_APPROVALS_PHASE_INDEX, INDENT_PHASES, INDENT_STATUS } from "./constants";
import type { Indent, IndentJourney, IndentJourneyStage } from "./types";

export type IndentDecision = "approve" | "reject";

const DECISION_QUERY_KINDS = new Set([
  "detail",
  "journey",
  "list",
  "recent",
  "stats",
  "activity",
  "notifications",
]);

/**
 * The approvals phase is found by its position in the phase contract, never by
 * its wording: `journey.phases[].sequence` is 1-based against `INDENT_PHASES`,
 * exactly as the progress card reads it. A renamed or translated phase title
 * must not silently disable this projection.
 */
const APPROVALS_PHASE_SEQUENCE = INDENT_APPROVALS_PHASE_INDEX + 1;

function updatePhases(
  phases: IndentJourneyStage[],
  decision: IndentDecision,
  approvalContinues: boolean,
) {
  if (!Array.isArray(phases) || phases.length !== INDENT_PHASES.length) return phases;
  if (!phases.some((phase) => phase.sequence === APPROVALS_PHASE_SEQUENCE)) return phases;

  return phases.map((phase) => {
    if (phase.sequence < APPROVALS_PHASE_SEQUENCE) return phase;
    if (phase.sequence === APPROVALS_PHASE_SEQUENCE) {
      if (decision === "reject") {
        return { ...phase, status: "REJECTED", is_current: false };
      }
      return {
        ...phase,
        status: approvalContinues ? "PENDING" : "APPROVED",
        is_current: approvalContinues,
      };
    }
    if (phase.status === "NOT_REQUIRED") return { ...phase, is_current: false };
    if (decision === "reject" || approvalContinues) {
      return { ...phase, status: "PENDING", is_current: false };
    }
    if (phase.sequence === APPROVALS_PHASE_SEQUENCE + 1) {
      return { ...phase, status: "PENDING", is_current: true };
    }
    return { ...phase, status: "PENDING", is_current: false };
  });
}

/**
 * Projects a confirmed mutation onto the cached, frozen Journey chain. The next
 * server Journey response replaces this projection; until then the UI never
 * falls back to the pre-decision pending stage.
 */
export function projectConfirmedIndentDecision(
  journey: IndentJourney | undefined,
  updated: Indent,
  decision: IndentDecision,
  _rejectionReason = "",
): IndentJourney | undefined {
  if (!journey) return journey;
  const approvalContinues = updated.status === INDENT_STATUS.PENDING_APPROVAL
    || updated.status === INDENT_STATUS.SUBMITTED;
  const nextMessage = decision === "reject"
    ? "Request rejected"
    : approvalContinues ? "Approval completed" : "Waiting for allocation";

  // The mutation response does not contain a workflow action snapshot. Preserve only
  // already-authoritative cards; the active Journey refetch appends the real action.
  const stages = journey.stages.filter((stage) => (
    Boolean(stage.timestamp)
    && !stage.is_current
    && !["PENDING", "CURRENT", "NOT_REQUIRED"].includes(stage.status)
  ));
  return {
    ...journey,
    status: updated.status,
    current_stage: nextMessage,
    current_stage_message: nextMessage,
    stages,
    phases: updatePhases(
      journey.phases,
      decision,
      decision === "approve" && approvalContinues,
    ),
  };
}

function matchesScope(query: Query, scope: IndentAccountScope) {
  return query.queryKey[0] === INDENT_QUERY_ROOT
    && query.queryKey[1] === scope.employeeId
    && query.queryKey[2] === scope.activePositionId;
}

export function isDecisionAffectedQuery(query: Query, scope: IndentAccountScope) {
  return matchesScope(query, scope) && DECISION_QUERY_KINDS.has(String(query.queryKey[3]));
}

export async function cancelIndentDecisionReads(
  queryClient: QueryClient,
  scope: IndentAccountScope,
  indentId: number,
) {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: indentKeys.detail(scope, indentId), exact: true }),
    queryClient.cancelQueries({ queryKey: indentKeys.journey(scope, indentId), exact: true }),
  ]);
}

export async function commitConfirmedIndentDecision(
  queryClient: QueryClient,
  scope: IndentAccountScope,
  indentId: number,
  updated: Indent,
  decision: IndentDecision,
  rejectionReason = "",
) {
  await cancelIndentDecisionReads(queryClient, scope, indentId);
  queryClient.setQueryData(indentKeys.detail(scope, indentId), updated);
  queryClient.setQueryData<IndentJourney | undefined>(
    indentKeys.journey(scope, indentId),
    (current) => projectConfirmedIndentDecision(current, updated, decision, rejectionReason),
  );

  void queryClient.invalidateQueries({
    predicate: (query) => isDecisionAffectedQuery(query, scope),
    refetchType: "all",
  }).catch(() => undefined);
}
