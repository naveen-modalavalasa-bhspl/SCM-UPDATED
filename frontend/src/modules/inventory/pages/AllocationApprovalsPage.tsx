import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Pagination } from "@heroui/react";
import {
  Card, PageHeader, ResponsiveList, StatusPill, type Column,
} from "@/shared/components";
import { getAllocation, getPendingInventoryApprovals } from "../api";
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
  const [page, setPage] = useState(1);

  const queue = useQuery({
    queryKey: ["inventory", "allocation-approvals"],
    queryFn: async () => {
      const pending = await getPendingInventoryApprovals();
      return Promise.all(pending.map((item) => getAllocation(item.doc_id)));
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

  const rows = useMemo(() => {
    let items = queue.data ?? [];
    if (allocatorFilter) items = items.filter((r) => r.allocated_by_name === allocatorFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      items = items.filter((r) =>
        r.allocation_no.toLowerCase().includes(q) ||
        (r.indent_no && r.indent_no.toLowerCase().includes(q))
      );
    }
    return items;
  }, [queue.data, search, allocatorFilter]);

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
      render: (row) => (
        <div>
          <div className="text-sm text-ink">
            {fmt(row.items.reduce((sum, item) => sum + Number(item.quantity), 0))} approved to give
          </div>
          <div className="text-xs text-muted">
            of {fmt(row.items.reduce((sum, item) => sum + Number(item.requested_qty), 0))} requested
          </div>
        </div>
      ),
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
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Total Lines</div>
          <div className="text-2xl font-bold text-ink">
            {queue.isLoading ? "…" : rows.reduce((sum, r) => sum + r.items.length, 0)}
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
          setPage(1);
        }}
        active={(search ? 1 : 0) + (allocatorFilter ? 1 : 0)}
      >
        <FilterSelect
          value={allocatorFilter}
          onChange={(v) => { setAllocatorFilter(v); setPage(1); }}
          options={allAllocators}
          placeholder="All Allocators"
        />
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
            onRowClick={(row) => nav(`/inventory/allocation-approvals/${row.id}`)}
            empty="No allocation is waiting for you. Only approvals assigned to your active position appear here."
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
