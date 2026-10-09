import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  CalendarRange, Check, ChevronDown, ChevronRight, Filter, Layers, PackageCheck,
  RefreshCw, Search, SlidersHorizontal, Users, X,
} from "lucide-react";
import {
  Button, Card, EmptyState, ErrorBanner, PageHeader, ResponsiveList, Select, StatCard,
  StatusPill, type Column,
} from "@/shared/components";
import { splitQuantity } from "@/shared/quantity";
import { approvalsApi } from "../api";
import { useConsolidationDecisions, type ItemDecision } from "../consolidationDecisions";
import type {
  ConsolidatedItem, ConsolidatedItemAllocation, ConsolidationApprovalResult,
  ConsolidationBatch, ConsolidationDimension, ConsolidationFilterOptions,
  ConsolidationQuery,
} from "../types";
import { TONE_APPROVE } from "@/shared/components/tones";

/** Indents per approve request. Small on purpose: the bar only moves when a chunk
 *  comes back, so 25 meant an approver watched "0 of 41" for minutes and assumed the
 *  screen had hung. Small chunks also bound what one dropped connection costs — the
 *  chunks already through are committed and stay approved. */
const APPROVE_CHUNK = 5;

export const formatQty = (value: number) => {
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
};

/** The proportional split, capped per indent and stepped to the unit. It lives in
 *  `@/shared/quantity` because the fulfilment queue divides stock the same way and the
 *  two screens must never propose different numbers; re-exported here because this is
 *  where the module has always imported it from. */
export { splitQuantity };

/** Exclusion is by exact indent number — the list comes from picking real indents off
 *  the item's own page, never from free text that could half-match two of them.
 *
 *  `is_excluded` is the SERVER's answer: a rung below already dropped this line and it
 *  stays dropped, whatever this approver's draft says. Without it the same line was
 *  offered an Exclude button at every rung (BUG_SCM_0008) and came up as an ordinary
 *  zero once excluded (BUG_SCM_0007). */
export const isExcluded = (allocation: ConsolidatedItemAllocation, excluded: string[]) =>
  Boolean(allocation.is_excluded)
  || excluded.includes(allocation.indent_no.toUpperCase());

/** What one item row currently resolves to: the approver's total, who is out, and
 *  the per-indent split of what is left. Pure — the screen recomputes it on every
 *  keystroke rather than storing a split that could go stale against its inputs. */
