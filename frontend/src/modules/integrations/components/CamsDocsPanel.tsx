import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, RotateCcw } from "lucide-react";
import {
  Button, Card, ConfirmModal, ErrorBanner, useToast,
} from "@/shared/components";
import { fmtDateTime } from "@/shared/datetime";
import { camsApi } from "../api";
import { useCamsWrites } from "../camsEvents";
import { writeToClipboard } from "./Copyable";

/**
 * Connection details for B-CAMS — what you send the team that will push to us.
 *
 * The adapter's `WebhookDocsPanel`, rung for rung: the secret at the top where a
 * webhook's sits, then the address, the headers, the envelope, the endpoints, one
 * worked example and the answers — and Copy as Markdown, which matters more here than
 * anywhere on the pull side because the reader of this document is another company's
 * developer who will never have an SCM login.
 *
 * Nothing on this panel is written in the browser. Every URL, header and example comes
 * from `/api/apis/cams/docs`, built from the one table that also registers the
 * endpoints, so the screen cannot advertise a path that does not exist or a body the
 * validator would refuse. The host is the host the request arrived on — open this from
 * the LAN and it shows the LAN address, which is the one that will actually work.
 */
export function CamsDocsPanel() {
  const toast = useToast();
  const [fallback, setFallback] = useState("");
  const { docs: d, error } = useCamsWrites();

  const asMarkdown = (): string => {
    if (!d) return "";
    return [
      "# Pushing to SCM — B-CAMS",
      "",
      `Base URL: \`${d.base_url}\``,
      "",
      "## Headers",
      "",
      "| Header | Value |",
      "| --- | --- |",
      ...d.headers.map((h) => `| \`${h.name}\` | ${h.note} |`),
      "",
      d.signing_note,
      "",
      "## Every body carries",
      "",
      "| Field | Meaning |",
      "| --- | --- |",
      ...d.envelope.map((e) => `| \`${e.field}\` | ${e.note} |`),
      "",
      `## Endpoints (${d.writes.length})`,
      "",
      "| Event | POST to | Effect |",
      "| --- | --- | --- |",
      ...d.writes.map((w) => `| \`${w.event}\` | \`${w.url}\` | ${w.effect} |`),
      "",
      "## Examples",
      "",
      ...d.writes.flatMap((w) => [
        `### ${w.label} — \`POST ${w.url}\``,
        "",
        "```json",
        JSON.stringify(w.sample, null, 2),
        "```",
        "",
      ]),
      "## Answers",
      "",
      "| Status | Meaning |",
      "| --- | --- |",
      ...d.answers.map((a) => `| ${a.status} | ${a.note} |`),
      "",
      "A repeated `event_id` is answered `duplicate` and changes nothing, so retrying",
      "is always safe.",
      "",
      `## Read feeds (${d.feeds.length})`,
      "",
      ...d.feeds.map((f) => `- \`GET ${f}\``),
    ].join("\n");
  };

  // The module's one carrier, for the same reason the webhook panel uses it: it falls
  // back to a selection where `navigator.clipboard` does not exist and it says whether
  // the copy landed, so the toast cannot claim one that did not.
  const copyDoc = async () => {
    const text = asMarkdown();
    if (await writeToClipboard(text)) {
      toast.success("Documentation copied — paste it into an email to them.");
      return;
    }
    setFallback(text);
    toast.success("Copied into the box below — select it and copy.");
  };

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          Everything B-CAMS needs, derived from the same table that registers the
          endpoints — so it cannot describe a write this adapter would refuse.
        </p>
        <Button variant="subtle" onClick={copyDoc} disabled={!d}>
          <Copy className="h-4 w-4" /> Copy as Markdown
        </Button>
      </div>

      <CamsSecretSection />

      {d && (
        <>
          <Card className="space-y-2 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">
              Base URL
            </div>
            <code className="block break-all text-sm text-ink">{d.base_url}</code>
            {!d.configured && (
              // Documented but unusable. Worth saying here, because this is the panel
              // somebody is reading in order to hand the address over.
              <div className="rounded-lg bg-warn-bg/60 p-2 text-xs text-body">
                No shared secret has been issued yet, so every write will be refused.
                Issue one above before sending these details.
              </div>
            )}
          </Card>

          <Card className="space-y-4 p-4">
            <Section title="Headers">
              {d.headers.map((header) => (
                <Line key={header.name} name={header.name} note={header.note} />
              ))}
              <p className="pt-1 text-xs text-muted">{d.signing_note}</p>
            </Section>

            <Section title="Every body carries">
              {d.envelope.map((field) => (
                <Line key={field.field} name={field.field} note={field.note} />
              ))}
            </Section>

            <Section title={`Endpoints (${d.writes.length})`}>
              {d.writes.map((write) => (
                <div key={write.event} className="rounded-lg bg-content2 p-2">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-semibold text-ink">{write.label}</span>
                    {/* Whether accepting it MOVES STOCK. Two of the five do, and a
                        partner reading this needs to know which before they replay a
                        batch. */}
                    {write.deducts_stock && (
                      <span className="rounded bg-ok/15 px-1.5 py-0.5 text-[10px]
                                       font-semibold uppercase tracking-wide text-ok">
                        Moves stock
                      </span>
                    )}
                  </div>
                  <code className="mt-1 block break-all text-xs text-body">
                    {write.method} {write.url}
                  </code>
                  <div className="mt-0.5 font-mono text-[11px] text-muted">
                    {write.event}
                  </div>
                </div>
              ))}
            </Section>

            {d.writes.length > 0 && (
              <Section title={`Example — ${d.writes[0].label}`}>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg
                                bg-content2 p-3 font-mono text-[11px] text-body">
                  {JSON.stringify(d.writes[0].sample, null, 2)}
                </pre>
                {d.writes.length > 1 && (
                  <p className="pt-1 text-xs text-muted">
                    The other {d.writes.length - 1} example
                    {d.writes.length > 2 ? "s are" : " is"} in the Markdown copy.
                  </p>
                )}
              </Section>
            )}

            <Section title="Answers">
              {d.answers.map((answer, index) => (
                // Two rows share status 200 — accepted and duplicate — so the status
                // cannot be the key.
                <Line key={`${answer.status}-${index}`} name={String(answer.status)}
                      note={answer.note} />
              ))}
            </Section>

            {d.feeds.length > 0 && (
              <Section title={`Read feeds (${d.feeds.length})`}>
                <div className="space-y-0.5">
                  {d.feeds.map((feed) => (
                    <code key={feed} className="block break-all text-[11px] text-muted">
                      GET {feed}
                    </code>
                  ))}
                </div>
              </Section>
            )}

            {fallback && (
              <Section title="Documentation — select all and copy">
                <textarea
                  readOnly
                  value={fallback}
                  onFocus={(event) => event.currentTarget.select()}
                  className="min-h-40 w-full rounded-lg border border-line bg-content1 p-3
                             font-mono text-xs text-ink"
                />
              </Section>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

/**
 * The shared secret, in the shape `SecretRevealSection` gives a webhook's.
 *
 * IT IS NOT THAT COMPONENT, and the reason is a real difference rather than a missing
 * feature: the webhook side has `GET .../secret` and a password-gated reveal, so an
 * admin can go and look at a value issued a year ago. The adapter serves no such route
 * — `/api/apis/cams/secret` mints, and that is all. So this shows a freshly minted
 * value exactly as a reveal does, and otherwise says plainly that SCM will not show it
 * again, rather than offering a Reveal button that could only ever fail.
 */
function CamsSecretSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  const status = useQuery({ queryKey: ["cams", "status"], queryFn: camsApi.status });

  const rotate = useMutation({
    mutationFn: camsApi.rotateSecret,
    onSuccess: (result) => {
      setSecret(result.shared_secret);
      setAsking(false);
      void queryClient.invalidateQueries({ queryKey: ["cams", "status"] });
      void queryClient.invalidateQueries({ queryKey: ["cams", "docs"] });
      toast.success("New secret issued — copy it and send it to them now");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  // Off the screen after half a minute, the same as a revealed webhook secret. A
  // shared secret left sitting on an unattended browser is the whole reason it is
  // shown once.
  useEffect(() => {
    if (!secret) return undefined;
    const timer = window.setTimeout(() => setSecret(null), 30000);
    return () => window.clearTimeout(timer);
  }, [secret]);

  const copy = async () => {
    if (!secret) return;
    if (await writeToClipboard(secret)) {
      toast.success("Shared secret copied");
      setSecret(null);
      return;
    }
    toast.error("Copy did not work. Select the text with your mouse and press Ctrl+C.");
  };

  const configured = status.data?.configured ?? false;

  return (
    <>
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-ink">
              <KeyRound className="h-4 w-4 text-brand" />
              Secret Key
            </div>
            <p className="mt-1 max-w-2xl text-xs text-muted">
              B-CAMS signs the raw body of every write with it and sends the result as
              the <code className="text-body">X-CAMS-Signature</code> header. It is
              shown once, when it is issued, and SCM will not show it again.
            </p>
            {configured && (
              <p className="mt-1 text-xs text-muted">
                Issued {fmtDateTime(status.data?.rotated_at ?? "")}
                {status.data?.rotated_by_name ? ` by ${status.data.rotated_by_name}` : ""}.
                They also need an API key scoped <code className="text-body">cams</code>,
                issued against their application on the Applications tab.
              </p>
            )}
          </div>
          {/* NOTHING is offered until the status query has answered. While it is in
              flight `configured` is false, which used to render the primary "Generate
              secret" button over a live integration — and that press does NOT ask
              first, because issuing a first secret breaks nothing. One click during a
              slow load, or while the query is erroring, and a working adapter is
              refusing every write with no warning shown. So the press that cannot be
              undone is never drawn from a guess about the state. */}
          <div className="flex flex-wrap items-center gap-2">
            {status.isLoading || status.error ? (
              <Button variant="ghost" disabled>
                <KeyRound className="h-4 w-4" />
                {status.error ? "Status unavailable" : "Checking…"}
              </Button>
            ) : configured ? (
              <Button variant="ghost" disabled={rotate.isPending}
                      onClick={() => setAsking(true)}>
                <RotateCcw className="h-4 w-4" /> Replace
              </Button>
            ) : (
              <Button disabled={rotate.isPending} onClick={() => rotate.mutate()}>
                <KeyRound className="h-4 w-4" />
                {rotate.isPending ? "Generating…" : "Generate secret"}
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <code
            className={`flex min-h-11 flex-1 items-center overflow-hidden rounded-lg border
                        border-line bg-content2 px-3 py-2 font-mono text-xs ${
                          secret
                            ? "break-all text-ink"
                            : "select-none whitespace-nowrap text-muted blur-[1.5px]"
                        }`}
          >
            {secret ?? "scm_........................................"}
          </code>
          <Button variant="subtle" disabled={!secret} onClick={copy}>
            <Copy className="h-4 w-4" /> Copy
          </Button>
        </div>
      </Card>

      {/* Replacing a live secret breaks the partner until they update it. Asked rather
          than guarded by a disabled button — an admin may genuinely need to rotate
          one, they just must not do it without knowing. */}
      <ConfirmModal
        isOpen={asking}
        title="Replace the B-CAMS shared secret?"
        message={(
          <>
            A new secret is minted and the current one stops working immediately —
            every write B-CAMS sends is refused until they have been given the
            replacement, including the two that move stock. There is no undo, and the
            new value is shown once.
          </>
        )}
        confirmLabel="Replace it"
        danger
        busy={rotate.isPending}
        error={rotate.error}
        onConfirm={() => rotate.mutate()}
        onClose={() => setAsking(false)}
      />
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted">
        {title}
      </div>
      {children}
    </div>
  );
}

function Line({ name, note }: { name: string; note: string }) {
  return (
    <div className="flex flex-wrap gap-x-2 text-xs">
      <code className="shrink-0 text-ink">{name}</code>
      <span className="min-w-0 text-muted">{note}</span>
    </div>
  );
}
