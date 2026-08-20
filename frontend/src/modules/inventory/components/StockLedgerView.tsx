import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Chip } from "@heroui/react";
import { ArrowDownLeft, ArrowUpRight, FileSpreadsheet } from "lucide-react";
import { Button, Card, PageHeader, ResponsiveGrid, ResponsiveList, StatCard, type Column } from "@/shared/components";
import { FilterBar, FilterSelect } from "./FilterBar";
import { DetailSheet, SheetRow, SheetSection } from "./DetailSheet";
import { UnitCell } from "./UnitsPanel";
import {
  getSerialSummary, getStockLedger, getStockLedgerSummary, getWarehouses, indexSerials,
} from "../api";
import type { SerialSummaryRow, StockLedgerItem } from "../types";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { fmtDate, fmtTime } from "@/shared/datetime";

/**
 * stk_ledger.ref_type — every value that actually reaches the table.
 *
 * The first five come from shared/enums.RefType; the rest are the warehouse module's
 * own WarehouseDocType, which move_stock() writes verbatim. Putaway lands as RECEIPT
 * (it is the goods-receipt document being put on a shelf) and a bin-to-bin stock
 * in/out lands as STOCK_MOVEMENT — without these rows the filter hid real movements.
 *
 * STO, PUTAWAY_ORDER and VEHICLE_ISSUE were missing even though they are three of the
 * six ref_types on the live ledger (VEHICLE_ISSUE alone is a third of all rows), so a
 * user filtering by document type simply could not see them.
 */
const REF_TYPES = [
  { value: "GRN", label: "Goods Receipt" },
  { value: "ISSUE", label: "Material Issue" },
  { value: "TRANSFER", label: "Stock Transfer" },
  { value: "STO", label: "Stock Transfer Order (STO)" },
  { value: "ADJUSTMENT", label: "Adjustment" },
  { value: "RESERVATION", label: "Reservation" },
  { value: "RECEIPT", label: "Receipt / Putaway" },
  { value: "PUTAWAY_ORDER", label: "Putaway Order" },
  { value: "STOCK_MOVEMENT", label: "Stock In / Out (bin move)" },
  { value: "WH_ISSUE", label: "Warehouse Issue" },
  { value: "VEHICLE_ISSUE", label: "Vehicle Issue" },
  { value: "DISPATCH", label: "Dispatch" },
  { value: "PURCHASE_RETURN", label: "Purchase Return" },
];

const DIRECTIONS = [
  { value: "IN", label: "Stock In (IN)" },
  { value: "OUT", label: "Stock Out (OUT)" },
];

/**
 * The ledger records movements that have already happened, so a future date can only
 * ever return nothing. Bounding the pickers stops the empty-result confusion rather
 * than explaining it after the fact. Local date, not toISOString() — that is UTC and
 * would offer tomorrow to anyone east of Greenwich.
 */
const TODAY = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
  .toISOString()
  .slice(0, 10);

/** Comma-safe CSV cell. Export is a plain Blob — no library for six columns. */
const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

