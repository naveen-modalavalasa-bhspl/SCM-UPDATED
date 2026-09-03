import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Copy, Play } from "lucide-react";
import {
  Button, Card, ErrorBanner, ScrollBox, useToast,
} from "@/shared/components";
import { integrationsApi } from "../api";
import { writeToClipboard } from "./Copyable";
import type { DocEndpoint } from "../types";

/**
 * Connection details — the page you send a partner so they can start calling.
 *
 * Everything here is DERIVED on the server from the endpoint documents. A document
 * kept in step by hand is wrong by the second week, and the drift is only ever found
 * by the partner, at the worst moment.
 *
 * Two things make it useful rather than decorative:
 *
 *   * every endpoint expands to show what it ACCEPTS and what it RETURNS, and can
 *     fetch a REAL response — a shape that is written down is a shape that is guessed
 *     at, and the guess is what gets integrated against;
 *   * Copy as Markdown, because the partner has no SCM login. The screen is behind
 *     one, so a link is no use to them; a self-contained doc pasted into an email is.
 */
export function ConnectionDocsPanel({ clientCode }: { clientCode: string }) {
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [samples, setSamples] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<string | null>(null);

  const docs = useQuery({
    queryKey: ["apis", "docs", clientCode],
    queryFn: () => integrationsApi.docs(clientCode),
  });

  const fetchSample = async (slug: string) => {
    setLoading(slug);
    try {
      const body = await integrationsApi.sample(clientCode, slug, 2);
      setSamples((held) => ({ ...held, [slug]: JSON.stringify(body, null, 2) }));
    } catch {
      setSamples((held) => ({
        ...held,
        [slug]: "This endpoint could not be read. It may reference a table that has "
          + "since changed.",
      }));
    } finally {
      setLoading(null);
    }
  };

  /** The whole thing as a document a partner can read without an SCM login. */
  const asMarkdown = (): string => {
    const d = docs.data;
    if (!d) return "";
    const lines = [
      `# ${d.client_name} — SCM API`,
      "",
      `Base URL: \`${d.base_url}\``,
      "",
      "## Authentication",
      "",
      `Every request carries the header \`${d.auth.header}: <your key>\`.`,
      d.auth.note,
      "",
      "```",
      `curl -H "${d.auth.header}: <your key>" ${d.base_url}${d.probe.path}`,
      "```",
      "",
      `${d.probe.note}`,
      "",
      "## Conventions",
      "",
      ...Object.values(d.conventions).map((note) => `- ${note}`),
      "",
      `A live list of everything your key may call: \`GET ${d.directory.path}\``,
      "",
      `## Endpoints (${d.endpoints.length})`,
      "",
    ];
    d.endpoints.forEach((endpoint) => {
      lines.push(`### ${endpoint.name}`, "", `\`GET ${endpoint.path}\``, "");
      lines.push("| Parameter | Meaning |", "| --- | --- |");
      endpoint.params.forEach((param) =>
        lines.push(`| \`${param.name}\` | ${param.note} |`));
      lines.push("", `Returns: ${endpoint.returns.map((f) => `\`${f}\``).join(", ")}`,
                 "");
    });
    return lines.join("\n");
  };

  // Through the module's one carrier, not `navigator.clipboard` directly: it falls
  // back to a selection where that API does not exist (any plain-http host) and it
  // ANSWERS whether the copy landed, so the toast can never claim one that did not.
  // The box below stays the guarantee either way — the partner has no SCM login, so
  // this text has to be gettable by hand.
  const copyDoc = async () => {
    const text = asMarkdown();
    if (await writeToClipboard(text)) {
      toast.success("Documentation copied — paste it into an email to them.");
      return;
    }
    setSamples((held) => ({ ...held, __doc__: text }));
    toast.success("Copied into the box at the bottom — select it and copy.");
  };

  const d = docs.data;

  return (
    <div className="space-y-4">
      {docs.error && <ErrorBanner error="Connection details could not be loaded." />}

      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted">
          Everything {d?.client_name ?? "this application"} needs to start calling.
          Built from the endpoints themselves, so it cannot fall out of step with what
          is actually served.
        </p>
        <Button variant="ghost" onClick={copyDoc} disabled={!d}>
          <Copy className="h-4 w-4" /> Copy as Markdown
        </Button>
      </div>

      {d && (
        <>
          <Card className="space-y-3 p-4">
            <Row label="Base URL" value={d.base_url} />
            <Row label="Auth header" value={`${d.auth.header}: <your key>`} />
            <Row label="Check the key works" value={`GET ${d.probe.path}`} />
            <Row label="List what it may call" value={`GET ${d.directory.path}`} />
            <ul className="ml-4 list-disc space-y-1 pt-1 text-xs text-muted">
              {Object.values(d.conventions).map((note) => <li key={note}>{note}</li>)}
            </ul>
          </Card>

          <div className="text-sm font-semibold text-ink">
            {d.endpoints.length} endpoints
          </div>

          <Card className="divide-y divide-line/70 p-0">
            {d.endpoints.map((endpoint) => (
              <EndpointRow
                key={endpoint.slug}
                endpoint={endpoint}
                open={open === endpoint.slug}
                sample={samples[endpoint.slug]}
                loading={loading === endpoint.slug}
                onToggle={() => setOpen(open === endpoint.slug ? null : endpoint.slug)}
                onSample={() => fetchSample(endpoint.slug)}
              />
            ))}
          </Card>

          {/* The fallback carrier for a host with no clipboard API. */}
          {samples.__doc__ && (
            <Card className="space-y-2 p-3">
              <p className="text-sm font-semibold text-ink">
                Documentation — select all and copy
              </p>
              <textarea
                readOnly
                value={samples.__doc__}
                onFocus={(event) => event.currentTarget.select()}
                className="min-h-40 w-full rounded-lg border border-line bg-content1
                           p-3 font-mono text-xs text-ink"
              />
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="w-44 shrink-0 text-xs uppercase tracking-wide text-muted">
        {label}
      </span>
      <code className="break-all text-sm text-ink">{value}</code>
    </div>
  );
}

function EndpointRow({ endpoint, open, sample, loading, onToggle, onSample }: {
  endpoint: DocEndpoint;
  open: boolean;
  sample?: string;
  loading: boolean;
  onToggle: () => void;
  onSample: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-content2"
      >
        {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted" />
              : <ChevronRight className="h-4 w-4 shrink-0 text-muted" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">
            {endpoint.name}
          </span>
          <code className="block truncate text-[11px] text-muted">
            GET {endpoint.path}
          </code>
        </span>
        <span className="shrink-0 text-[11px] text-muted">
          {endpoint.returns.length} fields
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-line/70 bg-content2/30 px-4 py-3">
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
              Accepts
            </div>
            <div className="space-y-1">
              {endpoint.params.map((param) => (
                <div key={param.name} className="flex flex-wrap gap-x-2 text-xs">
                  <code className="text-ink">{param.name}</code>
                  <span className="text-muted">{param.note}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
              Returns
            </div>
            <ScrollBox className="max-h-24">
              <div className="flex flex-wrap gap-1">
                {endpoint.returns.map((field) => (
                  <code key={field}
                        className="rounded bg-content1 px-1.5 py-0.5 text-[11px] text-body">
                    {field}
                  </code>
                ))}
              </div>
            </ScrollBox>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                Example response
              </span>
              <Button variant="ghost" onClick={onSample} disabled={loading}>
                <Play className="h-3.5 w-3.5" />
                {loading ? "Reading…" : sample ? "Read again" : "Show a real response"}
              </Button>
            </div>
            {sample
              ? (
                <ScrollBox className="max-h-64">
                  <pre className="whitespace-pre-wrap break-all rounded-lg bg-content1
                                  p-3 font-mono text-[11px] text-body">{sample}</pre>
                </ScrollBox>
              )
              : (
                <p className="text-xs text-muted">
                  Reads two real rows through this endpoint, exactly as their key
                  would — so the shape is seen, not guessed at.
                </p>
              )}
          </div>
        </div>
      )}
    </div>
  );
}
