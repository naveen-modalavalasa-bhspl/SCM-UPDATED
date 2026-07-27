import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader, Button, Card, Field, Input, Select } from "@/shared/components";
import { createAllocation, getAllocationProposal } from "../api";
import type { AllocationDecision, AllocationProposalLine } from "../types";

/**
 * Where a person decides how much stock an indent actually gets.
 *
 * The system shows what was asked for, what is on the shelf, which warehouses hold
 * it, and how much other indents are already waiting on. It does not choose. Sixty
 * bags of cement with four projects wanting it is a judgement, and this screen exists
 * so that judgement is made deliberately and recorded.
 */
export function AllocationPage() {
  const { indentId } = useParams();
  const id = Number(indentId);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [decisions, setDecisions] = useState<Record<number, { qty: string; wh: string }>>({});
  const [remarks, setRemarks] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["allocation-proposal", id],
    queryFn: () => getAllocationProposal(id),
    enabled: Number.isFinite(id),
  });

  // Pre-fill with the largest single warehouse, capped at what was requested. A
  // starting point, not a decision -- every box stays editable, including down to 0.
  useEffect(() => {
    if (!data) return;
    const seed: Record<number, { qty: string; wh: string }> = {};
    for (const line of data.lines) {
      const best = [...line.warehouses].sort((a, b) => b.available_qty - a.available_qty)[0];
      const suggested = Math.min(line.requested_qty, best?.available_qty ?? 0);
      seed[line.indent_item_id] = {
        qty: String(suggested),
        wh: best ? String(best.warehouse_id) : "",
      };
    }
    setDecisions(seed);
  }, [data]);

  const save = useMutation({
    mutationFn: () => {
      const payload: AllocationDecision[] = (data?.lines ?? []).map((line) => {
        const d = decisions[line.indent_item_id] ?? { qty: "0", wh: "" };
        return {
          indent_item_id: line.indent_item_id,
          item_id: line.item_id,
          item_code: line.item_code,
          item_name: line.item_name,
          uom_code: line.uom_code,
          requested_qty: line.requested_qty,
          quantity: Number(d.qty || 0),
          warehouse_id: d.wh ? Number(d.wh) : null,
        };
      });
      return createAllocation(id, payload, remarks || undefined);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fulfillment-queue"] });
      nav("/inventory/fulfillment");
    },
  });

  const set = (lineId: number, patch: Partial<{ qty: string; wh: string }>) =>
    setDecisions((prev) => ({
      ...prev,
      [lineId]: { ...(prev[lineId] ?? { qty: "0", wh: "" }), ...patch },
    }));

  if (isLoading) return <p className="p-6 text-muted">Loading…</p>;
  if (error) return <p className="p-6 text-danger">{(error as Error).message}</p>;
  if (!data) return null;

  return (
    <>
      <PageHeader eyebrow="Inventory" title={`Allocate ${data.indent_no}`} />

      <p className="mb-4 text-sm text-muted">
        {data.requested_by_name ?? "—"} · {data.department_name ?? "—"} · You decide how
        much to give and from where. Nothing is reserved until this is approved.
      </p>

      <div className="space-y-4">
        {data.lines.map((line: AllocationProposalLine) => {
          const d = decisions[line.indent_item_id] ?? { qty: "0", wh: "" };
          const giving = Number(d.qty || 0);
          const short = Math.max(0, line.requested_qty - giving);
          const chosen = line.warehouses.find((w) => String(w.warehouse_id) === d.wh);
          const overWarehouse = chosen ? giving > chosen.available_qty : giving > 0;

          return (
            <Card key={line.indent_item_id} className="p-4">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="mono text-xs text-muted">{line.item_code}</span>
                  <h3 className="font-semibold text-ink">{line.item_name}</h3>
                </div>
                <div className="text-sm text-muted">
                  asked <span className="tabular font-semibold text-ink">{line.requested_qty}</span>{" "}
                  {line.uom_code} · on hand{" "}
                  <span className="tabular font-semibold text-ink">{line.available_total}</span>
                  {line.competing_demand > 0 && (
                    <>
                      {" "}· <span className="text-warning">
                        {line.competing_demand} claimed by other indents
                      </span>
                    </>
                  )}
                </div>
              </div>

              {line.warehouses.length === 0 ? (
                <p className="text-sm text-danger">
                  Nothing on the shelf anywhere. Leave this at 0 and the whole line goes
                  to procurement.
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Select
                    label="From warehouse"
                    value={d.wh}
                    onChange={(v) => set(line.indent_item_id, { wh: v })}
                    placeholder="— none —"
                    options={line.warehouses.map((w) => ({
                      value: String(w.warehouse_id),
                      label: `${w.warehouse_name} (${w.available_qty} free)`,
                    }))}
                  />
                  <Field label={`Give (${line.uom_code ?? ""})`}>
                    <Input
                      type="number"
                      min={0}
                      value={d.qty}
                      onChange={(e) => set(line.indent_item_id, { qty: e.target.value })}
                    />
                  </Field>
                </div>
              )}

              <p className="mt-2 text-sm text-muted">
                {giving > 0 ? `Reserving ${giving}. ` : "Giving nothing. "}
                {short > 0 && (
                  <span className="text-warning">
                    {short} {line.uom_code} goes to procurement as a material request.
                  </span>
                )}
                {overWarehouse && (
                  <span className="text-danger">
                    {" "}More than that warehouse holds.
                  </span>
                )}
              </p>
            </Card>
          );
        })}
      </div>

      <div className="mt-4 space-y-3">
        <Field label="Why this split (optional)">
          <Input
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            placeholder="e.g. holding 20 for the Eluru site on Monday"
          />
        </Field>
        {save.error && <p className="text-danger">{(save.error as Error).message}</p>}
        <div className="flex gap-2">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Submitting…" : "Submit for approval"}
          </Button>
          <Button variant="ghost" onClick={() => nav("/inventory/fulfillment")}>
            Cancel
          </Button>
        </div>
      </div>
    </>
  );
}
