import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { Copy } from "lucide-react";
import { Button, Card, ErrorBanner, useToast } from "@/shared/components";
import { camsApi } from "../api";

/**
 * What B-CAMS is handed: the address to post to, how to sign, and one example body
 * per event.
 *
 * The same job `WebhookDocsModal` does for a registered webhook, and it exists for the
 * same reason — the person integrating is another company's developer who will never
 * have an SCM login, so the details have to leave this screen as text that can be
 * pasted into an email. Copy as Markdown is therefore the primary action, not a
 * convenience.
 *
 * Nothing here is written in the browser. Every URL, header and example comes from
 * `/api/apis/cams/docs`, built from the one table that also registers the endpoints,
 * so the screen cannot advertise a path that does not exist or a body the validator
 * would refuse. The host is the host the request arrived on — open this from the LAN
 * and it shows the LAN address, which is the one that will actually work.
 */
export function CamsDocsModal({ open, onClose }: {
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const [fallback, setFallback] = useState("");

  const docs = useQuery({
    queryKey: ["cams", "docs"],
    queryFn: camsApi.docs,
    enabled: open,
  });

  const asMarkdown = (): string => {
    const d = docs.data;
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

  const copyDoc = () => {
    const text = asMarkdown();
    const written = navigator.clipboard?.writeText(text);
    // `?.` short-circuits the whole chain where the API is missing, so the fallback
    // has to be raised on both paths or the plain-http host silently does nothing.
    if (!written) {
      setFallback(text);
      toast.success("Copied into the box below — select it and copy.");
      return;
    }
    written.then(
      () => toast.success("Documentation copied — paste it into an email to them."),
      () => { setFallback(text); toast.success("Copied into the box below."); },
    );
  };

  const d = docs.data;

  return (
    <Modal isOpen={open} onClose={onClose} size="3xl">
      <ModalContent>
        <ModalHeader className="font-display text-lg font-bold text-ink">
          How B-CAMS pushes to SCM
        </ModalHeader>
        <ModalBody className="gap-3">
          <ErrorBanner error={docs.error} />
          {d && (
            /* Plain overflow-y, not `ScrollBox`: that one is for wide TABLES and
             * scrolls sideways only, so capping its height here would clip the
             * examples dead with nothing to scroll. */
            <div className="max-h-[60vh] overflow-y-auto overscroll-y-contain">
              <div className="space-y-4 pr-1">
                <Card className="space-y-2 p-3">
                  <div className="text-xs uppercase tracking-wide text-muted">
                    Base URL
                  </div>
                  <code className="block break-all text-sm text-ink">
                    {d.base_url}
                  </code>
                  {!d.configured && (
                    // Documented but unusable. Worth saying on the page somebody is
                    // reading in order to hand the address over.
                    <div className="rounded-lg bg-warn-bg/60 p-2 text-xs text-body">
                      No shared secret has been issued yet, so every write will be
                      refused. Issue one before sending these details.
                    </div>
                  )}
                </Card>

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
                    <div key={write.event} className="rounded-lg bg-content1 p-2">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-sm font-semibold text-ink">
                          {write.label}
                        </span>
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
                    <pre className="whitespace-pre-wrap break-all rounded-lg
                                    bg-content1 p-3 font-mono text-[11px] text-body">
                      {JSON.stringify(d.writes[0].sample, null, 2)}
                    </pre>
                    <p className="pt-1 text-xs text-muted">
                      The other {d.writes.length - 1} examples are in the Markdown copy.
                    </p>
                  </Section>
                )}

                <Section title="Answers">
                  {d.answers.map((answer, index) => (
                    // Two rows share status 200 — accepted and duplicate — so the
                    // status cannot be the key.
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
                      className="min-h-40 w-full rounded-lg border border-line
                                 bg-content1 p-3 font-mono text-xs text-ink"
                    />
                  </Section>
                )}
              </div>
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={copyDoc} disabled={!d}>
            <Copy className="h-4 w-4" /> Copy as Markdown
          </Button>
          <Button onClick={onClose}>Close</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
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
