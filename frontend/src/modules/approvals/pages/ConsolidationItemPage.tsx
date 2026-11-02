import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft, Check, ClipboardList, Info, Package, PackageCheck, RefreshCw, RotateCcw,
  Search, SlidersHorizontal, Undo2, UserX, Users, X,
} from "lucide-react";
import {
  Button, Card, PageHeader, ResponsiveList, Select, StatCard, type Column,
} from "@/shared/components";
import { approvalsApi } from "../api";
import { useConsolidationDecisions } from "../consolidationDecisions";
import { PriorityFilter, PriorityTag } from "../components/PriorityFilter";
import { formatQty, resolveItem } from "./ConsolidationPage";
import type { ConsolidationIndentSummary } from "../types";
import { guardNumberKeys } from "@/shared/quantity";

/** One consolidated item, and everyone who asked for it.
 *
 *  The consolidation screen answers "what does this month need"; this one answers
 *  "who needs it, and what does each of them get". They used to be the same screen —
 *  every item carried its own split, and the batch's indents were listed again
 *  underneath — which put the same twenty indent numbers in front of the approver
 *  several times over and left the exclude box as free text nobody trusted.
 *
 *  Nothing new is fetched: the batch already ships each item's `allocations`, so this
 *  is the same cached workspace response the consolidation screen is showing, read
 *  one item deep. The quantity and the exclusions are held in the shared per-cycle
 *  draft (`consolidationDecisions.ts`) — set here, spent by Approve all over there.
 */

/** One requester's line for this item: their share of the allocation, joined to the
 *  indent header the batch already carries, so the row can be filtered by the same
 *  dimensions the rest of the module offers. */
interface ItemRow {
  line_id: number;
  indent_id: number;
  indent_no: string;
  requested_quantity: number;
  allocated: number;
  excluded: boolean;
  /** Dropped at a rung BELOW this approver — read-only here, not theirs to undo. */
  excludedBelow: boolean;
  excludedByName: string | null;
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
  const item = batch?.consolidated_items.find((row) => String(row.item_id) === itemId) ?? null;

  const { decisions, setApproved, toggleExcluded, includeAll } = useConsolidationDecisions(cycle);
  const decision = decisions[itemId];

  const [search, setSearch] = useState("");
  const [priority, setPriority] = useState("");

  const resolved = item ? resolveItem(item, decision) : null;

  // Every requester of this item, in one row each. Built from the allocations rather
  // than from the batch's indents: an indent that does not carry this item has no
  // business on this screen.
  const rows: ItemRow[] = useMemo(() => {
    if (!item || !resolved) return [];
    const byId = new Map((batch?.indents ?? []).map((row) => [row.id, row]));
    const excluded = (decision?.excluded ?? []).map((no) => no.toUpperCase());
    return (item.allocations ?? []).map((allocation) => ({
      line_id: allocation.line_id,
      indent_id: allocation.indent_id,
      indent_no: allocation.indent_no,
      requested_quantity: allocation.requested_quantity,
      allocated: resolved.split.get(allocation.line_id) ?? 0,
      excluded: Boolean(allocation.is_excluded)
        || excluded.includes(allocation.indent_no.toUpperCase()),
      // Already dropped further down the ladder. That decision is made: this approver
      // reads it, and is not offered a button to redo or undo it (BUG_SCM_0008).
      excludedBelow: Boolean(allocation.is_excluded),
      excludedByName: allocation.excluded_by_name ?? null,
      indent: byId.get(allocation.indent_id),
    }));
  }, [batch, decision, item, resolved]);

  // Search and priority hide rows; they never change the split. What each requester
  // gets depends on who is excluded, not on who the approver is currently looking at —
  // a filtered-out indent still holds its share.
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
  const control = "h-11 rounded-xl border border-line bg-content1 text-sm text-ink outline-none focus:border-brand";

