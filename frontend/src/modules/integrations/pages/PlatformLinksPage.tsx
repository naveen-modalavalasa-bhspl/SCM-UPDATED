import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle, CheckCircle2, Database, Eye, EyeOff, PlugZap, RefreshCw, Send,
  ShieldCheck, XCircle,
} from "lucide-react";
import {
  Button, Card, ErrorBanner, PageHeader, ResponsiveList, StatusPill,
  type Column,
} from "@/shared/components";
import { platformLinksApi } from "../api";
import type { LinkLogRow, LinkTest, PlatformLink } from "../types";

const SIZE = 20;

/** The glyph per link. Keyed on the code the server sends rather than its `icon`
 *  string, so this screen never draws the generic box the menu table can. */
const GLYPH: Record<string, typeof Database> = {
  hcm: RefreshCw,
  mail: Send,
  database: Database,
};

const when = (value?: string | null) =>
  value ? new Date(value).toLocaleString() : "—";

/** Statuses that mean "this went wrong", across both logs. Everything else is either
 *  fine or still running, and neither deserves red. */
const BAD = new Set(["FAILED", "ERROR", "FAILURE"]);

/**
 * App Integrations — what this deployment connects OUT to.
 *
 * The console tab answers "who calls us". This one answers the question nothing did:
 * what do WE call, with which credentials, is it working, and what has it been doing.
 *
 * Secrets are masked server-side and there is no route that unmasks one — the reveal
 * toggle here only hides the masked strings, which is a shoulder-surfing courtesy and
 * not a security boundary. Everything needed to diagnose a wrong deployment survives
 * masking: whether a key is set, WHICH key it is (the first and last four differ
 * between the 8001 and 8009 HCM keys), and whether it works. Test answers the last one
 * by making a real call rather than by printing the password.
 */
