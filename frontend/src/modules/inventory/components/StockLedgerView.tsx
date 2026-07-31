import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Chip } from "@heroui/react";
import { ArrowDownLeft, ArrowUpRight, FileSpreadsheet } from "lucide-react";
import { Button, Card, PageHeader, ResponsiveList, StatCard, type Column } from "@/shared/components";
import { FilterBar, FilterSelect } from "./FilterBar";
import { DetailSheet, SheetRow, SheetSection } from "./DetailSheet";
import { getStockLedger, getWarehouses } from "../api";
import type { StockLedgerItem } from "../types";

/**
 * stk_ledger.ref_type — every value that actually reaches the table.
 *
 * The first five come from shared/enums.RefType; the rest are the warehouse module's
 * own WarehouseDocType, which move_stock() writes verbatim. Putaway lands as RECEIPT
 * (it is the goods-receipt document being put on a shelf) and a bin-to-bin stock
 * in/out lands as STOCK_MOVEMENT — without these rows the filter hid real movements.
 */
const REF_TYPES = [
  { value: "GRN", label: "Goods Receipt" },
  { value: "ISSUE", label: "Material Issue" },
  { value: "TRANSFER", label: "Stock Transfer" },
  { value: "ADJUSTMENT", label: "Adjustment" },
  { value: "RESERVATION", label: "Reservation" },
  { value: "RECEIPT", label: "Receipt / Putaway" },
  { value: "STOCK_MOVEMENT", label: "Stock In / Out (bin move)" },
  { value: "WH_ISSUE", label: "Warehouse Issue" },
  { value: "DISPATCH", label: "Dispatch" },
  { value: "PURCHASE_RETURN", label: "Purchase Return" },
];

const DIRECTIONS = [
  { value: "IN", label: "Stock In (IN)" },
  { value: "OUT", label: "Stock Out (OUT)" },
];

/** Comma-safe CSV cell. Export is a plain Blob — no library for six columns. */
const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

