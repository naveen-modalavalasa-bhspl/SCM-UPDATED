import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  AlertCircle, ArrowLeft, Check, ClipboardList, Info, Package, PackageCheck, Percent,
  RefreshCw, Search, Trash2, Undo2, UserX, Users, X,
} from "lucide-react";
import { Button, Card, ConfirmModal, PageHeader, StatCard } from "@/shared/components";
import { approvalsApi } from "../api";
import { useConsolidationDecisions } from "../consolidationDecisions";
import {
  indentLineIds, isIndentRemoved, reducePercent, resolveItem,
} from "../consolidationLines";
import { PriorityFilter, PriorityTag } from "../components/PriorityFilter";
import { formatQty } from "./ConsolidationPage";
import type { ConsolidationIndentSummary } from "../types";
import { QuantityInput } from "@/shared/components/QuantityInput";

/** One consolidated item, and everyone who asked for it.
 *
 *  The consolidation screen answers "what does this month need"; this one answers
 *  "who needs it, and what does each of them get". The approver decides AT THE INDENT:
 *  every row carries its own quantity box and its own exclude button, and there is no
 *  batch total shared out in proportion. Two things act on more than one row, and both
 *  are deliberate presses rather than rules left running in the background:
 *
 *    - "Remove from all items" — a row that is already excluded from this item offers to
 *      take its indent out of every item in the cycle, so the indent is held back whole.
 *    - "Reduce %" — gives every INCLUDED indent the same share of its own ceiling, for
 *      this one item. It fills the quantity boxes in; each stays editable afterwards.
 *
 *  Nothing new is fetched: the batch already ships each item's `allocations`, so this
 *  is the same cached workspace response the consolidation screen is showing, read
 *  one item deep. The quantities and exclusions are held in the shared per-cycle draft
 *  (`consolidationDecisions.ts`) — set here, spent by Approve all over there.
 */

/** One requester's line for this item, joined to the indent header the batch already
 *  carries so the row can be filtered by the same dimensions the rest of the module
 *  offers. */
interface ItemRow {
  line_id: number;
  indent_id: number;
  indent_no: string;
  requested_quantity: number;
  /** The most this line may be passed. */
  cap: number;
  /** What goes out for it right now. */
  value: number;
  /** What is in the box ("" = untouched = the full ceiling). */
  typed: string;
  excluded: boolean;
  /** Dropped at a rung BELOW this approver — read-only here, not theirs to undo. */
  excludedBelow: boolean;
  excludedByName: string | null;
  /** This indent is out of every item it is on, not just this one. */
  removedEverywhere: boolean;
  invalid: boolean;
  over: boolean;
  indent?: ConsolidationIndentSummary;
}

/* ---- presentation only: nothing below decides a quantity ---- */

/** A requester's initials, for the row's avatar tile. A name is what an approver
 *  recognises a row by; the monogram gives every row a fixed anchor to scan down. */
const initials = (name?: string | null) => {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
};

/** How much of an ask is being met, 0–100, as a whole number for a bar's width. */
const share = (part: number, whole: number) =>
  whole > 0 ? Math.max(0, Math.min(100, Math.round((part / whole) * 100))) : 0;

const ROW_BUTTON = "flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-xs font-semibold transition-colors";

