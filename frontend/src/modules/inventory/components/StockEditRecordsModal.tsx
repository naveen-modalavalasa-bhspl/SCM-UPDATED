import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { RotateCcw } from "lucide-react";
import { Button, Input } from "@/shared/components";
import { listStockEditBatches, listStockEditUnits } from "../api";
import type {
  StockEditBatchRow, StockEditItemRow, StockEditTarget, StockEditUnitRow,
} from "../types";

/* The per-item editor behind the Stock Corrections screen's Units / Batches buttons —
 * the same shape as Material Issue's serial picker: the item list stays one row per
 * item, and the records behind an item open here, one row each, under one set of
 * headings. Mirrors warehouse/enums STOCK_EDIT_FIELDS; the server refuses any other. */
export const FIELDS: Record<StockEditTarget, { key: string; label: string; date?: boolean }[]> = {
  UNIT: [
    { key: "serial_number", label: "Serial no." },
    { key: "imei", label: "IMEI" },
    { key: "asset_code", label: "Asset code" },
    { key: "consumable_code", label: "Consumable code" },
    { key: "lot_no", label: "Lot no." },
  ],
  BATCH: [
    { key: "batch_no", label: "Batch no." },
    { key: "mfg_date", label: "Mfg date", date: true },
    { key: "expiry_date", label: "Expiry date", date: true },
  ],
};
export const fieldLabel = (key: string) =>
  [...FIELDS.UNIT, ...FIELDS.BATCH].find((f) => f.key === key)?.label ?? key;

export type Draft = {
  target: StockEditTarget;
  id: number;
  itemId: number;
  label: string;
  original: Record<string, string>;
  values: Record<string, string>;
};
export const draftKey = (t: StockEditTarget, id: number) => `${t}:${id}`;
export const changedFields = (d: Draft) =>
  Object.keys(d.values).filter((k) => d.values[k] !== d.original[k]);

type Row = StockEditUnitRow | StockEditBatchRow;
const PAGE_SIZE = 50;

