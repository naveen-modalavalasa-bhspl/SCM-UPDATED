import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Chip } from "@heroui/react";
import { ArrowDownLeft, ArrowUpRight, Download, History } from "lucide-react";
import {
  Button, Card, KpiTiles, PageHeader, ResponsiveList, type Column, type KpiTileSpec,
} from "@/shared/components";
import { FilterBar, FilterSelect } from "./FilterBar";
import { DetailSheet, SheetRow, SheetSection } from "./DetailSheet";
import { UnitCell } from "./UnitsPanel";
import {
  getSerialSummary, getStockLedger, getStockLedgerSummary, getUnitCodes, getWarehouses,
  indexSerials, indexUnitCodes, unitCodeKey, unplaced,
} from "../api";
import type { SerialSummaryRow, StockLedgerItem, UnitCodeRow } from "../types";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { fmtDate, fmtTime } from "@/shared/datetime";
import { TONE_BLUE } from "@/shared/components/tones";

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
/** What the count line under a ledger cell calls the units it is showing.
 *
 * Deliberately NOT "units in lot" (2026-08-22). A stock row lists what is standing on
 * a shelf; a ledger row lists what MOVED, and the two are different sets that were
 * being read as one — an issue of 2 said "198 units in lot" beside its own two
 * serials. The wording is half the fix; the other half is that the numbers now come
 * off the movement. */
