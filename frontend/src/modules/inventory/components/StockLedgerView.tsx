import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Filter, FileSpreadsheet, ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { Chip } from "@heroui/react";
import { Button, Input, Select, ResponsiveList, type Column } from "@/shared/components";
import { inventoryApi } from "../api";
import type { CatalogItemOption, StockLedgerFilter, StockLedgerItem, WarehouseOption } from "../types";

const TRANSACTION_TYPES = [
  { value: "all", label: "All Transaction Types" },
  { value: "GRN", label: "GRN (Goods Receipt Note)" },
  { value: "Sales Issue", label: "Sales Issue" },
  { value: "Stock Transfer", label: "Stock Transfer" },
  { value: "Stock Adjustment", label: "Stock Adjustment" },
  { value: "Consumption", label: "Consumption" },
  { value: "Return Inward", label: "Return Inward" },
  { value: "Return Outward", label: "Return Outward" },
  { value: "Opening Stock", label: "Opening Stock" },
];

export function StockLedgerView() {
  const [itemId, setItemId] = useState<string>("all");
  const [warehouseId, setWarehouseId] = useState<string>("all");
  const [txnType, setTxnType] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const { data: warehouses = [] } = useQuery<WarehouseOption[]>({
    queryKey: ["inventory-warehouses"],
    queryFn: inventoryApi.getWarehouses,
  });

  const { data: catalog = [] } = useQuery<CatalogItemOption[]>({
    queryKey: ["inventory-catalog"],
    queryFn: inventoryApi.getCatalogItems,
  });

  const filterParams: StockLedgerFilter = useMemo(
    () => ({
      item_id: itemId === "all" ? undefined : itemId,
      warehouse_id: warehouseId === "all" ? undefined : warehouseId,
      transaction_type: txnType === "all" ? undefined : txnType,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
    }),
    [itemId, warehouseId, txnType, dateFrom, dateTo]
  );

  const { data: ledgerItems = [], isLoading } = useQuery<StockLedgerItem[]>({
    queryKey: ["stock-ledger", filterParams],
    queryFn: () => inventoryApi.getStockLedger(filterParams),
  });

  const itemOptions = useMemo(
    () => [
      { value: "all", label: "All SKU Items" },
      ...catalog.map((c) => ({ value: c.id, label: `${c.code} - ${c.name}` })),
    ],
    [catalog]
  );

  const warehouseOptions = useMemo(
    () => [
      { value: "all", label: "All Warehouses" },
      ...warehouses.map((w) => ({ value: w.id, label: `${w.code} - ${w.name}` })),
    ],
    [warehouses]
  );

  const handleExport = () => {
    if (!ledgerItems || !ledgerItems.length) return;
    const headers = ["Posting Time", "Transaction Type", "Reference No", "Warehouse", "Item Code", "Item Name", "In Qty", "Out Qty", "Balance Qty"].join(",");
    const rows = ledgerItems.map((r) =>
      [`"${r.posting_time}"`, `"${r.transaction_type}"`, `"${r.reference_no}"`, `"${r.warehouse_name}"`, `"${r.item_code}"`, `"${r.item_name}"`, r.in_qty, r.out_qty, r.balance_qty].join(",")
    );
    const csvContent = "data:text/csv;charset=utf-8," + [headers, ...rows].join("\n");
    const link = document.createElement("a");
    link.setAttribute("href", encodeURI(csvContent));
    link.setAttribute("download", `stock_ledger_${new Date().toISOString().substring(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const getTagColor = (type: StockLedgerItem["transaction_type"]) => {
    switch (type) {
      case "GRN":
      case "Opening Stock":
      case "Return Inward":
        return "success";
      case "Sales Issue":
      case "Consumption":
      case "Return Outward":
        return "danger";
      case "Stock Transfer":
      case "Stock Adjustment":
        return "primary";
      default:
        return "default";
    }
  };

  const columns: Column<StockLedgerItem>[] = [
    {
      key: "posting_time",
      header: "Posting Date & Time",
      render: (r) => (
        <span className="mono text-xs font-semibold text-muted whitespace-nowrap">
          {r.posting_time}
        </span>
      ),
    },
    {
      key: "transaction_type",
      header: "Transaction Type",
      render: (r) => (
        <Chip size="sm" variant="flat" color={getTagColor(r.transaction_type)}>
          {r.transaction_type}
        </Chip>
      ),
    },
    {
      key: "reference_no",
      header: "Reference No",
      render: (r) => (
        <span className="mono font-bold text-xs text-brand hover:underline cursor-pointer">
          {r.reference_no}
        </span>
      ),
    },
    {
      key: "warehouse_name",
      header: "Warehouse",
      render: (r) => <span className="text-body font-medium">{r.warehouse_name}</span>,
    },
    {
      key: "item_code_name",
      header: "Item Code & Name",
      render: (r) => (
        <div>
          <div className="font-bold text-ink">{r.item_name}</div>
          <div className="mono font-mono text-[11px] text-muted">{r.item_code}</div>
        </div>
      ),
    },
    {
      key: "batch_number",
      header: "Batch Number",
      render: (r) => (
        <span className="mono text-xs bg-content2 px-2 py-0.5 rounded border border-line">
          {r.batch_number || "—"}
        </span>
      ),
    },
    {
      key: "in_qty",
      header: "In Qty (+)",
      render: (r) => (
        <span className={`tabular font-semibold ${r.in_qty > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-muted"}`}>
          {r.in_qty > 0 ? `+${r.in_qty.toLocaleString("en-IN", { minimumFractionDigits: 2 })}` : "—"}
        </span>
      ),
    },
    {
      key: "out_qty",
      header: "Out Qty (-)",
      render: (r) => (
        <span className={`tabular font-semibold ${r.out_qty > 0 ? "text-danger" : "text-muted"}`}>
          {r.out_qty > 0 ? `-${r.out_qty.toLocaleString("en-IN", { minimumFractionDigits: 2 })}` : "—"}
        </span>
      ),
    },
    {
      key: "balance_qty",
      header: "Running Balance",
      render: (r) => (
        <span className="tabular font-bold text-ink">
          {r.balance_qty.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
        </span>
      ),
    },
    {
      key: "unit_rate",
      header: "Unit Rate",
      render: (r) => (
        <span className="tabular text-body">
          ₹{r.unit_rate.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
        </span>
      ),
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
      key: "created_by",
      header: "User / Performed By",
      render: (r) => <span className="text-xs text-muted font-medium">{r.created_by}</span>,
    },
  ];

  return (
    <div className="space-y-6">
      {/* 2.1 Filter & Search Controls */}
      <div className="rounded-2xl border border-line bg-content1 p-4 shadow-sm space-y-4">
        <div className="flex items-center justify-between gap-2 border-b border-line pb-3">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-brand" />
            <h3 className="text-sm font-bold text-ink uppercase tracking-wider">
              Stock Ledger Search & Export
            </h3>
          </div>

          <Button variant="subtle" onClick={handleExport}>
            <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
            <Download className="h-3.5 w-3.5" /> Export Excel / CSV
          </Button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {/* Item Filter */}
          <div className="space-y-1">
            <label className="text-xs font-semibold text-muted">Item (SKU)</label>
            <Select options={itemOptions} value={itemId} onChange={(v) => setItemId(v)} />
          </div>

          {/* Warehouse Filter */}
          <div className="space-y-1">
            <label className="text-xs font-semibold text-muted">Warehouse</label>
            <Select options={warehouseOptions} value={warehouseId} onChange={(v) => setWarehouseId(v)} />
          </div>

          {/* Transaction Type Filter */}
          <div className="space-y-1">
            <label className="text-xs font-semibold text-muted">Transaction Type</label>
            <Select options={TRANSACTION_TYPES} value={txnType} onChange={(v) => setTxnType(v)} />
          </div>

          {/* Date From */}
          <div className="space-y-1">
            <label className="text-xs font-semibold text-muted">Start Date</label>
            <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </div>

          {/* Date To */}
          <div className="space-y-1">
            <label className="text-xs font-semibold text-muted">End Date</label>
            <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
        </div>
      </div>

      {/* 2.2 Stock Ledger Data Table with Horizontal Scrollbar */}
      <div className="w-full overflow-x-auto max-w-full rounded-2xl border border-line/70 bg-content1 shadow-xs">
        <div className="min-w-[1000px]">
          <ResponsiveList
            data={ledgerItems}
            columns={columns}
            loading={isLoading}
            keyOf={(r) => r.id}
            empty="No ledger transaction records match the selected filters."
            renderCard={(r) => (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="mono text-xs font-semibold text-brand">{r.reference_no}</span>
                  <Chip size="sm" variant="flat" color={getTagColor(r.transaction_type)}>
                    {r.transaction_type}
                  </Chip>
                </div>

                <div className="font-bold text-ink">{r.item_code} - {r.item_name}</div>

                <div className="grid grid-cols-2 gap-2 text-xs text-muted pt-1">
                  <div>
                    <span className="block">{r.posting_time}</span>
                    <span>Wh: {r.warehouse_name}</span>
                  </div>
                  <div className="text-right">
                    {r.in_qty > 0 && (
                      <span className="flex items-center justify-end gap-0.5 font-bold text-emerald-600">
                        <ArrowDownLeft className="h-3.5 w-3.5" /> +{r.in_qty}
                      </span>
                    )}
                    {r.out_qty > 0 && (
                      <span className="flex items-center justify-end gap-0.5 font-bold text-danger">
                        <ArrowUpRight className="h-3.5 w-3.5" /> -{r.out_qty}
                      </span>
                    )}
                    <span className="block font-semibold text-ink">Bal: {r.balance_qty}</span>
                  </div>
                </div>
              </div>
            )}
          />
        </div>
      </div>
    </div>
  );
}
