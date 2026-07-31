import { useEffect, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Circle, Clock, Loader2, X } from "lucide-react";
import { CardBody, Skeleton } from "@heroui/react";
import { Button, Card } from "@/shared/components";
import { IndentStatusBadge } from "../components/IndentStatusBadge";
import {
  INDENT_QUERY_GC_TIME, INDENT_QUERY_STALE_TIME, indentApi, indentKeys,
  isIndentUnavailableError, useIndentAccountCacheIsolation, useIndentAccountScope,
} from "../api";
import { formatIndentDate, formatIndentDateTime } from "../dateTime";
import type { IndentJourneyHistoryEvent, IndentJourneyStage } from "../types";

function formatDuration(seconds?: number | null) {
  if (!seconds || seconds < 60) return null;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

function stageTone(stage: IndentJourneyStage) {
  if (stage.status === "REJECTED") return "border-bad bg-bad-bg text-bad";
  if (stage.is_current) return "border-brand bg-brand/5 text-brand";
  if (stage.status === "APPROVED" || stage.status === "SUBMITTED") return "border-ok bg-ok text-white";
  if (stage.status === "NOT_REQUIRED") return "border-line bg-content2 text-muted";
  return "border-line bg-white text-muted";
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    SUBMITTED: "Submitted",
    APPROVED: "Approved",
    REJECTED: "Rejected",
    PENDING: "Pending",
    NOT_REQUIRED: "Not required",
  };
  return labels[status] ?? "Status unavailable";
}

function StageIcon({ stage }: { stage: IndentJourneyStage }) {
  const cls = `grid h-9 w-9 shrink-0 place-items-center rounded-full border ${stageTone(stage)}`;
  if (stage.status === "REJECTED") return <span className={cls}><X className="h-4 w-4" /></span>;
  if (stage.status === "APPROVED" || stage.status === "SUBMITTED") return <span className={cls}><Check className="h-4 w-4" /></span>;
  if (stage.is_current) return <span className={cls}><Clock className="h-4 w-4" /></span>;
  return <span className={cls}><Circle className="h-4 w-4" /></span>;
}

function JourneyStageRow({ stage }: { stage: IndentJourneyStage }) {
  const when = formatIndentDateTime(stage.timestamp);
  const duration = formatDuration(stage.duration_seconds);
  const current = Boolean(stage.is_current);
  const rejected = stage.status === "REJECTED";
  return (
    <li className="relative flex gap-3 sm:gap-4">
      <div className="flex flex-col items-center">
        <StageIcon stage={stage} />
        <span className="mt-2 h-full min-h-10 w-px bg-line" />
      </div>
      <article
        className={`mb-4 min-w-0 flex-1 rounded-lg border bg-content1 p-4 shadow-sm transition-colors duration-150 motion-reduce:transition-none ${
          current ? "border-brand/40 bg-brand/5" : rejected ? "border-bad/40 bg-bad-bg" : "border-line"
        }`}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="break-words text-sm font-semibold text-body">{stage.title}</h2>
            <p className="mt-1 break-words text-sm text-muted">
              {stage.approver_name || "Unassigned"}
              {stage.position_name ? ` · ${stage.position_name}` : ""}
            </p>
          </div>
          <span className="w-fit shrink-0 rounded-full border border-line bg-content2 px-2.5 py-1 text-xs font-semibold text-muted">
            {statusLabel(stage.status)}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {when && <span>{when}</span>}
          {duration && <span>Duration {duration}</span>}
        </div>
        {rejected && (
          <div className="mt-3 rounded-md border border-bad/20 bg-content2 px-3 py-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-bad">
              Rejection reason
            </p>
            <p className="mt-1 break-words text-sm font-medium leading-5 text-body">
              {stage.comments?.trim() || "Not provided"}
            </p>
          </div>
        )}
      </article>
    </li>
  );
}

export function groupJourneyHistory(history: IndentJourneyHistoryEvent[]) {
  const groups = new Map<string, IndentJourneyHistoryEvent[]>();
  history.forEach((event) => {
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
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: indentKeys.journey(accountScope, indentId),
    queryFn: () => indentApi.journey(indentId),
    enabled: Number.isFinite(indentId),
    staleTime: INDENT_QUERY_STALE_TIME,
    gcTime: INDENT_QUERY_GC_TIME,
    refetchOnWindowFocus: false,
  });
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

  if (isLoading || !data) return <Skeleton className="h-64 rounded-2xl" />;

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
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Approval journey</p>
          <h1 className="mt-1 break-words text-2xl font-semibold text-ink">{data.indent_no}</h1>
          <p className="mt-2 break-words text-sm text-muted">{data.current_stage_message}</p>
          {isFetching && (
            <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Refreshing journey...
            </p>
          )}
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-semibold uppercase text-muted">Requested by</dt>
              <dd className="mt-1 break-words text-body">{data.requested_by_name || "-"}</dd>
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

      <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
        <Card>
          <CardBody className="p-5">
            <h2 className="mb-5 text-sm font-semibold uppercase tracking-wider text-muted">Approval journey</h2>
            <ol className="space-y-0" aria-label="Approval journey timeline">
              {data.stages.map((stage) => <JourneyStageRow key={`${stage.sequence}-${stage.title}`} stage={stage} />)}
            </ol>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="p-5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted">Complete history</h2>
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
                        {event.event_type !== "REJECTED" && event.comments && (
                          <p className="mt-2 break-words text-sm text-body">{event.comments}</p>
                        )}
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </CardBody>
        </Card>
      </section>
    </div>
  );
}
