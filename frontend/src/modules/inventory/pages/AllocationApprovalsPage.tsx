import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getAllocationApprovalBatches } from "../api";
import { Pagination } from "@heroui/react";
import {
  Button, Card, PageHeader, ResponsiveList, StatusPill, type Column,
} from "@/shared/components";
import { getPendingInventoryApprovals, listAllocations } from "../api";
import { FilterBar, FilterSelect } from "../components/FilterBar";
import type { Allocation } from "../types";

const fmt = (value: number) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);

/**
 * The review itself lives at /inventory/allocation-approvals/:id
 * (AllocationApprovalDetailPage) — a real screen, not a popup card. This page is
 * only the queue: browse, filter, click through.
 */
export function AllocationApprovalsPage() {
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const reviewId = Number(searchParams.get("review"));
  const decisionView = searchParams.get("decision") === "1";
  const redirectedFromInbox = useRef(false);
  const [search, setSearch] = useState("");
  const [allocatorFilter, setAllocatorFilter] = useState("");
  // A signed cycle leaves the queue, which is right — but it also became unfindable,
  // search included, so there was no way to confirm what had just been approved.
  const [showDone, setShowDone] = useState(false);
  const [page, setPage] = useState(1);

  // Which decisions to list. The screen was an inbox and nothing else: it asked only
  // for what is WAITING on this hat, so an allocation vanished the moment it was
  // signed and there was no way to look up what was approved or why something was
  // rejected. Every decision is the default now — signing something must not make it
  // disappear from the screen you signed it on — and "Waiting for me" narrows back to
  // the work in one click.
  const [decision, setDecision] = useState("ALL");

  const queue = useQuery({
    queryKey: ["inventory", "allocation-approvals", decision],
    queryFn: async () => {
      if (decision === "WAITING") {
        // Two requests, not one per row: the inbox says WHICH allocations are mine,
        // the list carries the rows themselves. Opening each one was fine for an inbox
        // of five and unusable for a monthly cycle of nine hundred.
        const [pending, all] = await Promise.all([
          getPendingInventoryApprovals(),
          listAllocations({ status: "PENDING_APPROVAL" }),
        ]);
        const mine = new Set(pending.map((item) => item.doc_id));
        return (all.items ?? [])
          .filter((row) => mine.has(row.id))
          .map((row) => ({ ...row, remarks: null, items: [] } as unknown as Allocation));
      }
      // A decided allocation is read from the allocation list, not the approval
      // inbox: the inbox only ever holds what is still owed a signature.
      // AWAITING_PROCUREMENT is a signed allocation whose shortfall is being bought.
      // It belongs in "every decision" — leaving it out made a document that is very
      // much alive disappear from the screen it was signed on.
      const wanted = decision === "ALL"
        ? ["PENDING_APPROVAL", "AWAITING_PROCUREMENT", "APPROVED", "REJECTED"]
        : [decision];
      const pages = await Promise.all(
        wanted.map((status) => listAllocations({ status })));
      const rows = pages.flatMap((p) => p.items ?? []);
      // Newest first. The line totals come down with the list itself now — this used
      // to open the newest forty allocations one request at a time just to add their
      // quantities up, which is forty round trips before the screen could paint.
      rows.sort((a, b) => b.id - a.id);
      return rows.map((row) => ({ ...row, remarks: null, items: [] } as unknown as Allocation));
    },
  });

  // Old inbox links pointed at ?review=X(&decision=1) and opened a modal in place.
  // The modal is gone, so the same link now forwards to the routed detail page —
  // existing bookmarks and the Approvals inbox's links keep working.
  useEffect(() => {
    if (redirectedFromInbox.current || !Number.isFinite(reviewId) || reviewId <= 0) return;
    redirectedFromInbox.current = true;
    nav(`/inventory/allocation-approvals/${reviewId}${decisionView ? "?decision=1" : ""}`, {
      replace: true,
    });
  }, [decisionView, nav, reviewId]);

  const allAllocators = useMemo(() => {
    const allocs = new Set<string>();
    for (const row of queue.data ?? []) {
      if (row.allocated_by_name) allocs.add(row.allocated_by_name);
    }
    return Array.from(allocs).sort().map(a => ({ value: a, label: a }));
  }, [queue.data]);

  // Monthly cycles, counted server-side off the same pending rows. A cycle of 900
  // allocations is ONE decision for the approver, so it takes one row in this list
  // and opens its own screen — exactly like a single allocation does.
  const batches = useQuery({
    queryKey: ["allocation-approval-batches", showDone],
    queryFn: () => getAllocationApprovalBatches(showDone),
  });

  const rows = useMemo(() => {
    const cycleIds = new Set(
      (batches.data?.items ?? []).flatMap((b) => b.allocation_ids));
    const cycleRows = (batches.data?.items ?? []).map((b) => ({
      // Negative, so a synthetic row can never collide with a real allocation id.
      id: -Math.abs([...b.cycle].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1e6, 7) || 1),
      allocation_no: b.consolidation_no
        ? `${b.month_label} — ${b.consolidation_no}`
        : `${b.month_label} — consolidated`,
      // What this hat can still sign, not the raw pending count: after level 1 the
      // rows stay pending at level 2, and the row read "6 allocations" while the
      // buttons inside could sign none of them.
      // `indent_count` is the consolidation's membership, so it is the same figure
      // the Fulfilment Queue prints for this cycle — the two screens can no longer
      // answer different questions under the same word.
      // Both numbers, always. Printing the actionable count alone under the word
      // "allocations" made this row read "7 allocations" over a screen headed 51 —
      // two true answers to two different questions, under one label.
      indent_no: `${b.actionable_count} to sign · ${b.allocation_count} allocation`
        + `${b.allocation_count === 1 ? "" : "s"} · ${b.indent_count} indents`,
      status: b.pending_count ? "PENDING_APPROVAL" : "APPROVED",
      allocated_by_name: "Monthly cycle",
      cycle: b.cycle,
      total_qty: b.total_qty,
      requested_total: b.total_qty,
      items: [],
    })) as unknown as Allocation[];

    // The individual allocations inside a cycle are represented by their cycle row;
    // listing them twice would invite approving the same thing from two places.
    let items = (queue.data ?? []).filter((r) => !cycleIds.has(r.id));
    items = [...cycleRows, ...items];
    if (allocatorFilter) items = items.filter((r) => r.allocated_by_name === allocatorFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      items = items.filter((r) =>
        r.allocation_no.toLowerCase().includes(q) ||
        (r.indent_no && r.indent_no.toLowerCase().includes(q))
      );
    }
    return items;
  }, [queue.data, batches.data, search, allocatorFilter]);

  const columns: Column<Allocation>[] = [
    {
      key: "allocation",
      header: "Allocation",
      render: (row) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{row.allocation_no}</div>
          <div className="text-xs text-muted">{row.indent_no}</div>
        </div>
      ),
    },
    {
      key: "decision",
      header: "Inventory decision",
      // Totals come off the row itself — the server adds them up in one grouped query.
      render: (row) => (row.total_qty === undefined ? (
        <span className="text-xs text-muted">Open to see</span>
      ) : (
        <div>
          <div className="text-sm text-ink">{fmt(row.total_qty)} approved to give</div>
          <div className="text-xs text-muted">
            of {fmt(row.requested_total ?? row.total_qty)} requested
          </div>
        </div>
      )),
    },
    {
      key: "allocator",
      header: "Decided by",
      render: (row) => row.allocated_by_name ?? "—",
    },
    {
      key: "status",
      header: "Status",
      render: (row) => <StatusPill status={row.status} />,
    },
  ];

  return (
    <>
      <PageHeader eyebrow="Inventory" title="Allocation Approvals" />
      <p className="mb-4 max-w-[70ch] text-sm text-body">
        Inventory has decided how much stock to promise. Approving reserves exactly
        that quantity; any shortage becomes one Material Request.
      </p>

      <div className="mb-4 grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-line/70 bg-content1 p-3 text-left">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Total Approvals</div>
          <div className="text-2xl font-bold text-ink">{queue.isLoading ? "…" : rows.length}</div>
        </div>
        <div className="rounded-xl border border-line/70 bg-content1 p-3 text-left">
          {/* Was "total lines", which only counted the rows whose detail happened to
              be loaded. Still pending is the number this screen is actually for. */}
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Still Pending</div>
          <div className="text-2xl font-bold text-ink">
            {queue.isLoading
              ? "…"
              : rows.filter((r) => r.status === "PENDING_APPROVAL").length}
          </div>
        </div>
      </div>

      <FilterBar
        search={search}
        onSearch={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="Search allocation or indent no…"
        onClear={() => {
          setSearch("");
          setAllocatorFilter("");
          setDecision("ALL");
          setPage(1);
        }}
        active={(search ? 1 : 0) + (allocatorFilter ? 1 : 0) + (showDone ? 1 : 0)
          + (decision === "ALL" ? 0 : 1)}
      >
        {/* Every decision by default; "Waiting for me" is the first narrowing, so the
            screen is both the queue and the record of what it decided. */}
        <FilterSelect
          value={decision}
          onChange={(v) => { setDecision(v || "ALL"); setPage(1); }}
          options={[
            { value: "ALL", label: "All decisions" },
            { value: "WAITING", label: "Waiting for me" },
            { value: "APPROVED", label: "Approved" },
            // Signed, but the shortfall is on order — it comes back for a top-up when
            // the goods land, so it is worth being able to list on its own.
            { value: "AWAITING_PROCUREMENT", label: "Waiting on procurement" },
            { value: "REJECTED", label: "Rejected" },
          ]}
          placeholder="All decisions"
        />
        <FilterSelect
          value={allocatorFilter}
          onChange={(v) => { setAllocatorFilter(v); setPage(1); }}
          options={allAllocators}
          placeholder="All Allocators"
        />
        <Button
          variant={showDone ? "soft" : "subtle"}
          onClick={() => { setShowDone((v) => !v); setPage(1); }}
        >
          {showDone ? "Hiding nothing" : "Show signed cycles"}
        </Button>
      </FilterBar>

      {queue.error ? (
        <div className="rounded-lg bg-bad-bg p-4 text-sm text-bad">
          {(queue.error as Error).message}
        </div>
      ) : (
        <Card className="p-2">
          <ResponsiveList
            data={rows.slice((page - 1) * 10, page * 10)}
            loading={queue.isLoading}
            keyOf={(row) => row.id}
            columns={columns}
            onRowClick={(row) => nav((row as { cycle?: string }).cycle
              ? `/inventory/allocation-approvals/cycle/${(row as { cycle?: string }).cycle}`
              : `/inventory/allocation-approvals/${row.id}`)}
            empty={decision === "WAITING"
              ? "No allocation is waiting for you. Only approvals assigned to your active position appear here."
              : "No allocation matches this filter."}
            renderCard={(row) => (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm font-semibold text-ink">
                    {row.allocation_no}
                  </span>
                  <StatusPill status={row.status} />
                </div>
                <p className="text-sm text-body">{row.indent_no}</p>
                <p className="text-xs text-muted">
                  {fmt(row.total_qty ?? 0)} to give · decided by {row.allocated_by_name ?? "—"}
                </p>
              </div>
            )}
          />
          {rows.length > 0 && (
            <div className="mt-4 flex justify-center pb-2">
              <Pagination
                isCompact
                showControls
                color="primary"
                page={page}
                total={Math.max(1, Math.ceil(rows.length / 10))}
                onChange={setPage}
              />
            </div>
          )}
        </Card>
      )}

    </>
  );
}
