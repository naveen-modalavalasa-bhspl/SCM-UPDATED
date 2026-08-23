import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  Boxes, CheckCircle2, ChevronRight, Clock, RotateCcw, TriangleAlert, XCircle,
  type LucideIcon,
} from "lucide-react";
import { Can, Card, ErrorBanner, PageHeader, StatusPill } from "@/shared/components";
import { approvalsApi } from "../api";
import { BreakdownDonut, CardTitle, Kpi, foldSlices } from "../components/ApprovalPulse";
import { docTypeLabel } from "../docTypes";
import { approvalDocumentPath } from "../documentRoutes";

/**
 * The approvals dashboard — the SHAPE of this approver's workload.
 *
 * Three screens, three jobs, and this one had to earn its place. The inbox is
 * where work is DONE (queue, filters, bulk sign-off). Reports is the RECORD (a
 * filterable, exportable table of decisions). This is the SHAPE: how much is on
 * me, what it is made of, and what I have just been signing. The first cut of
 * this page redrew the inbox's own counts and doc-type chips, which is a second
 * door onto one room — the donut and the recent strip are what make it a third
 * answer rather than a third door.
 *
 * Two scopes decide everything here, and they are not the same scope:
 *
 *   APPROVAL scope — every number is what is waiting on, or was decided by, THIS
 *   approver. The endpoints filter on `wf_pending.approver_id` and apply the
 *   engine's other-hat rule, so somebody wearing two District Manager hats is
 *   never counted work they cannot sign. `pending/summary` counts in SQL, which
 *   is why these tiles cannot drift from the list they open.
 *
 *   RBAC scope — which SECTIONS exist is what this login may reach. The two desks
 *   hang off different codes (Consolidation needs `indent.approve`, the cycles
 *   need `allocation.view`), so they are gated separately rather than as one
 *   block. `<Can>` is UX only; the endpoints enforce the same codes and answer a
 *   caller without one with a 403, not with data.
 */

const DAY = 86_400_000;

/** Whole days since a timestamp. Never negative: clock skew between the API host
 *  and the browser must not read as "waiting -1 days". */
function daysSince(iso: string | null | undefined) {
  if (!iso) return null;
  const started = new Date(iso).getTime();
  if (!Number.isFinite(started)) return null;
  return Math.max(0, Math.floor((Date.now() - started) / DAY));
}

const DECISION_TONE: Record<string, { icon: LucideIcon; tint: string }> = {
  APPROVED: { icon: CheckCircle2, tint: "text-ok" },
  REJECTED: { icon: XCircle, tint: "text-bad" },
  RETURNED: { icon: RotateCcw, tint: "text-warn" },
};