  const columns: Column<ItemRow>[] = [
    {
      key: "indent",
      header: "Indent",
      render: (row) => <div className="flex min-w-0 items-center gap-2.5">
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
      </div>,
    },
    {
      key: "region",
      header: "Region",
      hideOnNarrow: true,
      render: (row) => <span className="text-muted">{row.indent?.region_name ?? "—"}</span>,
    },
    {
      key: "project",
      header: "Project",
      hideOnNarrow: true,
      render: (row) => <span className="text-muted">{row.indent?.project_name ?? "—"}</span>,
    },
    {
      key: "vehicle",
      header: "Vehicle",
      hideOnNarrow: true,
      render: (row) => <span className="text-muted">{row.indent?.vehicle_number ?? "—"}</span>,
    },
    {
      key: "requested",
      header: "Requested",
      render: (row) => <span className="tabular text-body">{formatQty(row.requested_quantity)}</span>,
    },
    {
      key: "allocated",
      header: "Gets",
      // The number, and how much of the ask it covers. A cut is the whole point of this
      // screen, and a bar says "this one is being halved" faster than two numbers do.
      render: (row) => {
        if (row.excluded) {
          return <span className="inline-flex items-center rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-warn">
            Excluded
          </span>;
        }
        const pct = share(row.allocated, row.requested_quantity);
        return <div className="w-24">
          <span className="flex items-baseline gap-1.5">
            <strong className="tabular text-ink">{formatQty(row.allocated)}</strong>
            <span className="tabular text-[11px] text-muted">{pct}%</span>
          </span>
          <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-content2">
            <span
              className={`block h-full rounded-full ${pct >= 100 ? "bg-ok" : pct > 0 ? "bg-brand" : "bg-line"}`}
              style={{ width: `${pct}%` }}
            />
          </span>
        </div>;
      },
    },
    {
      key: "action",
      header: "",
      render: (row) => (row.excludedBelow ? (
        <span className="text-xs text-muted">
          {row.excludedByName ? `Excluded by ${row.excludedByName}` : "Already excluded"}
        </span>
      ) : <button
        type="button"
        onClick={() => toggleExcluded(Number(itemId), row.indent_no)}
        className={`flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition-colors ${
          row.excluded
            ? "border-brand text-brand hover:bg-brand-050"
            : "border-line text-muted hover:border-danger hover:text-danger"
        }`}
      >
        {row.excluded ? <><Undo2 className="h-3.5 w-3.5" /> Include</> : <><UserX className="h-3.5 w-3.5" /> Exclude</>}
      </button>),
    },
  ];

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
            <div className="h-36 animate-pulse rounded-2xl border border-line/70 bg-content1" />
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
                      Every indent in this cycle that asked for it. Set the total going
                      out and it is shared in proportion to what each one requested;
                      exclude an indent and its share goes to the rest.
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

              {/* The two decisions on this screen, side by side and visibly separate:
                  how much goes out, and who is left out of it. */}
              <Card className="mb-4 overflow-hidden">
                <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                  {/* Outside a table on purpose: <ResponsiveList> renders a react-aria
                      grid, and a grid cell swallows the keystrokes an <input> needs. */}
                  <label className="block border-b border-line/70 bg-brand-050/40 p-4 lg:border-b-0 lg:border-r">
                    <span className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                      <SlidersHorizontal className="h-3.5 w-3.5 text-brand" /> Approve (total)
                    </span>
                    <span className="relative block">
                      <input
                        className={`${control} h-12 w-full px-3 text-lg font-semibold tabular placeholder:font-normal placeholder:text-muted ${
                          item.uom_code ? "pr-16" : ""
                        }`}
                        type="number" onKeyDown={guardNumberKeys}
                        min={0}
                        max={resolved.ceiling}
                        // The unit's own step. A countable item cannot be typed as
                        // 5.7 here any more than it can be split into 5.7 below.
                        step={item.uom_decimals === 0 ? 1 : "any"}
                        inputMode={item.uom_decimals === 0 ? "numeric" : "decimal"}
                        aria-label={`Approved quantity for ${name}`}
                        placeholder={formatQty(resolved.ceiling)}
                        value={decision?.approved ?? ""}
                        onChange={(e) => setApproved(Number(itemId), e.target.value)}
                      />
                      {item.uom_code && (
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold uppercase tracking-wide text-muted">
                          {item.uom_code}
                        </span>
                      )}
                    </span>
                    <span className="mt-1.5 block text-xs">
                      {resolved.invalid
                        ? <span className="text-danger">Enter a quantity of 0 or more.</span>
                        : resolved.over
                          ? <span className="text-danger">Capped at {formatQty(resolved.ceiling)}.</span>
                          : resolved.rounded
                            // A countable unit has no fractions to give away. Said out
                            // loud, because the number keyed in is not the number that
                            // goes out — 1.3 boxes used to read back as 1.3 while the
                            // split handed over 1.
                            ? <span className="text-warn">
                                {item.uom_code ?? "This unit"} goes out in whole units
                                — sending {formatQty(resolved.total)}.
                              </span>
                            : <span className="text-muted">
                                Blank sends the full {formatQty(resolved.ceiling)}.
                              </span>}
                    </span>
                  </label>

