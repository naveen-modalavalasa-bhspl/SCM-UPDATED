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
        title={batch ? `${batch.month_label} — consolidated` : "Consolidated cycle"}
        actions={
          <Button variant="ghost" onClick={() => nav("/inventory/fulfillment")}>
            <ArrowLeft className="h-4 w-4" /> Back to queue
          </Button>
        }
      />

      {batch && (
        <Card className="mb-4 flex flex-wrap gap-6 p-4 text-sm">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted">Indents</div>
            <div className="text-lg font-bold text-ink">{batch.indent_count}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted">Requesters</div>
            <div className="text-lg font-bold text-ink">{batch.requester_count}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted">Items</div>
            <div className="text-lg font-bold text-ink">{batch.item_count}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted">Total asked</div>
            <div className="text-lg font-bold text-ink">{batch.total_qty}</div>
          </div>
          {batch.urgent_count > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted">Urgent</div>
              <div className="text-lg font-bold text-bad">{batch.urgent_count}</div>
            </div>
          )}
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
