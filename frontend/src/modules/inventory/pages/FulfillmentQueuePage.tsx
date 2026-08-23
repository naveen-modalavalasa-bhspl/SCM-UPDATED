import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Chip, Pagination } from "@heroui/react";
import { ClipboardList, Hourglass, PackageOpen } from "lucide-react";
import { PageHeader, Card, ResponsiveList, StatusPill, Button, type Column } from "@/shared/components";
import { FilterBar, FilterSelect } from "../components/FilterBar";
import { getFulfilmentBatches, getFulfillmentQueue, listAllocations } from "../api";
import { fmtDate } from "@/shared/datetime";

/**
 * Everything that still owes something — and the place to do something about it.
 *
 * ONE list, not four status buckets. A remainder is a remainder whatever status the
 * indent is sitting in, and filtering by status on top of it emptied the screen: an
 * indent part-served on its way up is PENDING_APPROVAL, an untouched one is
 * AWAITING_ALLOCATION, and neither is PARTIALLY_FULFILLED. Status is still offered as
 * an optional narrowing, never as the thing that defines the queue.
 *
 * Clicking a row opens the allocation screen, which is where the decision is
 * actually made: how much, out of which stocking point, split across as many as it
 * takes. Submitting there raises an ALLOCATION — nothing moves; the goods leave the
 * shelf at the warehouse material issue once that allocation is approved.
 */
interface QueueRow {
  id: number;
  indent_no: string;
  indent_type?: string | null;
  department_name?: string | null;
  requested_by_name?: string | null;
  current_approver_name?: string | null;
  priority?: string;
  status: string;
  total_items: number;
  created_at: string;
  /** Set on the one row that stands for a whole monthly cycle. A cycle of 900 indents
   *  is one decision, so it is one row here; clicking it opens the item-first split
   *  rather than 900 separate allocation screens. */
  cycle?: string;
  month_label?: string;
  consolidation_no?: string | null;
  indent_count?: number;
  owed_indent_count?: number;
  in_approval_indent_count?: number;
}

const STATUS_OPTIONS = [
  { value: "PENDING_APPROVAL", label: "In approval" },
  { value: "AWAITING_ALLOCATION", label: "To allocate" },
  { value: "ALLOCATED", label: "Ready to issue" },
  { value: "PARTIALLY_FULFILLED", label: "Part short" },
  { value: "PENDING_PROCUREMENT", label: "Nothing given" },
];


/**
 * Where a row leads. ONE destination for every indent, whatever state it is in.
 *
 * Routing by state — allocate here, the allocation there, the indent somewhere else —
 * meant two rows in the same list opened two different screens, and the ones the
 * allocate form refuses opened on a red error. The allocate screen now reads every
 * indent and says for itself when there is no decision left in it, so the click is
 * predictable and nothing is a dead end. A cycle is still its own thing: it is one
 * decision over many indents, not an indent.
 */
const destinationFor = (row: QueueRow) =>
  row.cycle ? `/inventory/fulfillment/${row.cycle}` : `/inventory/allocate/${row.id}`;

/** Stable id for a synthetic cycle row. Only has to be unique within this list. */
const hashCycle = (cycle: string) =>
  [...cycle].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 1_000_000, 7) || 1;

const ageInDays = (s?: string | null) =>
  s ? Math.floor((Date.now() - new Date(s).getTime()) / 86_400_000) : 0;

/** `embedded` drops this page's own header and intro, because the Fulfilment Desk
 *  wraps it as a tab and a screen must not print two headings. Everything else — the
 *  filters, the cycle rows, where a click leads — is identical either way, so the desk
 *  never has to keep a second copy of the queue's rules. */
