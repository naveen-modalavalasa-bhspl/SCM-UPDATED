/**
 * StockAuditForm — New Stock Audit Modal.
 *
 * Implements targeted stock audits with:
 *   1. Searchable item picker from warehouse stock
 *   2. Prominent Item quantity overview (system on hand, reserved, available)
 *   3. Cascading Batches dropdown based on the selected item + warehouse
 *   4. Cascading Storage Location (bin) dropdown based on item + batch
 *   5. Scoped System Quantity for the chosen batch and location
 *   6. Tracked Unit selector: Asset codes, Consumable codes, Serials, IMEIs
 *   7. Physical count input with live variance calculation (+/-)
 *   8. Real-time validation against difference quantity for damage, expiry, shortage, excess
 *   9. Two-panel responsive layout with rich summary and line cards
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import {
  AlertCircle, ArrowDown, ArrowUp, Check, CheckCircle2,
  Layers, MapPin, Minus, Package, Plus, Search, ShieldAlert, Sparkles,
  Tag, Trash2, TrendingDown, TrendingUp, X,
} from "lucide-react";
import { Button, Field, Input, Select } from "@/shared/components";
import { TONE_MINT } from "@/shared/components/tones";
import {
  getAdjustmentCountSheet, getCatalogItems, getStockBalances, getUnits, getWarehouses,
} from "../api";
import type { CatalogItemOption, StockBalanceItem, UnitRow, WarehouseOption } from "../types";

// ─── constants ────────────────────────────────────────────────────────────────

export const AUDIT_REASONS = [
  { value: "CYCLE_COUNT",        label: "Stock audit (count variance)", desc: "Periodic verification of inventory on shelf" },
  { value: "DAMAGE",             label: "Damage", desc: "Goods broken, dented, or defective" },
  { value: "EXPIRY",             label: "Expiry", desc: "Past shelf-life or spoiled goods" },
  { value: "EXCESS",             label: "Found stock (excess)", desc: "Extra unrecorded stock discovered" },
  { value: "SHORTAGE",           label: "Shortage / Missing", desc: "Unaccounted shortage or theft" },
  { value: "QUALITY_REJECTION",  label: "Quality rejection", desc: "Failed QA inspection" },
  { value: "OPENING_BALANCE",    label: "Opening balance", desc: "Initial migration or setup variance" },
  { value: "OTHER",              label: "Other adjustment", desc: "Miscellaneous inventory correction" },
];

const OUT_REASONS = new Set(["DAMAGE", "EXPIRY", "SHORTAGE", "QUALITY_REJECTION"]);
const IN_REASONS  = new Set(["EXCESS", "OPENING_BALANCE"]);

const fmt = (n: number) => Number(n.toFixed(3)).toString();
const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : fmt(n));

// ─── types ────────────────────────────────────────────────────────────────────

export interface DraftAuditLine {
  id: string;
  item_id: number;
  item_code: string;
  item_name: string;
  uom_code: string;
  is_batch_tracked: boolean;
  selected_units: UnitRow[];
  batch_id: number;
  batch_no: string | null;
  bin_id: number;
  bin_code: string | null;
  system_qty: number;
  physical: string;
  remarks?: string;
}

export interface AuditLinePayload {
  item_id: number;
  bin_id: number;
  batch_id: number;
  physical_qty: number;
  remarks?: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (payload: {
    warehouse_id: number;
    reason: string;
    remarks: string | null;
    items: AuditLinePayload[];
  }) => void;
  isSaving: boolean;
}

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function reasonDirection(reason: string): "IN" | "OUT" | null {
  if (OUT_REASONS.has(reason)) return "OUT";
  if (IN_REASONS.has(reason))  return "IN";
  return null;
}

function splitUnits(units: UnitRow[]) {
  const serials: string[] = [];
  const imeis: string[] = [];
  const assetCodes: string[] = [];
  const consumableCodes: string[] = [];

  for (const u of units) {
    if (u.asset_code) assetCodes.push(u.asset_code);
    if (u.consumable_code) consumableCodes.push(u.consumable_code);
    if (u.serial_number && u.serial_number !== u.asset_code && u.serial_number !== u.consumable_code) {
      serials.push(u.serial_number);
    }
    if (u.imei) imeis.push(u.imei);
  }

  return { serials, imeis, assetCodes, consumableCodes };
}

function unitPrimaryIdentifier(u: UnitRow): { code: string; type: "asset" | "consumable" | "serial" | "imei" } {
  if (u.asset_code) return { code: u.asset_code, type: "asset" };
  if (u.consumable_code) return { code: u.consumable_code, type: "consumable" };
  if (u.serial_number) return { code: u.serial_number, type: "serial" };
  if (u.imei) return { code: u.imei, type: "imei" };
  return { code: `#${u.id}`, type: "serial" };
}

// ─── badge subcomponents ───────────────────────────────────────────────────────

function DiffBadge({ diff }: { diff: number | null }) {
  if (diff === null) return <span className="text-muted text-xs">—</span>;
  if (diff === 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-content2 px-2 py-0.5 text-xs font-medium text-muted">
        ±0 (Matched)
      </span>
    );
  }
  const positive = diff > 0;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums ${
        positive
          ? "bg-success/10 text-success border border-success/30"
          : "bg-danger/10 text-danger border border-danger/30"
      }`}
    >
      {positive ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
      {signed(diff)}
    </span>
  );
}

// ─── active item builder component ────────────────────────────────────────────

function AuditItemBuilder({
  warehouseId,
  warehouseStockMap,
  catalog,
  reason,
  onAddLine,
  onCancel,
}: {
  warehouseId: number;
  warehouseStockMap: Map<number, number>;
  catalog: CatalogItemOption[];
  reason: string;
  onAddLine: (line: DraftAuditLine) => void;
  onCancel: () => void;
}) {
  const [selectedItemId, setSelectedItemId] = useState("");
  const [batchId, setBatchId] = useState("0");
  const [binId, setBinId] = useState("0");
  const [selectedUnits, setSelectedUnits] = useState<UnitRow[]>([]);
  const [unitFilterType, setUnitFilterType] = useState<"ALL" | "ASSET" | "CONSUMABLE" | "SERIAL">("ALL");
  const [unitSearch, setUnitSearch] = useState("");
  const [physical, setPhysical] = useState("");
  const [lineRemarks, setLineRemarks] = useState("");

  const selectedItem = catalog.find((i) => String(i.id) === selectedItemId) ?? null;

  // 1. Fetch stock balances (lots & bins) for this item & warehouse
  const stockBalancesQ = useQuery({
    queryKey: ["item-stock-balances", selectedItem?.id, warehouseId],
    queryFn: () => getStockBalances({ item_id: selectedItem!.id, warehouse_id: warehouseId, size: 200 }),
    enabled: !!selectedItem && warehouseId > 0,
  });

  const balanceRows: StockBalanceItem[] = stockBalancesQ.data?.items ?? [];

  // 2. Fetch tracked units for this item & warehouse
  const unitsQ = useQuery({
    queryKey: ["item-units", selectedItem?.id, warehouseId],
    queryFn: () => getUnits({ item_id: selectedItem!.id, warehouse_id: warehouseId }),
    enabled: !!selectedItem && warehouseId > 0,
  });

  const allUnits: UnitRow[] = unitsQ.data ?? [];

  // Derive unique Batches from both balanceRows and allUnits
  const batchOptions = useMemo(() => {
    const map = new Map<number, { label: string; qty: number; exp?: string }>();
    for (const b of balanceRows) {
      if (b.batch_id && b.batch_number) {
        const existing = map.get(b.batch_id);
        const qty = (existing?.qty ?? 0) + b.physical_qty;
        map.set(b.batch_id, {
          label: `${b.batch_number}${b.expiry_date ? ` (Exp: ${b.expiry_date})` : ""}`,
          qty,
          exp: b.expiry_date,
        });
      }
    }
    for (const u of allUnits) {
      if (u.batch_id && u.batch_no && !map.has(u.batch_id)) {
        map.set(u.batch_id, {
          label: `${u.batch_no}${u.expiry_date ? ` (Exp: ${u.expiry_date})` : ""}`,
          qty: 0,
          exp: u.expiry_date ?? undefined,
        });
      }
    }

    return [
      { value: "0", label: "All batches / Not batch-specific" },
      ...[...map.entries()].map(([id, info]) => ({
        value: String(id),
        label: `${info.label} — ${fmt(info.qty)} in stock`,
      })),
    ];
  }, [balanceRows, allUnits]);

  // Derive Storage Locations (bins) based on selected batch
  const binOptions = useMemo(() => {
    const map = new Map<number, string>();
    const bIdNum = Number(batchId);

    const filteredBalances = bIdNum > 0
      ? balanceRows.filter((b) => b.batch_id === bIdNum)
      : balanceRows;

    for (const b of filteredBalances) {
      if (b.bin_id && b.bin_code && !map.has(b.bin_id)) {
        map.set(b.bin_id, `${b.bin_code} (Qty: ${fmt(b.physical_qty)})`);
      }
    }

    const filteredUnits = bIdNum > 0
      ? allUnits.filter((u) => u.batch_id === bIdNum)
      : allUnits;

    for (const u of filteredUnits) {
      if (u.bin_id && u.bin_code && !map.has(u.bin_id)) {
        map.set(u.bin_id, u.bin_code);
      }
    }

    return [
      { value: "0", label: "All locations / Not bin-specific" },
      ...[...map.entries()].map(([id, code]) => ({ value: String(id), label: code })),
    ];
  }, [balanceRows, allUnits, batchId]);

  // Scoped System Quantity calculation
  const scopedSystemQty = useMemo(() => {
    const bIdNum = Number(batchId);
    const binIdNum = Number(binId);

    if (balanceRows.length > 0) {
      let filtered = balanceRows;
      if (bIdNum > 0) filtered = filtered.filter((b) => b.batch_id === bIdNum);
      if (binIdNum > 0) filtered = filtered.filter((b) => b.bin_id === binIdNum);
      if (filtered.length > 0 || (bIdNum > 0 || binIdNum > 0)) {
        return filtered.reduce((acc, row) => acc + row.physical_qty, 0);
      }
    }

    if (allUnits.length > 0) {
      let filtered = allUnits;
      if (bIdNum > 0) filtered = filtered.filter((u) => u.batch_id === bIdNum);
      if (binIdNum > 0) filtered = filtered.filter((u) => u.bin_id === binIdNum);
      if (filtered.length > 0 || (bIdNum > 0 || binIdNum > 0)) {
        return filtered.length;
      }
    }

    return warehouseStockMap.get(selectedItem?.id ?? 0) ?? 0;
  }, [balanceRows, allUnits, batchId, binId, selectedItem, warehouseStockMap]);

  // Tracked units filtered by batch, bin, type, and search
  const availableTrackedUnits = useMemo(() => {
    let list = allUnits;
    const bIdNum = Number(batchId);
    const binIdNum = Number(binId);

    if (bIdNum > 0) list = list.filter((u) => u.batch_id === bIdNum);
    if (binIdNum > 0) list = list.filter((u) => u.bin_id === binIdNum);

    if (unitFilterType === "ASSET") {
      list = list.filter((u) => u.is_asset || !!u.asset_code);
    } else if (unitFilterType === "CONSUMABLE") {
      list = list.filter((u) => !!u.consumable_code || (!u.is_asset && !u.asset_code));
    } else if (unitFilterType === "SERIAL") {
      list = list.filter((u) => !!u.serial_number || !!u.imei);
    }

    if (unitSearch.trim()) {
      const q = unitSearch.trim().toLowerCase();
      list = list.filter((u) =>
        [u.serial_number, u.imei, u.asset_code, u.consumable_code, u.bin_code, u.batch_no]
          .some((v) => v?.toLowerCase().includes(q))
      );
    }

    return list;
  }, [allUnits, batchId, binId, unitFilterType, unitSearch]);

  const toggleUnit = (u: UnitRow) => {
    setSelectedUnits((prev) =>
      prev.find((x) => x.id === u.id) ? prev.filter((x) => x.id !== u.id) : [...prev, u]
    );
  };

  const selectAllFilteredUnits = () => {
    setSelectedUnits((prev) => {
      const existingIds = new Set(prev.map((u) => u.id));
      const toAdd = availableTrackedUnits.filter((u) => !existingIds.has(u.id));
      return [...prev, ...toAdd];
    });
  };

  const clearSelectedUnits = () => setSelectedUnits([]);

  // Auto-fill physical counts based on audit reason & selected units
  const applySuggestedCount = (type: "DIFFERENCE" | "MATCH" | "ZERO") => {
    if (type === "MATCH") {
      setPhysical(String(scopedSystemQty));
    } else if (type === "ZERO") {
      setPhysical("0");
    } else if (type === "DIFFERENCE") {
      const unitCount = selectedUnits.length;
      if (OUT_REASONS.has(reason)) {
        // e.g. 10 system - 2 damaged = 8 physical
        setPhysical(String(Math.max(0, scopedSystemQty - unitCount)));
      } else if (IN_REASONS.has(reason)) {
        // e.g. 10 system + 2 found = 12 physical
        setPhysical(String(scopedSystemQty + unitCount));
      }
    }
  };

  // Validation logic against difference quantity
  const physNum = Number(physical);
  const isPhysicalEntered = physical.trim() !== "" && !isNaN(physNum);
  const diff = isPhysicalEntered ? physNum - scopedSystemQty : null;

  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    if (!selectedItem) {
      errors.push("Please select an item.");
      return errors;
    }
    if (!isPhysicalEntered) {
      errors.push("Enter the physical count found on shelf.");
      return errors;
    }
    if (physNum < 0) {
      errors.push("Physical count cannot be negative.");
    }

    const variance = diff ?? 0;
    const unitCount = selectedUnits.length;

    // Reason-specific rules:
    if (OUT_REASONS.has(reason)) {
      if (variance > 0) {
        errors.push(`For reason "${reason}", stock cannot increase. Physical count must be ≤ system count.`);
      }
      if (unitCount > 0) {
        if (variance === 0) {
          errors.push(
            `You selected ${unitCount} unit(s) for damage/loss, but physical count matches system stock (difference is 0). Physical count must reflect the removed units.`
          );
        } else if (Math.abs(variance) < unitCount) {
          errors.push(
            `You selected ${unitCount} unit(s), but the difference is only ${Math.abs(variance)}. Physical count must be at least ${unitCount} less than system stock.`
          );
        }
      }
    } else if (IN_REASONS.has(reason)) {
      if (variance < 0) {
        errors.push(`For reason "${reason}", stock cannot decrease. Physical count must be ≥ system count.`);
      }
      if (unitCount > 0 && variance < unitCount) {
        errors.push(
          `You selected ${unitCount} found unit(s), but difference is only ${variance}. Physical count must be at least ${unitCount} higher.`
        );
      }
    }

    return errors;
  }, [selectedItem, isPhysicalEntered, physNum, diff, selectedUnits.length, reason]);

  const canCommitLine = validationErrors.length === 0;

  const commitLine = () => {
    if (!selectedItem || !canCommitLine) return;

    const bIdNum = Number(batchId);
    const binIdNum = Number(binId);
    const batchLabel = batchOptions.find((b) => b.value === batchId)?.label ?? null;
    const binLabel = binOptions.find((b) => b.value === binId)?.label ?? null;

    onAddLine({
      id: uid(),
      item_id: selectedItem.id,
      item_code: selectedItem.code,
      item_name: selectedItem.name,
      uom_code: selectedItem.uom_code ?? selectedItem.uom ?? "NOS",
      is_batch_tracked: !!selectedItem.is_batch_tracked,
      selected_units: selectedUnits,
      batch_id: bIdNum > 0 ? bIdNum : 0,
      batch_no: bIdNum > 0 ? (batchLabel?.split(" — ")[0] ?? null) : null,
      bin_id: binIdNum > 0 ? binIdNum : 0,
      bin_code: binIdNum > 0 ? (binLabel?.split(" ")[0] ?? null) : null,
      system_qty: scopedSystemQty,
      physical,
      remarks: lineRemarks.trim() || undefined,
    });
  };

  const itemOptions = useMemo(
    () =>
      catalog.map((i) => {
        const stockQty = warehouseStockMap.get(i.id) ?? 0;
        return {
          value: String(i.id),
          label: `${i.code} — ${i.name} (${fmt(stockQty)} ${i.uom_code ?? i.uom ?? "NOS"})`,
        };
      }),
    [catalog, warehouseStockMap]
  );

  return (
    <div className="rounded-2xl border border-brand/30 bg-card/90 shadow-md p-5 space-y-5 transition-all">
      {/* ── Item Selection Header ── */}
      <div className="flex items-center justify-between border-b border-line/60 pb-3">
        <div className="flex items-center gap-2 font-semibold text-brand text-sm">
          <Package className="h-4 w-4" /> Audit Item Details
        </div>
        <Button variant="ghost" onClick={onCancel} className="h-7 text-xs text-muted">
          Cancel
        </Button>
      </div>

      {/* 1. Item Dropdown */}
      <div className="space-y-1.5">
        <Field label="Select Item (Search by name or code)">
          <Select
            value={selectedItemId}
            onChange={(v) => {
              setSelectedItemId(v);
              setBatchId("0");
              setBinId("0");
              setSelectedUnits([]);
              setPhysical("");
            }}
            options={itemOptions}
            placeholder="Search items held at this warehouse…"
            searchable
          />
        </Field>
      </div>

      {selectedItem && (
        <>
          {/* Prominent Quantity & Item Status Banner */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 rounded-xl border border-line bg-content2/40 p-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">Total Warehouse Stock</div>
              <div className="text-base font-bold text-ink tabular-nums mt-0.5">
                {fmt(warehouseStockMap.get(selectedItem.id) ?? 0)} {selectedItem.uom_code ?? selectedItem.uom}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">Scoped System Stock</div>
              <div className="text-base font-bold text-brand tabular-nums mt-0.5">
                {fmt(scopedSystemQty)} {selectedItem.uom_code ?? selectedItem.uom}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">Tracking Type</div>
              <div className="text-xs font-medium text-body mt-1">
                {selectedItem.is_batch_tracked ? "Batch-Tracked" : "Standard"} ·{" "}
                {allUnits.length > 0 ? "Serial / Code Tracked" : "Quantity only"}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">Available Lots / Units</div>
              <div className="text-xs font-medium text-body mt-1">
                {balanceRows.length} lot(s) · {allUnits.length} tracked unit(s)
              </div>
            </div>
          </div>

          {/* 2. Cascading Batch & Bin Dropdowns */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Batch Number">
              <Select
                value={batchId}
                onChange={(v) => {
                  setBatchId(v);
                  setBinId("0");
                  setSelectedUnits([]);
                }}
                options={batchOptions}
              />
            </Field>

            <Field label="Storage Location / Bin">
              <Select
                value={binId}
                onChange={(v) => {
                  setBinId(v);
                  setSelectedUnits([]);
                }}
                options={binOptions}
              />
            </Field>
          </div>

          {/* 3. Tracked Units Section (Asset Codes / Consumable Codes / Serials / IMEIs) */}
          {allUnits.length > 0 && (
            <div className="rounded-xl border border-line/80 bg-background/60 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/50 pb-2.5">
                <div className="flex items-center gap-2 text-xs font-semibold text-ink">
                  <Tag className="h-3.5 w-3.5 text-brand" />
                  Tracked Units (Asset / Consumable / Serial / IMEI)
                  <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-bold text-brand">
                    {selectedUnits.length} of {availableTrackedUnits.length} selected
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={selectAllFilteredUnits}
                    className="text-xs text-brand hover:underline font-medium"
                  >
                    Select All
                  </button>
                  <span className="text-muted text-xs">·</span>
                  <button
                    type="button"
                    onClick={clearSelectedUnits}
                    className="text-xs text-muted hover:text-danger font-medium"
                  >
                    Clear
                  </button>
                </div>
              </div>

              {/* Filter Tabs & Search */}
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="flex items-center gap-1 overflow-x-auto text-xs pb-1 sm:pb-0">
                  {(["ALL", "ASSET", "CONSUMABLE", "SERIAL"] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setUnitFilterType(tab)}
                      className={`px-2.5 py-1 rounded-md transition-all font-medium whitespace-nowrap ${
                        unitFilterType === tab
                          ? "bg-brand text-white shadow-xs"
                          : "bg-content2 text-muted hover:text-ink"
                      }`}
                    >
                      {tab === "ALL" ? "All Units" : tab === "ASSET" ? "Asset Codes" : tab === "CONSUMABLE" ? "Consumables" : "Serials / IMEIs"}
                    </button>
                  ))}
                </div>

                <div className="relative flex-1">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
                  <input
                    type="text"
                    placeholder="Search asset code, serial, IMEI, bin…"
                    value={unitSearch}
                    onChange={(e) => setUnitSearch(e.target.value)}
                    className="w-full rounded-lg border border-line bg-background py-1.5 pl-8 pr-3 text-xs focus:outline-none focus:ring-2 focus:ring-brand/40"
                  />
                </div>
              </div>

              {/* Selected Unit Badges */}
              {selectedUnits.length > 0 && (
                <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto p-1.5 rounded-lg bg-content2/30 border border-line/40">
                  {selectedUnits.map((u) => {
                    const idInfo = unitPrimaryIdentifier(u);
                    return (
                      <span
                        key={u.id}
                        className="inline-flex items-center gap-1 rounded-md border border-brand/40 bg-brand/10 px-2 py-0.5 font-mono text-[11px] text-brand font-medium"
                      >
                        <span className="uppercase text-[9px] text-muted">{idInfo.type}:</span>
                        {idInfo.code}
                        <button
                          type="button"
                          onClick={() => toggleUnit(u)}
                          className="hover:text-danger rounded-full transition-colors ml-0.5"
                        >
                          <X size={10} />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}

              {/* Scrollable Unit Grid */}
              <div className="max-h-48 overflow-y-auto rounded-lg border border-line divide-y divide-line/40 bg-background">
                {availableTrackedUnits.length === 0 ? (
                  <div className="p-4 text-center text-xs text-muted">
                    No tracked units match the selected filters or search.
                  </div>
                ) : (
                  availableTrackedUnits.slice(0, 150).map((u) => {
                    const isSelected = selectedUnits.some((x) => x.id === u.id);
                    const idInfo = unitPrimaryIdentifier(u);
                    return (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => toggleUnit(u)}
                        className={`w-full flex items-center justify-between gap-3 px-3 py-2 text-left transition-colors text-xs ${
                          isSelected ? "bg-brand/10 text-brand" : "hover:bg-content2 text-body"
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span
                            className={`h-4 w-4 rounded flex items-center justify-center shrink-0 border ${
                              isSelected ? "border-brand bg-brand text-white" : "border-line bg-background"
                            }`}
                          >
                            {isSelected && <Check size={11} strokeWidth={3} />}
                          </span>
                          <span className="font-mono font-medium truncate">{idInfo.code}</span>
                          {u.serial_number && u.serial_number !== idInfo.code && (
                            <span className="text-[10px] text-muted truncate">SN: {u.serial_number}</span>
                          )}
                          {u.imei && u.imei !== idInfo.code && (
                            <span className="text-[10px] text-muted truncate">IMEI: {u.imei}</span>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0 text-[10px] text-muted">
                          {u.bin_code && (
                            <span className="rounded bg-content2 px-1.5 py-0.5 font-mono">{u.bin_code}</span>
                          )}
                          <span className="capitalize">{idInfo.type}</span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* 4. Physical Count, Live Difference & Suggestions */}
          <div className="rounded-xl border border-line bg-content2/20 p-4 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="text-xs font-semibold text-ink">Physical Count Found on Shelf</div>
              {/* Quick count buttons */}
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                {selectedUnits.length > 0 && (
                  <button
                    type="button"
                    onClick={() => applySuggestedCount("DIFFERENCE")}
                    className="inline-flex items-center gap-1 rounded bg-brand/10 px-2 py-1 text-xs font-medium text-brand hover:bg-brand/20 transition-colors"
                  >
                    <Sparkles size={11} /> Auto-apply {selectedUnits.length} selected {reasonDirection(reason) === "OUT" ? "damaged" : "found"} units
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => applySuggestedCount("MATCH")}
                  className="rounded bg-content2 border border-line px-2 py-1 text-xs text-muted hover:text-ink transition-colors"
                >
                  Match System ({fmt(scopedSystemQty)})
                </button>
                <button
                  type="button"
                  onClick={() => applySuggestedCount("ZERO")}
                  className="rounded bg-content2 border border-line px-2 py-1 text-xs text-muted hover:text-danger transition-colors"
                >
                  Set 0
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
              <div>
                <label className="text-[11px] font-medium text-muted block mb-1">
                  Physical Count ({selectedItem.uom_code ?? selectedItem.uom})
                </label>
                <Input
                  type="number"
                  min="0"
                  step="0.001"
                  inputMode="decimal"
                  value={physical}
                  onChange={(e) => setPhysical(e.target.value)}
                  placeholder="Enter physical count…"
                  className="text-base font-semibold"
                  autoFocus
                />
              </div>

              <div>
                <label className="text-[11px] font-medium text-muted block mb-1">Scoped System Stock</label>
                <div className="h-9 flex items-center px-3 rounded-lg border border-line bg-content2 text-sm font-semibold tabular-nums text-muted">
                  {fmt(scopedSystemQty)} {selectedItem.uom_code ?? selectedItem.uom}
                </div>
              </div>

              <div>
                <label className="text-[11px] font-medium text-muted block mb-1">Variance / Difference</label>
                <div className="h-9 flex items-center justify-between px-3 rounded-lg border border-line bg-background">
                  <span className="text-xs text-muted">Variance:</span>
                  <DiffBadge diff={diff} />
                </div>
              </div>
            </div>

            <Field label="Line Remarks / Notes (Optional)">
              <Input
                value={lineRemarks}
                onChange={(e) => setLineRemarks(e.target.value)}
                placeholder="e.g., Cracked screen, defective sensor, carton damaged during handling…"
              />
            </Field>

            {/* Validation Feedback Banner */}
            {validationErrors.length > 0 && isPhysicalEntered && (
              <div className="rounded-xl border border-danger/30 bg-danger/5 p-3 space-y-1 text-xs text-danger">
                <div className="flex items-center gap-1.5 font-semibold">
                  <ShieldAlert size={14} className="shrink-0" /> Audit Validation Requirements:
                </div>
                <ul className="list-disc list-inside space-y-0.5 text-[11px] pl-1">
                  {validationErrors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              </div>
            )}

            {canCommitLine && diff !== null && diff !== 0 && (
              <div
                className={`rounded-xl border p-2.5 flex items-center justify-between text-xs font-medium ${
                  diff > 0
                    ? "border-success/30 bg-success/5 text-success"
                    : "border-danger/30 bg-danger/5 text-danger"
                }`}
              >
                <span className="flex items-center gap-1.5">
                  {diff > 0 ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
                  Will post a stock {diff > 0 ? "addition (excess found)" : "reduction (damage/shortage)"} of{" "}
                  <strong>
                    {Math.abs(diff)} {selectedItem.uom_code ?? selectedItem.uom}
                  </strong>
                </span>
                <span className="text-[11px] opacity-80">
                  {selectedUnits.length > 0 ? `${selectedUnits.length} tracked units linked` : "Unserialized line"}
                </span>
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex items-center justify-between pt-2">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              className={TONE_MINT}
              disabled={!canCommitLine}
              onClick={commitLine}
            >
              <Check className="h-4 w-4" /> Add Item to Audit
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── audit line card in the list ──────────────────────────────────────────────

function AuditLineCard({
  line,
  reason,
  onRemove,
  onPhysicalChange,
}: {
  line: DraftAuditLine;
  reason: string;
  onRemove: () => void;
  onPhysicalChange: (val: string) => void;
}) {
  const physNum = Number(line.physical);
  const isCounted = line.physical.trim() !== "" && !isNaN(physNum);
  const diff = isCounted ? physNum - line.system_qty : null;
  const { serials, imeis, assetCodes, consumableCodes } = splitUnits(line.selected_units);

  return (
    <div className="rounded-xl border border-line/80 bg-background p-4 space-y-3 shadow-xs hover:border-brand/40 transition-colors group">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-ink text-sm truncate">{line.item_name}</div>
          <div className="text-xs text-muted font-mono">{line.item_code} · {line.uom_code}</div>
        </div>
        <button
          type="button"
          aria-label={`Remove ${line.item_name}`}
          onClick={onRemove}
          className="rounded-lg p-1.5 text-muted hover:bg-danger/10 hover:text-danger transition-colors shrink-0"
        >
          <Trash2 size={15} />
        </button>
      </div>

      {/* Badges for Batch & Location */}
      {(line.batch_no || line.bin_code) && (
        <div className="flex flex-wrap gap-1.5">
          {line.batch_no && (
            <span className="inline-flex items-center gap-1 rounded-md border border-line bg-content2 px-2 py-0.5 text-[11px] text-body">
              <Layers size={11} className="text-muted" />
              Batch: {line.batch_no}
            </span>
          )}
          {line.bin_code && (
            <span className="inline-flex items-center gap-1 rounded-md border border-line bg-content2 px-2 py-0.5 text-[11px] text-body">
              <MapPin size={11} className="text-muted" />
              Bin: {line.bin_code}
            </span>
          )}
        </div>
      )}

      {/* Selected Unit Chips */}
      {line.selected_units.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
            Tracked Units Audited ({line.selected_units.length})
          </div>
          <div className="flex flex-wrap gap-1">
            {[...assetCodes, ...consumableCodes, ...serials, ...imeis].slice(0, 16).map((code) => (
              <span
                key={code}
                className="inline-flex items-center rounded-md border border-brand/30 bg-brand/10 px-2 py-0.5 font-mono text-[10px] text-brand font-medium"
              >
                {code}
              </span>
            ))}
            {line.selected_units.length > 16 && (
              <span className="text-[10px] text-muted self-center">
                +{line.selected_units.length - 16} more
              </span>
            )}
          </div>
        </div>
      )}

      {/* Quantities Row */}
      <div className="grid grid-cols-3 gap-2 rounded-lg border border-line/60 bg-content2/30 p-2.5 items-center">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">System Stock</div>
          <div className="text-sm font-bold text-ink tabular-nums mt-0.5">{fmt(line.system_qty)}</div>
        </div>

        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-0.5">Physical Count</div>
          <Input
            type="number"
            min="0"
            step="0.001"
            inputMode="decimal"
            value={line.physical}
            onChange={(e) => onPhysicalChange(e.target.value)}
            className="h-7 text-xs font-semibold tabular-nums"
          />
        </div>

        <div className="text-right">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">Variance</div>
          <div className="mt-0.5">
            <DiffBadge diff={diff} />
          </div>
        </div>
      </div>

      {line.remarks && (
        <div className="text-xs text-muted italic bg-content2/30 rounded px-2 py-1">
          "{line.remarks}"
        </div>
      )}

      {diff !== null && diff !== 0 && (
        <div
          className={`flex items-center gap-1.5 text-xs rounded-lg px-2.5 py-1 font-medium ${
            diff < 0
              ? "bg-danger/10 text-danger border border-danger/20"
              : "bg-success/10 text-success border border-success/20"
          }`}
        >
          {diff < 0 ? <ArrowDown size={12} /> : <ArrowUp size={12} />}
          <span>
            {diff < 0 ? "Stock reduction" : "Stock addition"} ({reason.toLowerCase().replace(/_/g, " ")})
          </span>
        </div>
      )}
    </div>
  );
}

// ─── main StockAuditForm Modal ────────────────────────────────────────────────

export function StockAuditForm({ isOpen, onClose, onSubmit, isSaving }: Props) {
  // Form top-level state
  const [warehouseId, setWarehouseId] = useState("");
  const [reason, setReason] = useState("CYCLE_COUNT");
  const [remarks, setRemarks] = useState("");
  const [lines, setLines] = useState<DraftAuditLine[]>([]);
  const [isAddingItem, setIsAddingItem] = useState(false);

  // Queries
  const { data: warehouses = [] } = useQuery<WarehouseOption[]>({
    queryKey: ["warehouses"],
    queryFn: getWarehouses,
    enabled: isOpen,
  });

  const { data: catalog = [] } = useQuery<CatalogItemOption[]>({
    queryKey: ["catalog-items"],
    queryFn: getCatalogItems,
    enabled: isOpen,
  });

  const countSheetQ = useQuery({
    queryKey: ["adjustment-count-sheet", warehouseId],
    queryFn: () => getAdjustmentCountSheet(Number(warehouseId)),
    enabled: isOpen && !!warehouseId,
  });

  const warehouseStockMap = useMemo(() => {
    const map = new Map<number, number>();
    for (const r of countSheetQ.data ?? []) {
      map.set(r.item_id, r.system_qty);
    }
    return map;
  }, [countSheetQ.data]);

  const resetForm = useCallback(() => {
    setWarehouseId("");
    setReason("CYCLE_COUNT");
    setRemarks("");
    setLines([]);
    setIsAddingItem(false);
  }, []);

  useEffect(() => {
    if (!isOpen) resetForm();
  }, [isOpen, resetForm]);

  const addLine = (l: DraftAuditLine) => {
    setLines((prev) => [...prev, l]);
    setIsAddingItem(false);
  };

  const removeLine = (id: string) => {
    setLines((prev) => prev.filter((l) => l.id !== id));
  };

  const updateLinePhysical = (id: string, val: string) => {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, physical: val } : l)));
  };

  // Readiness
  const countedLines = lines.filter((l) => l.physical.trim() !== "" && !isNaN(Number(l.physical)));
  const invalidLines = countedLines.some((l) => Number(l.physical) < 0 || isNaN(Number(l.physical)));
  const canSubmit = !!warehouseId && countedLines.length > 0 && !invalidLines && !isSaving;

  const differingCount = countedLines.filter((l) => Number(l.physical) !== l.system_qty).length;
  const totalUnitsTracked = lines.reduce((acc, l) => acc + l.selected_units.length, 0);
  const warehouseName = warehouses.find((w) => String(w.id) === warehouseId)?.name ?? "Selected warehouse";

  const handleSubmit = () => {
    if (!canSubmit) return;

    onSubmit({
      warehouse_id: Number(warehouseId),
      reason,
      remarks: remarks.trim() || null,
      items: countedLines.map((l) => {
        // A tracked unit's write-off is stated in `serial_numbers`, not prose: the
        // server retires exactly these codes on an OUT posting, so a damaged asset
        // stops being offered by the issue screen. Putting them in remarks instead
        // left every "written-off" unit available on the shelf record.
        // The serial is the unit's identity the backend matches on; asset and
        // consumable codes live in their own columns and are matched through the
        // unit row by the server.
        const unitCodes = l.selected_units
          .map((u) => u.serial_number || u.imei || u.asset_code || u.consumable_code)
          .filter(Boolean);

        return {
          item_id: l.item_id,
          bin_id: l.bin_id,
          batch_id: l.batch_id,
          physical_qty: Number(l.physical),
          serial_numbers: unitCodes.length > 0 ? unitCodes : undefined,
          remarks: l.remarks || undefined,
        };
      }),
    });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="5xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex items-center gap-3 border-b border-line pb-3.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand/10 text-brand">
            <Package size={18} />
          </div>
          <div>
            <div className="text-base font-bold text-ink">New Stock Audit & Variance Verification</div>
            <div className="text-xs font-normal text-muted">
              Select items, inspect batch/location lots, tag damaged/excess asset & serial units, and reconcile
            </div>
          </div>
        </ModalHeader>

        <ModalBody className="p-0">
          <div className="flex flex-col md:flex-row min-h-[550px] divide-y md:divide-y-0 md:divide-x divide-line/70">
            {/* ── Left Sidebar: Audit Config & Statistics ── */}
            <div className="w-full md:w-80 shrink-0 flex flex-col gap-4 p-5 bg-content2/30">
              <Field label="Warehouse">
                <Select
                  value={warehouseId}
                  onChange={(v) => {
                    setWarehouseId(v);
                    setLines([]);
                    setIsAddingItem(false);
                  }}
                  options={warehouses.map((w) => ({ value: String(w.id), label: w.name }))}
                  placeholder="Select warehouse to audit"
                />
              </Field>

              <Field label="Audit Reason">
                <Select
                  value={reason}
                  onChange={setReason}
                  options={AUDIT_REASONS.map((r) => ({ value: r.value, label: r.label }))}
                />
              </Field>

              <Field label="General Audit Remarks">
                <Input
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  placeholder="Auditor name, reference memo, shift…"
                />
              </Field>

              {/* Summary Stats Panel */}
              {warehouseId && (
                <div className="mt-auto space-y-3 pt-4 border-t border-line/60">
                  <div className="rounded-xl border border-line bg-background p-3.5 space-y-2.5 shadow-xs">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-muted">
                      Audit Overview
                    </div>
                    <div className="text-xs font-medium text-ink truncate">{warehouseName}</div>

                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-lg bg-content2 p-2 text-center">
                        <div className="text-base font-bold text-ink">{lines.length}</div>
                        <div className="text-[10px] text-muted">items added</div>
                      </div>
                      <div className="rounded-lg bg-content2 p-2 text-center">
                        <div className="text-base font-bold text-ink">{countedLines.length}</div>
                        <div className="text-[10px] text-muted">reconciled</div>
                      </div>
                      <div
                        className={`rounded-lg p-2 text-center col-span-2 ${
                          differingCount > 0 ? "bg-warning/15 border border-warning/30" : "bg-content2"
                        }`}
                      >
                        <div className={`text-base font-bold ${differingCount > 0 ? "text-warning" : "text-ink"}`}>
                          {differingCount} line(s)
                        </div>
                        <div className="text-[10px] text-muted">with quantity variance</div>
                      </div>
                    </div>

                    {totalUnitsTracked > 0 && (
                      <div className="rounded-lg bg-brand/10 border border-brand/20 p-2 text-center">
                        <div className="text-sm font-bold text-brand">{totalUnitsTracked} unit(s)</div>
                        <div className="text-[10px] text-muted">tagged (asset/serial/consumable)</div>
                      </div>
                    )}
                  </div>

                  {/* Direction Note */}
                  {reasonDirection(reason) && (
                    <div
                      className={`rounded-xl border p-2.5 text-xs flex items-center gap-2 ${
                        reasonDirection(reason) === "OUT"
                          ? "border-danger/30 bg-danger/5 text-danger"
                          : "border-success/30 bg-success/5 text-success"
                      }`}
                    >
                      {reasonDirection(reason) === "OUT" ? (
                        <>
                          <Minus size={13} className="shrink-0" />
                          <span>Variances post as <strong>stock reductions</strong> (write-offs)</span>
                        </>
                      ) : (
                        <>
                          <Plus size={13} className="shrink-0" />
                          <span>Variances post as <strong>stock additions</strong> (found stock)</span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── Right Content Area: Item Builder & Audit Sheet ── */}
            <div className="flex-1 flex flex-col overflow-hidden bg-background">
              <div className="flex-1 overflow-y-auto p-5 space-y-4">
                {!warehouseId ? (
                  <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-20">
                    <div className="h-14 w-14 rounded-2xl bg-content2 flex items-center justify-center text-muted">
                      <Package size={28} />
                    </div>
                    <div>
                      <h4 className="font-semibold text-ink text-sm">Select a Warehouse</h4>
                      <p className="text-xs text-muted max-w-xs mt-1">
                        Choose a warehouse on the left to review its stock catalog and start adding audit items.
                      </p>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Add Item Builder — shown above existing lines when active */}
                    {isAddingItem && (
                      <AuditItemBuilder
                        warehouseId={Number(warehouseId)}
                        warehouseStockMap={warehouseStockMap}
                        catalog={catalog}
                        reason={reason}
                        onAddLine={addLine}
                        onCancel={() => setIsAddingItem(false)}
                      />
                    )}

                    {/* Empty-state dashed Add button — only when no lines and builder is closed */}
                    {!isAddingItem && lines.length === 0 && (
                      <button
                        type="button"
                        onClick={() => setIsAddingItem(true)}
                        className="w-full rounded-2xl border-2 border-dashed border-brand/40 py-6 flex flex-col sm:flex-row items-center justify-center gap-2 text-sm text-brand font-semibold hover:border-brand hover:bg-brand/5 transition-all shadow-2xs"
                      >
                        <Plus size={18} />
                        <span>Add Item to Audit (Select Item, Batch, Location, &amp; Tracked Units)</span>
                      </button>
                    )}

                    {/* Added Audit Line Cards */}
                    {lines.length > 0 && (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between text-xs text-muted px-1">
                          <span className="font-semibold uppercase tracking-wider">
                            Audited Items ({lines.length})
                          </span>
                          <span>{differingCount} line(s) differ from system</span>
                        </div>

                        {lines.map((line) => (
                          <AuditLineCard
                            key={line.id}
                            line={line}
                            reason={reason}
                            onRemove={() => removeLine(line.id)}
                            onPhysicalChange={(v) => updateLinePhysical(line.id, v)}
                          />
                        ))}

                        {/* Persistent Add Another Item button — always visible below list */}
                        {!isAddingItem && (
                          <button
                            type="button"
                            onClick={() => setIsAddingItem(true)}
                            className="w-full rounded-xl border border-dashed border-brand/40 py-3 flex items-center justify-center gap-2 text-sm text-brand font-semibold hover:border-brand hover:bg-brand/5 transition-all"
                          >
                            <Plus size={15} />
                            Add Another Item
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </ModalBody>

        <ModalFooter className="border-t border-line gap-2.5">
          <div className="flex-1 text-xs text-muted">
            {canSubmit ? (
              <span className="flex items-center gap-1.5 text-success font-medium">
                <CheckCircle2 size={13} />
                Ready to submit: {countedLines.length} item(s) reconciled · {differingCount} variance(s)
              </span>
            ) : !warehouseId ? (
              "Please select a warehouse"
            ) : countedLines.length === 0 ? (
              "Add at least one item and confirm physical count"
            ) : invalidLines ? (
              <span className="text-danger flex items-center gap-1">
                <AlertCircle size={13} /> Review counts: negative numbers are not allowed
              </span>
            ) : null}
          </div>

          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>

          <Button
            className={TONE_MINT}
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {isSaving ? "Saving Audit…" : "Submit Stock Audit"}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