export default function PlatformLinksPage() {
  // Which link's log is open. Null keeps the page to the cards, which is what the
  // reader wants first — the log is the second question, always.
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [logPage, setLogPage] = useState(1);
  const [results, setResults] = useState<Record<string, LinkTest>>({});
  // The real credentials, per link, once someone has asked for them. Component state
  // only: never cached by TanStack, never persisted, gone on reload — so a secret
  // cannot come back on a later render nobody asked for.
  const [shown, setShown] = useState<Record<string, Record<string, string>>>({});

  const { data: links = [], isLoading, error } = useQuery({
    queryKey: ["apis", "platform"],
    queryFn: platformLinksApi.list,
  });

  const test = useMutation({
    mutationFn: (code: string) => platformLinksApi.test(code),
    onSuccess: (result) => setResults((r) => ({ ...r, [result.code]: result })),
  });

  const reveal = useMutation({
    mutationFn: (code: string) => platformLinksApi.reveal(code),
    onSuccess: (result) => setShown((s) => ({
      ...s,
      [result.code]: Object.fromEntries(result.fields.map((f) => [f.label, f.value])),
    })),
  });

  /** Hiding again is local — the server is not asked twice, and the value simply
   *  leaves the page. */
  const hide = (code: string) =>
    setShown(({ [code]: _gone, ...rest }) => rest);

  const { data: logs, isLoading: logsLoading } = useQuery({
    queryKey: ["apis", "platform", openLog, "logs", logPage],
    queryFn: () => platformLinksApi.logs(openLog!, { page: logPage, size: SIZE }),
    enabled: Boolean(openLog),
  });
  const { data: stats } = useQuery({
    queryKey: ["apis", "platform", openLog, "log-stats"],
    queryFn: () => platformLinksApi.logStats(openLog!),
    enabled: Boolean(openLog),
  });

  const openLink = links.find((l) => l.code === openLog);

  const columns: Column<LinkLogRow>[] = [
    {
      key: "at",
      header: "When",
      render: (r) => <span className="whitespace-nowrap text-xs">{when(r.at)}</span>,
    },
    {
      key: "status",
      header: "Status",
      render: (r) => <StatusPill status={r.status} />,
    },
    {
      key: "subject",
      header: "Subject",
      render: (r) => (
        <span className="truncate text-sm font-medium text-ink">{r.subject ?? "—"}</span>
      ),
    },
    {
      key: "detail",
      header: "Detail",
      render: (r) => (
        <div className="min-w-0">
          <span className="block truncate text-xs text-muted">{r.detail ?? "—"}</span>
          {r.error && (
            // The whole point of surfacing these rows: a failed sync's message was
            // written to the table and read by nobody.
            <span className="mt-0.5 block break-words text-xs text-bad">{r.error}</span>
          )}
        </div>
      ),
    },
    {
      key: "actor",
      header: "By",
      hideOnNarrow: true,
      render: (r) => <span className="text-xs text-muted">{r.actor ?? "—"}</span>,
    },
  ];

  const card = (link: PlatformLink) => {
    const Glyph = GLYPH[link.code] ?? PlugZap;
    const result = results[link.code];
    const busy = test.isPending && test.variables === link.code;
    const activity = link.last_activity;
    const open = shown[link.code];
    const revealing = reveal.isPending && reveal.variables === link.code;
    const hasSecrets = link.fields.some((f) => f.is_secret && f.is_set);

    return (
      <Card key={link.code} className="overflow-hidden">
        <div className="flex flex-wrap items-start gap-3 border-b border-line/70 p-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center
                           rounded-xl bg-brand-050 text-brand">
            <Glyph className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-display text-base font-semibold text-ink">
                {link.name}
              </h3>
              <StatusPill status={link.configured ? "CONFIGURED" : "NOT CONFIGURED"} />
              <span className="text-[11px] uppercase tracking-wide text-muted">
                {link.kind}
              </span>
            </div>
            {/* The address, in the font it is typed in. This is the line that answers
                "which server is this deployment actually pointed at". */}
            <p className="mt-1 break-all font-mono text-xs text-muted">
              {link.endpoint ?? "not configured"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {hasSecrets && (
              // Per link, not per page: revealing is a recorded act, so it is asked
              // for about ONE thing at a time rather than swept across all three.
              <Button variant="ghost" disabled={revealing}
                onClick={() => (open ? hide(link.code) : reveal.mutate(link.code))}>
                {open
                  ? <><EyeOff className="mr-1 h-4 w-4" /> Hide</>
                  : <><Eye className="mr-1 h-4 w-4" />
                      {revealing ? "Revealing…" : "Reveal"}</>}
              </Button>
            )}
            <Button variant="subtle" disabled={busy || !link.configured}
              onClick={() => test.mutate(link.code)}>
              <ShieldCheck className="mr-1 h-4 w-4" />
              {busy ? "Testing…" : "Test"}
            </Button>
            {link.has_log && (
              <Button
                variant={openLog === link.code ? "soft" : "ghost"}
                onClick={() => {
                  setOpenLog(openLog === link.code ? null : link.code);
                  setLogPage(1);
                }}
              >
                {link.log_label ?? "Log"}
              </Button>
            )}
          </div>
        </div>

        <div className="p-4">
          <p className="mb-3 max-w-3xl text-sm leading-relaxed text-muted">
            {link.summary}
          </p>

          {result && (
            <div className={`mb-3 flex items-start gap-2 rounded-xl border p-3 text-sm
                             ${result.ok
                               ? "border-ok/30 bg-ok-bg text-ok"
                               : "border-bad/30 bg-bad-bg text-bad"}`}>
              {result.ok
                ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
              <span className="min-w-0 break-words">
                {result.detail}
                <span className="ml-1 opacity-70">({result.ms} ms)</span>
              </span>
            </div>
          )}

          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {link.fields.map((field) => (
              <div key={field.label}
                className="flex items-baseline justify-between gap-3 border-b
                           border-line/40 py-1.5">
                <dt className="shrink-0 text-xs text-muted">{field.label}</dt>
                <dd className="min-w-0 text-right">
                  {field.is_set ? (
                    <span className={`break-all font-mono text-xs ${
                      field.is_secret && open?.[field.label]
                        ? "rounded bg-warn-bg px-1.5 py-0.5 text-ink"
                        : "text-ink"}`}>
                      {/* A revealed secret is tinted, so a screenshot of this card
                          never looks like the ordinary masked state. */}
                      {field.is_secret
                        ? open?.[field.label] ?? field.value
                        : field.value}
                    </span>
                  ) : (
                    <span className="text-xs italic text-muted">not set</span>
                  )}
                  {field.hint && (
                    <span className="mt-0.5 block text-[11px] text-muted">
                      {field.hint}
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>

          {activity && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl
                            bg-content2 px-3 py-2 text-xs">
              {BAD.has((activity.status ?? "").toUpperCase())
                ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-bad" />
                : <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-ok" />}
              <span className="font-medium text-ink">Last: {activity.status}</span>
              <span className="text-muted">{when(activity.at)}</span>
              <span className="min-w-0 truncate text-muted">{activity.detail}</span>
            </div>
          )}
        </div>
      </Card>
    );
  };

  return (
    <div>
      <PageHeader eyebrow="Settings" title="App Integrations" />

      <Card className="mb-4 overflow-hidden">
        <div className="flex gap-3 border-l-[3px] border-brand p-4 sm:gap-4 sm:p-5">
          <span className="mt-0.5 hidden h-9 w-9 shrink-0 items-center justify-center
                           rounded-xl bg-brand-050 text-brand sm:flex">
            <PlugZap className="h-4.5 w-4.5" />
          </span>
          <p className="max-w-3xl text-sm leading-relaxed text-muted">
            What this deployment connects out to, read from{" "}
            <span className="font-mono text-xs">backend/.env</span>. Keys and passwords
            arrive <b className="text-body">masked</b> — enough of each to tell one
            credential from another. <b className="text-body">Reveal</b> fetches the
            real value for that one link and <b className="text-body">records who
            asked</b> in the audit log. <b className="text-body">Test</b> proves a
            credential works without revealing it: nothing is emailed, nothing written.
          </p>
        </div>
      </Card>

      <ErrorBanner error={error ?? test.error} />

      {isLoading ? (
        <Card className="p-8 text-center text-sm text-muted">Reading configuration…</Card>
      ) : (
        <div className="grid gap-4">{links.map(card)}</div>
      )}

      {openLink && (
        <Card className="mt-4 p-2">
          <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-2 pt-1">
            <h3 className="font-display text-sm font-semibold text-ink">
              {openLink.name} · {openLink.log_label}
            </h3>
            <div className="flex flex-wrap items-center gap-1.5">
              {/* Counts over the WHOLE log, not this page — a failure count that
                  changed as you paged would be worse than none. */}
              {Object.entries(stats?.by_status ?? {}).map(([status, count]) => (
                <span key={status}
                  className="inline-flex items-center gap-1.5 rounded-md bg-content2
                             px-2 py-1 text-[11px]">
                  <StatusPill status={status} />
                  <span className="font-semibold text-ink">{count}</span>
                </span>
              ))}
            </div>
          </div>
          <ResponsiveList
            data={logs?.items ?? []}
            columns={columns}
            keyOf={(r) => r.id}
            loading={logsLoading}
            page={logPage}
            totalPages={Math.max(1, Math.ceil((logs?.total ?? 0) / SIZE))}
            onPageChange={setLogPage}
            empty={`Nothing logged for ${openLink.name} yet.`}
            renderCard={(r) => (
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium text-ink">{r.subject ?? "—"}</span>
                  <StatusPill status={r.status} />
                </div>
                <div className="text-xs text-muted">{when(r.at)}</div>
                <div className="text-xs text-muted">{r.detail}</div>
                {r.error && <div className="text-xs text-bad">{r.error}</div>}
              </div>
            )}
          />
        </Card>
      )}
    </div>
  );
}
