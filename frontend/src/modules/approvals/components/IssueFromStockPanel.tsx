import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageCheck } from "lucide-react";
import { Button, Card, StatusPill } from "@/shared/components";
import { approvalsApi } from "../api";
import type { IndentAvailabilityLine } from "../types";

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
export function IssueFromStockPanel({ indentId }: { indentId: number }) {
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
    onSuccess: () => {
      setQuantities({});
      setReason("");
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

  const field = "min-h-11 w-full rounded-xl border border-line bg-content1 px-3 text-sm text-ink outline-none placeholder:text-muted focus:border-brand-500";
  const typedTotal = Object.values(quantities)
    .reduce((sum, value) => sum + (Number(value) || 0), 0);

  return (
    <Card className="mb-4 space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Serve from your own stock</p>
          <p className="mt-1 text-sm text-body">
            {servable.length > 0
              ? "Commit what you hold now — this raises an allocation for approval; the goods leave the shelf at the warehouse material issue. Whatever is left stays on this indent and goes up to the next approver."
              : "You hold none of what is still owed, so this indent moves up as it is."}
          </p>
          {data.target_warehouse_name && (
            <p className="mt-1 text-xs text-muted">Delivering into {data.target_warehouse_name}.</p>
          )}
        </div>
        {data.target_warehouse_id
          ? <StatusPill status="ISSUE" />
          : <StatusPill status="REQUESTER NOT TAGGED" />}
      </div>

      {!data.target_warehouse_id && <p className="rounded-xl bg-warn/10 p-3 text-sm text-warn">
        The requester's position is not tagged to a stocking point, so there is nowhere
        to issue into. Tag it under Inventory &gt; Stocking Points first.
      </p>}

      <div className="space-y-2">
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
            placeholder="Why this is going out — e.g. camp stock, urgent replacement"
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
        Allocation {issue.data.allocation_no} raised for {issue.data.issued.length} line
        {issue.data.issued.length === 1 ? "" : "s"}. Nothing has moved yet — the stock is
        handed over at the warehouse material issue once this allocation is approved.
        {issue.data.fully_served
          ? " Nothing else is outstanding on this indent."
          : issue.data.forwarded
            ? ` ${fmt(issue.data.outstanding_quantity)} still owed — sent on to the next approver.`
            : ` ${fmt(issue.data.outstanding_quantity)} still owed, and this indent is still with you.`}
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
  const spent = line.remainder === 0;
  return (
    <div className={`grid grid-cols-1 gap-3 rounded-xl border border-line/70 p-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)] ${spent ? "opacity-60" : ""}`}>
      <div>
        <strong className="text-ink">{line.item_name ?? line.item_code}</strong>
        <p className="text-xs text-muted">
          approved {fmt(line.approved_quantity)} · served {fmt(line.allocated_quantity)}
          {line.uom_code ? ` · ${line.uom_code}` : ""}
        </p>
      </div>
      <div>
        <span className="block text-xs font-semibold uppercase tracking-wide text-muted">Still owed</span>
        <span className="text-sm text-ink">{fmt(line.remainder)}</span>
      </div>
      <div>
        <span className="block text-xs font-semibold uppercase tracking-wide text-muted">You hold</span>
        <span className={`text-sm ${line.available_at_my_points > 0 ? "text-ink" : "text-muted"}`}>
          {fmt(line.available_at_my_points)}
        </span>
      </div>
      <div className="flex gap-2">
        <label className="block flex-1">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Issue</span>
          <input
            className={field}
            type="number"
            min={0}
            max={line.issuable_now}
            step="any"
            aria-label={`Issue quantity for ${line.item_name ?? line.item_code}`}
            placeholder={fmt(line.issuable_now)}
            disabled={line.issuable_now <= 0}
            value={quantity}
            onChange={(e) => onQuantity(e.target.value)}
          />
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
  );
}
