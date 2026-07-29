import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader,
} from "@heroui/react";
import { CheckCircle2, XCircle } from "lucide-react";
import {
  Button, Card, Field, Input, PageHeader, ResponsiveList, StatusPill, type Column,
} from "@/shared/components";
import {
  approveAllocation, getAllocation, getPendingInventoryApprovals, rejectAllocation,
} from "../api";
import type { Allocation } from "../types";

const fmt = (value: number) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);

export function AllocationApprovalsPage() {
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const reviewId = Number(searchParams.get("review"));
  const openedFromInbox = useRef(false);
  const [selected, setSelected] = useState<Allocation | null>(null);
  const [comments, setComments] = useState("");
  const [error, setError] = useState<string | null>(null);

  const queue = useQuery({
    queryKey: ["inventory", "allocation-approvals"],
    queryFn: async () => {
      const pending = await getPendingInventoryApprovals();
      return Promise.all(pending.map((item) => getAllocation(item.doc_id)));
    },
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
    if (openedFromInbox.current || !Number.isFinite(reviewId) || reviewId <= 0 || !queue.data) return;
    const selectedAllocation = queue.data.find((row) => row.id === reviewId);
    if (selectedAllocation) {
      openedFromInbox.current = true;
      setSelected(selectedAllocation);
    }
  }, [queue.data, reviewId]);

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

      {queue.error ? (
        <div className="rounded-lg bg-bad-bg p-4 text-sm text-bad">
          {(queue.error as Error).message}
        </div>
      ) : (
        <Card className="p-2">
          <ResponsiveList
            data={queue.data ?? []}
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
        </Card>
      )}

      <Modal
        isOpen={selected !== null}
        onOpenChange={() => setSelected(null)}
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

                <Field label="Comments">
                  <Input
                    value={comments}
                    onChange={(event) => setComments(event.target.value)}
                    placeholder="Optional reason or instruction"
                  />
                </Field>
              </ModalBody>
              <ModalFooter>
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                <Button
                  variant="danger"
                  disabled={act.isPending}
                  onClick={() => act.mutate({ approve: false })}
                >
                  <XCircle className="h-4 w-4" /> Reject
                </Button>
                <Button
                  disabled={act.isPending}
                  onClick={() => act.mutate({ approve: true })}
                >
                  <CheckCircle2 className="h-4 w-4" /> Approve and reserve
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </>
  );
}
