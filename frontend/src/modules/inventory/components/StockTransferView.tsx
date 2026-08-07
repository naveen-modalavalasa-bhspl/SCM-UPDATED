import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { ArrowRight, Plus, Trash2 } from "lucide-react";
import {
  Button, Can, Card, Field, Input, PageHeader, ResponsiveList, Select, StatCard, StatusPill, type Column,
  ResponsiveGrid,
} from "@/shared/components";
import { FilterBar, FilterSelect } from "./FilterBar";
import { DetailSheet, SheetRow, SheetSection } from "./DetailSheet";
import { MovementKindStrip } from "../pages/StockingPointsPage";
import {
  listSTOs, getSTO, createSTO, approveSTO, dispatchSTO, receiveSTO,
  getWarehouses, getCatalogItems, getStockBalances,
} from "../api";
import { alerts } from "@/modules/alerts";

/**
 * Stock transfer orders between warehouses.
 *
 * A transfer is a four-step document (raise → approve → dispatch → receive), not a
 * one-shot move, so the list is the screen and the form is a dialog on top of it. The
 * previous layout put a full creation panel beside the list on a tinted background,
 * which made it unclear which half you were meant to be looking at.
 */

type STO = Record<string, any>;

const STATUSES = ["PENDING_APPROVAL", "APPROVED", "DISPATCHED", "RECEIVED"];

/** The single action a transfer is waiting for, given where it is in the chain. */
const nextStep = (status: string) =>
  status === "PENDING_APPROVAL" ? { label: "Approve", run: approveSTO }
  : status === "APPROVED" ? { label: "Dispatch", run: dispatchSTO }
  : status === "DISPATCHED" ? { label: "Receive", run: receiveSTO }
  : null;

const BLANK_LINE = { item_id: "", requested_qty: "" };

