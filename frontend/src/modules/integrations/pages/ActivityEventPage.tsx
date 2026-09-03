import { useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight, Braces, Building2, FileCode2, Info, MonitorSmartphone, Server,
} from "lucide-react";
import {
  Card, EmptyState, ErrorBanner, PageHeader, ScrollBox, StatusPill, SubNav,
  type SubNavItem,
} from "@/shared/components";
import { fmtDateTime, fmtRelative } from "@/shared/datetime";
import { activityApi } from "../api";
import { CopyButton } from "../components/Copyable";
import { Direction, OutcomePill, wasRefused } from "../components/ActivityChrome";
import type { ActivityEvent, ActivityFact } from "../types";

/**
 * One integration event, opened — its own page, its own address.
 *
 * IT WAS A DIALOG UNTIL 2026-09-01, and a dialog was the wrong shape for it twice
 * over. An event is what somebody forwards to a partner ("this is the push you say
 * you sent, here is what arrived") and a box over the list has no address to send
 * anyone. And the thing they open it FOR — the body that moved — is the one thing a
 * scrolling window the size of a postcard cannot show.
 *
 * HOW IT STAYS SIMPLE WHILE SHOWING EVERYTHING. Three rungs, in the order a person
 * asks them:
 *
 *   1. What happened — one sentence, the result, and when.
 *   2. Between whom — the two ends of the wire with their IP and port, and the
 *      request that ran between them. Always visible: it is the question a network
 *      problem is asked in, and it must never be behind a tab.
 *   3. Everything else — on tabs, so the page opens readable. `Details` is the rest
 *      of the record in plain words, `The data` is the body itself, and
 *      `Full record` is the source's own document verbatim for anyone who needs
 *      field names rather than labels.
 *
 * NOTHING HERE KNOWS A FIELD NAME. The labels, the wording and which values are
 * identifiers are all decided in `activity.py` and arrive as `facts` — so a field a
 * receipt or `sys_app_logs` learns to record tomorrow appears on this page with no
 * change to this file. The only field names in this file are the handful drawn
 * ABOVE the tabs, listed once in `SHOWN_ABOVE` so they are not also repeated below.
 */

/** Fields already drawn in the header or the route strip. Left out of `Details`,
 *  which is the REST of the record — the same value in two places on one page is how
 *  a detail screen becomes a wall. All of them are still in `Full record`. */
const SHOWN_ABOVE = new Set([
  "at", "received_at", "created_at", "endpoint", "http_method", "status_code",
  "ip_address", "remote_port", "local_ip_address", "local_port",
  // The reason a request was refused IS the sentence at the top of the page — it is
  // what `detail` is built from. Repeating it three inches lower under its own
  // heading is the same words twice on one screen.
  "message", "error",
]);

const TABS: SubNavItem[] = [
  { key: "details", label: "Details", icon: Info },
  { key: "data", label: "The data", icon: Braces },
  { key: "record", label: "Full record", icon: FileCode2 },
];

const pretty = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);

/** A machine on one end of the wire, with the socket it was reached on.
 *
 *  The address is the point of the card, so it is never silently blank: a value the
 *  log does not hold says so, because "nothing here" and "0.0.0.0" are different
 *  answers to "where did this come from". */
function Endpoint({
  role, name, note, ip, port, icon: Icon,
}: {
  role: string;
  name: string;
  note: string;
  ip?: string | null;
  port?: number | null;
  icon: typeof Server;
}) {
  return (
    <div className="min-w-0 flex-1 rounded-xl border border-line/70 bg-content1 p-3.5">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <Icon className="h-3.5 w-3.5" />
        {role}
      </div>
      <div className="truncate text-sm font-semibold text-ink" title={name}>{name}</div>
      <div className="mt-0.5 text-xs text-muted">{note}</div>
      <div className="mt-2 rounded-lg bg-content2 px-2 py-1.5 font-mono text-xs text-body">
        {ip ? ip : <span className="text-muted">IP not recorded</span>}
        {port ? <span className="text-muted">:{port}</span> : null}
      </div>
    </div>
  );
}

/** One line of the record. `block` values (a stack trace, a posting outcome) get the
 *  full width and their own scroll box; everything else is a label over a value. */
