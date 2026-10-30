import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Repeat2, ShoppingCart, Trash2 } from "lucide-react";
import { Can, PageHeader, Button, Card, Field, Input, Select } from "@/shared/components";
import { createAllocation, createMaterialRequest, getAllocationProposal } from "../api";
// A LIP or an MDP is a distribution rung, never the default shelf — see
// warehouseTiers.ts.
import { isChainPoint, orderPoints } from "../warehouseTiers";
import { ClaimsPanel } from "../components/ClaimsPanel";
import { LoadingRows } from "../components/PageStates";
import { alerts } from "@/modules/alerts";
import type { AllocationDecision, AllocationProposalLine } from "../types";
import { TONE_SUBMIT } from "@/shared/components/tones";
import { TONE_MINT } from "@/shared/components/tones";
import {
  CombinationPicker, CombinationTag, combinationKey, combinationLabel, inStockOptions,
  type CombinationValue,
} from "@/shared/combination";

/** One "give this much, out of this warehouse" row. A line can carry several. An Any
 *  line also says which brand / variant / model the row gives (2026-10-23). */
type Split = { qty: string; wh: string; combo?: CombinationValue; reason?: string };

/** A line whose indent named its combination. The desk may still give ANOTHER brand
 *  in stock (2026-10-24) — recorded on the allocation as a brand change. */
const named = (line: AllocationProposalLine) => !!line.brand_id;

/** The combination the indent asked for, as a picker value. */
const askedFor = (line: AllocationProposalLine): CombinationValue | undefined => named(line) ? {
  brand_id: line.brand_id, variant_id: line.variant_id || null, model_id: line.model_id || null,
  brand_name: line.brand_name ?? null, variant_name: line.variant_name ?? null,
  model_name: line.model_name ?? null, combination_any: false,
} : undefined;

/** Does this row give another brand than the indent named? */
const isSubstitute = (line: AllocationProposalLine, combo?: CombinationValue) =>
  named(line) && !!(combo?.brand_id || combo?.no_brand)
  && combinationKey(combo) !== combinationKey(askedFor(line));

/** A pick that names something — a brand, or stock with no brand recorded. */
const picked = (combo?: CombinationValue) => !!(combo?.brand_id || combo?.no_brand);

/** Other brands of a named line, free at any point — "Other brands in stock". */
const otherBrandsFree = (line: AllocationProposalLine) => !named(line) ? 0
  : line.warehouses.flatMap((w) => w.combinations ?? [])
      .filter((c) => !c.no_brand && combinationKey(c) !== combinationKey(askedFor(line)))
      .reduce((sum, c) => sum + c.available_qty, 0);

/** Free stock with NO brand recorded, at any point (2026-10-24) — booked in before
 *  brands were, so it can serve any line, recorded as a brand change. */
const noBrandFree = (line: AllocationProposalLine) =>
  line.warehouses.flatMap((w) => w.combinations ?? [])
    .filter((c) => c.no_brand).reduce((sum, c) => sum + c.available_qty, 0);

/** What a point holds of each combination, as picker options with quantities. */
const combosAt = (line: AllocationProposalLine, wh: string) => inStockOptions(
  line.item_id,
  (line.warehouses.find((w) => String(w.warehouse_id) === wh)?.combinations ?? [])
    .map((c) => ({ ...c, qty: c.available_qty })));

/** Free stock of ONE combination at every point that holds it, most first — the
 *  answer to "if I give this brand, where can it come from?". */
const brandNetwork = (line: AllocationProposalLine, combo?: CombinationValue) => {
  if (!picked(combo)) return [];
  const key = combinationKey(combo);
  return orderPoints(line.warehouses)
    .map((w) => ({
      warehouse: w,
      qty: (w.combinations ?? []).filter((c) => combinationKey(c) === key)
        .reduce((sum, c) => sum + c.available_qty, 0),
    }))
    .filter((row) => row.qty > 0)
    .sort((a, b) => b.qty - a.qty);
};

