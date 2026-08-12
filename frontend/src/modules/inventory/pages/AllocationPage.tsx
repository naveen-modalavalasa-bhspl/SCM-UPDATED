import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { Can, PageHeader, Button, Card, Field, Input, Select } from "@/shared/components";
import { createAllocation, getAllocationProposal } from "../api";
import { ClaimsPanel } from "../components/ClaimsPanel";
import { alerts } from "@/modules/alerts";
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

  /** Free stock at one warehouse for one line. No warehouse picked means nothing
   *  can be taken, so any quantity against it is over. */
  const shelfAt = (line: AllocationProposalLine, warehouseId: string) =>
    line.warehouses.find((w) => String(w.warehouse_id) === warehouseId)?.available_qty ?? 0;

  /**
   * The most this split may hold: what is left of the request, and never more than
   * the chosen warehouse actually has free.
   *
   * The box used to cap at the requested quantity alone, so 10 could be typed against
   * a warehouse holding 8. The screen said "more than that warehouse holds" in red and
   * then let the submit through to a backend that rejects it — a dead end with no way
   * out except guessing the right number.
   */
  const ceilingFor = (line: AllocationProposalLine, splits: Split[], index: number) => {
    const others = splits.reduce(
      (sum, sp, i) => (i === index ? sum : sum + Number(sp.qty || 0)), 0);
    return Math.max(0, Math.min(line.requested_qty - others, shelfAt(line, splits[index]?.wh ?? "")));
  };

  const clampQty = (line: AllocationProposalLine, splits: Split[], index: number, raw: string) => {
    if (raw === "") return "";
    const n = Number(raw);
    if (!Number.isFinite(n)) return "0";
    return String(Math.max(0, Math.min(n, ceilingFor(line, splits, index))));
  };

  /**
   * The points this row may still choose: every point holding the item, minus the
   * ones the OTHER rows on this line have already taken.
   *
   * A split exists to draw one line from SEVERAL points, so the same point twice is
   * never a real answer — and it read as one, because the new row offered the whole
   * list and the picked point sat right at the top of it. Two rows on one point also
   * quietly double-count against `ceilingFor`, which caps each row at that point's
   * free stock without knowing a sibling is drawing on the same shelf.
   *
   * The scoping is the backend's: `warehouses` is already narrowed to this login's
   * own stocking points and their subtree (`allocation_proposal`). This only removes
   * from that list — it can never add a point the caller was not offered.
   */
  const pointsFor = (line: AllocationProposalLine, splits: Split[], index: number) => {
    const taken = new Set(
      splits.filter((_, i) => i !== index).map((s) => s.wh).filter(Boolean));
    return line.warehouses.filter((w) => !taken.has(String(w.warehouse_id)));
  };

  /** Anything still promising stock that is not there. The backend refuses these, so
   *  the submit button has no business being live while one is on screen. */
  const overSplits = (data?.lines ?? []).filter((line: AllocationProposalLine) =>
    splitsOf(line.indent_item_id).some((s) => Number(s.qty || 0) > shelfAt(line, s.wh)));

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
    onSuccess: async () => {
      void alerts.success("allocation.saved");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["fulfillment-queue"] }),
        qc.invalidateQueries({ queryKey: ["allocations", "PENDING_APPROVAL"] }),
        // The screen this allocation is now waiting on. Neither key above matches
        // it, so Allocation Approvals opened on its cached list: the allocation just
        // raised was missing until the background refetch landed, which is the pause
        // and the "refresh before it appears" both.
        qc.invalidateQueries({ queryKey: ["inventory", "allocation-approvals"] }),
        qc.invalidateQueries({ queryKey: ["allocation-approval-batches"] }),
      ]);
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

      {/* Every fulfilment-queue row opens this screen, including the ones with no
          decision left in them. Saying so here — with a link to whatever is already
          promising the goods — beats four different destinations and a red error. */}
      {!data.allocatable && (
        <Card className="mb-4 p-4">
          <p className="text-sm font-semibold text-ink">{data.blocked_reason}</p>
          {data.allocations.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {data.allocations.map((allocation) => (
                <Button
                  key={allocation.id}
                  variant="subtle"
                  onClick={() => nav(`/inventory/allocation-approvals/${allocation.id}`)}
                >
                  {allocation.allocation_no} · {allocation.status.replace(/_/g, " ").toLowerCase()}
                </Button>
              ))}
            </div>
          )}
          <p className="mt-2 text-xs text-muted">
            The lines below are shown as they stand. Nothing here can be submitted.
          </p>
        </Card>
      )}

      <div className="space-y-4">
        {data.lines.map((line: AllocationProposalLine) => {
          const splits = splitsOf(line.indent_item_id);
          const giving = givenOn(line.indent_item_id);
          const short = Math.max(0, line.requested_qty - giving);
          // Only the part no warehouse can supply becomes procurement demand. Issuing
          // less than was asked for while stock is still on the shelf is a decision,
          // not a shortage, and announcing procurement for it sent buyers chasing
          // stock the branch already had.
          const unavailable = Math.max(0, short - Math.max(0, line.available_total - giving));
          const withheld = short - unavailable;
          const overWarehouse = splits.some((s) => Number(s.qty || 0) > shelfAt(line, s.wh));

          return (
            <Card key={line.indent_item_id} className="p-4">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="mono text-xs text-muted">{line.item_code}</span>
                  <h3 className="font-semibold text-ink">{line.item_name}</h3>
                </div>
                <div className="text-sm text-muted">
                  {/* Not "asked": the backend already subtracts what an approved or
                      pending allocation has promised, so this is what is STILL owed on
                      the line. A line fully covered by a pending allocation reads 0,
                      which is correct and only looked wrong under the old label. */}
                  still owed <span className="tabular font-semibold text-ink">{line.requested_qty}</span>{" "}
                  {/* `available_total` is free stock, not everything in the building.
                      Calling it "on hand" is what let an allocator promise units that
                      another indent had already reserved. */}
                  {line.uom_code} · available{" "}
                  <span className="tabular font-semibold text-ink">{line.available_total}</span>
                </div>
              </div>

              {/* The claim is the one number on this line an allocator cannot act on as
                  a total — it opens into who is holding what. Full width under the
                  header rather than inside it: the breakdown is a table, and the
                  header's right-hand column is a caption. */}
              {line.competing_demand > 0 && (
                <div className="mb-3">
                  <ClaimsPanel
                    itemId={line.item_id}
                    indentId={id}
                    demand={line.competing_demand}
                    uom={line.uom_code}
                  />
                </div>
              )}

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
                            // Moving to a smaller warehouse re-clamps what is already
                            // typed, so switching from a store holding 50 to one
                            // holding 8 cannot leave 50 sitting in the box.
                            onChange={(v) => {
                              const next = [...splits];
                              next[i] = { ...next[i], wh: v };
                              set(line.indent_item_id, i,
                                  { wh: v, qty: clampQty(line, next, i, next[i].qty) });
                            }}
                            placeholder="— none —"
                            options={pointsFor(line, splits, i).map((w) => ({
                              value: String(w.warehouse_id),
                              label: `${w.warehouse_name} (${w.available_qty} free)`,
                            }))}
                          />
                        </Field>
                        <Field label={i === 0 ? `Give (${line.uom_code ?? ""})` : ""}>
                          <Input
                            type="number"
                            min={0}
                            max={ceilingFor(line, splits, i)}
                            value={s.qty}
                            onChange={(e) => set(line.indent_item_id, i,
                                                 { qty: clampQty(line, splits, i, e.target.value) })}
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
                  {/* Off once every point holding this item is already on a row —
                      the row it would add could only ever be blank. */}
                  <Button
                    variant="subtle"
                    disabled={splits.filter((s) => s.wh).length >= line.warehouses.length}
                    onClick={() => addSplit(line.indent_item_id)}
                  >
                    <Plus size={14} /> Take some from another warehouse
                  </Button>
                </div>
              )}

              <p className="mt-2 text-sm text-muted">
                {giving > 0 ? `Reserving ${giving}. ` : "Giving nothing. "}
                {unavailable > 0 && (
                  <span className="text-warning">
                    {unavailable} {line.uom_code} goes to procurement as a material request.
                  </span>
                )}
                {withheld > 0 && (
                  <span className="text-muted">
                    {" "}{withheld} {line.uom_code} not issued — still in stock, so nothing
                    is sent to procurement.
                  </span>
                )}
                {overWarehouse && (
                  <span className="text-danger">
                    {" "}More than that warehouse holds — reduce it, or take the rest
                    from another warehouse.
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
        {overSplits.length > 0 && (
          <p className="text-sm text-danger">
            {overSplits.length === 1
              ? `${overSplits[0].item_name} is allocating more than its warehouse has free.`
              : `${overSplits.length} lines are allocating more than their warehouses have free.`}
            {" "}Nothing can be submitted until that is corrected.
          </p>
        )}
        <div className="flex gap-2">
          {/* Disabled, not just warned: the backend refuses an over-allocation, so
              leaving the button live only produced a 422 the allocator could do
              nothing with. Withheld entirely when there is no decision left to make. */}
          {/* Two gates, and they answer different questions. `allocatable` is the
              document's state — is there anything left to decide. `allocation.submit`
              is the job profile — is this person one of the people who decides. */}
          {data.allocatable && (
            <Can do="allocation.submit">
              <Button onClick={() => save.mutate()} disabled={save.isPending || overSplits.length > 0}>
                {save.isPending ? "Submitting…" : "Submit for approval"}
              </Button>
            </Can>
          )}
          <Button variant="subtle" onClick={() => nav("/inventory/fulfillment")}>
            {data.allocatable ? "Cancel" : "Back to the queue"}
          </Button>
        </div>
      </div>
    </>
  );
}