export function resolveItem(item: ConsolidatedItem, decision: ItemDecision | undefined) {
  const allocations = item.allocations ?? [];
  const excluded = (decision?.excluded ?? []).map((no) => no.toUpperCase());
  const included = allocations.filter((a) => !isExcluded(a, excluded));
  const droppedCount = allocations.length - included.length;

  /** The most one indent may be passed on this item: what the rung below approved for
   *  it, falling back to the request at the first rung. Never its share of somebody
   *  else's ask. */
  const capOf = (allocation: ConsolidatedItemAllocation) =>
    Number.isFinite(allocation.ceiling_quantity)
      ? allocation.ceiling_quantity
      : allocation.requested_quantity;

  const typed = decision?.approved?.trim();
  const parsed = typed === undefined || typed === "" ? null : Number(typed);
  const invalid = parsed !== null && (Number.isNaN(parsed) || parsed < 0);
  // The batch total is worth no more than the ceilings still in play. Excluding an
  // indent takes its ceiling out with it — offering the item's full total afterwards
  // proposed quantities nobody was entitled to receive.
  const ceiling = included.length === allocations.length
    ? item.total_ceiling_quantity
    : included.reduce((sum, a) => sum + capOf(a), 0);
  const over = parsed !== null && !invalid && parsed > ceiling;
  // Stepped to the unit BEFORE anything is shown or split. UOM-BOX is a countable
  // unit, so 1.3 boxes is not a quantity — but the box only refused to step the
  // arrows, and a typed 1.3 sailed through: the header read "1.3 going out", the
  // split handed 1 to one indent and 0 to the rest, and 0.3 of a box existed
  // nowhere. Down, like every other quantity door in the system, so a number that
  // has cleared the ceiling can never grow back over it.
  const stepped = (value: number) => {
    const places = item.uom_decimals ?? 3;
    const factor = 10 ** places;
    return Math.floor(value * factor) / factor;
  };
  const total = parsed === null || invalid
    ? stepped(ceiling)
    : stepped(Math.min(parsed, ceiling));
  /** The typed number carried more precision than the unit has. The screen says so
   *  rather than silently showing a different figure than the one keyed in. */
  const rounded = parsed !== null && !invalid && !over && stepped(parsed) !== parsed;

  const shares = splitQuantity(
    total,
    included.map((a) => a.requested_quantity),
    included.map(capOf),
    item.uom_decimals,
  );
  const split = new Map<number, number>(allocations.map((a) => [a.line_id, 0]));
  included.forEach((a, index) => split.set(a.line_id, shares[index]));

  return { allocations, included, droppedCount, invalid, over, rounded,
           ceiling, total, split };
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

/** How many dimension dropdowns stay on the bar itself. Search, the raised-on window
 *  and two dropdowns is one line on a laptop; the other five turned the bar into a
 *  form of its own, so they live behind "More filters" and announce themselves with a
 *  count when something inside is set. */
const PRIMARY_FILTERS = 2;

function FilterBar({ options, value, onChange, onClear, search, onSearch }: {
  options: ConsolidationFilterOptions;
  value: ConsolidationQuery;
  onChange: (next: ConsolidationQuery) => void;
  onClear: () => void;
  search: string;
  onSearch: (next: string) => void;
}) {
  const active = FILTERS.filter((f) => (options[f.dimension] ?? []).length > 0);
  const primary = active.slice(0, PRIMARY_FILTERS);
  const extra = active.slice(PRIMARY_FILTERS);
  const applied = {
    /** Everything narrowing the workspace, dropdowns and dates and search alike. */
    count: Object.values(value).filter(Boolean).length,
    /** The ones folded away behind "More filters" — what the chip row announces. */
    hidden: extra.filter((f) => value[f.param]),
  };
  const [open, setOpen] = useState(false);

  const control = "h-11 rounded-xl border border-line bg-content1 text-sm text-ink outline-none focus:border-brand";
  const optionsFor = (filter: typeof FILTERS[number]) =>
    (options[filter.dimension] ?? []).map((option) => ({
      value: option.value,
      label: `${option.label} (${option.indent_count})`,
    }));
  /** The chosen option's own name, so a chip reads "Region · North" and not an id.
   *  Falls back to the raw value if the option list has moved on under it. */
  const optionLabel = (filter: typeof FILTERS[number], picked: string | undefined) =>
    (options[filter.dimension] ?? []).find((option) => option.value === picked)?.label ?? picked;

  return (
    <Card className="mb-4 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-55 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            className={`${control} w-full pl-9 pr-3 placeholder:text-muted`}
            type="search"
            aria-label="Search consolidations"
            placeholder="Search indent no., requester, item…"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
          />
        </div>

        {/* One raised-on control, not two labelled fields: the pair only ever reads as
            a window, and reading it as one keeps the bar to a single line. */}
        <div className={`${control} flex items-center gap-1.5 px-2.5`}>
          <CalendarRange className="h-4 w-4 shrink-0 text-muted" />
          <input
            className="w-30 bg-transparent text-sm text-ink outline-none"
            type="date"
            aria-label="Raised from"
            value={value.raised_from ?? ""}
            onChange={(e) => onChange({ ...value, raised_from: e.target.value || undefined })}
          />
          <span className="text-xs text-muted">to</span>
          <input
            className="w-30 bg-transparent text-sm text-ink outline-none"
            type="date"
            aria-label="Raised to"
            value={value.raised_to ?? ""}
            onChange={(e) => onChange({ ...value, raised_to: e.target.value || undefined })}
          />
        </div>

        {primary.map((filter) => (
          <div key={filter.param} className="min-w-42">
            <Select
              ariaLabel={filter.label}
              placeholder={`All ${filter.label.toLowerCase()}s`}
              value={value[filter.param] ?? ""}
              onChange={(next) => onChange({ ...value, [filter.param]: next || undefined })}
              options={optionsFor(filter)}
            />
          </div>
        ))}

        {extra.length > 0 && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
            className={`${control} flex items-center gap-1.5 px-3 font-medium text-body hover:bg-content2`}
          >
            <SlidersHorizontal className="h-4 w-4" />
            More filters
            {applied.hidden.length > 0 && (
              <span className="rounded-full bg-brand px-1.5 py-0.5 text-[11px] font-bold leading-none text-white">
                {applied.hidden.length}
              </span>
            )}
            <ChevronDown className={`h-4 w-4 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        )}

        {applied.count > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="flex h-11 items-center gap-1 rounded-xl px-3 text-sm font-medium text-muted hover:bg-content2 hover:text-ink"
          >
            <X className="h-4 w-4" /> Clear ({applied.count})
          </button>
        )}
      </div>

      {open && extra.length > 0 && (
        <div className="mt-2.5 grid grid-cols-1 gap-2.5 border-t border-line/70 pt-3 sm:grid-cols-2 lg:grid-cols-3">
          {extra.map((filter) => (
            <Select
              key={filter.param}
              label={filter.label}
              placeholder={`All ${filter.label.toLowerCase()}s`}
              value={value[filter.param] ?? ""}
              onChange={(next) => onChange({ ...value, [filter.param]: next || undefined })}
              options={optionsFor(filter)}
            />
          ))}
        </div>
      )}

      {/* A filter that is set but folded away behind "More filters" is a filter nobody
          can see. The count badge says how many; these say WHICH, and each one drops
          itself. Only rendered while the panel is closed — with it open the dropdowns
          are already showing the same thing. */}
      {!open && applied.hidden.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-line/70 pt-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Also filtered
          </span>
          {applied.hidden.map((filter) => (
            <button
              key={filter.param}
              type="button"
              onClick={() => onChange({ ...value, [filter.param]: undefined })}
              aria-label={`Remove ${filter.label} filter`}
              className="group inline-flex min-h-9 items-center gap-1.5 rounded-full border border-brand/20 bg-brand-050 py-1 pl-3 pr-2 text-xs text-brand transition-colors hover:border-brand/45"
            >
              <span className="text-brand/70">{filter.label}</span>
              <span className="max-w-[18ch] truncate font-semibold">
                {optionLabel(filter, value[filter.param])}
              </span>
              <X className="h-3.5 w-3.5 opacity-55 transition-opacity group-hover:opacity-100" />
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

/** The consolidated item list: one row per item, showing only what everyone asked for
 *  in total and what is going out. Who asked for it lives on the item's own page —
 *  this list is the totals, and the way in.
 *
 *  A list, not the old inline editor: with the quantity box gone from the row there is
 *  nothing here for a react-aria grid cell to swallow, so this is a plain
 *  <ResponsiveList> like every other list screen.
 */
function ItemList({ items, decisions, onOpen }: {
  items: ConsolidatedItem[];
  decisions: Record<string, ItemDecision>;
  onOpen: (item: ConsolidatedItem) => void;
}) {
  const name = (item: ConsolidatedItem) => item.item_name ?? item.item_code ?? `Item ${item.item_id}`;

  /** What this item is currently set to send out, and whether that is still the
   *  untouched default — an approver scanning the list needs to see at a glance
   *  which items they have already been into. */
  const state = (item: ConsolidatedItem) => {
    const { total, ceiling, droppedCount, invalid, over } = resolveItem(item, decisions[String(item.item_id)]);
    return { total, ceiling, droppedCount, invalid, over, edited: total !== ceiling || droppedCount > 0 };
  };

  const columns: Column<ConsolidatedItem>[] = [
    {
      key: "item",
      header: "Item",
      render: (row) => <div className="min-w-0">
        <strong className="block truncate text-ink">{name(row)}</strong>
        <span className="block truncate text-xs text-muted">
          {row.item_code}{row.uom_code ? ` · ${row.uom_code}` : ""}
        </span>
      </div>,
    },
    {
      key: "indents",
      header: "Requested by",
      render: (row) => <span className="text-body">
        {row.indent_count} indent{row.indent_count === 1 ? "" : "s"}
      </span>,
    },
    {
      key: "requested",
      header: "Total requested",
      render: (row) => <span className="tabular font-semibold text-ink">
        {formatQty(row.total_requested_quantity)}
      </span>,
    },
    {
      key: "approvable",
      header: "Approvable",
      hideOnNarrow: true,
      render: (row) => <span className="tabular text-muted">{formatQty(row.total_ceiling_quantity)}</span>,
    },
    {
      key: "approving",
      header: "Approving",
      render: (row) => {
        const { total, invalid, over, edited } = state(row);
        if (invalid || over) return <span className="text-sm font-semibold text-danger">Fix quantity</span>;
        return <span className={`tabular font-semibold ${edited ? "text-brand" : "text-body"}`}>
          {formatQty(total)}
        </span>;
      },
    },
    {
      key: "excluded",
      header: "Excluded",
      render: (row) => {
        const { droppedCount } = state(row);
        return droppedCount === 0
          ? <span className="text-muted">—</span>
          : <span className="rounded-full bg-warn/15 px-2 py-0.5 text-xs font-semibold text-warn">
              {droppedCount} out
            </span>;
      },
    },
    { key: "open", header: "", render: () => <ChevronRight className="h-4 w-4 text-muted" /> },
  ];

  return (
    <ResponsiveList
      data={items}
      columns={columns}
      keyOf={(row) => row.item_id}
      onRowClick={onOpen}
      empty="No items on this batch."
      renderCard={(row) => {
        const { total, droppedCount, invalid, over, edited } = state(row);
        return <div className="space-y-1.5">
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0">
              <strong className="block truncate text-ink">{name(row)}</strong>
              <span className="block truncate text-xs text-muted">{row.item_code}</span>
            </span>
            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          </div>
          <p className="text-xs text-muted">
            {row.indent_count} indent{row.indent_count === 1 ? "" : "s"}
            {" · requested "}<strong className="text-body">{formatQty(row.total_requested_quantity)}</strong>
            {row.uom_code ? ` ${row.uom_code}` : ""}
          </p>
          <p className="text-xs">
            {invalid || over
              ? <span className="font-semibold text-danger">Fix quantity</span>
              : <span className={edited ? "font-semibold text-brand" : "text-muted"}>
                  Approving {formatQty(total)}
                </span>}
            {droppedCount > 0 && <span className="text-warn"> · {droppedCount} excluded</span>}
          </p>
        </div>;
      }}
    />
  );
}

/** A consolidation has no document number — it is a GROUP BY over the pending queue,
 *  computed fresh on every request and stored nowhere. This reference is derived from
 *  the cycle it groups, so it is stable for as long as the cycle is, and it never
 *  pretends to be a saved document id. */
/** The document's own number — the SAME string the Fulfilment Queue and Allocation
 *  Approvals print for this set of indents. `CONS-<month>` was a name only this screen
 *  used, for a batch the other two already called `CON/2026-27/00001`. Only monthly
 *  indents raised before documents existed still fall back to it. */
export const batchRef = (batch: ConsolidationBatch) =>
  batch.consolidation_no ?? `CONS-${batch.cycle}`;

const batchTotalRequested = (batch: ConsolidationBatch) =>
  batch.consolidated_items.reduce((sum, item) => sum + item.total_requested_quantity, 0);

const MONTH_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;

/** The cycle, read off its own key. Every row on this screen IS a month, so the
 *  leading tile says which one instead of repeating the same generic glyph twenty
 *  times — the month is the one thing that tells two rows apart at a glance.
 *  `UNDATED` is a real cycle key (an indent with no date), and it has no month. */
export function cycleTile(cycle: string) {
  const [year, month] = cycle.split("-");
  const index = Number(month) - 1;
  return year?.length === 4 && index >= 0 && index < 12
    ? { top: MONTH_ABBR[index], bottom: year }
    : { top: "—", bottom: "" };
}

function CycleTile({ cycle }: { cycle: string }) {
  const { top, bottom } = cycleTile(cycle);
  return (
    <span
      aria-hidden
      className="grid h-11 w-11 shrink-0 place-content-center rounded-xl border border-brand/15 bg-brand-050 text-center leading-none"
    >
      <span className="font-display text-[13px] font-bold tracking-wide text-brand">{top}</span>
      {bottom && <span className="mt-1 block text-[10px] font-semibold text-brand/60">{bottom}</span>}
    </span>
  );
}

/** How this cycle's volume compares with the busiest one on screen. A bare number
 *  says nothing until you have read every other row; a rule under it says "this is
 *  the big one" before you have read anything. */
function VolumeBar({ value, peak }: { value: number; peak: number }) {
  const pct = peak > 0 ? Math.max(4, Math.round((value / peak) * 100)) : 0;
  return (
    <span className="mt-1.5 block h-1 w-full max-w-24 overflow-hidden rounded-full bg-content2">
      <span className="block h-full rounded-full bg-brand/55" style={{ width: `${pct}%` }} />
    </span>
  );
}

/** Requesters, short. A consolidation gathers everyone reporting to the approver, so
 *  the full list ran a row into a paragraph and no name in it was readable. Two names
 *  carry the recognition and the rest becomes a count; the whole list is still one
 *  hover away, and in full inside the consolidation. */
export function requesterSummary(names: string[], keep = 2) {
  const shown = names.slice(0, keep);
  const rest = names.length - shown.length;
  return { shown, rest };
}

/** A scope cell: the one name when the cycle has one, the count when it spans more. */
const spanLabel = (name: string | null | undefined, count: number, noun: string) =>
  name || (count > 0 ? `${count} ${noun}${count === 1 ? "" : "s"}` : "—");

function Requesters({ names, keep = 2 }: { names: string[]; keep?: number }) {
  const { shown, rest } = requesterSummary(names, keep);
  if (names.length === 0) return <span className="text-muted">—</span>;

  return (
    <span className="flex flex-wrap items-center gap-1" title={names.join(", ")}>
      {shown.map((name) => (
        <span key={name} className="max-w-[16ch] truncate rounded-full bg-content2 px-2 py-0.5 text-xs text-body">
          {name}
        </span>
      ))}
      {rest > 0 && (
        <span className="text-xs font-semibold text-muted">+{rest} other{rest === 1 ? "" : "s"}</span>
      )}
    </span>
  );
}

/** The workspace's front door: one row per consolidation, in the shape of the All
 *  requests list. Opening a row is what reveals the quantity editor — the same
 *  drill-down an indent gets, so the two screens read the same way. */
function BatchList({ batches, loading, onOpen }: {
  batches: ConsolidationBatch[];
  loading?: boolean;
  onOpen: (batch: ConsolidationBatch) => void;
}) {
  // The busiest cycle on screen sets the scale every other row is drawn against.
  const peak = batches.reduce((max, row) => Math.max(max, batchTotalRequested(row)), 0);

  const columns: Column<ConsolidationBatch>[] = [
    {
      key: "ref",
      header: "Consolidation",
      render: (row) => <div className="flex items-center gap-3">
        <CycleTile cycle={row.cycle} />
        <span className="min-w-0">
          <strong className="block font-display text-[15px] font-bold text-ink">{row.month_label}</strong>
          <span className="block truncate font-mono text-[11px] tracking-tight text-muted">{batchRef(row)}</span>
        </span>
      </div>,
    },
    { key: "indents", header: "Indents", render: (row) => <span className="tabular text-ink">{row.indent_count}</span> },
    { key: "items", header: "Items", render: (row) => <span className="tabular text-ink">{row.consolidated_items.length}</span> },
    {
      key: "requesters",
      header: "Requesters",
      hideOnNarrow: true,
      render: (row) => <Requesters names={row.requesters} />,
    },
    // Region and project each get their own column. A cycle that spans several of
    // either has no single name to show, so the cell says how many it spans rather
    // than picking one of them.
    {
      key: "region",
      header: "Region",
      hideOnNarrow: true,
      render: (row) => <span className="text-muted">{spanLabel(row.region_name, row.region_count, "region")}</span>,
    },
    {
      key: "project",
      header: "Project",
      hideOnNarrow: true,
      render: (row) => <span className="text-muted">{spanLabel(row.project_name, row.project_count, "project")}</span>,
    },
    {
      key: "requested",
      header: "Requested",
      render: (row) => <div className="min-w-20">
        <span className="tabular font-semibold text-ink">{formatQty(batchTotalRequested(row))}</span>
        <VolumeBar value={batchTotalRequested(row)} peak={peak} />
      </div>,
    },
    { key: "stage", header: "Stage", render: (row) => <StatusPill status={row.current_stage_name ?? "PENDING"} /> },
  ];

  return (
    <ResponsiveList
      data={batches}
      columns={columns}
      loading={loading}
      keyOf={(row) => row.batch_key}
      onRowClick={onOpen}
      empty="No Monthly indents are waiting for your consolidated approval."
      renderCard={(row) => <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-3">
            <CycleTile cycle={row.cycle} />
            <span className="min-w-0">
              <strong className="block truncate font-display text-[15px] font-bold text-ink">
                {row.month_label}
              </strong>
              <span className="block truncate font-mono text-[11px] text-muted">{batchRef(row)}</span>
            </span>
          </span>
          <StatusPill status={row.current_stage_name ?? "PENDING"} />
        </div>
        {/* Three figures, three columns — the same numbers the table shows, but
            lined up instead of run together in a sentence. */}
        <div className="grid grid-cols-3 gap-2 rounded-xl bg-content2/60 px-3 py-2 text-center">
          {[
            ["Indents", String(row.indent_count)],
            ["Items", String(row.consolidated_items.length)],
            ["Requested", formatQty(batchTotalRequested(row))],
          ].map(([label, figure]) => (
            <span key={label} className="min-w-0">
              <span className="block truncate tabular text-sm font-semibold text-ink">{figure}</span>
              <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted">
                {label}
              </span>
            </span>
          ))}
        </div>
        <Requesters names={row.requesters} />
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
  // Keyed by item id, one per item the approver has been into. Held outside this
  // component (see consolidationDecisions.ts) because the quantities are now set on
  // each item's own page and spent here — a `useState` would be thrown away in
  // between. Still nothing written server-side until Approve all.
  const { decisions, clearCycle } = useConsolidationDecisions(batch.cycle);
  const [result, setResult] = useState<ConsolidationApprovalResult | null>(null);
  // How many indents the server has answered for so far. Decided from the responses,
  // never from a timer: it has to say what is actually committed, because that is
  // exactly what survives if the tab is closed halfway through.
  const [progress, setProgress] = useState(0);
  const queryClient = useQueryClient();
  const nav = useNavigate();

  // The members this batch had when it was opened, frozen. Indents keep arriving in
  // the month while the batch is being read, and this screen groups on the MONTH — a
  // consolidation id only exists after approval, so there is no sealed document to
  // hold the set still the way the fulfilment and allocation screens have one. Without
  // this, a refetch quietly grew the batch between reading it and clicking Approve all,
  // and an indent nobody had seen was signed. Arrivals are announced instead.
  const [reload, setReload] = useState(0);
  const frozenIds = useMemo(
    () => new Set(batch.indents.map((row) => row.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately NOT `batch`:
    // the set is captured once per cycle and only re-taken when the approver asks.
    [batch.cycle, reload],
  );
  const arrived = batch.indents.filter((row) => !frozenIds.has(row.id));

  // A bad number anywhere in the batch blocks the whole approval: the split it feeds
  // would be wrong for every indent holding that item, not just one.
  const blocked = batch.consolidated_items.some((item) => {
    const { invalid, over } = resolveItem(item, decisions[String(item.item_id)]);
    return invalid || over;
  });

  /** Indents left out of every item they appear on — they get nothing from this round.
   *
   *  They are HELD, not approved: sending them on with zeros used to pass them up the
   *  ladder as decided-and-empty, so the next approver saw an indent nobody meant to
   *  send. Held here, the indent simply stays in this approver's queue, exactly where
   *  it was before Approve all, and can be included next round, approved on its own
   *  screen, or rejected — none of which is possible once it has climbed a rung.
   *
   *  Excluded on SOME items only is not a hold: those lines go out at zero and the
   *  rest at their share, which is an ordinary partial approval. */
  const held = useMemo(() => {
    const seen = new Map<number, boolean>();
    for (const item of batch.consolidated_items) {
      const excluded = (decisions[String(item.item_id)]?.excluded ?? [])
        .map((no) => no.toUpperCase());
      for (const allocation of item.allocations ?? []) {
        const out = isExcluded(allocation, excluded);
        seen.set(allocation.indent_id, (seen.get(allocation.indent_id) ?? true) && out);
      }
    }
    return new Set([...seen].filter(([, all]) => all).map(([id]) => id));
  }, [batch.consolidated_items, decisions]);

  /** How many indents Approve all actually sends — the button, the progress bar and
   *  the request all count the same set, so a held indent never shows up as one that
   *  failed to approve. */
  const sending = batch.indents.filter(
    (row) => frozenIds.has(row.id) && !held.has(row.id)).length;

  const approve = useMutation({
    mutationFn: async () => {
      // Every item's split, flattened. A line nobody edited still ships its share,
      // because the split of an untouched item is simply its full ceiling.
      const lines = batch.consolidated_items.flatMap((item) => {
        const { split } = resolveItem(item, decisions[String(item.item_id)]);
        const dropped = (decisions[String(item.item_id)]?.excluded ?? [])
          .map((no) => no.toUpperCase());
        return (item.allocations ?? []).map((allocation) => ({
          indent_id: allocation.indent_id,
          line_id: allocation.line_id,
          approved_quantity: split.get(allocation.line_id) ?? 0,
          // Said out loud, not left to be inferred from the zero: a line dropped from
          // the batch and a line approved at nothing are the same number and mean
          // completely different things (BUG_SCM_0004).
          excluded: isExcluded(allocation, dropped),
        }));
      });
      // The frozen set, never whatever the server holds at click time: an indent that
      // joined the month while this screen was open has not been read by anybody here.
      const indentIds = batch.indents
        .map((row) => row.id)
        .filter((id) => frozenIds.has(id) && !held.has(id));

      // Sent in small chunks, not one request. The backend walks the batch one indent
      // at a time — engine-owned chains cannot be short-cut — so a monthly cycle would
      // sit on a single request long past any gateway timeout. The call is already
      // non-atomic across indents by design and each indent commits on its own, so
      // splitting it changes nothing about the outcome: it only bounds how long any
      // one request is held open, and gives the bar below something to move on.
      const merged: ConsolidationApprovalResult = {
        approved_count: 0, approved_indent_ids: [], failed: [],
      };
      setProgress(0);
      for (let i = 0; i < indentIds.length; i += APPROVE_CHUNK) {
        const chunk = indentIds.slice(i, i + APPROVE_CHUNK);
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
      // The draft has been spent. Leaving it behind would re-apply last week's
      // numbers to whatever is still in the cycle after this round.
      if (data.approved_count > 0) clearCycle();
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

  return (
    <Card className="mb-4 space-y-4 p-4">
      {arrived.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warn/40 bg-warn/5 p-3 text-sm">
          <p className="text-warn">
            {arrived.length} indent{arrived.length === 1 ? "" : "s"} joined this month
            since you opened the batch ({arrived.map((row) => row.indent_no).join(", ")}).
            They are not counted below and Approve all will not sign them.
          </p>
          <Button variant="secondary" onClick={() => setReload((n) => n + 1)}>
            Include them
          </Button>
        </div>
      )}
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
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <Users className="h-3.5 w-3.5 shrink-0" /> <Requesters names={batch.requesters} />
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={batch.current_stage_name ?? "PENDING"} />
          {/* Serving from your own stock is a different job from setting quantities —
              it moves goods — so it is a visible action up here, not a disclosure
              buried under the item editor where nobody found it. */}
          {/* Same solid primary as Approve all: both are real decisions the approver
              takes from this header, so neither is demoted to a secondary weight. */}
          <Button
            disabled={batch.indents.length === 0}
            onClick={() => nav(`/approvals/consolidation/${encodeURIComponent(batch.cycle)}/serve`)}
          >
            <PackageCheck className="h-4 w-4" /> Serve from own stock
          </Button>
          <Button className={TONE_APPROVE}
            disabled={blocked || approve.isPending || sending === 0}
            onClick={() => approve.mutate()}
          >
            <Check className="h-4 w-4" />
            {approve.isPending
              ? `Approving… ${progress}/${sending}`
              : `Approve all ${sending}`}
          </Button>
        </div>
      </div>

      {blocked && <p className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
        One item's quantity is out of range — open it and fix it before approving.
      </p>}
      {held.size > 0 && <p className="rounded-xl bg-warn/10 p-3 text-sm text-warn">
        {held.size} indent{held.size === 1 ? " is" : "s are"} left out of every item and
        will not be sent on — {held.size === 1 ? "it stays" : "they stay"} in your queue
        for you to include next round, or to reject.
        {sending === 0 && " Nothing is left to approve."}
      </p>}
      {approve.isPending && (
        <div className="rounded-xl bg-brand/5 p-3">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-body">
              Approving {progress} of {sending}…
            </span>
            <span className="font-mono text-xs text-muted">
              {Math.round((progress / Math.max(sending, 1)) * 100)}%
            </span>
          </div>
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-brand/15"
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={sending}
            aria-label="Indents approved"
          >
            <div
              className="h-full rounded-full bg-brand transition-[width] duration-300"
              style={{ width: `${(progress / Math.max(sending, 1)) * 100}%` }}
            />
          </div>
          {/* Said out loud because it is the thing an approver worries about while a
              long run is going. Each indent commits on its own, so this is true. */}
          <p className="mt-2 text-xs text-muted">
            Safe to wait — every indent already counted is approved and stays approved,
            even if this page is closed.
          </p>
        </div>
      )}
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

      {/* The whole batch, item by item — and nothing else. The matching indents used
          to sit under this as a second table, which meant an approver read the same
          twenty indents once here and again inside every item they opened. They now
          live on the item they asked for, where the exclusion that drops one of them
          actually happens. */}
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Consolidated item quantities
        </p>
        <ItemList
          items={batch.consolidated_items}
          decisions={decisions}
          onOpen={(item) => nav(
            `/approvals/consolidation/${encodeURIComponent(batch.cycle)}/items/${item.item_id}`,
          )}
        />
        <p className="mt-2 text-xs text-muted">
          Open an item to see who asked for it, set the quantity going out and leave
          indents out of it.
        </p>
      </div>
    </Card>
  );
}

/** The fourth tile. Three counts and a fourth count read as four of the same thing,
 *  and the number that actually matters here is a proportion: how much of the queue
 *  the filters are letting through. Same shell and rhythm as `StatCard` — it belongs
 *  to that row — with the share drawn instead of spelled out. */
function CoverageCard({ shown, total }: { shown: number; total: number }) {
  const pct = total > 0 ? Math.round((shown / total) * 100) : 0;
  const narrowed = shown < total;
  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          {narrowed ? "In view" : "Whole queue"}
        </span>
        <span className={narrowed ? "text-brand" : "text-muted"}>
          <Filter className="h-4 w-4" />
        </span>
      </div>
      <div className="flex items-end justify-between gap-2">
        <span className="font-display text-3xl font-bold tabular text-ink">{pct}%</span>
        <span className="pb-1 text-xs text-muted tabular">{shown} of {total}</span>
      </div>
      <span className="mt-3 block h-1.5 overflow-hidden rounded-full bg-content2">
        <span
          className="block h-full rounded-full bg-brand transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </span>
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
    <p className="mb-4 max-w-3xl text-sm text-body">
      Every Monthly indent waiting on you, gathered into one row per monthly cycle.
      Filters narrow what is <em className="not-italic font-semibold">inside</em> a
      cycle — they never split it into separate approvals. Open a consolidation to set
      quantities and approve it.
    </p>

    {data && <>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {/* One accent, on the number the screen is about; the other two stay ink so
            the strip reads as a hierarchy rather than a set of coloured lights. */}
        <StatCard
          label="Indents shown"
          value={data.total_indent_count}
          tone="text-brand"
          icon={<Layers className="h-4 w-4" />}
        />
        <StatCard label="Requesters" value={data.total_requester_count} icon={<Users className="h-4 w-4" />} />
        <StatCard
          label="Consolidations"
          value={batches.length}
          icon={<CalendarRange className="h-4 w-4" />}
        />
        <CoverageCard shown={data.total_indent_count} total={data.unfiltered_indent_count} />
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

    <ErrorBanner error={query.error} />

    {!query.error && (query.isLoading || batches.length > 0
      // Skeleton rows, not a "Loading…" card: the list keeps its shape while it
      // arrives, so nothing on the page jumps when it does.
      ? <BatchList
          batches={batches}
          loading={query.isLoading}
          onOpen={(batch) => nav(`/approvals/consolidation/${encodeURIComponent(batch.batch_key)}`)}
        />
      : <EmptyState
          title={appliedCount > 0
            ? "No consolidation matches these filters"
            : "Nothing waiting on your consolidated approval"}
          hint={appliedCount > 0
            ? "Monthly indents are pending, but none of them survive the current filters. Widen or clear them to see the rest of the queue."
            : "Monthly indents raised below you land here, gathered by the month they were raised in. Nothing is pending right now."}
          action={appliedCount > 0
            ? <Button variant="subtle" onClick={() => { setSearchText(""); setFilters({}); }}>
                Clear filters
              </Button>
            : undefined}
        />)}
  </>;
}