/** The rung a point sits on, in the words the floor uses. */
const tierWord = (type?: string | null) => {
  const t = (type ?? "").toUpperCase();
  return t === "LIP" ? "LIP" : t === "MDP" ? "MDP" : "Warehouse";
};

const TIER_CHIP: Record<string, string> = {
  Warehouse: "bg-brand/10 text-brand",
  MDP: "bg-info-bg text-info",
  LIP: "bg-ok-bg text-ok",
};

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
  // Immediate receipt while the refreshed proposal loads procurement coverage.
  const [raised, setRaised] = useState<Record<number, string>>({});

  const { data, isLoading, error } = useQuery({
    queryKey: ["allocation-proposal", id],
    queryFn: () => getAllocationProposal(id),
    enabled: Number.isFinite(id),
  });

  // Pre-fill with the largest single warehouse, capped at what was requested. A
  // starting point, not a decision -- every box stays editable, including down to 0.
  //
  // FIXED 2026-08-22 — largest of the WAREHOUSE-tier points only. A LIP or an MDP is
  // where stock ends up, not a shelf an indent is filled from; seeding one meant the
  // screen opened proposing the one move the store almost never makes, on the strength
  // of five units parked at a distribution point. They stay in the dropdown, below the
  // warehouses and labelled — drawing on one is a decision somebody makes on purpose.
  useEffect(() => {
    if (!data) return;
    const seed: Record<number, Split[]> = {};
    for (const line of data.lines) {
      const best = [...line.warehouses]
        .filter((w) => !isChainPoint(w) && w.available_qty > 0)
        .sort((a, b) => b.available_qty - a.available_qty)[0];
      const wh = best ? String(best.warehouse_id) : "";
      // A named line opens on what the indent asked for; an Any line on the
      // combination the point holds most of.
      const top = named(line) ? askedFor(line) : combosAt(line, wh)[0];
      const suggested = Math.min(line.requested_qty,
                                 !named(line) && top ? (top as { stock_qty?: number }).stock_qty ?? 0
                                   : best?.available_qty ?? 0);
      seed[line.indent_item_id] = [{ qty: String(suggested), wh, combo: top }];
    }
    setDecisions(seed);
  }, [data]);

  const splitsOf = (lineId: number) => decisions[lineId] ?? [{ qty: "0", wh: "" }];
  const givenOn = (lineId: number) =>
    splitsOf(lineId).reduce((sum, s) => sum + Number(s.qty || 0), 0);

  /** Free stock at one warehouse for one line. No warehouse picked means nothing
   *  can be taken, so any quantity against it is over. */
  const shelfAt = (line: AllocationProposalLine, warehouseId: string,
                   combo?: CombinationValue) => {
    const point = line.warehouses.find((w) => String(w.warehouse_id) === warehouseId);
    if (picked(combo) && !(named(line) && !isSubstitute(line, combo))) {
      return combosAt(line, warehouseId)
        .find((o) => combinationKey(o) === combinationKey(combo))?.stock_qty ?? 0;
    }
    return point?.available_qty ?? 0;
  };

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
    return Math.max(0, Math.min(line.requested_qty - others,
                                shelfAt(line, splits[index]?.wh ?? "", splits[index]?.combo)));
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
    const others = splits.filter((s, i) => i !== index && s.wh);
    return line.warehouses.filter((w) => {
      const wh = String(w.warehouse_id);
      const combos = combosAt(line, wh);
      if (!combos.length) return !others.some((s) => s.wh === wh);
      const used = new Set(others.filter((s) => s.wh === wh && s.combo?.brand_id)
        .map((s) => combinationKey(s.combo)));
      return combos.some((o) => !used.has(combinationKey(o)));
    });
  };

  /** Every (point, combination) a line could still be served from — what "Take some
   *  from another warehouse" may add a row for. */
  const sourcesOf = (line: AllocationProposalLine) => line.warehouses.reduce(
    (sum, w) => sum + Math.max(1, combosAt(line, String(w.warehouse_id)).length), 0);

  /** Anything still promising stock that is not there. The backend refuses these, so
   *  the submit button has no business being live while one is on screen. */
  const overSplits = (data?.lines ?? []).filter((line: AllocationProposalLine) =>
    splitsOf(line.indent_item_id).some((s) => Number(s.qty || 0) > shelfAt(line, s.wh, s.combo)));

  // Raising is per LINE, so one line's request cannot fail the whole screen and the
  // mutation carries the line it was fired for.
  const raise = useMutation({
    mutationFn: ({ line, quantity }: { line: AllocationProposalLine; quantity: number }) =>
      createMaterialRequest({
        indent_id: id,
        indent_no: data?.indent_no,
        items: [{
          item_id: line.item_id,
          quantity,
          indent_item_id: line.indent_item_id,
          // The INDENT's project, off the proposal. Without it the backend can only
          // fall back to the login's own project, and the request was being filed
          // against whichever project the storekeeper's post sits in rather than the
          // one the indent is serving — which then feeds the document number and the
          // requisition raised behind it. See create_mr_manual.
          project_id: line.project_id,
        }],
      }),
    onSuccess: (mr, { line }) => {
      setRaised((prev) => ({ ...prev, [line.indent_item_id]: mr.mr_no }));
      void alerts.success("material_request.raised", { number: mr.mr_no });
      void qc.invalidateQueries({ queryKey: ["material-requests"] });
      void qc.invalidateQueries({ queryKey: ["allocation-proposal", id] });
    },
  });

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
          // An Any line's pick settles it; a named line sends a pick only when it is
          // ANOTHER brand, with why — the server records the change (2026-10-24).
          ...((!named(line) || isSubstitute(line, s.combo)) && picked(s.combo) ? {
            brand_id: s.combo?.brand_id || null, variant_id: s.combo?.variant_id ?? null,
            model_id: s.combo?.model_id ?? null, no_brand: !s.combo?.brand_id,
          } : {}),
          ...(isSubstitute(line, s.combo) && s.reason?.trim()
            ? { substitution_reason: s.reason.trim() } : {}),
        })),
      );
      return createAllocation(id, payload, remarks || undefined);
    },
    onSuccess: async () => {
      void alerts.success("allocation.saved");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["fulfillment-queue"] }),
        qc.invalidateQueries({ queryKey: ["allocation-proposal", id] }),
        qc.invalidateQueries({ queryKey: ["allocations", "PENDING_APPROVAL"] }),
        // The screen this allocation is now waiting on. Neither key above matches
        // it, so Allocation Approvals opened on its cached list: the allocation just
        // raised was missing until the background refetch landed, which is the pause
        // and the "refresh before it appears" both.
        qc.invalidateQueries({ queryKey: ["inventory", "allocation-approvals"] }),
        qc.invalidateQueries({ queryKey: ["allocation-approval-batches"] }),
      ]);
      nav("/inventory/fulfilment");
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

  if (isLoading) return <LoadingRows rows={6} className="mt-2" />;
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
      {data.allocatable && data.allocations.length > 0 && (
        <Card className="mb-4 p-3 bg-content2/40 border-line/70">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold text-muted">
              Previous allocation rounds for this indent:
            </span>
            <div className="flex flex-wrap gap-2">
              {data.allocations.map((allocation) => (
                <Button
                  key={allocation.id}
                  variant="subtle"
                  className="h-8 text-xs px-2.5"
                  onClick={() => nav(`/inventory/allocation-approvals/${allocation.id}`)}
                >
                  {allocation.allocation_no} · {allocation.status.replace(/_/g, " ").toLowerCase()}
                </Button>
              ))}
            </div>
          </div>
        </Card>
      )}

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

      <fieldset disabled={!data.allocatable || save.isPending || raise.isPending} className="space-y-4">
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
          const overWarehouse = splits.some((s) => Number(s.qty || 0) > shelfAt(line, s.wh, s.combo));

          return (
            <Card key={line.indent_item_id} className="p-4">
              {(line.on_order_qty ?? 0) > 0 && <p className="mb-3 text-sm text-warning">
                {line.on_order_qty} {line.uom_code} already covered by procurement.
              </p>}
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="mono text-xs text-muted">{line.item_code}</span>
                  <h3 className="font-semibold text-ink">{line.item_name}</h3>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <CombinationTag value={line} />
                    {otherBrandsFree(line) > 0 && (
                      <span className="rounded-full bg-info-bg px-2 py-0.5 text-[11px] font-semibold text-info">
                        Other brands in stock · {otherBrandsFree(line)} {line.uom_code}
                      </span>
                    )}
                    {noBrandFree(line) > 0 && (
                      <span className="rounded-full bg-content2 px-2 py-0.5 text-[11px] font-semibold text-ink-700 ring-1 ring-line"
                            title="Stock booked in before brands were recorded. Pick it as “No brand”.">
                        No brand recorded · {noBrandFree(line)} {line.uom_code}
                      </span>
                    )}
                  </div>
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
                    <div key={i} className="space-y-2">
                    <div className="flex items-end gap-2">
                      {/* Both controls sit in a <Field> so their labels share a
                          baseline — Select's own label floats inside the box and
                          would sit a row below the Input's. */}
                      <div className={`grid flex-1 items-start gap-x-4 gap-y-3 ${
                        line.warehouses.some((w) => combosAt(line, String(w.warehouse_id)).length)
                          ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
                        <Field label={i === 0 ? "From warehouse" : ""}>
                          <Select
                            ariaLabel="From warehouse"
                            value={s.wh}
                            // Moving to a smaller warehouse re-clamps what is already
                            // typed, so switching from a store holding 50 to one
                            // holding 8 cannot leave 50 sitting in the box.
                            onChange={(v) => {
                              const next = [...splits];
                              // A new point starts on the combination it holds most of.
                              const combo = named(line) ? askedFor(line) : combosAt(line, v)[0];
                              next[i] = { ...next[i], wh: v, combo };
                              set(line.indent_item_id, i,
                                  { wh: v, combo, qty: clampQty(line, next, i, next[i].qty) });
                            }}
                            placeholder="— none —"
                            // Warehouses first, then the distribution points, each
                            // saying what it is — see `isChainPoint`.
                            // With a brand chosen, each point also says how much of
                            // THAT brand it holds — the total alone hides that the
                            // biggest store may have none of it.
                            options={orderPoints(pointsFor(line, splits, i)).map((w) => {
                              const ofBrand = picked(s.combo)
                                ? brandNetwork(line, s.combo)
                                    .find((r) => r.warehouse.warehouse_id === w.warehouse_id)?.qty ?? 0
                                : null;
                              return {
                                value: String(w.warehouse_id),
                                label: `${w.warehouse_name} (`
                                  + (ofBrand !== null
                                    ? `${ofBrand} of ${combinationLabel(s.combo)} · ` : "")
                                  + `${w.available_qty} free)`
                                  + (isChainPoint(w) ? " · distribution point" : ""),
                              };
                            })}
                          />
                        </Field>
                        {line.warehouses.some((w) => combosAt(line, String(w.warehouse_id)).length) && (
                          <Field label={i === 0 ? "Brand · variant · model" : ""}>
                            <CombinationPicker
                              options={combosAt(line, s.wh)}
                              value={s.combo}
                              uom={line.uom_code}
                              ariaLabel="Brand, variant and model"
                              onChange={(combo) => {
                                const next = [...splits];
                                next[i] = { ...next[i], combo };
                                set(line.indent_item_id, i,
                                    { combo, qty: clampQty(line, next, i, next[i].qty) });
                              }}
                            />
                          </Field>
                        )}
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
                    {picked(s.combo) && brandNetwork(line, s.combo).length > 0 && (
                      <div className="rounded-lg border border-line bg-content2/60 px-3 py-2">
                        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
                          {combinationLabel(s.combo)} free across the network ·{" "}
                          <span className="tabular text-ink">
                            {brandNetwork(line, s.combo).reduce((sum, r) => sum + r.qty, 0)}
                          </span>{" "}{line.uom_code}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {brandNetwork(line, s.combo).map(({ warehouse: w, qty }) => {
                            const here = String(w.warehouse_id) === s.wh;
                            const tier = tierWord(w.warehouse_type);
                            const taken = !here && splits.some((o, j) => j !== i
                              && o.wh === String(w.warehouse_id)
                              && combinationKey(o.combo) === combinationKey(s.combo));
                            return (
                              <button
                                key={w.warehouse_id}
                                type="button"
                                disabled={here || taken}
                                title={here ? "This row draws from here"
                                  : taken ? "Another row already draws this brand from here"
                                  : `Take ${combinationLabel(s.combo)} from ${w.warehouse_name}`}
                                onClick={() => {
                                  const next = [...splits];
                                  next[i] = { ...next[i], wh: String(w.warehouse_id) };
                                  set(line.indent_item_id, i, {
                                    wh: String(w.warehouse_id),
                                    qty: clampQty(line, next, i, next[i].qty),
                                  });
                                }}
                                className={`inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition ${
                                  here ? "border-brand bg-brand/10 font-semibold text-brand"
                                    : "border-line bg-content1 text-ink-700 hover:border-brand/60 hover:text-brand disabled:opacity-50"}`}
                              >
                                <span className={`rounded px-1 py-px text-[10px] font-bold uppercase ${TIER_CHIP[tier]}`}>
                                  {tier}
                                </span>
                                <span className="max-w-[12rem] truncate">{w.warehouse_name}</span>
                                <span className="tabular font-semibold">{qty}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {isSubstitute(line, s.combo) && (
                      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2">
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-warning">
                          <Repeat2 size={14} aria-hidden />
                          Brand changed from {combinationLabel(askedFor(line))} to {combinationLabel(s.combo)}
                        </span>
                        <input
                          value={s.reason ?? ""}
                          maxLength={300}
                          onChange={(e) => set(line.indent_item_id, i, { reason: e.target.value })}
                          placeholder="Reason (optional)"
                          aria-label="Reason for the brand change"
                          className="h-9 min-w-[12rem] flex-1 rounded-lg border border-line bg-content1 px-3 text-sm outline-none focus:border-brand"
                        />
                      </div>
                    )}
                    </div>
                  ))}
                  {/* Off once every point holding this item is already on a row —
                      the row it would add could only ever be blank. */}
                  <Button
                    variant="subtle"
                    disabled={splits.filter((s) => s.wh).length >= sourcesOf(line)}
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

              {/* The warehouse holds none of this, whatever the LIP and MDP points are
                  showing. The automatic shortfall never fires here — it reads
                  `available_total`, which counts chain stock — so procurement would
                  never hear about the line unless somebody says so. Drawing from a
                  distribution point is still allowed and still on the screen above;
                  this is the other answer, made available rather than assumed. */}
              {data.allocatable && !(line.on_order_qty ?? 0) && line.main_available_qty === 0 && short > 0 && (
                <Can do="mr.create">
                  <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2">
                    <span className="text-sm text-muted">
                      No warehouse stock
                      {line.available_total > 0
                        ? " — what is showing sits at LIP/MDP points."
                        : "."}
                    </span>
                    {raised[line.indent_item_id] ? (
                      <span className="mono text-sm font-semibold text-ink">
                        Requested on {raised[line.indent_item_id]}
                      </span>
                    ) : (
                      <Button className={TONE_MINT}
                        variant="secondary"
                        disabled={raise.isPending}
                        onClick={() => raise.mutate({ line, quantity: short })}
                      >
                        <ShoppingCart size={14} /> Raise MR for {short} {line.uom_code}
                      </Button>
                    )}
                  </div>
                </Can>
              )}
            </Card>
          );
        })}
      </fieldset>

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
              <Button className={TONE_SUBMIT} onClick={() => save.mutate()} disabled={save.isPending || overSplits.length > 0}>
                {save.isPending ? "Submitting…" : "Submit for approval"}
              </Button>
            </Can>
          )}
          <Button variant="subtle" onClick={() => nav("/inventory/fulfilment")}>
            {data.allocatable ? "Cancel" : "Back to the queue"}
          </Button>
        </div>
      </div>
    </>
  );
}