export function StockTransferView() {
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<STO | null>(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ from_warehouse_id: "", to_warehouse_id: "", remarks: "" });
  const [lines, setLines] = useState([{ ...BLANK_LINE }]);
  const qc = useQueryClient();

  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses"], queryFn: getWarehouses });
  const { data: catalog = [] } = useQuery({ queryKey: ["catalog-items"], queryFn: getCatalogItems });

  const { data, isLoading } = useQuery({
    queryKey: ["stos", status],
    queryFn: () => listSTOs({ status: status || undefined, size: 100 }),
  });

  // Stock at the source warehouse, so a line cannot be raised for something not there.
  const { data: sourceStock } = useQuery({
    queryKey: ["stock-at", form.from_warehouse_id],
    queryFn: () => getStockBalances({ warehouse_id: form.from_warehouse_id, size: 200 }),
    enabled: !!form.from_warehouse_id,
  });
  const available = useMemo(() => {
    const map = new Map<number, number>();
    (sourceStock?.items ?? []).forEach((s) =>
      map.set(s.item_id, (map.get(s.item_id) ?? 0) + s.available_qty));
    return map;
  }, [sourceStock]);

  const rows: STO[] = useMemo(() => {
    const all: STO[] = data?.items ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) =>
      r.sto_no?.toLowerCase().includes(q) ||
      r.from_warehouse_name?.toLowerCase().includes(q) ||
      r.to_warehouse_name?.toLowerCase().includes(q));
  }, [data, search]);

  const counts = useMemo(() => {
    const all: STO[] = data?.items ?? [];
    return {
      pending: all.filter((r) => r.status === "PENDING_APPROVAL").length,
      inTransit: all.filter((r) => r.status === "DISPATCHED").length,
      done: all.filter((r) => r.status === "RECEIVED").length,
    };
  }, [data]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["stos"] });
  const fail = (e: any) => setError(e?.response?.data?.error ?? "The action failed");
  /** Alerts name things, not ids: "Bolt M8 from Main Store", never "17 from 3". */
  const itemName = (id: string | number) =>
    catalog.find((i) => String(i.id) === String(id))?.name ?? "the item";
  const warehouseName = (id: string | number) =>
    warehouses.find((w) => String(w.id) === String(id))?.name ?? "the warehouse";

  const advance = useMutation({
    mutationFn: (
      { id, run }: { id: number; run: (id: number) => Promise<unknown>; row: STO; label: string },
    ) => run(id),
    onSuccess: (_result, { row, label }) => {
      // Receiving is the only step that actually lands the stock, so it gets the
      // "now at" wording; approve and dispatch only move the paperwork along.
      if (label === "Receive") {
        void alerts.success("stock.transferred", {
          qty: row.total_qty ?? row.items?.[0]?.requested_qty ?? "The stock",
          item: row.items?.[0]?.item_name ?? "the transferred items",
          destination: row.to_warehouse_name ?? "the destination",
        });
      } else {
        void alerts.success("stock.transfer_advanced", {
          number: row.sto_no ?? "The transfer",
          status: label === "Approve" ? "approved" : "dispatched",
        });
      }
      setError(""); setSelected(null); refresh();
    },
    onError: fail,
  });

  const openDetail = useMutation({
    mutationFn: getSTO,
    onSuccess: (d: STO) => { setSelected(d); setError(""); },
    onError: fail,
  });

  const create = useMutation({
    mutationFn: () =>
      createSTO({
        from_warehouse_id: Number(form.from_warehouse_id),
        to_warehouse_id: Number(form.to_warehouse_id),
        remarks: form.remarks || undefined,
        items: lines
          .filter((l) => l.item_id && Number(l.requested_qty) > 0)
          .map((l) => ({ item_id: Number(l.item_id), requested_qty: Number(l.requested_qty) })),
      }),
    onSuccess: (created: STO) => {
      void alerts.success("stock.transfer_raised", { number: created?.sto_no ?? "The transfer" });
      setOpen(false);
      setForm({ from_warehouse_id: "", to_warehouse_id: "", remarks: "" });
      setLines([{ ...BLANK_LINE }]);
      setError("");
      refresh();
    },
    onError: fail,
  });

  const askThenCreate = async () => {
    const first = validLines[0];
    if (!(await alerts.confirm("stock.transfer", {
      qty: first?.requested_qty ?? "",
      item: itemName(first?.item_id ?? ""),
      source: warehouseName(form.from_warehouse_id),
      destination: warehouseName(form.to_warehouse_id),
    }))) return;
    create.mutate();
  };

  const validLines = lines.filter((l) => l.item_id && Number(l.requested_qty) > 0);
  const sameWarehouse = !!form.from_warehouse_id && form.from_warehouse_id === form.to_warehouse_id;
  const canSubmit = !!form.from_warehouse_id && !!form.to_warehouse_id && !sameWarehouse && validLines.length > 0;

  const stepButton = (r: STO) => {
    const step = nextStep(r.status);
    if (!step) return null;
    return (
      <Can do="stock.transfer">
        <Button onClick={() => advance.mutate({ id: r.id, run: step.run, row: r, label: step.label })}>{step.label}</Button>
      </Can>
    );
  };

  const columns: Column<STO>[] = [
    {
      key: "sto_no",
      header: "Transfer No",
      render: (r) => <span className="font-mono text-xs font-semibold text-ink">{r.sto_no}</span>,
    },
    {
      key: "route",
      header: "Route",
      render: (r) => (
        <div className="flex items-center gap-2 text-sm">
          <span className="truncate text-body">{r.from_warehouse_name}</span>
          <ArrowRight size={14} className="shrink-0 text-muted" />
          <span className="truncate text-body">{r.to_warehouse_name}</span>
        </div>
      ),
    },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    { key: "requested_by_name", header: "Raised By", render: (r) => r.requested_by_name ?? "—", hideOnNarrow: true },
    {
      key: "created_at", header: "Raised On", hideOnNarrow: true,
      render: (r) => (r.created_at ? new Date(r.created_at).toLocaleDateString() : "—"),
    },
    { key: "action", header: "", render: stepButton },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title="Stock Transfers"
        actions={
          <Can do="stock.transfer">
            <Button onClick={() => setOpen(true)}><Plus size={14} /> New Transfer</Button>
          </Can>
        }
      />

      <ResponsiveGrid cols={3} className="mb-4">
        <StatCard label="Awaiting Approval" value={counts.pending} tone={counts.pending ? "text-warning" : "text-muted"} />
        <StatCard label="In Transit" value={counts.inTransit} tone={counts.inTransit ? "text-brand" : "text-muted"} />
        <StatCard label="Received" value={counts.done} tone="text-success" />
      </ResponsiveGrid>

      {error && (
        <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</div>
      )}

      <FilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search transfer number or warehouse…"
        onClear={() => { setSearch(""); setStatus(""); }}
        active={[search, status].filter(Boolean).length}
      >
        <FilterSelect
          value={status}
          onChange={setStatus}
          placeholder="All statuses"
          options={STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, " ") }))}
        />
      </FilterBar>

      <Card className="p-2">
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          onRowClick={(r) => openDetail.mutate(r.id)}
          empty="No transfers raised yet."
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-sm font-semibold text-ink">{r.sto_no}</span>
                <StatusPill status={r.status} />
              </div>
              <div className="text-sm text-body">{r.from_warehouse_name} → {r.to_warehouse_name}</div>
              {stepButton(r)}
            </div>
          )}
        />
      </Card>

      <Modal isOpen={open} onClose={() => setOpen(false)} size="2xl" scrollBehavior="inside">
        <ModalContent>
          <ModalHeader>New Stock Transfer</ModalHeader>
          <ModalBody className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="From warehouse">
                <Select
                  value={form.from_warehouse_id}
                  onChange={(v) => setForm({ ...form, from_warehouse_id: v })}
                  options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
                  placeholder="Source"
                />
              </Field>
              <Field label="To warehouse">
                <Select
                  value={form.to_warehouse_id}
                  onChange={(v) => setForm({ ...form, to_warehouse_id: v })}
                  options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
                  placeholder="Destination"
                />
              </Field>
            </div>
            {sameWarehouse && (
              <p className="text-sm text-danger">Source and destination must be different warehouses.</p>
            )}

            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold text-ink">Items</span>
                <button
                  onClick={() => setLines([...lines, { ...BLANK_LINE }])}
                  className="text-sm font-medium text-brand hover:underline"
                >
                  + Add line
                </button>
              </div>
              <div className="space-y-2">
                {lines.map((line, i) => {
                  const stock = line.item_id ? available.get(Number(line.item_id)) ?? 0 : null;
                  const over = stock !== null && Number(line.requested_qty) > stock;
                  return (
                    <div key={i} className="flex items-end gap-2">
                      <div className="flex-1">
                        <Select
                          value={line.item_id}
                          onChange={(v) => setLines(lines.map((l, j) => (j === i ? { ...l, item_id: v } : l)))}
                          options={catalog.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` }))}
                          placeholder="Select item"
                        />
                        {stock !== null && (
                          <span className={`mt-1 block text-xs ${over ? "text-danger" : "text-muted"}`}>
                            {over ? `Only ${stock} available at source` : `${stock} available at source`}
                          </span>
                        )}
                      </div>
                      <div className="w-32">
                        <Input
                          type="number" min="0.001" step="0.001" placeholder="Qty"
                          value={line.requested_qty}
                          onChange={(e) =>
                            setLines(lines.map((l, j) => (j === i ? { ...l, requested_qty: e.target.value } : l)))
                          }
                        />
                      </div>
                      {lines.length > 1 && (
                        <button
                          onClick={() => setLines(lines.filter((_, j) => j !== i))}
                          aria-label="Remove line"
                          className="flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-content2 hover:text-danger"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* What this move IS comes from the two points, never from a dropdown —
                letting a user pick would make "Movement" a one-click way past the
                Inventory Manager on a cross-project transfer. They say WHY. */}
            <MovementKindStrip
              fromWarehouseId={form.from_warehouse_id ? Number(form.from_warehouse_id) : null}
              toWarehouseId={form.to_warehouse_id ? Number(form.to_warehouse_id) : null}
            />

            <Field label="Reason">
              <Input
                value={form.remarks}
                onChange={(e) => setForm({ ...form, remarks: e.target.value })}
                placeholder="Why the stock is moving — e.g. camp restock, rebalancing"
              />
            </Field>
          </ModalBody>
          <ModalFooter>
            <Button variant="subtle" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!canSubmit || create.isPending} onClick={() => void askThenCreate()}>
              {create.isPending ? "Raising…" : "Raise Transfer"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <DetailSheet
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.sto_no ?? ""}
        subtitle={selected ? `${selected.from_warehouse_name} → ${selected.to_warehouse_name}` : undefined}
        badge={selected && <StatusPill status={selected.status} />}
        footer={
          <>
            <Button variant="subtle" onClick={() => setSelected(null)}>Close</Button>
            {selected && stepButton(selected)}
          </>
        }
      >
        {selected && (
          <>
            <SheetSection title="Progress">
              <SheetRow label="Raised by" value={selected.requested_by_name} />
              <SheetRow label="Raised on" value={selected.created_at ? new Date(selected.created_at).toLocaleString() : null} />
              <SheetRow label="Approved by" value={selected.approved_by_name} />
              <SheetRow label="Dispatched" value={selected.dispatched_at ? new Date(selected.dispatched_at).toLocaleString() : null} />
              <SheetRow label="Received" value={selected.received_at ? new Date(selected.received_at).toLocaleString() : null} />
              <SheetRow label="Remarks" value={selected.remarks} />
            </SheetSection>

            <SheetSection title={`Items (${selected.items?.length ?? 0})`}>
              <div className="space-y-2">
                {(selected.items ?? []).map((it: any) => (
                  <div key={it.id} className="rounded-lg border border-line/70 p-3">
                    <div className="font-medium text-ink">{it.item_name}</div>
                    <div className="font-mono text-[11px] text-muted">{it.item_code}</div>
                    <div className="mt-2 flex flex-wrap gap-4 text-sm">
                      <span>Requested <strong>{it.requested_qty}</strong></span>
                      <span className="text-muted">Dispatched {it.dispatched_qty}</span>
                      <span className="text-muted">Received {it.received_qty}</span>
                      <span className="text-[11px] text-muted">{it.uom_code}</span>
                    </div>
                  </div>
                ))}
              </div>
            </SheetSection>
          </>
        )}
      </DetailSheet>
    </div>
  );
}