export function StockLedgerView() {
  const [params] = useSearchParams();
  const [search, setSearch] = useState("");
  const [itemId, setItemId] = useState(params.get("item_id") ?? "");
  const [warehouseId, setWarehouseId] = useState("");
  const [refType, setRefType] = useState("");
  const [direction, setDirection] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [selected, setSelected] = useState<StockLedgerItem | null>(null);

  // Opened from a stock row ("View movements") — honour the item it arrived with.
  useEffect(() => {
    const fromUrl = params.get("item_id");
    if (fromUrl) setItemId(fromUrl);
  }, [params]);

  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses"], queryFn: getWarehouses });

  const filters = {
    search, item_id: itemId, warehouse_id: warehouseId,
    ref_type: refType, direction, date_from: dateFrom, date_to: dateTo,
  };

  const { data, isLoading } = useQuery({
    queryKey: ["stock-ledger", filters],
    queryFn: () => getStockLedger(filters),
  });
  const rows = data?.items ?? [];

  const totals = useMemo(() => {
    let inQty = 0, outQty = 0;
    rows.forEach((r) => { inQty += r.in_qty; outQty += r.out_qty; });
    return { inQty, outQty, net: inQty - outQty };
  }, [rows]);

  const activeFilters = [search, itemId, warehouseId, refType, direction, dateFrom, dateTo].filter(Boolean).length;

  const clear = () => {
    setSearch(""); setItemId(""); setWarehouseId("");
    setRefType(""); setDirection(""); setDateFrom(""); setDateTo("");
  };

  const exportCsv = () => {
    const header = ["Date", "Reference", "Type", "Item Code", "Item", "Warehouse", "Batch", "In", "Out", "Balance", "By"];
    const body = rows.map((r) => [
      r.transaction_date, r.transaction_no, r.transaction_type, r.item_code, r.item_name,
      r.warehouse_name, r.batch_number, r.in_qty, r.out_qty, r.balance_qty, r.performed_by,
    ]);
    const csv = [header, ...body].map((line) => line.map(cell).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `stock-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const columns: Column<StockLedgerItem>[] = [
    {
      key: "when",
      header: "Date",
      render: (r) => (
        <div>
          <div className="text-sm text-ink">{new Date(r.transaction_date).toLocaleDateString()}</div>
          <div className="text-[11px] text-muted">{new Date(r.transaction_date).toLocaleTimeString()}</div>
        </div>
      ),
    },
    {
      key: "ref",
      header: "Reference",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-ink">{r.transaction_no}</div>
          <Chip size="sm" variant="flat">{r.transaction_type || "—"}</Chip>
        </div>
      ),
    },
    {
      key: "item",
      header: "Item",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-ink">{r.item_name}</div>
          <div className="font-mono text-[11px] text-muted">{r.item_code}</div>
        </div>
      ),
    },
    {
      key: "where",
      header: "Warehouse / Batch",
      hideOnNarrow: true,
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-body">{r.warehouse_name}</div>
          <div className="font-mono text-[11px] text-muted">{r.batch_number || "—"}</div>
        </div>
      ),
    },
    {
      key: "in",
      header: "In",
      className: "text-right",
      render: (r) => (r.in_qty ? <span className="font-semibold text-success">+{r.in_qty}</span> : <span className="text-muted">—</span>),
    },
    {
      key: "out",
      header: "Out",
      className: "text-right",
      render: (r) => (r.out_qty ? <span className="font-semibold text-danger">−{r.out_qty}</span> : <span className="text-muted">—</span>),
    },
    {
      key: "balance",
      header: "Balance After",
      className: "text-right",
      render: (r) => <span className="font-medium text-ink">{r.balance_qty} <span className="text-[11px] text-muted">{r.uom_code}</span></span>,
    },
    {
      key: "by",
      header: "By",
      hideOnNarrow: true,
      render: (r) => <span className="text-sm text-body">{r.performed_by || "—"}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title="Stock Ledger"
        actions={
          <Button variant="ghost" disabled={rows.length === 0} onClick={exportCsv}>
            <FileSpreadsheet size={14} /> Export CSV
          </Button>
        }
      />

      <div className="mb-4 grid grid-cols-3 gap-3">
        <StatCard label="Movements" value={rows.length} />
        <StatCard label="Total In" value={`+${totals.inQty.toLocaleString("en-IN")}`} icon={<ArrowDownLeft size={16} />} tone="text-success" />
        <StatCard label="Total Out" value={`−${totals.outQty.toLocaleString("en-IN")}`} icon={<ArrowUpRight size={16} />} tone="text-danger" />
      </div>

      <FilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search item, reference or batch…"
        onClear={clear}
        active={activeFilters}
      >
        <FilterSelect
          value={warehouseId}
          onChange={setWarehouseId}
          placeholder="All warehouses"
          options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
        />
        <FilterSelect value={refType} onChange={setRefType} placeholder="All document types" options={REF_TYPES} />
        <FilterSelect value={direction} onChange={setDirection} placeholder="In and out" options={DIRECTIONS} />
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          aria-label="From date"
          className="h-11 rounded-lg border border-line bg-content1 px-3 text-sm text-ink outline-none focus:border-brand"
        />
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          aria-label="To date"
          className="h-11 rounded-lg border border-line bg-content1 px-3 text-sm text-ink outline-none focus:border-brand"
        />
      </FilterBar>

      <Card className="p-2">
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          onRowClick={setSelected}
          empty={activeFilters ? "No movements match these filters." : "No stock movements recorded yet."}
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold text-ink">{r.item_name}</span>
                <Chip size="sm" variant="flat">{r.transaction_type}</Chip>
              </div>
              <div className="font-mono text-[11px] text-muted">{r.transaction_no}</div>
              <div className="flex gap-4 text-sm">
                {r.in_qty > 0 && <span className="text-success">+{r.in_qty}</span>}
                {r.out_qty > 0 && <span className="text-danger">−{r.out_qty}</span>}
                <span className="text-muted">Balance {r.balance_qty}</span>
              </div>
              <div className="text-[11px] text-muted">
                {new Date(r.transaction_date).toLocaleString()} · {r.warehouse_name}
              </div>
            </div>
          )}
        />
      </Card>

      <DetailSheet
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.item_name ?? ""}
        subtitle={selected?.transaction_no}
        badge={selected && <Chip size="sm" variant="flat">{selected.transaction_type}</Chip>}
        footer={<Button variant="ghost" onClick={() => setSelected(null)}>Close</Button>}
      >
        {selected && (
          <>
            <SheetSection title="Movement">
              <SheetRow label="Direction" value={selected.in_qty > 0 ? "IN — receipt" : "OUT — issue"} />
              <SheetRow label="Quantity" value={`${selected.in_qty || selected.out_qty} ${selected.uom_code}`} />
              <SheetRow label="Balance after" value={`${selected.balance_qty} ${selected.uom_code}`} />
              <SheetRow label="When" value={new Date(selected.transaction_date).toLocaleString()} />
              <SheetRow label="By" value={selected.performed_by} />
            </SheetSection>
            <SheetSection title="Context">
              <SheetRow label="Item code" value={selected.item_code} />
              <SheetRow label="Warehouse" value={selected.warehouse_name} />
              <SheetRow label="Batch" value={selected.batch_number} />
              <SheetRow label="Source document" value={selected.reference_no} />
            </SheetSection>
          </>
        )}
      </DetailSheet>
    </div>
  );
}