const MOVEMENT_CAPTION = "units in this movement";

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
  /** The units behind one ledger row.
   *
   *  FIXED 2026-08-21 — this asked for `item:warehouse` only, and `indexSerials`
   *  files a row under that short key ONLY when its units are unplaced (no bin, no
   *  batch). Every unit that has actually been put away is filed under the full
   *  `item:warehouse:bin:batch`, so the lookup missed every one of them and the
   *  Serial / IMEI and Asset Code columns showed a dash for stock whose units were
   *  sitting correctly coded one table away.
   *
   *  Most specific first, exactly as Stock Balance does it: the row's own bin and
   *  batch, then the bin alone, then the point. Falling back that way is what lets a
   *  movement whose lot has since been emptied still name what it carried, without
   *  handing one lot another lot's units. */
  const lotOfRow = (r: StockLedgerItem) =>
    serialsByRow.get(`${r.item_id}:${r.warehouse_id}:${unplaced(r.bin_id)}:${unplaced(r.batch_id)}`)
    ?? serialsByRow.get(`${r.item_id}:${r.warehouse_id}:${unplaced(r.bin_id)}`)
    ?? serialsByRow.get(`${r.item_id}:${r.warehouse_id}`);

  /** The units THIS MOVEMENT carried, straight off `stk_ledger.serial_numbers`. */
  const movedUnits = (r: StockLedgerItem) => r.serial_numbers ?? [];

  /** The codes those units carry, looked up in the warehouse module.
   *
   *  NEW 2026-08-22. `list_movements` can only reach `stk_balance` for a code, which
   *  is one code for a whole LOT — so a serial-tracked movement arrived with nothing
   *  in its code columns and the screen filled them from the lot summary below. Asked
   *  for once per page, over the units the page actually names. */
  const { data: codeRows = [] } = useQuery({
    queryKey: ["ledger-unit-codes", rows.flatMap(movedUnits).join(",")],
    queryFn: () => getUnitCodes(rows.flatMap(movedUnits)),
    enabled: rows.some((r) => movedUnits(r).length > 0),
  });
  const codeByUnit = indexUnitCodes(codeRows);

  /** Does this row name its own units?
   *
   *  THE question the whole cell hangs on (2026-08-22). A row that names them is a
   *  record of what MOVED and must be read from that list alone. A row that does not
   *  — every ledger line written before `serial_numbers` was mapped — has nothing but
   *  the lot behind it, and the lot summary stays its best available answer.
   *
   *  Mixing the two is the defect this fixes: an issue of 2 mice showed its own two
   *  serials beside "198 units in lot", because the serials came off the movement and
   *  the codes came off the shelf as it stands today. Two columns of one row,
   *  answering two different questions, reading as one fact. */
  const namesOwnUnits = (r: StockLedgerItem) => movedUnits(r).length > 0;

  /** The lot summary, but ONLY for a row that cannot speak for itself. */
  const unitsOf = (r: StockLedgerItem) =>
    (namesOwnUnits(r) ? undefined : lotOfRow(r));

  /** One kind of code for the units this movement carried, in the order it carried
   *  them. Empty for a row that names no units, which falls back to the lot. */
  const movedCodes = (r: StockLedgerItem, pick: (u: UnitCodeRow) => string | null) =>
    movedUnits(r)
      .map((unit) => {
        // Keyed on the row's ITEM as well as the identity: a serial is not unique
        // across items in the live data, and a bare identity lookup handed a mouse
        // the monitor's asset code. See `indexUnitCodes`.
        const u = codeByUnit.get(unitCodeKey(r.item_id, unit));
        return u ? pick(u) : null;
      })
      .filter(Boolean) as string[];

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

  /** Which lot a cell's popover should list the units of.
   *
   *  DOWN TO THE BIN AND THE BATCH (2026-09-03). This asked for item + point only, on
   *  the reasoning that "a ledger row names an item at a point, not a bin" — but the
   *  row carries `bin_id` and `batch_id` and has since 2026-08-21, and the count beside
   *  the cell is already keyed on them by `lotOfRow`. Two putaways of one GRN into two
   *  bins therefore opened the SAME query: both panels listed every unit of that item
   *  at that warehouse, newest first, so both showed the second putaway's units and the
   *  first putaway's 10,000 could not be reached from the row that made them. The count
   *  said 10,000 and the list was somebody else's 10,000.
   *
   *  Narrowed on the same rule `unplaced` uses, because it has to agree with the count
   *  beside it: `NO_BIN` and `NO_BATCH` are both 0, so a falsy value means "this row
   *  names no bin / no batch" and must be left OFF the query rather than sent as 0. */
  const lotOf = (r: StockLedgerItem) => ({
    itemId: r.item_id,
    warehouseId: r.warehouse_id,
    binId: r.bin_id || undefined,
    batchId: r.batch_id || undefined,
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
      // The movement's own units first — the export must say the same thing the
      // screen does, and the screen no longer borrows the lot's units for a row that
      // names its own.
      (namesOwnUnits(r) ? movedUnits(r).join(" | ") : "")
        || serialOf(r) || unitsOf(r)?.serials.join(" | ") || unitsOf(r)?.imeis.join(" | "),
      movedCodes(r, (u) => u.asset_code).join(" | ")
        || (r.asset_code && r.unit_codes?.join(" | "))
        || r.asset_code || unitsOf(r)?.asset_codes?.join(" | "),
      movedCodes(r, (u) => u.consumable_code).join(" | ")
        || (r.consumable_code && r.unit_codes?.join(" | "))
        || r.consumable_code || unitsOf(r)?.consumable_codes?.join(" | "),
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
    /** The same kind of code, read off ONE unit — used for the units the movement
     *  itself carried, which is the answer this column should give whenever the row
     *  has one. */
    mine: (u: UnitCodeRow) => string | null,
  ): Column<StockLedgerItem> => ({
    key,
    header,
    hideOnNarrow: true,
    render: (r) => {
      // The units this movement carried, if it named any: their codes, and no others.
      // `ownCodes` is the same answer for an item that is not serial-tracked, where
      // the unit code is the identity and arrives on the row itself — the column that
      // owns them is the one whose single code the row filled in.
      const moved = movedCodes(r, mine).length ? movedCodes(r, mine)
        : (ownOf(r) && r.unit_codes?.length ? r.unit_codes : []);
      if (moved.length) {
        return (
          <UnitCell
            units={moved}
            caption={MOVEMENT_CAPTION}
            listTitle={header}
            title={r.item_name}
          />
        );
      }
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
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-050 font-display text-sm font-bold text-brand"
          >
            {(r.item_name.charAt(0) || "?").toUpperCase()}
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-ink">{r.item_name}</div>
            <div className="font-mono text-[11px] text-muted">{r.item_code}</div>
          </div>
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
        // A movement that names its units lists exactly those — one per line moved,
        // in order, with the rest a click away. It used to render them as one long
        // comma-joined string that the cell then truncated to the first two.
        if (namesOwnUnits(r)) {
          return (
            <UnitCell
              units={movedUnits(r)}
              caption={MOVEMENT_CAPTION}
              listTitle="Serial / IMEI"
              title={r.item_name}
            />
          );
        }
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
               (r) => r.asset_code, (u) => u.asset_codes, (u) => u.asset_count,
               (u) => u.asset_code),
    codeColumn("consumable_code", "Consumable Code",
               (r) => r.consumable_code,
               (u) => u.consumable_codes, (u) => u.consumable_count,
               (u) => u.consumable_code),
    {
      key: "in",
      header: "In",
      className: "text-right",
      render: (r) => (r.in_qty
        ? <span className="inline-block rounded-md bg-ok-bg px-2 py-0.5 font-semibold tabular text-ok">+{r.in_qty}</span>
        : <span className="text-muted">—</span>),
    },
    {
      key: "out",
      header: "Out",
      className: "text-right",
      render: (r) => (r.out_qty
        ? <span className="inline-block rounded-md bg-bad-bg px-2 py-0.5 font-semibold tabular text-bad">−{r.out_qty}</span>
        : <span className="text-muted">—</span>),
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
        // ghost + 16px icon, the app-wide header-action shape. See StockBalanceView.
        actions={
          <Button className={TONE_BLUE} variant="ghost" disabled={rows.length === 0} onClick={exportCsv}>
            <Download className="h-4 w-4" /> Export CSV
          </Button>
        }
      />

      {/* Each tile IS the direction filter it counts: In and Out set `direction`,
          Movements is the unfiltered whole and clears it. Pressing the tile already on
          clears it too, so the strip can never show a state the register is not in. */}
      <KpiTiles label="Movement totals" className="mb-4" tiles={[
        {
          key: "movements", label: "Movements", value: num(totals?.movements),
          icon: History, tone: "brand", active: direction === "",
          hint: "Every movement, in and out. Press to clear the direction filter.",
          onPress: () => { setDirection(""); setPage(1); },
        },
        {
          key: "in", label: "Total in", value: signed(totals?.total_in, "+"),
          icon: ArrowDownLeft, tone: "ok", active: direction === "IN",
          onPress: () => { setDirection((on) => (on === "IN" ? "" : "IN")); setPage(1); },
        },
        {
          key: "out", label: "Total out", value: signed(totals?.total_out, "−"),
          icon: ArrowUpRight, tone: "bad", active: direction === "OUT",
          onPress: () => { setDirection((on) => (on === "OUT" ? "" : "OUT")); setPage(1); },
        },
      ] satisfies KpiTileSpec[]} />

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
          className="h-11 rounded-xl border border-line/60 bg-content1 px-3 text-sm text-ink shadow-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/25"
        />
        <input
          type="date"
          value={dateTo}
          min={dateFrom || undefined}
          max={TODAY}
          onChange={(e) => setDateTo(e.target.value)}
          aria-label="To date"
          className="h-11 rounded-xl border border-line/60 bg-content1 px-3 text-sm text-ink shadow-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/25"
        />
        <FilterSelect
          value={size.toString()}
          onChange={(val) => { setSize(Number(val)); setPage(1); }}
          placeholder="20 per page"
          // A page size must always hold a value: the shared pill offers a "Show all"
          // row by default, and picking it here set the size to "" -> Number("") -> 0.
          allowEmpty={false}
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
                {r.in_qty > 0 && <span className="rounded-md bg-ok-bg px-2 py-0.5 font-semibold text-ok">+{r.in_qty}</span>}
                {r.out_qty > 0 && <span className="rounded-md bg-bad-bg px-2 py-0.5 font-semibold text-bad">−{r.out_qty}</span>}
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
              {/* FIXED 2026-08-21 — these read the ledger row's own columns and nothing
                * else, so a movement whose units live on `whs_serial_numbers` — which
                * is every put-away lot — showed a dash here while the TABLE behind the
                * sheet named them correctly through `unitsOf`. Two views of one row
                * disagreeing is worse than either being blank. Same lookup, same
                * fallback, so the sheet can never say less than the row it opened
                * from. `serial_numbers` (plural) is the ledger's own column; the
                * singular one this used never existed on the wire. */}
              {/* Same order of preference as the table, so the sheet can never say
                * something the row it opened from does not. */}
              <SheetRow
                label="Serial / IMEI"
                value={movedUnits(selected).join(", ")
                  || selected.serial_number
                  || unitsOf(selected)?.serials.join(", ")
                  || unitsOf(selected)?.imeis.join(", ")}
              />
              <SheetRow
                label="Asset code"
                value={movedCodes(selected, (u) => u.asset_code).join(", ")
                  || (selected.asset_code && selected.unit_codes?.join(", "))
                  || selected.asset_code
                  || unitsOf(selected)?.asset_codes?.join(", ")}
              />
              <SheetRow
                label="Consumable code"
                value={movedCodes(selected, (u) => u.consumable_code).join(", ")
                  || (selected.consumable_code && selected.unit_codes?.join(", "))
                  || selected.consumable_code
                  || unitsOf(selected)?.consumable_codes?.join(", ")}
              />
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
