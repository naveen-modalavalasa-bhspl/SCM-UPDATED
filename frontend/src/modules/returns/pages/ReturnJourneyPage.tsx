import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft, Ban, Check, Circle, Clock, Loader2, Minus, RefreshCw, Undo2, X,
} from "lucide-react";
import { CardBody, Skeleton } from "@heroui/react";
import { Button, Card, StatusPill } from "@/shared/components";
import { returnsApi } from "../api";
import { STATUS_LABEL } from "../constants";
import { formatReturnDate, formatReturnDateTime, parseReturnTimestamp } from "../dateTime";
import {
  buildJourneyTracks, isResubmissionStage, journeySteps, stageStatus,
} from "../journeyModel";
import type { JourneyTrack, JourneyTrackState } from "../journeyModel";
import type { ReturnJourneyHistoryEvent, ReturnJourneyStage } from "../types";

/**
 * The whole road a return travelled, at step level.
 *
 * Drawn with the indent journey screen's own chrome — the same rail, the same
 * `--color-step-*` fills, the same leg bands, the same history column — because the two
 * documents are meant to read as one system and a returner who has seen one should not
 * have to learn a second layout. What it draws is entirely this return's: its decision
 * desk, its sign-off, its approval ladder, its shipment, its movement, its
 * acknowledgement. Where the return names an indent that is a reference on the header and
 * nothing more; the indent's own rungs belong to the indent's own journey.
 *
 * Every step, its state and its wording come from `GET /api/returns/{id}/journey`. Nothing
 * on this page decides what a status means: a second copy of the flow in the browser is
 * how a rejected document ends up rendering as though the stock moved.
 */

