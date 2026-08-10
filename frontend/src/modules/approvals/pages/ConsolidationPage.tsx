import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Check, Layers, RefreshCw, Search, Users } from "lucide-react";
import {
  Button, Card, PageHeader, ResponsiveList, Select, StatCard, StatusPill, type Column,
} from "@/shared/components";
import { approvalsApi } from "../api";
import { IssueFromStockPanel } from "../components/IssueFromStockPanel";
import type {
  ConsolidatedItem, ConsolidatedItemAllocation, ConsolidationApprovalResult,
  ConsolidationBatch, ConsolidationDimension, ConsolidationFilterOptions,
  ConsolidationIndentSummary, ConsolidationQuery,
} from "../types";

/** Indents per approve request. Small enough that no single call can outlive a
 *  gateway timeout on a monthly batch, large enough that a normal batch is one call. */
const APPROVE_CHUNK = 25;

const formatQty = (value: number) => {
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
};

/** Split `total` across `weights` in proportion, losing nothing to rounding.
 *
 *  Largest remainder (Hamilton): everyone takes their whole units first, then the
 *  units left over go to the biggest fractions. 45 across five equal 10s is 9/9/9/9/9;
 *  43 is 9/9/9/8/8 — never 8.6 five times, because an indent line is a quantity a
 *  storekeeper has to issue. A non-integer total is split on the same rule at three
 *  decimals, so a UOM measured in litres still adds back up exactly.
 */
export function splitQuantity(total: number, weights: number[]): number[] {
  const sum = weights.reduce((acc, w) => acc + Math.max(0, w), 0);
  if (!(total > 0) || sum <= 0) return weights.map(() => 0);

  const scale = Number.isInteger(total) ? 1 : 1000;
  const units = Math.round(total * scale);
  const raw = weights.map((w) => (Math.max(0, w) / sum) * units);
  const base = raw.map((value) => Math.floor(value));
  let left = units - base.reduce((acc, value) => acc + value, 0);

  // Biggest fraction first; a tie goes to the bigger request, then to the earlier row,
  // so the same numbers always produce the same split.
  const order = raw
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => (b.frac - a.frac)
      || (weights[b.index] - weights[a.index])
      || (a.index - b.index));

  for (const { index } of order) {
    if (left <= 0) break;
    base[index] += 1;
    left -= 1;
  }
  return base.map((value) => value / scale);
}

/** Indent numbers typed into an item's exclude box, split on commas/spaces/newlines. */
const parseExcluded = (text: string): string[] =>
  text.split(/[\s,;]+/).map((token) => token.trim().toUpperCase()).filter(Boolean);

const isExcluded = (allocation: ConsolidatedItemAllocation, excluded: string[]) =>
  excluded.some((token) => allocation.indent_no.toUpperCase().includes(token));

interface ItemDecision { approved: string; exclude: string }

/** What one item row currently resolves to: the approver's total, who is out, and
 *  the per-indent split of what is left. Pure — the screen recomputes it on every
 *  keystroke rather than storing a split that could go stale against its inputs. */
function resolveItem(item: ConsolidatedItem, decision: ItemDecision | undefined) {
  const allocations = item.allocations ?? [];
  const excluded = parseExcluded(decision?.exclude ?? "");
  const included = allocations.filter((a) => !isExcluded(a, excluded));
  const droppedCount = allocations.length - included.length;

  const typed = decision?.approved?.trim();
  const parsed = typed === undefined || typed === "" ? null : Number(typed);
  const invalid = parsed !== null && (Number.isNaN(parsed) || parsed < 0);
  const ceiling = item.total_ceiling_quantity;
  const over = parsed !== null && !invalid && parsed > ceiling;
  const total = parsed === null || invalid ? ceiling : Math.min(parsed, ceiling);

  const shares = splitQuantity(total, included.map((a) => a.requested_quantity));
  const split = new Map<number, number>(allocations.map((a) => [a.line_id, 0]));
  included.forEach((a, index) => split.set(a.line_id, shares[index]));

  return { allocations, included, droppedCount, invalid, over, ceiling, total, split };
}