                  <div className="p-4">
                    <span className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                      <UserX className="h-3.5 w-3.5 text-brand" /> Leave an indent out
                    </span>
                    {/* Picking a real indent, not typing one: the old free-text box
                        matched on substrings, so "IND-1" quietly excluded IND-10 too. */}
                    <Select
                      // Remounted on every change so the box clears itself — it is an
                      // action, not a field holding a value.
                      key={`exclude-${resolved.droppedCount}`}
                      ariaLabel="Exclude an indent from this item"
                      placeholder="Search an indent no. or requester…"
                      value=""
                      onChange={(next) => { if (next) toggleExcluded(Number(itemId), next); }}
                      options={rows.filter((row) => !row.excluded).map((row) => ({
                        value: row.indent_no,
                        label: `${row.indent_no} · ${row.indent?.requested_by_name ?? "—"} · ${formatQty(row.requested_quantity)}`,
                      }))}
                    />
                    {resolved.droppedCount === 0
                      ? <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                          <Check className="h-3.5 w-3.5 text-ok" />
                          Everyone who asked is getting a share.
                        </p>
                      : <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          {(decision?.excluded ?? []).map((indentNo) => (
                            <button
                              key={indentNo}
                              type="button"
                              onClick={() => toggleExcluded(Number(itemId), indentNo)}
                              className="flex items-center gap-1 rounded-full bg-warn/15 px-2.5 py-1 font-mono text-xs font-semibold text-warn hover:bg-warn/25"
                            >
                              {indentNo} <X className="h-3 w-3" />
                            </button>
                          ))}
                          <button
                            type="button"
                            onClick={() => includeAll(Number(itemId))}
                            className="flex items-center gap-1 px-1.5 text-xs font-medium text-muted hover:text-ink"
                          >
                            <RotateCcw className="h-3 w-3" /> Include all
                          </button>
                        </div>}
                  </div>
                </div>
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

              <ResponsiveList
                data={shown}
                columns={columns}
                keyOf={(row) => row.line_id}
                empty="No indent here matches."
                renderCard={(row) => <div className={`space-y-2 ${row.excluded ? "opacity-75" : ""}`}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2.5">
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
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <strong className={`font-mono ${row.excluded ? "text-muted line-through" : "text-ink"}`}>
                          {row.indent_no}
                        </strong>
                        <PriorityTag priority={row.indent?.priority} />
                      </span>
                    </span>
                    {row.excludedBelow ? (
                      <span className="text-xs text-muted">
                        {row.excludedByName ? `Excluded by ${row.excludedByName}` : "Already excluded"}
                      </span>
                    ) : <button
                      type="button"
                      onClick={() => toggleExcluded(Number(itemId), row.indent_no)}
                      className={`flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold ${
                        row.excluded ? "border-brand text-brand" : "border-line text-muted"
                      }`}
                    >
                      {row.excluded ? <><Undo2 className="h-3.5 w-3.5" /> Include</> : <><UserX className="h-3.5 w-3.5" /> Exclude</>}
                    </button>}
                  </div>
                  <p className="text-sm text-body">{row.indent?.requested_by_name ?? "—"}</p>
                  <p className="text-xs text-muted">
                    {[row.indent?.region_name, row.indent?.project_name, row.indent?.vehicle_number]
                      .filter(Boolean).join(" · ") || "—"}
                  </p>
                  <p className="text-xs text-muted">
                    Requested {formatQty(row.requested_quantity)}
                    {" · gets "}
                    {row.excluded
                      ? <span className="font-semibold text-warn">nothing</span>
                      : <><strong className="text-ink">{formatQty(row.allocated)}</strong>
                          {" "}({share(row.allocated, row.requested_quantity)}%)</>}
                  </p>
                  {!row.excluded && (
                    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-content2">
                      <span
                        className={`block h-full rounded-full ${
                          share(row.allocated, row.requested_quantity) >= 100 ? "bg-ok" : "bg-brand"
                        }`}
                        style={{ width: `${share(row.allocated, row.requested_quantity)}%` }}
                      />
                    </span>
                  )}
                </div>}
              />

              <p className="mt-3 flex items-start gap-2 rounded-xl border border-line/70 bg-content2/60 p-3 text-xs text-muted">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
                <span>
                  Nothing here is saved on its own —{" "}
                  <strong className="font-semibold text-body">Approve all</strong>, back on
                  the consolidation, is what sends these quantities to the indents.
                </span>
              </p>
            </>}
  </>;
}
