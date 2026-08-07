import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, XCircle } from "lucide-react";
import { Button, Card, Field, Input, PageHeader, StatusPill } from "@/shared/components";
import {
  approveAllocation, getAllocation, getAllocationHistory, rejectAllocation,
} from "../api";
import { alerts } from "@/modules/alerts";

const fmt = (value: number) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);

/**
 * Full-screen review, not a popup: the popup card hid the approval history and the
 * line table behind a modal scroll region, and there was no URL a reviewer could
 * bookmark or come back to mid-decision. This is the same content, routed at
 * /inventory/allocation-approvals/:id so it is a real page.
 *
 * Give quantities are read-only here on purpose. Approving reserves exactly what
 * inventory decided to give; changing that number at approval time is a decision
 * for the indents module (it owns /api/allocations/{id}/approve and the workflow
 * that follows it), not something this module's screen can commit to.
 */
export function AllocationApprovalDetailPage() {
  const { id } = useParams();
  const allocationId = Number(id);
  const [searchParams] = useSearchParams();
  const decisionView = searchParams.get("decision") === "1";
  const nav = useNavigate();
  const qc = useQueryClient();
  const [comments, setComments] = useState("");
  const [error, setError] = useState<string | null>(null);

  const allocation = useQuery({
    queryKey: ["inventory", "allocation-decision", allocationId],
    queryFn: () => getAllocation(allocationId),
    enabled: Number.isFinite(allocationId) && allocationId > 0,
  });

  const history = useQuery({
    queryKey: ["inventory", "allocation-history", allocationId],
    queryFn: () => getAllocationHistory(allocationId),
    enabled: Number.isFinite(allocationId) && allocationId > 0,
  });

  const goBack = () => nav(decisionView ? "/approvals/decisions" : "/inventory/allocation-approvals");

  const act = useMutation({
    mutationFn: ({ approve }: { approve: boolean }) =>
      approve ? approveAllocation(allocationId, comments) : rejectAllocation(allocationId, comments),
    onSuccess: (_result, { approve }) => {
      void alerts.success(approve ? "allocation.approved" : "allocation.rejected");
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["fulfillment-queue"] });
      goBack();
    },
    onError: (err: Error) => setError(err.message),
  });

  const a = allocation.data;

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title={a ? `Review ${a.allocation_no}` : "Review allocation"}
        actions={
          <Button variant="subtle" onClick={goBack}>
            <ArrowLeft size={14} /> Back
          </Button>
        }
      />

      {allocation.isLoading ? (
        <p className="p-6 text-sm text-muted">Loading allocation…</p>
      ) : allocation.error || !a ? (
        <div className="rounded-lg bg-bad-bg p-4 text-sm text-bad">
          {(allocation.error as Error)?.message ?? "Allocation not found"}
        </div>
      ) : (
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-bad-bg p-3 text-sm text-bad">{error}</div>}

          <Card className="p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm">
                <div><strong>Indent:</strong> {a.indent_no}</div>
                <div><strong>Decided by:</strong> {a.allocated_by_name ?? "—"}</div>
                {a.remarks && <div><strong>Reason:</strong> {a.remarks}</div>}
              </div>
              <StatusPill status={a.status} />
            </div>
          </Card>

          <Card className="overflow-x-auto p-0">
            <table className="w-full text-left text-sm">
              <thead className="bg-content2 text-xs text-muted">
                <tr>
                  <th className="p-3">Item</th>
                  <th className="p-3">Requested</th>
                  <th className="p-3">Give</th>
                  <th className="p-3">Warehouse</th>
                  <th className="p-3">Shortage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {a.items.map((item) => (
                  <tr key={item.id}>
                    <td className="p-3">
                      <div className="font-medium text-ink">{item.item_name}</div>
                      <div className="text-xs text-muted">{item.item_code}</div>
                    </td>
                    <td className="p-3">{fmt(item.requested_qty)} {item.uom_code}</td>
                    <td className="p-3 font-semibold text-ok">
                      {fmt(item.quantity)} {item.uom_code}
                    </td>
                    <td className="p-3">{item.warehouse_name ?? "Not allocated"}</td>
                    <td className="p-3 text-warn">
                      {fmt(Math.max(0, item.requested_qty - item.quantity))} {item.uom_code}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card className="p-4">
            <h3 className="mb-2 text-sm font-semibold text-ink">Approval history</h3>
            <div className="divide-y divide-line rounded-xl border border-line">
              {history.isLoading && (
                <p className="p-3 text-sm text-muted">Loading history…</p>
              )}
              {(history.data ?? []).map((row, index) => (
                <div key={`${row.stage_sequence}-${index}`} className="p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <strong className="text-ink">{row.actor_name ?? "System"}</strong>
                      <p className="text-xs text-muted">
                        {row.stage_name ?? `Step ${row.stage_sequence}`}
                        {" · "}
                        {/* The hat matters: the same person signs each step under a
                            different position. */}
                        {row.actor_position ?? "Position unavailable"}
                      </p>
                    </div>
                    <StatusPill status={row.action} />
                  </div>
                  {row.comments && <p className="mt-1 text-sm text-body">{row.comments}</p>}
                  <p className="mt-1 text-xs text-muted">
                    {row.acted_at ? new Date(row.acted_at).toLocaleString() : "—"}
                  </p>
                </div>
              ))}
              {!history.isLoading && !(history.data ?? []).length && (
                <p className="p-3 text-sm text-muted">Nothing signed yet — this is the first step.</p>
              )}
            </div>
          </Card>

          {!decisionView && (
            <Card className="p-4">
              <Field label="Comments">
                <Input
                  value={comments}
                  onChange={(event) => setComments(event.target.value)}
                  placeholder="Optional reason or instruction"
                />
              </Field>
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <Button variant="subtle" onClick={goBack}>Cancel</Button>
                <Button variant="danger" disabled={act.isPending} onClick={() => act.mutate({ approve: false })}>
                  <XCircle className="h-4 w-4" /> Reject
                </Button>
                <Button disabled={act.isPending} onClick={() => act.mutate({ approve: true })}>
                  <CheckCircle2 className="h-4 w-4" /> Approve and reserve
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