export function FulfillmentQueuePage({ embedded = false }: { embedded?: boolean } = {}) {
  const [search, setSearch] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [deptFilter, setDeptFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [showDoneCycles, setShowDoneCycles] = useState(false);
  const nav = useNavigate();

  // Owed-only was the whole screen: `has_remainder` was hardcoded true, so an indent
  // left the queue the instant its last line was allocated and there was no way to
  // look up what had been fulfilled — or what was rejected on the way. Owed stays the
  // default, because that is the work; "Everything" drops the filter and lets the
  // Status select beside it narrow to any indent state.
  // Still owed by default. "Everything" is one choice away and the count stays honest
  // either way, but defaulting to it put every indent an approver had already served —
  // and every shortage already sent to procurement — back in front of the desk that
  // had just cleared it, which reads as "nothing I did stuck".
  const [view, setView] = useState("OWED");

  const queue = useQuery({
    queryKey: ["fulfillment-queue", view],
    queryFn: () => getFulfillmentQueue(undefined, view === "OWED"),
  });
  // An indent whose allocation is already waiting on an approver has been dealt with;
  // showing it again invites a second allocation the backend will refuse anyway.
  const pending = useQuery({
    queryKey: ["allocations", "PENDING_APPROVAL"],
    queryFn: () => listAllocations({ status: "PENDING_APPROVAL" }),
  });
  // Indent -> the allocation already waiting on it. Not just a membership test: an
  // indent an approver served out of their own stock has every line covered, so the
  // allocate screen has nothing to offer it and refuses ("already covered by an
  // allocation"). The row still has somewhere useful to go — the allocation itself.
  const pendingAllocationByIndent = useMemo(
    () => new Map((pending.data?.items ?? []).map(
      (allocation) => [allocation.indent_id, allocation.id])),
    [pending.data],
  );
  const pendingIndentIds = useMemo(
    () => new Set(pendingAllocationByIndent.keys()), [pendingAllocationByIndent]);

  // Monthly cycles, counted server-side off exactly the rows below. Fetched separately
  // rather than grouped here so the count on the row is the same number the batch
  // screen will open with.
  const batches = useQuery({
    queryKey: ["fulfilment-batches", showDoneCycles],
    // A cycle that has been fully allocated leaves the queue, which is right — but it
    // also became unfindable, so there was no way to look back at what was just done.
    queryFn: () => getFulfilmentBatches(showDoneCycles),
  });

  const all = useMemo(() => {
    const raw = (queue.data?.items ?? []) as unknown as QueueRow[];
    // A monthly indent is never its own row: it is part of a cycle, and the cycle is
    // the thing a storekeeper acts on. Regular indents are one-off requests and stay
    // exactly as they always were.
    const singles = raw.filter((r) => r.indent_type !== "MONTHLY");
    const cycleRows: QueueRow[] = (batches.data?.items ?? []).map((b) => ({
      // Negative, so a synthetic row can never collide with a real indent id.
      id: -Math.abs(hashCycle(b.cycle)),
      // The document number, not just the month: a month can hold more than one
      // consolidation once a batch has been sealed, and two rows both reading
      // "August 2026 — consolidated" would be indistinguishable.
      indent_no: b.consolidation_no
        ? `${b.month_label} — ${b.consolidation_no}`
        : `${b.month_label} — consolidated`,
      cycle: b.cycle,
      month_label: b.month_label,
      consolidation_no: b.consolidation_no,
      indent_count: b.indent_count,
      owed_indent_count: b.owed_indent_count,
      in_approval_indent_count: b.in_approval_indent_count,
      requested_by_name: `${b.requester_count} requester${b.requester_count === 1 ? "" : "s"}`,
      department_name: `${b.item_count} item${b.item_count === 1 ? "" : "s"}`,
      priority: b.urgent_count > 0 ? "URGENT" : "NORMAL",
      status: "AWAITING_ALLOCATION",
      total_items: b.item_count,
      created_at: b.oldest_raised_at ?? new Date().toISOString(),
    }));
    return [...cycleRows, ...singles];
  }, [queue.data, batches.data]);

  const allDepartments = useMemo(() => {
    const depts = new Set<string>();
    for (const item of all) if (item.department_name) depts.add(item.department_name);
    return Array.from(depts).sort().map((d) => ({ value: d, label: d }));
  }, [all]);

  const rows = useMemo(() => {
    let out = all;
    if (statusFilter) out = out.filter((r) => r.status === statusFilter);
    if (priorityFilter) out = out.filter((r) => r.priority === priorityFilter);
    if (deptFilter) out = out.filter((r) => r.department_name === deptFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter((r) =>
        r.indent_no?.toLowerCase().includes(q) ||
        r.requested_by_name?.toLowerCase().includes(q) ||
        r.department_name?.toLowerCase().includes(q)
      );
    }
    return out;
  }, [all, statusFilter, priorityFilter, deptFilter, search]);

  const awaitingAllocation = rows.filter((r) => !pendingIndentIds.has(r.id)).length;

  const columns: Column<QueueRow>[] = [
    {
      key: "no",
      header: "Indent",
      render: (r) => (
        <div>
          <div className={r.cycle
            ? "text-xs font-semibold text-ink"
            : "font-mono text-xs font-semibold text-ink"}>
            {r.indent_no}
          </div>
          <div className="text-[11px] text-muted">
            {/* Members first, then what is left in them. Both figures come off the
                consolidation document, so the screen this row opens prints the same
                two numbers — which is the whole point of the document existing. */}
            {r.cycle
              ? [`${r.indent_count} indents`,
                 `${r.owed_indent_count ?? r.indent_count} still to allocate`,
                 // Waiting on an allocation somebody already raised: not allocatable,
                 // not done. Left out, the row read "3 still to allocate" over a screen
                 // whose Submit could only come back with three refusals.
                 ...(r.in_approval_indent_count
                   ? [`${r.in_approval_indent_count} in approval`] : [])].join(" · ")
              : `${r.total_items} line${r.total_items === 1 ? "" : "s"}`}
          </div>
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
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    {
      key: "held",
      header: "Allocation",
      hideOnNarrow: true,
      render: (r) => pendingIndentIds.has(r.id)
        ? <span className="text-xs text-warn">Awaiting approval</span>
        : <span className="text-xs text-muted">—</span>,
    },
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
      key: "open",
      header: "",
      render: (r) => (
        <Button
          variant="ghost"
          // A cycle has no single indent behind it to open, so the button does what
          // the row does rather than pointing at an id that does not exist.
          //
          // No stopPropagation: the shared Button hands this to HeroUI's `onPress`,
          // which passes a PressEvent — calling a DOM method on it threw on every
          // click, so the button did nothing at all and only the row worked. HeroUI
          // does not bubble a press to the row, so there is nothing to stop.
          onClick={() =>
            nav(r.cycle ? `/inventory/fulfillment/${r.cycle}` : `/indents/${r.id}`)
          }
        >
          Open
        </Button>
      ),
    },
  ];

  const paged = rows.slice((page - 1) * 10, page * 10);

  return (
    <div>
      {!embedded && <PageHeader eyebrow="Inventory" title="Fulfilment Queue" />}

      <div className="mb-4 grid grid-cols-3 gap-2 lg:grid-cols-3">
        <Card className="p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            <ClipboardList size={12} /> Still owed
          </div>
          <div className="text-2xl font-bold text-brand">{queue.isLoading ? "…" : rows.length}</div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            <PackageOpen size={12} /> Nothing raised
          </div>
          <div className="text-2xl font-bold text-ink">{queue.isLoading ? "…" : awaitingAllocation}</div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            <Hourglass size={12} /> In approval
          </div>
          <div className="text-2xl font-bold text-warn">{rows.length - awaitingAllocation}</div>
        </Card>
      </div>

      <p className="mb-3 text-sm text-muted">
        Pick an indent to decide what to give. Goods hand over at warehouse issue.
      </p>

      <FilterBar
        search={search}
        onSearch={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="Search indent number, requester or department…"
        onClear={() => {
          setSearch("");
          setPriorityFilter("");
          setDeptFilter("");
          setStatusFilter("");
          setView("OWED");
          setPage(1);
        }}
        active={(search ? 1 : 0) + (priorityFilter ? 1 : 0) + (deptFilter ? 1 : 0)
          + (statusFilter ? 1 : 0) + (showDoneCycles ? 1 : 0)
          + (view === "OWED" ? 0 : 1)}
      >
        <FilterSelect
          value={view}
          onChange={(v) => { setView(v || "ALL"); setPage(1); }}
          options={[
            { value: "OWED", label: "Still owed" },
            { value: "ALL", label: "Everything" },
          ]}
          placeholder="Everything"
        />
        <FilterSelect
          value={statusFilter}
          onChange={(v) => { setStatusFilter(v); setPage(1); }}
          options={STATUS_OPTIONS}
          placeholder="Any status"
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
        <Button
          variant={showDoneCycles ? "soft" : "subtle"}
          onClick={() => { setShowDoneCycles((v) => !v); setPage(1); }}
        >
          {showDoneCycles ? "Hiding nothing" : "Show finished cycles"}
        </Button>
      </FilterBar>

      {queue.error ? (
        <p className="rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          {(queue.error as Error).message}
        </p>
      ) : (
        <Card className="p-2">
          <ResponsiveList
            data={paged}
            loading={queue.isLoading}
            keyOf={(r) => r.id}
            // Straight to the allocation screen. It already asks the only two
            // questions worth asking — how much, and out of which point — and does it
            // per line with splits, so the queue's job is to pick the indent, not to
            // reimplement the decision inline.
            // A cycle opens the item-first split; a single indent opens the allocation
            // screen it always opened.
            onRowClick={(r) => nav(destinationFor(r))}
            columns={columns}
            empty={view === "OWED"
              ? "Nothing owed right now. Switch to Everything to see fulfilled indents."
              : "No indent matches these filters."}
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
