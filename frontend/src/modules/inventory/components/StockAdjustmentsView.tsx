import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { Plus, Check, X, RefreshCw, Download, Trash2 } from "lucide-react";
import {
  Button, Can, Card, Field, FilterBar, FilterDateRange, FilterMenu, Input, PageHeader,
  ResponsiveList, Select, StatusPill, type Column,
} from "@/shared/components";
import {
  listStockAdjustments, createStockAdjustment, approveStockAdjustment, rejectStockAdjustment,
  getStockAdjustment, getAdjustmentCountSheet, getWarehouses, getCatalogItems,
} from "../api";
import type { StockAdjustment, StockAdjustmentLine } from "../types";
import { alerts } from "@/modules/alerts";
import { DetailSheet, SheetRow, SheetSection } from "./DetailSheet";
import { ErrorNote } from "./PageStates";
import { TONE_APPROVE, TONE_REJECT, TONE_MINT, TONE_BLUE } from "@/shared/components/tones";

// Mirrors shared.enums.AdjustmentReason — the service refuses anything else.
const REASONS = [
  { value: "CYCLE_COUNT", label: "Stock audit (count variance)" },
  { value: "DAMAGE", label: "Damage" },
  { value: "EXPIRY", label: "Expiry" },
  { value: "EXCESS", label: "Found stock" },
  { value: "SHORTAGE", label: "Shortage" },
  { value: "QUALITY_REJECTION", label: "Quality rejection" },
  { value: "OPENING_BALANCE", label: "Opening balance" },
  { value: "OTHER", label: "Other" },
];
const reasonLabel = (v: string) => REASONS.find((r) => r.value === v)?.label ?? v;

const STATUS_TABS = [
  { value: "", label: "All" },
  { value: "PENDING_APPROVAL", label: "Pending approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
];

/** One row of the count sheet: the system figure and what was physically found. */
type CountLine = {
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  system_qty: number;
  /** Blank means "not counted", and the line is left off the audit. */
  physical: string;
};

const fmt = (n: number) => Number(n.toFixed(3)).toString();
const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : fmt(n));

/** The difference a line states: physical - system on a counted line. */
function lineDifference(line: StockAdjustmentLine): number {
  if (line.physical_qty != null && line.system_qty != null) {
    return line.physical_qty - line.system_qty;
  }
  return line.direction === "OUT" ? -line.quantity : line.quantity;
}

