import { useEffect, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowLeft, Ban, Check, Circle, Clock, Loader2, Minus, RefreshCw, Undo2, X,
} from "lucide-react";
import { CardBody, Skeleton } from "@heroui/react";
import { Button, Card } from "@/shared/components";
import { IndentStatusBadge } from "../components/IndentStatusBadge";
import {
  INDENT_QUERY_GC_TIME, INDENT_QUERY_STALE_TIME, indentApi, indentKeys,
  isIndentUnavailableError, useIndentAccountCacheIsolation, useIndentAccountScope,
} from "../api";
import { INDENT_STATUS } from "../constants";
import { formatIndentDate, formatIndentDateTime, parseIndentTimestamp } from "../dateTime";
import {
  buildJourneyTracks, isOccurredJourneyStage, isResubmissionStage, isUpcomingJourneyStage,
  journeySteps, sortOccurredStages, stageStatus,
} from "../journeyModel";
import type { JourneyTrack, JourneyTrackState } from "../journeyModel";
import type { IndentJourneyHistoryEvent, IndentJourneyStage } from "../types";

export { isOccurredJourneyStage, isUpcomingJourneyStage, sortOccurredStages };

const COMPLETED_PHASE_STATUSES = new Set([
  "APPROVED", "COMPLETED", "SUBMITTED", "ACKNOWLEDGED", "NOT_REQUIRED", "SKIPPED",
]);