/** The filter bar, in display order. `param` is the query param the backend reads;
 *  `dimension` is the key its dropdown values arrive under.
 *
 *  There is no Phase row: `ind_indents` has no phase column and this screen does not
 *  invent one. Any dimension whose option list comes back empty (no indent in the
 *  queue carries a vehicle, say) is dropped below, so the bar only ever shows
 *  controls that can actually narrow something. */
const FILTERS: { dimension: ConsolidationDimension; param: keyof ConsolidationQuery; label: string }[] = [
  { dimension: "cycle", param: "cycle", label: "Month" },
  { dimension: "region", param: "region_id", label: "Region" },
  { dimension: "project", param: "project_id", label: "Project" },
  { dimension: "vehicle", param: "vehicle_id", label: "Vehicle" },
  { dimension: "office", param: "office_id", label: "Office" },
  { dimension: "requester", param: "requester_id", label: "Requester" },
  { dimension: "item", param: "item_id", label: "Item" },
];

function FilterBar({ options, value, onChange, onClear, search, onSearch }: {
  options: ConsolidationFilterOptions;
  value: ConsolidationQuery;
  onChange: (next: ConsolidationQuery) => void;
  onClear: () => void;
  search: string;
  onSearch: (next: string) => void;
}) {
  const active = FILTERS.filter((f) => (options[f.dimension] ?? []).length > 0);
  const applied = Object.values(value).filter(Boolean).length;
  const field = "min-h-11 w-full rounded-xl border border-line bg-content1 px-3 text-sm text-ink outline-none placeholder:text-muted focus:border-brand-500";

  return (
    <Card className="mb-4 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Filters</p>
        <Button variant="ghost" disabled={applied === 0} onClick={onClear}>
          Clear filters{applied > 0 ? ` (${applied})` : ""}
        </Button>
      </div>

      {/* Search and the raised-on window sit above the dropdowns and are always
          offered: unlike a dimension, they need no values in the queue to be useful. */}
      <div className="mb-3 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Search</span>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              className={`${field} pl-9`}
              type="search"
              aria-label="Search consolidations"
              placeholder="Indent no., requester, item, region…"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
            />
          </div>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Raised from</span>
          <input
            className={field}
            type="date"
            aria-label="Raised from"
            value={value.raised_from ?? ""}
            onChange={(e) => onChange({ ...value, raised_from: e.target.value || undefined })}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Raised to</span>
          <input
            className={field}
            type="date"
            aria-label="Raised to"
            value={value.raised_to ?? ""}
            onChange={(e) => onChange({ ...value, raised_to: e.target.value || undefined })}
          />
        </label>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {active.map((filter) => (
          <Select
            key={filter.param}
            label={filter.label}
            placeholder={`All ${filter.label.toLowerCase()}s`}
            value={value[filter.param] ?? ""}
            onChange={(next) => onChange({ ...value, [filter.param]: next || undefined })}
            options={(options[filter.dimension] ?? []).map((option) => ({
              value: option.value,
              label: `${option.label} (${option.indent_count})`,
            }))}
          />
        ))}
      </div>
    </Card>
  );
}

/** The per-indent result of an item's approved total, shown under the row it came
 *  from so the approver sees who loses what before deciding. */
function SplitBreakdown({ item, decision }: { item: ConsolidatedItem; decision: ItemDecision | undefined }) {
  const { allocations, included, droppedCount, split, total } = resolveItem(item, decision);
  if (allocations.length === 0) return <span className="text-xs text-muted">—</span>;

  return (
    <div className="space-y-1">
      {allocations.map((allocation) => {
        const share = split.get(allocation.line_id) ?? 0;
        const out = !included.includes(allocation);
        return (
          <p key={allocation.line_id} className={`text-xs ${out ? "text-muted line-through" : "text-body"}`}>
            <span className="font-mono">{allocation.indent_no}</span>
            {" · "}{formatQty(allocation.requested_quantity)} → <strong>{formatQty(share)}</strong>
          </p>
        );
      })}
      <p className="text-xs text-muted">
        Allocated {formatQty(total)} across {included.length} indent{included.length === 1 ? "" : "s"}
        {droppedCount > 0 ? ` · ${droppedCount} excluded` : ""}
      </p>
    </div>
  );
}

