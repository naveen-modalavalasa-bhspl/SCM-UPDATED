import { useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import {
  Activity, AlertTriangle, ArrowDownLeft, ArrowUpRight, Clock3, Globe2, Hash,
  Plug, Puzzle, Radio, Route, Server,
} from "lucide-react";
import {
  Button, Card, EmptyState, ErrorBanner, FilterBar, KpiTiles, ResponsiveList, Select,
  StatusPill, type Column, type KpiTileSpec,
} from "@/shared/components";
import { fmtDateTime, fmtRelative } from "@/shared/datetime";
import { activityApi } from "../api";
import type { ActivityRow } from "../types";

/**
 * The Activity Log — one list of everything that happened on every integration.
 *
 * WHY IT IS ONE SCREEN. "Is this integration working?" was being answered in four
 * places: a per-application usage tab, a per-webhook received list, the adapter's own
 * receipts, and Settings > App Logs for the failures. Nobody watching a partner go
 * live could see the push arrive and the refusal that followed it in the same list,
 * because they were not in the same list.
 *
 * IT IS A READ-OUT. Every row already exists somewhere for its own reasons — see the
 * module docstring on `integrations/activity.py`. Nothing is written to feed this
 * screen, so it can never show an event the system does not actually carry, and
 * deleting it would change nothing about what SCM does.
 *
 * IT IS WRITTEN FOR SOMEBODY WHO DOES NOT WORK IN IT. Every row leads with a sentence
 * — "HCM sent 'employee.updated'" — and the status code sits underneath as evidence.
 * The sentence and the result word are composed on the SERVER, so an event is
 * described the same way wherever it is shown and this file has no vocabulary of its
 * own to drift.
 *
 * NOTHING HERE NAMES A SYSTEM. The filters are served (`activityApi.filters`), so an
 * application or a webhook registered five minutes ago is listed, countable and
 * selectable with no change to this file.
 */

/** The three results, in the app's own status colours.
 *
 *  `StatusPill` maps a document status to a tone and takes a `label` that overrides
 *  the words without touching the status. An integration outcome is not a document
 *  status, so it is translated to the nearest one here — module-local, one line, and
 *  the shared pill is still the only thing that decides what green looks like. */
const OUTCOME_STATUS: Record<string, string> = {
  OK: "APPROVED",
  FAILED: "REJECTED",
  DUPLICATE: "DRAFT",
};

const CHANNEL_ICON = {
  WEBHOOK: Radio,
  ADAPTER: Puzzle,
  APPLICATION: Plug,
} as const;

/** How far back to look. A window, not an archive — the stores behind it are capped. */
const WINDOWS = [
  { value: "1", label: "Last 24 hours" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];

function OutcomePill({ row }: { row: ActivityRow }) {
  return (
    <StatusPill status={OUTCOME_STATUS[row.outcome] ?? "DRAFT"}
                label={row.outcome_word} />
  );
}

/** The arrow says which way the data moved. Two icons carry the one fact the whole
 *  row hangs off, and the text beside them repeats it for a screen reader. */
function Direction({ row }: { row: ActivityRow }) {
  const Icon = row.direction === "IN" ? ArrowDownLeft : ArrowUpRight;
  const ChannelIcon = CHANNEL_ICON[row.channel] ?? Plug;
  return (
    <span className="flex items-center gap-1.5" title={row.channel_note}>
      <Icon className={`h-4 w-4 shrink-0 ${
        row.direction === "IN" ? "text-info" : "text-brand"}`} aria-hidden="true" />
      <ChannelIcon className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
      <span className="sr-only">{row.channel_note}. </span>
    </span>
  );
}

function valueOrDash(value: string | number | null | undefined, fallback = "Not recorded by this log") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function DetailTile({
  label,
  value,
  icon,
  mono = false,
}: {
  label: string;
  value: string | number | null | undefined;
  icon?: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-line/70 bg-content1 p-3">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase text-muted">
        {icon}
        <span>{label}</span>
      </div>
      <div className={`min-w-0 break-words text-sm text-ink ${mono ? "font-mono text-xs" : ""}`}>
        {valueOrDash(value)}
      </div>
    </div>
  );
}

function ActivityDetailModal({
  row,
  onClose,
}: {
  row: ActivityRow | null;
  onClose: () => void;
}) {
  const isInbound = row?.direction === "IN";
  const directionText = isInbound
    ? "The outside system sent data into SCM."
    : "The outside application read data out of SCM.";
  const endpoint = row?.endpoint ?? (row?.event ? `/api/ext/v1/${row.event}` : null);
  const rowCount = row?.rows === null || row?.rows === undefined
    ? null
    : `${row.rows} ${row.rows === 1 ? "row" : "rows"}`;
  const dataSummary = row
    ? [row.event, rowCount].filter(Boolean).join(" | ")
    : null;

  return (
    <Modal isOpen={row !== null} onClose={onClose} size="3xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="font-display text-lg font-bold text-ink">
          {row?.headline ?? "Activity detail"}
        </ModalHeader>
        <ModalBody className="gap-4">
          {row && (
            <>
              <div className="rounded-lg border border-line/70 bg-content2 p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Direction row={row} />
                  <OutcomePill row={row} />
                  <span className="text-xs text-muted">{row.channel_note}</span>
                </div>
                <p className="text-sm leading-relaxed text-body">{directionText}</p>
                {row.detail && (
                  <p className="mt-2 text-sm leading-relaxed text-muted">{row.detail}</p>
                )}
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-lg border border-line/70 bg-content1 p-3">
                  <div className="mb-1 text-[11px] font-semibold uppercase text-muted">
                    From
                  </div>
                  <div className="text-sm font-semibold text-ink">{row.party}</div>
                  <div className="mt-1 text-xs text-muted">
                    Data: <span className="font-medium text-body">{valueOrDash(dataSummary, "No data summary")}</span>
                  </div>
                  <div className="mt-1 font-mono text-xs text-muted">
                    IP: {valueOrDash(row.ip_address, "Not stored")}
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-muted">
                    Port: {valueOrDash(row.remote_port, "Not stored")}
                  </div>
                </div>
                <div className="rounded-lg border border-line/70 bg-content1 p-3">
                  <div className="mb-1 text-[11px] font-semibold uppercase text-muted">
                    Through
                  </div>
                  <div className="text-sm font-semibold text-ink">SCM external API</div>
                  <div className="mt-1 font-mono text-xs text-muted">
                    {row.http_method ? `${row.http_method} ` : ""}{valueOrDash(endpoint)}
                  </div>
                </div>
                <div className="rounded-lg border border-line/70 bg-content1 p-3">
                  <div className="mb-1 text-[11px] font-semibold uppercase text-muted">
                    Receiving side
                  </div>
                  <div className="text-sm font-semibold text-ink">SCM</div>
                  <div className="mt-1 text-xs text-muted">
                    {isInbound ? "Received the push" : "Served the read request"}
                  </div>
                  <div className="mt-1 font-mono text-xs text-muted">
                    IP: {valueOrDash(row.local_ip_address, "Not stored")}
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-muted">
                    Port: {valueOrDash(row.local_port, "Not stored")}
                  </div>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <DetailTile label="Exact time" value={row.at ? fmtDateTime(row.at) : null}
                            icon={<Clock3 className="h-3.5 w-3.5" />} />
                <DetailTile label="System" value={row.party}
                            icon={<Server className="h-3.5 w-3.5" />} />
                <DetailTile label="Channel" value={row.channel}
                            icon={<Globe2 className="h-3.5 w-3.5" />} />
                <DetailTile label="Endpoint" value={endpoint}
                            icon={<Route className="h-3.5 w-3.5" />} mono />
                <DetailTile label="Status code" value={row.status_code ?? "No HTTP code stored"}
                            icon={<Hash className="h-3.5 w-3.5" />} />
                <DetailTile label="Rows" value={rowCount ?? "No row count stored"} />
                <DetailTile label="Reference or key" value={row.reference} mono />
                <DetailTile label="Request ID" value={row.request_id} mono />
                <DetailTile label="Event" value={row.event} mono />
                <DetailTile label="Storage" value={row.durable ? "Stored permanently" : "Kept until server restart"} />
              </div>
            </>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

export function ActivityLog() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [party, setParty] = useState("");
  const [outcome, setOutcome] = useState("");
  const [direction, setDirection] = useState("");
  const [days, setDays] = useState("7");
  const [selected, setSelected] = useState<ActivityRow | null>(null);

  const reset = () => setPage(1);
  const query = {
    page, size: 25, search, party, outcome, direction, days: Number(days),
  };

  const { data, isLoading, error } = useQuery({
    queryKey: ["apis", "activity", query],
    queryFn: () => activityApi.feed(query),
  });

  // The tiles read the same window as the list, so a count and the rows under it can
  // never disagree — they are computed over one set of rows on the server.
  const { data: summary, isError: summaryFailed } = useQuery({
    queryKey: ["apis", "activity", "summary", days],
    queryFn: () => activityApi.summary(Number(days)),
  });

  const { data: options } = useQuery({
    queryKey: ["apis", "activity", "filters"],
    queryFn: () => activityApi.filters(),
  });

  /** Pressing a tile applies the filter it counts, and pressing it again clears it. */
  const toggle = (next: { direction?: string; outcome?: string }) => {
    reset();
    if (next.direction !== undefined) {
      setOutcome("");
      setDirection(direction === next.direction ? "" : next.direction);
    }
    if (next.outcome !== undefined) {
      setDirection("");
      setOutcome(outcome === next.outcome ? "" : next.outcome);
    }
  };

  const tiles: KpiTileSpec[] = [
    {
      key: "all", label: "Everything", icon: Activity, tone: "neutral",
      value: summary?.total, failed: summaryFailed,
      active: !direction && !outcome,
      onPress: () => { reset(); setDirection(""); setOutcome(""); },
      hint: "Every event in the window. Press to clear the filters.",
    },
    {
      key: "in", label: "Sent in to us", icon: ArrowDownLeft, tone: "info",
      value: summary?.inbound, failed: summaryFailed,
      active: direction === "IN", onPress: () => toggle({ direction: "IN" }),
      hint: "Pushes from an outside system into SCM.",
    },
    {
      key: "out", label: "Read out of us", icon: ArrowUpRight, tone: "brand",
      value: summary?.outbound, failed: summaryFailed,
      active: direction === "OUT", onPress: () => toggle({ direction: "OUT" }),
      hint: "Calls an outside application made to read SCM data.",
    },
    {
      key: "failed", label: "Did not work", icon: AlertTriangle,
      tone: summary?.failed ? "bad" : "ok",
      value: summary?.failed, failed: summaryFailed,
      active: outcome === "FAILED", onPress: () => toggle({ outcome: "FAILED" }),
      hint: "Anything refused, rejected or only partly applied.",
    },
  ];

  const activeFilters =
    (search ? 1 : 0) + (party ? 1 : 0) + (outcome ? 1 : 0) + (direction ? 1 : 0);

  const columns: Column<ActivityRow>[] = [
    {
      key: "at",
      header: "When",
      render: (row) => (
        <div className="text-sm">
          <div className="text-ink">{fmtRelative(row.at)}</div>
          <div className="text-xs text-muted">{fmtDateTime(row.at)}</div>
        </div>
      ),
    },
    {
      key: "what",
      header: "What happened",
      render: (row) => (
        <div className="min-w-0">
          <div className="flex items-start gap-2">
            <Direction row={row} />
            {/* The sentence is the row. Everything else on the line is evidence for
                it, which is why the code and the reference are a size smaller. */}
            <span className="min-w-0 font-medium text-ink">{row.headline}</span>
          </div>
          {row.detail && (
            <div className="mt-0.5 pl-6 text-xs leading-relaxed text-muted">
              {row.detail}
            </div>
          )}
        </div>
      ),
    },
    {
      key: "party",
      header: "System",
      hideOnNarrow: true,
      render: (row) => (
        <div className="text-sm">
          <div className="truncate text-ink">{row.party}</div>
          <div className="text-xs text-muted">{row.channel_note}</div>
        </div>
      ),
    },
    {
      key: "outcome",
      header: "Result",
      render: (row) => (
        <div className="min-w-0">
          <OutcomePill row={row} />
          <div className="mt-1 text-[11px] leading-tight text-muted">
            {row.status_code ? `Code ${row.status_code}` : null}
            {row.status_code && row.rows !== null && row.rows !== undefined ? " · " : null}
            {row.rows !== null && row.rows !== undefined
              ? `${row.rows} ${row.rows === 1 ? "row" : "rows"}` : null}
          </div>
          {/* A row that came from the in-memory call ring says so on the row, not in
              a footnote nobody reads. A restart empties it, and a gap that is not
              explained reads as "nothing happened". */}
          {!row.durable && (
            <div className="mt-0.5 text-[11px] leading-tight text-muted">
              Kept until restart
            </div>
          )}
          <div className="mt-1 text-[11px] font-medium text-brand">
            Click for full trace
          </div>
        </div>
      ),
    },
  ];

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / (data?.size || 25)));

  return (
    <div>
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl
                           bg-neutral-bg text-neutral">
            <Activity className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-display text-base font-bold text-ink">
              Activity log
            </div>
            <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-body">
              Everything that happened between SCM and the outside systems connected to
              it — every push that arrived, every read that went out, and everything
              that was turned away with the reason it was turned away. Applications and
              webhooks together, newest first. Nothing is recorded specially for this
              page: it reads what the system already keeps, so a system connected today
              appears here today.
            </p>
          </div>
        </div>
      </Card>

      <KpiTiles label="Integration activity" tiles={tiles} className="mb-4" />

      <FilterBar
        search={search}
        onSearch={(value) => { setSearch(value); reset(); }}
        searchPlaceholder="Search by system, event or reason…"
        searchLabel="Search the activity log"
        active={activeFilters}
        onClear={() => {
          setSearch(""); setParty(""); setOutcome(""); setDirection(""); reset();
        }}
        right={
          <span className="text-sm text-muted">
            {total} {total === 1 ? "event" : "events"}
          </span>
        }
      >
        {/* Every option here is SERVED. Nothing in this file knows the name of a
            single application, webhook or adapter. */}
        <Select
          value={party}
          onChange={(value) => { setParty(value); reset(); }}
          ariaLabel="Filter by system"
          placeholder="Every system"
          className="min-w-[190px]"
          options={[
            { value: "", label: "Every system" },
            ...(options?.parties ?? []).map((option) => ({
              value: option.code, label: option.name,
            })),
          ]}
        />
        <Select
          value={outcome}
          onChange={(value) => { setOutcome(value); setDirection(""); reset(); }}
          ariaLabel="Filter by result"
          placeholder="Any result"
          className="min-w-[160px]"
          options={[
            { value: "", label: "Any result" },
            ...(options?.outcomes ?? []).map((option) => ({
              value: option.code, label: option.name,
            })),
          ]}
        />
        <Select
          value={days}
          onChange={(value) => { setDays(value); reset(); }}
          ariaLabel="How far back to look"
          className="min-w-[150px]"
          options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))}
        />
      </FilterBar>

      {error && <ErrorBanner error="The activity log could not be loaded." />}

      {/* One line per connected system, so "which one is broken" is answered before
          the list is read. Hidden once a system is chosen — it would be a strip of
          one. */}
      {!party && (summary?.by_party?.length ?? 0) > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {summary!.by_party.map((line) => (
            <button
              key={line.party}
              type="button"
              onClick={() => { setParty(line.party_code ?? line.party); reset(); }}
              className={`flex min-h-11 items-center gap-2 rounded-xl border px-3 py-2
                          text-left transition hover:border-brand/40 ${
                line.failed
                  ? "border-bad/30 bg-bad-bg/40"
                  : "border-line/70 bg-content1"}`}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-ink">
                  {line.party}
                </span>
                <span className="block text-[11px] text-muted">
                  {line.total} {line.total === 1 ? "event" : "events"}
                  {line.failed > 0 && ` · ${line.failed} failed`}
                  {line.last_at && ` · ${fmtRelative(line.last_at)}`}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      <ResponsiveList
        data={data?.items ?? []}
        columns={columns}
        keyOf={(row) => row.id}
        onRowClick={setSelected}
        loading={isLoading}
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        empty={
          <EmptyState
            title="Nothing happened in this window"
            hint={
              activeFilters
                ? "No event matches these filters. Widen the window or clear them."
                : "No outside system has called SCM or pushed anything into it in this period. Reads are only remembered until the server restarts, so a quiet list here does not prove nothing was sent."
            }
          />
        }
        renderCard={(row) => (
          <div className="p-1">
            <div className="flex items-start justify-between gap-2">
              <span className="flex min-w-0 items-start gap-2">
                <Direction row={row} />
                <span className="min-w-0 font-medium text-ink">{row.headline}</span>
              </span>
              <OutcomePill row={row} />
            </div>
            {row.detail && (
              <div className="mt-1 text-xs leading-relaxed text-muted">{row.detail}</div>
            )}
            <div className="mt-1.5 text-xs text-muted">
              {fmtRelative(row.at)} · {row.party}
              {row.status_code ? ` · code ${row.status_code}` : ""}
              {!row.durable ? " · kept until restart" : ""}
            </div>
          </div>
        )}
      />

      <ActivityDetailModal row={selected} onClose={() => setSelected(null)} />

      {/* Said once, at the bottom, plainly. The failure half of this log is written to
          the database and survives anything; the read half is an in-memory ring the
          server keeps per process. Implying otherwise would make an empty morning
          after a restart look like a partner had gone silent. */}
      <p className="mt-4 text-xs leading-relaxed text-muted">
        Pushes that arrived and anything that was turned away are stored and stay
        stored. Reads by an application are remembered in memory only and start again
        from empty each time the server restarts — those rows are marked
        “kept until restart”.
      </p>
    </div>
  );
}
