import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageCheck } from "lucide-react";
import { Button, Card, StatusPill } from "@/shared/components";
import { approvalsApi } from "../api";
import type { IndentAvailabilityLine } from "../types";
import { QuantityInput } from "@/shared/components/QuantityInput";
import { useUomDecimals } from "@/shared/hooks/useUomDecimals";

const fmt = (value: number) => {
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
};

/** "You have some of this — give it now" on the approval screen itself.
 *
 *  The point of the whole cascade: an approver serves what they hold, the remainder
 *  stays on the SAME indent, and the document climbs carrying only what is still
 *  owed. No child requests, and no trip to another module for the common case.
 *
 *  The user never says what kind of movement this is — the server derives that from
 *  the two stocking points. All they add is a reason.
 */
export function IssueFromStockPanel(
  { indentId, onClosed }: {
    indentId: number;
    /** Called when the issue ended the indent's approval (nothing left owed, and the
     *  issuer was the approver the stage was waiting on). The screen this panel sits
     *  on has to leave: refetching an indent that is no longer awaiting approval
     *  answers 422 and paints an error over an act that succeeded. */
    onClosed?: () => void;
  },
) {
  const queryClient = useQueryClient();
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [sources, setSources] = useState<Record<number, string>>({});
  const [reason, setReason] = useState("");
  // On by default: serving part of an indent and then sitting on the rest is the one
  // outcome nobody wants. Unticking keeps it here — for an approver issuing in two
  // goes from two of their own points before letting it move.
  const [forward, setForward] = useState(true);

  const availability = useQuery({
    queryKey: ["approvals", "availability", indentId],
    queryFn: () => approvalsApi.indentAvailability(indentId),
  });

  const issue = useMutation({
    mutationFn: () => {
      const lines = (availability.data?.items ?? [])
        .map((line) => {
          const typed = quantities[line.line_id];
          const qty = typed === undefined || typed === "" ? 0 : Number(typed);
          const warehouseId = Number(sources[line.line_id] ?? line.sources[0]?.warehouse_id ?? 0);
          return { line_id: line.line_id, warehouse_id: warehouseId, quantity: qty };
        })
        .filter((line) => line.quantity > 0 && line.warehouse_id > 0);
      return approvalsApi.issueFromStock(indentId, lines, reason, forward);
    },
    onSuccess: (result) => {
      setQuantities({});
      setReason("");
      // The host screen takes over only when it said it would; anywhere else the
      // ordinary refresh still has to run or the list keeps showing a settled row.
      if (result.closed && onClosed) {
        onClosed();
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
    },
  });

  const data = availability.data;
  if (availability.isLoading) return <Card className="mb-4 p-4 text-sm text-muted">Checking your stock…</Card>;
  if (!data) return null;

  const servable = data.items.filter((line) => line.issuable_now > 0);
  const outstanding = data.items.reduce((sum, line) => sum + line.remainder, 0);

  // Nothing owed at all: the indent is fully served and this panel has no job.
  if (outstanding === 0) {
    return (
      <Card className="mb-4 flex items-center gap-2 p-4 text-sm text-success">
        <PackageCheck className="h-4 w-4" /> Every line on this indent has been served.
      </Card>
    );
  }

  const field = "min-h-11 w-full rounded-xl border border-line bg-content1 px-3 text-sm text-ink outline-none placeholder:text-muted focus:border-brand";
  const typedTotal = Object.values(quantities)
    .reduce((sum, value) => sum + (Number(value) || 0), 0);

  return (
    <Card className="mb-4 space-y-3 p-4">
      {/* One line, not a paragraph. What issuing means is the same every time and the
          approver learns it once; repeating it above every indent buried the numbers
          they are actually here to read. The full story stays on the screen's intro. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          {servable.length === 0
            ? "You hold none of what is owed — this indent moves up as it is."
            : data.target_warehouse_name
              ? <>Delivering into <span className="text-body">{data.target_warehouse_name}</span></>
              : "Nowhere to deliver into yet."}
        </p>
        {data.target_warehouse_id
          ? <StatusPill status="ISSUE" />
          : <StatusPill status="REQUESTER NOT TAGGED" />}
      </div>

      {!data.target_warehouse_id && <p className="rounded-xl bg-warn/10 p-3 text-sm text-warn">
        The requester's position has no stocking point. Tag it under Inventory &gt; Stocking Points.
      </p>}

      <div className="space-y-3">
        {data.items.map((line) => (
          <LineRow
            key={line.line_id}
            line={line}
            field={field}
            quantity={quantities[line.line_id] ?? ""}
            source={sources[line.line_id] ?? String(line.sources[0]?.warehouse_id ?? "")}
            onQuantity={(value) => setQuantities((c) => ({ ...c, [line.line_id]: value }))}
            onSource={(value) => setSources((c) => ({ ...c, [line.line_id]: value }))}
          />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,3fr)_auto]">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Reason</span>
          <input
            className={field}
            aria-label="Reason for this issue"
            placeholder="Why this is going out"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <div className="flex items-end gap-3">
          <label className="flex min-h-11 items-center gap-2 text-sm text-body">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={forward}
              onChange={(e) => setForward(e.target.checked)}
            />
            Send the rest on
          </label>
          <Button
            disabled={typedTotal <= 0 || issue.isPending || !data.target_warehouse_id}
            onClick={() => issue.mutate()}
          >
            <PackageCheck className="h-4 w-4" />
            {issue.isPending ? "Allocating…" : "Allocate from my stock"}
          </Button>
        </div>
      </div>

      {issue.error && <p className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
        {(issue.error as Error).message}
      </p>}
      {issue.data && <p className={`rounded-xl p-3 text-sm ${issue.data.fully_served ? "bg-success/10 text-success" : "bg-brand-050 text-brand-700"}`}>
        Allocation {issue.data.allocation_no} raised for {issue.data.issued.length} item
        {issue.data.issued.length === 1 ? "" : "s"} — stock moves once it is approved.
        {issue.data.fully_served
          ? " Nothing else outstanding."
          : issue.data.forwarded
            ? ` ${fmt(issue.data.outstanding_quantity)} still owed — sent on.`
            : ` ${fmt(issue.data.outstanding_quantity)} still owed, still with you.`}
      </p>}
    </Card>
  );
}

function LineRow({ line, field, quantity, source, onQuantity, onSource }: {
  line: IndentAvailabilityLine;
  field: string;
  quantity: string;
  source: string;
  onQuantity: (value: string) => void;
  onSource: (value: string) => void;
}) {
  const uomDecimals = useUomDecimals();
  const spent = line.remainder === 0;
  // What THIS source can actually cover. "You hold" is the total across every point,
  // but an allocation comes out of one shelf, so the ceiling on the box is the chosen
  // point's own stock — capping by the total let an approver type the 10 that was
  // owed against a point holding 5 and get the error only after submitting.
  const chosen = line.sources.find((s) => String(s.warehouse_id) === source)
    ?? line.sources[0];
  const ceiling = Math.min(line.issuable_now, chosen?.available_quantity ?? 0);
  const capped = ceiling < line.issuable_now;
  return (
    // The item is the thing being decided, so its box is the only card-like surface on
    // the screen: a brand rail down the left edge, its own shadow, and the two numbers
    // lifted into chips. Everything around it is flat, so the eye lands here first and
    // reads name → owed → hold → issue in that order.
    <div className={`relative overflow-hidden rounded-2xl border bg-content1 shadow-sm transition-colors ${
      spent ? "border-line/60 opacity-60" : "border-line hover:border-brand/50"
    }`}>
      {!spent && <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-brand" />}
      <div className="grid grid-cols-1 gap-4 p-4 pl-5 lg:grid-cols-[minmax(0,2.2fr)_auto_minmax(0,1.5fr)] lg:items-center">
        <div className="min-w-0">
          <strong className="block truncate text-base font-semibold text-ink">
            {line.item_name ?? line.item_code}
          </strong>
          <p className="mt-0.5 text-xs text-muted">
            approved {fmt(line.approved_quantity)} · served {fmt(line.allocated_quantity)}
            {line.uom_code ? ` · ${line.uom_code}` : ""}
          </p>
        </div>

        <div className="flex gap-2">
          <Metric label="Still owed" value={fmt(line.remainder)} />
          <Metric label="You hold" value={fmt(line.available_at_my_points)} good={line.available_at_my_points > 0} />
        </div>

        <div className="flex gap-2">
        <label className="block flex-1">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Issue</span>
          <QuantityInput
            className={field}
            decimals={uomDecimals(line.uom_code)}
            min={0}
            max={ceiling}
            aria-label={`Issue quantity for ${line.item_name ?? line.item_code}`}
            placeholder={fmt(ceiling)}
            disabled={ceiling <= 0}
            value={quantity}
            onChange={onQuantity}
          />
          {/* Said before submitting, not after. The gap between "you hold 505" and
              "this shelf has 5" is the whole confusion, so it is named where the
              number is typed rather than left to a server error. */}
          {capped && <span className="mt-1 block text-xs text-warn">
            This point holds {fmt(chosen?.available_quantity ?? 0)} of the {fmt(line.remainder)} owed
            {line.sources.length > 1 ? " — pick another point for the rest" : ""}
          </span>}
        </label>
        {/* Always shown, even with one option: the source is part of what is being
            committed, so the approver should see which point it comes out of rather
            than have it chosen silently. Only points in their own reporting subtree
            are ever listed — the server refuses anything else. */}
        {line.sources.length > 0 && (
          <label className="block flex-1">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">From</span>
            <select
              className={field}
              aria-label={`Source point for ${line.item_name ?? line.item_code}`}
              value={source}
              onChange={(e) => onSource(e.target.value)}
            >
              {line.sources.map((option) => (
                <option key={option.warehouse_id} value={option.warehouse_id}>
                  {option.warehouse_name ?? `Point ${option.warehouse_id}`} · {fmt(option.available_quantity)}
                </option>
              ))}
            </select>
          </label>
        )}
        </div>
      </div>
    </div>
  );
}

/** One number on the item box. A chip rather than a stacked label so the two figures
 *  the decision turns on — what is owed and what you hold — read as a pair. */
function Metric({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="min-w-23 rounded-xl bg-content2 px-3 py-2">
      <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</span>
      <span className={`block tabular text-sm font-semibold ${good ? "text-ok" : "text-ink"}`}>{value}</span>
    </div>
  );
}
