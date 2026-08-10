import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import { ArrowLeft, Check, X } from "lucide-react";
import { Button, Card, PageHeader, StatusPill } from "@/shared/components";
import { fmtDateTime } from "@/shared/datetime";
import {
  approveAllocationsBatch, getAllocationApprovalBatches, getAllocationHistory,
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
  });
  const batch = (batches.data?.items ?? []).find((b) => b.cycle === cycle);
  // Signed everything this position can sign: the rows are still pending, but at a
  // rung this hat does not hold. The buttons go dead rather than erroring on click.
  const canSign = batch?.actionable_count ?? 0;

  // Who signed what, for every allocation in the cycle. The single-allocation screen
  // has always shown this; without it here, a batch was signed blind — and with the
  // same person holding two rungs, "has level 1 been done?" is exactly the question
  // the approver needs answered before signing level 2.
  const histories = useQueries({
    queries: (batch?.allocation_ids ?? []).map((id) => ({
      queryKey: ["inventory", "allocation-history", id],
      queryFn: () => getAllocationHistory(id),
    })),
  });
  const historyLoading = histories.some((q) => q.isLoading);
  const historyRows = (batch?.allocations ?? []).map((alloc, index) => ({
    allocation_no: alloc.allocation_no,
    rows: histories[index]?.data ?? [],
  }));

  const act = useMutation({
    mutationFn: async ({ approve }: { approve: boolean }) => {
      // Only what this hat can actually sign. Sending the rest produced "Switch to
      // the approval position before acting" for every one of them.
      const ids = batch?.actionable_ids ?? [];
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
      // Approving reserves stock, so the balances behind every inventory screen move.
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["allocation-approval-batches"] });
      qc.invalidateQueries({ queryKey: ["batch-demand"] });
      qc.invalidateQueries({ queryKey: ["fulfilment-batches"] });
    },
  });

  if (batches.isLoading) return <Card className="p-6 text-sm text-muted">Loading…</Card>;
  if (!batch) {
    return (
      <div>
        <PageHeader eyebrow="Inventory · Allocation Approvals" title="Cycle" />
        <Card className="p-6 text-sm text-muted">
          {result
            ? `${result.done_count} allocation${result.done_count === 1 ? "" : "s"} signed — nothing left in this cycle.`
            : "Nothing in this cycle is waiting for you."}
          <div className="mt-3">
            <Button variant="secondary" onClick={() => nav("/inventory/allocation-approvals")}>
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
        title={`${batch.month_label} — consolidated`}
        actions={
          <Button variant="ghost" onClick={() => nav("/inventory/allocation-approvals")}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        }
      />

      <Card className="mb-4 flex flex-wrap gap-6 p-4 text-sm">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">Allocations</div>
          <div className="text-lg font-bold text-ink">{batch.allocation_count}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">Indents</div>
          <div className="text-lg font-bold text-ink">{batch.indent_count}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">Items</div>
          <div className="text-lg font-bold text-ink">{batch.item_count}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">To give</div>
          <div className="text-lg font-bold text-brand">{fmt(batch.total_qty)}</div>
        </div>
      </Card>

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
              </tr>
            </thead>
            <tbody>
              {batch.allocations.flatMap((alloc) =>
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
                  </tr>
                )))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="sticky bottom-2 flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="text-sm text-muted">
          Signs {canSign || batch.allocation_count} allocation
          {(canSign || batch.allocation_count) === 1 ? "" : "s"} — each on its own
          ladder, each with its own audit row. Approving reserves the stock.
        </p>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            disabled={act.isPending || canSign === 0}
            onClick={() => { setResult(null); setProgress(0); act.mutate({ approve: false }); }}
          >
            <X className="h-4 w-4" /> Reject all
          </Button>
          <Button
            disabled={act.isPending || canSign === 0}
            onClick={() => { setResult(null); setProgress(0); act.mutate({ approve: true }); }}
          >
            <Check className="h-4 w-4" />
            {act.isPending
              ? `Signing… ${progress}/${batch.allocation_count}`
              : `Approve all ${canSign || batch.allocation_count}`}
          </Button>
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
