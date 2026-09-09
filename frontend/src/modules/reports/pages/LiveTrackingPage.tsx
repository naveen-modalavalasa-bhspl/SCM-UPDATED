import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpRight, Building2, CheckCircle2, ChevronDown, ChevronRight, CircleDashed, Clock,
  ExternalLink, GitBranch, MinusCircle, Search, Send, Undo2, XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@heroui/react";
import { Card, ErrorBanner, PageHeader, Select, StatusPill } from "@/shared/components";
import { api } from "@/shared/api/client";
import { useAuth } from "@/shared/auth/AuthContext";
import { fmtDate, fmtDateTime, fmtRelative } from "@/shared/datetime";
import {
  doctypeBadge, fmtWait, indentHit, ladderChipLabel, ladderOrigin, ladderRoute,
  ladderStages, sortHits, waitingSince,
  type TrackApproval, type TrackHit, type TrackJourney, type TrackStage,
} from "../liveTrackingModel";

/**
 * Live Tracking — one indent number in, the whole story out, refreshed as it happens.
 *
 * Reports already answers "what happened" twice over: the Indent Journey carries the
 * ladder (who raised it and where, every rung with its actor and duration) and the
 * Document Trail carries the downstream chain (allocation, MR, PO, GRN, issue,
 * consignment, shipment). What neither did was move: an approver pressing a button
 * in another building did not reach the reader until they refetched by hand.
 *
 * This screen is those two reads, polled. Every 15 seconds both endpoints are asked
 * again, so "who has it now" stays true while you watch — there is no third copy of
 * any business state here to keep honest, only two windows onto the records that
 * already exist.
 */

const REFRESH_MS = 15_000;
const LIST_LIMIT = 500;

interface TraceNode {
  key: string;
  label: string;
  id: number;
  doc_no: string | null;
  status: string | null;
  date: string | null;
  path: string | null;
  is_root: boolean;
  doctype_code?: string | null;
  approval?: TrackApproval | null;
  approvals: {
    action: string;
    stage: string | null;
    actor: string | null;
    actor_position: string | null;
    comments: string | null;
    at: string | null;
  }[];
}

interface Chain {
  nodes: TraceNode[];
  truncated: boolean;
}

type TrackingFilters = { kind: string; status: string; dateFrom: string; dateTo: string };

const trackingApi = {
  search: (q: string, filters: TrackingFilters, limit = 25) =>
    api.get<TrackHit[]>("/api/reports/traceability/search", {
      params: { q, limit, browse: true, ...(filters.kind ? { kind: filters.kind } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.dateFrom ? { date_from: filters.dateFrom } : {}),
        ...(filters.dateTo ? { date_to: filters.dateTo } : {}) },
    }).then((r) => r.data),
  kinds: () => api.get<{ key: string; label: string }[]>("/api/reports/traceability/kinds")
    .then((r) => r.data),
  journey: (indentId: number) =>
    api.get<TrackJourney>(`/api/indents/${indentId}/journey`).then((r) => r.data),
  chain: (kind: string, docId: number) =>
    api.get<Chain>("/api/reports/traceability/chain",
                   { params: { kind, doc_id: docId } }).then((r) => r.data),
};

/** One glyph per rung state. PENDING gets the clock — it is the only state where the
 *  glyph names a person still to act rather than one who acted. */
const STAGE_META: Record<string, { icon: LucideIcon; tint: string }> = {
  APPROVED: { icon: CheckCircle2, tint: "bg-ok-bg text-ok" },
  SUBMITTED: { icon: Send, tint: "bg-info-bg text-info" },
  REJECTED: { icon: XCircle, tint: "bg-bad-bg text-bad" },
  RETURNED: { icon: Undo2, tint: "bg-warn-bg text-warn" },
  NOT_REQUIRED: { icon: MinusCircle, tint: "bg-neutral-bg text-neutral" },
  PENDING: { icon: Clock, tint: "bg-warn-bg text-warn" },
};

