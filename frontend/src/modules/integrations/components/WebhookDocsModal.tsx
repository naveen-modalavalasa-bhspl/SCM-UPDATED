import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { Copy } from "lucide-react";
import { Button, Card, ErrorBanner, ScrollBox, useToast } from "@/shared/components";
import { webhooksApi } from "../api";

/**
 * Connection details for one webhook — what you send the system that will push to us.
 *
 * The mirror image of `ConnectionDocsPanel`, which documents what an application
 * PULLS. Same rule: everything is derived on the server from the registration, so it
 * cannot drift from what the endpoint will actually accept. The events listed here
 * are literally the ones the receiver checks against.
 *
 * Copy as Markdown matters more here than on the pull side: the sender is usually
 * another company's developer, who will never have an SCM login to read this screen.
 */
export function WebhookDocsModal({ source, onClose }: {
  source: string | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const [fallback, setFallback] = useState("");

  const docs = useQuery({
    queryKey: ["apis", "webhook-docs", source],
    queryFn: () => webhooksApi.docs(source as string),
    enabled: source !== null,
  });

  const asMarkdown = (): string => {
    const d = docs.data;
    if (!d) return "";
    const lines = [
      `# Pushing to SCM — ${d.name}`,
      "",
      `\`${d.method} ${d.url}\``,
      "",
      `What SCM does with it: **${d.handler_label}**`,
      "",
      "## Headers",
      "",
      "| Header | Value |",
      "| --- | --- |",
      ...d.headers.map((h) => `| \`${h.name}\` | ${h.note} |`),
      "",
      d.signing_note,
      "",
      "## Body",
      "",
      "| Field | Meaning |",
      "| --- | --- |",
      ...d.envelope.map((e) => `| \`${e.field}\` | ${e.note} |`),
      "",
      `## Events accepted (${d.events.length})`,
      "",
      ...d.events.map((e) => `- \`${e}\``),
      "",
      "Anything else is refused, and the refusal names what is accepted.",
      "",
      "## Examples",
      "",
      ...d.samples.flatMap((s) => [
        `### ${s.event}`, "", "```json", JSON.stringify(s.body, null, 2), "```", "",
      ]),
      "## Answers",
      "",
      "| Status | Meaning |",
      "| --- | --- |",
      ...d.answers.map((a) => `| ${a.status} | ${a.note} |`),
      "",
      "A repeated `event_id` is answered `duplicate` and changes nothing, so retrying",
      "is always safe.",
    ];
    return lines.join("\n");
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
    <Modal isOpen={source !== null} onClose={onClose} size="3xl">
      <ModalContent>
        <ModalHeader className="font-display text-lg font-bold text-ink">
          How {d?.name ?? source} pushes to SCM
        </ModalHeader>
        <ModalBody className="gap-3">
          <ErrorBanner error={docs.error} />
          {d && (
            <ScrollBox className="max-h-[60vh]">
              <div className="space-y-4 pr-1">
                <Card className="space-y-2 p-3">
                  <code className="block break-all text-sm text-ink">
                    {d.method} {d.url}
                  </code>
                  <div className="text-xs text-muted">
                    What SCM does with it:{" "}
                    <span className="font-semibold text-body">{d.handler_label}</span>
                  </div>
                  {!d.has_secret && d.require_signature && (
                    // Registered but unusable. Worth saying here, because this is the
                    // page somebody is reading in order to hand the URL over.
                    <div className="rounded-lg bg-warn-bg/60 p-2 text-xs text-body">
                      No secret has been issued yet, so every push will be refused.
                      Issue one before sending these details.
                    </div>
                  )}
                </Card>

                <Section title="Headers">
                  {d.headers.map((header) => (
                    <Line key={header.name} name={header.name} note={header.note} />
                  ))}
                  <p className="pt-1 text-xs text-muted">{d.signing_note}</p>
                </Section>

                <Section title="Body">
                  {d.envelope.map((field) => (
                    <Line key={field.field} name={field.field} note={field.note} />
                  ))}
                </Section>

                <Section title={`Events accepted (${d.events.length})`}>
                  <div className="flex flex-wrap gap-1">
                    {d.events.map((event) => (
                      <code key={event}
                            className="rounded bg-content1 px-1.5 py-0.5 text-[11px] text-body">
                        {event}
                      </code>
                    ))}
                  </div>
                  <p className="pt-1 text-xs text-muted">
                    Anything else is refused, and the refusal names what is accepted.
                  </p>
                </Section>

                {d.samples.length > 0 && (
                  <Section title={`Example — ${d.samples[0].event}`}>
                    <pre className="whitespace-pre-wrap break-all rounded-lg
                                    bg-content1 p-3 font-mono text-[11px] text-body">
                      {JSON.stringify(d.samples[0].body, null, 2)}
                    </pre>
                    {d.samples.length > 1 && (
                      <p className="pt-1 text-xs text-muted">
                        The other {d.samples.length - 1} event
                        {d.samples.length > 2 ? "s are" : " is"} in the Markdown copy.
                      </p>
                    )}
                  </Section>
                )}

                <Section title="Answers">
                  {d.answers.map((answer) => (
                    <Line key={answer.status} name={String(answer.status)}
                          note={answer.note} />
                  ))}
                </Section>

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
            </ScrollBox>
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
