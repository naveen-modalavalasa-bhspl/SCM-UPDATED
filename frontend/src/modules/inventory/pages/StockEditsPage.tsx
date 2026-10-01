import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { Boxes, Check, Layers, PenLine, RefreshCw, X } from "lucide-react";
import {
  Button, Can, Card, Field, FilterBar, FilterDateRange, FilterMenu, Input, PageHeader,
  ResponsiveList, Select, StatusPill, type Column,
} from "@/shared/components";
import { TONE_APPROVE, TONE_MINT, TONE_REJECT } from "@/shared/components/tones";
import { alerts } from "@/modules/alerts";
import {
  approveStockEdit, createStockEdit, getStockEdit, getWarehouses, listStockEditItems,
  listStockEdits, rejectStockEdit,
} from "../api";
import type { StockEdit, StockEditItemRow, StockEditTarget } from "../types";
import { DetailSheet, SheetRow, SheetSection } from "../components/DetailSheet";
import { ErrorNote } from "../components/PageStates";
import {
  StockEditRecordsModal, changedFields, fieldLabel, type Draft,
} from "../components/StockEditRecordsModal";

/* Stock Corrections — edit what held stock IS (batch no., mfg / expiry, serial, IMEI,
 * codes). One row per item; its Units / Batches buttons open the records behind it
 * (StockEditRecordsModal). Nothing is written until the STOCK_EDIT ladder signs; the
 * server reads every "from" value itself and re-checks it at approval. */


