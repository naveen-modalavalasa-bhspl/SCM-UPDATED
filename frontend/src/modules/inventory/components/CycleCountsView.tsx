import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { Plus, Pencil, CircleCheck, RefreshCw } from "lucide-react";
import {
  Button, Can, Card, Field, Input, PageHeader, ResponsiveList, Select, StatusPill, type Column,
} from "@/shared/components";
import {
  listCycleCounts, createCycleCount, getCycleCount, updateCycleCount, postCycleCount, getWarehouses,
} from "../api";

type Count = Record<string, any>;

const today = () => new Date().toISOString().slice(0, 10);

export function CycleCountsView() {
  const [planOpen, setPlanOpen] = useState(false);
  const [plan, setPlan] = useState({ warehouse_id: "", count_date: today() });
  const [active, setActive] = useState<Count | null>(null);
  const [counted, setCounted] = useState<Record<number, string>>({});
  const [error, setError] = useState("");
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({ queryKey: ["cycle-counts"], queryFn: () => listCycleCounts() });
  const rows: Count[] = data?.items ?? [];
  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses"], queryFn: getWarehouses });

  const refresh = () => qc.invalidateQueries({ queryKey: ["cycle-counts"] });
  const fail = (e: any) => setError(e?.response?.data?.error ?? "The action failed");

  const create = useMutation({
    mutationFn: () => createCycleCount({ warehouse_id: Number(plan.warehouse_id), count_date: plan.count_date }),
    onSuccess: () => { setPlanOpen(false); setPlan({ warehouse_id: "", count_date: today() }); setError(""); refresh(); },
    onError: fail,
  });

  const openCounts = useMutation({
    mutationFn: (id: number) => getCycleCount(id),
    onSuccess: (detail: Count) => {
      setActive(detail);
      setCounted(Object.fromEntries(
        (detail.items ?? []).map((it: any) => [it.id, String(it.counted_qty ?? it.snapshot_qty ?? 0)]),
      ));
      setError("");
    },
    onError: fail,
  });

  const save = useMutation({
    mutationFn: () =>
      updateCycleCount(active!.id, {
        items: Object.entries(counted).map(([id, qty]) => ({ id: Number(id), counted_qty: Number(qty) })),
      }),
    onSuccess: () => { setActive(null); setError(""); refresh(); },
    onError: fail,
  });

  const post = useMutation({
    mutationFn: postCycleCount,
    onSuccess: () => { setError(""); refresh(); },
    onError: fail,
  });

  const actions = (r: Count) =>
    r.status !== "COMPLETED" ? (
      <Can do="stock.adjust">
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => openCounts.mutate(r.id)}>
            <Pencil size={14} /> Enter Counts
          </Button>
          {r.status === "IN_PROGRESS" && (
            <Button onClick={() => post.mutate(r.id)}>
              <CircleCheck size={14} /> Post Variance
            </Button>
          )}
        </div>
      </Can>
    ) : null;

  const columns: Column<Count>[] = [
    { key: "count_no", header: "Count No", render: (r) => <strong>{r.count_no}</strong> },
    { key: "warehouse_name", header: "Warehouse", render: (r) => r.warehouse_name ?? "-" },
    { key: "count_date", header: "Count Date", render: (r) => r.count_date ?? "-" },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    { key: "planned_by_name", header: "Planned By", render: (r) => r.planned_by_name ?? "-", hideOnNarrow: true },
    { key: "actions", header: "", render: actions },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title="Cycle Counting"
        actions={
          <>
            <Button variant="ghost" onClick={refresh}><RefreshCw size={14} /> Refresh</Button>
            <Can do="stock.adjust">
              <Button onClick={() => setPlanOpen(true)}><Plus size={14} /> Plan Cycle Count</Button>
            </Can>
          </>
        }
      />

      {error && (
        <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</div>
      )}

      <Card className="p-2">
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          empty="No cycle counts planned."
          renderCard={(r) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-ink">{r.count_no}</span>
                <StatusPill status={r.status} />
              </div>
              <div className="text-xs text-muted">{r.warehouse_name} · {r.count_date}</div>
              {actions(r)}
            </div>
          )}
        />
      </Card>

      <Modal isOpen={planOpen} onClose={() => setPlanOpen(false)}>
        <ModalContent>
          <ModalHeader>Plan Cycle Count</ModalHeader>
          <ModalBody className="space-y-3">
            <Field label="Warehouse">
              <Select
                value={plan.warehouse_id}
                onChange={(v) => setPlan({ ...plan, warehouse_id: v })}
                options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
                placeholder="Select warehouse"
              />
            </Field>
            <Field label="Count Date">
              <Input type="date" value={plan.count_date} onChange={(e) => setPlan({ ...plan, count_date: e.target.value })} />
            </Field>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={() => setPlanOpen(false)}>Cancel</Button>
            <Button disabled={!plan.warehouse_id || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? "Saving…" : "Plan"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={!!active} onClose={() => setActive(null)} size="2xl" scrollBehavior="inside">
        <ModalContent>
          <ModalHeader>Enter Counts — {active?.count_no}</ModalHeader>
          <ModalBody className="space-y-2">
            {(active?.items ?? []).map((it: any) => (
              <div key={it.id} className="flex items-center justify-between gap-4 rounded-lg border border-line/70 p-3">
                <div>
                  <div className="font-medium text-ink">{it.item_name ?? `Item #${it.item_id}`}</div>
                  <div className="text-xs text-muted">System snapshot: {it.snapshot_qty}</div>
                </div>
                <div className="w-36">
                  <Input
                    type="number" min="0" step="0.001"
                    value={counted[it.id] ?? ""}
                    onChange={(e) => setCounted({ ...counted, [it.id]: e.target.value })}
                  />
                </div>
              </div>
            ))}
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={() => setActive(null)}>Cancel</Button>
            <Button disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save Counts"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
