import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  FileCheck2,
  TrendingDown,
  DollarSign,
  CheckSquare,
  Square,
  ShoppingCart,
  CheckCircle,
  Plus,
  RefreshCw,
} from "lucide-react";
import {
  Chip,
  Checkbox,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from "@heroui/react";
import { StatCard, Button, Input, Select, ResponsiveList, type Column } from "@/shared/components";
import { inventoryApi } from "../api";
import type { ReplenishmentItem, VendorOption } from "../types";

export function StockReplenishmentView() {
  const queryClient = useQueryClient();

  const [itemsData, setItemsData] = useState<ReplenishmentItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [vendorSelections, setVendorSelections] = useState<Record<number, number>>({});
  const [suggestedQtys, setSuggestedQtys] = useState<Record<number, number>>({});
  const [minStockLevels, setMinStockLevels] = useState<Record<number, number>>({});
  const [reorderLevels, setReorderLevels] = useState<Record<number, number>>({});
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);

  // New Replenishment Modal State
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [selectedItemForAdd, setSelectedItemForAdd] = useState<ReplenishmentItem | null>(null);
  const [addQty, setAddQty] = useState<number | "">(50);
  const [addVendorId, setAddVendorId] = useState<number | "">("");
  const [addModalError, setAddModalError] = useState("");

  const { data: rawReplenishments = [], isLoading } = useQuery<ReplenishmentItem[]>({
    queryKey: ["stock-replenishment"],
    queryFn: async () => {
      const data = await inventoryApi.getReplenishments();
      setItemsData(data);
      return data;
    },
  });

  const { data: vendors = [] } = useQuery<VendorOption[]>({
    queryKey: ["inventory-vendors"],
    queryFn: inventoryApi.getVendors,
  });

  const vendorOptions = useMemo(
    () => [
      { value: "", label: "Select Vendor" },
      ...vendors.map((v) => ({ value: v.id, label: `${v.code} - ${v.name}` })),
    ],
    [vendors],
  );

  // Compute Metrics
  const activeItems = itemsData.length > 0 ? itemsData : rawReplenishments;

  const { itemsNeedingReorder, criticalOutOfStock, totalReorderValue } = useMemo(() => {
    let count = activeItems.length;
    let critical = 0;
    let totalVal = 0;

    activeItems.forEach((item) => {
      const minLevel = minStockLevels[item.id] ?? item.min_stock_level ?? 20;
      if (item.current_available <= 0 || item.current_available <= minLevel) {
        critical++;
      }
      const qty = suggestedQtys[item.id] ?? item.suggested_reorder_qty;
      totalVal += qty * item.est_unit_rate;
    });

    return {
      itemsNeedingReorder: count,
      criticalOutOfStock: critical,
      totalReorderValue: totalVal,
    };
  }, [activeItems, minStockLevels, suggestedQtys]);

  const toggleSelectAll = () => {
    if (selectedIds.size === activeItems.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(activeItems.map((i) => i.id)));
    }
  };

  const toggleSelectRow = (id: number) => {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedIds(next);
  };

  const createIndentMutation = useMutation({
    mutationFn: (selectedItems: { item_id: number; suggested_qty: number; vendor_id?: number }[]) =>
      inventoryApi.createPurchaseIndent(selectedItems),
    onSuccess: (res) => {
      setFeedbackMsg(res.message);
      queryClient.invalidateQueries({ queryKey: ["stock-replenishment"] });
      setSelectedIds(new Set());
      setIsAddModalOpen(false);
      setTimeout(() => setFeedbackMsg(null), 5000);
    },
    onError: (err: any) => {
      setAddModalError(err?.message || "Failed to create replenishment indent.");
    },
  });

  const handleCreateIndent = (item?: ReplenishmentItem) => {
    if (item) {
      const qty = suggestedQtys[item.id] ?? item.suggested_reorder_qty;
      const vId = vendorSelections[item.id] ?? item.preferred_vendor_id ?? undefined;
      createIndentMutation.mutate([{ item_id: item.item_id, suggested_qty: qty, vendor_id: vId }]);
    } else {
      // Bulk creation
      const itemsToCreate = Array.from(selectedIds).map((id) => {
        const row = activeItems.find((i) => i.id === id);
        const qty = suggestedQtys[id] ?? row?.suggested_reorder_qty ?? 100;
        const vId = vendorSelections[id] ?? row?.preferred_vendor_id ?? undefined;
        return {
          item_id: row?.item_id ?? id,
          suggested_qty: qty,
          vendor_id: vId,
        };
      });

      if (itemsToCreate.length === 0) return;
      createIndentMutation.mutate(itemsToCreate);
    }
  };

  const handleOpenAddModal = (item?: ReplenishmentItem) => {
    setAddModalError("");
    const target = item || activeItems[0] || null;
    setSelectedItemForAdd(target);
    if (target) {
      setAddQty(target.suggested_reorder_qty || 50);
      setAddVendorId(target.preferred_vendor_id || vendors[0]?.id || "");
    }
    setIsAddModalOpen(true);
  };

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setAddModalError("");

    if (!selectedItemForAdd) {
      setAddModalError("Please select a target material.");
      return;
    }
    if (!addQty || Number(addQty) <= 0) {
      setAddModalError("Replenishment quantity must be greater than 0.");
      return;
    }

    createIndentMutation.mutate([
      {
        item_id: selectedItemForAdd.item_id,
        suggested_qty: Number(addQty),
        vendor_id: addVendorId ? Number(addVendorId) : undefined,
      },
    ]);
  };

  const columns: Column<ReplenishmentItem>[] = [
    {
      key: "select",
      header: "",
      render: (r) => (
        <Checkbox
          isSelected={selectedIds.has(r.id)}
          onValueChange={() => toggleSelectRow(r.id)}
          aria-label={`Select ${r.item_code}`}
        />
      ),
    },
    {
      key: "item_code_name",
      header: "Item Code & Name",
      render: (r) => (
        <div>
          <div className="font-bold text-ink">{r.item_name}</div>
          <div className="mono font-mono text-[11px] text-brand">{r.item_code}</div>
        </div>
      ),
    },
    {
      key: "warehouse",
      header: "Warehouse",
      render: (r) => (
        <div>
          <span className="text-body font-semibold block">{r.warehouse_name}</span>
          <span className="text-[10px] text-muted">{r.category_name}</span>
        </div>
      ),
    },
    {
      key: "current_available",
      header: "Current Available",
      render: (r) => {
        const minLevel = minStockLevels[r.id] ?? r.min_stock_level ?? 20;
        const isCritical = r.current_available <= minLevel;
        return (
          <span
            className={`tabular font-bold px-2 py-0.5 rounded ${
              isCritical
                ? "bg-danger-100 text-danger dark:bg-danger-900/30"
                : "bg-warning-100 text-warning-700 dark:bg-warning-900/30"
            }`}
          >
            {r.current_available.toLocaleString("en-IN")} {r.uom_code}
          </span>
        );
      },
    },
    {
      key: "min_stock_level",
      header: "Min Qty (Safety)",
      render: (r) => {
        const val = minStockLevels[r.id] ?? r.min_stock_level ?? 20;
        return (
          <div className="w-24">
            <Input
              type="number"
              min="0"
              value={val}
              onChange={(e) => {
                const nextMin = e.target.value !== "" ? Number(e.target.value) : 0;
                setMinStockLevels((prev) => ({ ...prev, [r.id]: nextMin }));
                const rLevel = reorderLevels[r.id] ?? r.reorder_level ?? 30;
                const newSuggested = Math.max(1, rLevel * 2 - r.current_available);
                setSuggestedQtys((prev) => ({ ...prev, [r.id]: newSuggested }));
              }}
              className="text-right font-medium"
            />
          </div>
        );
      },
    },
    {
      key: "reorder_level",
      header: "Reorder Level",
      render: (r) => {
        const val = reorderLevels[r.id] ?? r.reorder_level ?? 30;
        return (
          <div className="w-24">
            <Input
              type="number"
              min="0"
              value={val}
              onChange={(e) => {
                const nextReorder = e.target.value !== "" ? Number(e.target.value) : 0;
                setReorderLevels((prev) => ({ ...prev, [r.id]: nextReorder }));
                const newSuggested = Math.max(1, nextReorder * 2 - r.current_available);
                setSuggestedQtys((prev) => ({ ...prev, [r.id]: newSuggested }));
              }}
              className="text-right font-bold text-brand"
            />
          </div>
        );
      },
    },
    {
      key: "suggested_reorder_qty",
      header: "Suggested Reorder Qty",
      render: (r) => {
        const val = suggestedQtys[r.id] ?? r.suggested_reorder_qty;
        return (
          <div className="w-28">
            <Input
              type="number"
              min="1"
              value={val}
              onChange={(e) => {
                const nextQty = e.target.value ? Number(e.target.value) : 0;
                setSuggestedQtys((prev) => ({ ...prev, [r.id]: nextQty }));
              }}
              className="text-right font-bold"
            />
          </div>
        );
      },
    },
    {
      key: "preferred_vendor",
      header: "Preferred Vendor",
      render: (r) => {
        const vVal = vendorSelections[r.id] ?? r.preferred_vendor_id ?? "";
        return (
          <div className="w-44">
            <Select
              options={vendorOptions}
              value={vVal}
              onChange={(v) =>
                setVendorSelections((prev) => ({ ...prev, [r.id]: v ? Number(v) : 0 }))
              }
            />
          </div>
        );
      },
    },
    {
      key: "est_unit_rate",
      header: "Est. Unit Rate",
      render: (r) => (
        <span className="tabular text-body text-xs">
          ₹{r.est_unit_rate.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
        </span>
      ),
    },
    {
      key: "est_total_cost",
      header: "Est. Total Cost",
      render: (r) => {
        const qty = suggestedQtys[r.id] ?? r.suggested_reorder_qty;
        const total = qty * r.est_unit_rate;
        return (
          <span className="tabular font-bold text-emerald-600 dark:text-emerald-400">
            ₹{total.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
          </span>
        );
      },
    },
    {
      key: "action",
      header: "Action",
      className: "sticky right-0 bg-content1 shadow-sm z-10",
      render: (r) => (
        <Button
          variant="primary"
          onClick={() => handleCreateIndent(r)}
          disabled={createIndentMutation.isPending}
        >
          <ShoppingCart className="h-3.5 w-3.5" /> Indent
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* 3.1 Header KPI Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          label="Items Needing Reorder"
          value={itemsNeedingReorder}
          icon={<TrendingDown className="h-5 w-5" />}
          tone="text-brand"
        />

        <StatCard
          label="Critical Out-of-Stock"
          value={
            <span className="flex items-center gap-1.5 text-danger">
              <AlertCircle className="h-5 w-5 animate-pulse" />
              {criticalOutOfStock}
            </span>
          }
          tone="text-danger"
        />

        <StatCard
          label="Total Reorder Value"
          value={`₹${totalReorderValue.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`}
          icon={<DollarSign className="h-5 w-5" />}
          tone="text-emerald-600 dark:text-emerald-400"
        />
      </div>

      {/* Feedback Banner */}
      {feedbackMsg && (
        <div className="flex items-center gap-2 rounded-xl bg-emerald-50 dark:bg-emerald-900/30 p-4 text-sm font-bold text-emerald-700 dark:text-emerald-300 border border-emerald-200">
          <CheckCircle className="h-5 w-5" />
          <span>{feedbackMsg}</span>
        </div>
      )}

      {/* Bulk Action Bar */}
      <div className="flex items-center justify-between gap-4 rounded-2xl border border-line bg-content1 p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <button
            onClick={toggleSelectAll}
            className="flex items-center gap-2 text-sm font-semibold text-body hover:text-brand transition"
          >
            {selectedIds.size > 0 && selectedIds.size === activeItems.length ? (
              <CheckSquare className="h-4 w-4 text-brand" />
            ) : (
              <Square className="h-4 w-4 text-muted" />
            )}
            Select All ({selectedIds.size} / {activeItems.length})
          </button>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={() => handleOpenAddModal()}>
            <Plus className="h-4 w-4" /> Add Replenishment
          </Button>

          {selectedIds.size > 0 && (
            <Button
              variant="primary"
              onClick={() => handleCreateIndent()}
              disabled={createIndentMutation.isPending}
            >
              <FileCheck2 className="h-4 w-4" />
              Create Bulk Indent ({selectedIds.size} Items)
            </Button>
          )}
        </div>
      </div>

      {/* 3.2 Replenishment Data Table with Horizontal Scrollbar */}
      <div className="w-full overflow-x-auto max-w-full rounded-2xl border border-line/70 bg-content1 shadow-xs p-1 scrollbar-thin scrollbar-thumb-brand-300">
        <div className="min-w-[1250px]">
          <ResponsiveList
            data={activeItems}
            columns={columns}
            loading={isLoading}
            keyOf={(r) => r.id}
            empty="All stock levels are optimal. No items require replenishment currently."
            renderCard={(r) => {
              const qty = suggestedQtys[r.id] ?? r.suggested_reorder_qty;
              const totalCost = qty * r.est_unit_rate;
              const minLevel = minStockLevels[r.id] ?? r.min_stock_level ?? 20;
              const rLevel = reorderLevels[r.id] ?? r.reorder_level ?? 30;
              return (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        isSelected={selectedIds.has(r.id)}
                        onValueChange={() => toggleSelectRow(r.id)}
                      />
                      <span className="font-bold text-ink">{r.item_name}</span>
                    </div>
                    <Chip size="sm" variant="flat" color="primary">
                      {r.category_name}
                    </Chip>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs text-muted">
                    <div>
                      <span className="block font-mono text-brand font-bold">{r.item_code}</span>
                      <span>Warehouse: {r.warehouse_name}</span>
                    </div>
                    <div className="text-right">
                      <span className="block font-bold text-danger">Available: {r.current_available}</span>
                      <span>Min: {minLevel} | Reorder: {rLevel}</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-line">
                    <div className="text-xs">
                      <span className="text-muted">Est Cost: </span>
                      <span className="font-bold text-emerald-600">₹{totalCost.toLocaleString("en-IN")}</span>
                    </div>
                    <Button variant="primary" onClick={() => handleCreateIndent(r)}>
                      Create Indent
                    </Button>
                  </div>
                </div>
              );
            }}
          />
        </div>
      </div>

      {/* Add Replenishment Modal */}
      <Modal isOpen={isAddModalOpen} onClose={() => setIsAddModalOpen(false)} size="lg">
        <ModalContent className="border border-line bg-content1 shadow-2xl">
          <form onSubmit={handleAddSubmit}>
            <ModalHeader className="flex items-center gap-2 border-b border-line pb-3">
              <RefreshCw className="h-5 w-5 text-emerald-600" />
              <span className="text-lg font-bold text-ink">Add Stock Replenishment Indent</span>
            </ModalHeader>

            <ModalBody className="py-5 space-y-4">
              {addModalError && (
                <div className="rounded-lg bg-danger-50 dark:bg-danger-900/20 p-3 text-xs font-semibold text-danger border border-danger-200">
                  {addModalError}
                </div>
              )}

              {/* Select Material */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-muted">Material & Warehouse</label>
                <Select
                  options={activeItems.map((i) => ({
                    value: i.id,
                    label: `${i.item_code} - ${i.item_name} (${i.warehouse_name})`,
                  }))}
                  value={selectedItemForAdd?.id ? String(selectedItemForAdd.id) : ""}
                  onChange={(v) => {
                    const found = activeItems.find((i) => String(i.id) === String(v));
                    if (found) {
                      setSelectedItemForAdd(found);
                      setAddQty(found.suggested_reorder_qty || 50);
                    }
                  }}
                />
              </div>

              {selectedItemForAdd && (
                <div className="rounded-xl border border-line bg-content2/60 p-4 space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-muted">Item:</span>
                    <span className="font-bold text-ink">{selectedItemForAdd.item_code} - {selectedItemForAdd.item_name}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted">Target Warehouse:</span>
                    <span className="font-semibold text-ink">{selectedItemForAdd.warehouse_name}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted">Current Available:</span>
                    <span className="font-bold text-danger">{selectedItemForAdd.current_available} {selectedItemForAdd.uom_code}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted">Est Unit Rate:</span>
                    <span className="font-semibold text-emerald-600">₹{selectedItemForAdd.est_unit_rate}</span>
                  </div>
                </div>
              )}

              {/* Replenishment Quantity */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-muted">Reorder Quantity</label>
                <Input
                  type="number"
                  placeholder="Enter quantity to reorder..."
                  value={addQty}
                  onChange={(e) => setAddQty(e.target.value === "" ? "" : Number(e.target.value))}
                />
              </div>

              {/* Vendor */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-muted">Preferred Vendor</label>
                <Select
                  options={vendorOptions}
                  value={addVendorId}
                  onChange={(v) => setAddVendorId(v ? Number(v) : "")}
                />
              </div>
            </ModalBody>

            <ModalFooter className="border-t border-line">
              <Button variant="ghost" onClick={() => setIsAddModalOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={createIndentMutation.isPending}>
                {createIndentMutation.isPending ? "Creating Indent..." : "Confirm & Create Indent"}
              </Button>
            </ModalFooter>
          </form>
        </ModalContent>
      </Modal>
    </div>
  );
}