/** One consolidated item: what was asked for, what this approver is passing on, who
 *  is being left out, and the resulting per-indent split — all on one row.
 *
 *  Plain `<input>`s rather than the HeroUI field kit: this row lives outside a table
 *  on purpose (see the note at its call site) and a native input is also what makes
 *  the browser's own `<datalist>` suggestion list work for the exclude box.
 */
function ItemEditor({ item, batchKey, decision, onChange }: {
  item: ConsolidatedItem;
  batchKey: string;
  decision: ItemDecision | undefined;
  onChange: (patch: Partial<ItemDecision>) => void;
}) {
  const { invalid, over, ceiling, droppedCount } = resolveItem(item, decision);
  const listId = `exclude-${batchKey}-${item.item_id}`;
  const field = "min-h-11 w-full rounded-xl border border-line bg-content1 px-3 text-sm text-ink outline-none placeholder:text-muted focus:border-brand-500";

  return (
    <div className="rounded-2xl border border-line/70 bg-content1 p-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1.6fr)]">
        <div>
          <strong className="text-ink">{item.item_name ?? item.item_code}</strong>
          <p className="text-xs text-muted">{item.item_code}{item.uom_code ? ` · ${item.uom_code}` : ""}</p>
          <p className="mt-1 text-xs text-muted">
            {item.indent_count} indent{item.indent_count === 1 ? "" : "s"}
            {" · requested "}{formatQty(item.total_requested_quantity)}
            {" · approvable "}{formatQty(ceiling)}
          </p>
        </div>

        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Approve (total)</span>
          <input
            className={field}
            type="number"
            min={0}
            max={ceiling}
            step="any"
            inputMode="decimal"
            aria-label={`Approved quantity for ${item.item_name ?? item.item_code}`}
            placeholder={formatQty(ceiling)}
            value={decision?.approved ?? ""}
            onChange={(e) => onChange({ approved: e.target.value })}
          />
          {(invalid || over) && <span className="mt-1 block text-xs text-danger">
            {invalid ? "Enter a quantity of 0 or more." : `Capped at ${formatQty(ceiling)}.`}
          </span>}
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Exclude indents</span>
          <input
            className={field}
            list={listId}
            aria-label={`Indents to exclude for ${item.item_name ?? item.item_code}`}
            placeholder="Type or pick an indent no."
            value={decision?.exclude ?? ""}
            onChange={(e) => onChange({ exclude: e.target.value })}
          />
          <datalist id={listId}>
            {(item.allocations ?? []).map((a) => (
              <option key={a.line_id} value={a.indent_no}>{a.requested_by_name ?? ""}</option>
            ))}
          </datalist>
          <span className="mt-1 block text-xs text-muted">
            {droppedCount > 0
              ? `${droppedCount} getting nothing — their share goes to the rest`
              : "Separate several with commas"}
          </span>
        </label>

        <div>
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Per-indent split</span>
          <SplitBreakdown item={item} decision={decision} />
        </div>
      </div>
    </div>
  );
}

/** A consolidation has no document number — it is a GROUP BY over the pending queue,
 *  computed fresh on every request and stored nowhere. This reference is derived from
 *  the cycle it groups, so it is stable for as long as the cycle is, and it never
 *  pretends to be a saved document id. */
export const batchRef = (batch: ConsolidationBatch) => `CONS-${batch.cycle}`;

