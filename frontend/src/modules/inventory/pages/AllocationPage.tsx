import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { PageHeader, Button, Card, Field, Input, Select } from "@/shared/components";
import { createAllocation, getAllocationProposal } from "../api";
import type { AllocationDecision, AllocationProposalLine } from "../types";

/** One "give this much, out of this warehouse" row. A line can carry several. */
type Split = { qty: string; wh: string };

/**
 * Where a person decides how much stock an indent actually gets.
 *
 * The system shows what was asked for, what is on the shelf, which warehouses hold
 * it, and how much other indents are already waiting on. It does not choose. Sixty
 * bags of cement with four projects wanting it is a judgement, and this screen exists
 * so that judgement is made deliberately and recorded.
 *
 * A line can be split across warehouses (a main store, an LIP, an MDP) — the backend
 * has always accepted one decision row per (line, warehouse); this screen now lets a
 * person write them.
 */
export function AllocationPage() {
  const { indentId } = useParams();
  const id = Number(indentId);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [decisions, setDecisions] = useState<Record<number, Split[]>>({});
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
    const seed: Record<number, Split[]> = {};
    for (const line of data.lines) {
      const best = [...line.warehouses].sort((a, b) => b.available_qty - a.available_qty)[0];
      const suggested = Math.min(line.requested_qty, best?.available_qty ?? 0);
      seed[line.indent_item_id] = [{
        qty: String(suggested),
        wh: best ? String(best.warehouse_id) : "",
      }];
    }
    setDecisions(seed);
  }, [data]);

  const splitsOf = (lineId: number) => decisions[lineId] ?? [{ qty: "0", wh: "" }];
  const givenOn = (lineId: number) =>
    splitsOf(lineId).reduce((sum, s) => sum + Number(s.qty || 0), 0);

  const save = useMutation({
    mutationFn: () => {
      // One decision row per split. A line with nothing given still sends a single
      // zero row, because "give nothing" is a decision the backend has to record.
      const payload: AllocationDecision[] = (data?.lines ?? []).flatMap((line) =>
        splitsOf(line.indent_item_id).map((s, i) => ({
          indent_item_id: line.indent_item_id,
          item_id: line.item_id,
          item_code: line.item_code,
          item_name: line.item_name,
          uom_code: line.uom_code,
          // The requested quantity belongs to the line, not to each split — only the
          // first row carries it, or the shortfall would be counted once per split.
          requested_qty: i === 0 ? line.requested_qty : 0,
          quantity: Number(s.qty || 0),
          warehouse_id: s.wh ? Number(s.wh) : null,
        })),
      );
      return createAllocation(id, payload, remarks || undefined);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fulfillment-queue"] });
      nav("/inventory/fulfillment");
    },
  });

  const set = (lineId: number, index: number, patch: Partial<Split>) =>
    setDecisions((prev) => {
      const rows = [...(prev[lineId] ?? [{ qty: "0", wh: "" }])];
      rows[index] = { ...rows[index], ...patch };
      return { ...prev, [lineId]: rows };
    });

  const addSplit = (lineId: number) =>
    setDecisions((prev) => ({
      ...prev,
      [lineId]: [...(prev[lineId] ?? []), { qty: "0", wh: "" }],
    }));

  const removeSplit = (lineId: number, index: number) =>
    setDecisions((prev) => {
      const rows = (prev[lineId] ?? []).filter((_, i) => i !== index);
      return { ...prev, [lineId]: rows.length ? rows : [{ qty: "0", wh: "" }] };
    });

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
          const splits = splitsOf(line.indent_item_id);
          const giving = givenOn(line.indent_item_id);
          const short = Math.max(0, line.requested_qty - giving);
          const overWarehouse = splits.some((s) => {
            const chosen = line.warehouses.find((w) => String(w.warehouse_id) === s.wh);
            return chosen ? Number(s.qty || 0) > chosen.available_qty : Number(s.qty || 0) > 0;
          });

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
                <div className="space-y-2">
                  {splits.map((s, i) => (
                    <div key={i} className="flex items-end gap-2">
                      {/* Both controls sit in a <Field> so their labels share a
                          baseline — Select's own label floats inside the box and
                          would sit a row below the Input's. */}
                      <div className="grid flex-1 items-start gap-x-4 gap-y-3 sm:grid-cols-2">
                        <Field label={i === 0 ? "From warehouse" : ""}>
                          <Select
                            ariaLabel="From warehouse"
                            value={s.wh}
                            onChange={(v) => set(line.indent_item_id, i, { wh: v })}
                            placeholder="— none —"
                            options={line.warehouses.map((w) => ({
                              value: String(w.warehouse_id),
                              label: `${w.warehouse_name} (${w.available_qty} free)`,
                            }))}
                          />
                        </Field>
                        <Field label={i === 0 ? `Give (${line.uom_code ?? ""})` : ""}>
                          <Input
                            type="number"
                            min={0}
                            value={s.qty}
                            onChange={(e) => set(line.indent_item_id, i, { qty: e.target.value })}
                          />
                        </Field>
                      </div>
                      {splits.length > 1 && (
                        <Button
                          variant="ghost"
                          aria-label="Remove this warehouse"
                          onClick={() => removeSplit(line.indent_item_id, i)}
                        >
                          <Trash2 size={14} />
                        </Button>
                      )}
                    </div>
                  ))}
                  <Button variant="ghost" onClick={() => addSplit(line.indent_item_id)}>
                    <Plus size={14} /> Take some from another warehouse
                  </Button>
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
