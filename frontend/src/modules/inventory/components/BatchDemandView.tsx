import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import { AlertTriangle, ChevronDown, ChevronRight, Plus, Send, Trash2 } from "lucide-react";
import { Button, Can, Card, Input } from "@/shared/components";
import { LoadingRows } from "./PageStates";
import { splitQuantity } from "@/shared/quantity";
import { createAllocationsBatch, getBatchDemand } from "../api";
// FIXED 2026-08-22 — a LIP is where stock ends up, not a shelf an indent is filled
// from. See warehouseTiers.ts for why both allocation screens needed this.
import { isChainPoint, orderPoints } from "../warehouseTiers";
import type {
  AllocationDecision, BatchDemandItem, BatchDemandLine,
} from "../types";

/**
 * The fulfilment queue turned on its side: one row per ITEM, not per indent.
 *
 * Nine hundred lab technicians raise nine hundred monthly indents. Deciding them one
 * at a time hides the only number that matters — that between them they want 4,000
 * gloves and the shelf holds 2,500. This groups the same rows the queue already shows,
 * so the storekeeper answers once per item instead of opening 900 screens.
 *
 * The split is a PROPOSAL, never a verdict: every line is editable, so the allocator
 * can overrule urgent-first when he knows better. Submitting still writes ONE
 * ALLOCATION PER INDENT through the same endpoint the single-indent screen posts to —
 * the batch is a faster way to fill the form in, not a different kind of document.
 */

/** How one item is being served: out of which shelves, and any hand-set shares. */
interface ItemPlan {
  /** One rung per source warehouse, exactly like the single-indent allocation screen.
   *  Splitting across points is normal — no single store holds a month of demand. */
  splits: { wh: string; qty: string }[];
  /** Lines the allocator typed over, as raw strings so a half-typed "1" on the way to
   *  "12" is not clamped out from under the cursor. */
  edited: Record<number, string>;
  /** Send what no shelf can cover to procurement.
   *
   *  The single-indent screen has never needed a flag: it posts a ZERO row for a line
   *  it is giving nothing to, and the backend turns the unservable part of it into a
   *  material request. This screen skipped those lines entirely, so a monthly cycle's
   *  out-of-stock demand was silently dropped — the indent was never even submitted.
   *
   *  A flag rather than always-on because one press here decides a whole cycle: an
   *  item nobody has looked at yet must not commit nine hundred indents to a purchase.
   *  Defaulted ON only when the shelves hold NOTHING, where procurement is the only
   *  possible answer and there is no quantity to type. */
  procure: boolean;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, ""));

/** Mirror of `split_demand` in backend/app/modules/indents/service.py.
 *
 *  Urgent-first is the right opening bid — it is what the rule says when nobody has
 *  looked — but the allocator is the one who knows that an urgent request for 90
 *  should not swallow the whole shelf while ten other points get nothing.
 *
 *  `fixed` holds the lines already typed over. They are honoured exactly and the
 *  remainder is shared among the rest, so editing one row never silently rewrites a
 *  row that was already settled. */
function splitPreview(
  lines: BatchDemandLine[],
  giving: number,
  fixed: Map<number, number> = new Map(),
  decimals = 3,
): Map<number, number> {
  const out = new Map<number, number>(lines.map((l) => [l.indent_item_id, 0]));
  const open = lines.filter((l) => !fixed.has(l.indent_item_id));
  // The unit's step. Pro-rata used to round every share to 3 dp whatever the unit was,
  // so 20 gloves across lines asking 10 and 7 proposed 5.7 gloves — a quantity nobody
  // can pick off a shelf. `decimals` is 0 for anything counted in whole numbers.
  const step = (value: number) => Math.floor(value * 10 ** decimals) / 10 ** decimals;

  let left = Math.max(0, giving);
  for (const [lineId, qty] of fixed) {
    out.set(lineId, qty);
    left -= qty;
  }
  left = step(Math.max(0, left));

  for (const line of open.filter((l) => l.priority === "URGENT")) {
    const take = Math.min(step(line.pending_qty), left);
    out.set(line.indent_item_id, take);
    left = round3(left - take);
  }

  const rest = open.filter((l) => l.priority !== "URGENT");
  const wanted = rest.reduce((sum, l) => sum + l.pending_qty, 0);
  if (left > 0 && wanted > 0) {
    // Largest remainder in whole steps of the unit, capped at what each line still
    // needs — the same rule `share_out` applies on the backend, so the proposal shown
    // here is exactly what gets reserved.
    const shares = splitQuantity(
      left, rest.map((l) => l.pending_qty), rest.map((l) => l.pending_qty), decimals,
    );
    rest.forEach((line, index) => out.set(line.indent_item_id, shares[index]));
  }
  return out;
}

