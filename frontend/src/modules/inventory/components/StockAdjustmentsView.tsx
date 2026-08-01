import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Chip, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { Plus, Check, X, RefreshCw } from "lucide-react";
import {
  Button, Can, Card, Field, Input, PageHeader, ResponsiveList, Select, StatusPill, type Column,
} from "@/shared/components";
import {
  listStockAdjustments, createStockAdjustment, approveStockAdjustment, rejectStockAdjustment,
  getWarehouses, getCatalogItems,
} from "../api";

const REASONS = [
  { value: "DAMAGE", label: "Damage" },
  { value: "EXPIRY", label: "Expiry" },
  { value: "COUNT_VARIANCE", label: "Count Variance" },
  { value: "FOUND", label: "Found Stock" },
];

const DIRECTIONS = [
  { value: "IN", label: "IN (increase)" },
  { value: "OUT", label: "OUT (decrease)" },
];

const BLANK = {
  warehouse_id: "", item_id: "", reason: "COUNT_VARIANCE", direction: "IN",
  quantity: "", unit_cost: "", remarks: "",
};

type Adjustment = Record<string, any>;

export function StockAdjustmentsView() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...BLANK });
  const [error, setError] = useState("");
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["stock-adjustments"],
    queryFn: () => listStockAdjustments(),
  });
  const rows: Adjustment[] = data?.items ?? [];

  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses"], queryFn: getWarehouses });
  const { data: items = [] } = useQuery({ queryKey: ["catalog-items"], queryFn: getCatalogItems });

  const refresh = () => qc.invalidateQueries({ queryKey: ["stock-adjustments"] });
  const fail = (e: any) => setError(e?.response?.data?.error ?? "The action failed");

  const create = useMutation({
    mutationFn: () =>
      createStockAdjustment({
        warehouse_id: Number(form.warehouse_id),
        reason: form.reason,
        remarks: form.remarks,
        items: [{
          item_id: Number(form.item_id),
          direction: form.direction,
          quantity: Number(form.quantity),
          unit_cost: Number(form.unit_cost || 0),
        }],
      }),
    onSuccess: () => { setOpen(false); setForm({ ...BLANK }); setError(""); refresh(); },
    onError: fail,
  });

  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: number; approve: boolean }) =>
      approve ? approveStockAdjustment(id) : rejectStockAdjustment(id),
    onSuccess: () => { setError(""); refresh(); },
    onError: fail,
  });

  const valid = form.warehouse_id && form.item_id && Number(form.quantity) > 0;

  const actions = (r: Adjustment) =>
    r.status === "PENDING_APPROVAL" ? (
      <Can do="stock.adjust">
        <div className="flex gap-2">
          <Button onClick={() => decide.mutate({ id: r.id, approve: true })}>
            <Check size={14} /> Approve
          </Button>
          <Button variant="ghost" onClick={() => decide.mutate({ id: r.id, approve: false })}>
            <X size={14} /> Reject
          </Button>
        </div>
      </Can>
    ) : null;

  const columns: Column<Adjustment>[] = [
    { key: "adjustment_no", header: "Adj No", render: (r) => <strong>{r.adjustment_no}</strong> },
    { key: "warehouse_name", header: "Warehouse", render: (r) => r.warehouse_name ?? "-" },
    { key: "reason", header: "Reason", render: (r) => <Chip size="sm" variant="flat">{r.reason}</Chip> },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    { key: "created_by_name", header: "Created By", render: (r) => r.created_by_name ?? "-", hideOnNarrow: true },
    {
      key: "created_at", header: "Created", hideOnNarrow: true,
      render: (r) => (r.created_at ? new Date(r.created_at).toLocaleString() : "-"),
    },
    { key: "actions", header: "", render: actions },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title="Stock Adjustments"
        actions={
          <>
            <Button variant="ghost" onClick={refresh}><RefreshCw size={14} /> Refresh</Button>
            <Can do="stock.adjust">
              <Button onClick={() => setOpen(true)}><Plus size={14} /> New Adjustment</Button>
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
          empty="No adjustments yet."
          renderCard={(r) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-ink">{r.adjustment_no}</span>
                <StatusPill status={r.status} />
              </div>
              <div className="text-xs text-muted">{r.warehouse_name} · {r.reason}</div>
              {actions(r)}
            </div>
          )}
        />
      </Card>

      <Modal isOpen={open} onClose={() => setOpen(false)} size="lg">
        <ModalContent>
          <ModalHeader>Create Stock Adjustment</ModalHeader>
          <ModalBody className="space-y-3">
            <Field label="Warehouse">
              <Select
                value={form.warehouse_id}
                onChange={(v) => setForm({ ...form, warehouse_id: v })}
                options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
                placeholder="Select warehouse"
              />
            </Field>
            <Field label="Reason">
              <Select value={form.reason} onChange={(v) => setForm({ ...form, reason: v })} options={REASONS} />
            </Field>
            <Field label="Item">
              <Select
                value={form.item_id}
                onChange={(v) => setForm({ ...form, item_id: v })}
                options={items.map((i) => ({ value: i.id, label: `${i.code} — ${i.name}` }))}
                placeholder="Select item"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Direction">
                <Select value={form.direction} onChange={(v) => setForm({ ...form, direction: v })} options={DIRECTIONS} />
              </Field>
              <Field label="Quantity">
                <Input
                  type="number" min="0.001" step="0.001" value={form.quantity}
                  onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Unit Cost (optional)">
              <Input
                type="number" min="0" step="0.01" value={form.unit_cost}
                onChange={(e) => setForm({ ...form, unit_cost: e.target.value })}
              />
            </Field>
            <Field label="Remarks">
              <Input
                value={form.remarks}
                onChange={(e) => setForm({ ...form, remarks: e.target.value })}
                placeholder="Reason or inspection notes"
              />
            </Field>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!valid || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? "Saving…" : "Create"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
