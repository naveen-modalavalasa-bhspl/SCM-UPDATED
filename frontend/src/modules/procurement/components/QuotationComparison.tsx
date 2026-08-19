import { useMemo, useState } from "react";
import { Award, Check, Trophy } from "lucide-react";
import { Button, Can, Card, ScrollBox, StatusPill } from "@/shared/components";
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
  comparison, awardedQuotationId, poId, poNo, busy, onAward, onCreatePo, onOpenPo,
}: {
  comparison: Comparison;
  /** The quote that already won, if one has. */
  awardedQuotationId?: number | null;
  poId?: number | null;
  poNo?: string | null;
  busy?: boolean;
  onAward: (quotationId: number) => void;
  onCreatePo: (quotationId: number) => void;
  onOpenPo: () => void;
}) {
  const totals = comparison.totals ?? [];
  // Which columns are open. Empty state means "the default window" rather than
  // "nothing", so the sheet is never blank on arrival.
  const [shown, setShown] = useState<number[] | null>(null);

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

  return (
    <Card className="p-0">
      {/* The vendor switchboard. Only earns its place past the default window, but
        * once an RFQ went to twelve suppliers it is the only way to read the sheet. */}
      {totals.length > VISIBLE && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line p-3">
          <span className="mr-1 text-xs text-muted">
            {columns.length} of {totals.length} vendors shown
          </span>
          {totals.map((total) => {
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
            {(comparison.items ?? []).map((row) => (
              <tr key={row.rfq_item_id} className="align-top">
                <th scope="row" className={`${PINNED} border-t border-line px-3 py-3 text-left`}>
                  <div className="text-sm font-medium text-ink">
                    {row.item_name ?? `Item ${row.item_id}`}
                  </div>
                  <div className="font-mono text-[11px] text-muted">{row.item_code ?? "—"}</div>
                  <div className="mt-1 text-xs text-body">
                    {row.quantity} {row.uom_code ?? ""}
                  </div>
                </th>
                {columns.map((total) => {
                  const cell = row.cells.find((c) => c.quotation_id === total.quotation_id);
                  return (
                    <td key={total.quotation_id} className={`${COL} border-t border-line p-2`}>
                      {cell
                        ? <Cell cell={cell} />
                        : <div className="py-3 text-center text-xs text-muted">Not quoted</div>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>

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

            {/* The decision row. Awarding and raising the order stay two acts with two
              * permissions: picking a winner is not approving a spend. */}
            <tr>
              <th scope="row" className={`${PINNED} border-t border-line px-3 py-3 text-left text-xs font-medium text-muted`}>
                Decision
              </th>
              {columns.map((total) => {
                const won = awardedQuotationId === total.quotation_id;
                return (
                  <td key={total.quotation_id} className={`${COL} border-t border-line px-3 py-3`}>
                    {won ? (
                      <div className="space-y-2">
                        <div className="flex items-center justify-end gap-1 text-xs font-semibold text-success">
                          <Award className="h-3.5 w-3.5" /> Awarded
                        </div>
                        {poId ? (
                          <Button variant="subtle" className="w-full" onClick={onOpenPo}>
                            {poNo ?? "Purchase order"}
                          </Button>
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
                    ) : awardedQuotationId ? (
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