/** What the warehouse tier can actually serve.
 *
 *  Falls back to `available_total` when the API did not send `main_available_qty`, so
 *  an older backend behaves exactly as it did rather than reporting nothing available.
 */
const warehouseAvailable = (item: BatchDemandItem) =>
  item.main_available_qty ?? item.available_total;

const defaultPlan = (item: BatchDemandItem): ItemPlan => {
  // Only a WAREHOUSE-tier point is ever pre-selected. Where the only stock sits on the
  // chain the row opens with no shelf picked, which is the honest starting position:
  // taking it out of a LIP is a decision somebody has to make, not a default.
  const first = item.warehouses.find((w) => !isChainPoint(w) && w.available_qty > 0);
  return {
    splits: [{
      wh: first ? String(first.warehouse_id) : "",
      qty: String(Math.min(first?.available_qty ?? 0, item.total_demand)),
    }],
    edited: {},
    // Nothing the WAREHOUSE can serve: there is no allocation for it to make, so the
    // only outcome this row can have is a material request. Read off the warehouse
    // tier, not off `available_total` — stock parked at a LIP is not cover, and
    // counting it left the checkbox off and the shortfall short.
    procure: warehouseAvailable(item) <= 0 && item.total_demand > 0,
  };
};

const planTotal = (plan: ItemPlan) =>
  plan.splits.reduce((sum, s) => sum + (Number(s.qty) || 0), 0);

const fixedShares = (item: BatchDemandItem, plan: ItemPlan) => {
  const map = new Map<number, number>();
  for (const line of item.demand) {
    const typed = plan.edited[line.indent_item_id];
    if (typed === undefined) continue;
    // A line can never be given more than it asked for, whatever is typed.
    map.set(line.indent_item_id,
            Math.min(Math.max(0, Number(typed) || 0), line.pending_qty));
  }
  return map;
};

/**
 * Turn one item's plan into the decisions the allocation endpoint takes.
 *
 * Each indent's share is drawn from the chosen shelves in order until it is met, so a
 * line served partly from the main store and partly from an MDP becomes two decisions
 * on the same indent line — which is exactly what the single-indent screen produces
 * when it splits, and what `AllocationDecisionIn` has always accepted.
 */
