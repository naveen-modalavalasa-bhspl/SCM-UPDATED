import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Chip, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { Plus, Check, X, RefreshCw, Download } from "lucide-react";
import {
  Button, Can, Card, Field, Input, PageHeader, ResponsiveList, Select, StatusPill, type Column,
} from "@/shared/components";
import {
  listStockAdjustments, createStockAdjustment, approveStockAdjustment, rejectStockAdjustment,
  getWarehouses, getCatalogItems,
} from "../api";
import { alerts } from "@/modules/alerts";
import { DetailSheet, SheetRow, SheetSection } from "./DetailSheet";
import { ErrorNote } from "./PageStates";
// offer COUNT_VARIANCE and FOUND, which are not in that enum — the reason went
// unvalidated, so they were stored and reported on as if they were real categories.
const REASONS = [
  { value: "DAMAGE", label: "Damage" },
  { value: "EXPIRY", label: "Expiry" },
  { value: "CYCLE_COUNT", label: "Count Variance" },
  { value: "EXCESS", label: "Found Stock" },
  { value: "SHORTAGE", label: "Shortage" },
  { value: "QUALITY_REJECTION", label: "Quality Rejection" },
  { value: "OPENING_BALANCE", label: "Opening Balance" },
  { value: "OTHER", label: "Other" },
];

const DIRECTIONS = [
  { value: "IN", label: "IN (increase)" },
  { value: "OUT", label: "OUT (decrease)" },
];

const BLANK = {
  warehouse_id: "", item_id: "", reason: "CYCLE_COUNT", direction: "IN",
  quantity: "", unit_cost: "", remarks: "",
};

type Adjustment = Record<string, any>;

export function StockAdjustmentsView() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...BLANK });
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Adjustment | null>(null);
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
  /** The alert names the item, not its id — the id means nothing to a storekeeper. */
  const itemName = (id: string) =>
    items.find((i) => String(i.id) === String(id))?.name ?? "the item";

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
    onSuccess: () => {
      void alerts.success("adjustment.posted", { item: itemName(form.item_id), qty: form.quantity });
      setOpen(false); setForm({ ...BLANK }); setError(""); refresh();
    },
    onError: fail,
  });

  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: number; approve: boolean; row: Adjustment }) =>
      approve ? approveStockAdjustment(id) : rejectStockAdjustment(id),
    onSuccess: (_result, { approve, row }) => {
      if (approve) {
        void alerts.success("adjustment.approved", {
          item: row.items?.[0]?.item_name ?? "The item",
          qty: row.items?.[0]?.quantity ?? "the counted quantity",
        });
      } else {
        void alerts.success("adjustment.rejected");
      }
      setError(""); refresh();
    },
    onError: fail,
  });

  const askThenCreate = async () => {
    if (!(await alerts.confirm("stock.adjust", {
      item: itemName(form.item_id), qty: form.quantity,
    }))) return;
    create.mutate();
  };
  const askThenDecide = async (row: Adjustment, approve: boolean) => {
    if (approve && !(await alerts.confirm("adjustment.approve", {
      item: row.items?.[0]?.item_name ?? "this item",
    }))) return;
    decide.mutate({ id: row.id, approve, row });
  };

  const valid = form.warehouse_id && form.item_id && Number(form.quantity) > 0;

  const actions = (r: Adjustment) =>
    r.status === "PENDING_APPROVAL" ? (
      <Can do="stock.adjust">
        <div className="flex gap-2">
          <Button onClick={() => void askThenDecide(r, true)}>
            <Check size={14} /> Approve
          </Button>
          <Button variant="subtle" onClick={() => void askThenDecide(r, false)}>
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

  const exportCsv = () => {
    const header = ["Adj No", "Warehouse", "Reason", "Status", "Created By", "Created At"];
    const cell = (v: any) => {
      if (v == null) return '""';
      const s = String(v).replace(/"/g, '""');
      return `"${s}"`;
    };
    const body = rows.map((r) => [
      r.adjustment_no, r.warehouse_name, r.reason, r.status, r.created_by_name, 
      r.created_at ? new Date(r.created_at).toLocaleString() : "-"
    ]);
    const csv = [header, ...body].map((line) => line.map(cell).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `stock-adjustments-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title="Stock Adjustments"
        actions={
          <>
            {/* ghost + 16px icon, the app-wide header-action shape. See StockBalanceView. */}
            <Button variant="ghost" disabled={rows.length === 0} onClick={exportCsv}>
              <Download className="h-4 w-4" /> Export CSV
            </Button>
            <Button variant="subtle" onClick={refresh}><RefreshCw size={14} /> Refresh</Button>
            <Can do="stock.adjust">
              <Button onClick={() => setOpen(true)}><Plus size={14} /> New Adjustment</Button>
            </Can>
          </>
        }
      />

      {error && <div className="mb-3"><ErrorNote message={error} /></div>}

      <Card className="p-2">
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          onRowClick={setSelected}
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
            <Button variant="subtle" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!valid || create.isPending} onClick={() => void askThenCreate()}>
              {create.isPending ? "Saving…" : "Create"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <DetailSheet
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.adjustment_no ?? ""}
        subtitle={selected?.warehouse_name}
        badge={selected && <StatusPill status={selected.status} />}
      >
        {selected && (
          <>
            <SheetSection title="Details">
              <SheetRow label="Reason" value={selected.reason} />
              <SheetRow label="Created By" value={selected.created_by_name} />
              <SheetRow label="Created At" value={selected.created_at ? new Date(selected.created_at).toLocaleString() : "-"} />
              <SheetRow label="Remarks" value={selected.remarks} />
            </SheetSection>
            
            <SheetSection title="Adjusted Items">
              {selected.items?.length ? (
                <div className="space-y-3">
                  {selected.items.map((item: any, i: number) => (
                    <div key={i} className="rounded-lg border border-line/70 p-3">
                      <div className="font-semibold text-ink">{item.item_name || "Unknown Item"}</div>
                      <div className="mt-1 flex gap-4 text-sm">
                        <span>Direction: <strong>{item.direction}</strong></span>
                        <span>Qty: <strong>{item.quantity}</strong></span>
                        {item.unit_cost > 0 && <span>Cost: ₹{item.unit_cost}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted">No items found.</p>
              )}
            </SheetSection>
          </>
        )}
      </DetailSheet>
    </div>
  );
}
