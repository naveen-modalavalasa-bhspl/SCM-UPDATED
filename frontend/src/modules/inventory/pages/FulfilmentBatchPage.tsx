import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Button, Card, PageHeader } from "@/shared/components";
import { BatchDemandView } from "../components/BatchDemandView";
import { getFulfilmentBatches } from "../api";

/**
 * One monthly cycle, opened from the Fulfilment Queue.
 *
 * The queue shows the cycle as a single row because it is a single decision: nine
 * hundred lab technicians asking for the same twenty items is not nine hundred
 * decisions. This screen is where that decision is made — per ITEM, with the split
 * back onto each indent visible and editable, and the shelf it leaves from chosen once
 * rather than nine hundred times.
 */
function Stat({ label, value, tone = "text-ink" }:
              { label: string; value: number; tone?: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`text-lg font-bold ${tone}`}>{value}</div>
    </div>
  );
}

export function FulfilmentBatchPage() {
  const { cycle = "" } = useParams();
  const nav = useNavigate();

  // Only for the heading. The numbers that matter come from the demand call inside
  // BatchDemandView, so the two can never show different totals.
  const batches = useQuery({
    queryKey: ["fulfilment-batches", "with-done"],
    // Finished cycles included: opening one that has just been signed must
    // still show what was decided, not an empty screen.
    queryFn: () => getFulfilmentBatches(true),
  });
  const batch = (batches.data?.items ?? []).find((b) => b.cycle === cycle);

  return (
    <div>
      <PageHeader
        eyebrow="Inventory · Fulfilment Queue"
        title={batch
          ? `${batch.month_label} — ${batch.consolidation_no ?? "consolidated"}`
          : "Consolidated cycle"}
        actions={
          <Button variant="ghost" onClick={() => nav("/inventory/fulfilment")}>
            <ArrowLeft className="h-4 w-4" /> Back to queue
          </Button>
        }
      />

      {batch && (
        <Card className="mb-4 p-4 text-sm">
          {/* The flex row lives on an inner div: HeroUI's Card is itself a column
              flex container, so `flex-wrap` on the Card never won against its
              `flex-col` and every figure stacked down the page. */}
          <div className="flex flex-wrap items-start gap-x-10 gap-y-4">
            {/* The same two numbers the queue row shows, off the same document. */}
            <Stat label="Indents" value={batch.indent_count} />
            <Stat label="Still to allocate"
                  value={batch.owed_indent_count ?? batch.indent_count} />
            {/* Waiting on an allocation already raised. Counted under "still to
                allocate" it produced a Submit that came back with one refusal per
                indent — inventory refuses a second proposal while one is in flight. */}
            {(batch.in_approval_indent_count ?? 0) > 0 && (
              <Stat label="In approval" value={batch.in_approval_indent_count ?? 0} />
            )}
            <Stat label="Requesters" value={batch.requester_count} />
            {/* What is still owed, because that is what the list below shows. The
                document's own totals (29 items, 78 lines for August) described the
                whole cycle and sat above a list of 7. */}
            <Stat label="Items" value={batch.owed_item_count ?? batch.item_count} />
            {(batch.owed_line_count ?? batch.line_count) !== undefined && (
              <Stat label="Lines"
                    value={batch.owed_line_count ?? batch.line_count ?? 0} />
            )}
            {batch.urgent_count > 0 && (
              <Stat label="Urgent" value={batch.urgent_count} tone="text-bad" />
            )}
            {/* One figure per unit. A single "total asked" summed millilitres, boxes
                and pieces into 985.324 — a quantity nobody can pick off a shelf. */}
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted">Total asked</div>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                {(batch.totals_by_uom ?? []).map((total) => (
                  <span key={total.uom_code} className="text-lg font-bold text-ink">
                    {total.quantity}
                    <span className="ml-1 text-xs font-medium text-muted">
                      {total.uom_code}
                    </span>
                  </span>
                ))}
                {!batch.totals_by_uom?.length && (
                  <span className="text-lg font-bold text-ink">—</span>
                )}
              </div>
            </div>
          </div>
        </Card>
      )}

      <p className="mb-3 text-sm text-muted">
        One row per item, totalled across the whole cycle. Pick the shelf it comes from,
        set how much to give, and adjust any indent's share by hand. The allocation
        itself is still written per indent, so every reservation and ledger row stays
        exactly where it always was.
      </p>

      <BatchDemandView cycle={cycle} />
    </div>
  );
}
