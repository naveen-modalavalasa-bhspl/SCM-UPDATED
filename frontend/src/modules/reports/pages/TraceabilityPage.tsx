import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown, CheckCircle2, ChevronRight, CornerDownRight, ExternalLink, RotateCcw,
  Search, Send, Undo2, XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@heroui/react";
import { Card, ErrorBanner, PageHeader, StatusPill } from "@/shared/components";
import { api } from "@/shared/api/client";
import { fmtDate, fmtDateTime } from "@/shared/datetime";

/**
 * Document Traceability — one number in, the whole chain out.
 *
 * Type any document number (indent, allocation, material request, requisition, RFQ,
 * quotation, purchase order, GRN, outward inspection, issue, consignment, shipment)
 * and this shows every document connected to it, in the order the work happened, each
 * with its status and its full approval history.
 *
 * Read-only by construction — the backend unions SELECTs over documents that already
 * exist, so nothing here can show an event the documents do not carry.
 *
 * The chain is rendered as a VERTICAL TRAIL rather than a graph. A graph is the
 * truthful shape (a purchase order really does point at an indent, a requisition and
 * a quotation at once) but it is not the readable one: what a person tracing a
 * consignment wants is the order things happened, top to bottom, with the document
 * they searched for marked. The parent links are printed on each row instead, so the
 * branching is still legible without drawing it.
 */

interface TraceNode {
  key: string;
  label: string;
  doc_type: string | null;
  id: number;
  doc_no: string | null;
  status: string | null;
  date: string | null;
  path: string | null;
  is_root: boolean;
  approvals: {
    action: string;
    stage: string | null;
    sequence: number | null;
    actor: string | null;
    actor_position: string | null;
    comments: string | null;
    at: string | null;
    instance_status: string | null;
  }[];
}

interface Chain {
  nodes: TraceNode[];
  edges: { from: string; to: string }[];
  truncated: boolean;
}

const traceApi = {
  search: (q: string) =>
    api.get<TraceNode[]>("/api/reports/traceability/search", { params: { q } })
      .then((r) => r.data),
  chain: (kind: string, docId: number) =>
    api.get<Chain>("/api/reports/traceability/chain",
                   { params: { kind, doc_id: docId } }).then((r) => r.data),
};

/** One glyph per kind of approval action, so a long trail can be scanned rather than
 *  read. The tints are the status tokens the rest of the app already uses. */
const ACTION_META: Record<string, { icon: LucideIcon; tint: string }> = {
  SUBMITTED: { icon: Send, tint: "bg-info-bg text-info" },
  APPROVED: { icon: CheckCircle2, tint: "bg-ok-bg text-ok" },
  REJECTED: { icon: XCircle, tint: "bg-bad-bg text-bad" },
  RETURNED: { icon: Undo2, tint: "bg-warn-bg text-warn" },
  DELEGATED: { icon: CornerDownRight, tint: "bg-info-bg text-info" },
  CANCELLED: { icon: XCircle, tint: "bg-neutral-bg text-neutral" },
  FALLBACK: { icon: RotateCcw, tint: "bg-warn-bg text-warn" },
  MOVED: { icon: CornerDownRight, tint: "bg-warn-bg text-warn" },
};