function formatDuration(seconds?: number | null) {
  if (!seconds || seconds < 60) return null;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

// The same `--color-step-*` tints the eight-dot `ReturnStepper` and this rail, so the
// expanded journey and the summary of it are one rail read at two zooms. Never
// `.bg-brand` — that token carries the four-stop brand sweep as a background image, which
// puts a different colour on every dot in the column.
function stageTone(stage: ReturnJourneyStage) {
  const status = stageStatus(stage);
  if (status === "REJECTED") return "border-transparent bg-step-bad text-white";
  if (status === "RETURNED") return "border-transparent bg-step-hold text-white";
  if (status === "CANCELLED") return "border-transparent bg-step-off text-white";
  if (stage.is_current) return "border-transparent bg-step-live text-white";
  if (["APPROVED", "SUBMITTED", "COMPLETED", "ACKNOWLEDGED"].includes(status)) return "border-transparent bg-step-done text-white";
  if (status === "NOT_REQUIRED") return "border-line bg-content2 text-muted";
  return "border-line bg-content1 text-muted";
}

function statusLabel(stage: ReturnJourneyStage) {
  if (stage.is_current) return "Current";
  const labels: Record<string, string> = {
    SUBMITTED: "Submitted",
    APPROVED: "Approved",
    COMPLETED: "Completed",
    ACKNOWLEDGED: "Acknowledged",
    REJECTED: "Rejected",
    PENDING: "Pending",
    NOT_REQUIRED: "Not required",
    RETURNED: "Sent back for correction",
    CANCELLED: "Withdrawn",
  };
  return labels[stageStatus(stage)] ?? "Status unavailable";
}

function stageKey(stage: ReturnJourneyStage) {
  return stage.event_id
    || `${stage.sequence}-${stage.stage_type}-${stage.timestamp ?? ""}-${stage.reference_no ?? ""}`;
}

/**
 * Which send-backs were answered. A return that was corrected and resubmitted is history,
 * and the step says so rather than sitting on the rail as an open setback.
 */
function correctedReturnStageKeys(stages: ReturnJourneyStage[]) {
  const corrected = new Set<string>();
  const pendingReturns: string[] = [];
  stages.forEach((stage) => {
    if (stageStatus(stage) === "RETURNED") {
      pendingReturns.push(stageKey(stage));
      return;
    }
    if (isResubmissionStage(stage)) {
      const returnKey = pendingReturns.pop();
      if (returnKey) corrected.add(returnKey);
    }
  });
  return corrected;
}

function StageIcon({ stage }: { stage: ReturnJourneyStage }) {
  const status = stageStatus(stage);
  const cls = `grid h-9 w-9 shrink-0 place-items-center rounded-full border ${stageTone(stage)}`;
  if (status === "REJECTED") return <span className={cls}><X className="h-4 w-4" /></span>;
  if (status === "RETURNED") return <span className={cls}><Undo2 className="h-4 w-4" /></span>;
  if (status === "CANCELLED") return <span className={cls}><Ban className="h-4 w-4" /></span>;
  if (status === "NOT_REQUIRED") return <span className={cls}><Minus className="h-4 w-4" /></span>;
  if (["APPROVED", "SUBMITTED", "COMPLETED", "ACKNOWLEDGED"].includes(status)) return <span className={cls}><Check className="h-4 w-4" /></span>;
  if (stage.is_current) return <span className={cls}><Clock className="h-4 w-4" /></span>;
  return <span className={cls}><Circle className="h-4 w-4" /></span>;
}

/** The leg's colour, carried by its edge alone — never by a second tick mark. */
function trackAccent(state: JourneyTrackState) {
  const accents: Record<JourneyTrackState, string> = {
    // Flat crimson, not the sweep: this is a 4px BORDER, and a border takes a colour,
    // never a gradient.
    COMPLETED: "border-l-[var(--grad-3)]",
    CURRENT: "border-l-brand",
    PENDING: "border-l-line",
    REJECTED: "border-l-bad",
    RETURNED: "border-l-warn",
  };
  return accents[state];
}

function JourneyStageRow({
  stage, isLast, correctionResubmitted = false,
}: { stage: ReturnJourneyStage; isLast: boolean; correctionResubmitted?: boolean }) {
  const when = formatReturnDateTime(stage.timestamp);
  const duration = formatDuration(stage.duration_seconds);
  const status = stageStatus(stage);
  const current = Boolean(stage.is_current);
  const rejected = status === "REJECTED";
  const returned = status === "RETURNED";
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
 * The leg label inside the timeline. A tinted band with a coloured edge, not a node: the
 * ticks down the rail belong to the steps, and repeating one here made a leg read as
 * something that happened on its own.
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

/** Newest first, grouped by the day it happened — a log, read the way a log is read. */
export function groupJourneyHistory(history: ReturnJourneyHistoryEvent[]) {
  const ordered = [...history].sort((left, right) => (
    (parseReturnTimestamp(right.timestamp)?.getTime() ?? 0)
    - (parseReturnTimestamp(left.timestamp)?.getTime() ?? 0)
  ));
  const groups = new Map<string, ReturnJourneyHistoryEvent[]>();
  ordered.forEach((event) => {
    const key = formatReturnDate(event.timestamp);
    if (!key) return;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  });
  return [...groups.entries()];
}

export default function ReturnJourneyPage() {
  const { id } = useParams<{ id: string }>();
  const returnId = Number(id);
  const nav = useNavigate();
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    // The same key the detail page's stepper uses, so opening the journey costs no
    // second fetch and both zooms of the rail move together.
    queryKey: ["returns", returnId, "journey"],
    queryFn: () => returnsApi.journey(returnId),
    enabled: Number.isFinite(returnId),
    placeholderData: (previousData) => previousData,
    refetchOnMount: "always",
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

  // A failed load must never sit on a loading placeholder — say so, and offer a retry.
  if (error && !data) {
    return (
      <div className="space-y-4 rounded-xl border border-bad/30 bg-content1 p-5">
        <p className="text-sm font-semibold text-body">The return journey could not be loaded</p>
        <p className="break-words text-sm text-muted">{(error as Error).message}</p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => refetch()} disabled={isFetching}>
            {isFetching
              ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
            {isFetching ? "Retrying..." : "Try again"}
          </Button>
          <Button variant="secondary" onClick={() => nav(`/returns/${returnId}`)}>
            <ArrowLeft className="h-4 w-4" /> Back to return details
          </Button>
        </div>
      </div>
    );
  }

  if (isLoading || !data) return <Skeleton className="h-64 rounded-2xl" />;

  return (
    <div className="min-w-0 space-y-5">
      <button
        type="button"
        onClick={() => nav(`/returns/${returnId}`)}
        className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-muted hover:text-body"
      >
        <ArrowLeft className="h-4 w-4" /> Back to return details
      </button>

      <header className="flex flex-col gap-4 rounded-xl border border-line bg-content1 p-5 shadow-sm lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Complete return journey</p>
          <h1 className="mt-1 break-words text-2xl font-semibold text-ink">{data.return_no ?? `Return ${returnId}`}</h1>
          {data.current_stage_message && (
            <p className="mt-2 break-words text-sm text-muted">{data.current_stage_message}</p>
          )}
          {isFetching && (
            <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Refreshing journey...
            </p>
          )}
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-semibold uppercase text-muted">Returned by</dt>
              <dd className="mt-1 break-words text-body">
                {data.raised_by_name || "-"}
                {data.raised_by_position && (
                  <span className="block break-words text-xs text-muted">{data.raised_by_position}</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase text-muted">Raised</dt>
              <dd className="mt-1 text-body">{formatReturnDateTime(data.created_at) ?? "-"}</dd>
            </div>
            {data.indent_no && (
              <div className="sm:col-span-2">
                <dt className="text-xs font-semibold uppercase text-muted">Against indent</dt>
                {/* A reference, not a second journey: this return followed the approval
                  * that request went through, and the request's own steps are on the
                  * indent's journey screen. */}
                <dd className="mt-1 break-words text-body">
                  {data.indent_no}
                  <span className="block break-words text-xs text-muted">
                    The return followed this request&apos;s approval.
                  </span>
                </dd>
              </div>
            )}
          </dl>
        </div>
        <StatusPill status={data.status} label={STATUS_LABEL[data.status]} />
      </header>

      {error && (
        <p className="rounded-lg border border-bad/30 bg-bad-bg px-4 py-3 text-sm text-bad">
          {(error as Error).message}
        </p>
      )}

      <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
        <Card>
          <CardBody className="p-5">
            <h2 className="mb-5 text-sm font-semibold uppercase tracking-wider text-muted">Complete return journey</h2>
            {steps.occurred.length > 0 ? (
              <ol className="space-y-0" aria-label="Complete return journey timeline">
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
                <ol className="space-y-0" aria-label="Remaining return journey stages">
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
                          <p className="text-xs font-semibold text-muted">{formatReturnDateTime(event.timestamp)}</p>
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