function buildDecisions(
  item: BatchDemandItem, plan: ItemPlan, shares: Map<number, number>,
): AllocationDecision[] {
  const pools = plan.splits
    .map((s) => ({ wh: Number(s.wh) || 0, left: Number(s.qty) || 0 }))
    .filter((p) => p.wh > 0 && p.left > 0);

  const out: AllocationDecision[] = [];
  for (const line of item.demand) {
    let need = shares.get(line.indent_item_id) ?? 0;
    // The line's requested quantity belongs to the LINE, not to each split. Repeating
    // it on every row made the backend read one line asking 10 and served 6+4 as two
    // lines each 4 and 6 short — a material request for goods that were handed over.
    // Same rule the single-indent screen applies: first row only.
    let first = true;
    const push = (quantity: number, warehouse: number | null) => {
      out.push({
        indent_item_id: line.indent_item_id,
        item_id: item.item_id,
        item_code: item.item_code ?? undefined,
        item_name: item.item_name ?? undefined,
        uom_code: item.uom_code ?? undefined,
        requested_qty: first ? line.pending_qty : 0,
        quantity,
        warehouse_id: warehouse,
        project_id: 0,
      });
      first = false;
    };

    if (need <= 0) {
      // "Give nothing" is a decision, and the ONLY way this line reaches procurement:
      // the backend works the shortfall out of `requested_qty - quantity` and raises
      // one material request for the indent. Skipped, the line was dropped from the
      // payload, its indent was never submitted at all, and a whole cycle's
      // out-of-stock demand went nowhere. Withheld on purpose (stock is there, the
      // allocator chose not to give it) stays skipped: the backend also refuses to buy
      // what is sitting on the shelf, but not sending it keeps the allocation honest.
      if (plan.procure) push(0, null);
      continue;
    }
    for (const pool of pools) {
      if (need <= 0) break;
      const take = round3(Math.min(pool.left, need));
      if (take <= 0) continue;
      push(take, pool.wh);
      pool.left = round3(pool.left - take);
      need = round3(need - take);
    }
  }
  return out;
}