export function ConsolidationItemPage() {
  const nav = useNavigate();
  const { cycle = "", itemId = "" } = useParams<{ cycle: string; itemId: string }>();
  const back = () => nav(`/approvals/consolidation/${encodeURIComponent(cycle)}`);

  // Same query key as the consolidation screen: opening an item reads the cache it
  // already filled rather than asking the server for the batch a second time.
  const query = useQuery({
    queryKey: ["approvals", "consolidation", { cycle }],
    queryFn: () => approvalsApi.consolidation({ cycle }),
  });
  const batch = query.data?.items?.[0] ?? null;
  const allItems = batch?.consolidated_items ?? [];
  const item = allItems.find((row) => String(row.item_id) === itemId) ?? null;

  const { decisions, setApproved, setApprovedMany, setExcluded } = useConsolidationDecisions(cycle);

  const [search, setSearch] = useState("");
  const [priority, setPriority] = useState("");
  const [reduceOpen, setReduceOpen] = useState(false);
  const [percent, setPercent] = useState("");
  const [removing, setRemoving] = useState<ItemRow | null>(null);

  const resolved = item ? resolveItem(item, decisions) : null;
  const decimals = item?.uom_decimals ?? 3;

  // Every requester of this item, in one row each. Built from the allocations rather
  // than from the batch's indents: an indent that does not carry this item has no
  // business on this screen.
  const rows: ItemRow[] = useMemo(() => {
    if (!item || !resolved) return [];
    const byId = new Map((batch?.indents ?? []).map((row) => [row.id, row]));
    return resolved.lines.map((line) => ({
      line_id: line.allocation.line_id,
      indent_id: line.allocation.indent_id,
      indent_no: line.allocation.indent_no,
      requested_quantity: line.allocation.requested_quantity,
      cap: line.cap,
      value: line.value,
      typed: line.typed,
      excluded: line.excluded,
      excludedBelow: line.excludedBelow,
      excludedByName: line.allocation.excluded_by_name ?? null,
      removedEverywhere: line.excluded && !line.excludedBelow
        && isIndentRemoved(allItems, line.allocation.indent_id, decisions),
      invalid: line.invalid,
      over: line.over,
      indent: byId.get(line.allocation.indent_id),
    }));
    // `resolved` is rebuilt from item + decisions on every render; depending on those two.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allItems, batch, decisions, item]);

  // Search and priority hide rows; they never change a quantity. A filtered-out indent
  // still goes out at whatever its box holds.
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows
      .filter((row) => !priority || (row.indent?.priority ?? "NORMAL") === priority)
      .filter((row) => !needle || [
        row.indent_no, row.indent?.requested_by_name, row.indent?.region_name,
        row.indent?.project_name, row.indent?.vehicle_number,
      ].some((value) => value?.toLowerCase().includes(needle)))
      // Urgent first, then the biggest ask: the rows a cut hurts most, first.
      .sort((a, b) =>
        Number((b.indent?.priority ?? "") === "URGENT") - Number((a.indent?.priority ?? "") === "URGENT")
        || b.requested_quantity - a.requested_quantity);
  }, [priority, rows, search]);

  const name = item?.item_name ?? item?.item_code ?? "Item";
  const unit = item?.uom_code ?? "";
  const control = "h-11 rounded-xl border border-line bg-content1 text-sm text-ink outline-none focus:border-brand";

  /* ---- the row actions ---- */
  const exclude = (row: ItemRow) => setExcluded([row.line_id], true);
  const include = (row: ItemRow) => setExcluded([row.line_id], false);
  const includeEverywhere = (row: ItemRow) =>
    setExcluded(indentLineIds(allItems, row.indent_id), false);
  const removeEverywhere = (row: ItemRow) => {
    setExcluded(indentLineIds(allItems, row.indent_id), true);
    setRemoving(null);
  };

  /* ---- Reduce % ---- */
  const parsedPercent = percent.trim() === "" ? null : Number(percent);
  const percentOk = parsedPercent !== null && !Number.isNaN(parsedPercent)
    && parsedPercent >= 0 && parsedPercent <= 100;
  const reduction = item && percentOk ? reducePercent(item, decisions, parsedPercent) : null;
  const applyReduction = () => {
    if (!reduction) return;
    setApprovedMany(reduction.entries.map(({ lineId, approved }) => ({ lineId, approved })));
    setReduceOpen(false);
  };

  /** The quantity box for one row. A plain input, not a grid cell: <ResponsiveList>
   *  renders a react-aria grid, and a grid cell swallows the keystrokes an <input> needs
   *  — which is why this list is a hand-built table. */
  const quantityBox = (row: ItemRow) => {
    if (row.excluded) {
      return <span className="inline-flex items-center rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-warn">
        Excluded
      </span>;
    }
    const error = row.invalid
      ? "Enter a quantity of 0 or more."
      : row.over ? `Capped at ${formatQty(row.cap)}.` : null;
    const pct = share(row.value, row.requested_quantity);
    return <div className="w-40">
      <div
        className={`flex h-10 items-center rounded-xl border bg-content1 pr-2.5 transition focus-within:ring-2 ${
          error
            ? "border-bad bg-bad-bg/40 focus-within:ring-bad/30"
            : "border-line focus-within:border-brand focus-within:ring-brand/25"
        }`}
      >
        <QuantityInput
          decimals={decimals}
          min={0}
          max={row.cap}
          aria-label={`Quantity for ${row.indent_no}`}
          aria-invalid={Boolean(error)}
          placeholder={formatQty(row.cap)}
          value={row.typed}
          onChange={(raw) => setApproved(row.line_id, raw)}
          className="h-full min-w-0 flex-1 rounded-xl bg-transparent px-2.5 text-right font-semibold tabular outline-none placeholder:font-normal placeholder:text-muted"
        />
        {unit && <span className="shrink-0 whitespace-nowrap text-xs font-medium text-muted">{unit}</span>}
      </div>
      <p
        role={error ? "alert" : undefined}
        className={`mt-1 flex items-center gap-1 text-[11px] ${error ? "font-medium text-bad" : "text-muted"}`}
      >
        {error && <AlertCircle className="h-3 w-3 shrink-0" aria-hidden />}
        {error ?? (row.typed.trim() === ""
          ? `Blank sends the full ${formatQty(row.cap)}.`
          : `${pct}% of the ask`)}
      </p>
    </div>;
  };

  /** The buttons for one row — the two-step exclude lives here. */
  const rowActions = (row: ItemRow) => {
    if (row.excludedBelow) {
      return <span className="text-xs text-muted">
        {row.excludedByName ? `Excluded by ${row.excludedByName}` : "Already excluded"}
      </span>;
    }
    if (!row.excluded) {
      return <button
        type="button"
        onClick={() => exclude(row)}
        className={`${ROW_BUTTON} border-line text-muted hover:border-danger hover:text-danger`}
      >
        <UserX className="h-3.5 w-3.5" /> Exclude
      </button>;
    }
    if (row.removedEverywhere) {
      return <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-semibold text-warn">
          Removed from all items
        </span>
        <button
          type="button"
          onClick={() => includeEverywhere(row)}
          className={`${ROW_BUTTON} border-brand text-brand hover:bg-brand-050`}
        >
          <Undo2 className="h-3.5 w-3.5" /> Include again
        </button>
      </div>;
    }
    return <div className="flex flex-wrap items-center justify-end gap-2">
      <button
        type="button"
        onClick={() => setRemoving(row)}
        className={`${ROW_BUTTON} border-danger/50 text-danger hover:bg-danger/10`}
      >
        <Trash2 className="h-3.5 w-3.5" /> Remove from all items
      </button>
      <button
        type="button"
        onClick={() => include(row)}
        className="flex items-center gap-1 px-1 text-xs font-medium text-brand hover:underline"
      >
        <Undo2 className="h-3 w-3" /> Include
      </button>
    </div>;
  };

  const requesterCell = (row: ItemRow) => <div className="flex min-w-0 items-center gap-2.5">
    <span
      aria-hidden
      className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl text-[11px] font-bold ${
        row.excluded
          ? "bg-content2 text-muted"
          : row.indent?.priority === "URGENT"
            ? "bg-bad-bg text-bad"
            : "bg-brand-050 text-brand"
      }`}
    >
      {initials(row.indent?.requested_by_name)}
    </span>
    <span className="min-w-0">
      <span className="flex items-center gap-2">
        <strong className={`font-mono ${row.excluded ? "text-muted line-through" : "text-ink"}`}>
          {row.indent_no}
        </strong>
        <PriorityTag priority={row.indent?.priority} />
      </span>
      <span className="block truncate text-xs text-muted">
        {row.indent?.requested_by_name ?? "—"}
      </span>
    </span>
  </div>;

  return <>
    <PageHeader
      eyebrow={`Approvals · CONS-${cycle}`}
      title={name}
      actions={<div className="flex gap-2">
        <Button variant="ghost" onClick={back}><ArrowLeft className="h-4 w-4" /> Back</Button>
        <Button variant="ghost" disabled={query.isFetching} onClick={() => query.refetch()}>
          <RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>}
    />

    {query.error
      ? <p className="rounded-xl bg-danger/10 p-4 text-sm text-danger">{(query.error as Error).message}</p>
      : query.isLoading
        // Skeleton in the shape of the screen, not the word "Loading" — the layout
        // stops jumping once the batch lands.
        ? <div className="space-y-4">
            <div className="h-28 animate-pulse rounded-2xl border border-line/70 bg-content1" />
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-24 animate-pulse rounded-2xl border border-line/70 bg-content1" />
              ))}
            </div>
            <div className="h-20 animate-pulse rounded-2xl border border-line/70 bg-content1" />
            <div className="h-64 animate-pulse rounded-2xl border border-line/70 bg-content1" />
          </div>
        : !item || !resolved
          ? <Card className="flex flex-col items-center gap-3 p-12 text-center text-muted">
              <span className="grid h-14 w-14 place-items-center rounded-2xl bg-brand-050 text-brand">
                <Package className="h-6 w-6" />
              </span>
              This item is no longer waiting on you in {cycle}.
              <Button variant="ghost" onClick={back}>Back to the consolidation</Button>
            </Card>
          : <>
              {/* The item, as an object with a face on it. The code, the unit and the
                  coverage of the whole ask were three scattered greys before; together
                  they are the one thing the approver is deciding about. */}
              <Card className="mb-4 overflow-hidden">
                <div className="flex flex-wrap items-start gap-4 bg-linear-to-r from-brand-050 to-transparent p-4 sm:p-5">
                  <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-brand text-white shadow-sm">
                    <Package className="h-5 w-5" />
                  </span>

                  <div className="min-w-50 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded-lg border border-line/70 bg-content1 px-2 py-0.5 font-mono text-xs font-semibold text-ink">
                        {item.item_code}
                      </span>
                      {item.uom_code && (
                        <span className="rounded-lg bg-content2 px-2 py-0.5 text-xs font-medium text-body">
                          {item.uom_code}
                        </span>
                      )}
                      <span className="rounded-lg bg-content2 px-2 py-0.5 text-xs font-medium text-body">
                        {item.indent_count} indent{item.indent_count === 1 ? "" : "s"}
                      </span>
                    </span>
                    <p className="mt-2 max-w-prose text-sm text-body">
                      Every indent in this cycle that asked for it. Set what each one gets
                      in its own row, or exclude it.
                    </p>
                  </div>

                  {/* One bar, two fills: the pale one is what may still be approved, the
                      solid one is what is currently going out. The gap between them and
                      the end of the track is the shortfall against the whole ask. */}
                  <div className="w-full rounded-xl border border-line/70 bg-content1 p-3 sm:w-64">
                    <span className="flex items-baseline justify-between">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                        Covering the ask
                      </span>
                      <strong className="tabular text-sm font-bold text-brand">
                        {share(resolved.total, item.total_requested_quantity)}%
                      </strong>
                    </span>
                    <span className="relative mt-2 block h-2.5 w-full overflow-hidden rounded-full bg-content2">
                      <span
                        className="absolute inset-y-0 left-0 rounded-full bg-brand/25"
                        style={{ width: `${share(resolved.ceiling, item.total_requested_quantity)}%` }}
                      />
                      <span
                        className="absolute inset-y-0 left-0 rounded-full bg-brand"
                        style={{ width: `${share(resolved.total, item.total_requested_quantity)}%` }}
                      />
                    </span>
                    <span className="mt-1.5 block text-[11px] text-muted">
                      <strong className="tabular font-semibold text-body">{formatQty(resolved.total)}</strong>
                      {" going out of "}
                      <span className="tabular">{formatQty(item.total_requested_quantity)}</span>
                      {" requested"}
                    </span>
                  </div>
                </div>
              </Card>

              <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatCard label="Indents" value={item.indent_count} icon={<Users className="h-4 w-4" />} />
                <StatCard
                  label="Total requested"
                  value={formatQty(item.total_requested_quantity)}
                  icon={<ClipboardList className="h-4 w-4" />}
                />
                <StatCard
                  label="Approvable"
                  value={formatQty(resolved.ceiling)}
                  icon={<PackageCheck className="h-4 w-4" />}
                />
                <StatCard
                  label="Allocated"
                  value={formatQty(resolved.total)}
                  icon={<Check className="h-4 w-4" />}
                  tone={resolved.total < resolved.ceiling ? "text-warn" : "text-ink"}
                />
              </div>

              {/* The one action that acts on the whole item: an even cut across every
                  included indent. Everything else is decided in the rows below. */}
              <Card className="mb-4 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="max-w-prose text-sm text-body">
                    Set each indent's quantity in its row, or exclude it. To cut this item
                    evenly across every indent that is still in, use <strong>Reduce %</strong>.
                  </p>
                  <Button
                    variant="ghost"
                    disabled={resolved.included.length === 0}
                    onClick={() => { setPercent(""); setReduceOpen(true); }}
                  >
                    <Percent className="h-4 w-4" /> Reduce %
                  </Button>
                </div>
                {resolved.droppedCount > 0 && (
                  <p className="mt-2 text-xs text-muted">
                    {resolved.droppedCount} of {rows.length} indent{rows.length === 1 ? "" : "s"} out of this item.
                  </p>
                )}
              </Card>

              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="relative w-full max-w-xs">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                  <input
                    className={`${control} w-full pl-9 pr-3 placeholder:text-muted`}
                    type="search"
                    aria-label="Search indents for this item"
                    placeholder="Indent no., requester, project…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <PriorityFilter value={priority} onChange={setPriority} />
                {(search || priority) && (
                  <button
                    type="button"
                    onClick={() => { setSearch(""); setPriority(""); }}
                    className="flex h-11 items-center gap-1 rounded-xl px-3 text-sm font-medium text-muted hover:bg-content2 hover:text-ink"
                  >
                    <X className="h-4 w-4" /> Clear
                  </button>
                )}
                <span className="ml-auto rounded-full bg-content2 px-2.5 py-1 text-xs font-medium text-muted">
                  <strong className="tabular font-semibold text-body">{shown.length}</strong>
                  {" of "}{rows.length} indent{rows.length === 1 ? "" : "s"}
                </span>
              </div>

              {shown.length === 0
                ? <Card className="p-8 text-center text-muted">No indent here matches.</Card>
                : <>
                    {/* Desktop: a table. */}
                    <div className="hidden overflow-x-auto rounded-2xl border border-line/70 bg-content1 md:block">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-content2">
                          <tr className="text-[11px] uppercase tracking-wider text-muted">
                            <th scope="col" className="px-4 py-3 font-semibold">Indent</th>
                            <th scope="col" className="hidden px-3 py-3 font-semibold lg:table-cell">Region</th>
                            <th scope="col" className="hidden px-3 py-3 font-semibold lg:table-cell">Project</th>
                            <th scope="col" className="hidden px-3 py-3 font-semibold xl:table-cell">Vehicle</th>
                            <th scope="col" className="px-3 py-3 font-semibold">Requested</th>
                            <th scope="col" className="px-3 py-3 font-semibold">Quantity</th>
                            <th scope="col" className="px-4 py-3 text-right font-semibold">
                              <span className="sr-only">Actions</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                          {shown.map((row) => (
                            <tr key={row.line_id} className={row.excluded ? "bg-content2/40" : ""}>
                              <td className="px-4 py-3 align-top">{requesterCell(row)}</td>
                              <td className="hidden px-3 py-3 align-top text-muted lg:table-cell">{row.indent?.region_name ?? "—"}</td>
                              <td className="hidden px-3 py-3 align-top text-muted lg:table-cell">{row.indent?.project_name ?? "—"}</td>
                              <td className="hidden px-3 py-3 align-top text-muted xl:table-cell">{row.indent?.vehicle_number ?? "—"}</td>
                              <td className="px-3 py-3 align-top tabular text-body">{formatQty(row.requested_quantity)}</td>
                              <td className="px-3 py-3 align-top">{quantityBox(row)}</td>
                              <td className="px-4 py-3 text-right align-top">{rowActions(row)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Phone: one card per indent, the same controls. */}
                    <div className="space-y-3 md:hidden">
                      {shown.map((row) => (
                        <Card key={row.line_id} className={`space-y-3 p-3 ${row.excluded ? "opacity-80" : ""}`}>
                          {requesterCell(row)}
                          <p className="text-xs text-muted">
                            {[row.indent?.region_name, row.indent?.project_name, row.indent?.vehicle_number]
                              .filter(Boolean).join(" · ") || "—"}
                          </p>
                          <p className="text-xs text-muted">
                            Requested <strong className="text-body">{formatQty(row.requested_quantity)}</strong>
                          </p>
                          <div>{quantityBox(row)}</div>
                          <div className="flex justify-end">{rowActions(row)}</div>
                        </Card>
                      ))}
                    </div>
                  </>}

              <p className="mt-3 flex items-start gap-2 rounded-xl border border-line/70 bg-content2/60 p-3 text-xs text-muted">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
                <span>
                  Nothing here is saved on its own —{" "}
                  <strong className="font-semibold text-body">Approve all</strong>, back on
                  the consolidation, is what sends these quantities to the indents.
                </span>
              </p>

              <ConfirmModal
                isOpen={reduceOpen}
                title={`Reduce ${name}`}
                message="Every indent that is still in gets the same share of its own ceiling for this item. Other items of those indents are not touched, and you can still change any row afterwards."
                confirmLabel="Apply"
                confirmDisabled={!reduction || reduction.entries.length === 0}
                onClose={() => setReduceOpen(false)}
                onConfirm={applyReduction}
              >
                <label className="block text-sm font-semibold text-ink">
                  Percentage of each indent's ceiling
                  <span className="mt-2 flex h-11 items-center rounded-xl border border-line bg-content1 pr-3 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/25">
                    <QuantityInput
                      autoFocus
                      decimals={2}
                      min={0}
                      max={100}
                      aria-label="Percentage"
                      placeholder="e.g. 80"
                      value={percent}
                      onChange={setPercent}
                      className="h-full min-w-0 flex-1 rounded-xl bg-transparent px-3 text-right text-base font-semibold tabular outline-none placeholder:font-normal placeholder:text-muted"
                    />
                    <span className="text-sm font-semibold text-muted">%</span>
                  </span>
                </label>
                <p className="mt-2 min-h-5 text-xs" role="status">
                  {percent.trim() !== "" && !percentOk
                    ? <span className="text-danger">Enter a percentage from 0 to 100.</span>
                    : reduction
                      ? parsedPercent === 100
                        ? <span className="text-muted">Puts every indent still in back to its full ceiling.</span>
                        : <span className="text-body">
                            {reduction.entries.length} indent{reduction.entries.length === 1 ? "" : "s"}
                            {" · "}<strong className="tabular">{formatQty(reduction.before)}</strong>
                            {" → "}<strong className="tabular">{formatQty(reduction.after)}</strong>
                            {unit ? ` ${unit}` : ""}
                            {reduction.zeroed > 0 && <span className="text-warn">
                              {" · "}{reduction.zeroed} would drop to 0
                            </span>}
                          </span>
                      : null}
                </p>
              </ConfirmModal>

              <ConfirmModal
                isOpen={removing !== null}
                title={removing ? `Remove ${removing.indent_no} from all items?` : "Remove from all items?"}
                message={removing
                  ? `${removing.indent_no} is left out of every item it is on in this cycle `
                    + `(${indentLineIds(allItems, removing.indent_id).length} line${indentLineIds(allItems, removing.indent_id).length === 1 ? "" : "s"}). `
                    + "It is not rejected: it stays in your queue for the next round, and you can include it again from any of its rows."
                  : ""}
                confirmLabel="Remove from all items"
                danger
                onClose={() => setRemoving(null)}
                onConfirm={() => { if (removing) removeEverywhere(removing); }}
              />
            </>}
  </>;
}