export function TraceabilityPage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  // The searched document lives in the URL, so a trail can be pasted to a colleague
  // — which is most of why anybody opens this screen.
  const kind = params.get("kind") ?? "";
  const docId = Number(params.get("doc_id") ?? 0);
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [submitted, setSubmitted] = useState(params.get("q") ?? "");

  const results = useQuery({
    queryKey: ["traceability", "search", submitted],
    queryFn: () => traceApi.search(submitted),
    enabled: submitted.trim().length > 0,
  });

  const chain = useQuery({
    queryKey: ["traceability", "chain", kind, docId],
    queryFn: () => traceApi.chain(kind, docId),
    enabled: Boolean(kind && docId),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(query.trim());
    setParams({ q: query.trim() }, { replace: true });
  }

  const open = (node: TraceNode) =>
    setParams({ q: submitted, kind: node.key, doc_id: String(node.id) },
              { replace: true });

  // The parent of each node, for the "from" line on a row — printed rather than
  // drawn, see the note at the top.
  const byRef = new Map((chain.data?.nodes ?? []).map((n) => [`${n.key}:${n.id}`, n]));
  const parentsOf = (node: TraceNode) => (chain.data?.edges ?? [])
    .filter((e) => e.to === `${node.key}:${node.id}`)
    .map((e) => byRef.get(e.from))
    .filter(Boolean) as TraceNode[];

  const hits = results.data ?? [];
  // One match and nothing chosen yet: open it. Typing a full document number and then
  // being asked to click it once more is a step for nothing.
  if (hits.length === 1 && !kind && !chain.isFetching) {
    const only = hits[0];
    if (only) queueMicrotask(() => open(only));
  }

  return (
    <div>
      <PageHeader eyebrow="Reports" title="Document Traceability" />

      <Card className="mb-4 p-4">
        <form onSubmit={submit} className="flex flex-wrap items-center gap-3">
          <label className="relative min-w-64 flex-1">
            <span className="sr-only">Document number</span>
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoFocus
              placeholder="Indent, allocation, issue, GRN, consignment, PO…"
              className="h-11 w-full rounded-lg border border-line bg-content1 pl-9 pr-3 text-sm text-ink placeholder:text-muted focus:border-brand focus:outline-none"
            />
          </label>
          <Button type="submit" color="primary" className="h-11 font-semibold"
                  isDisabled={!query.trim()}>
            Trace
          </Button>
        </form>
        <p className="mt-2 text-xs text-muted">
          Part of a number is enough — the tail off a printed gate pass will find it.
        </p>
      </Card>

      <ErrorBanner error={results.error ?? chain.error} />

      {/* More than one document matched: ask which, rather than guessing. */}
      {hits.length > 1 && (
        <Card className="mb-4 p-2">
          <p className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted">
            {hits.length} documents match
          </p>
          <div className="divide-y divide-line/60">
            {hits.map((hit) => (
              <button
                key={`${hit.key}:${hit.id}`}
                type="button"
                onClick={() => open(hit)}
                className={`flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-content2 ${
                  hit.key === kind && hit.id === docId ? "bg-brand-050/50" : ""
                }`}
              >
                <span className="w-40 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted">
                  {hit.label}
                </span>
                <span className="mono min-w-0 flex-1 truncate text-sm font-semibold text-ink">
                  {hit.doc_no}
                </span>
                {hit.status && <StatusPill status={hit.status} />}
                <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
              </button>
            ))}
          </div>
        </Card>
      )}

      {submitted && !results.isLoading && hits.length === 0 && (
        <Card className="p-10 text-center">
          <p className="text-sm text-muted">
            No document carries a number like “{submitted}”.
          </p>
        </Card>
      )}

      {chain.isLoading && (
        <Card className="p-10 text-center text-sm text-muted">Building the trail…</Card>
      )}

      {chain.data && (
        <>
          {chain.data.truncated && (
            <div className="mb-3 rounded-xl bg-warn-bg px-4 py-3 text-sm text-warn">
              This document is connected to more than the trail shows. Trace one of the
              documents below directly to see its own chain.
            </div>
          )}
          <ol className="space-y-3">
            {chain.data.nodes.map((node, index) => (
              <li key={`${node.key}:${node.id}`}>
                <TraceRow
                  node={node}
                  parents={parentsOf(node)}
                  onOpen={() => node.path && nav(node.path)}
                  onTrace={() => open(node)}
                />
                {index < chain.data.nodes.length - 1 && (
                  <div className="flex justify-center py-1" aria-hidden>
                    <ArrowDown className="h-4 w-4 text-line" />
                  </div>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function TraceRow({ node, parents, onOpen, onTrace }: {
  node: TraceNode;
  parents: TraceNode[];
  onOpen: () => void;
  onTrace: () => void;
}) {
  const [showTrail, setShowTrail] = useState(node.is_root);

  return (
    <Card className={`p-4 ${node.is_root ? "border-brand ring-1 ring-brand/30" : ""}`}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              {node.label}
            </span>
            {node.is_root && (
              <span className="rounded-full bg-brand-050 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand">
                searched
              </span>
            )}
          </div>
          <div className="mono mt-0.5 truncate text-sm font-bold text-ink">
            {node.doc_no ?? `#${node.id}`}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            {node.date && <span>{fmtDate(node.date)}</span>}
            {parents.length > 0 && (
              // The branching, printed rather than drawn — see the note at the top.
              <span className="truncate">
                from {parents.map((p) => p.doc_no).join(", ")}
              </span>
            )}
            <span>
              {node.approvals.length
                ? `${node.approvals.length} approval step${node.approvals.length === 1 ? "" : "s"}`
                : "no approval ladder"}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {node.status && <StatusPill status={node.status} />}
          {node.approvals.length > 0 && (
            <Button size="sm" variant="light" onPress={() => setShowTrail((v) => !v)}>
              {showTrail ? "Hide trail" : "Trail"}
            </Button>
          )}
          {!node.is_root && (
            <Button size="sm" variant="bordered" onPress={onTrace}>Trace</Button>
          )}
          {node.path && (
            <Button size="sm" variant="bordered" onPress={onOpen}
                    aria-label={`Open ${node.doc_no}`}>
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {showTrail && node.approvals.length > 0 && (
        <ol className="mt-3 space-y-2 border-t border-line/60 pt-3">
          {node.approvals.map((step, index) => {
            const meta = ACTION_META[step.action]
              ?? { icon: ChevronRight, tint: "bg-neutral-bg text-neutral" };
            const Icon = meta.icon;
            return (
              <li key={index} className="flex items-start gap-3">
                <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg ${meta.tint}`}>
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-semibold text-ink">{step.action}</span>
                    {step.stage && (
                      <span className="text-xs text-muted">at {step.stage}</span>
                    )}
                  </div>
                  <div className="text-xs text-muted">
                    {step.actor ?? "System"}
                    {step.actor_position ? ` · ${step.actor_position}` : ""}
                    {step.at ? ` · ${fmtDateTime(step.at)}` : ""}
                  </div>
                  {step.comments && (
                    <p className="mt-0.5 text-xs italic text-body">“{step.comments}”</p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