/** Same rule as Stock Balance: a null rate is "not costed", never a confident ₹0. */
const money = (n?: number | null) =>
  n == null || n === 0
    ? <span className="text-muted">—</span>
    : `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

export function StockLedgerView() {
  const [params] = useSearchParams();
  const [search, setSearch] = useState("");
  const [itemId, setItemId] = useState(params.get("item_id") ?? "");
  const [warehouseId, setWarehouseId] = useState("");
  const [refType, setRefType] = useState("");
  const [direction, setDirection] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [dateTo, setDateTo] = useState("");
  const [selected, setSelected] = useState<StockLedgerItem | null>(null);

  // Opened from a stock row ("View movements") — honour the item it arrived with.
  useEffect(() => {
    const fromUrl = params.get("item_id");
    if (fromUrl) setItemId(fromUrl);
  }, [params]);

  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses"], queryFn: getWarehouses });

  const debouncedSearch = useDebouncedValue(search);

  const filters = {
    search: debouncedSearch, item_id: itemId, warehouse_id: warehouseId,
    ref_type: refType, direction, date_from: dateFrom, date_to: dateTo,
    page, size,
  };

  const { data, isLoading } = useQuery({
    queryKey: ["stock-ledger", filters],
    queryFn: () => getStockLedger(filters),
  });
  const rows = data?.items ?? [];
  const totalPages = data?.total ? Math.ceil(data.total / size) : 0;

  // Counted on the server across the whole filtered ledger. Summing `rows` summed the
  // open page, so "Movements 20 / In +423" at 20/page became "100 / +5,196" at 100 —
  // two different answers to the same question over 219 rows.
  const { page: _page, size: _size, ...summaryFilters } = filters;
  const { data: totals, isLoading: totalsLoading } = useQuery({
    queryKey: ["stock-ledger-summary", summaryFilters],
    queryFn: () => getStockLedgerSummary(summaryFilters),
  });
  const num = (n?: number) =>
    totalsLoading || n === undefined ? "—" : n.toLocaleString("en-IN");
  /** A signed total, but nothing moved is just 0: "+0" and "−0" read as a direction
   *  that was never taken. The sign belongs to a quantity, not to an empty filter. */
  const signed = (n: number | undefined, sign: string) =>
    totalsLoading || n === undefined ? "—"
      : n === 0 ? "0"
        : `${sign}${n.toLocaleString("en-IN")}`;

  // stk_ledger stores at most one serial per row, and older rows store none at all.
  // The units standing at that item + point are fetched for the page and merged, the
  // same way Stock Balance does it — see getSerialSummary.
  const { data: serialRows = [] } = useQuery({
    queryKey: ["ledger-serials", rows.map((r) => `${r.item_id}:${r.warehouse_id}`).join(",")],
    queryFn: () => getSerialSummary(rows.map((r) => r.item_id),
                                    rows.map((r) => r.warehouse_id)),
    enabled: rows.length > 0,
  });
  const serialsByRow = indexSerials(serialRows);
  const unitsOf = (r: StockLedgerItem) =>
    serialsByRow.get(`${r.item_id}:${r.warehouse_id}`);

  /** The serial to show for a row, or nothing.
   *
   *  A row that already carries an asset or consumable code is identified by THAT —
   *  it is the code putaway minted for the physical unit — and the serial beside it
   *  is the same unit named twice. Two identity columns saying one thing read as two
   *  different units, which is the opposite of what the ledger is opened for.
   *
   *  Returning undefined rather than "" so the callers below fall through to the
   *  serial summary in the usual way. */
  const serialOf = (r: StockLedgerItem) =>
    (r.asset_code || r.consumable_code) ? undefined : r.serial_number;

  /** Which lot a cell's popover should list the units of. A ledger row names an item
   *  at a point, not a bin, so the popover shows everything standing there. */
  const lotOf = (r: StockLedgerItem) => ({
    itemId: r.item_id,
    warehouseId: r.warehouse_id,
    itemCode: r.item_code,
    expected: unitsOf(r)?.count,
    label: r.warehouse_name,
  });

  const activeFilters = [search, itemId, warehouseId, refType, direction, dateFrom, dateTo].filter(Boolean).length;

  const clear = () => {
    setSearch(""); setItemId(""); setWarehouseId("");
    setRefType(""); setDirection(""); setDateFrom(""); setDateTo("");
    setPage(1);
  };

  const exportCsv = () => {
    const header = ["Date", "Reference", "Type", "Item Code", "Item", "Warehouse", "Batch",
                    "Serial / IMEI", "Asset Code", "Consumable Code",
                    "In", "Out", "Balance", "Rate", "Value", "By"];
    const body = rows.map((r) => [
      r.transaction_date, r.transaction_no, r.transaction_type, r.item_code, r.item_name,
      // A column each, and every value in it — not the one the cell has room for.
      r.warehouse_name, r.batch_number,
      serialOf(r) || unitsOf(r)?.serials.join(" | ") || unitsOf(r)?.imeis.join(" | "),
      r.asset_code || unitsOf(r)?.asset_codes?.join(" | "),
      r.consumable_code || unitsOf(r)?.consumable_codes?.join(" | "),
      r.in_qty, r.out_qty, r.balance_qty, r.unit_rate, r.total_value, r.performed_by,
    ]);
    const csv = [header, ...body].map((line) => line.map(cell).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `stock-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /** One of the two unit-code columns. The value comes off the ledger row when the
   *  movement recorded it; otherwise from the units standing at that item + point,
   *  filtered to this kind, with the popover listing the whole lot. */
  const codeColumn = (
    key: string,
    header: string,
    ownOf: (r: StockLedgerItem) => string | undefined,
    listOf: (u: SerialSummaryRow) => string[] | undefined,
    countOf: (u: SerialSummaryRow) => number | undefined,
  ): Column<StockLedgerItem> => ({
    key,
    header,
    hideOnNarrow: true,
    render: (r) => {
      const units = unitsOf(r);
      const own = ownOf(r);
      const codes = (units && listOf(units)) || [];
      return (
        <UnitCell
          text={own || codes[0]}
          extra={own || !codes.length ? 0 : ((units && countOf(units)) || codes.length) - 1}
          lot={!own && codes.length ? lotOf(r) : undefined}
          title={r.item_name}
        />
      );
    },
  });

  const columns: Column<StockLedgerItem>[] = [
    {
      key: "when",
      header: "Date",
      render: (r) => (
        <div>
          <div className="text-sm text-ink">{fmtDate(r.transaction_date)}</div>
          <div className="text-[11px] text-muted">{fmtTime(r.transaction_date)}</div>
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
      // Serial/IMEI or the asset/consumable code — the identity of the unit that
      // moved. Asked for on this screen because tracing one physical device through
      // its receipts and issues is the reason the ledger gets opened.
      key: "unit",
      header: "Serial / IMEI",
      hideOnNarrow: true,
      render: (r) => {
        const units = unitsOf(r);
        const serial = serialOf(r);
        return (
          <UnitCell
            text={serial || units?.serials[0] || units?.imeis[0]}
            extra={serial ? 0 : (units ? units.count - 1 : 0)}
            lot={units && !serial ? lotOf(r) : undefined}
            title={r.item_name}
          />
        );
      },
    },
    // A unit is an asset OR a consumable, never both, so the two codes get a column
    // each and a row only ever fills one of them. One shared column read as a single
    // identity that could be either kind, which is exactly what the ledger is opened
    // to tell apart.
    codeColumn("asset_code", "Asset Code",
               (r) => r.asset_code, (u) => u.asset_codes, (u) => u.asset_count),
    codeColumn("consumable_code", "Consumable Code",
               (r) => r.consumable_code,
               (u) => u.consumable_codes, (u) => u.consumable_count),
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
      key: "rate",
      header: "Rate",
      className: "text-right",
      hideOnNarrow: true,
      render: (r) => <span className="text-sm">{money(r.unit_rate)}</span>,
    },
    {
      key: "value",
      header: "Value",
      className: "text-right",
      hideOnNarrow: true,
      render: (r) => <span className="text-sm">{money(r.total_value)}</span>,
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
          <Button variant="primary" disabled={rows.length === 0} onClick={exportCsv}>
            <FileSpreadsheet size={14} /> Export CSV
          </Button>
        }
      />

      <ResponsiveGrid cols={3} className="mb-4">
        <StatCard label="Movements" value={num(totals?.movements)} />
        <StatCard label="Total In" value={signed(totals?.total_in, "+")} icon={<ArrowDownLeft size={16} />} tone="text-success" />
        <StatCard label="Total Out" value={signed(totals?.total_out, "−")} icon={<ArrowUpRight size={16} />} tone="text-danger" />
      </ResponsiveGrid>

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
          max={dateTo || TODAY}
          onChange={(e) => setDateFrom(e.target.value)}
          aria-label="From date"
          className="h-11 rounded-lg border border-line bg-content1 px-3 text-sm text-ink outline-none focus:border-brand"
        />
        <input
          type="date"
          value={dateTo}
          min={dateFrom || undefined}
          max={TODAY}
          onChange={(e) => setDateTo(e.target.value)}
          aria-label="To date"
          className="h-11 rounded-lg border border-line bg-content1 px-3 text-sm text-ink outline-none focus:border-brand"
        />
        <FilterSelect
          value={size.toString()}
          onChange={(val) => { setSize(Number(val)); setPage(1); }}
          placeholder="20 per page"
          options={[
            { value: "20", label: "20 per page" },
            { value: "50", label: "50 per page" },
            { value: "100", label: "100 per page" },
          ]}
        />
      </FilterBar>

      <Card className="p-2">
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          onRowClick={setSelected}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          // The serial/code lookup lands after the list — see ResponsiveList.revision.
          revision={`${serialRows.length}:${rows.length}`}
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
        footer={<Button variant="subtle" onClick={() => setSelected(null)}>Close</Button>}
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
            <SheetSection title="Value">
              <SheetRow label="Rate" value={money(selected.unit_rate)} />
              <SheetRow label="Movement value" value={money(selected.total_value)} />
            </SheetSection>
            <SheetSection title="Context">
              <SheetRow label="Item code" value={selected.item_code} />
              <SheetRow label="Serial / IMEI" value={selected.serial_number} />
              <SheetRow label="Asset code" value={selected.asset_code} />
              <SheetRow label="Consumable code" value={selected.consumable_code} />
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
