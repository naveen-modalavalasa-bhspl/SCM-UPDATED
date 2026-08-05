import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Chip, Pagination } from "@heroui/react";
import { PageHeader, Card, ResponsiveList, StatusPill, type Column } from "@/shared/components";
import { FilterBar, FilterSelect } from "../components/FilterBar";
import { getFulfillmentQueue, listAllocations } from "../api";

/**
 * What the availability check decided, per indent.
 *
 * Reads /api/indents filtered by status rather than a queue endpoint of its own: the
 * indent list already answers this question, and a second route would be a second
 * thing to keep in step. All four buckets are fetched together so each tab can show
 * its own count without a click.
 */
interface QueueRow {
  id: number;
  indent_no: string;
  department_name?: string | null;
  requested_by_name?: string | null;
  current_approver_name?: string | null;
  priority?: string;
  status: string;
  total_items: number;
  created_at: string;
}

const BUCKETS = [
  { key: "AWAITING_ALLOCATION", label: "To allocate", hint: "Waiting for someone to decide what to issue." },
  { key: "ALLOCATED", label: "Ready to issue", hint: "Stock is held; the store can hand it over." },
  { key: "PARTIALLY_FULFILLED", label: "Part short", hint: "Some lines issued, the rest went to procurement." },
  { key: "PENDING_PROCUREMENT", label: "Nothing given", hint: "No stock at all; buying starts from here." },
];

const fmtDate = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) : "—";

const ageInDays = (s?: string | null) =>
  s ? Math.floor((Date.now() - new Date(s).getTime()) / 86_400_000) : 0;