export function LiveTrackingPage() {
  const nav = useNavigate();
  // The two halves of this screen sit behind DIFFERENT permissions. The register, the
  // trail and the ladder stamps are `report.view`, like every other Reports screen;
  // the indent Journey is `/api/indents/{id}/journey`, which indents gates on
  // `indent.view` and scopes to the indents this login may read. So the journey query
  // is only ARMED when the login carries that code — firing it regardless would 403
  // on every poll for a reports-only reader and fill sys_app_logs with it.
  const { can } = useAuth();
  const canReadIndents = can("indent.view");
  const [selected, setSelected] = useState<TrackHit | null>(null);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [sort, setSort] = useState<"latest" | "oldest">("latest");
  const [filters, setFilters] = useState<TrackingFilters>({ kind: "", status: "", dateFrom: "", dateTo: "" });
  const kinds = useQuery({ queryKey: ["live-tracking", "kinds"], queryFn: trackingApi.kinds });

  const results = useQuery({
    queryKey: ["live-tracking", "search", submitted, filters],
    queryFn: () => trackingApi.search(submitted, filters, LIST_LIMIT),
    enabled: true,
  });

  // The two live reads share the refresh cadence, so the header and the trail can
  // never disagree about where the document is.
  const journey = useQuery({
    queryKey: ["live-tracking", "journey", selected?.key, selected?.id],
    queryFn: () => trackingApi.journey(selected!.id),
    enabled: selected?.key === "indent" && canReadIndents,
    refetchInterval: REFRESH_MS,
  });
  const chain = useQuery({
    queryKey: ["live-tracking", "chain", selected?.key, selected?.id],
    queryFn: () => trackingApi.chain(selected!.key, selected!.id),
    enabled: Boolean(selected),
    refetchInterval: REFRESH_MS,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    // A new search starts from a clean board — drop the indent now showing so the
    // old journey never lingers while the new number is looked up.
    setSelected(null);
    setSubmitted(query.trim());
  }

  function track(hit: TrackHit) {
    setSelected(hit);
  }

  const hits = sortHits(results.data ?? [], sort);
  const hit = selected ?? indentHit(hits);

  // The tracked indent's own ladder stamp — which ladder version it runs on and
  // which project it came from. The trail's root node is the canonical read for
  // the document on screen; the register hit is the fallback while the chain is
  // still loading. Both arrive from the backend, nothing is inferred here.
  const rootApproval = chain.data?.nodes.find((node) => node.is_root)?.approval
    ?? hit?.approval ?? null;

  // The date the ladder headline wears: when the indent actually cleared. Read off
  // the same stage list the ladder renders, so the two can never disagree — a
  // document still climbing simply shows its last approval, not a guessed date.
  const ladderRows = journey.data ? ladderStages(journey.data) : [];
  const approvedAt = [...ladderRows]
    .reverse()
    .find((stage) => stage.status === "APPROVED" && stage.timestamp)?.timestamp
    ?? [...ladderRows].reverse().find((stage) => stage.timestamp)?.timestamp;

  // One match and it is not the indent already on screen: open it — typing the
  // number and then being asked to click it once more is a step for nothing. This
  // also covers searching a second indent after an earlier one is still showing.
  if (hits.length === 1 && !results.isFetching
      && (hits[0]!.id !== selected?.id || hits[0]!.key !== selected?.key)) {
    queueMicrotask(() => track(hits[0]!));
  }

  const live = journey.data
    ? { at: journey.dataUpdatedAt, fetching: journey.isFetching || chain.isFetching }
    : null;

  return (
    <div>
      <PageHeader eyebrow="Reports" title="Live Tracking" />

      <Card className="mb-4 p-3">
        <form onSubmit={submit} className="space-y-2.5">
          <div className="flex items-center gap-2">
          <label className="relative min-w-64 flex-1">
            <span className="sr-only">Document number</span>
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoFocus
              placeholder="Document number — IND, PO, GRN, SHIP…"
              className="h-11 w-full rounded-lg border border-line bg-content1 pl-9 pr-3 text-sm text-ink placeholder:text-muted focus:border-brand focus:outline-none"
            />
          </label>
          <Button type="submit" color="primary" className="h-11 font-semibold"
                  isDisabled={!query.trim()}>
            Track
          </Button>
          </div>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-[7rem_11rem_8rem_minmax(8rem,1fr)_minmax(8rem,1fr)_auto]">
          <Select
            ariaLabel="Sort documents"
            value={sort}
            onChange={(value) => setSort(value === "oldest" ? "oldest" : "latest")}
            className="w-full"
            options={[
              { value: "latest", label: "Latest first" },
              { value: "oldest", label: "Oldest first" },
            ]}
          />
          <Select ariaLabel="Document type" value={filters.kind} className="w-full"
            placeholder="All document types" searchable={false}
            onChange={(kind) => { setSelected(null); setFilters((f) => ({ ...f, kind })); }}
            options={(kinds.data ?? []).map((kind) => ({ value: kind.key, label: kind.label }))} />
          <Select ariaLabel="Status" value={filters.status} className="w-full"
            placeholder="Any status" searchable={false}
            onChange={(status) => { setSelected(null); setFilters((f) => ({ ...f, status })); }}
            options={["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "CANCELLED"]
              .map((status) => ({ value: status, label: status.split("_").join(" ") }))} />
          <label className="flex h-11 min-w-0 items-center gap-1 rounded-lg border border-line bg-content1 px-2 text-xs text-muted">From <input type="date" value={filters.dateFrom}
            onChange={(event) => { setSelected(null); setFilters((f) => ({ ...f, dateFrom: event.target.value })); }}
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none" /></label>
          <label className="flex h-11 min-w-0 items-center gap-1 rounded-lg border border-line bg-content1 px-2 text-xs text-muted">To <input type="date" value={filters.dateTo}
            onChange={(event) => { setSelected(null); setFilters((f) => ({ ...f, dateTo: event.target.value })); }}
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none" /></label>
          {(filters.kind || filters.status || filters.dateFrom || filters.dateTo) && (
            <Button type="button" variant="light" className="h-11 px-3 text-muted"
              onPress={() => { setSelected(null); setFilters({ kind: "", status: "", dateFrom: "", dateTo: "" }); }}>
              Clear
            </Button>
          )}
          </div>
        </form>
        <p className="mt-1.5 text-xs text-muted">
          Part of the number is enough. The board refreshes itself every 15 seconds
          while it is open.
        </p>
      </Card>

      <ErrorBanner error={results.error ?? journey.error ?? chain.error} />

      {submitted && !results.isLoading && hits.length === 0 && (
        <Card className="p-10 text-center">
          <p className="text-sm text-muted">
            No document carries the number “{submitted}”.
          </p>
        </Card>
      )}

      {/* List what is in front of the reader. With nothing typed and nothing chosen
          that is the whole register (the landing view after a refresh); with a term
          that returns several serials it is the matches to pick from. */}
      {!results.isLoading && hits.length > 0 && (
          (!selected || (submitted && hits.length > 1)) && (
        <Card className="mb-4">
          <p className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-muted">
            {submitted ? "Matches — pick the one to track" : "All documents"}
          </p>
          <ul className="p-2">
            {hits.map((item) => (
              <li key={`${item.key}:${item.id}`}>
                <div className="flex w-full items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-content2 focus-within:ring-2 focus-within:ring-brand">
                  <button
                    type="button"
                    onClick={() => track(item)}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus:outline-none"
                  >
                    <span className="flex w-36 shrink-0 items-center">
                      <DoctypeBadge code={doctypeBadge(item)} label={item.label} />
                    </span>
                    <span className="mono min-w-0 flex-1 truncate text-sm font-semibold text-ink">
                      {item.doc_no ?? `#${item.id}`}
                    </span>
                    {item.status && <StatusPill status={item.status} />}
                  </button>
                  <LadderChip approval={item.approval} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ))}


      {journey.isLoading && (
        <Card className="p-10 text-center text-sm text-muted">Opening the file…</Card>
      )}

      {/* The board below is built around the Journey, so without `indent.view` there
          is nothing to draw. Name the missing permission rather than leaving a blank
          screen that looks like the indent does not exist — the register above is
          still readable, and that difference is the whole clue. */}
      {selected && selected.key !== "indent" && chain.data && (
        <Card className="mb-4 p-5 sm:p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Live document</p>
              <h2 className="mt-1 text-lg font-bold text-ink">{selected.label} · {selected.doc_no ?? `#${selected.id}`}</h2>
            </div>
            {selected.status && <StatusPill status={selected.status} />}
          </div>
          <ol className="space-y-3">{chain.data.nodes.map((node) => (
            <li key={`${node.key}:${node.id}`}><TrailNode node={node} onOpen={() => node.path && nav(node.path)} /></li>
          ))}</ol>
        </Card>
      )}

      {selected?.key === "indent" && !canReadIndents && (
        <Card className="mb-4 p-6 text-center text-sm text-muted">
          Tracking an indent needs the Indents view permission
          (<span className="mono">indent.view</span>) on top of Reports. The register
          above is what this login can read.
        </Card>
      )}

      {journey.data && (
        <>
          {/* WHERE IT IS NOW — the header answers the question before the trail does. */}
          <Card className="mb-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
              <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                    Indent
                  </span>
                  <span className="mono text-sm font-bold text-ink">
                    {journey.data.indent_no}
                  </span>
                  <StatusPill status={journey.data.status} />
                  <LadderChip approval={rootApproval} className="ml-1" />
                </div>
                <dl className="flex min-w-0 flex-wrap items-baseline gap-x-6 gap-y-1 text-xs text-muted">
                  <div>
                    <dt className="inline">Raised by </dt>
                    <dd className="inline font-semibold text-ink">
                      {journey.data.requested_by_name ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline">at </dt>
                    <dd className="inline font-semibold text-ink">
                      {journey.data.requested_by_position ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline">on </dt>
                    <dd className="inline">{fmtDateTime(journey.data.created_at)}</dd>
                  </div>
                </dl>
              </div>
              {live && (
                <span
                  aria-live="polite"
                  className="flex shrink-0 items-center gap-1.5 rounded-full bg-ok-bg px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-ok"
                  title={`Last checked ${fmtDateTime(new Date(live.at))}`}
                >
                  <span
                    aria-hidden
                    className={`h-2 w-2 rounded-full bg-current ${
                      live.fetching ? "animate-pulse" : ""
                    }`}
                  />
                  Live{live.fetching ? "…" : ` · ${fmtTimeOfDay(live.at)}`}
                </span>
              )}
            </div>
            <p className="mt-3 text-base font-bold text-ink">
              {journey.data.current_stage_message ?? journey.data.status}
            </p>
            <p className="mt-0.5 text-xs text-muted">
              Waiting since {fmtDateTime(waitingSince(journey.data))}
              {" · "}
              {fmtRelative(waitingSince(journey.data))}
            </p>

            {/* The seven phases, as chips — the same contract the Journey screen walks. */}
            {(journey.data.phases?.length ?? 0) > 0 && (
              <ol className="mt-3 flex flex-wrap gap-1.5 border-t border-line/60 pt-3">
                {journey.data.phases!.map((phase) => {
                  const done = phase.status === "APPROVED";
                  const current = phase.is_current;
                  return (
                    <li
                      key={phase.sequence}
                      title={phase.approver_name ?? undefined}
                      className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${
                        current
                          ? "border-brand bg-brand-050 text-brand"
                          : done
                            ? "border-transparent bg-ok-bg text-ok"
                            : "border-line text-muted"
                      }`}
                    >
                      {phase.title}
                      {current ? " · now" : ""}
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>

          {/* Ladder and trail sit side by side on a wide screen, stacked on a narrow one. */}
          <div className="grid gap-6 lg:grid-cols-2">
            {/* THE LADDER — who approved, when, and how long each rung took. */}
            <Card className="h-fit p-5 sm:p-6">
              <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Approval ladder
                </h2>
                {approvedAt && (
                  <span className="text-xs text-muted">
                    Approved {fmtDateTime(approvedAt)}
                  </span>
                )}
              </div>
              <ol className="space-y-3">
                {ladderStages(journey.data).map((stage) => (
                  <li key={`${stage.stage_type}:${stage.sequence}`}>
                    <StageRow stage={stage} />
                  </li>
                ))}
              </ol>
            </Card>

            {/* THE TRAIL — everything the demand became after approval. Compact cards, sitting
              side by side with the ladder on a wide screen; each node still keeps the full
              story, just with less padding. */}
            <Card className="h-fit p-5 sm:p-6">
              <h2 className="mb-4 text-sm font-semibold tracking-tight text-ink">
                Downstream trail
                <span className="ml-2 text-xs font-normal text-muted">
                  — where this indent went next
                </span>
              </h2>
              {chain.isLoading && (
                <p className="py-5 text-center text-sm text-muted">Building the trail…</p>
              )}
              {chain.data && chain.data.nodes.length <= 1 && (
                <p className="py-5 text-center text-sm text-muted">
                  Nothing has been raised against this indent yet — the trail grows as
                  allocation, purchase and dispatch documents are created.
                </p>
              )}
              {chain.data && chain.data.truncated && (
                <p className="mb-4 rounded-xl bg-warn-bg px-4 py-3 text-sm text-warn">
                  More documents are connected than shown. Search the document directly to see its full trail.
                </p>
              )}
              {chain.data && chain.data.nodes.length > 1 && (
                <ol className="space-y-3">
                  {chain.data.nodes.filter((node) => !node.is_root).map((node) => (
                    <li key={`${node.key}:${node.id}`}>
                      <TrailNode
                        node={node}
                        onOpen={() => node.path && nav(node.path)}
                      />
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function StageRow({ stage }: { stage: TrackStage }) {
  const meta = STAGE_META[stage.status]
    ?? { icon: CircleDashed, tint: "bg-neutral-bg text-neutral" };
  const Icon = meta.icon;
  const current = Boolean(stage.is_current) && stage.status === "PENDING";

  return (
    <div className={`flex items-start gap-3 rounded-xl px-2 py-1.5 ${
      current ? "bg-brand-050/50 ring-1 ring-brand/20" : ""
    }`}>
      <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg ${meta.tint} ${
        current ? "animate-pulse" : ""
      }`}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="text-sm font-semibold text-ink">
            {stage.title}
            {current && (
              <span className="ml-2 rounded-full bg-brand px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">
                now
              </span>
            )}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-muted">
            {stage.duration_seconds != null && stage.timestamp
              ? `${fmtWait(stage.duration_seconds)} · ${fmtDateTime(stage.timestamp)}`
              : stage.timestamp
                ? fmtDateTime(stage.timestamp)
                : current ? "waiting" : ""}
          </span>
        </div>
        {stage.approver_name && (
          <div className="text-xs text-muted">
            {stage.approver_name}
            {stage.position_name ? ` · ${stage.position_name}` : ""}
          </div>
        )}
        {stage.comments && (
          <p className="mt-0.5 text-xs italic text-body">“{stage.comments}”</p>
        )}
      </div>
    </div>
  );
}

function TrailNode({ node, onOpen }: {
  node: TraceNode; onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl border border-line/60 bg-content1">
      <div className="p-3 sm:p-3.5">
        {/* Row 1: type + actions */}
        <div className="flex items-start justify-between gap-3">
          <DoctypeBadge code={doctypeBadge(node)} label={node.label} />
          <div className="flex shrink-0 items-center gap-1.5">
            {node.approvals.length > 0 && (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line/60 text-muted transition-colors hover:bg-content2 hover:text-ink"
                aria-label={`${open ? "Hide" : "Show"} ${node.approvals.length} approval steps`}
              >
                {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
            )}
            {node.path && (
              <Button
                size="sm"
                variant="bordered"
                isIconOnly
                className="h-8 w-8 min-w-8 rounded-lg"
                onPress={onOpen}
                aria-label={`Open ${node.doc_no ?? "document"}`}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        {/* Row 2: document identity — one compact row */}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="mono text-sm font-bold leading-tight text-ink">
            {node.doc_no ?? `#${node.id}`}
          </div>
          {node.status && <StatusPill status={node.status} />}
          <span className="text-xs text-muted">
            {node.date ? fmtDate(node.date) : "—"}
          </span>
        </div>

        {/* Row 3: single flow chip */}
        <div className="mt-2">
          <LadderChip approval={node.approval} />
        </div>
      </div>

      {open && node.approvals.length > 0 && (
        <ol className="space-y-1.5 border-t border-line/60 bg-content2/40 px-3 py-2.5 sm:px-4 sm:py-3">
          {node.approvals.map((step, index) => (
            <li key={index} className="rounded-xl bg-content1 px-2.5 py-2 text-sm leading-snug">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-semibold text-ink">{step.action}</span>
                <span className="text-muted">—</span>
                <span className="font-medium text-body">{step.actor ?? "System"}</span>
                {step.at && <span className="text-xs text-muted">· {fmtDateTime(step.at)}</span>}
              </div>
              {step.comments && (
                <p className="mt-1 text-sm italic text-body">“{step.comments}”</p>
              )}
              {step.stage && (
                <p className="mt-0.5 text-xs text-muted">{step.stage}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function fmtTimeOfDay(value: number): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

/** The doctype's short badge — IND, ALL, MR. The code is whatever the backend
 *  stamped, never a screen-side table; the full label rides on the tooltip so
 *  nothing is lost when it is abbreviated, and the tint is the one the phase
 *  chips already wear. */
function DoctypeBadge({ code, label }: { code: string; label?: string | null }) {
  return (
    <span
      title={label && label !== code ? label : undefined}
      className="inline-flex max-w-full items-center truncate rounded-md bg-brand-050 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand"
    >
      {code}
    </span>
  );
}

/** The ladder + origin chip — which approval ladder version a document runs on and
 *  which project/module it came from, both read off the payload the backend sent.
 *  It looks pressable because it is: the route is the backend's `navigation_route`,
 *  the same path the trail's open button uses. A document that never reached a
 *  workflow gets a quiet "No approval ladder"; one whose screen cannot be resolved
 *  renders inert, never dead. */
function LadderChip({ approval, className = "" }: {
  approval?: TrackApproval | null; className?: string;
}) {
  const nav = useNavigate();
  // The chip's destination: the project's approval-flow editor for this document
  // type when the ladder is project-scoped (that page shows which version is
  // running); the Approval Flow settings list for a company-wide indent ladder
  // (where its chain is configured); otherwise the backend-resolved document route.
  const route = (approval?.project_id != null && approval?.doctype)
    ? ladderRoute(approval)
    : (approval?.doctype === "INDENT"
      ? "/admin/approval-flow"
      : ladderRoute(approval));
  const origin = ladderOrigin(approval);
  const summary = [
    approval?.project ? `Project: ${approval.project}` : "",
    approval?.module ? `Module: ${approval.module}` : "",
    approval?.ladder_name ?? "",
  ].filter(Boolean).join(" · ");

  // One flow only — show the full names without truncation.
  const face = (
    <>
      <GitBranch aria-hidden className="h-3 w-3 shrink-0" />
      <span>{ladderChipLabel(approval)}</span>
      {origin && (
        <>
          <span aria-hidden className="opacity-50">·</span>
          <Building2 aria-hidden className="h-3 w-3 shrink-0" />
          <span>{origin}</span>
        </>
      )}
    </>
  );

  if (!route) {
    return (
      <span
        title={summary || undefined}
        className={`inline-flex max-w-full flex-wrap items-center gap-1 rounded-full border border-line bg-content2 px-2 py-0.5 text-[11px] font-medium text-muted ${className}`}
      >
        {face}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        nav(route);
      }}
      title={`Open ${summary || route}`}
      aria-label={`Open the ${approval?.module ?? "source"} screen — ${ladderChipLabel(approval)}`}
      className={`group inline-flex max-w-full flex-wrap items-center gap-1 rounded-full border border-line bg-content2 px-2 py-0.5 text-[11px] font-medium text-muted transition-colors hover:border-brand hover:bg-brand-050 hover:text-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand ${className}`}
    >
      {face}
      <ArrowUpRight aria-hidden className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}
