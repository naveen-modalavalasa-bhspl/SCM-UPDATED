import { useMemo, useState } from "react";
import { Award, Check, Search, Trophy, ChevronDown, ChevronRight, Star } from "lucide-react";
import { Can, Card, ScrollBox, StatusPill } from "@/shared/components";
import { Button } from "./ActionButton";
import { fmtDate } from "@/shared/datetime";
import { money } from "../pages/RequisitionListPage";
import type { Comparison, ComparisonCell, ComparisonTotal } from "../types";

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
const PINNED = "sticky left-0 z-10 bg-content1 min-w-[220px] w-[220px]";

function TaxLine({ label, rate, amount }: {
  label: string; rate?: number | null; amount?: number | null;
}) {
  if (rate == null || amount == null) return null;
  return (
    <div className="flex justify-between gap-2 text-[11px] text-muted">
      <span>{label} ({rate}%)</span>
      <span className="font-mono">{money(amount)}</span>
    </div>
  );
}

function Cell({ cell }: { cell: ComparisonCell }) {
  // The whole breakup, always: unit rate, what came off, what tax was added, what the
  // line comes to. A comparison that shows only the total is a comparison nobody can
  // argue with — and buyers have to be able to argue with it.
  const split = cell.cgst_rate != null || cell.sgst_rate != null || cell.igst_rate != null;
  return (
    <div
      className={`h-full rounded-lg border p-2.5 ${
        cell.is_best
          ? "border-success/40 bg-success/5"
          : "border-line bg-surface-2/40"
      }`}
    >
      <div className="text-right text-sm font-semibold text-ink">
        {money(cell.line_total)}
      </div>
      <div className="mt-1.5 space-y-0.5 border-t border-line pt-1.5">
        <div className="flex justify-between gap-2 text-[11px] text-muted">
          <span>Qty</span>
          <span className="font-mono text-body">{cell.quantity}</span>
        </div>
        <div className="flex justify-between gap-2 text-[11px] text-muted">
          <span>Rate</span>
          <span className="font-mono text-body">{money(cell.rate)}</span>
        </div>
        {cell.discount_percent > 0 && (
          <div className="flex justify-between gap-2 text-[11px] text-muted">
            <span>Discount ({cell.discount_percent}%)</span>
            <span className="font-mono">− {money(cell.discount_amount)}</span>
          </div>
        )}
        <div className="flex justify-between gap-2 text-[11px] text-muted">
          <span>Taxable</span>
          <span className="font-mono text-body">{money(cell.taxable_amount)}</span>
        </div>
        {split ? (
          <>
            <TaxLine label="CGST" rate={cell.cgst_rate} amount={cell.cgst_amount} />
            <TaxLine label="SGST" rate={cell.sgst_rate} amount={cell.sgst_amount} />
            <TaxLine label="IGST" rate={cell.igst_rate} amount={cell.igst_amount} />
          </>
        ) : (
          <div className="flex justify-between gap-2 text-[11px] text-muted">
            <span>Tax ({cell.tax_percent}%)</span>
            <span className="font-mono">{money(cell.tax_amount)}</span>
          </div>
        )}
      </div>
      {cell.is_best && (
        <div className="mt-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-success">
          <Check className="h-3 w-3" /> Best price
        </div>
      )}
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
  comparison, pos, busy, onAward, onAwardSplit, onCreatePo, onOpenPo,
}: {
  comparison: Comparison;
  pos?: { po_id: number; po_no: string; quotation_id?: number | null }[];
  busy?: boolean;
  onAward: (quotationId: number) => void;
  /** Share the tender out: one entry per (item, supplier) the buyer gave a quantity. */
  onAwardSplit?: (allocations: { item_id: number; vendor_id: number; quantity: number }[]) => void;
  onCreatePo: (quotationId: number) => void;
  onOpenPo: (poId: number) => void;
}) {
  const totals = comparison.totals ?? [];
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
  const [linesExpanded, setLinesExpanded] = useState(false);
  /**
   * How much of each item each supplier is being given, keyed `itemId:vendorId`.
   *
   * THE SPLIT IS DECIDED HERE, against the prices, and not on the RFQ form where it
   * used to live — at the moment a tender is raised nobody knows what anything costs,
   * so the buyer was being asked to guess the answer to the question the RFQ exists to
   * ask. Every invited supplier quotes the whole line; this is where the line is
   * shared out between the answers that came back.
   *
   * Held as typed text, not numbers: a half-typed "1" on the way to "10" must not be
   * re-rendered as 1, and an emptied box must stay empty rather than snapping to 0.
   */
  const [split, setSplit] = useState<Record<string, string>>({});
  const [splitting, setSplitting] = useState(false);
  const splitKey = (itemId: number, vendorId: number) => `${itemId}:${vendorId}`;

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

  if (!totals.length) {
    return (
      <Card className="p-6 text-center text-sm text-muted">
        No quotations submitted yet.
      </Card>
    );
  }

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

  const isAnyAwarded = comparison.quotations.some((q) => q.status === "ACCEPTED");
  const isSplitAward = comparison.quotations.filter((q) => q.status === "ACCEPTED").length > 1;

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
                    <StatusPill status={total.status} />
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
                  <div className="mt-1 text-xs text-body">
                    {row.quantity} {row.uom_code ?? ""}
                  </div>
                  {splitting && (() => {
                    // What this row has been shared out so far, against what it asks
                    // for. Over-allocating is shown here rather than only refused at
                    // the save: the buyer is typing into a grid and the row is where
                    // the arithmetic they are doing actually lives.
                    const given = columns.reduce((sum, total) =>
                      sum + (Number(split[splitKey(row.item_id, total.vendor_id)]) || 0), 0);
                    const over = given > Number(row.quantity);
                    return (
                      <div className={`mt-1 text-[11px] font-semibold ${over ? "text-danger" : "text-muted"}`}>
                        Allocated {given} / {row.quantity}
                      </div>
                    );
                  })()}
                </th>
                {columns.map((total) => {
                  const cell = row.cells.find((c) => c.quotation_id === total.quotation_id);
                  return (
                    <td key={total.quotation_id} className={`${COL} border-t border-line p-2`}>
                      {cell
                        ? <Cell cell={cell} />
                        : <div className="py-3 text-center text-xs text-muted">Not quoted</div>}
                      {/* Only against a cell that was actually quoted: a supplier who
                        * did not answer for this item cannot be given any of it, and
                        * the server refuses it, so there is no box to type into. */}
                      {splitting && cell && (
                        <input
                          type="number" min="0" step="0.001"
                          value={split[splitKey(row.item_id, total.vendor_id)] ?? ""}
                          aria-label={`Quantity for ${total.vendor_name ?? "supplier"} on ${row.item_name ?? row.item_id}`}
                          onChange={(e) => setSplit((current) => ({
                            ...current,
                            [splitKey(row.item_id, total.vendor_id)]: e.target.value,
                          }))}
                          className="mt-2 min-h-9 w-full rounded-md border border-line bg-content1 px-2 text-right text-sm text-ink outline-none focus:border-brand"
                        />
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

            {/* Sharing the tender out. A row of its own above the decision, because it
              * is a different decision from "who wins the lot": one is a column, the
              * other is a grid. Only offered while nothing has been awarded, and only
              * when the caller wired it. */}
            {onAwardSplit && !isAnyAwarded && (
              <tr>
                <th scope="row" className={`${PINNED} border-t border-line px-3 py-3 text-left text-xs font-medium text-muted`}>
                  Split
                </th>
                <td colSpan={columns.length} className="border-t border-line px-3 py-3">
                  {!splitting ? (
                    <Can do="rfq.award">
                      <Button variant="subtle" disabled={busy} onClick={() => setSplitting(true)}>
                        Share between suppliers
                      </Button>
                    </Can>
                  ) : (() => {
                    const allocations = Object.entries(split)
                      .map(([key, value]) => {
                        const [itemId, vendorId] = key.split(":").map(Number);
                        return { item_id: itemId, vendor_id: vendorId, quantity: Number(value) };
                      })
                      .filter((row) => row.quantity > 0);
                    // Refused here as well as at the server, because the buyer is
                    // typing into a grid and should not have to press Award to find
                    // out that one row of it does not add up.
                    const over = rows.filter((row) => {
                      const given = columns.reduce((sum, total) =>
                        sum + (Number(split[splitKey(row.item_id, total.vendor_id)]) || 0), 0);
                      return given > Number(row.quantity);
                    });
                    return (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-muted">
                          Type each supplier&rsquo;s share against their quoted price.
                          An item nobody is given stays unordered.
                        </span>
                        <span className="flex-1" />
                        {over.length > 0 && (
                          <span className="text-xs font-semibold text-danger">
                            {over.length === 1
                              ? `${over[0].item_name ?? "One item"} is over-allocated.`
                              : `${over.length} items are over-allocated.`}
                          </span>
                        )}
                        <Button variant="subtle" onClick={() => { setSplitting(false); setSplit({}); }}>
                          Cancel
                        </Button>
                        <Button
                          disabled={busy || !allocations.length || over.length > 0}
                          onClick={() => onAwardSplit(allocations)}
                        >
                          Split and award POs
                        </Button>
                      </div>
                    );
                  })()}
                </td>
              </tr>
            )}

            {/* The decision row. Awarding and raising the order stay two acts with two
              * permissions: picking a winner is not approving a spend. */}
            <tr>
              <th scope="row" className={`${PINNED} border-t border-line px-3 py-3 text-left text-xs font-medium text-muted`}>
                Decision
              </th>
              {columns.map((total) => {
                const isAwarded = total.status === "ACCEPTED";
                const isAnyAwarded = comparison.quotations.some((q) => q.status === "ACCEPTED");
                const createdPo = pos?.find((p) => p.quotation_id === total.quotation_id);
                return (
                  <td key={total.quotation_id} className={`${COL} border-t border-line px-3 py-3`}>
                    {isAwarded ? (
                      <div className="space-y-2">
                        <div className="flex items-center justify-end gap-1 text-xs font-semibold text-success">
                          <Award className="h-3.5 w-3.5" /> Awarded
                        </div>
                        {createdPo ? (
                          <Button variant="subtle" className="w-full" onClick={() => onOpenPo(createdPo.po_id)}>
                            {createdPo.po_no ?? "Purchase order"}
                          </Button>
                        ) : isSplitAward ? (
                          <div className="text-center text-xs text-muted">
                            Processing PO...
                          </div>
                        ) : (
                          <Can do="po.create">
                            <Button
                              className="w-full"
                              disabled={busy}
                              onClick={() => onCreatePo(total.quotation_id)}
                            >
                              Create PO
                            </Button>
                          </Can>
                        )}
                      </div>
                    ) : isAnyAwarded ? (
                      <p className="text-right text-xs text-muted">Not selected</p>
                    ) : (
                      <Can do="rfq.award">
                        <Button
                          variant="subtle"
                          className="w-full"
                          disabled={busy}
                          onClick={() => onAward(total.quotation_id)}
                        >
                          Select this quote
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