export function FulfillmentQueuePage() {
  const [status, setStatus] = useState(BUCKETS[0].key);
  const [search, setSearch] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [deptFilter, setDeptFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const nav = useNavigate();

  const results = useQueries({
    queries: BUCKETS.map((b) => ({
      queryKey: ["fulfillment-queue", b.key],
      queryFn: () => getFulfillmentQueue(b.key),
    })),
  });
  const pending = useQuery({
    queryKey: ["allocations", "PENDING_APPROVAL"],
    queryFn: () => listAllocations({ status: "PENDING_APPROVAL" }),
  });
  const pendingIndentIds = useMemo(
    () => new Set((pending.data?.items ?? []).map((allocation) => allocation.indent_id)),
    [pending.data],
  );

  const allDepartments = useMemo(() => {
    const depts = new Set<string>();
    for (const res of results) {
      const items = (res.data?.items ?? []) as unknown as QueueRow[];
      for (const item of items) {
        if (item.department_name) depts.add(item.department_name);
      }
    }
    return Array.from(depts).sort().map(d => ({ value: d, label: d }));
  }, [results]);

  const visibleItems = (index: number) => {
    const items = (results[index]?.data?.items ?? []) as unknown as QueueRow[];
    let bucketItems = BUCKETS[index].key === "AWAITING_ALLOCATION"
      ? items.filter((indent) => !pendingIndentIds.has(indent.id))
      : items;

    if (statusFilter && BUCKETS[index].key !== statusFilter) {
      bucketItems = [];
    }

    if (priorityFilter) {
      bucketItems = bucketItems.filter((r) => r.priority === priorityFilter);
    }
    if (deptFilter) {
      bucketItems = bucketItems.filter((r) => r.department_name === deptFilter);
    }

    const q = search.trim().toLowerCase();
    if (q) {
      bucketItems = bucketItems.filter((r) =>
        r.indent_no?.toLowerCase().includes(q) ||
        r.requested_by_name?.toLowerCase().includes(q) ||
        r.department_name?.toLowerCase().includes(q)
      );
    }
    return bucketItems;
  };

  const activeIndex = BUCKETS.findIndex((b) => b.key === status);
  const active = results[activeIndex];
  const rows = visibleItems(activeIndex);

  const columns: Column<QueueRow>[] = [
    {
      key: "no",
      header: "Indent",
      render: (r) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{r.indent_no}</div>
          <div className="text-[11px] text-muted">{r.total_items} line{r.total_items === 1 ? "" : "s"}</div>
        </div>
      ),
    },
    {
      key: "who",
      header: "Requested by",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-ink">{r.requested_by_name ?? "—"}</div>
          <div className="truncate text-[11px] text-muted">{r.department_name ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "priority",
      header: "Priority",
      render: (r) =>
        r.priority ? (
          <Chip size="sm" variant="flat" color={r.priority === "URGENT" ? "danger" : "default"}>{r.priority}</Chip>
        ) : "—",
    },
    { key: "status", header: "Outcome", render: (r) => <StatusPill status={r.status} /> },
    {
      key: "age",
      header: "Waiting",
      hideOnNarrow: true,
      render: (r) => {
        const d = ageInDays(r.created_at);
        return <span className={d > 7 ? "text-warning" : "text-muted"}>{d} day{d === 1 ? "" : "s"}</span>;
      },
    },
    {
      key: "date",
      header: "Raised",
      hideOnNarrow: true,
      render: (r) => <span className="text-muted">{fmtDate(r.created_at)}</span>,
    },
  ];

  return (
    <div>
      <PageHeader eyebrow="Inventory" title="Fulfilment Queue" />

      {/* Counts live on the tabs, so the queue's shape is visible without clicking. */}
      <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {BUCKETS.map((b, i) => {
          const count = visibleItems(i).length;
          const on = b.key === status;
          return (
            <button
              key={b.key}
              onClick={() => {
                setStatus(b.key);
                setStatusFilter(""); // Clear filter so we see the full bucket
                setPage(1);
              }}
              aria-pressed={on}
              className={`rounded-xl border p-3 text-left ${
                on ? "border-brand bg-brand/5" : "border-line/70 bg-content1 hover:bg-content2"
              }`}
            >
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{b.label}</div>
              <div className={`text-2xl font-bold ${on ? "text-brand" : "text-ink"}`}>
                {results[i]?.isLoading ? "…" : count}
              </div>
            </button>
          );
        })}
      </div>

      <p className="mb-3 text-sm text-muted">{BUCKETS[activeIndex]?.hint}</p>

      <FilterBar
        search={search}
        onSearch={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="Search indent number, requester or department…"
        onClear={() => {
          setSearch("");
          setPriorityFilter("");
          setDeptFilter("");
          setStatusFilter("");
          setPage(1);
        }}
        active={(search ? 1 : 0) + (priorityFilter ? 1 : 0) + (deptFilter ? 1 : 0) + (statusFilter ? 1 : 0)}
      >
        <FilterSelect
          value={statusFilter}
          onChange={(v) => { 
            setStatusFilter(v); 
            if (v) setStatus(v); // Route to the respective tab automatically
            setPage(1); 
          }}
          options={BUCKETS.map(b => ({ value: b.key, label: b.label }))}
          placeholder="All Outcomes"
        />
        <FilterSelect
          value={priorityFilter}
          onChange={(v) => { setPriorityFilter(v); setPage(1); }}
          options={[
            { value: "URGENT", label: "Urgent" },
            { value: "NORMAL", label: "Normal" },
          ]}
          placeholder="All Priorities"
        />
        <FilterSelect
          value={deptFilter}
          onChange={(v) => { setDeptFilter(v); setPage(1); }}
          options={allDepartments}
          placeholder="All Departments"
        />
      </FilterBar>

      {active?.error ? (
        <p className="rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          {(active.error as Error).message}
        </p>
      ) : (
        <Card className="p-2">
          <ResponsiveList
            data={rows.slice((page - 1) * 10, page * 10)}
            loading={active?.isLoading || (status === "AWAITING_ALLOCATION" && pending.isFetching)}
            keyOf={(r) => r.id}
            // An indent waiting on a decision opens the allocation screen; one already
            // decided opens the indent itself. Clicking the row should do the thing the
            // row is actually asking for.
            onRowClick={(r) =>
              nav(r.status === "AWAITING_ALLOCATION" ? `/inventory/allocate/${r.id}` : `/indents/${r.id}`)
            }
            columns={columns}
            empty="Nothing in this bucket. Indents appear once they clear approval and the stock check has run."
            renderCard={(r) => (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm font-semibold text-ink">{r.indent_no}</span>
                  <StatusPill status={r.status} />
                </div>
                <p className="text-sm text-body">{r.requested_by_name ?? "—"} · {r.department_name ?? "—"}</p>
                <p className="text-xs text-muted">
                  {r.total_items} lines · raised {fmtDate(r.created_at)} · waiting {ageInDays(r.created_at)}d
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
    </div>
  );
}
