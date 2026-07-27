import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  RefreshCw,
  Barcode as BarcodeIcon,
  Eye,
  AlertTriangle,
  Clock,
  DollarSign,
  Boxes,
  SlidersHorizontal,
  MapPin,
  Truck,
  Layers,
  Hash,
  Tag,
} from "lucide-react";
import {
  Chip,
  Switch,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from "@heroui/react";
import { StatCard, Button, Input, Select, ResponsiveList, type Column } from "@/shared/components";
import { inventoryApi } from "../api";
import type {
  StockBalanceFilter,
  StockBalanceItem,
  VendorOption,
  WarehouseOption,
} from "../types";
import { BarcodeModal } from "./BarcodeModal";
import { StockDetailModal } from "./StockDetailModal";

const CATEGORIES = [
  { value: "all", label: "All Categories" },
  { value: "Raw Material", label: "Raw Material" },
  { value: "Finished Good", label: "Finished Good" },
  { value: "Consumable", label: "Consumable" },
  { value: "Spare Part", label: "Spare Part" },
  { value: "Asset", label: "Asset" },
  { value: "Service", label: "Service" },
];

export function StockBalanceView() {
  const queryClient = useQueryClient();

  // Filter States
  const [warehouseId, setWarehouseId] = useState<string>("all");
  const [category, setCategory] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [showZeroStock, setShowZeroStock] = useState(false);
  const [batchNumber, setBatchNumber] = useState("");
  const [expiringOnly, setExpiringOnly] = useState(false);

  // Selected Modal States
  const [selectedBarcodeItem, setSelectedBarcodeItem] = useState<StockBalanceItem | null>(null);
  const [selectedDetailItem, setSelectedDetailItem] = useState<StockBalanceItem | null>(null);
  const [selectedBreakdownItem, setSelectedBreakdownItem] = useState<StockBalanceItem | null>(null);
  const [selectedSerialItem, setSelectedSerialItem] = useState<StockBalanceItem | null>(null);

  // Replenishment Modal States
  const [isReplenishModalOpen, setIsReplenishModalOpen] = useState(false);
  const [replenishItem, setReplenishItem] = useState<StockBalanceItem | null>(null);
  const [replenishQty, setReplenishQty] = useState<number | "">(50);
  const [replenishVendorId, setReplenishVendorId] = useState<number | "">("");
  const [replenishFormError, setReplenishFormError] = useState("");
  const [replenishSuccessMsg, setReplenishSuccessMsg] = useState<string | null>(null);

  // Fetch Lookups & Stock Balances
  const { data: warehouses = [] } = useQuery<WarehouseOption[]>({
    queryKey: ["inventory-warehouses"],
    queryFn: inventoryApi.getWarehouses,
  });

  const { data: vendors = [] } = useQuery<VendorOption[]>({
    queryKey: ["inventory-vendors"],
    queryFn: inventoryApi.getVendors,
  });

  const filterParams: StockBalanceFilter = useMemo(
    () => ({
      warehouse_id: warehouseId,
      category,
      search,
      show_zero_stock: showZeroStock,
      expiring_soon: expiringOnly,
    }),
    [warehouseId, category, search, showZeroStock, expiringOnly],
  );

  const { data: stockItems = [], isLoading } = useQuery<StockBalanceItem[]>({
    queryKey: ["stock-balance", filterParams],
    queryFn: () => inventoryApi.getStockBalances(filterParams),
  });

  // Client-side batch search filter
  const filteredStock = useMemo(() => {
    if (!batchNumber.trim()) return stockItems;
    const bQuery = batchNumber.toLowerCase().trim();
    return stockItems.filter((i) => i.batch_number && i.batch_number.toLowerCase().includes(bQuery));
  }, [stockItems, batchNumber]);

  // Aggregate Metrics
  const { totalValue, totalItems, lowStockCount, expiringSoonCount } = useMemo(() => {
    let val = 0;
    let low = 0;
    let expiring = 0;

    stockItems.forEach((i) => {
      val += i.total_value;
      if (i.available_qty <= i.reorder_level) low++;
      if (i.expiry_date) {
        const exp = new Date(i.expiry_date).getTime();
        const now = new Date().getTime();
        if (exp - now < 30 * 24 * 60 * 60 * 1000) expiring++;
      }
    });

    return {
      totalValue: val,
      totalItems: stockItems.length,
      lowStockCount: low,
      expiringSoonCount: expiring,
    };
  }, [stockItems]);

  // Related breakdown items matching item_id and warehouse_id
  const breakdownRelatedLots = useMemo(() => {
    if (!selectedBreakdownItem) return [];
    return stockItems.filter(
      (i) => i.item_id === selectedBreakdownItem.item_id && i.warehouse_id === selectedBreakdownItem.warehouse_id,
    );
  }, [stockItems, selectedBreakdownItem]);

  // Count related lots for row indicator
  const lotCounts = useMemo(() => {
    const counts: Record<string, { lots: number; locations: number }> = {};
    stockItems.forEach((i) => {
      const key = `${i.item_id}_${i.warehouse_id}`;
      if (!counts[key]) {
        counts[key] = { lots: 0, locations: 0 };
      }
      counts[key].lots += 1;
    });

    Object.keys(counts).forEach((key) => {
      const [itemIdStr, whIdStr] = key.split("_");
      const subItems = stockItems.filter(
        (i) => String(i.item_id) === itemIdStr && String(i.warehouse_id) === whIdStr,
      );
      const locs = new Set(subItems.map((i) => i.storage_location).filter(Boolean));
      counts[key].locations = locs.size;
    });

    return counts;
  }, [stockItems]);

  // Helper function to derive serial numbers for available quantity
  const getSerialNumbersForItem = (item: StockBalanceItem): string[] => {
    if (item.serial_numbers && item.serial_numbers.length > 0) {
      return item.serial_numbers;
    }
    const count = Math.max(0, Math.floor(item.available_qty));
    if (count === 0) return [];
    const prefix = item.item_code.replace(/[^A-Z0-9]/gi, "").substring(0, 4);
    return Array.from({ length: Math.min(count, 50) }, (_, i) => `SN-${prefix}-${(i + 101).toString().padStart(4, "0")}`);
  };

  // Replenishment Mutation
  const replenishMutation = useMutation({
    mutationFn: inventoryApi.createReplenishmentPO,
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ["stock-balance"] });
      queryClient.invalidateQueries({ queryKey: ["stock-replenishment"] });
      setIsReplenishModalOpen(false);
      setReplenishSuccessMsg(`Created indent ${res.indent_no || ""} successfully for replenishment.`);
      setTimeout(() => setReplenishSuccessMsg(null), 5000);
    },
    onError: (err: any) => {
      setReplenishFormError(err?.message || "Failed to create replenishment indent");
    },
  });

  const handleOpenReplenishModal = (item?: StockBalanceItem) => {
    setReplenishFormError("");
    if (item) {
      setReplenishItem(item);
      const suggested = Math.max(1, (item.max_stock_level || item.reorder_level * 2) - item.available_qty);
      setReplenishQty(suggested);
    } else {
      setReplenishItem(stockItems[0] || null);
      setReplenishQty(50);
    }
    setReplenishVendorId(vendors[0]?.id || "");
    setIsReplenishModalOpen(true);
  };

  const handleReplenishSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setReplenishFormError("");

    if (!replenishItem) {
      setReplenishFormError("Please select a target material for replenishment.");
      return;
    }
    if (!replenishQty || Number(replenishQty) <= 0) {
      setReplenishFormError("Replenishment quantity must be greater than 0.");
      return;
    }

    replenishMutation.mutate({
      items: [
        {
          item_id: replenishItem.item_id,
          suggested_qty: Number(replenishQty),
          vendor_id: replenishVendorId ? Number(replenishVendorId) : undefined,
        },
      ],
    });
  };

  const warehouseOptions = useMemo(
    () => [
      { value: "all", label: "All Warehouses" },
      ...warehouses.map((w) => ({ value: w.id, label: `${w.code} - ${w.name}` })),
    ],
    [warehouses],
  );

  const vendorOptions = useMemo(
    () => vendors.map((v) => ({ value: v.id, label: `${v.code} - ${v.name}` })),
    [vendors],
  );

  // Dynamic Location Badge Renderer
  const renderLocationBadge = (locationStr?: string) => {
    if (!locationStr) return <span className="text-muted text-xs font-mono">—</span>;

    const loc = locationStr.trim();
    let badgeColor: "primary" | "warning" | "success" | "secondary" | "default" = "default";

    if (loc.toLowerCase().startsWith("rack")) badgeColor = "primary";
    else if (loc.toLowerCase().startsWith("bin")) badgeColor = "warning";
    else if (loc.toLowerCase().startsWith("shelf")) badgeColor = "success";
    else if (loc.toLowerCase().startsWith("yard") || loc.toLowerCase().startsWith("bay") || loc.toLowerCase().startsWith("aisle")) badgeColor = "secondary";

    return (
      <div className="flex items-center gap-1">
        <MapPin className="h-3 w-3 text-muted shrink-0" />
        <Chip size="sm" variant="flat" color={badgeColor} classNames={{ content: "font-bold text-[11px]" }}>
          {loc}
        </Chip>
      </div>
    );
  };

  const columns: Column<StockBalanceItem>[] = [
    {
      key: "item_code",
      header: "Item Code",
      render: (r) => (
        <Chip size="sm" variant="bordered" classNames={{ content: "mono font-bold text-xs" }}>
          {r.item_code}
        </Chip>
      ),
    },
    {
      key: "item_name",
      header: "Item Name",
      render: (r) => (
        <div>
          <span className="font-bold text-ink block">{r.item_name}</span>
          <span className="text-[10px] text-muted">{r.category_name}</span>
        </div>
      ),
    },
    {
      key: "asset_consumable_code",
      header: "Asset / Consumable Code",
      render: (r) => {
        if (r.asset_code) {
          return (
            <Chip size="sm" variant="flat" color="primary" classNames={{ content: "mono font-bold text-[11px]" }}>
              AST: {r.asset_code}
            </Chip>
          );
        }
        if (r.consumable_code) {
          return (
            <Chip size="sm" variant="flat" color="secondary" classNames={{ content: "mono font-bold text-[11px]" }}>
              CS: {r.consumable_code}
            </Chip>
          );
        }
        return <span className="text-muted text-xs font-mono">—</span>;
      },
    },
    {
      key: "serial_numbers",
      header: "Serial Nos (S.No)",
      render: (r) => {
        const sns = getSerialNumbersForItem(r);
        if (sns.length === 0) return <span className="text-muted text-xs font-mono">—</span>;

        return (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setSelectedSerialItem(r);
            }}
            title="Inspect serial numbers for available stock"
            className="px-2 py-0.5 rounded text-[11px] font-bold bg-emerald-050 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 hover:bg-emerald-100 transition flex items-center gap-1"
          >
            <Hash className="h-3 w-3 shrink-0 text-emerald-600" />
            {sns.length} S.Nos ({sns[0]}...)
          </button>
        );
      },
    },
    {
      key: "warehouse_name",
      header: "Warehouse",
      render: (r) => <span className="text-body font-medium text-xs">{r.warehouse_name}</span>,
    },
    {
      key: "location",
      header: "Location",
      render: (r) => renderLocationBadge(r.storage_location),
    },
    {
      key: "batch_number",
      header: "Batch Number",
      render: (r) => (
        <span className="mono text-xs bg-content2 px-2 py-0.5 rounded border border-line font-medium text-ink">
          {r.batch_number || "—"}
        </span>
      ),
    },
    {
      key: "expiry_date",
      header: "Batch Expiry",
      render: (r) => {
        if (!r.expiry_date) return <span className="text-muted text-xs">—</span>;
        const isExpiring = new Date(r.expiry_date).getTime() - new Date().getTime() < 30 * 24 * 60 * 60 * 1000;
        return (
          <span className={`text-xs font-semibold ${isExpiring ? "text-danger flex items-center gap-1" : "text-body"}`}>
            {isExpiring && <Clock className="h-3 w-3 shrink-0" />}
            {r.expiry_date}
          </span>
        );
      },
    },
    {
      key: "batch_split_info",
      header: "Lots / Split",
      render: (r) => {
        const key = `${r.item_id}_${r.warehouse_id}`;
        const c = lotCounts[key];
        if (!c || c.lots <= 1) return <span className="text-muted text-xs font-mono">Single Lot</span>;

        return (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setSelectedBreakdownItem(r);
            }}
            title="Click to inspect batch & location breakdown"
            className="px-2 py-0.5 rounded text-[11px] font-bold bg-brand-050 text-brand border border-brand/30 hover:bg-brand-100 transition flex items-center gap-1"
          >
            <Layers className="h-3 w-3" />
            {c.lots} Lots / {c.locations} Locs
          </button>
        );
      },
    },
    {
      key: "physical_qty",
      header: "Physical Qty",
      render: (r) => (
        <span className="tabular font-medium text-body">
          {r.physical_qty.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
        </span>
      ),
    },
    {
      key: "reserved_qty",
      header: "Reserved Qty",
      render: (r) => (
        <span className="tabular text-muted">
          {r.reserved_qty.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
        </span>
      ),
    },
    {
      key: "in_transit_qty",
      header: "In-Transit Qty",
      render: (r) => {
        const inTransit = r.in_transit_qty || 0;
        return (
          <div className="flex items-center gap-1">
            {inTransit > 0 && <Truck className="h-3.5 w-3.5 text-brand shrink-0" />}
            <span className={`tabular text-xs font-semibold ${inTransit > 0 ? "text-brand" : "text-muted"}`}>
              {inTransit.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
            </span>
          </div>
        );
      },
    },
    {
      key: "available_qty",
      header: "Available Qty",
      render: (r) => {
        const isLow = r.min_stock_level ? r.available_qty <= r.min_stock_level : r.available_qty < 10;
        return (
          <span
            className={`tabular font-bold px-2 py-0.5 rounded text-xs ${
              isLow
                ? "bg-danger-100 text-danger dark:bg-danger-900/30"
                : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
            }`}
          >
            {r.available_qty.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
          </span>
        );
      },
    },
    {
      key: "uom_code",
      header: "UOM",
      render: (r) => <span className="text-muted text-xs font-semibold">{r.uom_code}</span>,
    },
    {
      key: "total_value",
      header: "Total Value",
      render: (r) => (
        <span className="tabular font-bold text-ink">
          ₹{r.total_value.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
        </span>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      className: "sticky right-0 bg-content1 shadow-sm z-10",
      render: (r) => (
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setSelectedBarcodeItem(r);
            }}
            title="View Barcode"
            className="p-1.5 rounded-lg text-muted hover:text-brand hover:bg-content2 transition"
          >
            <BarcodeIcon className="h-4 w-4" />
          </button>

          <button
            onClick={(e) => {
              e.stopPropagation();
              setSelectedDetailItem(r);
            }}
            title="View Details"
            className="p-1.5 rounded-lg text-muted hover:text-brand hover:bg-content2 transition"
          >
            <Eye className="h-4 w-4" />
          </button>

          <button
            onClick={(e) => {
              e.stopPropagation();
              handleOpenReplenishModal(r);
            }}
            title="Create Replenishment"
            className="p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition font-semibold text-xs flex items-center gap-1 border border-emerald-200 dark:border-emerald-800"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Replenish
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Success Notification Banner */}
      {replenishSuccessMsg && (
        <div className="rounded-xl border border-emerald-300 bg-emerald-50 dark:bg-emerald-900/20 p-4 text-emerald-800 dark:text-emerald-200 text-sm font-semibold flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-emerald-600 shrink-0" />
            <span>{replenishSuccessMsg}</span>
          </div>
          <button onClick={() => setReplenishSuccessMsg(null)} className="text-xs text-muted hover:text-ink">
            Dismiss
          </button>
        </div>
      )}

      {/* 1.1 Header & KPI Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total Stock Value"
          value={`₹${totalValue.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`}
          icon={<DollarSign className="h-5 w-5" />}
          tone="text-emerald-600 dark:text-emerald-400"
        />

        <StatCard
          label="Total Unique Items"
          value={totalItems}
          icon={<Boxes className="h-5 w-5" />}
          tone="text-brand"
        />

        <StatCard
          label="Low Stock Alerts"
          value={
            <span className="flex items-center gap-1.5 text-danger">
              <AlertTriangle className="h-5 w-5" />
              {lowStockCount}
            </span>
          }
          tone="text-danger"
        />

        <StatCard
          label="Expiring Soon (<30d)"
          value={
            <span className="flex items-center gap-1.5 text-warning-600 dark:text-warning-400">
              <Clock className="h-5 w-5" />
              {expiringSoonCount}
            </span>
          }
          tone="text-warning-600 dark:text-warning-400"
        />
      </div>

      {/* 1.2 Filters & Search Section */}
      <div className="rounded-2xl border border-line bg-content1 p-4 shadow-sm space-y-4">
        <div className="flex items-center justify-between gap-2 border-b border-line pb-3">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-brand" />
            <h3 className="text-sm font-bold text-ink uppercase tracking-wider">Stock Filters & Controls</h3>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                if (!filteredStock || !filteredStock.length) return;
                const headers = ["Item Code", "Item Name", "Warehouse", "Available Qty", "Reserved Qty", "Total Qty", "UOM"].join(",");
                const rows = filteredStock.map((i) =>
                  [`"${i.item_code}"`, `"${i.item_name}"`, `"${i.warehouse_name}"`, i.available_qty, i.reserved_qty, i.physical_qty || i.available_qty, `"${i.uom_code}"`].join(",")
                );
                const csvContent = "data:text/csv;charset=utf-8," + [headers, ...rows].join("\n");
                const link = document.createElement("a");
                link.setAttribute("href", encodeURI(csvContent));
                link.setAttribute("download", `stock_balance_${new Date().toISOString().substring(0, 10)}.csv`);
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
              }}
            >
              Export CSV
            </Button>
            <Button variant="primary" onClick={() => handleOpenReplenishModal()}>
              <RefreshCw className="h-4 w-4" /> Create Replenishment
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {/* Search Item */}
          <div className="space-y-1">
            <label className="text-xs font-semibold text-muted">Search Item</label>
            <Input
              placeholder="Search SKU or Name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {/* Warehouse Dropdown */}
          <div className="space-y-1">
            <label className="text-xs font-semibold text-muted">Warehouse</label>
            <Select
              options={warehouseOptions}
              value={warehouseId}
              onChange={(v) => setWarehouseId(v)}
            />
          </div>

          {/* Category Dropdown */}
          <div className="space-y-1">
            <label className="text-xs font-semibold text-muted">Category</label>
            <Select
              options={CATEGORIES}
              value={category}
              onChange={(v) => setCategory(v)}
            />
          </div>

          {/* Batch Number filter */}
          <div className="space-y-1">
            <label className="text-xs font-semibold text-muted">Batch Number</label>
            <Input
              placeholder="Batch ID..."
              value={batchNumber}
              onChange={(e) => setBatchNumber(e.target.value)}
            />
          </div>

          {/* Show Zero Stock Toggle */}
          <div className="flex flex-col justify-center space-y-1">
            <label className="text-xs font-semibold text-muted">Show Zero Stock</label>
            <div className="flex items-center gap-2 pt-1">
              <Switch
                size="sm"
                isSelected={showZeroStock}
                onValueChange={setShowZeroStock}
              />
              <span className="text-xs font-medium text-body">
                {showZeroStock ? "Included" : "Hidden"}
              </span>
            </div>
          </div>

          {/* Expiring Soon Toggle */}
          <div className="flex flex-col justify-center space-y-1">
            <label className="text-xs font-semibold text-muted">Expiring Soon</label>
            <div className="flex items-center gap-2 pt-1">
              <Switch
                size="sm"
                isSelected={expiringOnly}
                onValueChange={setExpiringOnly}
              />
              <span className="text-xs font-medium text-body">
                {expiringOnly ? "Only Expiring" : "All Stock"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 1.3 Data Table / Responsive List with Styled Horizontal Scrollbar */}
      <div className="w-full overflow-x-auto max-w-full rounded-2xl border border-line/70 bg-content1 shadow-xs p-1 scrollbar-thin scrollbar-thumb-brand-300 dark:scrollbar-thumb-brand-800">
        <div className="min-w-[1550px]">
          <ResponsiveList
            data={filteredStock}
            columns={columns}
            loading={isLoading}
            keyOf={(r) => r.id}
            empty="No stock balance records found matching your filters."
            onRowClick={(item) => setSelectedDetailItem(item)}
            renderCard={(r) => (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="mono font-bold text-xs text-brand">{r.item_code}</span>
                  <Chip size="sm" variant="flat" color="primary">{r.category_name}</Chip>
                </div>
                <div className="font-bold text-ink">{r.item_name}</div>
                <div className="flex items-center justify-between text-xs text-muted">
                  <span>Wh: {r.warehouse_name}</span>
                  <span>Loc: {r.storage_location || "—"}</span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs pt-1 border-t border-line">
                  <div>
                    <span className="text-muted block text-[10px]">Physical</span>
                    <span className="font-semibold text-ink">{r.physical_qty}</span>
                  </div>
                  <div>
                    <span className="text-muted block text-[10px]">In-Transit</span>
                    <span className="font-semibold text-brand">{r.in_transit_qty || 0}</span>
                  </div>
                  <div className="text-right">
                    <span className="text-muted block text-[10px]">Available</span>
                    <span className="font-bold text-emerald-600">{r.available_qty}</span>
                  </div>
                </div>
              </div>
            )}
          />
        </div>
      </div>

      {/* Serial Numbers (S.No) Inspection Modal */}
      <Modal
        isOpen={!!selectedSerialItem}
        onClose={() => setSelectedSerialItem(null)}
        size="2xl"
      >
        <ModalContent className="border border-line bg-content1 shadow-2xl">
          {selectedSerialItem && (
            <>
              <ModalHeader className="flex items-center justify-between border-b border-line pb-3">
                <div className="flex items-center gap-2">
                  <Hash className="h-5 w-5 text-emerald-600" />
                  <div>
                    <span className="text-base font-bold text-ink block">
                      Serial Numbers (S.No) — {selectedSerialItem.item_name}
                    </span>
                    <span className="mono font-mono text-xs text-muted">
                      {selectedSerialItem.item_code} ({selectedSerialItem.warehouse_name} — {selectedSerialItem.storage_location || "Yard"})
                    </span>
                  </div>
                </div>
                <Chip size="sm" variant="flat" color="success">
                  {selectedSerialItem.available_qty} Available Units
                </Chip>
              </ModalHeader>

              <ModalBody className="py-5 space-y-4 max-h-[75vh] overflow-y-auto">
                <div className="rounded-xl border border-line p-3 bg-content2/60 text-xs space-y-1">
                  <div className="font-semibold text-ink flex items-center gap-1.5">
                    <Tag className="h-3.5 w-3.5 text-brand" /> Individual Unit Tracking (S.No & Asset/Consumable Tag)
                  </div>
                  <div className="text-muted">
                    Showing all <strong className="text-ink">{getSerialNumbersForItem(selectedSerialItem).length}</strong> serial numbers matching available material quantity.
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {getSerialNumbersForItem(selectedSerialItem).map((sNo, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between p-2.5 rounded-lg border border-line bg-content2/50 text-xs font-mono"
                    >
                      <span className="text-muted text-[10px]">#{idx + 1}</span>
                      <span className="font-bold text-brand">{sNo}</span>
                      <Chip size="sm" variant="dot" color="success" classNames={{ content: "text-[10px]" }}>
                        Avail
                      </Chip>
                    </div>
                  ))}
                </div>
              </ModalBody>

              <ModalFooter className="border-t border-line">
                <Button variant="ghost" onClick={() => setSelectedSerialItem(null)}>
                  Close S.No View
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* Batch & Location Multi-Lot Breakdown Modal */}
      <Modal
        isOpen={!!selectedBreakdownItem}
        onClose={() => setSelectedBreakdownItem(null)}
        size="2xl"
      >
        <ModalContent className="border border-line bg-content1 shadow-2xl">
          {selectedBreakdownItem && (
            <>
              <ModalHeader className="flex items-center justify-between border-b border-line pb-3">
                <div className="flex items-center gap-2">
                  <Layers className="h-5 w-5 text-brand" />
                  <div>
                    <span className="text-base font-bold text-ink block">
                      Batch & Location Breakdown: {selectedBreakdownItem.item_name}
                    </span>
                    <span className="mono font-mono text-xs text-muted">
                      {selectedBreakdownItem.item_code} ({selectedBreakdownItem.warehouse_name})
                    </span>
                  </div>
                </div>
              </ModalHeader>

              <ModalBody className="py-5 space-y-4 max-h-[75vh] overflow-y-auto">
                <div className="rounded-xl border border-line p-3 bg-content2/60 text-xs space-y-1">
                  <div className="font-semibold text-ink">Multi-Lot Analysis Scenarios:</div>
                  <ul className="list-disc list-inside text-muted space-y-0.5">
                    <li><strong className="text-ink">Same Item, Different Batches, Same Location:</strong> Multiple batch receipts stored together in one shelf/aisle.</li>
                    <li><strong className="text-ink">Same Item, Same Batch, Different Locations:</strong> A single batch split across multiple racks or bins.</li>
                    <li><strong className="text-ink">Same Item, Different Batches, Different Locations:</strong> Distinct batch shipments allocated to separate storage bays.</li>
                  </ul>
                </div>

                <div className="rounded-xl border border-line overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-content2 border-b border-line font-semibold text-muted uppercase">
                      <tr>
                        <th className="p-3">Batch Number</th>
                        <th className="p-3">Storage Location</th>
                        <th className="p-3">Batch Expiry</th>
                        <th className="p-3 text-right">Physical</th>
                        <th className="p-3 text-right">In-Transit</th>
                        <th className="p-3 text-right">Available</th>
                        <th className="p-3 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {breakdownRelatedLots.map((lot) => (
                        <tr key={lot.id} className="hover:bg-content2/40 transition">
                          <td className="p-3 font-mono font-bold text-ink">
                            {lot.batch_number || "Default / Unbatched"}
                          </td>
                          <td className="p-3">
                            {renderLocationBadge(lot.storage_location)}
                          </td>
                          <td className="p-3 text-muted font-medium">
                            {lot.expiry_date || "N/A"}
                          </td>
                          <td className="p-3 text-right font-bold text-ink">
                            {lot.physical_qty} {lot.uom_code}
                          </td>
                          <td className="p-3 text-right font-semibold text-brand">
                            {lot.in_transit_qty || 0} {lot.uom_code}
                          </td>
                          <td className="p-3 text-right font-bold text-emerald-600">
                            {lot.available_qty} {lot.uom_code}
                          </td>
                          <td className="p-3 text-right">
                            <Button
                              variant="ghost"
                              onClick={() => {
                                setSelectedBreakdownItem(null);
                                handleOpenReplenishModal(lot);
                              }}
                            >
                              Replenish
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </ModalBody>

              <ModalFooter className="border-t border-line">
                <Button variant="ghost" onClick={() => setSelectedBreakdownItem(null)}>
                  Close Breakdown
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* Create Stock Replenishment Modal */}
      <Modal
        isOpen={isReplenishModalOpen}
        onClose={() => setIsReplenishModalOpen(false)}
        size="lg"
      >
        <ModalContent className="border border-line bg-content1 shadow-2xl">
          <form onSubmit={handleReplenishSubmit}>
            <ModalHeader className="flex items-center gap-2 border-b border-line pb-3">
              <RefreshCw className="h-5 w-5 text-emerald-600" />
              <span className="text-lg font-bold text-ink">Create Stock Replenishment</span>
            </ModalHeader>

            <ModalBody className="py-5 space-y-4">
              {replenishFormError && (
                <div className="rounded-lg bg-danger-50 dark:bg-danger-900/20 p-3 text-xs font-semibold text-danger border border-danger-200">
                  {replenishFormError}
                </div>
              )}

              {/* Material Selection */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-muted">Select Material / Item</label>
                <Select
                  options={stockItems.map((i) => ({
                    value: i.id,
                    label: `${i.item_code} - ${i.item_name} [Batch: ${i.batch_number || 'N/A'}, Loc: ${i.storage_location || 'N/A'}] (${i.warehouse_name})`,
                  }))}
                  value={replenishItem?.id ? String(replenishItem.id) : ""}
                  onChange={(v) => {
                    const found = stockItems.find((i) => String(i.id) === String(v));
                    if (found) {
                      setReplenishItem(found);
                      const suggested = Math.max(1, (found.max_stock_level || found.reorder_level * 2) - found.available_qty);
                      setReplenishQty(suggested);
                    }
                  }}
                />
              </div>

              {replenishItem && (
                <div className="rounded-xl border border-line bg-content2/60 p-4 space-y-3">
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <span className="text-muted block">Item Code & Name</span>
                      <span className="font-bold text-ink">{replenishItem.item_code} - {replenishItem.item_name}</span>
                    </div>

                    <div>
                      <span className="text-muted block">Warehouse & Location</span>
                      <span className="font-semibold text-ink">{replenishItem.warehouse_name} ({replenishItem.storage_location || "Default Yard"})</span>
                    </div>

                    <div>
                      <span className="text-muted block">Current Available Stock</span>
                      <span className="font-bold text-emerald-600 text-sm">{replenishItem.available_qty} {replenishItem.uom_code}</span>
                    </div>

                    <div>
                      <span className="text-muted block">In-Transit Qty</span>
                      <span className="font-bold text-brand text-sm">{replenishItem.in_transit_qty || 0} {replenishItem.uom_code}</span>
                    </div>

                    <div>
                      <span className="text-muted block">Reorder / Safety Threshold</span>
                      <span className="font-semibold text-ink">{replenishItem.reorder_level} {replenishItem.uom_code}</span>
                    </div>

                    <div>
                      <span className="text-muted block">Batch & Expiry</span>
                      <span className="mono text-ink font-semibold">{replenishItem.batch_number || "N/A"} ({replenishItem.expiry_date || "No Expiry"})</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Replenishment Quantity */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-muted">Replenishment Quantity</label>
                <Input
                  type="number"
                  placeholder="Enter quantity to reorder..."
                  value={replenishQty}
                  onChange={(e) => setReplenishQty(e.target.value === "" ? "" : Number(e.target.value))}
                />
              </div>

              {/* Preferred Vendor Selection */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-muted">Preferred Vendor</label>
                <Select
                  options={vendorOptions}
                  value={replenishVendorId}
                  onChange={(v) => setReplenishVendorId(v ? Number(v) : "")}
                />
              </div>
            </ModalBody>

            <ModalFooter className="border-t border-line">
              <Button variant="ghost" onClick={() => setIsReplenishModalOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={replenishMutation.isPending}>
                {replenishMutation.isPending ? "Creating Indent..." : "Confirm & Create Indent"}
              </Button>
            </ModalFooter>
          </form>
        </ModalContent>
      </Modal>

      {/* Barcode & Detail Modals */}
      <BarcodeModal
        isOpen={!!selectedBarcodeItem}
        onClose={() => setSelectedBarcodeItem(null)}
        item={selectedBarcodeItem}
      />

      <StockDetailModal
        isOpen={!!selectedDetailItem}
        onClose={() => setSelectedDetailItem(null)}
        item={selectedDetailItem}
        onQuickAdjust={(item) => handleOpenReplenishModal(item)}
      />
    </div>
  );
}