const batchTotalRequested = (batch: ConsolidationBatch) =>
  batch.consolidated_items.reduce((sum, item) => sum + item.total_requested_quantity, 0);

/** The workspace's front door: one row per consolidation, in the shape of the All
 *  requests list. Opening a row is what reveals the quantity editor — the same
 *  drill-down an indent gets, so the two screens read the same way. */
function BatchList({ batches, onOpen }: {
  batches: ConsolidationBatch[];
  onOpen: (batch: ConsolidationBatch) => void;
}) {
  const columns: Column<ConsolidationBatch>[] = [
    {
      key: "ref",
      header: "Consolidation",
      render: (row) => <div>
        <strong className="font-mono text-ink">{batchRef(row)}</strong>
        <p className="text-xs text-muted">{row.month_label}</p>
      </div>,
    },
    { key: "indents", header: "Indents", render: (row) => row.indent_count },
    { key: "items", header: "Items", render: (row) => row.consolidated_items.length },
    {
      key: "requesters",
      header: "Requesters",
      hideOnNarrow: true,
      render: (row) => <span className="block max-w-[22ch] truncate">{row.requesters.join(", ") || "—"}</span>,
    },
    {
      key: "scope",
      header: "Scope",
      hideOnNarrow: true,
      render: (row) => <span className="text-muted">
        {[row.region_name, row.project_name].filter(Boolean).join(" · ")
          || `${row.region_count} region${row.region_count === 1 ? "" : "s"} · ${row.project_count} project${row.project_count === 1 ? "" : "s"}`}
      </span>,
    },
    { key: "requested", header: "Requested (total)", render: (row) => formatQty(batchTotalRequested(row)) },
    { key: "stage", header: "Stage", render: (row) => <StatusPill status={row.current_stage_name ?? "PENDING"} /> },
  ];

  return (
    <ResponsiveList
      data={batches}
      columns={columns}
      keyOf={(row) => row.batch_key}
      onRowClick={onOpen}
      empty="No Monthly indents are waiting for your consolidated approval."
      renderCard={(row) => <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0">
            <strong className="block truncate font-mono text-ink">{batchRef(row)}</strong>
            <span className="mt-1 block truncate text-xs text-muted">{row.month_label}</span>
          </span>
          <StatusPill status={row.current_stage_name ?? "PENDING"} />
        </div>
        <p className="text-xs text-muted">
          {row.indent_count} indent{row.indent_count === 1 ? "" : "s"}
          {" · "}{row.consolidated_items.length} item{row.consolidated_items.length === 1 ? "" : "s"}
          {" · requested "}{formatQty(batchTotalRequested(row))}
        </p>
        <p className="truncate text-xs text-muted">{row.requesters.join(", ") || "—"}</p>
      </div>}
    />
  );
}