export function ApprovalOverviewPage() {
  const nav = useNavigate();

  const summary = useQuery({
    queryKey: ["approvals", "pending", "summary"],
    queryFn: () => approvalsApi.pendingSummary(),
  });
  const report = useQuery({
    queryKey: ["approvals", "report"],
    queryFn: () => approvalsApi.report(),
  });
  // Five rows, not the whole history: this strip answers "what have I just been
  // signing", and the full record is one click away on My Decisions.
  const recent = useQuery({
    queryKey: ["approvals", "decisions", "recent"],
    queryFn: () => approvalsApi.decisions(1, 5),
  });
  // Its own query, and allowed to fail on its own: this endpoint is gated on
  // `allocation.view`, which the other three are not. Folding it into any of them
  // would blank a card an approver is entitled to over a permission they are not.
  const cycles = useQuery({
    queryKey: ["approvals", "allocation-cycles"],
    queryFn: () => approvalsApi.allocationCycles(),
    retry: false,
  });

  const waiting = summary.data?.total ?? 0;
  const pastDue = summary.data?.past_due ?? 0;
  const oldest = daysSince(summary.data?.oldest_waiting_since);
  const decided = report.data?.total_decisions ?? 0;

  // What the queue is MADE of. Only the types actually sitting in this approver's
  // queue — every DocType in the system would draw nine slices, eight of them zero.
  const slices = foldSlices(
    Object.entries(summary.data?.by_doc_type ?? {})
      .map(([key, count]) => ({ key, label: docTypeLabel(key), count })),
  );

  return (
    <>
      <PageHeader title="Overview" />

      {/* The summary IS the page. A failure here is not a partial render — say so,
          rather than draw four zeroes, which reads as "nothing to approve". */}
      <ErrorBanner error={summary.error} />

      <section aria-label="Approval queues" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Waiting for me"
          value={waiting}
          icon={Clock}
          tint="bg-brand-050 text-brand"
          muted={waiting === 0}
          onOpen={() => nav("/approvals")}
        />
        <Kpi
          label="Past due"
          value={pastDue}
          icon={TriangleAlert}
          tint="bg-bad-bg text-bad"
          muted={pastDue === 0}
          onOpen={() => nav("/approvals?overdue=1")}
        />
        <Kpi
          label={oldest === null ? "Nothing waiting" : "Longest wait"}
          value={oldest === null ? "—" : `${oldest}d`}
          icon={Clock}
          tint="bg-warn-bg text-warn"
          muted={oldest === null}
          onOpen={() => nav("/approvals?sort=oldest")}
        />
        <Kpi
          label="Decided by me"
          value={decided}
          icon={CheckCircle2}
          tint="bg-ok-bg text-ok"
          onOpen={() => nav("/approvals/decisions")}
        />
      </section>

      <section className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[1.4fr_1fr]">
        <Card className="p-4">
          <CardTitle title="Waiting on me, by document" />
          <BreakdownDonut
            slices={slices}
            total={waiting}
            totalLabel="Awaiting me"
            emptyText="Nothing waiting on you."
            onPick={(key) => nav(
              key === "__other__" ? "/approvals" : `/approvals?doc_type=${encodeURIComponent(key)}`,
            )}
          />
        </Card>

        <Card className="p-4">
          <CardTitle
            title="Recent decisions"
            action={
              <button
                type="button"
                onClick={() => nav("/approvals/decisions")}
                className="text-xs font-semibold text-brand transition-colors hover:text-brand-600"
              >
                View all
              </button>
            }
          />
          {recent.isLoading && <p className="py-8 text-center text-sm text-muted">Loading…</p>}
          {!recent.isLoading && !recent.data?.items.length && (
            <p className="py-8 text-center text-sm text-muted">You have not decided anything yet.</p>
          )}
          <ul className="divide-y divide-line/60">
            {(recent.data?.items ?? []).map((row) => {
              const tone = DECISION_TONE[row.decision] ?? { icon: Clock, tint: "text-muted" };
              return (
                <li key={row.id}>
                  {/* Straight to the document it decided — the same route the inbox
                      uses, so a decision and its document never disagree on where
                      the document lives. */}
                  <button
                    type="button"
                    onClick={() => nav(approvalDocumentPath(row))}
                    className="flex min-h-11 w-full items-center gap-2.5 py-2 text-left transition-colors hover:bg-content2/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    <tone.icon className={`h-4 w-4 shrink-0 ${tone.tint}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[13px] font-semibold text-ink">
                        {row.doc_no ?? `#${row.doc_id}`}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {docTypeLabel(row.doc_type)}
                      </span>
                    </span>
                    <StatusPill status={row.decision} />
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      </section>

      {/* The two other desks. Separate permissions, so separate gates. */}
      <section className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Can do="indent.approve">
          <button
            type="button"
            onClick={() => nav("/approvals/consolidation")}
            className="flex min-h-[68px] items-center gap-3 rounded-2xl border border-line/70 bg-content1 p-4 text-left transition-colors hover:border-brand/40 hover:bg-content2/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-info-bg text-info">
              <Boxes className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-display text-base font-bold text-ink">Consolidation</span>
              <span className="block truncate text-sm text-muted">Monthly indents, signed as one batch</span>
            </span>
            <ChevronRight className="h-5 w-5 shrink-0 text-muted" />
          </button>
        </Can>

        <Can do="allocation.view">
          <button
            type="button"
            onClick={() => nav("/approvals/consolidation")}
            className="flex min-h-[68px] items-center gap-3 rounded-2xl border border-line/70 bg-content1 p-4 text-left transition-colors hover:border-brand/40 hover:bg-content2/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-050 text-brand">
              <Boxes className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-display text-base font-bold text-ink">
                {cycles.data?.length ?? 0} allocation {cycles.data?.length === 1 ? "cycle" : "cycles"}
              </span>
              <span className="block truncate text-sm text-muted">Waiting on my signature</span>
            </span>
            <ChevronRight className="h-5 w-5 shrink-0 text-muted" />
          </button>
        </Can>
      </section>
    </>
  );
}
