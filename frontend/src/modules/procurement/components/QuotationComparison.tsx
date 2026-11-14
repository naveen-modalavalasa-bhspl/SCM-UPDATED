import { useEffect, useMemo, useState } from "react";
import {
  Award,
  Check,
  Search,
  Trophy,
  ChevronDown,
  ChevronRight,
  Star,
  Zap,
  RotateCcw,
  AlertTriangle,
} from "lucide-react";
import { Can, Card, ScrollBox, StatusPill } from "@/shared/components";
import { Button } from "./ActionButton";
import { fmtDate } from "@/shared/datetime";
import { money } from "../pages/RequisitionListPage";
import type { Comparison, ComparisonCell, ComparisonTotal } from "../types";
import { QuantityInput } from "@/shared/components/QuantityInput";
import { useUomDecimals } from "@/shared/hooks/useUomDecimals";
import { quantityProblem } from "@/shared/quantity";

/**
 * The quotation comparison sheet: one column per vendor, one row per item, and the
 * full breakup inside every cell.
 *
 * Two things shape it.
 *
 * **It never decides.** The backend flags the cheapest cell on each row and the top of
 * the ranking, and both are drawn as labels — "Best price", "Suggested". Every column
 * keeps its own award button whatever the flags say, because a buyer picks on delivery,
 * on payment terms, on who actually delivered last quarter, and the sheet has no
 * business overruling that. A suggestion the screen enforces is not a suggestion.
 *
 * **It has to survive ten vendors.** Eleven columns do not fit any screen, so the
 * sheet shows a window onto them — the top `VISIBLE` by rank — and the chips above it
 * turn each vendor on or off. The window scrolls sideways inside its own box with the
 * item column pinned, so the page itself never scrolls and the reader never loses
 * which row they are on.
 */

/** How many vendor columns open by default. Four fits a laptop beside the pinned item
 *  column; the rest are one chip away. */
const VISIBLE = 4;

const COL = "min-w-[210px] w-[210px]";

/** The item column is pinned. It carries its own background or the scrolling cells
 *  show through it. */
/** An RFQ line: the item and which line of the RFQ it is. */
type LineRef = { item_id: number; rfq_item_id: number };

const PINNED = "sticky left-0 z-10 bg-content1 min-w-[220px] w-[220px]";

function Cell({ cell, isAllocated = false }: { cell: ComparisonCell; isAllocated?: boolean }) {
  // The whole breakup, always: unit rate, what came off, what tax was added, what the
  // line comes to. A comparison that shows only the total is a comparison nobody can
  // argue with — and buyers have to be able to argue with it.
  return (
    <div
      className={`h-full rounded-lg border p-2.5 transition-all ${
        isAllocated
          ? "border-emerald-500/80 bg-emerald-50/25 dark:bg-emerald-950/25 shadow-sm ring-2 ring-emerald-500/30"
          : cell.is_best
          ? "border-success/40 bg-success/5"
          : "border-line bg-surface-2/40"
      }`}
    >
      <div className="flex items-start justify-between gap-1">
        {cell.is_best ? (
          <span className="inline-flex items-center gap-1 rounded bg-success/15 px-1.5 py-0.5 text-[10px] font-bold text-success uppercase tracking-wider">
            <Check className="h-3 w-3 stroke-[2.5]" /> Best price
          </span>
        ) : <span />}
        <div className="text-right text-sm font-semibold text-ink">
          {money(cell.line_total)}
        </div>
      </div>
      {/* The brand THIS supplier quoted — amber when it is not what was asked. */}
      {cell.combination && (
        <div className={`mt-1 text-right text-[11px] font-semibold ${
          cell.brand_changed ? "text-warn" : "text-brand"}`}
             title={cell.brand_changed ? "Not the brand the RFQ asked for" : "Brand quoted"}>
          {cell.combination}{cell.brand_changed ? " · changed" : ""}
        </div>
      )}
      <div className="mt-1.5 space-y-0.5 border-t border-line pt-1.5">
        <div className="flex justify-between gap-2 text-[11px] text-muted">
          <span>Qty</span>
          <span className="font-mono text-body font-medium">{cell.quantity}</span>
        </div>
        <div className="flex justify-between gap-2 text-[11px] text-muted">
          <span>Rate</span>
          <span className="font-mono text-body font-medium">{money(cell.rate)}</span>
        </div>
        {cell.discount_percent > 0 && (
          <div className="flex justify-between gap-2 text-[11px] text-muted">
            <span>Discount ({cell.discount_percent}%)</span>
            <span className="font-mono text-body">− {money(cell.discount_amount)}</span>
          </div>
        )}
        <div className="flex justify-between gap-2 text-[11px] text-muted">
          <span>Taxable</span>
          <span className="font-mono text-body">{money(cell.taxable_amount)}</span>
        </div>
        <div className="flex justify-between gap-2 text-[11px] text-muted">
          <span>GST ({cell.tax_percent}%)</span>
          <span className="font-mono text-body">{money(cell.tax_amount)}</span>
        </div>
      </div>
    </div>
  );
}

function FooterRow({ label, columns, render, strong = false }: {
  label: string;
  columns: ComparisonTotal[];
  render: (total: ComparisonTotal) => React.ReactNode;
  strong?: boolean;
}) {
  return (
    <tr className={strong ? "bg-surface-2/60" : ""}>
      <th
        scope="row"
        className={`${PINNED} border-t border-line px-3 py-2 text-left text-xs font-medium ${
          strong ? "text-ink" : "text-muted"
        } ${strong ? "bg-content1" : ""}`}
      >
        {label}
      </th>
      {columns.map((total) => (
        <td
          key={total.quotation_id}
          className={`${COL} border-t border-line px-3 py-2 text-right ${
            strong ? "text-sm font-semibold text-ink" : "text-xs text-body"
          }`}
        >
          {render(total)}
        </td>
      ))}
    </tr>
  );
}