export function BatchCard({ batch, onBack }: {
  batch: ConsolidationBatch;
  /** Where "everything here is approved" goes. The screen's own header owns the
   *  visible Back control; this fires when the batch itself is finished with. */
  onBack: () => void;
}) {
  // Keyed by item id, one per row of the consolidated item table. Local to the screen:
  // nothing is written until the approver acts on the indents themselves.
  const [decisions, setDecisions] = useState<Record<number, ItemDecision>>({});
  const [result, setResult] = useState<ConsolidationApprovalResult | null>(null);
  // How many indents the running approval has got through, so a batch of hundreds
  // shows movement instead of a frozen button.
  const [progress, setProgress] = useState(0);
  const queryClient = useQueryClient();
  const setDecision = (itemId: number, patch: Partial<ItemDecision>) =>
    setDecisions((current) => ({
      ...current,
      [itemId]: { ...(current[itemId] ?? { approved: "", exclude: "" }), ...patch },
    }));

  // A bad number anywhere in the batch blocks the whole approval: the split it feeds
  // would be wrong for every indent holding that item, not just one.
  const blocked = batch.consolidated_items.some((item) => {
    const { invalid, over } = resolveItem(item, decisions[item.item_id]);
    return invalid || over;
  });

  const approve = useMutation({
    mutationFn: async () => {
      const indentIds = batch.indents.map((row) => row.id);
      // Every item's split, flattened. A line nobody edited still ships its share,
      // because the split of an untouched item is simply its full ceiling.
      const lines = batch.consolidated_items.flatMap((item) => {
        const { split } = resolveItem(item, decisions[item.item_id]);
        return (item.allocations ?? []).map((allocation) => ({
          indent_id: allocation.indent_id,
          line_id: allocation.line_id,
          approved_quantity: split.get(allocation.line_id) ?? 0,
        }));
      });

      // Sent in chunks, not one request. The backend walks the batch one indent at a
      // time — engine-owned chains cannot be short-cut — so a monthly cycle of several
      // hundred indents would sit on a single request long past any gateway timeout,
      // and a timeout mid-walk leaves the approver unable to tell what went through.
      // The call is already non-atomic across indents by design, so splitting it
      // changes nothing about the outcome, only how long any one request is held open.
      const chunks: number[][] = [];
      for (let i = 0; i < indentIds.length; i += APPROVE_CHUNK) {
        chunks.push(indentIds.slice(i, i + APPROVE_CHUNK));
      }
      const merged: ConsolidationApprovalResult = {
        approved_count: 0, approved_indent_ids: [], failed: [],
      };
      for (const chunk of chunks) {
        const ids = new Set(chunk);
        const part = await approvalsApi.approveConsolidation({
          indent_ids: chunk,
          lines: lines.filter((line) => ids.has(line.indent_id)),
        });
        merged.approved_count += part.approved_count;
        merged.approved_indent_ids.push(...part.approved_indent_ids);
        merged.failed.push(...part.failed);
        setProgress(merged.approved_count + merged.failed.length);
      }
      return merged;
    },
    onSuccess: (data) => {
      setResult(data);
      // The approved indents leave this approver's queue, so the workspace has to be
      // re-read rather than patched.
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
      // Nothing failed means nothing is left here — go back rather than leave the
      // approver staring at a consolidation that is about to empty out.
      // Skips are a normal outcome, not something to stay and look at. Only a real
      // problem keeps the approver on this screen.
      if (data.failed.every((f) => f.skipped)) onBack();
    },
  });

  const indentColumns: Column<ConsolidationIndentSummary>[] = [
    { key: "indent", header: "Indent", render: (row) => <div><strong className="font-mono text-ink">{row.indent_no}</strong><p className="text-xs text-muted">{row.line_count} line{row.line_count === 1 ? "" : "s"}</p></div> },
    { key: "requester", header: "Requester", render: (row) => row.requested_by_name ?? "—" },
    { key: "region", header: "Region", hideOnNarrow: true, render: (row) => row.region_name ?? "—" },
    { key: "project", header: "Project", hideOnNarrow: true, render: (row) => row.project_name ?? "—" },
    { key: "office", header: "Office", hideOnNarrow: true, render: (row) => row.office_name ?? "—" },
    { key: "vehicle", header: "Vehicle", hideOnNarrow: true, render: (row) => row.vehicle_number ?? "—" },
    { key: "requested", header: "Requested", render: (row) => formatQty(row.total_requested_quantity) },
    { key: "previous", header: "Previously approved", hideOnNarrow: true, render: (row) => row.previous_approved_quantity === null || row.previous_approved_quantity === undefined ? "—" : formatQty(row.previous_approved_quantity) },
    { key: "ceiling", header: "Approvable now", render: (row) => formatQty(row.current_ceiling_quantity) },
    { key: "stage", header: "Stage", hideOnNarrow: true, render: (row) => <StatusPill status={row.current_stage_name ?? "PENDING"} /> },
  ];

  return (
    <Card className="mb-4 space-y-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs font-semibold uppercase tracking-wide text-muted">{batchRef(batch)}</p>
          <h3 className="text-lg font-semibold text-ink">{batch.month_label}</h3>
          <p className="mt-1 text-sm text-body">
            {batch.indent_count} pending monthly indent{batch.indent_count === 1 ? "" : "s"}
            {" · "}{batch.requester_count} requester{batch.requester_count === 1 ? "" : "s"}
            {batch.project_count > 0 ? ` · ${batch.project_count} project${batch.project_count === 1 ? "" : "s"}` : ""}
            {batch.region_count > 0 ? ` · ${batch.region_count} region${batch.region_count === 1 ? "" : "s"}` : ""}
          </p>
          <p className="mt-1 flex items-center gap-1 text-xs text-muted">
            <Users className="h-3.5 w-3.5" /> {batch.requesters.join(", ")}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <StatusPill status={batch.current_stage_name ?? "PENDING"} />
          <Button
            disabled={blocked || approve.isPending || batch.indents.length === 0}
            onClick={() => { setProgress(0); approve.mutate(); }}
          >
            <Check className="h-4 w-4" />
            {approve.isPending
              ? `Approving… ${progress}/${batch.indents.length}`
              : `Approve all ${batch.indents.length}`}
          </Button>
        </div>
      </div>

      {blocked && <p className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
        Fix the quantities above before approving.
      </p>}
      {approve.error && <p className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
        {(approve.error as Error).message}
      </p>}
      {result && (() => {
        // An indent that was already served in full is SKIPPED, not failed: leaving it
        // where it is was the right call, and colouring that red made the screen look
        // broken every time the cascade worked.
        const skipped = result.failed.filter((f) => f.skipped);
        const problems = result.failed.filter((f) => !f.skipped);
        return (
          <p className={`rounded-xl p-3 text-sm ${problems.length > 0 ? "bg-warn/10 text-warn" : "bg-success/10 text-success"}`}>
            Sent on {result.approved_count} indent{result.approved_count === 1 ? "" : "s"}.
            {skipped.length > 0 && ` ${skipped.length} already served in full — left where they are.`}
            {problems.length > 0 && ` ${problems.length} could not be approved: ${problems.map((f) => f.reason).join("; ")}`}
          </p>
        );
      })()}

      {/* An editor, not a list — deliberately not <ResponsiveList>. Its table is a
          react-aria grid, and a grid cell swallows the keystrokes an <input> needs,
          so an editable quantity inside one silently refuses to type. */}
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Consolidated item quantities</p>
        {batch.consolidated_items.length === 0
          ? <div className="rounded-2xl border border-line/70 bg-content1 py-10 text-center text-muted">No items on this batch.</div>
          : <div className="space-y-3">
              {batch.consolidated_items.map((item) => (
                <ItemEditor
                  key={item.item_id}
                  item={item}
                  batchKey={batch.batch_key}
                  decision={decisions[item.item_id]}
                  onChange={(patch) => setDecision(item.item_id, patch)}
                />
              ))}
            </div>}
      </div>

      <div>
        {/* Serve-from-stock, per indent. A consolidation is a view over several
            documents, and stock is issued INTO the raiser's own point — so there is
            no single "issue the batch": each indent's goods go somewhere different. */}
        <details className="mb-3 rounded-2xl border border-line/70 bg-content1 p-3">
          <summary className="cursor-pointer text-sm font-semibold text-ink">
            Serve these indents from your own stock
          </summary>
          <div className="mt-3 space-y-3">
            {batch.indents.map((row) => (
              <div key={row.id}>
                <p className="mb-1 font-mono text-xs text-muted">{row.indent_no}</p>
                <IssueFromStockPanel indentId={row.id} />
              </div>
            ))}
          </div>
        </details>

        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Matching indents</p>
        <ResponsiveList
          data={batch.indents}
          columns={indentColumns}
          keyOf={(row) => row.id}
          empty="No indents in this batch."
          renderCard={(row) => <div className="space-y-2">
            <div className="flex justify-between gap-2"><strong className="font-mono text-ink">{row.indent_no}</strong><StatusPill status={row.current_stage_name ?? "PENDING"} /></div>
            <p className="text-sm text-body">{row.requested_by_name ?? "—"}</p>
            <p className="text-xs text-muted">
              {[row.region_name, row.project_name, row.office_name, row.vehicle_number].filter(Boolean).join(" · ") || "—"}
            </p>
            <p className="text-xs text-muted">Requested {formatQty(row.total_requested_quantity)} · Approvable now {formatQty(row.current_ceiling_quantity)}</p>
          </div>}
        />
      </div>
    </Card>
  );
}