export function StockAdjustmentsView() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const reviewId = Number(searchParams.get("review")) || null;
  const [error, setError] = useState("");
  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses"], queryFn: getWarehouses });

  // ---- the register: every filter lives in the URL, so a refresh or a shared link
  // lands on the same list ----
  const status = searchParams.get("status") ?? "";
  const warehouseFilter = searchParams.get("warehouse") ?? "";
  const reasonFilter = searchParams.get("reason") ?? "";
  const dateFrom = searchParams.get("from") ?? "";
  const dateTo = searchParams.get("to") ?? "";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  const [searchText, setSearchText] = useState(searchParams.get("q") ?? "");
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== "page") next.delete("page");
    setSearchParams(next, { replace: true });
  };
  // Debounced: one request per pause in typing, not one per keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if ((searchParams.get("q") ?? "") !== searchText.trim()) setFilter("q", searchText.trim());
    }, 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);
  const search = searchParams.get("q") ?? "";
  const activeFilters = [search, warehouseFilter, reasonFilter, dateFrom || dateTo].filter(Boolean).length;
  const clearFilters = () => {
    const next = new URLSearchParams();
    if (status) next.set("status", status);
    setSearchText("");
    setSearchParams(next, { replace: true });
  };

  const PAGE_SIZE = 25;
  const { data, isLoading } = useQuery({
    queryKey: ["stock-adjustments", status, search, warehouseFilter, reasonFilter, dateFrom, dateTo, page],
    queryFn: () => listStockAdjustments({
      status: status || undefined,
      search: search || undefined,
      warehouse_id: warehouseFilter ? Number(warehouseFilter) : undefined,
      reason: reasonFilter || undefined,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      page,
      size: PAGE_SIZE,
    }),
  });
  const rows: StockAdjustment[] = data?.items ?? [];
  const total: number = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const refresh = () => qc.invalidateQueries({ queryKey: ["stock-adjustments"] });
  const fail = (e: any) => setError(e?.response?.data?.error ?? "The action failed");

  // ---- the detail sheet, opened from a row or from an approvals deep link ----
  const openReview = (id: number | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set("review", String(id)); else next.delete("review");
    setSearchParams(next, { replace: true });
  };
  const detail = useQuery({
    queryKey: ["stock-adjustment", reviewId],
    queryFn: () => getStockAdjustment(reviewId as number),
    enabled: reviewId != null,
  });
  const selected = detail.data ?? null;
  const [decisionNote, setDecisionNote] = useState("");
  useEffect(() => setDecisionNote(""), [reviewId]);

  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: number; approve: boolean }) =>
      approve ? approveStockAdjustment(id, decisionNote) : rejectStockAdjustment(id, decisionNote),
    onSuccess: (_r, { approve }) => {
      void alerts.success(approve ? "adjustment.approved" : "adjustment.rejected", {
        item: selected?.adjustment_no ?? "The audit", qty: "its counted quantities",
      });
      setError("");
      refresh();
      void qc.invalidateQueries({ queryKey: ["stock-adjustment", reviewId] });
    },
    onError: fail,
  });
  const askThenDecide = async (approve: boolean) => {
    if (!selected) return;
    if (approve && !(await alerts.confirm("adjustment.approve", { item: selected.adjustment_no }))) return;
    decide.mutate({ id: selected.id, approve });
  };

  // ---- the new-audit form ----
  const [open, setOpen] = useState(false);
  const [warehouseId, setWarehouseId] = useState("");
  const [reason, setReason] = useState("CYCLE_COUNT");
  const [remarks, setRemarks] = useState("");
  const [lines, setLines] = useState<CountLine[]>([]);
  const [addItemId, setAddItemId] = useState("");

  const { data: catalog = [] } = useQuery({
    queryKey: ["catalog-items"], queryFn: getCatalogItems, enabled: open,
  });
  const sheet = useQuery({
    queryKey: ["adjustment-count-sheet", warehouseId],
    queryFn: () => getAdjustmentCountSheet(Number(warehouseId)),
    enabled: open && !!warehouseId,
  });
  // A new warehouse is a new count: the sheet is replaced, never merged.
  useEffect(() => {
    if (!sheet.data) return;
    setLines(sheet.data.map((r) => ({ ...r, physical: "" })));
  }, [sheet.data]);

  const resetForm = () => {
    setWarehouseId(""); setReason("CYCLE_COUNT"); setRemarks(""); setLines([]); setAddItemId("");
  };
  const counted = lines.filter((l) => l.physical.trim() !== "");
  const differing = counted.filter((l) => Number(l.physical) !== l.system_qty);
  const invalid = counted.some((l) => !(Number(l.physical) >= 0));
  const warehouseName = warehouses.find((w) => String(w.id) === warehouseId)?.name ?? "the warehouse";

  const setPhysical = (itemId: number, value: string) =>
    setLines((prev) => prev.map((l) => (l.item_id === itemId ? { ...l, physical: value } : l)));
  const removeLine = (itemId: number) => setLines((prev) => prev.filter((l) => l.item_id !== itemId));
  const addItem = () => {
    const item = catalog.find((i) => String(i.id) === addItemId);
    if (!item) return;
    // Not in the system at this warehouse, so the system figure is nil. The server
    // reads it again at save, whatever this says.
    setLines((prev) => [...prev, {
      item_id: item.id, item_code: item.code, item_name: item.name,
      uom_code: item.uom_code ?? item.uom, system_qty: 0, physical: "",
    }]);
    setAddItemId("");
  };
  const addable = useMemo(() => {
    const present = new Set(lines.map((l) => l.item_id));
    return catalog
      .filter((i) => !present.has(i.id))
      .map((i) => ({ value: String(i.id), label: `${i.code} — ${i.name}` }));
  }, [catalog, lines]);

  const create = useMutation({
    mutationFn: () =>
      createStockAdjustment({
        warehouse_id: Number(warehouseId),
        reason,
        remarks: remarks || null,
        items: counted.map((l) => ({ item_id: l.item_id, physical_qty: Number(l.physical) })),
      }),
    onSuccess: (saved: StockAdjustment) => {
      void alerts.success("stock.audit.saved", {
        number: saved.adjustment_no,
        status: saved.status === "APPROVED" ? "approved and posted" : "waiting for approval",
      });
      setOpen(false); resetForm(); setError(""); refresh();
    },
    onError: fail,
  });
  const askThenCreate = async () => {
    if (!(await alerts.confirm("stock.audit.submit", {
      count: `${counted.length} item${counted.length === 1 ? "" : "s"}`,
      warehouse: warehouseName,
      diff: String(differing.length),
    }))) return;
    create.mutate();
  };

  const columns: Column<StockAdjustment>[] = [
    { key: "adjustment_no", header: "Audit No", render: (r) => <strong>{r.adjustment_no}</strong> },
    { key: "warehouse_name", header: "Warehouse", render: (r) => r.warehouse_name ?? "-" },
    { key: "reason", header: "Reason", hideOnNarrow: true, render: (r) => reasonLabel(r.reason) },
    {
      key: "status", header: "Status",
      render: (r) => (
        <div className="space-y-0.5">
          <StatusPill status={r.status} />
          {r.status === "PENDING_APPROVAL" && r.current_approver_name && (
            <div className="text-xs text-muted">With {r.current_approver_name}</div>
          )}
        </div>
      ),
    },
    { key: "created_by_name", header: "Raised By", render: (r) => r.created_by_name ?? "-", hideOnNarrow: true },
    {
      key: "created_at", header: "Created", hideOnNarrow: true,
      render: (r) => (r.created_at ? new Date(r.created_at).toLocaleString() : "-"),
    },
  ];

  const exportCsv = () => {
    const header = ["Audit No", "Warehouse", "Reason", "Status", "Raised By", "Created At"];
    const cell = (v: unknown) => `"${v == null ? "" : String(v).replace(/"/g, '""')}"`;
    const body = rows.map((r) => [
      r.adjustment_no, r.warehouse_name, reasonLabel(r.reason), r.status, r.created_by_name,
      r.created_at ? new Date(r.created_at).toLocaleString() : "-",
    ]);
    const csv = [header, ...body].map((line) => line.map(cell).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `stock-audits-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title="Stock Audit"
        actions={
          <>
            <Button className={TONE_BLUE} variant="ghost" disabled={rows.length === 0} onClick={exportCsv}>
              <Download className="h-4 w-4" /> Export CSV
            </Button>
            <Button variant="subtle" onClick={refresh}><RefreshCw size={14} /> Refresh</Button>
            <Can do="stock.adjust">
              <Button className={TONE_MINT} onClick={() => setOpen(true)}><Plus size={14} /> New Stock Audit</Button>
            </Can>
          </>
        }
      />

      {error && <div className="mb-3"><ErrorNote message={error} /></div>}

      <div className="mb-3 flex flex-wrap gap-2" role="tablist" aria-label="Filter by status">
        {STATUS_TABS.map((t) => (
          <Button
            key={t.value || "all"}
            variant={status === t.value ? "primary" : "subtle"}
            aria-pressed={status === t.value}
            onClick={() => setFilter("status", t.value)}
          >
            {t.label}
          </Button>
        ))}
      </div>

      <FilterBar
        search={searchText}
        onSearch={setSearchText}
        searchPlaceholder="Search audit no., raised by or item..."
        searchClassName="w-full sm:w-72"
        active={activeFilters}
        onClear={clearFilters}
        right={<span className="text-sm text-muted">{total} audit{total === 1 ? "" : "s"}</span>}
      >
        <FilterMenu
          label="Warehouse"
          value={warehouseFilter}
          onChange={(v) => setFilter("warehouse", v)}
          options={warehouses.map((w) => ({ value: String(w.id), label: w.name }))}
        />
        <FilterMenu
          label="Reason"
          value={reasonFilter}
          onChange={(v) => setFilter("reason", v)}
          options={REASONS}
        />
        <FilterDateRange
          label="Created"
          from={dateFrom}
          to={dateTo}
          onFrom={(v) => setFilter("from", v)}
          onTo={(v) => setFilter("to", v)}
        />
      </FilterBar>

      <Card className="p-2">
        <ResponsiveList
          page={page}
          totalPages={totalPages}
          onPageChange={(p) => setFilter("page", p > 1 ? String(p) : "")}
          data={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          onRowClick={(r) => openReview(r.id)}
          empty={activeFilters || status ? "No stock audits match these filters." : "No stock audits yet."}
          renderCard={(r) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-ink">{r.adjustment_no}</span>
                <StatusPill status={r.status} />
              </div>
              <div className="text-xs text-muted">{r.warehouse_name} · {reasonLabel(r.reason)}</div>
              {r.status === "PENDING_APPROVAL" && r.current_approver_name && (
                <div className="text-xs text-muted">With {r.current_approver_name}</div>
              )}
            </div>
          )}
        />
      </Card>

      <Modal isOpen={open} onClose={() => setOpen(false)} size="4xl" scrollBehavior="inside">
        <ModalContent>
          <ModalHeader>New Stock Audit</ModalHeader>
          <ModalBody className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Warehouse">
                <Select
                  value={warehouseId}
                  onChange={(v) => setWarehouseId(v)}
                  options={warehouses.map((w) => ({ value: String(w.id), label: w.name }))}
                  placeholder="Select warehouse"
                />
              </Field>
              <Field label="Reason">
                <Select value={reason} onChange={setReason} options={REASONS} />
              </Field>
            </div>

            {!warehouseId ? (
              <p className="text-sm text-muted">Pick a warehouse to load what the system holds there.</p>
            ) : sheet.isLoading ? (
              <p className="text-sm text-muted">Loading system stock…</p>
            ) : (
              <>
                <p className="text-sm text-muted">
                  Enter what is physically on the shelf. Leave a count blank to skip that item.{" "}
                  <strong className="text-ink">{counted.length}</strong> counted,{" "}
                  <strong className="text-ink">{differing.length}</strong> differ from system stock.
                </p>
                <div className="divide-y divide-line/70 rounded-lg border border-line/70">
                  <div className="hidden grid-cols-[1fr_7rem_8rem_6rem_2.75rem] gap-3 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted sm:grid">
                    <span>Item</span>
                    <span className="text-right">System stock</span>
                    <span className="text-right">Physical stock</span>
                    <span className="text-right">Difference</span>
                    <span />
                  </div>
                  {lines.length === 0 && (
                    <p className="px-3 py-4 text-sm text-muted">
                      The system holds nothing at this warehouse. Add any item you find below.
                    </p>
                  )}
                  {lines.map((l) => {
                    const isCounted = l.physical.trim() !== "";
                    const diff = isCounted ? Number(l.physical) - l.system_qty : null;
                    return (
                      <div
                        key={l.item_id}
                        className="grid grid-cols-2 items-center gap-x-3 gap-y-1 px-3 py-2 sm:grid-cols-[1fr_7rem_8rem_6rem_2.75rem]"
                      >
                        <div className="col-span-2 min-w-0 sm:col-span-1">
                          <div className="truncate font-medium text-ink">{l.item_name ?? "Item"}</div>
                          <div className="truncate text-xs text-muted">{l.item_code} · {l.uom_code ?? "-"}</div>
                        </div>
                        <div className="text-sm tabular-nums sm:text-right">
                          <span className="text-muted sm:hidden">System: </span>{fmt(l.system_qty)}
                        </div>
                        <Input
                          type="number" min="0" step="0.001" inputMode="decimal"
                          aria-label={`Physical stock of ${l.item_name ?? "item"}`}
                          value={l.physical}
                          onChange={(e) => setPhysical(l.item_id, e.target.value)}
                          placeholder="Count"
                        />
                        <div className={`text-sm tabular-nums sm:text-right ${diff ? "font-semibold text-ink" : "text-muted"}`}>
                          <span className="font-normal text-muted sm:hidden">Difference: </span>
                          {diff == null ? "—" : signed(diff)}
                        </div>
                        <Button
                          variant="ghost" aria-label={`Remove ${l.item_name ?? "item"}`}
                          className="min-h-11 min-w-11 justify-self-end"
                          onClick={() => removeLine(l.item_id)}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    );
                  })}
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <div className="flex-1">
                    <Field label="Found an item the system does not show here?">
                      <Select
                        value={addItemId}
                        onChange={setAddItemId}
                        options={addable}
                        placeholder="Pick an item to add"
                        searchable
                      />
                    </Field>
                  </div>
                  <Button variant="subtle" disabled={!addItemId} onClick={addItem}>
                    <Plus size={14} /> Add item
                  </Button>
                </div>
              </>
            )}

            <Field label="Remarks">
              <Input
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder="Who counted, when, anything the approver should know"
              />
            </Field>
          </ModalBody>
          <ModalFooter>
            <Button variant="subtle" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              className={TONE_MINT}
              disabled={!warehouseId || counted.length === 0 || invalid || create.isPending}
              onClick={() => void askThenCreate()}
            >
              {create.isPending ? "Saving…" : "Submit Audit"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <DetailSheet
        open={reviewId != null}
        onClose={() => openReview(null)}
        title={selected?.adjustment_no ?? (detail.isError ? "Not found" : "Loading…")}
        subtitle={selected?.warehouse_name}
        badge={selected && <StatusPill status={selected.status} />}
        footer={selected?.can_act ? (
          <Can do="stock.adjust.approve">
            <div className="space-y-2">
              <Input
                value={decisionNote}
                onChange={(e) => setDecisionNote(e.target.value)}
                placeholder="Comment (required to explain a rejection)"
                aria-label="Approval comment"
              />
              <div className="flex gap-2">
                <Button className={TONE_APPROVE} disabled={decide.isPending} onClick={() => void askThenDecide(true)}>
                  <Check size={14} /> Approve
                </Button>
                <Button
                  className={TONE_REJECT} variant="subtle"
                  disabled={decide.isPending || !decisionNote.trim()}
                  onClick={() => void askThenDecide(false)}
                >
                  <X size={14} /> Reject
                </Button>
              </div>
            </div>
          </Can>
        ) : undefined}
      >
        {detail.isError && <ErrorNote message="This stock audit could not be opened." />}
        {selected && (
          <>
            <SheetSection title="Details">
              <SheetRow label="Reason" value={reasonLabel(selected.reason)} />
              <SheetRow label="Raised By" value={selected.created_by_name} />
              <SheetRow label="Created At" value={selected.created_at ? new Date(selected.created_at).toLocaleString() : "-"} />
              {selected.status === "PENDING_APPROVAL" && (
                <SheetRow label="Waiting On" value={selected.current_approver_name ?? "An approver holding Stock Audit approval"} />
              )}
              {selected.approved_by_name && selected.status === "APPROVED" && (
                <SheetRow label="Approved By" value={selected.approved_by_name} />
              )}
              <SheetRow label="Remarks" value={selected.remarks} />
            </SheetSection>

            <SheetSection title="System vs physical stock">
              {selected.items?.length ? (
                <div className="space-y-2">
                  {selected.items.map((item) => {
                    const diff = lineDifference(item);
                    return (
                      <div key={item.id} className="rounded-lg border border-line/70 p-3">
                        <div className="font-semibold text-ink">{item.item_name || "Unknown item"}</div>
                        <div className="text-xs text-muted">{item.item_code} · {item.uom_code ?? "-"}</div>
                        <div className="mt-2 grid grid-cols-3 gap-2 text-sm tabular-nums">
                          <span><span className="block text-xs text-muted">System</span>{item.system_qty != null ? fmt(item.system_qty) : "—"}</span>
                          <span><span className="block text-xs text-muted">Physical</span>{item.physical_qty != null ? fmt(item.physical_qty) : "—"}</span>
                          <span className={diff ? "font-semibold text-ink" : "text-muted"}>
                            <span className="block text-xs font-normal text-muted">Difference</span>{signed(diff)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted">No items on this audit.</p>
              )}
            </SheetSection>
          </>
        )}
      </DetailSheet>
    </div>
  );
}