export function QuotationComparison({
  comparison, awardedQuotationIds = [], purchaseOrders = [], busy,
  reawardable = false, liveAllocatedQuantities = {},
  onAward, onAwardSplit, onCreatePo, onOpenPo,
}: {
  comparison: Comparison;
  awardedQuotationIds?: number[];
  purchaseOrders?: {
    id: number; po_no: string; quotation_id?: number | null;
    vendor_id?: number | null;
    /** Quantity saved on this specific PO, keyed by RFQ item id. */
    item_quantities?: Record<string, number>;
  }[];
  busy?: boolean;
  /** An awarded tender with a share nobody holds an order against — a purchase order
   *  was rejected or cancelled, so that quantity is buyable again and the split may be
   *  reopened. Decided on the server's own list of live orders, never here. */
  reawardable?: boolean;
  /** vendor id -> (item id -> quantity on a live PO). This is deliberately not the
   * saved award: a rejected/cancelled PO frees its quantity without any screen-side
   * bookkeeping, and a re-share begins with only the quantities that remain ordered. */
  liveAllocatedQuantities?: Record<number, Record<string, number>>;
  onAward: (quotationIds: number[]) => void;
  onAwardSplit?: (allocations: { item_id: number; rfq_item_id?: number; vendor_id: number; quantity: number }[]) => void;
  onCreatePo: (quotationId: number) => void;
  onOpenPo: (poId: number) => void;
}) {
  const totals = comparison.totals ?? [];
  const isAnyAwarded = awardedQuotationIds.length > 0;
  // Which columns are open. Empty state means "the default window" rather than
  // "nothing", so the sheet is never blank on arrival.
  const [shown, setShown] = useState<number[] | null>(null);
  // Two text filters, because on a real RFQ neither list is short: forty lines down
  // the sheet and twelve suppliers across it. `itemQuery` narrows the ROWS, so a buyer
  // arguing about one item is not scrolling past thirty-nine others; `vendorQuery`
  // narrows the switchboard CHIPS, not the columns — hiding a chip must never hide a
  // column the buyer has already switched on, or a quote silently leaves the
  // comparison they are deciding from.
  const [itemQuery, setItemQuery] = useState("");
  const [vendorQuery, setVendorQuery] = useState("");
  // Rows this vendor did not quote at all. Off by default: "did not quote" is itself
  // an answer a buyer needs to see.
  const [quotedOnly, setQuotedOnly] = useState(false);
  // An awarded sheet is normally opened to answer "how much is already ordered?".
  // Keep the rows visible on arrival; an unawarded comparison stays compact.
  const [linesExpanded, setLinesExpanded] = useState(isAnyAwarded);
  const [split, setSplit] = useState<Record<string, string>>({});
  const [splitting, setSplitting] = useState(false);
  const uomDecimals = useUomDecimals();
  // Keyed by RFQ LINE (2026-10-26): one item asked in two brands is two lines, each
  // awarded on its own — keying by item added them together.
  const splitKey = (rfqItemId: number, vendorId: number) => `${rfqItemId}:${vendorId}`;
  // A column is a QUOTATION; a split is per VENDOR. A supplier who revised their offer
  // holds two columns that share one split key, so adding the columns up counted their
  // share twice — the allocated line read double what was typed and items went red as
  // over-allocated on numbers that were right. Dedupe before summing anything.
  const splitVendorIds = useMemo(
    () => Array.from(new Set(totals.map((total) => total.vendor_id))), [totals]);

  useEffect(() => {
    if (isAnyAwarded) setLinesExpanded(true);
  }, [isAnyAwarded]);

  const columns = useMemo(() => {
    if (shown === null) return totals.slice(0, VISIBLE);
    return totals.filter((t) => shown.includes(t.quotation_id));
  }, [totals, shown]);

  const toggle = (quotationId: number) => {
    const current = shown ?? totals.slice(0, VISIBLE).map((t) => t.quotation_id);
    setShown(current.includes(quotationId)
      ? current.filter((id) => id !== quotationId)
      : [...current, quotationId]);
  };

  const hidden = totals.length - columns.length;

  const chips = useMemo(() => {
    const q = vendorQuery.trim().toLowerCase();
    if (!q) return totals;
    return totals.filter((t) =>
      String(t.vendor_name ?? `Vendor ${t.vendor_id}`).toLowerCase().includes(q));
  }, [totals, vendorQuery]);

  const rows = useMemo(() => {
    const all = comparison.items ?? [];
    const q = itemQuery.trim().toLowerCase();
    return all.filter((row) => {
      if (quotedOnly && !columns.some((t) =>
        row.cells.some((c) => c.quotation_id === t.quotation_id))) return false;
      if (!q) return true;
      return [row.item_name, row.item_code]
        .some((field) => String(field ?? "").toLowerCase().includes(q));
    });
  }, [comparison.items, itemQuery, quotedOnly, columns]);

  // Keep every hook above this branch. The comparison can first render empty and then
  // receive quotations; returning before the memo hooks changed the hook count and
  // crashed the whole RFQ screen on that transition.
  if (!totals.length) {
    return (
      <Card className="p-6 text-center text-sm text-muted">
        No quotations submitted yet.
      </Card>
    );
  }

  const formatQuantity = (value: number) => Number(value).toLocaleString(undefined, {
    maximumFractionDigits: 3,
  });
  /** One RFQ line's quantity in an award / PO / allocation map: keyed `L<line>` since
   *  2026-10-26, by item id before. */
  const lineQty = (map: Record<string, number> | null | undefined, row: LineRef) =>
    Number(map?.[`L${row.rfq_item_id}`] ?? map?.[String(row.item_id)] ?? 0);
  const liveAllocation = (row: LineRef, vendorId: number) => {
    const map = liveAllocatedQuantities[vendorId];
    if (map && (map[`L${row.rfq_item_id}`] != null || map[String(row.item_id)] != null)) {
      return lineQty(map, row);
    }
    // The RFQ read normally supplies `liveAllocatedQuantities`.  The PO references
    // are an intentional fallback: if an older/stale response omits that derived map,
    // a visible previous PO must still not be shown as "Allocated 0".
    return purchaseOrders.reduce((sum, po) => (
      po.vendor_id === vendorId
        ? sum + lineQty(po.item_quantities, row)
        : sum
    ), 0);
  };
  /** What the buyer is adding now. This is deliberately separate from the live PO
   * quantity: a re-share is an increment, never an edit to a sent PO. */
  const additionalAward = (row: LineRef, vendorId: number) => {
    const value = Number(split[splitKey(row.rfq_item_id, vendorId)] ?? 0);
    // `min=0` is only a browser affordance; a pasted negative value must not turn
    // an "additional" award into an attempt to reduce a live PO allocation.
    return Number.isFinite(value) && value > 0 ? value : 0;
  };

  const splitAllocations = useMemo(() => {
    return (comparison.items ?? []).flatMap((item) =>
      splitVendorIds.map((vendorId) => {
        const quantity = liveAllocation(item, vendorId) + additionalAward(item, vendorId);
        return quantity > 0
          ? { item_id: item.item_id, rfq_item_id: item.rfq_item_id, vendor_id: vendorId, quantity }
          : null;
      }).filter((row): row is {
        item_id: number; rfq_item_id: number; vendor_id: number; quantity: number;
      } => row !== null),
    );
  }, [comparison.items, splitVendorIds, liveAllocatedQuantities, purchaseOrders, split]);

  const splitOverItems = useMemo(() => {
    return (comparison.items ?? []).filter((row) =>
      splitVendorIds.reduce((sum, vendorId) =>
        sum + liveAllocation(row, vendorId) + additionalAward(row, vendorId), 0)
      > Number(row.quantity)
    );
  }, [comparison.items, splitVendorIds, liveAllocatedQuantities, purchaseOrders, split]);

  const splitHasBadValue = useMemo(() => {
    return (comparison.items ?? []).some((row) =>
      splitVendorIds.some((vendorId) =>
        Boolean(quantityProblem(split[splitKey(row.rfq_item_id, vendorId)], {
          decimals: uomDecimals(row.uom_code), required: false,
        }))
      )
    );
  }, [comparison.items, splitVendorIds, split, uomDecimals]);

  const hasAdditionalQuantity = useMemo(() => {
    return Object.entries(split).some(([, value]) => Number(value) > 0);
  }, [split]);

  const awardedVendorsCount = useMemo(() => {
    return splitVendorIds.filter((vId) =>
      (comparison.items ?? []).some((item) => additionalAward(item, vId) > 0)
    ).length;
  }, [comparison.items, splitVendorIds, split]);

  const autoAllocateBestPrices = () => {
    const newSplit: Record<string, string> = {};

    (comparison.items ?? []).forEach((row) => {
      const decimals = uomDecimals(row.uom_code);
      const factor = Math.pow(10, decimals);

      // Live allocated quantity on previous POs
      const totalAllocatedOnItem = splitVendorIds.reduce(
        (sum, vId) => sum + liveAllocation(row, vId),
        0,
      );
      const unallocatedQty = Math.max(0, Number(row.quantity) - totalAllocatedOnItem);
      if (unallocatedQty <= 0) return;

      // Filter valid cells that quoted this line
      const quotedCells = row.cells.filter(
        (c) => Number(c.quantity) > 0 || Number(c.rate) > 0,
      );
      if (quotedCells.length === 0) return;

      // Determine the best price cells:
      // First priority: backend cell.is_best flag
      let bestCells = quotedCells.filter((c) => c.is_best);
      if (bestCells.length === 0) {
        const minRate = Math.min(...quotedCells.map((c) => Number(c.rate)));
        bestCells = quotedCells.filter((c) => Math.abs(Number(c.rate) - minRate) < 0.0001);
      }

      // Deduplicate by vendor_id to handle revisions
      const vendorCells: { vendorId: number; cell: ComparisonCell }[] = [];
      const seenVendors = new Set<number>();
      for (const cell of bestCells) {
        const total = totals.find((t) => t.quotation_id === cell.quotation_id);
        if (total && !seenVendors.has(total.vendor_id)) {
          seenVendors.add(total.vendor_id);
          vendorCells.push({ vendorId: total.vendor_id, cell });
        }
      }

      const tiedCount = vendorCells.length;
      if (tiedCount === 0) return;

      const totalUnits = Math.round(unallocatedQty * factor);
      const baseUnits = Math.floor(totalUnits / tiedCount);
      const remUnits = totalUnits % tiedCount;

      vendorCells.forEach(({ vendorId, cell }, idx) => {
        const allocatedUnits = baseUnits + (idx < remUnits ? 1 : 0);
        const calculatedShare = allocatedUnits / factor;
        // Cap at supplier quoted capacity minus what they already have allocated
        const supplierCurrentAlloc = liveAllocation(row, vendorId);
        const supplierMaxAvailable = Math.max(0, Number(cell.quantity) - supplierCurrentAlloc);
        const finalQty = Math.min(calculatedShare, supplierMaxAvailable);
        if (finalQty > 0) {
          newSplit[splitKey(row.rfq_item_id, vendorId)] =
            decimals > 0 ? finalQty.toFixed(decimals) : String(finalQty);
        }
      });
    });

    setSplit(newSplit);
    setShown(totals.map((total) => total.quotation_id));
    setSplitting(true);
    setLinesExpanded(true);
  };

  const handleStartManualSplit = () => {
    const initialSplit: Record<string, string> = {};
    (comparison.items ?? []).forEach((row) => {
      const quotingVendorIds = Array.from(
        new Set(
          row.cells
            .map((cell) => totals.find((t) => t.quotation_id === cell.quotation_id)?.vendor_id)
            .filter((vId): vId is number => vId != null),
        ),
      );
      if (quotingVendorIds.length === 1) {
        const singleVendorId = quotingVendorIds[0];
        const totalAllocatedOnItem = splitVendorIds.reduce(
          (sum, vId) => sum + liveAllocation(row, vId),
          0,
        );
        const unallocatedQty = Math.max(0, Number(row.quantity) - totalAllocatedOnItem);
        if (unallocatedQty > 0) {
          initialSplit[splitKey(row.rfq_item_id, singleVendorId)] = String(unallocatedQty);
        }
      }
    });

    setSplit(initialSplit);
    setShown(totals.map((total) => total.quotation_id));
    setSplitting(true);
    setLinesExpanded(true);
  };

  return (
    <Card className="p-0 overflow-hidden shadow-lg border-line">
      {totals.length > 0 && totals.some((t) => t.is_recommended) && (
        <div className="bg-gradient-to-r from-brand/20 via-brand/5 to-transparent border-b border-brand/20 p-5">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand/20 text-brand shadow-sm">
              <Trophy className="h-6 w-6" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-brand uppercase tracking-wider mb-1 flex items-center gap-2">
                <Star className="h-4 w-4" /> Top Ranked Supplier
              </h3>
              <p className="text-lg font-bold text-ink">
                {totals.find((t) => t.is_recommended)?.vendor_name ?? `Vendor ${totals.find((t) => t.is_recommended)?.vendor_id}`}
              </p>
              <p className="text-sm text-muted mt-1">
                This supplier offers the best overall proposal based on the selected evaluation method.
              </p>
            </div>
          </div>
        </div>
      )}
      {/* The vendor switchboard. Only earns its place past the default window, but
        * once an RFQ went to twelve suppliers it is the only way to read the sheet. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={itemQuery}
            onChange={(e) => setItemQuery(e.target.value)}
            placeholder="Find an item on this sheet…"
            className="h-10 w-full rounded-lg border border-line bg-content1 pl-9 pr-3 text-sm text-ink outline-none placeholder:text-muted focus:border-brand"
          />
        </div>
        {totals.length > VISIBLE && (
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              value={vendorQuery}
              onChange={(e) => setVendorQuery(e.target.value)}
              placeholder="Find a vendor…"
              className="h-10 w-full rounded-lg border border-line bg-content1 pl-9 pr-3 text-sm text-ink outline-none placeholder:text-muted focus:border-brand"
            />
          </div>
        )}
        <button
          type="button"
          onClick={() => setQuotedOnly(!quotedOnly)}
          aria-pressed={quotedOnly}
          className={`h-10 rounded-lg border px-3 text-xs font-medium ${
            quotedOnly
              ? "border-brand bg-brand/10 text-brand"
              : "border-line bg-content1 text-body hover:bg-surface-2"
          }`}
        >
          Quoted lines only
        </button>
        {(itemQuery || vendorQuery || quotedOnly) && (
          <button
            type="button"
            onClick={() => { setItemQuery(""); setVendorQuery(""); setQuotedOnly(false); }}
            className="h-10 rounded-lg px-3 text-xs text-muted hover:bg-surface-2 hover:text-ink"
          >
            Clear
          </button>
        )}
      </div>

      {totals.length > VISIBLE && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line p-3">
          <span className="mr-1 text-xs text-muted">
            {columns.length} of {totals.length} vendors shown
          </span>
          {chips.map((total) => {
            const on = columns.some((c) => c.quotation_id === total.quotation_id);
            return (
              <button
                key={total.quotation_id}
                type="button"
                onClick={() => toggle(total.quotation_id)}
                aria-pressed={on}
                className={`flex h-8 items-center gap-1 rounded-full border px-3 text-xs transition ${
                  on
                    ? "border-brand bg-brand/10 text-brand"
                    : "border-line text-muted hover:bg-surface-2"
                }`}
              >
                {total.is_recommended && <Trophy className="h-3 w-3" />}
                {total.vendor_name ?? `Vendor ${total.vendor_id}`}
              </button>
            );
          })}
          {chips.length === 0 && (
            <span className="text-xs text-muted">No vendor matches that name.</span>
          )}
          <button
            type="button"
            onClick={() => setShown(hidden ? totals.map((t) => t.quotation_id) : [])}
            className="ml-auto h-8 rounded-lg px-3 text-xs text-brand hover:underline"
          >
            {hidden ? "Show all" : "Hide all"}
          </button>
        </div>
      )}

      {onAwardSplit && (!isAnyAwarded || reawardable) && (
        <div className={`border-b transition-colors ${
          splitting
            ? "border-emerald-500/30 bg-emerald-500/[0.04] p-3.5"
            : "border-line bg-surface-2/30 p-3"
        }`}>
          {!splitting ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-ink">Multi-Supplier Awards:</span>
                <span className="text-xs text-muted">
                  Award whole quotations, or split quantities by line across best-price suppliers.
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Can do="rfq.award">
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={autoAllocateBestPrices}
                    className="!bg-emerald-600 hover:!bg-emerald-700 text-white shadow-sm flex items-center gap-1.5 text-xs font-semibold"
                  >
                    <Zap className="h-3.5 w-3.5 fill-current" /> Select the Best Price Suppliers
                  </Button>
                  <Button
                    variant="subtle"
                    disabled={busy}
                    onClick={handleStartManualSplit}
                    className="text-xs"
                  >
                    {isAnyAwarded ? "Re-share Unordered Items" : "Share Items Between Suppliers"}
                  </Button>
                </Can>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 px-3 py-1 text-xs font-bold text-emerald-700 dark:text-emerald-300">
                  <Zap className="h-3.5 w-3.5 fill-current text-emerald-600 dark:text-emerald-400" />
                  Split Mode Active
                </span>
                <span className="text-xs text-muted">
                  Auto-allocate lowest prices or check supplier boxes to fill quoted quantities.
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="soft"
                  disabled={busy}
                  onClick={autoAllocateBestPrices}
                  className="text-xs font-semibold flex items-center gap-1.5 border border-emerald-500/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/15"
                  title="Automatically allocate the best price suppliers for each line item (splits tied prices equally)"
                >
                  <Zap className="h-3.5 w-3.5 fill-current text-emerald-600" /> Select the Best Price Suppliers
                </Button>

                <Button
                  variant="subtle"
                  disabled={busy}
                  onClick={() => setSplit({})}
                  className="text-xs flex items-center gap-1 text-muted hover:text-ink"
                  title="Clear all allocated quantities"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Reset
                </Button>

                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setSplitting(false);
                    setSplit({});
                  }}
                  className="text-xs"
                >
                  Cancel
                </Button>

                {splitOverItems.length > 0 && (
                  <span className="text-xs font-semibold text-danger flex items-center gap-1">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {splitOverItems.length === 1
                      ? `${splitOverItems[0].item_name ?? "One item"} is over-allocated`
                      : `${splitOverItems.length} items over-allocated`}
                  </span>
                )}

                <Button
                  variant="primary"
                  disabled={
                    busy ||
                    splitOverItems.length > 0 ||
                    splitHasBadValue ||
                    !splitAllocations.length ||
                    (isAnyAwarded && !hasAdditionalQuantity)
                  }
                  onClick={() => onAwardSplit(splitAllocations)}
                  className="text-xs font-semibold shadow-sm !bg-emerald-600 hover:!bg-emerald-700 text-white"
                >
                  {awardedVendorsCount > 0
                    ? `Award & Generate ${awardedVendorsCount} PO${awardedVendorsCount > 1 ? "s" : ""}`
                    : "Award & Generate POs"}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <ScrollBox>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className={`${PINNED} px-3 py-3 text-left text-xs font-semibold text-muted`}>
                Item
              </th>
              {columns.map((total) => (
                <th key={total.quotation_id} className={`${COL} px-3 py-3 align-top`}>
                  <div className="flex flex-col items-end gap-1">
                    <span className="text-sm font-semibold text-ink">
                      {total.vendor_name ?? `Vendor ${total.vendor_id}`}
                    </span>
                    <div className="flex items-center gap-1.5 flex-wrap justify-end">
                      <StatusPill status={total.status} />
                      {total.revision_count > 0 && (
                        <span className="rounded-full bg-surface-2/80 border border-line px-2 py-0.5 text-[10px] font-semibold text-body">
                          v{total.revision_count + 1} pricing
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap justify-end gap-1">
                      {total.is_recommended && (
                        <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
                          <Trophy className="h-3 w-3" /> Suggested
                        </span>
                      )}
                      {total.best_line_count > 0 && (
                        <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success">
                          Cheapest on {total.best_line_count}
                        </span>
                      )}
                    </div>
                  </div>
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            <tr>
              <td colSpan={columns.length + 1} className="p-0">
                <button
                  type="button"
                  onClick={() => setLinesExpanded(!linesExpanded)}
                  className="w-full flex items-center justify-center gap-2 py-3 bg-surface-2/30 hover:bg-surface-2/60 text-sm font-medium text-ink transition-colors border-y border-line"
                >
                  {linesExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  {linesExpanded ? "Hide Line Items" : "View Line Items"}
                </button>
              </td>
            </tr>
          </tbody>
          {linesExpanded && (
          <tbody>
            {rows.map((row) => (
              <tr key={row.rfq_item_id} className="align-top">
                <th scope="row" className={`${PINNED} border-t border-line px-3 py-3 text-left`}>
                  <div className="text-sm font-medium text-ink">
                    {row.item_name ?? `Item ${row.item_id}`}
                  </div>
                  <div className="font-mono text-[11px] text-muted">{row.item_code ?? "—"}</div>
                  {row.requested_combination && (
                    <div className="mt-1 inline-flex rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-semibold text-brand">
                      Asked: {row.requested_combination}
                    </div>
                  )}
                  {(isAnyAwarded || splitting) && (() => {
                    const reqQty = Number(row.quantity);
                    const allocated = splitVendorIds.reduce((sum, vendorId) =>
                      sum + liveAllocation(row, vendorId), 0);
                    const added = splitVendorIds.reduce((sum, vendorId) =>
                      sum + additionalAward(row, vendorId), 0);
                    const totalAlloc = allocated + (splitting ? added : 0);
                    const isOver = totalAlloc > reqQty;
                    const isFull = Math.abs(totalAlloc - reqQty) < 0.0001;
                    const pct = reqQty > 0 ? Math.min(100, Math.round((totalAlloc / reqQty) * 100)) : 0;
                    const remaining = Math.max(0, reqQty - totalAlloc);

                    return (
                      <div className="mt-2 space-y-1.5 rounded-lg border border-line bg-surface-2/40 p-2 text-[11px]">
                        <div className="flex items-center justify-between gap-1 font-medium">
                          <span className="text-muted">Allocation:</span>
                          <span className={`font-mono font-bold ${
                            isOver ? "text-danger" : isFull ? "text-success" : totalAlloc > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted"
                          }`}>
                            {formatQuantity(totalAlloc)} / {formatQuantity(reqQty)}
                          </span>
                        </div>

                        {/* Mini Progress Bar */}
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-line/80">
                          <div
                            className={`h-full transition-all duration-300 ${
                              isOver
                                ? "bg-danger"
                                : isFull
                                ? "bg-success"
                                : totalAlloc > 0
                                ? "bg-amber-500"
                                : "bg-transparent"
                            }`}
                            style={{ width: `${isOver ? 100 : pct}%` }}
                          />
                        </div>

                        {splitting && (
                          <div className="flex items-center justify-between text-[10px]">
                            {isOver ? (
                              <span className="font-semibold text-danger flex items-center gap-1">
                                Over by +{formatQuantity(totalAlloc - reqQty)} {row.uom_code || ""}
                              </span>
                            ) : isFull ? (
                              <span className="font-semibold text-success flex items-center gap-1">
                                <Check className="h-3 w-3 stroke-[2.5]" /> 100% Covered
                              </span>
                            ) : totalAlloc > 0 ? (
                              <span className="text-amber-600 dark:text-amber-400 font-medium">
                                {formatQuantity(remaining)} remaining
                              </span>
                            ) : (
                              <span className="text-muted">Unassigned</span>
                            )}
                            {added > 0 && (
                              <span className="font-mono text-brand font-semibold">
                                +{formatQuantity(added)} new
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </th>
                {columns.map((total) => {
                  const cell = row.cells.find((c) => c.quotation_id === total.quotation_id);
                  // Keep every earlier PO visible below the exact item it covered. A
                  // vendor can now receive a second balance PO, so a single header
                  // link does not tell the buyer which quantity was already sent.
                  const earlierPos = purchaseOrders.filter((po) =>
                    po.quotation_id === total.quotation_id
                    && lineQty(po.item_quantities, row) > 0,
                  );
                  const key = splitKey(row.rfq_item_id, total.vendor_id);
                  const splitVal = split[key] ?? "";
                  const allocQty = Number(splitVal);
                  const hasActiveAllocation = Number.isFinite(allocQty) && allocQty > 0;

                  return (
                    <td key={total.quotation_id} className={`${COL} border-t border-line p-2 transition-colors ${
                      hasActiveAllocation ? "bg-emerald-500/[0.04]" : ""
                    }`}>
                      {cell
                        ? <Cell cell={cell} isAllocated={hasActiveAllocation} />
                        : <div className="py-3 text-center text-xs text-muted">Not quoted</div>}
                      {cell && isAnyAwarded && (
                        <div className="mt-2 space-y-1 text-right text-[11px] font-semibold text-muted">
                          <div>
                            Allocated {formatQuantity(liveAllocation(row, total.vendor_id))}
                          </div>
                          {earlierPos.map((po) => {
                            const quantity = lineQty(po.item_quantities, row);
                            return (
                              <button
                                key={po.id}
                                type="button"
                                onClick={() => onOpenPo(po.id)}
                                title={`Open ${po.po_no}`}
                                className="block ml-auto text-brand hover:underline"
                              >
                                {po.po_no} · previously sent {formatQuantity(quantity)}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {splitting && cell && (
                        <div className={`mt-2 rounded-lg border p-2 transition-all ${
                          hasActiveAllocation
                            ? "border-emerald-400 bg-emerald-50/50 dark:border-emerald-700 dark:bg-emerald-950/40 shadow-sm"
                            : "border-line bg-surface-2/50 hover:border-brand/40"
                        }`}>
                          <div className="mb-1.5 flex items-center justify-between gap-1">
                            <label className="flex cursor-pointer items-center gap-1.5 select-none" title="Check to allocate quoted quantity">
                              <input
                                type="checkbox"
                                checked={hasActiveAllocation}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    const quotedQty = Number(cell.quantity);
                                    const otherVendorsAllocated = splitVendorIds.reduce((sum, vId) => {
                                      if (vId === total.vendor_id) return sum;
                                      return sum + liveAllocation(row, vId) + additionalAward(row, vId);
                                    }, 0);
                                    const unallocatedNeeded = Math.max(0, Number(row.quantity) - otherVendorsAllocated);
                                    const fillVal = (unallocatedNeeded > 0 && unallocatedNeeded < quotedQty)
                                      ? unallocatedNeeded
                                      : quotedQty;
                                    const decimals = uomDecimals(row.uom_code);
                                    setSplit((prev) => ({
                                      ...prev,
                                      [key]: decimals > 0 ? fillVal.toFixed(decimals) : String(fillVal),
                                    }));
                                  } else {
                                    setSplit((prev) => {
                                      const next = { ...prev };
                                      delete next[key];
                                      return next;
                                    });
                                  }
                                }}
                                className="h-3.5 w-3.5 cursor-pointer rounded border-line text-emerald-600 focus:ring-emerald-500 accent-emerald-600"
                              />
                              <span className="text-[11px] font-semibold text-ink">
                                Quoted: <span className="font-mono">{formatQuantity(Number(cell.quantity))}</span>
                              </span>
                            </label>
                            <span className="text-[9px] font-semibold uppercase tracking-wider text-muted">
                              {isAnyAwarded ? "Add Qty" : "Award Qty"}
                            </span>
                          </div>

                          <QuantityInput
                            decimals={uomDecimals(row.uom_code)}
                            min={0}
                            value={splitVal}
                            data-uom={row.uom_code ?? ""}
                            aria-label={`Quantity for ${total.vendor_name ?? "supplier"} on ${row.item_name ?? row.item_id}`}
                            placeholder="0"
                            onChange={(raw) => setSplit((current) => ({
                              ...current,
                              [key]: raw,
                            }))}
                            className={`min-h-8 w-full rounded-md border px-2 text-right text-xs font-mono font-bold text-ink outline-none transition-all ${
                              hasActiveAllocation
                                ? "border-emerald-500 bg-content1 shadow-sm focus:ring-2 focus:ring-emerald-500/20"
                                : "border-line bg-content1 focus:border-brand"
                            }`}
                          />

                          {hasActiveAllocation && Number(cell.rate) > 0 && (
                            <div className="mt-1.5 flex items-center justify-between border-t border-emerald-200/60 pt-1 text-[10px] font-medium text-emerald-700 dark:border-emerald-800/60 dark:text-emerald-300">
                              <span>Line share:</span>
                              <span className="font-mono font-bold">{money(allocQty * Number(cell.rate))}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length + 1}
                    className="border-t border-line px-3 py-6 text-center text-sm text-muted">
                  No items match this search.
                </td>
              </tr>
            )}
          </tbody>
          )}

          <tfoot>
            <FooterRow label="Delivery by" columns={columns} render={(t) =>
              t.expected_delivery_date
                ? fmtDate(t.expected_delivery_date)
                : t.delivery_days != null ? `${t.delivery_days} days` : "—"} />
            <FooterRow label="Payment terms" columns={columns}
                       render={(t) => t.payment_terms || "—"} />
            <FooterRow label="Base amount" columns={columns}
                       render={(t) => money(t.sub_total)} />
            <FooterRow label="Discount" columns={columns}
                       render={(t) => t.discount_amount ? `− ${money(t.discount_amount)}` : "—"} />
            <FooterRow label="Taxes" columns={columns}
                       render={(t) => `+ ${money(t.tax_amount)}`} />
            <FooterRow label="Freight" columns={columns}
                       render={(t) => t.freight_amount ? `+ ${money(t.freight_amount)}` : "—"} />
            <FooterRow label="Grand total" columns={columns} strong
                       render={(t) => money(t.grand_total)} />

            {onAwardSplit && (!isAnyAwarded || reawardable) && (
              <tr>
                <th scope="row" className={`${PINNED} border-t border-line px-3 py-3 text-left text-xs font-medium text-muted`}>
                  {isAnyAwarded ? "Re-award" : "Split award"}
                </th>
                <td colSpan={columns.length} className="border-t border-line px-3 py-3">
                  {!splitting ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Can do="rfq.award">
                        <Button
                          variant="primary"
                          disabled={busy}
                          onClick={autoAllocateBestPrices}
                          className="!bg-emerald-600 hover:!bg-emerald-700 text-white text-xs font-semibold flex items-center gap-1.5 shadow-sm"
                        >
                          <Zap className="h-3.5 w-3.5 fill-current" /> Select the Best Price Suppliers
                        </Button>
                        <Button
                          variant="subtle"
                          disabled={busy}
                          onClick={handleStartManualSplit}
                          className="text-xs"
                        >
                          {isAnyAwarded ? "Re-share the unordered items" : "Share items between suppliers"}
                        </Button>
                      </Can>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted">
                        Enter each supplier&apos;s share against the item they quoted.
                        Unallocated quantities remain open for a later purchase.
                        {isAnyAwarded && " Allocated is already on a PO and cannot be changed here. Enter only the additional quantity; it becomes a new PO and is added to the allocated total."}
                      </span>
                      <span className="flex-1" />
                      <Button
                        variant="soft"
                        disabled={busy}
                        onClick={autoAllocateBestPrices}
                        className="text-xs font-semibold flex items-center gap-1.5 border border-emerald-500/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/15"
                      >
                        <Zap className="h-3.5 w-3.5 fill-current text-emerald-600" /> Select the Best Price Suppliers
                      </Button>
                      <Button
                        variant="subtle"
                        disabled={busy}
                        onClick={() => setSplit({})}
                        className="text-xs flex items-center gap-1 text-muted hover:text-ink"
                      >
                        <RotateCcw className="h-3.5 w-3.5" /> Reset
                      </Button>
                      {splitOverItems.length > 0 && (
                        <span className="text-xs font-semibold text-danger flex items-center gap-1">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          {splitOverItems.length === 1
                            ? `${splitOverItems[0].item_name ?? "One item"} is over-allocated.`
                            : `${splitOverItems.length} items are over-allocated.`}
                        </span>
                      )}
                      <Button variant="subtle" onClick={() => {
                        setSplitting(false);
                        setSplit({});
                      }}>Cancel</Button>
                      <Button
                        disabled={
                          busy ||
                          splitOverItems.length > 0 ||
                          splitHasBadValue ||
                          !splitAllocations.length ||
                          (isAnyAwarded && !hasAdditionalQuantity)
                        }
                        onClick={() => onAwardSplit(splitAllocations)}
                        className="!bg-emerald-600 hover:!bg-emerald-700 text-white text-xs font-semibold shadow-sm"
                      >
                        {awardedVendorsCount > 0
                          ? `Award & Generate ${awardedVendorsCount} PO${awardedVendorsCount > 1 ? "s" : ""}`
                          : "Award & generate POs"}
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            )}

            {/* Award and PO creation remain separate permission-controlled acts. */}
            <tr>
              <th scope="row" className={`${PINNED} border-t border-line px-3 py-3 text-left text-xs font-medium text-muted`}>
                Decision
              </th>
              {columns.map((total) => {
                const won = awardedQuotationIds.includes(total.quotation_id);
                const pos = purchaseOrders.filter(
                  (row) => row.quotation_id === total.quotation_id || row.vendor_id === total.vendor_id,
                );
                const awardedMap = liveAllocatedQuantities[total.vendor_id];
                let remainingAwardedQty = 0;
                let claimableUnallocatedRfqQty = 0;

                (comparison.items ?? []).forEach((row) => {
                  const cell = row.cells.find((c) => c.quotation_id === total.quotation_id);
                  if (!cell) return;
                  const wonQty = awardedMap != null
                    ? lineQty(awardedMap, row)
                    : (won ? Number(cell.quantity) : 0);
                  const orderedQty = pos.reduce(
                    (sum, po) => sum + lineQty(po.item_quantities, row),
                    0,
                  );
                  const remAwarded = wonQty - orderedQty;
                  if (remAwarded > 0.001) remainingAwardedQty += remAwarded;

                  const totalAllocatedOnItem = splitVendorIds.reduce(
                    (sum, vId) => sum + liveAllocation(row, vId),
                    0,
                  );
                  const unallocatedOnRfq = Math.max(0, Number(row.quantity) - totalAllocatedOnItem);
                  const vendorAlreadyWon = liveAllocation(row, total.vendor_id);
                  const vendorMaxQuota = Number(cell.quantity);
                  const vendorCanTakeMore = Math.max(0, vendorMaxQuota - vendorAlreadyWon);
                  const claimable = Math.min(unallocatedOnRfq, vendorCanTakeMore);
                  if (claimable > 0.001) claimableUnallocatedRfqQty += claimable;
                });

                const canRaiseRemaining = remainingAwardedQty > 0.001 || claimableUnallocatedRfqQty > 0.001;

                const handleRaiseRemaining = () => {
                  if (remainingAwardedQty > 0.001 || !onAwardSplit) {
                    onCreatePo(total.quotation_id);
                    return;
                  }
                  const autoAllocations = (comparison.items ?? []).flatMap((row) =>
                    splitVendorIds.map((vendorId) => {
                      const currentAlloc = liveAllocation(row, vendorId);
                      if (vendorId === total.vendor_id) {
                        const cell = row.cells.find((c) => c.quotation_id === total.quotation_id);
                        const cellQty = Number(cell?.quantity ?? 0);
                        const totalAlloc = splitVendorIds.reduce((sum, vId) => sum + liveAllocation(row, vId), 0);
                        const unallocatedOnRfq = Math.max(0, Number(row.quantity) - totalAlloc);
                        const vendorCanTake = Math.max(0, cellQty - currentAlloc);
                        const added = Math.min(unallocatedOnRfq, vendorCanTake);
                        const newQty = currentAlloc + added;
                        return newQty > 0 ? { item_id: row.item_id, rfq_item_id: row.rfq_item_id, vendor_id: vendorId, quantity: newQty } : null;
                      }
                      return currentAlloc > 0 ? { item_id: row.item_id, rfq_item_id: row.rfq_item_id, vendor_id: vendorId, quantity: currentAlloc } : null;
                    }).filter((r): r is { item_id: number; rfq_item_id: number; vendor_id: number; quantity: number } => r !== null),
                  );

                  if (autoAllocations.length > 0) {
                    onAwardSplit(autoAllocations);
                  } else {
                    onCreatePo(total.quotation_id);
                  }
                };

                return (
                  <td key={total.quotation_id} className={`${COL} border-t border-line px-3 py-3`}>
                    {won ? (
                      <div className="space-y-2">
                        <div className="flex items-center justify-end gap-1 text-xs font-semibold text-success">
                          <Award className="h-3.5 w-3.5" /> Awarded
                        </div>
                        {pos.length > 0 && (
                          <div className="space-y-1">
                            {pos.map((po) => (
                              <Button key={po.id} variant="subtle" className="w-full text-xs"
                                      onClick={() => onOpenPo(po.id)}>
                                {po.po_no}
                              </Button>
                            ))}
                          </div>
                        )}
                        <Can do="po.create">
                          <Button
                            className="w-full text-xs"
                            variant={pos.length > 0 ? "subtle" : "primary"}
                            disabled={busy || (pos.length > 0 && !canRaiseRemaining)}
                            title={!canRaiseRemaining && pos.length > 0 ? "All items are fully allocated and ordered" : undefined}
                            onClick={handleRaiseRemaining}
                          >
                            {pos.length > 0 ? "Raise PO to remaining qtys" : "Create PO"}
                          </Button>
                        </Can>
                      </div>
                    ) : isAnyAwarded ? (
                      <p className="text-right text-xs text-muted">Not selected</p>
                    ) : (
                      <Can do="rfq.award">
                        <Button variant="subtle" className="w-full" disabled={busy}
                                onClick={() => onAward([total.quotation_id])}>
                          Award complete quote
                        </Button>
                      </Can>
                    )}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </ScrollBox>
    </Card>
  );
}