function formatDuration(seconds?: number | null) {
  if (!seconds || seconds < 60) return null;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

function stageTone(stage: IndentJourneyStage) {
  const status = stageStatus(stage);
  if (status === "REJECTED") return "border-bad bg-bad-bg text-bad";
  if (status === "RETURNED" || status === INDENT_STATUS.RETURNED_FOR_CORRECTION) return "border-warn bg-warn-bg text-warn";
  if (status === "CANCELLED") return "border-neutral bg-neutral-bg text-neutral";
  if (stage.is_current) return "border-brand bg-brand/5 text-brand";
  if (["APPROVED", "SUBMITTED", "COMPLETED", "ACKNOWLEDGED"].includes(status)) return "border-ok bg-ok text-white";
  if (status === "NOT_REQUIRED") return "border-line bg-content2 text-muted";
  return "border-line bg-white text-muted";
}

function statusLabel(stage: IndentJourneyStage) {
  if (stage.is_current) return "Current";
  const status = stageStatus(stage);
  if (
    (stage.stage_type === "draft" && status === "APPROVED")
    || (stage.stage_type === "submission" && status === "SUBMITTED")
  ) return "Completed";
  const labels: Record<string, string> = {
    SUBMITTED: "Submitted",
    APPROVED: "Approved",
    COMPLETED: "Completed",
    ACKNOWLEDGED: "Acknowledged",
    REJECTED: "Rejected",
    PENDING: "Pending",
    NOT_REQUIRED: "Not required",
    RETURNED: "Returned for correction",
    RETURNED_FOR_CORRECTION: "Returned for correction",
    CANCELLED: "Cancelled",
  };
  return labels[status] ?? "Status unavailable";
}

function stageKey(stage: IndentJourneyStage) {
  return stage.event_id
    || `${stage.sequence}-${stage.stage_type}-${stage.timestamp ?? ""}-${stage.reference_no ?? ""}`;
}

function correctedReturnStageKeys(stages: IndentJourneyStage[]) {
  const corrected = new Set<string>();
  const pendingReturns: string[] = [];
  stages.forEach((stage) => {
    const status = stageStatus(stage);
    const returned = status === "RETURNED" || status === INDENT_STATUS.RETURNED_FOR_CORRECTION;
    const resubmitted = isResubmissionStage(stage);
    if (returned) {
      pendingReturns.push(stageKey(stage));
      return;
    }
    if (resubmitted) {
      const returnKey = pendingReturns.pop();
      if (returnKey) corrected.add(returnKey);
    }
  });
  return corrected;
}

function StageIcon({ stage }: { stage: IndentJourneyStage }) {
  const status = stageStatus(stage);
  const cls = `grid h-9 w-9 shrink-0 place-items-center rounded-full border ${stageTone(stage)}`;
  if (status === "REJECTED") return <span className={cls}><X className="h-4 w-4" /></span>;
  if (status === "RETURNED" || status === INDENT_STATUS.RETURNED_FOR_CORRECTION) return <span className={cls}><Undo2 className="h-4 w-4" /></span>;
  if (status === "CANCELLED") return <span className={cls}><Ban className="h-4 w-4" /></span>;
  if (status === "NOT_REQUIRED") return <span className={cls}><Minus className="h-4 w-4" /></span>;
  if (["APPROVED", "SUBMITTED", "COMPLETED", "ACKNOWLEDGED"].includes(status)) return <span className={cls}><Check className="h-4 w-4" /></span>;
  if (stage.is_current) return <span className={cls}><Clock className="h-4 w-4" /></span>;
  return <span className={cls}><Circle className="h-4 w-4" /></span>;
}

/** The leg's colour, carried by its edge alone — never by a second tick mark. */
function trackAccent(state: JourneyTrackState) {
  const accents: Record<JourneyTrackState, string> = {
    COMPLETED: "border-l-ok",
    CURRENT: "border-l-brand",
    PENDING: "border-l-line",
    REJECTED: "border-l-bad",
    RETURNED: "border-l-warn",
  };
  return accents[state];
}

function JourneyStageRow({
  stage, isLast, correctionResubmitted = false,
}: { stage: IndentJourneyStage; isLast: boolean; correctionResubmitted?: boolean }) {
  const when = formatIndentDateTime(stage.timestamp);
  const duration = formatDuration(stage.duration_seconds);
  const status = stageStatus(stage);
  const current = Boolean(stage.is_current);
  const rejected = status === "REJECTED";
  const returned = status === "RETURNED" || status === INDENT_STATUS.RETURNED_FOR_CORRECTION;
  const awaited = !stage.timestamp && !current;
  return (
    <li className="relative flex gap-3 sm:gap-4">
      <div className="flex flex-col items-center">
        <StageIcon stage={stage} />
        {!isLast && <span className="mt-2 h-full min-h-10 w-px bg-line" />}
      </div>
      <article
        className={`mb-4 min-w-0 flex-1 rounded-lg border p-4 shadow-sm transition-colors duration-150 motion-reduce:transition-none ${
          current
            ? "border-brand/40 bg-brand/5"
            : rejected
              ? "border-bad/40 bg-bad-bg"
              : returned
                ? "border-warn/40 bg-warn-bg"
                : awaited
                  ? "border-dashed border-line bg-content2"
                  : "border-line bg-content1"
        }`}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 className="break-words text-sm font-semibold text-body">{stage.title}</h3>
            {(stage.approver_name || stage.position_name) && (
              <p className="mt-1 break-words text-sm text-muted">
                {stage.approver_name || stage.position_name}
                {stage.approver_name && stage.position_name ? ` · ${stage.position_name}` : ""}
              </p>
            )}
          </div>
          <span className={`w-fit shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold ${
            current ? "border-brand/30 bg-brand/10 text-brand" : "border-line bg-content2 text-muted"
          }`}>
            {statusLabel(stage)}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {when && <span>{when}</span>}
          {duration && <span>Duration {duration}</span>}
          {stage.reference_no && <span>Ref {stage.reference_no}</span>}
          {stage.quantity_summary && <span>{stage.quantity_summary}</span>}
        </div>
        {!rejected && !returned && stage.comments && (
          <p className="mt-3 break-words text-sm text-body">{stage.comments}</p>
        )}
        {(rejected || returned) && (
          <div className={`mt-3 rounded-md border px-3 py-2.5 ${
            rejected ? "border-bad/20 bg-content2" : "border-warn/30 bg-content2"
          }`}>
            <p className={`text-[11px] font-semibold uppercase tracking-wide ${rejected ? "text-bad" : "text-warn"}`}>
              {rejected ? "Rejection reason" : "Correction requested"}
            </p>
            <p className="mt-1 break-words text-sm font-medium leading-5 text-body">
              {stage.comments?.trim() || "Not provided"}
            </p>
          </div>
        )}
        {returned && correctionResubmitted && (
          <span className="mt-2 inline-flex w-fit rounded-full border border-ok/25 bg-ok-bg px-2.5 py-1 text-[11px] font-semibold text-ok">
            Corrected and resubmitted
          </span>
        )}
      </article>
    </li>
  );
}

/**
 * The leg label inside the timeline. A tinted band with a coloured edge, not a
 * node: the ticks down the rail belong to the steps, and repeating one here made
 * a leg read as something that happened on its own. Deliberately not a heading
 * either, so the timeline's headings stay the steps themselves.
 */
function TrackDividerRow({ track }: { track: JourneyTrack }) {
  return (
    <li className={`mb-3 flex flex-col gap-0.5 rounded-r-lg border-l-4 bg-content2 px-3 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4 ${trackAccent(track.state)}`}>
      <p className="break-words text-[11px] font-semibold uppercase tracking-[0.14em] text-body">
        {track.label}
      </p>
      <p className="break-words text-xs text-muted sm:text-right">{track.summary}</p>
    </li>
  );
}

export function groupJourneyHistory(history: IndentJourneyHistoryEvent[]) {
  const ordered = [...history].sort((left, right) => (
    (parseIndentTimestamp(right.timestamp)?.getTime() ?? 0)
    - (parseIndentTimestamp(left.timestamp)?.getTime() ?? 0)
  ));
  const groups = new Map<string, IndentJourneyHistoryEvent[]>();
  ordered.forEach((event) => {
    const key = formatIndentDate(event.timestamp);
    if (!key) return;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  });
  return [...groups.entries()];
}

export function IndentJourneyPage() {
  const { id } = useParams();
  const indentId = Number(id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const accountScope = useIndentAccountScope();
  useIndentAccountCacheIsolation(accountScope);
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: indentKeys.journey(accountScope, indentId),
    queryFn: ({ signal }) => indentApi.journey(indentId, signal),
    enabled: Number.isFinite(indentId),
    staleTime: INDENT_QUERY_STALE_TIME,
    gcTime: INDENT_QUERY_GC_TIME,
    placeholderData: (previousData) => previousData,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
  });
  const steps = useMemo(() => journeySteps(data), [data]);
  const correctedReturns = useMemo(
    () => correctedReturnStageKeys(steps.occurred),
    [steps.occurred],
  );
  const tracks = useMemo(() => buildJourneyTracks(data, steps), [data, steps]);
  const timelineTracks = useMemo(
    () => tracks.filter((track) => track.occurred.length > 0),
    [tracks],
  );
  const groupedHistory = useMemo(
    () => groupJourneyHistory(data?.history ?? []),
    [data?.history],
  );
  const unavailable = isIndentUnavailableError(error);
  useEffect(() => {
    if (unavailable) {
      qc.removeQueries({ queryKey: indentKeys.journey(accountScope, indentId) });
      qc.removeQueries({ queryKey: indentKeys.detail(accountScope, indentId) });
    }
  }, [accountScope, indentId, qc, unavailable]);

  if (unavailable) {
    return (
      <div className="space-y-4 rounded-xl border border-line bg-content1 p-5">
        <p className="text-sm font-semibold text-body">This indent is not available to your current account</p>
        <Button variant="secondary" onClick={() => nav("/indents")}>
          <ArrowLeft className="h-4 w-4" /> Back to All requests
        </Button>
      </div>
    );
  }

  // A failed load must never sit on a loading placeholder — say so, and offer a retry.
  if (error && !data) {
    return (
      <div className="space-y-4 rounded-xl border border-bad/30 bg-content1 p-5">
        <p className="text-sm font-semibold text-body">The indent journey could not be loaded</p>
        <p className="break-words text-sm text-muted">{error.message}</p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => refetch()} disabled={isFetching}>
            {isFetching
              ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
            {isFetching ? "Retrying..." : "Try again"}
          </Button>
          <Button variant="secondary" onClick={() => nav(`/indents/${indentId}`)}>
            <ArrowLeft className="h-4 w-4" /> Back to indent details
          </Button>
        </div>
      </div>
    );
  }

  if (isLoading || !data) return <Skeleton className="h-64 rounded-2xl" />;

  // A finished journey has nothing missing. The banner listed the columns the
  // evidence walk never needed to read on a request that is already closed.
  const journeyCompleted = data.phases.length > 0 && data.phases.every((phase) => (
    COMPLETED_PHASE_STATUSES.has(stageStatus(phase))
  ));
  // A consignment still inside the gate has no `gate_out_at` to read. That is the
  // normal state of an indent the warehouse has not released yet, not a record the
  // evidence walk failed on, so listing it fired the banner on almost every open
  // request. Every other missing source still shows.
  const visibleMissingSources = data.missing_sources?.filter(
    (source) => source !== "out_dispatches.gate_out_at",
  ) ?? [];

  return (
    <div className="min-w-0 space-y-5">
      <button
        type="button"
        onClick={() => nav(`/indents/${indentId}`)}
        className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-muted hover:text-body"
      >
        <ArrowLeft className="h-4 w-4" /> Back to indent details
      </button>

      <header className="flex flex-col gap-4 rounded-xl border border-line bg-content1 p-5 shadow-sm lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Complete indent journey</p>
          <h1 className="mt-1 break-words text-2xl font-semibold text-ink">{data.indent_no}</h1>
          <p className="mt-2 break-words text-sm text-muted">{data.current_stage_message}</p>
          {data.final_any_one_outcome && (
            <p className="mt-1 break-words text-sm font-medium text-body">
              Final approval · {data.final_any_one_outcome}
            </p>
          )}
          {isFetching && (
            <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Refreshing journey...
            </p>
          )}
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-semibold uppercase text-muted">Requested by</dt>
              <dd className="mt-1 break-words text-body">
                {data.requested_by_name || "-"}
                {data.requested_by_position && (
                  <span className="block break-words text-xs text-muted">{data.requested_by_position}</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase text-muted">Created</dt>
              <dd className="mt-1 text-body">{formatIndentDateTime(data.created_at)}</dd>
            </div>
          </dl>
        </div>
        <IndentStatusBadge status={data.status} journey={data} />
      </header>

      {error && <p className="rounded-lg border border-bad/30 bg-bad-bg px-4 py-3 text-sm text-bad">{error.message}</p>}

      {!journeyCompleted && visibleMissingSources.length > 0 && (
        <p className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn-bg px-4 py-3 text-sm text-warn">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="break-words">
            Some records could not be read ({visibleMissingSources.join(", ")}), so this journey may be incomplete.
          </span>
        </p>
      )}

      <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
        <Card>
          <CardBody className="p-5">
            <h2 className="mb-5 text-sm font-semibold uppercase tracking-wider text-muted">Complete indent journey</h2>
            {steps.occurred.length > 0 ? (
              <ol className="space-y-0" aria-label="Complete indent journey timeline">
                {timelineTracks.map((track, trackIndex) => (
                  <li key={track.key} className="mt-6 list-none first:mt-0">
                    <ol className="space-y-0">
                      <TrackDividerRow track={track} />
                      {track.occurred.map((stage, index) => (
                        <JourneyStageRow
                          key={stageKey(stage)}
                          stage={stage}
                          correctionResubmitted={correctedReturns.has(stageKey(stage))}
                          isLast={
                            index === track.occurred.length - 1
                            && trackIndex === timelineTracks.length - 1
                            && steps.upcoming.length === 0
                          }
                        />
                      ))}
                    </ol>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted">No recorded journey events are available.</p>
            )}

            {steps.upcoming.length > 0 && (
              <>
                <h2 className="mb-4 mt-2 text-sm font-semibold uppercase tracking-wider text-muted">Still to come</h2>
                <ol className="space-y-0" aria-label="Remaining indent journey stages">
                  {steps.upcoming.map((stage, index) => (
                    <JourneyStageRow
                      key={stageKey(stage)}
                      stage={stage}
                      isLast={index === steps.upcoming.length - 1}
                    />
                  ))}
                </ol>
              </>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardBody className="p-5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted">Complete history</h2>
            {groupedHistory.length === 0 ? (
              <p className="text-sm text-muted">No history has been recorded yet.</p>
            ) : (
              <div className="space-y-5">
                {groupedHistory.map(([date, events]) => (
                  <section key={date}>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{date}</h3>
                    <div className="space-y-3">
                      {events.map((event) => (
                        <article key={event.id} className="rounded-lg border border-line bg-content2 p-3">
                          <p className="text-xs font-semibold text-muted">{formatIndentDateTime(event.timestamp)}</p>
                          <p className="mt-1 break-words text-sm font-semibold text-body">{event.title}</p>
                          {event.description && <p className="mt-1 break-words text-sm text-muted">{event.description}</p>}
                          {event.actor_name && <p className="mt-1 break-words text-sm text-body">{event.actor_name}</p>}
                          {event.position_name && <p className="break-words text-xs text-muted">{event.position_name}</p>}
                          {(event.reference_no || event.quantity_summary) && (
                            <p className="mt-1 break-words text-xs text-muted">
                              {[event.reference_no ? `Ref ${event.reference_no}` : null, event.quantity_summary]
                                .filter(Boolean).join(" · ")}
                            </p>
                          )}
                          {event.comments && (
                            <p className="mt-2 break-words text-sm text-body">{event.comments}</p>
                          )}
                        </article>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      </section>
    </div>
  );
}
