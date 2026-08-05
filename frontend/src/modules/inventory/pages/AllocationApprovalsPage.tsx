import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Pagination,
} from "@heroui/react";
import { CheckCircle2, XCircle } from "lucide-react";
import {
  Button, Card, Field, Input, PageHeader, ResponsiveList, StatusPill, type Column,
} from "@/shared/components";
import {
  approveAllocation, getAllocation, getAllocationHistory,
  getPendingInventoryApprovals, rejectAllocation,
} from "../api";
import { FilterBar, FilterSelect } from "../components/FilterBar";
import type { Allocation } from "../types";

const fmt = (value: number) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);

export function AllocationApprovalsPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const reviewId = Number(searchParams.get("review"));
  const decisionView = searchParams.get("decision") === "1";
  const openedFromInbox = useRef(false);
  const [selected, setSelected] = useState<Allocation | null>(null);
  const [comments, setComments] = useState("");
  const [error, setError] = useState<string | null>(null);
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

  // Completed allocations are no longer present in the pending queue. My Decisions
  // therefore loads the selected document directly and presents this dialog read-only.
  const decidedAllocation = useQuery({
    queryKey: ["inventory", "allocation-decision", reviewId],
    queryFn: () => getAllocation(reviewId),
    enabled: decisionView && Number.isFinite(reviewId) && reviewId > 0,
  });

  // Who has signed so far, and under which hat. A post-based ladder can ask one
  // person for two signatures — Assistant Manager, then Inventory Manager — so
  // "approved by Siva" alone does not say how far along the document is.
  const history = useQuery({
    queryKey: ["inventory", "allocation-history", selected?.id],
    queryFn: () => getAllocationHistory(selected!.id),
    enabled: selected !== null,
  });

  const act = useMutation({
    mutationFn: ({ approve }: { approve: boolean }) =>
      approve
        ? approveAllocation(selected!.id, comments)
        : rejectAllocation(selected!.id, comments),
    onSuccess: () => {
      setSelected(null);
      setComments("");
      setError(null);
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["fulfillment-queue"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  useEffect(() => {
    if (openedFromInbox.current || !Number.isFinite(reviewId) || reviewId <= 0) return;
    const selectedAllocation = decisionView
      ? decidedAllocation.data
      : queue.data?.find((row) => row.id === reviewId);
    if (selectedAllocation) {
      openedFromInbox.current = true;
      setSelected(selectedAllocation);
    }
  }, [decidedAllocation.data, decisionView, queue.data, reviewId]);

  const closeSelected = () => {
    setSelected(null);
    setComments("");
    setError(null);
    if (decisionView) nav("/approvals/decisions");
  };

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

      {queue.error || decidedAllocation.error ? (
        <div className="rounded-lg bg-bad-bg p-4 text-sm text-bad">
          {((decidedAllocation.error || queue.error) as Error).message}
        </div>
      ) : (
        <Card className="p-2">
          <ResponsiveList
            data={rows.slice((page - 1) * 10, page * 10)}
            loading={queue.isLoading}
            keyOf={(row) => row.id}
            columns={columns}
            onRowClick={(row) => {
              setSelected(row);
              setComments("");
              setError(null);
            }}
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

      <Modal
        isOpen={selected !== null}
        onOpenChange={(open) => { if (!open) closeSelected(); }}
        placement="center"
        scrollBehavior="inside"
        size="2xl"
      >
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>Review {selected?.allocation_no}</ModalHeader>
              <ModalBody>
                {error && <div className="rounded-lg bg-bad-bg p-3 text-sm text-bad">{error}</div>}

                <div className="rounded-xl bg-content2 p-4 text-sm">
                  <div><strong>Indent:</strong> {selected?.indent_no}</div>
                  <div><strong>Decided by:</strong> {selected?.allocated_by_name ?? "—"}</div>
                  {selected?.remarks && <div><strong>Reason:</strong> {selected.remarks}</div>}
                </div>

                <div className="overflow-x-auto rounded-xl border border-line">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-content2 text-xs text-muted">
                      <tr>
                        <th className="p-3">Item</th>
                        <th className="p-3">Requested</th>
                        <th className="p-3">Give</th>
                        <th className="p-3">Warehouse</th>
                        <th className="p-3">Shortage</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {(selected?.items ?? []).map((item) => (
                        <tr key={item.id}>
                          <td className="p-3">
                            <div className="font-medium text-ink">{item.item_name}</div>
                            <div className="text-xs text-muted">{item.item_code}</div>
                          </td>
                          <td className="p-3">{fmt(item.requested_qty)} {item.uom_code}</td>
                          <td className="p-3 font-semibold text-ok">
                            {fmt(item.quantity)} {item.uom_code}
                          </td>
                          <td className="p-3">{item.warehouse_name ?? "Not allocated"}</td>
                          <td className="p-3 text-warn">
                            {fmt(Math.max(0, item.requested_qty - item.quantity))} {item.uom_code}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <section>
                  <h3 className="mb-2 text-sm font-semibold text-ink">Approval history</h3>
                  <div className="divide-y divide-line rounded-xl border border-line">
                    {history.isLoading && (
                      <p className="p-3 text-sm text-muted">Loading history…</p>
                    )}
                    {(history.data ?? []).map((row, index) => (
                      <div key={`${row.stage_sequence}-${index}`} className="p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <strong className="text-ink">{row.actor_name ?? "System"}</strong>
                            <p className="text-xs text-muted">
                              {row.stage_name ?? `Step ${row.stage_sequence}`}
                              {" · "}
                              {/* The hat matters: the same person signs each step
                                  under a different position. */}
                              {row.actor_position ?? "Position unavailable"}
                            </p>
                          </div>
                          <StatusPill status={row.action} />
                        </div>
                        {row.comments && (
                          <p className="mt-1 text-sm text-body">{row.comments}</p>
                        )}
                        <p className="mt-1 text-xs text-muted">
                          {row.acted_at ? new Date(row.acted_at).toLocaleString() : "—"}
                        </p>
                      </div>
                    ))}
                    {!history.isLoading && !(history.data ?? []).length && (
                      <p className="p-3 text-sm text-muted">
                        Nothing signed yet — this is the first step.
                      </p>
                    )}
                  </div>
                </section>

                {!decisionView && <Field label="Comments">
                  <Input
                    value={comments}
                    onChange={(event) => setComments(event.target.value)}
                    placeholder="Optional reason or instruction"
                  />
                </Field>}
              </ModalBody>
              <ModalFooter>
                <Button variant="ghost" onClick={decisionView ? closeSelected : onClose}>
                  {decisionView ? "Back to My Decisions" : "Cancel"}
                </Button>
                {!decisionView && <Button
                  variant="danger"
                  disabled={act.isPending}
                  onClick={() => act.mutate({ approve: false })}
                >
                  <XCircle className="h-4 w-4" /> Reject
                </Button>}
                {!decisionView && <Button
                  disabled={act.isPending}
                  onClick={() => act.mutate({ approve: true })}
                >
                  <CheckCircle2 className="h-4 w-4" /> Approve and reserve
                </Button>}
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </>
  );
}
