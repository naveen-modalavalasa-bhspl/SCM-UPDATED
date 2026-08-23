import { useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import { ArrowLeft, Check, X } from "lucide-react";
import { Button, Can, Card, PageHeader, StatusPill } from "@/shared/components";
import { LoadingRows } from "../components/PageStates";
import { fmtDateTime } from "@/shared/datetime";
import {
  approveAllocationsBatch, getAllocationApprovalBatches, getAllocationHistories,
  rejectAllocationsBatch,
} from "../api";
import type { AllocBatchResult } from "../types";

/**
 * One monthly cycle's allocations, opened from the Allocation Approvals list.
 *
 * Consolidating the indents and the allocation decision only moved the queue along:
 * 900 requests approved together, allocated together, and then 900 separate
 * allocations to open and sign. The cycle is ONE decision for the approver, so it is
 * one row in that list and it opens here — the same shape a single allocation opens
 * in, with the whole cycle laid out and one signature at the bottom.
 *
 * Each allocation still goes through its own ladder and writes its own `wf_actions`
 * row. This only saves the clicking.
 */

/** Allocations per request. Small enough that no single call can outlive a gateway
 *  timeout on a monthly batch, large enough that a normal batch is one call. */
const CHUNK = 25;

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, ""));

export function AllocationCycleApprovalPage() {
  const { cycle = "" } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<AllocBatchResult | null>(null);

  const batches = useQuery({
    queryKey: ["allocation-approval-batches", "with-done"],
    // Finished cycles included: opening one that has just been signed must
    // still show what was decided, not an empty screen.
    queryFn: () => getAllocationApprovalBatches(true),
    // A cycle must not change under the approver mid-review. Allocations are still
    // being raised while this screen is open, and a background refetch quietly grew
    // the table and the "Approve all N" count between reading and clicking — so the
    // signature covered a set the approver had never seen. New arrivals are announced
    // instead (see `arrived` below) and picked up on an explicit refresh.
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
  const batch = (batches.data?.items ?? []).find((b) => b.cycle === cycle);

  // The exact set this screen is showing, frozen the first time it loads. The buttons
  // act on THIS list — never on whatever the server happens to hold when the click
  // lands, which is how half a cycle came to be signed while other rows appeared.
  const shown = useRef<number[] | null>(null);
  if (shown.current === null && batch) shown.current = [...batch.allocation_ids];
  const arrived = useMemo(() => {
    if (!batch || !shown.current) return 0;
    const known = new Set(shown.current);
    return batch.allocation_ids.filter((id) => !known.has(id)).length;
  }, [batch]);
  const signable = useMemo(() => {
    const frozen = new Set(shown.current ?? []);
    return (batch?.actionable_ids ?? []).filter((id) => frozen.has(id));
  }, [batch]);

  // The rows the approver is looking at: the frozen set, never a later arrival.
  const shownAllocations = useMemo(() => {
    const frozen = new Set(shown.current ?? []);
    return (batch?.allocations ?? []).filter((alloc) => frozen.has(alloc.id));
  }, [batch]);

  // The screen loads the cycle WITH the signed allocations so a finished cycle is not
  // an empty page — but that put 42 settled rows in front of an approver looking for
  // the 9 still open. Unsigned by default, the rest one click away.
  const [showSigned, setShowSigned] = useState(false);
  const signedCount = useMemo(
    () => shownAllocations.filter((a) => a.status === "APPROVED").length,
    [shownAllocations]);
  const visible = useMemo(
    () => (showSigned ? shownAllocations
                      : shownAllocations.filter((a) => a.status !== "APPROVED")),
    [shownAllocations, showSigned]);

  // Who signed what, for every allocation in the cycle — in ONE request. This used to
  // be one call per allocation, so a 900-allocation cycle fired 900 of them and took
  // minutes to paint. Without it a batch is signed blind: with the same person holding
  // two rungs, "has level 1 been done?" is the question to answer before signing 2.
  const histories = useQuery({
    queryKey: ["inventory", "allocation-histories", cycle, batch?.allocation_ids.length ?? 0],
    queryFn: () => getAllocationHistories(batch?.allocation_ids ?? []),
    enabled: !!batch?.allocation_ids.length,
  });
  const historyLoading = histories.isLoading;
  const historyRows = shownAllocations.map((alloc) => ({
    allocation_no: alloc.allocation_no,
    rows: histories.data?.[String(alloc.id)] ?? [],
  }));

  const act = useMutation({
    mutationFn: async ({ approve }: { approve: boolean }) => {
      // Only what this hat can actually sign, and only what was on screen when it
      // opened. Sending the rest produced "Switch to the approval position before
      // acting" for every one of them.
      const ids = signable;
      const merged: AllocBatchResult = { done_count: 0, done_ids: [], failed: [] };
      // Chunked: the backend walks one allocation at a time — engine-owned chains
      // cannot be short-cut — so a monthly cycle would sit on a single request long
      // past any gateway timeout.
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const part = approve
          ? await approveAllocationsBatch(slice)
          : await rejectAllocationsBatch(slice);
        merged.done_count += part.done_count;
        merged.done_ids.push(...part.done_ids);
        merged.failed.push(...part.failed);
        setProgress(merged.done_count + merged.failed.length);
      }
      return merged;
    },
    onSuccess: (data) => {
      setResult(data);
      // The frozen set has been acted on, so the next read is allowed to bring in
      // whatever arrived while it was being signed.
      shown.current = null;
      // Approving reserves stock, so the balances behind every inventory screen move.
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["allocation-approval-batches"] });
      qc.invalidateQueries({ queryKey: ["batch-demand"] });
      qc.invalidateQueries({ queryKey: ["fulfilment-batches"] });
    },
  });

  if (batches.isLoading) return <Card className="p-2"><LoadingRows rows={4} className="p-0" /></Card>;
  if (!batch) {
    return (
      <div>
        <PageHeader eyebrow="Inventory · Allocation Approvals" title="Cycle" />
        <Card className="p-6 text-sm text-muted">
          {result
            ? `${result.done_count} allocation${result.done_count === 1 ? "" : "s"} signed — nothing left in this cycle.`
            : "Nothing in this cycle is waiting for you."}
          <div className="mt-3">
            <Button variant="secondary" onClick={() => nav("/inventory/fulfilment?tab=approvals")}>
              Back to approvals
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Inventory · Allocation Approvals"
        title={`${batch.month_label} — ${batch.consolidation_no ?? "consolidated"}`}
        actions={
          <Button variant="ghost" onClick={() => nav("/inventory/fulfilment?tab=approvals")}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        }
      />

      <Card className="mb-4 p-4 text-sm">
        {/* Inner flex row: HeroUI's Card is a column flex container, so `flex-wrap`
            on the Card itself never won and the figures stacked vertically. */}
        <div className="flex flex-wrap items-start gap-x-10 gap-y-4">
          <div>
            {/* This screen loads the cycle WITH the signed ones (include_done), so this
                is every allocation ever raised in the cycle — the approvals list beside
                it loads pending only and prints a smaller number under the same word.
                Split here so the two can be reconciled instead of argued about. */}
            <div className="text-[11px] uppercase tracking-wide text-muted">Allocations</div>
            <div className="text-lg font-bold text-ink">{batch.allocation_count}</div>
            <div className="text-[11px] text-muted">
              {batch.pending_count ?? 0} pending · {batch.approved_count ?? 0} signed
            </div>
          </div>
          <div>
            {/* The consolidation's membership — the same number the Fulfilment Queue
                shows for this cycle. `allocated_indent_count` beside it is how many of
                those this inbox is holding allocations for, which is the figure this
                screen used to print as plain "Indents". */}
            <div className="text-[11px] uppercase tracking-wide text-muted">Indents</div>
            <div className="text-lg font-bold text-ink">{batch.indent_count}</div>
          </div>
          <div>
            {/* What THIS hat can actually sign — the same figure the approvals list
                row prints. It used to read `allocated_indent_count`, i.e. how many
                indents the cycle holds allocations for (43), under a label promising
                what was waiting for this approver (7). */}
            <div className="text-[11px] uppercase tracking-wide text-muted">Here to sign</div>
            <div className="text-lg font-bold text-ink">{batch.actionable_count}</div>
            <div className="text-[11px] text-muted">
              of {batch.allocated_indent_count ?? batch.indent_count} allocated
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted">Items</div>
            <div className="text-lg font-bold text-ink">{batch.item_count}</div>
          </div>
          {/* Per unit: quantities only add up within their own unit. */}
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted">To give</div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              {(batch.totals_by_uom ?? []).map((total) => (
                <span key={total.uom_code} className="text-lg font-bold text-brand">
                  {fmt(total.quantity)}
                  <span className="ml-1 text-xs font-medium text-muted">
                    {total.uom_code}
                  </span>
                </span>
              ))}
              {!batch.totals_by_uom?.length && (
                <span className="text-lg font-bold text-brand">{fmt(batch.total_qty)}</span>
              )}
            </div>
          </div>
        </div>
      </Card>

      {arrived > 0 && (
        <Card className="mb-4 flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
          <p className="text-warn">
            {arrived} new allocation{arrived === 1 ? "" : "s"} joined this cycle since
            you opened it. They are not in the list below and will not be signed.
          </p>
          <Button
            variant="secondary"
            onClick={() => { shown.current = null; void batches.refetch(); }}
          >
            Load them
          </Button>
        </Card>
      )}

      {result && (
        <Card className="mb-4 p-4 text-sm">
          <p className="font-semibold text-ok">
            {result.done_count} allocation{result.done_count === 1 ? "" : "s"} signed.
          </p>
          {result.failed.length > 0 && (
            <ul className="mt-2 space-y-1 text-bad">
              {result.failed.map((f, i) => (
                <li key={i}>{f.allocation_no ?? f.allocation_id}: {f.reason}</li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card className="mb-4 p-2">
        <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-2">
          <p className="text-sm text-muted">
            {visible.length} allocation{visible.length === 1 ? "" : "s"}
            {showSigned ? " in this cycle" : " still open"}
          </p>
          {signedCount > 0 && (
            <Button variant="ghost" onClick={() => setShowSigned((v) => !v)}>
              {showSigned ? "Hide signed" : `Show ${signedCount} signed`}
            </Button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="px-2 py-2 font-medium">Allocation</th>
                <th className="px-2 py-2 font-medium">Indent</th>
                <th className="px-2 py-2 font-medium">Raised by</th>
                <th className="px-2 py-2 font-medium">Item</th>
                <th className="px-2 py-2 font-medium">From</th>
                <th className="px-2 py-2 text-right font-medium">Qty</th>
                {/* Which of these the buttons below will actually act on. Without it
                    the table was 51 identical-looking rows over a bar that signed 7,
                    and nothing on screen said which 7. */}
                <th className="px-2 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.flatMap((alloc) =>
                alloc.lines.map((line, i) => (
                  <tr key={`${alloc.id}-${i}`} className="border-b border-line/60">
                    <td className="px-2 py-2 font-mono text-xs">
                      {i === 0 ? alloc.allocation_no : ""}
                    </td>
                    <td className="px-2 py-2 font-mono text-xs">
                      {i === 0 ? alloc.indent_no : ""}
                      {i === 0 && alloc.priority === "URGENT" && (
                        <Chip size="sm" color="danger" variant="flat" className="ml-2">
                          Urgent
                        </Chip>
                      )}
                    </td>
                    <td className="px-2 py-2">{i === 0 ? (alloc.requested_by_name ?? "—") : ""}</td>
                    <td className="px-2 py-2">{line.item_name ?? line.item_code ?? "—"}</td>
                    <td className="px-2 py-2 text-muted">{line.warehouse_name ?? "—"}</td>
                    <td className="px-2 py-2 text-right font-semibold">
                      {fmt(line.quantity)} {line.uom_code ?? ""}
                    </td>
                    <td className="px-2 py-2">
                      {i === 0 && (
                        alloc.status === "APPROVED"
                          ? <Chip size="sm" color="success" variant="flat">Signed</Chip>
                          : alloc.can_act
                            ? <Chip size="sm" color="primary" variant="flat">To sign</Chip>
                            // Pending on somebody else. Named, because "another rung"
                            // left the reader with nobody to chase.
                            : <Chip size="sm" variant="flat" className="max-w-[14rem]">
                                {alloc.pending_with?.length
                                  ? `With ${alloc.pending_with.join(", ")}`
                                  : "With another approver"}
                              </Chip>
                      )}
                    </td>
                  </tr>
                )))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="sticky bottom-2 flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="text-sm text-muted">
          {/* The count the buttons act on, not the size of the cycle. They disagreed —
              the bar promised "Approve all 20" while only the six this hat could sign
              were sent — which is how a signature looked like it had half worked. */}
          Signs {signable.length} of {visible.length} allocation
          {visible.length === 1 ? "" : "s"} shown — each on its own ladder,
          each with its own audit row. Approving reserves whatever stock was given
          and raises a material request for any line that came up short, which goes
          to procurement.
          {visible.length > signable.length && (
            <> The rest sit at a rung this position does not hold.</>
          )}
        </p>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            disabled={act.isPending || signable.length === 0}
            onClick={() => { setResult(null); setProgress(0); act.mutate({ approve: false }); }}
          >
            <X className="h-4 w-4" /> Reject {signable.length}
          </Button>
          {/* `signable` is the ladder's answer; this is the job profile's. Same
              permission as the single Approve and reserve — signing a cycle is the
              same decision taken in one go. */}
          <Can do="allocation.approve_reserve">
            <Button
              disabled={act.isPending || signable.length === 0}
              onClick={() => { setResult(null); setProgress(0); act.mutate({ approve: true }); }}
            >
              <Check className="h-4 w-4" />
              {act.isPending
                ? `Signing… ${progress}/${signable.length}`
                : `Approve ${signable.length}`}
            </Button>
          </Can>
        </div>
      </Card>

      <Card className="mt-4 p-4">
        <h3 className="mb-2 text-sm font-semibold text-ink">Approval history</h3>
        {historyLoading && <p className="text-sm text-muted">Loading history…</p>}
        <div className="divide-y divide-line rounded-xl border border-line">
          {historyRows.map((entry) => (
            <div key={entry.allocation_no} className="p-3">
              <p className="mono mb-1 text-xs font-semibold text-ink">
                {entry.allocation_no}
              </p>
              {entry.rows.length === 0 && (
                <p className="text-xs text-muted">
                  Nothing signed yet — this is the first step.
                </p>
              )}
              {entry.rows.map((row, i) => (
                <div key={`${row.stage_sequence}-${i}`}
                     className="flex flex-wrap items-center justify-between gap-2 py-1">
                  <div>
                    <span className="text-sm text-ink">{row.actor_name ?? "System"}</span>
                    <p className="text-xs text-muted">
                      {row.stage_name ?? `Step ${row.stage_sequence}`}
                      {" · "}
                      {/* The hat matters: the same person signs each rung under a
                          different position. */}
                      {row.actor_position ?? "Position unavailable"}
                      {row.acted_at ? ` · ${fmtDateTime(row.acted_at)}` : ""}
                    </p>
                  </div>
                  <StatusPill status={row.action} />
                </div>
              ))}
            </div>
          ))}
          {!historyLoading && historyRows.length === 0 && (
            <p className="p-3 text-sm text-muted">Nothing signed yet.</p>
          )}
        </div>
      </Card>
    </div>
  );
}