const STATUS_TABS = [
  { value: "", label: "All" },
  { value: "PENDING_APPROVAL", label: "Pending approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
];


const PAGE_SIZE = 25;

export function StockEditsPage() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const reviewId = Number(searchParams.get("review")) || null;
  const [error, setError] = useState("");
  const fail = (e: any) => setError(e?.response?.data?.error ?? "The action failed");
  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses"], queryFn: getWarehouses });
  const warehouseOptions = warehouses.map((w) => ({ value: String(w.id), label: w.name }));

  // ---- the register; every filter lives in the URL ----
  const status = searchParams.get("status") ?? "";
  const warehouseFilter = searchParams.get("warehouse") ?? "";
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
  useEffect(() => {
    const t = window.setTimeout(() => {
      if ((searchParams.get("q") ?? "") !== searchText.trim()) setFilter("q", searchText.trim());
    }, 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);
  const search = searchParams.get("q") ?? "";
  const activeFilters = [search, warehouseFilter, dateFrom || dateTo].filter(Boolean).length;
  const clearFilters = () => {
    const next = new URLSearchParams();
    if (status) next.set("status", status);
    setSearchText("");
    setSearchParams(next, { replace: true });
  };

  const register = useQuery({
    queryKey: ["stock-edits", status, search, warehouseFilter, dateFrom, dateTo, page],
    queryFn: () => listStockEdits({
      status: status || undefined, search: search || undefined,
      warehouse_id: warehouseFilter ? Number(warehouseFilter) : undefined,
      date_from: dateFrom || undefined, date_to: dateTo || undefined, page, size: PAGE_SIZE,
    }),
  });
  const rows = register.data?.items ?? [];
  const total = register.data?.total ?? 0;
  const refresh = () => qc.invalidateQueries({ queryKey: ["stock-edits"] });

  // ---- review sheet (row click or approvals deep link) ----
  const openReview = (id: number | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set("review", String(id)); else next.delete("review");
    setSearchParams(next, { replace: true });
  };
  const detail = useQuery({
    queryKey: ["stock-edit", reviewId],
    queryFn: () => getStockEdit(reviewId as number),
    enabled: reviewId != null,
  });
  const selected = detail.data ?? null;
  const [note, setNote] = useState("");
  useEffect(() => setNote(""), [reviewId]);
  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: number; approve: boolean }) =>
      approve ? approveStockEdit(id, note) : rejectStockEdit(id, note),
    onSuccess: (saved) => {
      void alerts.show({
        variant: "success", mode: "alert",
        title: saved.status === "APPROVED" ? "Correction approved" : saved.status === "REJECTED" ? "Correction rejected" : "Approval recorded",
        message: saved.status === "APPROVED"
          ? `${saved.edit_no}: the corrected values are now on the stock.`
          : saved.status === "REJECTED" ? `${saved.edit_no} was rejected; nothing changed.`
            : `${saved.edit_no} moves to ${saved.current_approver_name ?? "the next approver"}.`,
      });
      setError("");
      refresh();
      void qc.invalidateQueries({ queryKey: ["stock-edit", reviewId] });
    },
    onError: fail,
  });
  const askThenDecide = async (approve: boolean) => {
    if (!selected) return;
    if (approve && !(await alerts.show({
      mode: "confirm", variant: "warning", title: "Approve this correction?",
      message: `${selected.edit_no} rewrites ${selected.items?.length ?? 0} batch/unit record(s) if this is the last approval.`,
      confirmLabel: "Approve",
    }))) return;
    decide.mutate({ id: selected.id, approve });
  };

  // ---- the editor: one row per item, records behind a button ----
  const [open, setOpen] = useState(false);
  const [warehouseId, setWarehouseId] = useState("");
  const [itemSearch, setItemSearch] = useState("");
  const [itemQuery, setItemQuery] = useState("");
  const [itemPage, setItemPage] = useState(1);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [reason, setReason] = useState("");
  const [remarks, setRemarks] = useState("");
  const [records, setRecords] = useState<{ item: StockEditItemRow; target: StockEditTarget } | null>(null);
  useEffect(() => {
    const t = window.setTimeout(() => { setItemQuery(itemSearch.trim()); setItemPage(1); }, 300);
    return () => window.clearTimeout(t);
  }, [itemSearch]);

  const itemParams = {
    warehouse_id: Number(warehouseId), search: itemQuery || undefined, page: itemPage, size: PAGE_SIZE,
  };
  const items = useQuery({
    queryKey: ["stock-edit-items", itemParams],
    queryFn: () => listStockEditItems(itemParams),
    enabled: open && !!warehouseId,
  });
  const itemRows = items.data?.items ?? [];
  const itemPages = Math.max(1, Math.ceil((items.data?.total ?? 0) / PAGE_SIZE));

  const resetEditor = () => {
    setWarehouseId(""); setItemSearch(""); setItemPage(1);
    setDrafts({}); setReason(""); setRemarks(""); setRecords(null);
  };
  const changeWarehouse = async (v: string) => {
    if (Object.keys(drafts).length && !(await alerts.show({
      mode: "confirm", variant: "warning", title: "Discard your changes?",
      message: "A correction covers one warehouse. Switching drops the edits made so far.",
      confirmLabel: "Switch",
    }))) return;
    setDrafts({}); setWarehouseId(v); setItemPage(1);
  };
  const changedFor = (itemId: number, target: StockEditTarget) =>
    Object.values(drafts).filter((d) => d.itemId === itemId && d.target === target).length;
  const pending = Object.entries(drafts).filter(([, d]) => changedFields(d).length);

  const create = useMutation({
    mutationFn: () => createStockEdit({
      warehouse_id: Number(warehouseId), reason: reason.trim(), remarks: remarks.trim() || null,
      lines: pending.map(([, d]) => ({
        target_type: d.target, target_id: d.id,
        changes: Object.fromEntries(changedFields(d).map((f) => [f, d.values[f].trim() || null])),
      })),
    }),
    onSuccess: (saved) => {
      void alerts.show({
        variant: "success", mode: "alert", title: "Correction raised",
        message: saved.status === "APPROVED"
          ? `${saved.edit_no} needed no approval and is already applied.`
          : `${saved.edit_no} is waiting on ${saved.current_approver_name ?? "a holder of stock-correction approval"}.`,
      });
      setOpen(false); resetEditor(); setError(""); refresh();
      void qc.invalidateQueries({ queryKey: ["stock-edit-items"] });
      void qc.invalidateQueries({ queryKey: ["stock-edit-units"] });
      void qc.invalidateQueries({ queryKey: ["stock-edit-batches"] });
    },
    onError: fail,
  });
  const askThenCreate = async () => {
    if (!(await alerts.show({
      mode: "confirm", variant: "warning", title: "Send for approval?",
      message: `${pending.length} record(s) will be corrected once the approval ladder signs.`,
      confirmLabel: "Submit",
    }))) return;
    create.mutate();
  };

  const columns: Column<StockEdit>[] = [
    { key: "edit_no", header: "Correction No", render: (r) => <strong>{r.edit_no}</strong> },
    { key: "warehouse_name", header: "Warehouse", render: (r) => r.warehouse_name ?? "-" },
    { key: "reason", header: "Reason", hideOnNarrow: true, render: (r) => r.reason },
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
    { key: "created_by_name", header: "Raised By", hideOnNarrow: true, render: (r) => r.created_by_name ?? "-" },
    {
      key: "created_at", header: "Created", hideOnNarrow: true,
      render: (r) => (r.created_at ? new Date(r.created_at).toLocaleString() : "-"),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title="Stock Corrections"
        actions={
          <>
            <Button variant="subtle" onClick={refresh}><RefreshCw size={14} /> Refresh</Button>
            <Can do="stock.edit.create">
              <Button className={TONE_MINT} onClick={() => setOpen(true)}>
                <PenLine size={14} /> New correction
              </Button>
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
        searchPlaceholder="Search number, raised by, item, serial or batch..."
        searchClassName="w-full sm:w-72"
        active={activeFilters}
        onClear={clearFilters}
        right={<span className="text-sm text-muted">{total} correction{total === 1 ? "" : "s"}</span>}
      >
        <FilterMenu label="Warehouse" value={warehouseFilter}
          onChange={(v) => setFilter("warehouse", v)} options={warehouseOptions} />
        <FilterDateRange label="Created" from={dateFrom} to={dateTo}
          onFrom={(v) => setFilter("from", v)} onTo={(v) => setFilter("to", v)} />
      </FilterBar>

      <Card className="p-2">
        <ResponsiveList
          page={page}
          totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))}
          onPageChange={(p) => setFilter("page", p > 1 ? String(p) : "")}
          data={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={register.isLoading}
          onRowClick={(r) => openReview(r.id)}
          empty={activeFilters || status ? "No corrections match these filters." : "No stock corrections yet."}
          renderCard={(r) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-ink">{r.edit_no}</span>
                <StatusPill status={r.status} />
              </div>
              <div className="text-xs text-muted">{r.warehouse_name} · {r.reason}</div>
            </div>
          )}
        />
      </Card>

      <Modal isOpen={open} onClose={() => setOpen(false)} size="5xl" scrollBehavior="inside">
        <ModalContent>
          <ModalHeader>New stock correction</ModalHeader>
          <ModalBody className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Warehouse">
                <Select value={warehouseId} onChange={(v) => void changeWarehouse(v)}
                  options={warehouseOptions} placeholder="Select warehouse" searchable />
              </Field>
              <Field label="Find an item">
                <Input value={itemSearch} onChange={(e) => setItemSearch(e.target.value)}
                  placeholder="Item code or name" disabled={!warehouseId} />
              </Field>
            </div>

            {!warehouseId ? (
              <p className="text-sm text-muted">Pick a warehouse to list the items it holds.</p>
            ) : items.isLoading ? (
              <p className="text-sm text-muted">Loading stock…</p>
            ) : itemRows.length === 0 ? (
              <p className="text-sm text-muted">No item held here matches.</p>
            ) : (
              <>
              <p className="text-sm text-muted">
                Showing {(itemPage - 1) * PAGE_SIZE + 1}–{(itemPage - 1) * PAGE_SIZE + itemRows.length} of{" "}
                <strong className="text-ink">{items.data?.total ?? itemRows.length}</strong> items held here
              </p>
              <div className="divide-y divide-line/70 rounded-lg border border-line/70">
                {itemRows.map((it) => {
                  const units = changedFor(it.item_id, "UNIT");
                  const batches = changedFor(it.item_id, "BATCH");
                  return (
                    <div key={it.item_id}
                      className={`flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center ${units + batches ? "bg-warning/5" : ""}`}>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-ink">{it.item_name ?? "Item"}</div>
                        <div className="truncate text-xs text-muted">
                          {it.item_code} · {it.qty} {it.uom_code ?? ""} held
                          {units + batches > 0 && <> · <strong className="text-warning">{units + batches} changed</strong></>}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button variant="subtle" disabled={!it.unit_count}
                          title={it.unit_count ? "Edit serial, IMEI and codes" : "No units recorded for this item here"}
                          onClick={() => setRecords({ item: it, target: "UNIT" })}>
                          <Boxes size={14} /> Units ({it.unit_count}){units > 0 && ` · ${units} edited`}
                        </Button>
                        <Button variant="subtle" disabled={!it.batch_count}
                          title={it.batch_count ? "Edit batch no., mfg and expiry" : "No batches recorded for this item here"}
                          onClick={() => setRecords({ item: it, target: "BATCH" })}>
                          <Layers size={14} /> Batches ({it.batch_count}){batches > 0 && ` · ${batches} edited`}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
              </>
            )}
            {warehouseId && itemPages > 1 && (
              <div className="flex items-center justify-end gap-2 text-sm text-muted">
                <Button variant="subtle" disabled={itemPage <= 1} onClick={() => setItemPage((p) => p - 1)}>Previous</Button>
                <span>Page {itemPage} of {itemPages}</span>
                <Button variant="subtle" disabled={itemPage >= itemPages} onClick={() => setItemPage((p) => p + 1)}>Next</Button>
              </div>
            )}

            {pending.length > 0 && (
              <div className="rounded-lg border border-line/70 p-3 text-sm">
                <div className="mb-1 font-semibold text-ink">{pending.length} record(s) changed</div>
                <ul className="space-y-0.5 text-muted">
                  {pending.map(([key, d]) => (
                    <li key={key}>
                      <span className="text-ink">{d.label}</span>:{" "}
                      {changedFields(d).map((f) => `${fieldLabel(f)} ${d.original[f] || "—"} → ${d.values[f] || "—"}`).join("; ")}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Reason (required)">
                <Input value={reason} onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. IMEI keyed into serial at GRN" />
              </Field>
              <Field label="Remarks">
                <Input value={remarks} onChange={(e) => setRemarks(e.target.value)}
                  placeholder="Anything the approver should know" />
              </Field>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="subtle" onClick={() => setOpen(false)}>Cancel</Button>
            <Button className={TONE_MINT}
              disabled={!warehouseId || pending.length === 0 || !reason.trim() || create.isPending}
              onClick={() => void askThenCreate()}>
              {create.isPending ? "Submitting…" : "Submit for approval"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <StockEditRecordsModal
        isOpen={records != null}
        onClose={() => setRecords(null)}
        warehouseId={Number(warehouseId)}
        item={records?.item ?? null}
        target={records?.target ?? "UNIT"}
        drafts={drafts}
        setDrafts={setDrafts}
      />

      <DetailSheet
        open={reviewId != null}
        onClose={() => openReview(null)}
        title={selected?.edit_no ?? (detail.isError ? "Not found" : "Loading…")}
        subtitle={selected?.warehouse_name}
        badge={selected && <StatusPill status={selected.status} />}
        footer={selected?.can_act ? (
          <Can do="stock.edit.approve">
            <div className="space-y-2">
              <Input value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="Comment (required to reject)" aria-label="Approval comment" />
              <div className="flex gap-2">
                <Button className={TONE_APPROVE} disabled={decide.isPending} onClick={() => void askThenDecide(true)}>
                  <Check size={14} /> Approve
                </Button>
                <Button className={TONE_REJECT} variant="subtle" disabled={decide.isPending || !note.trim()}
                  onClick={() => void askThenDecide(false)}>
                  <X size={14} /> Reject
                </Button>
              </div>
            </div>
          </Can>
        ) : undefined}
      >
        {detail.isError && <ErrorNote message="This correction could not be opened." />}
        {selected && (
          <>
            <SheetSection title="Details">
              <SheetRow label="Reason" value={selected.reason} />
              <SheetRow label="Raised By" value={selected.created_by_name} />
              <SheetRow label="Created At" value={new Date(selected.created_at).toLocaleString()} />
              {selected.status === "PENDING_APPROVAL" && (
                <SheetRow label="Waiting On" value={selected.current_approver_name ?? "A holder of stock-correction approval"} />
              )}
              {selected.status === "APPROVED" && <SheetRow label="Approved By" value={selected.approved_by_name} />}
              <SheetRow label="Remarks" value={selected.remarks} />
            </SheetSection>
            <SheetSection title="What changes">
              <div className="space-y-2">
                {(selected.items ?? []).map((line) => (
                  <div key={line.id} className="rounded-lg border border-line/70 p-3">
                    <div className="font-semibold text-ink">{line.label}</div>
                    <div className="text-xs text-muted">{line.item_code} · {line.item_name}</div>
                    <div className="mt-2 space-y-1 text-sm">
                      {Object.entries(line.changes).map(([field, c]) => (
                        <div key={field} className="grid grid-cols-[8rem_1fr] gap-2">
                          <span className="text-muted">{fieldLabel(field)}</span>
                          <span>
                            <span className="text-muted line-through">{c.from || "—"}</span>
                            {" → "}
                            <strong className="text-ink">{c.to || "—"}</strong>
                          </span>
                        </div>
                      ))}
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