function Fact({ fact }: { fact: ActivityFact }) {
  return (
    <div className={`min-w-0 rounded-xl border border-line/70 bg-content1 p-3 ${
      fact.block ? "sm:col-span-2" : ""}`}>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
        {fact.label}
      </div>
      {fact.block ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg
                        bg-content2 p-2.5 font-mono text-xs leading-relaxed text-body">
          {fact.value}
        </pre>
      ) : (
        <div className={`break-words text-sm text-ink ${
          fact.mono ? "font-mono text-xs" : ""}`}>
          {fact.value}
        </div>
      )}
    </div>
  );
}

/** A JSON body, shown whole. Copyable, because the next thing that happens to it is
 *  usually that somebody pastes it into a message to the partner who sent it. */
function Body({ title, note, value }: { title: string; note: string; value: unknown }) {
  const text = useMemo(() => pretty(value), [value]);
  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-display text-sm font-bold text-ink">{title}</div>
          {note && <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">{note}</p>}
        </div>
        <CopyButton value={text} label="Copy" />
      </div>
      <ScrollBox>
        <pre className="max-h-[60vh] overflow-auto rounded-lg bg-content2 p-3
                        font-mono text-xs leading-relaxed text-body">
          {text}
        </pre>
      </ScrollBox>
    </Card>
  );
}