export function ConsolidationPage() {
  const nav = useNavigate();
  const [filters, setFilters] = useState<ConsolidationQuery>({});
  // Typing is debounced into `filters` so every keystroke does not become a request;
  // the box itself stays instant because it renders from its own state.
  const [searchText, setSearchText] = useState("");
  useEffect(() => {
    const timer = setTimeout(
      () => setFilters((current) => ({ ...current, search: searchText.trim() || undefined })),
      300,
    );
    return () => clearTimeout(timer);
  }, [searchText]);
  // Filters are part of the key, so each combination is cached; placeholderData keeps
  // the previous result on screen while the next one loads, so the bar never flickers
  // back to an empty workspace between keystrokes.
  const query = useQuery({
    queryKey: ["approvals", "consolidation", filters],
    queryFn: () => approvalsApi.consolidation(filters),
    placeholderData: keepPreviousData,
  });
  const data = query.data;
  const batches = data?.items ?? [];

  const appliedCount = useMemo(
    () => Object.values(filters).filter(Boolean).length, [filters],
  );

  return <>
    <PageHeader
      eyebrow="Approvals"
      title="Consolidation"
      actions={<Button variant="ghost" disabled={query.isFetching} onClick={() => query.refetch()}>
        <RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} /> Refresh
      </Button>}
    />
    <p className="mb-4 text-sm text-body">
      One row per consolidation — every Monthly indent waiting on you, grouped by
      monthly cycle. Region, project, office, vehicle, requester and item narrow what
      is inside a cycle; they never split it into separate approvals. Open a
      consolidation to set quantities and approve it.
    </p>

    {data && <>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Indents shown" value={data.total_indent_count} icon={<Layers className="h-4 w-4" />} />
        <StatCard label="Requesters" value={data.total_requester_count} icon={<Users className="h-4 w-4" />} />
        <StatCard label="Consolidations" value={batches.length} />
        <StatCard
          label={appliedCount > 0 ? "Filtered out" : "All pending"}
          value={appliedCount > 0
            ? `${data.unfiltered_indent_count - data.total_indent_count} of ${data.unfiltered_indent_count}`
            : data.unfiltered_indent_count}
        />
      </div>
      <FilterBar
        options={data.filter_options}
        value={filters}
        onChange={setFilters}
        onClear={() => { setSearchText(""); setFilters({}); }}
        search={searchText}
        onSearch={setSearchText}
      />
    </>}

    {query.error
      ? <p className="rounded-xl bg-danger/10 p-4 text-sm text-danger">{(query.error as Error).message}</p>
      : query.isLoading
        ? <Card className="p-8 text-center text-muted">Loading…</Card>
        : batches.length === 0
          ? <Card className="flex flex-col items-center gap-2 p-10 text-center text-muted">
              <Layers className="h-6 w-6" />
              {appliedCount > 0
                ? "No Monthly indents match these filters."
                : "No Monthly indents are waiting for your consolidated approval."}
              {appliedCount > 0 && <Button variant="ghost" onClick={() => setFilters({})}>Clear filters</Button>}
            </Card>
          : <BatchList
              batches={batches}
              onOpen={(batch) => nav(`/approvals/consolidation/${encodeURIComponent(batch.batch_key)}`)}
            />}
  </>;
}