export function StockEditRecordsModal({
  isOpen, onClose, warehouseId, item, target, drafts, setDrafts,
}: {
  isOpen: boolean;
  onClose: () => void;
  warehouseId: number;
  item: StockEditItemRow | null;
  target: StockEditTarget;
  drafts: Record<string, Draft>;
  setDrafts: Dispatch<SetStateAction<Record<string, Draft>>>;
}) {
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => { setSearchText(""); setSearch(""); setPage(1); }, [item?.item_id, target]);
  useEffect(() => {
    const t = window.setTimeout(() => { setSearch(searchText.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(t);
  }, [searchText]);

  const params = {
    warehouse_id: warehouseId, item_id: item?.item_id, search: search || undefined, page, size: PAGE_SIZE,
  };
  const query = useQuery({
    queryKey: [target === "UNIT" ? "stock-edit-units" : "stock-edit-batches", params],
    queryFn: () => (target === "UNIT" ? listStockEditUnits(params) : listStockEditBatches(params)),
    enabled: isOpen && !!item,
  });
  const rows = (query.data?.items ?? []) as Row[];
  const pages = Math.max(1, Math.ceil((query.data?.total ?? 0) / PAGE_SIZE));

  // Only the identifiers this item carries: a consumable has no asset tag, and a
  // column of empty boxes reads as data missing rather than data not applicable.
  const fields = useMemo(() => FIELDS[target].filter((f) => {
    if (target === "BATCH" || !item) return true;
    const anyValue = rows.some((r) => (r as any)[f.key]);
    if (f.key === "imei") return item.is_imei_tracked || anyValue;
    if (f.key === "asset_code") return item.is_asset || anyValue;
    if (f.key === "consumable_code") return !item.is_asset || anyValue;
    return true;
  }), [target, item, rows]);

  const originalOf = (row: Row): Record<string, string> =>
    Object.fromEntries(FIELDS[target].map((f) => [f.key, String((row as any)[f.key] ?? "")]));
  const labelOf = (row: Row) =>
    target === "UNIT"
      ? `${row.item_code ?? ""} · ${(row as StockEditUnitRow).serial_number ?? `unit ${row.id}`}`
      : `${row.item_code ?? ""} · ${row.batch_no === "Unbatched" ? "Unbatched" : `batch ${row.batch_no ?? row.id}`}`;
  const setValue = (row: Row, field: string, value: string) => {
    const key = draftKey(target, row.id);
    setDrafts((prev) => {
      const original = prev[key]?.original ?? originalOf(row);
      const values = { ...(prev[key]?.values ?? original), [field]: value };
      const next = {
        ...prev, [key]: { target, id: row.id, itemId: row.item_id, label: labelOf(row), original, values },
      };
      if (!changedFields(next[key]).length) delete next[key];
      return next;
    });
  };
  const undoRow = (key: string) => setDrafts((prev) => {
    const next = { ...prev }; delete next[key]; return next;
  });

  const changedHere = Object.values(drafts).filter(
    (d) => d.target === target && d.itemId === item?.item_id).length;
  // Fields, then the read-only context column, then the undo slot.
  const grid = { gridTemplateColumns: `repeat(${fields.length}, minmax(0, 1fr)) 9rem 2.75rem` };
  const noun = target === "UNIT" ? "unit" : "batch";

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="5xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex-col items-start gap-1">
          <span>{target === "UNIT" ? "Units" : "Batches"} — {item?.item_name}</span>
          <span className="text-xs font-normal text-muted">
            {item?.item_code} · {query.data?.total ?? "…"} {noun}{query.data?.total === 1 ? "" : target === "UNIT" ? "s" : "es"} held here
            {changedHere > 0 && <> · <strong className="text-warning">{changedHere} changed</strong></>}
          </span>
        </ModalHeader>
        <ModalBody className="space-y-3">
          <Input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder={target === "UNIT" ? "Find a serial, IMEI, code or lot" : "Find a batch no."}
            aria-label={`Search ${noun}s`}
          />
          {query.isLoading ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted">No {noun} held here matches.</p>
          ) : (
            <>
            <p className="text-sm text-muted">
              Showing {(page - 1) * PAGE_SIZE + 1}–{(page - 1) * PAGE_SIZE + rows.length} of{" "}
              <strong className="text-ink">{query.data?.total ?? rows.length}</strong> {target === "UNIT" ? "units" : "batches"}
            </p>
            <div className="divide-y divide-line/70 rounded-lg border border-line/70">
              <div className="hidden gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted sm:grid" style={grid}>
                {fields.map((f) => <span key={f.key}>{f.label}</span>)}
                <span>{target === "UNIT" ? "Batch · qty / status" : "Qty held"}</span>
                <span />
              </div>
              {rows.map((row) => {
                const key = draftKey(target, row.id);
                const draft = drafts[key];
                const changed = draft ? changedFields(draft) : [];
                const locked = !!row.pending_edit_no;
                return (
                  <div key={key} className={`px-3 py-2 ${changed.length ? "bg-warning/5" : ""}`}>
                    <div className="grid grid-cols-1 items-center gap-2 sm:[grid-template-columns:var(--cols)]"
                      style={{ ["--cols" as any]: grid.gridTemplateColumns }}>
                      {fields.map((f) => {
                        const dirty = changed.includes(f.key);
                        return (
                          <label key={f.key} className="block">
                            <span className="text-xs text-muted sm:hidden">{f.label}</span>
                            <Input
                              type={f.date ? "date" : "text"}
                              value={draft?.values[f.key] ?? String((row as any)[f.key] ?? "")}
                              disabled={locked}
                              aria-label={`${f.label} of ${labelOf(row)}`}
                              className={dirty ? "border-warning" : undefined}
                              onChange={(e) => setValue(row, f.key, e.target.value)}
                            />
                          </label>
                        );
                      })}
                      <div className="min-w-0 text-xs text-muted">
                        {target === "UNIT" ? (
                          <>
                            <div className="truncate">
                              Batch {row.batch_no ?? "—"}
                              {(row as StockEditUnitRow).batch_qty != null && (
                                <> · <strong className="text-ink">{(row as StockEditUnitRow).batch_qty} {item?.uom_code ?? ""}</strong></>
                              )}
                            </div>
                            <div className="truncate">{(row as StockEditUnitRow).status}</div>
                          </>
                        ) : (
                          <>
                            <div className="truncate text-sm font-semibold text-ink">{(row as StockEditBatchRow).qty} {(row as StockEditBatchRow).uom_code ?? ""}</div>
                            <div className="truncate">{(row as StockEditBatchRow).grn_no ?? ""}</div>
                          </>
                        )}
                        {locked && <div className="truncate font-medium text-warning">On {row.pending_edit_no}</div>}
                      </div>
                      <div className="justify-self-end">
                        {changed.length > 0 && (
                          <Button variant="ghost" className="min-h-11 min-w-11" aria-label="Undo this row"
                            onClick={() => undoRow(key)}>
                            <RotateCcw size={14} />
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            </>
          )}
          {pages > 1 && (
            <div className="flex items-center justify-end gap-2 text-sm text-muted">
              <Button variant="subtle" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <span>Page {page} of {pages}</span>
              <Button variant="subtle" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="primary" onClick={onClose}>Done</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