function ItemRow({ item, plan, onChange }: {
  item: BatchDemandItem;
  plan: ItemPlan;
  onChange: (next: ItemPlan) => void;
}) {
  const [open, setOpen] = useState(false);

  const giving = planTotal(plan);
  const shares = useMemo(
    () => splitPreview(item.demand, giving, fixedShares(item, plan), item.uom_decimals),
    [item, plan, giving],
  );
  const handed = item.demand.reduce(
    (sum, line) => sum + (shares.get(line.indent_item_id) ?? 0), 0);
  const short = round3(item.total_demand - handed);
  // Two very different reasons a line goes unserved, and they must not be confused —
  // the same distinction BUG_SCM_016 forced onto the single-indent screen. Only demand
  // the shelf genuinely cannot cover becomes a material request. Quantity the
  // allocator deliberately withheld is still sitting in stock and must NOT be bought
  // again.
  //
  // FIXED 2026-08-22 — "still in stock" means the WAREHOUSE still holds it. Measured
  // against `available_total`, 5 units parked at a LIP made a demand of 44 read as
  // "39 to procurement · 5 not issued, still in stock", and those 5 were never bought
  // and never issued. Only what is left on the warehouse tier AFTER what this plan is
  // already drawing off it can be called withheld; a chain point the allocator chose
  // to draw from is counted in `handed` and so needs no term of its own.
  const takenFromWarehouse = plan.splits.reduce((sum, split) => {
    const point = item.warehouses.find((w) => String(w.warehouse_id) === split.wh);
    return point && !isChainPoint(point) ? sum + (Number(split.qty) || 0) : sum;
  }, 0);
  // FIXED 2026-08-22 (P1) — warehouse stock only counts as cover when this plan
  // actually DRAWS from the warehouse tier. A point picked with qty 0 means "not
  // serving from shelves", and the old math (`WA - taken`) cancelled the typed
  // quantity out of `short - coverable`, so the procurement count sat frozen no
  // matter what the top field said — it only moved from the per-indent Gets box,
  // which never touches `takenFromWarehouse`.
  const drawsWarehouse = plan.splits.some((s) => {
    const point = item.warehouses.find((w) => String(w.warehouse_id) === s.wh);
    return !!point && !isChainPoint(point) && (Number(s.qty) || 0) > 0;
  });
  const coverable = drawsWarehouse
    ? Math.max(0, warehouseAvailable(item) - takenFromWarehouse)
    : 0;
  const unavailable = round3(Math.max(0, short - coverable));
  // Ticked means BUY THE SHORTFALL — every unit this split did not serve, not just
  // the slice no shelf could ever have covered. The number on the checkbox is what
  // the allocator is committing to purchase, so it answers to the tick, and it now
  // answers to the source rows above it too.
  const toProcure = round3(plan.procure ? Math.max(0, short) : unavailable);
  const withheld = round3(short - unavailable);
  // Hand-edits can add up to more than the shelves offer, or leave some unspoken for.
  // Both are said out loud rather than silently corrected — the allocator is the one
  // deciding, and a number that moves on its own is worse than one that is flagged.
  const overGiven = round3(handed - giving);

  /** What the OTHER hand-set lines have already claimed of the total being taken off
   *  the shelves — the ceiling for the line currently being typed into. */
  const otherFixed = (lineId: number) =>
    [...fixedShares(item, plan)].reduce(
      (sum, [id, qty]) => (id === lineId ? sum : sum + qty), 0);

  /** The most this source row may take: what its shelf still has free after the other
   *  rows claimed theirs, and never more than the item is actually short.
   *
   *  Clamped on the way in rather than warned about afterwards. `max` on a number
   *  input does not stop typing — 166 could be entered against a demand of 15 and the
   *  surplus silently vanished, because the split can never hand out more than each
   *  line asked for. A box that cannot hold a wrong number beats a message saying it
   *  did. */
  const clampSplit = (index: number, whId: string, typed: string) => {
    const raw = Math.max(0, Number(typed) || 0);
    const shelf = item.warehouses.find((w) => String(w.warehouse_id) === whId);
    const otherRows = plan.splits.reduce(
      (sum, s, j) => (j === index ? sum : sum + (Number(s.qty) || 0)), 0);
    const shelfFree = shelf
      ? shelf.available_qty - plan.splits.reduce(
        (sum, s, j) => (j !== index && s.wh === whId ? sum + (Number(s.qty) || 0) : sum), 0)
      : 0;
    return String(round3(Math.max(0, Math.min(
      raw, shelfFree, item.total_demand - otherRows))));
  };

  const setSplit = (i: number, patch: Partial<{ wh: string; qty: string }>) =>
    onChange({ ...plan, splits: plan.splits.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const addSplit = () =>
    onChange({ ...plan, splits: [...plan.splits, { wh: "", qty: "" }] });
  const removeSplit = (i: number) =>
    onChange({ ...plan, splits: plan.splits.filter((_, j) => j !== i) });

  /** What this shelf can still offer, given what the other rungs already claimed. */
  const freeOn = (whId: string, index: number) => {
    const shelf = item.warehouses.find((w) => String(w.warehouse_id) === whId);
    if (!shelf) return 0;
    const claimed = plan.splits.reduce(
      (sum, s, j) => (j !== index && s.wh === whId ? sum + (Number(s.qty) || 0) : sum), 0);
    return round3(shelf.available_qty - claimed);
  };
  const overShelf = plan.splits.some(
    (s, i) => s.wh && (Number(s.qty) || 0) > freeOn(s.wh, i));

  return (
    <Card className="p-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left min-h-[44px]"
      >
        {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted" />
              : <ChevronRight className="h-4 w-4 shrink-0 text-muted" />}
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-ink">{item.item_name ?? "—"}</div>
          <div className="truncate font-mono text-xs text-muted">{item.item_code ?? "—"}</div>
        </div>
        <div className="hidden shrink-0 text-right sm:block">
          <div className="text-[11px] uppercase tracking-wide text-muted">Wanted</div>
          <div className="font-semibold text-ink">
            {fmt(item.total_demand)} {item.uom_code ?? ""}
          </div>
        </div>
        <div className="hidden shrink-0 text-right sm:block">
          <div className="text-[11px] uppercase tracking-wide text-muted">Giving</div>
          <div className="font-semibold text-brand">{fmt(handed)}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[11px] uppercase tracking-wide text-muted">Indents</div>
          <div className="font-semibold text-ink">{item.indent_count}</div>
        </div>
        {item.shortfall > 0 && (
          <Chip size="sm" color="warning" variant="flat" className="shrink-0">
            <AlertTriangle className="mr-1 inline h-3 w-3" />
            {fmt(item.shortfall)} short
          </Chip>
        )}
        {item.urgent_count > 0 && (
          <Chip size="sm" color="danger" variant="flat" className="shrink-0">
            {item.urgent_count} urgent
          </Chip>
        )}
      </button>

      {open && (
        <div className="border-t border-line px-4 py-3">
          {/* Source shelves. Same shape as the single-indent screen's splits, because
              it is the same decision: no one store holds a month of demand. */}
          <div className="mb-3 space-y-2">
            {plan.splits.map((split, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <div className="w-72">
                  {i === 0 && (
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted">
                      From which shelf
                    </label>
                  )}
                  <select
                    value={split.wh}
                    // Moving to a smaller point re-clamps what is already typed, so
                    // switching from a store holding 977 to one holding 1 cannot leave
                    // 977 sitting in the box.
                    onChange={(e) => setSplit(i, {
                      wh: e.target.value,
                      qty: clampSplit(i, e.target.value, split.qty),
                    })}
                    aria-label={`Source warehouse ${i + 1} for ${item.item_name ?? "item"}`}
                    className="h-11 w-full rounded-lg border border-line bg-content1 px-2 text-sm text-ink"
                  >
                    <option value="">— pick a point —</option>
                    {/* Warehouses first, then the distribution points, and a chain
                        point says so on its own row: drawing stock back out of a LIP
                        is allowed and is sometimes right, but the picker must never
                        let it happen by accident. */}
                    {orderPoints(item.warehouses).map((w) => (
                      <option key={w.warehouse_id} value={String(w.warehouse_id)}>
                        {w.warehouse_name} ({fmt(w.available_qty)} free)
                        {isChainPoint(w) ? " · distribution point" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="w-36">
                  {i === 0 && (
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted">
                      Take from here
                    </label>
                  )}
                  <Input
                    type="number"
                    min={0}
                    max={freeOn(split.wh, i)}
                    value={split.qty}
                    onChange={(e) => setSplit(i, { qty: clampSplit(i, split.wh, e.target.value) })}
                    aria-label={`Quantity from source ${i + 1} for ${item.item_name ?? "item"}`}
                  />
                </div>
                {plan.splits.length > 1 && (
                  <Button variant="ghost" aria-label={`Remove source ${i + 1}`}
                          onClick={() => removeSplit(i)}>
                    <Trash2 size={14} />
                  </Button>
                )}
              </div>
            ))}
            <Button variant="subtle" onClick={addSplit}>
              <Plus size={14} /> Take some from another point
            </Button>
          </div>

          <p className="mb-3 text-sm text-muted">
            Giving <strong className="text-ink">{fmt(handed)} {item.uom_code ?? ""}</strong>
            {" "}of {fmt(item.total_demand)} asked.
            {unavailable > 0 && (
              <span className={plan.procure ? "text-warning" : "text-muted"}>
                {" "}· {fmt(plan.procure ? toProcure : unavailable)} {item.uom_code ?? ""}
                {plan.procure
                  ? " goes to procurement"
                  : " cannot be served from any shelf — tick below to buy it in"}
              </span>
            )}
            {withheld > 0 && (
              <span className="text-muted">
                {" "}· {fmt(withheld)} {item.uom_code ?? ""} not issued — still in
                stock, so nothing is sent to procurement
              </span>
            )}
            {overShelf && (
              <span className="text-danger"> · more than a point actually holds</span>
            )}
            {overGiven > 0 && (
              <span className="text-danger">
                {" "}· hand-set shares exceed what you are taking off the shelves by {fmt(overGiven)}
              </span>
            )}
            <br />
            The split below is a starting proposal — urgent first, then the rest share
            what is left. <strong className="text-ink">Change any line</strong> and the
            remainder re-splits around it.
            {Object.keys(plan.edited).length > 0 && (
              <button
                type="button"
                className="ml-2 text-xs font-medium text-brand underline"
                onClick={() => onChange({ ...plan, edited: {} })}
              >
                Reset the split
              </button>
            )}
          </p>

          {/* The one thing this screen could not say. A line given nothing is only
              sent as a zero decision when this is ticked, and that zero is what the
              backend turns into a material request — exactly what the single-indent
              screen has always posted. Ticked by default when no shelf holds any of
              it, because then there is no other answer to give. */}
          {toProcure > 0 && (
            <label className="mb-3 flex min-h-11 items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={plan.procure}
                onChange={(e) => onChange({ ...plan, procure: e.target.checked })}
                className="h-4 w-4"
                aria-label={`Send the shortfall of ${item.item_name ?? "this item"} to procurement`}
              />
              <span>
                Send the {fmt(toProcure)} {item.uom_code ?? ""} no shelf can cover to
                procurement
                <span className="ml-1 text-muted">
                  — raises a material request on each indent's own approval ladder
                </span>
              </span>
            </label>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-2 py-2 font-medium">Indent</th>
                  <th className="px-2 py-2 font-medium">Raised by</th>
                  <th className="px-2 py-2 font-medium">Point</th>
                  <th className="px-2 py-2 text-right font-medium">Wants</th>
                  <th className="px-2 py-2 text-right font-medium">Gets</th>
                </tr>
              </thead>
              <tbody>
                {item.demand.map((line) => {
                  const gets = shares.get(line.indent_item_id) ?? 0;
                  const touched = plan.edited[line.indent_item_id] !== undefined;
                  return (
                    <tr key={line.indent_item_id} className="border-b border-line/60">
                      <td className="px-2 py-2 font-mono text-xs">
                        {line.indent_no}
                        {line.priority === "URGENT" && (
                          <Chip size="sm" color="danger" variant="flat" className="ml-2">
                            Urgent
                          </Chip>
                        )}
                      </td>
                      <td className="px-2 py-2">{line.requested_by_name ?? "—"}</td>
                      <td className="px-2 py-2 text-muted">
                        {line.office_name ?? line.project_name ?? "—"}
                      </td>
                      <td className="px-2 py-2 text-right">{fmt(line.pending_qty)}</td>
                      <td className="px-2 py-2 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <input
                            type="number"
                            min={0}
                            max={line.pending_qty}
                            value={plan.edited[line.indent_item_id] ?? fmt(gets)}
                            // Clamped to what this line asked for and to what is
                            // actually being taken off the shelves, so a hand-set
                            // share can never promise stock the sources do not cover.
                            onChange={(e) => onChange({
                              ...plan,
                              edited: {
                                ...plan.edited,
                                [line.indent_item_id]: String(round3(Math.max(0, Math.min(
                                  Number(e.target.value) || 0,
                                  line.pending_qty,
                                  round3(giving - otherFixed(line.indent_item_id)),
                                )))),
                              },
                            })}
                            aria-label={`Quantity for ${line.indent_no}`}
                            className={`h-9 w-24 rounded-lg border border-line bg-content1 px-2 text-right text-sm font-semibold
                              ${gets >= line.pending_qty ? "text-ok" : gets > 0 ? "text-warning" : "text-muted"}`}
                          />
                          {touched && (
                            <button
                              type="button"
                              aria-label={`Undo edit for ${line.indent_no}`}
                              className="text-xs text-muted underline"
                              onClick={() => {
                                const next = { ...plan.edited };
                                delete next[line.indent_item_id];
                                onChange({ ...plan, edited: next });
                              }}
                            >
                              undo
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}

export function BatchDemandView({ cycle }: { cycle?: string }) {
  const qc = useQueryClient();
  const [plans, setPlans] = useState<Record<number, ItemPlan>>({});
  const [result, setResult] = useState<
    { created: number; failed: { indent_no?: string | null; reason: string }[] } | null
  >(null);

  const batch = useQuery({
    queryKey: ["batch-demand", cycle ?? "all"],
    queryFn: () => getBatchDemand(cycle),
  });
  const items = batch.data?.items ?? [];

  const planFor = (item: BatchDemandItem) => plans[item.item_id] ?? defaultPlan(item);

  /** Every item's decisions, regrouped into one allocation per INDENT — which is the
   *  document the backend actually writes. */
  const allocations = useMemo(() => {
    const byIndent = new Map<number, AllocationDecision[]>();
    const indentOf = new Map<number, number>();
    for (const item of items) {
      const plan = planFor(item);
      const shares = splitPreview(
        item.demand, planTotal(plan), fixedShares(item, plan), item.uom_decimals);
      for (const line of item.demand) indentOf.set(line.indent_item_id, line.indent_id);
      for (const decision of buildDecisions(item, plan, shares)) {
        const indentId = indentOf.get(decision.indent_item_id)!;
        byIndent.set(indentId, [...(byIndent.get(indentId) ?? []), decision]);
      }
    }
    return [...byIndent].map(([indent_id, decisions]) => ({ indent_id, decisions }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, plans]);

  const submit = useMutation({
    mutationFn: () => createAllocationsBatch(allocations),
    onSuccess: (data) => {
      setResult({ created: data.created_count, failed: data.failed });
      setPlans({});
      // The served indents drop out of the batch, so it has to be re-read rather than
      // patched — and the queue behind it counts the same rows.
      qc.invalidateQueries({ queryKey: ["batch-demand"] });
      qc.invalidateQueries({ queryKey: ["fulfilment-batches"] });
      qc.invalidateQueries({ queryKey: ["fulfillment-queue"] });
    },
  });

  if (batch.error) {
    return (
      <p className="rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
        {(batch.error as Error).message}
      </p>
    );
  }
  if (batch.isLoading) return <Card className="p-2"><LoadingRows rows={4} className="p-0" /></Card>;
  if (items.length === 0) {
    return (
      <Card className="p-6 text-sm text-muted">
        {result
          ? `${result.created} allocation${result.created === 1 ? "" : "s"} raised — nothing else outstanding.`
          : "Nothing outstanding. Items appear here the moment an approved line is owed more than has been allocated."}
      </Card>
    );
  }

  const indentCount = allocations.length;

  return (
    <div className="space-y-2">
      {result && (
        <Card className="p-4 text-sm">
          <p className="font-semibold text-ok">
            {result.created} allocation{result.created === 1 ? "" : "s"} raised and sent
            for approval.
          </p>
          {result.failed.length > 0 && (
            <ul className="mt-2 space-y-1 text-danger">
              {result.failed.map((f, i) => (
                <li key={i}>{f.indent_no ?? "An indent"}: {f.reason}</li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {items.map((item) => (
        <ItemRow
          key={item.item_id}
          item={item}
          plan={planFor(item)}
          onChange={(next) => setPlans((cur) => ({ ...cur, [item.item_id]: next }))}
        />
      ))}

      {/* One submit for the whole cycle. It still raises one allocation per indent —
          the storekeeper just stops clicking through 900 screens to say so. */}
      <Card className="sticky bottom-2 flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="text-sm text-muted">
          {indentCount === 0
            ? "Nothing to allocate yet — set a quantity above."
            : `Raises ${indentCount} allocation${indentCount === 1 ? "" : "s"}, one per indent, each going for approval on its own ladder.`}
        </p>
        {/* Same permission as the single-indent Submit: it is the same decision,
            raised for a whole cycle at once. */}
        <Can do="allocation.submit">
          <Button
            disabled={indentCount === 0 || submit.isPending}
            onClick={() => { setResult(null); submit.mutate(); }}
          >
            <Send className="h-4 w-4" />
            {submit.isPending ? "Submitting…" : `Submit all ${indentCount}`}
          </Button>
        </Can>
      </Card>

      {submit.error && (
        <p className="rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          {(submit.error as Error).message}
        </p>
      )}
    </div>
  );
}