export default function ActivityEventPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const [tab, setTab] = useState("details");

  const { data, isLoading, error } = useQuery<ActivityEvent>({
    queryKey: ["apis", "activity", "event", id],
    queryFn: () => activityApi.event(id),
    enabled: Boolean(id),
    retry: false,
  });

  // The list writes where it was into `?back=`, so Back returns to the same page of
  // the same filters. Only a path inside this screen is followed: an address that
  // arrives in a link is somebody else's text until it is checked.
  const from = params.get("back") ?? "";
  const back = {
    to: from.startsWith("/admin/integrations") ? from : "/admin/integrations?tab=activity",
    label: "Back to Activity log",
  };

  if (isLoading) {
    return (
      <div>
        <PageHeader title="Loading the event…" back={back} />
        <Card className="p-6 text-sm text-muted">Reading what was recorded…</Card>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div>
        <PageHeader title="That event could not be opened" back={back} />
        <ErrorBanner error={error ?? "That event is no longer in the log."} />
        <EmptyState
          title="Nothing to show for this event"
          hint="Pushes are kept as a de-duplication window and the oldest are dropped as new ones arrive; reads are remembered in memory only and start again from empty each time the server restarts. The Activity log lists what is still held."
        />
      </div>
    );
  }

  const inbound = data.direction === "IN";
  // Turned away at the door — so nothing moved, and no line on this page may say it
  // did. An accepted push whose lines could not all be posted is FAILED too and is
  // NOT this: it got in. The rule is shared with the list (`ActivityChrome`).
  const refused = wasRefused(data);
  const facts = data.facts.filter((fact) => !SHOWN_ABOVE.has(fact.field));
  const hasPayload = data.payload !== null && data.payload !== undefined;

  return (
    <div>
      <PageHeader
        title={data.headline}
        back={back}
        actions={<OutcomePill row={data} />}
      />

      {/* Rung one: what happened, in one sentence, with the clock beside it. */}
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Direction row={data} />
          <span className="text-sm font-semibold text-ink">
            {refused ? "Turned away" : data.channel_note}
          </span>
          <span className="text-xs text-muted">·</span>
          <span className="text-sm text-body">{fmtDateTime(data.at)}</span>
          <span className="text-xs text-muted">({fmtRelative(data.at)})</span>
          {!data.durable && (
            <StatusPill status="DRAFT" label="Kept until restart" />
          )}
        </div>
        <p className="mt-2 text-sm leading-relaxed text-body">
          {refused
            ? (inbound
                ? "An outside system tried to send data into SCM and was turned away. Nothing was saved."
                : "An outside application asked SCM for data and was turned away. Nothing was sent back.")
            : (inbound
                ? "An outside system sent data into SCM."
                : "An outside application read data out of SCM.")}
          {data.detail ? ` ${data.detail}` : ""}
        </p>
      </Card>

      {/* Rung two: the two ends of the wire. Never behind a tab — a network problem
          is asked in exactly these four numbers. */}
      <Card className="mb-4 p-4">
        <div className="mb-3 font-display text-sm font-bold text-ink">
          Between which two machines
        </div>
        <div className="flex flex-col items-stretch gap-3 lg:flex-row lg:items-center">
          <Endpoint
            role={inbound ? "Sent from" : "Asked by"}
            name={data.party}
            note={inbound
              ? (refused ? "Tried to send data" : "Pushed the data")
              : "Made the request"}
            ip={data.ip_address}
            port={data.remote_port}
            icon={MonitorSmartphone}
          />
          <div className="flex shrink-0 flex-col items-center gap-1 px-1">
            <ArrowRight className="h-5 w-5 rotate-90 text-muted lg:rotate-0" aria-hidden="true" />
            <span className="rounded-md bg-content2 px-2 py-1 font-mono text-[11px] text-body">
              {data.http_method ?? "—"} {data.status_code ? `· ${data.status_code}` : ""}
            </span>
          </div>
          <Endpoint
            role={refused ? "Turned away by" : inbound ? "Received at" : "Answered by"}
            name="SCM"
            note={refused
              ? "Refused the request"
              : inbound ? "Checked it and stored it" : "Served the read"}
            ip={data.local_ip_address}
            port={data.local_port}
            icon={Server}
          />
        </div>
        <div className="mt-3 rounded-lg bg-content2 px-3 py-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            Address it was called on
          </span>
          <div className="mt-0.5 break-all font-mono text-xs text-body">
            {data.endpoint ?? "Not recorded"}
          </div>
        </div>
        {/* Which way anything actually travelled — said once, plainly, because it is
            the question the two cards above are read to answer. A refusal moved
            nothing in either direction, and must never be left implying it did. */}
        {(refused || !inbound) && (
          <p className="mt-2 text-xs leading-relaxed text-muted">
            {refused
              ? (inbound
                  ? "Nothing was saved. The push was stopped before SCM accepted it."
                  : "No data left SCM. The request was stopped before anything was read.")
              : `The rows travelled back the other way, from SCM to ${data.party}.`}
          </p>
        )}
      </Card>

      <SubNav label="This event" items={TABS} value={tab} onChange={setTab} />

      {tab === "details" && (
        facts.length ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {facts.map((fact) => <Fact key={fact.field} fact={fact} />)}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted">
              The time, the address and the two sockets are above rather than repeated
              here. Every field the source recorded, under its own name, is on
              <span className="font-medium text-body"> Full record</span>.
            </p>
          </>
        ) : (
          <EmptyState
            title="Nothing further was recorded"
            hint="This event carries only what is shown above."
          />
        )
      )}

      {tab === "data" && (
        <div className="space-y-4">
          {/* What an application is ever allowed to be sent, when it read one of the
              built APIs. It is the honest answer to "what data went out" for a reply
              that is deliberately not stored a second time. */}
          {data.served && (
            <Card className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Building2 className="h-4 w-4 text-muted" />
                <span className="font-display text-sm font-bold text-ink">
                  {data.served.name}
                </span>
                {data.served.table && (
                  <span className="rounded-md bg-content2 px-2 py-0.5 font-mono text-[11px] text-muted">
                    {data.served.table}
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">
                Every column this API can ever return — nothing outside this list left
                SCM on this call.
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {data.served.columns.map((column) => (
                  <span key={column}
                        className="rounded-md border border-line bg-content1 px-2 py-1
                                   font-mono text-[11px] text-body">
                    {column}
                  </span>
                ))}
              </div>
            </Card>
          )}

          {hasPayload ? (
            <Body title={data.payload_label || "The data"} note={data.payload_note}
                  value={data.payload} />
          ) : (
            <EmptyState
              title="No body was kept for this event"
              hint={data.payload_note || "This source records what happened, not what it carried."}
            />
          )}
        </div>
      )}

      {tab === "record" && (
        <Body
          title="The record exactly as it was stored"
          note="Every field the source kept for this event, under its own name. Nothing on this page is composed from anything that is not here."
          value={data.record}
        />
      )}
    </div>
  );
}
