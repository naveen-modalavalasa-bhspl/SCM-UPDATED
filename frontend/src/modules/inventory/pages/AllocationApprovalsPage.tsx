import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getAllocationApprovalBatches } from "../api";
import { Pagination } from "@heroui/react";
import {
  Button, Card, PageHeader, ResponsiveList, StatusPill, type Column,
} from "@/shared/components";
import { getAllocation, getPendingInventoryApprovals, listAllocations } from "../api";
import { FilterBar, FilterSelect } from "../components/FilterBar";
import type { Allocation } from "../types";

const fmt = (value: number) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);

/** How many of the listed allocations are fetched in full so their line totals can be
 *  shown in the table. One request each, so it is a window, not the whole history. */
const DETAIL_LIMIT = 40;

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
        const pending = await getPendingInventoryApprovals();
        return Promise.all(pending.map((item) => getAllocation(item.doc_id)));
      }
      // A decided allocation is read from the allocation list, not the approval
      // inbox: the inbox only ever holds what is still owed a signature.
      const wanted = decision === "ALL"
        ? ["PENDING_APPROVAL", "APPROVED", "REJECTED"] : [decision];
      const pages = await Promise.all(
        wanted.map((status) => listAllocations({ status })));
      const rows = pages.flatMap((p) => p.items ?? []);
      // Newest first, and only the newest few carry their lines: pulling every
      // allocation's detail was one request per row, which was survivable while this
      // list was an inbox of a handful and is not now that it opens on every
      // decision ever made. The rest show their totals when they are opened.
      rows.sort((a, b) => b.id - a.id);
      const detailed = await Promise.all(
        rows.slice(0, DETAIL_LIMIT).map((row) => getAllocation(row.id)));
      return [
        ...detailed,
        ...rows.slice(DETAIL_LIMIT).map((row) => ({
          ...row, remarks: null, items: [],
        } as unknown as Allocation)),
      ];
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
      allocation_no: `${b.month_label} — consolidated`,
      // What this hat can still sign, not the raw pending count: after level 1 the
      // rows stay pending at level 2, and the row read "6 allocations" while the
      // buttons inside could sign none of them.
      indent_no: `${b.actionable_count || b.allocation_count} allocations`
        + ` · ${b.indent_count} indents`,
      status: b.pending_count ? "PENDING_APPROVAL" : "APPROVED",
      allocated_by_name: "Monthly cycle",
      cycle: b.cycle,
      items: b.allocations.flatMap((a) => a.lines.map((l) => ({
        quantity: l.quantity, requested_qty: l.quantity,
      }))),
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
      // A row outside the detail window has no lines to add up. "Open to see" is the
      // truth; a confident 0 is not.
      render: (row) => (row.items.length ? (
        <div>
          <div className="text-sm text-ink">
            {fmt(row.items.reduce((sum, item) => sum + Number(item.quantity), 0))} approved to give
          </div>
          <div className="text-xs text-muted">
            of {fmt(row.items.reduce((sum, item) => sum + Number(item.requested_qty), 0))} requested
          </div>
        </div>
      ) : <span className="text-xs text-muted">Open to see</span>),
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
                  {fmt(row.items.reduce((sum, item) => sum + Number(item.quantity), 0))}
                  {" "}to give · decided by {row.allocated_by_name ?? "—"}
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
