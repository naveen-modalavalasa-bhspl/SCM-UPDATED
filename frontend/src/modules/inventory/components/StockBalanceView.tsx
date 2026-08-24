import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Chip } from "@heroui/react";
import { Boxes, Layers, TriangleAlert, CalendarClock, Tag as TagIcon, Download, MapPin, ScanLine, X } from "lucide-react";
import {
  Button, Card, KpiTiles, PageHeader, ResponsiveGrid, ResponsiveList,
  type Column, type KpiTileSpec,
} from "@/shared/components";
import { FilterBar, FilterSelect, FilterToggle, FilterSelect as FilterMenu,
} from "./FilterBar";
import { DetailSheet, SheetRow, SheetSection } from "./DetailSheet";
import { UnitCell, UnitsPanel } from "./UnitsPanel";
import {
  getSerialSummary, getStockBalances, getStockDetail, getStockSummary, getWarehouses,
  indexSerials, lookupUnit, unplaced,
} from "../api";
import type { StockBalanceItem, StockDetail, StockLot } from "../types";
import { useDebouncedValue } from "../hooks/useDebouncedValue";

/** Value columns read off stk_balance.valuation_rate / stock_value. Both are 0 across
 *  the live data, so an uncosted row says so rather than printing a confident ₹0.00. */
const money = (n?: number) =>
  !n ? <span className="text-muted">Not costed</span> : `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

const qty = (n: number, uom?: string) => `${n.toLocaleString("en-IN")}${uom ? ` ${uom}` : ""}`;

/** What to print for a lot's unit of measure. `uom_code` is the identity every stored
 *  document is keyed on, so it is never renamed; the six oldest masters just happen to
 *  carry their prefix inside it, which read as "12 UOM-GMS". The name says "GMS". */
const uomOf = (r: { uom_name?: string | null; uom_code?: string }) => r.uom_name || r.uom_code;

const daysTo = (d?: string) =>
  d ? Math.ceil((new Date(d).getTime() - Date.now()) / 86_400_000) : null;

function stockState(r: StockBalanceItem) {
  const left = daysTo(r.expiry_date);
  if (r.available_qty <= 0) return { label: "Out of stock", color: "danger" as const };
  if (left !== null && left <= 30) return { label: `Expires in ${left}d`, color: "warning" as const };
  if (r.reorder_level > 0 && r.available_qty < r.reorder_level)
    return { label: "Below reorder", color: "warning" as const };
  return { label: "In stock", color: "success" as const };
}

/** Colored initial tile, so rows scan by shape before they read by name. */
const TILE_TONES = [
  "bg-brand-050 text-brand",
  "bg-ok-bg text-ok",
  "bg-warn-bg text-warn",
  "bg-info-bg text-info",
];
function ItemTile({ name }: { name: string }) {
  const tone = TILE_TONES[(name.charCodeAt(0) || 0) % TILE_TONES.length];
  return (
    <span
      aria-hidden
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg font-display text-sm font-bold ${tone}`}
    >
      {(name.charAt(0) || "?").toUpperCase()}
    </span>
  );
}

/** How much of what is on the shelf is free vs spoken for. Render-only picture of
 *  available/(available+reserved); no number here is new. */
function LevelBar({ r }: { r: StockBalanceItem }) {
  const total = r.available_qty + r.reserved_qty;
  if (total <= 0) return null;
  const freePct = Math.round((r.available_qty / total) * 100);
  return (
    <div className="mt-1 flex h-1.5 w-20 overflow-hidden rounded-full bg-content2" aria-hidden>
      <div className="bg-brand transition-all" style={{ width: `${freePct}%` }} />
      {r.reserved_qty > 0 && <div className="bg-warn" style={{ width: `${100 - freePct}%` }} />}
    </div>
  );
}

/** Expiry as a coloured chip — red gone, amber close, quiet otherwise. */
function ExpiryChip({ date }: { date?: string }) {
  const left = daysTo(date);
  if (!date) return <span className="text-[11px] text-muted">No expiry</span>;
  const color = left !== null && left <= 0 ? "danger" : left !== null && left <= 30 ? "warning" : "default";
  return (
    <Chip size="sm" variant="flat" color={color}>
      {date}
    </Chip>
  );
}

const EXPIRY_WINDOWS = [
  { value: "30", label: "Expiring in next 30 days" },
  { value: "60", label: "Expiring in next 60 days" },
  { value: "90", label: "Expiring in next 90 days" },
  { value: "expired", label: "Already Expired" },
  { value: "expired_30", label: "Expired in last 30 days" },
  { value: "expired_60", label: "Expired in last 60 days" },
  { value: "expired_90", label: "Expired in last 90 days" },
  { value: "custom", label: "Custom Date Range" },
];

/** Warehouse › zone › rack › bin. Wraps rather than scrolls: a deep tree still reads. */
function LocationPath({ path }: { path: (string | undefined)[] }) {
  const parts = path.filter(Boolean) as string[];
  if (!parts.length) return <p className="text-sm text-muted">Location unknown</p>;
  return (
    <div className="flex flex-wrap items-center gap-1 py-1">
      {parts.map((p, i) => (
        <span key={`${p}-${i}`} className="flex items-center gap-1">
          {i > 0 && <span className="text-muted">›</span>}
          <span
            className={
              i === parts.length - 1
                ? "rounded-md bg-brand/10 px-2 py-0.5 text-sm font-semibold text-brand"
                : "text-sm text-body"
            }
          >
            {p}
          </span>
        </span>
      ))}
    </div>
  );
}

function LotCard({ lot, uom }: { lot: StockLot; uom?: string }) {
  const left = lot.days_to_expiry;
  return (
    <div className="rounded-lg border border-line/70 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-ink">{lot.batch_no || "No batch"}</div>
          <div className="text-[11px] text-muted">
            {lot.expiry_date ? `Expires ${lot.expiry_date}` : "No expiry"}
            {lot.project_name ? ` · ${lot.project_name}` : ""}
          </div>
        </div>
        {left !== null && left !== undefined && (
          <Chip size="sm" variant="flat" color={left <= 0 ? "danger" : left <= 30 ? "warning" : "default"}>
            {left <= 0 ? "Expired" : `${left}d left`}
          </Chip>
        )}
      </div>
      <LocationPath path={lot.location_path} />
      <div className="flex gap-4 text-sm">
        <span>Available <strong className="text-ink">{lot.available_qty.toLocaleString("en-IN")}</strong> {uom}</span>
        {lot.reserved_qty > 0 && <span className="text-warning">Reserved {lot.reserved_qty}</span>}
      </div>
      {lot.asset_code && (
        <div className="mt-1 font-mono text-[11px] text-muted">{lot.asset_code}</div>
      )}
    </div>
  );
}

export function StockBalanceView() {
  const navigate = useNavigate();
  // Seeded from the URL so Stocking Points can hand off "show me what is at THIS
  // point" without the reader re-picking a warehouse out of a thousand-row dropdown.
  // Read once, as the initial value — after that the filter is the user's, and
  // re-syncing it would fight every change they make.
  const [params] = useSearchParams();
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [search, setSearch] = useState("");
  const [warehouseId, setWarehouseId] = useState(params.get("warehouse_id") ?? "");
  const [expiringIn, setExpiringIn] = useState("");
  const [expiryFrom, setExpiryFrom] = useState("");
  const [expiryTo, setExpiryTo] = useState("");
  /* What the grid is showing. Was a single "Include zero / fully reserved" toggle,
     which asked two questions at once and answered neither: "there is none left" and
     "there is some but it is all committed" are different problems with different
     fixes, and the toggle lumped them together with the ordinary rows. */
  const [stockView, setStockView] = useState("");
  const [belowReorder, setBelowReorder] = useState(false);
  const [selected, setSelected] = useState<StockBalanceItem | null>(null);

  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses"], queryFn: getWarehouses });

  // Dismissed by hand: after "found it, that one is in BIN-A2" the banner has done its
  // job, and it should not need the search cleared to go away.
  const [hitDismissed, setHitDismissed] = useState(false);

  // Opened only when a row is clicked: the lots and the walk down the location tree
  // are a second query, so the list itself stays one cheap page of stk_balance.
  const { data: detail, isLoading: detailLoading } = useQuery<StockDetail>({
    queryKey: ["stock-detail", selected?.id],
    queryFn: () => getStockDetail(selected!.id),
    enabled: !!selected,
  });

  const debouncedSearch = useDebouncedValue(search);

  // Is the text in the search box the identity of ONE unit? The list search matches
  // item, batch and bin; a serial, an IMEI or an asset code names a single physical
  // thing, and the answer to it is "it is in this bin", not a page of lots. Asked in
  // parallel with the list, so neither waits for the other.
  const { data: unitHit } = useQuery({
    queryKey: ["unit-lookup", debouncedSearch],
    queryFn: () => lookupUnit(debouncedSearch),
    // Six characters and no spaces: a serial, an IMEI and a code are all single
    // tokens, so "face mask" is not worth a lookup.
    enabled: debouncedSearch.trim().length >= 6 && !/\s/.test(debouncedSearch.trim()),
  });

  const listFilters = {
    search: debouncedSearch,
    warehouse_id: warehouseId,
    expiring_in_days: ["30", "60", "90"].includes(expiringIn) ? Number(expiringIn) : undefined,
    expiry_status: expiringIn === "expired" ? "expired" : undefined,
    expired_in_last_days: expiringIn.startsWith("expired_") ? Number(expiringIn.split("_")[1]) : undefined,
    expiry_from: expiringIn === "custom" ? expiryFrom : undefined,
    expiry_to: expiringIn === "custom" ? expiryTo : undefined,
    stock_view: stockView || undefined,
    below_reorder: belowReorder,
    page,
    size,
  };

  // A serial or an IMEI is not text on any stk_balance column, so searching one left
  // the grid empty under a banner that had just said where the unit was. When the
  // lookup resolves, the LIST is asked for that unit's item at that point instead —
  // "where is this thing" answered by the lot that holds it.
  const filters = unitHit
    ? { ...listFilters, search: "", item_id: unitHit.item_id,
        warehouse_id: unitHit.warehouse_id ?? listFilters.warehouse_id }
    : listFilters;

  const { data, isLoading } = useQuery({
    queryKey: ["stock-balance", filters],
    queryFn: () => getStockBalances(filters),
  });
  const rows = data?.items ?? [];
  const totalPages = data?.total ? Math.ceil(data.total / size) : 0;

  // The tiles are counted on the server over every matching row. Summing `rows` here
  // summed one page: at 20/page the screen claimed 20 stock lines and 11 items over
  // a 90-row dataset, and the numbers moved whenever the page size changed.
  // `page`/`size` are deliberately left out of the key so paging does not refetch it.
  const { page: _page, size: _size, ...summaryFilters } = filters;
  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ["stock-summary", summaryFilters],
    queryFn: () => getStockSummary(summaryFilters),
  });
  // `undefined`, not "—", while the count is in flight: the KPI strip draws a skeleton
  // for undefined and an em dash only when the request actually FAILED, and those are
  // different things to tell a reader. 0 stays 0 — a real answer, never a blank.
  const stat = (n?: number) =>
    summaryLoading || n === undefined ? undefined : n.toLocaleString("en-IN");

  // Per-unit identity for the rows on screen. A balance row is a LOT, and its single
  // serial_number column cannot hold the 88 units a lot can contain, so the codes are
  // fetched for the page and merged. Keyed on the page's rows, so paging refetches.
  const { data: serialRows = [] } = useQuery({
    queryKey: ["stock-serials", rows.map((r) => `${r.item_id}:${r.warehouse_id}`).join(",")],
    queryFn: () => getSerialSummary(rows.map((r) => r.item_id),
                                    rows.map((r) => r.warehouse_id)),
    enabled: rows.length > 0,
  });
  const serialsByRow = indexSerials(serialRows);

  /** The serial to show for a lot, or nothing.
   *
   *  FIXED 2026-08-21 — both readers below fell back to `r.serial_number` when the
   *  serial summary had none, and for an UNSERIALISED lot that column holds the asset
   *  or consumable code: `warehouse._place_unit_codes` writes the one string into both,
   *  because `whs_serial_numbers.serial_number` is UNIQUE and NOT NULL. So the code
   *  appeared under "Serial / IMEI" and again in the Codes column beside it, and one
   *  lot read as two identities.
   *
   *  The summary endpoint is already right (`warehouse.serial_summary` keeps a serial
   *  only for a serial-tracked item), so the fallback was the whole bug — it reached
   *  past a deliberately empty list to the raw column. A lot carrying a code is
   *  identified BY that code; it has no serial to show. Same rule as
   *  `StockLedgerView.serialOf`. */
  const serialOf = (r: { serial_number?: string | null; asset_code?: string | null;
                         consumable_code?: string | null }) =>
    (r.asset_code || r.consumable_code) ? undefined : r.serial_number ?? undefined;
  // Narrowest key first: the units in THIS bin and THIS batch. A lot only widens the
  // question to the whole bin, or the whole point, when it does not itself name one —
  // a lot standing in BINA1 that has no units of its own has none, and must not be
  // handed the unplaced ones sitting in bulk. See indexSerials.
  const unitsOf = (r: StockBalanceItem) => {
    const bin = unplaced(r.bin_id), batch = unplaced(r.batch_id);
    return serialsByRow.get(`${r.item_id}:${r.warehouse_id}:${bin}:${batch}`)
      ?? (batch ? undefined : serialsByRow.get(`${r.item_id}:${r.warehouse_id}:${bin}`))
      ?? (bin || batch ? undefined : serialsByRow.get(`${r.item_id}:${r.warehouse_id}`));
  };

  /** Which lot a cell's popover should list the units of. */
  const lotOf = (r: StockBalanceItem) => ({
    itemId: r.item_id,
    warehouseId: r.warehouse_id,
    binId: r.bin_id,
    batchId: r.batch_id,
    itemCode: r.item_code,
    expected: unitsOf(r)?.count,
    label: r.bin_code || r.warehouse_name,
  });

  const activeFilters =
    [search, warehouseId, expiringIn, expiryFrom, expiryTo].filter(Boolean).length +
    (stockView ? 1 : 0) +
    (belowReorder ? 1 : 0);

  const hit = hitDismissed ? null : unitHit;

  const clear = () => {
    setHitDismissed(false);
    setSearch(""); setWarehouseId(""); setExpiringIn("");
    setExpiryFrom(""); setExpiryTo("");
    setStockView(""); setBelowReorder(false);
    setPage(1);
  };

  const exportCsv = () => {
    const header = ["Item Code", "Item Name", "Category", "Warehouse", "Bin", "Batch",
                    "Expiry", "Available", "Reserved", "Serials", "IMEIs",
                    "Asset / consumable codes", "Rate", "Value"];
    const cell = (v: any) => {
      if (v == null) return '""';
      const s = String(v).replace(/"/g, '""');
      return `"${s}"`;
    };
    const body = rows.map((r) => [
      r.item_code, r.item_name, r.category_name, r.warehouse_name, r.bin_code, r.batch_number, r.expiry_date,
      r.available_qty, r.reserved_qty,
      // Three columns, because the three identities are not interchangeable. The
      // summary carries the first five of each — the whole list of a single lot is a
      // Download away in the row's popover, which is the right place for 88 codes.
      unitsOf(r)?.serials.join(" | ") || serialOf(r),
      unitsOf(r)?.imeis.join(" | "),
      unitsOf(r)?.codes.join(" | ") || (r.asset_code ?? r.consumable_code),
      r.valuation_rate, r.total_value,
    ]);
    const csv = [header, ...body].map((line) => line.map(cell).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `stock-balance-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const columns: Column<StockBalanceItem>[] = [
    {
      key: "item",
      header: "Item",
      render: (r) => (
        <div className="flex items-center gap-2.5">
          <ItemTile name={r.item_name} />
          <div className="min-w-0">
            <div className="truncate font-semibold text-ink">{r.item_name}</div>
            <div className="font-mono text-[11px] text-muted">
              {r.item_code}{r.category_name ? ` · ${r.category_name}` : ""}
            </div>
          </div>
        </div>
      ),
    },
    {
      key: "location",
      header: "Location",
      render: (r) => (
        <div className="flex min-w-0 items-start gap-1.5">
          <MapPin size={14} className="mt-0.5 shrink-0 text-muted" />
          <div className="min-w-0">
            <div className="truncate text-sm text-body">{r.warehouse_name}</div>
            <div className="text-[11px] text-muted">
              {r.bin_code || "No bin"}{r.project_name ? ` · ${r.project_name}` : ""}
            </div>
          </div>
        </div>
      ),
    },
    {
      key: "batch",
      header: "Batch / Expiry",
      hideOnNarrow: true,
      render: (r) => (
        <div className="flex min-w-0 flex-col items-start gap-1">
          <span className="truncate rounded-md bg-content2/70 px-2 py-0.5 font-mono text-[11px] font-semibold text-body">
            {r.batch_number || "No batch"}
          </span>
          <ExpiryChip date={r.expiry_date} />
        </div>
      ),
    },
    {
      key: "available",
      header: "Available",
      className: "text-right",
      render: (r) => (
        <div className="inline-flex flex-col items-end">
          <span className="font-display text-base font-bold tabular text-ink">{qty(r.available_qty, uomOf(r))}</span>
          <LevelBar r={r} />
        </div>
      ),
    },
    {
      key: "reserved",
      header: "Reserved",
      className: "text-right",
      render: (r) => (
        <span className={r.reserved_qty > 0 ? "font-semibold text-warn" : "text-muted"}>{r.reserved_qty}</span>
      ),
    },
    {
      // "On Hand" was available + reserved, and reserved stock is precisely what is
      // NOT on hand — it belongs to somebody else's indent. Showing it invited people
      // to allocate against goods that were already spoken for. Available and Reserved
      // are both above; the sum adds nothing but a wrong word. The serial goes here
      // instead, which is what the column is actually wanted for.
      key: "serial",
      header: "Serial / IMEI",
      hideOnNarrow: true,
      render: (r) => {
        const units = unitsOf(r);
        // Serial first, IMEI second: both name the unit, and an item is rarely
        // tracked by both. The lot's own column is the last resort — it holds one
        // value for a lot that may contain eighty units.
        const first = units?.serials[0] ?? units?.imeis[0] ?? serialOf(r);
        return (
          <UnitCell
            text={first}
            extra={units ? units.count - 1 : 0}
            lot={units ? lotOf(r) : undefined}
            title={r.item_name}
          />
        );
      },
    },
    {
      key: "unit_code",
      header: "Asset / Consumable code",
      hideOnNarrow: true,
      render: (r) => {
        const units = unitsOf(r);
        const first = units?.codes[0] ?? r.asset_code ?? r.consumable_code;
        return (
          <UnitCell
            text={first}
            extra={units?.codes.length ? units.count - 1 : 0}
            lot={units?.codes.length ? lotOf(r) : undefined}
            title={r.item_name}
          />
        );
      },
    },
    {
      key: "rate",
      header: "Rate",
      className: "text-right",
      hideOnNarrow: true,
      render: (r) => <span className="text-sm">{money(r.valuation_rate)}</span>,
    },
    {
      key: "value",
      header: "Value",
      className: "text-right",
      hideOnNarrow: true,
      render: (r) => <span className="text-sm">{money(r.total_value)}</span>,
    },
    {
      key: "state",
      header: "Status",
      render: (r) => {
        const s = stockState(r);
        return <Chip size="sm" variant="flat" color={s.color}>{s.label}</Chip>;
      },
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title="Stock Balance"
        actions={
          <>
            {/* Header actions are `ghost` with a 16px icon, app-wide (2026-08-23). The same
                Export button was `primary` on Stock Ledger, `secondary` here and
                `subtle` on Adjustments — three weights for one action, so the eye
                read them as three different levels of importance. Approvals' Export
                is the reference; a solid fill in the header competes with the one
                button on the page that CREATES something. */}
            <Button variant="ghost" disabled={rows.length === 0} onClick={exportCsv}>
              <Download className="h-4 w-4" /> Export CSV
            </Button>
            <Button variant="ghost" onClick={() => navigate("/inventory/labels")}>
              <TagIcon className="h-4 w-4" /> Labels & Printing
            </Button>
          </>
        }
      />

      {/* `undefined` while a count is in flight — the strip draws a skeleton for it.
          Rendering 0 0 0 0 read as a real answer ("no stock, nothing expiring") on a
          screen that was still loading.

          The first three are READ-OUTS and say so by taking no `onPress`: "on hand" is
          a quantity, not a set of rows, and narrowing the list to "distinct items"
          means nothing. The last two ARE sets, and each is the filter it counts. A
          tile that cannot filter must not pretend it can — a press that does nothing
          is worse than no press at all. */}
      <KpiTiles label="Stock summary" className="mb-4" tiles={[
        {
          key: "on_hand", label: "On hand", icon: Boxes, tone: "brand",
          // Counted by the same query over the same rows as Stocking Points, and first
          // because it is the number the two screens get read against each other on.
          value: summaryLoading || summary?.total_qty === undefined
            ? undefined
            : summary.total_qty.toLocaleString("en-IN", { maximumFractionDigits: 3 }),
        },
        { key: "lines", label: "Stock lines", value: stat(summary?.stock_lines),
          icon: Layers, tone: "info" },
        { key: "items", label: "Distinct items", value: stat(summary?.distinct_items),
          icon: Boxes, tone: "info" },
        // Hidden, not zeroed, when no item in the master carries a reorder level: a
        // "Below reorder 0" tile reads as "nothing needs ordering" when the truth is
        // that nobody has said what low means yet. Comes back on its own the moment a
        // reorder level is set on any item.
        ...(summary?.reorder_configured === false ? [] : [{
          key: "reorder", label: "Below reorder", value: stat(summary?.below_reorder),
          icon: TriangleAlert, tone: summary?.below_reorder ? "bad" : "neutral",
          active: belowReorder,
          onPress: () => { setBelowReorder((on) => !on); setPage(1); },
        } as KpiTileSpec]),
        {
          key: "expiring", label: "Expiring ≤30d", value: stat(summary?.expiring_30_days),
          icon: CalendarClock, tone: summary?.expiring_30_days ? "warn" : "neutral",
          active: expiringIn === "30",
          onPress: () => {
            setExpiringIn((on) => (on === "30" ? "" : "30"));
            setPage(1);
          },
        },
      ] satisfies KpiTileSpec[]} />

      {/* One unit, found by whatever identity is printed on it. This is the answer to
          "where is THIS thing", which a list of lots cannot give. */}
      {hit && (
        <div className="mb-4 rounded-2xl border border-brand/40 bg-brand-050/40 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <ScanLine size={18} className="mt-0.5 shrink-0 text-brand" />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-ink">
                  {hit.item_name}
                  <span className="ml-1 font-normal text-muted">{hit.item_code}</span>
                </div>
                <div className="mt-0.5 text-xs text-body">
                  {hit.warehouse_name || "Unknown point"}
                  {hit.bin_code ? ` › ${hit.bin_code}` : " › no bin recorded"}
                  {hit.batch_no ? ` · Batch ${hit.batch_no}` : ""}
                  {hit.expiry_date ? ` · Expires ${hit.expiry_date}` : ""}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {([
                    ["Serial", hit.serial_number],
                    ["IMEI", hit.imei],
                    [hit.is_asset ? "Asset code" : "Consumable code",
                     hit.asset_code || hit.consumable_code],
                  ] as const).filter(([, v]) => v).map(([label, v]) => (
                    <span key={label} className="rounded bg-content1 px-2 py-0.5 text-[11px] text-body">
                      <span className="text-muted">{label} </span>
                      <span className="font-mono">{v}</span>
                    </span>
                  ))}
                  <Chip size="sm" variant="flat">{hit.status}</Chip>
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="secondary"
                onClick={() => {
                  setWarehouseId(String(hit.warehouse_id ?? ""));
                  setPage(1);
                }}
              >
                Show this point
              </Button>
              <button
                type="button"
                aria-label="Dismiss"
                className="rounded-md p-2 text-muted transition-colors hover:bg-content2"
                onClick={() => setHitDismissed(true)}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        </div>
      )}

      <FilterBar
        search={search}
        onSearch={(v) => { setHitDismissed(false); setSearch(v); }}
        searchPlaceholder="Scan or type a serial, IMEI, asset code, item, batch or bin…"
        onClear={clear}
        active={activeFilters}
      >
        <FilterSelect
          value={warehouseId}
          onChange={setWarehouseId}
          placeholder="All warehouses"
          options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
        />
        <FilterSelect
          value={expiringIn}
          onChange={setExpiringIn}
          placeholder="Any expiry"
          options={EXPIRY_WINDOWS}
        />
        {expiringIn === "custom" && (
          <>
            <input
              type="date"
              value={expiryFrom}
              max={expiryTo || undefined}
              onChange={(e) => setExpiryFrom(e.target.value)}
              aria-label="From expiry date"
              className="h-11 rounded-xl border border-line/60 bg-content1 px-3 text-sm text-ink shadow-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/25"
            />
            <input
              type="date"
              value={expiryTo}
              min={expiryFrom || undefined}
              onChange={(e) => setExpiryTo(e.target.value)}
              aria-label="To expiry date"
              className="h-11 rounded-xl border border-line/60 bg-content1 px-3 text-sm text-ink shadow-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/25"
            />
          </>
        )}
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
        {/* Same reason as the tile: with no reorder level anywhere the filter can only
            ever return an empty grid, which reads as "no stock is low". */}
        {summary?.reorder_configured !== false && (
          <FilterToggle active={belowReorder} onChange={setBelowReorder}>Below reorder</FilterToggle>
        )}
        <FilterMenu
          placeholder="Available stock"
          value={stockView}
          onChange={setStockView}
          options={[
            { value: "all", label: "All stock" },
            { value: "zero", label: "Zero stock" },
            { value: "reserved", label: "Fully reserved" },
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
          // The serial/code lookup lands after the list. Without this the table keeps
          // the cells it built before that answer arrived — see ResponsiveList.revision.
          revision={`${serialRows.length}:${rows.length}`}
          empty={
            activeFilters
              ? "No stock matches these filters."
              : "No stock on hand. Rows appear once a GRN is received."
          }
          renderCard={(r) => {
            const s = stockState(r);
            return (
              <div className="space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <ItemTile name={r.item_name} />
                    <span className="truncate font-semibold text-ink">{r.item_name}</span>
                  </div>
                  <Chip size="sm" variant="flat" color={s.color}>{s.label}</Chip>
                </div>
                <div className="font-mono text-[11px] text-muted">{r.item_code}</div>
                <div className="text-xs text-muted">{r.warehouse_name} · {r.bin_code || "No bin"}</div>
                <div className="text-xs text-muted">
                  Batch {r.batch_number || "—"} · {r.expiry_date ? `Expires ${r.expiry_date}` : "No expiry"}
                </div>
                <div className="flex gap-4 text-sm">
                  <span>Available <strong>{qty(r.available_qty, uomOf(r))}</strong></span>
                  <span className="text-muted">Reserved {r.reserved_qty}</span>
                </div>
              </div>
            );
          }}
        />
      </Card>

      <DetailSheet
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.item_name ?? ""}
        subtitle={selected?.item_code}
        badge={
          selected && (
            <Chip size="sm" variant="flat" color={stockState(selected).color}>
              {stockState(selected).label}
            </Chip>
          )
        }
        footer={
          <>
            <Button variant="subtle" onClick={() => setSelected(null)}>Close</Button>
            <Button onClick={() => navigate(`/inventory/ledger?item_id=${selected?.item_id}`)}>
              View movements
            </Button>
          </>
        }
      >
        {selected && (
          <>
            <SheetSection title="Quantities">
              <ResponsiveGrid cols={3} gap="gap-2">
                {([
                  ["Available", selected.available_qty, "text-brand"],
                  ["Reserved", selected.reserved_qty, "text-warning"],
                  // Not "On hand": this is available + reserved, and reserved goods
                  // are committed elsewhere. "Total in stock" says what it is without
                  // implying any of it is free to give.
                  ["Total in stock", selected.physical_qty, "text-ink"],
                ] as const).map(([label, v, tone]) => (
                  <div key={label} className="rounded-lg border border-line/70 p-3">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</div>
                    <div className={`text-xl font-bold ${tone}`}>{v.toLocaleString("en-IN")}</div>
                    <div className="text-[10px] text-muted">{uomOf(selected)}</div>
                  </div>
                ))}
              </ResponsiveGrid>
              {(selected.transit_qty ?? 0) > 0 && (
                <p className="mt-2 text-xs text-muted">
                  In transit: {selected.transit_qty} {uomOf(selected)}
                </p>
              )}
            </SheetSection>

            <SheetSection title="Where it sits">
              <LocationPath path={detail?.location_path ?? [selected.warehouse_name]} />
              <SheetRow label="Project" value={selected.project_name} />
            </SheetSection>

            <SheetSection title="Identity & Tracking">
              <SheetRow label="Category" value={selected.category_name} />
              {/* The barcode IS the item code. A separate barcode_value was optional,
                  usually empty, and when it was filled it named a different string
                  from the one printed on the shelf label — two identities for one
                  item. The code is what Labels & Printing encodes. */}
              <SheetRow label="Barcode (item code)" value={selected.item_code} />
              <SheetRow label="Batch" value={selected.batch_number} />
              <SheetRow label="Expiry" value={selected.expiry_date} />
              <SheetRow label="Bin" value={selected.bin_code} />
            </SheetSection>

            {/* The units themselves — every serial, IMEI and asset/consumable code
                standing in this lot, copyable and downloadable. The list row has space
                for one; "which units are actually here" is the question that follows,
                and the answer has to leave the browser. */}
            <SheetSection title="Units in this lot">
              <UnitsPanel
                itemId={selected.item_id}
                warehouseId={selected.warehouse_id}
                binId={selected.bin_id}
                batchId={selected.batch_id}
                itemCode={selected.item_code}
                expected={unitsOf(selected)?.count}
              />
            </SheetSection>

            <SheetSection title={`Lots in ${selected.warehouse_name || "this warehouse"}`}>
              {detailLoading && <p className="text-sm text-muted">Loading lots…</p>}
              {!detailLoading && !detail?.lots.length && (
                <p className="text-sm text-muted">No lot rows for this item here.</p>
              )}
              <div className="space-y-2">
                {detail?.lots.map((lot) => <LotCard key={lot.id} lot={lot} uom={uomOf(selected)} />)}
              </div>
            </SheetSection>

            <SheetSection title="Costing & Planning">
              <SheetRow label="Valuation rate" value={money(selected.valuation_rate)} />
              <SheetRow label="Stock value" value={money(selected.total_value)} />
              <SheetRow
                label="Reorder level"
                value={selected.reorder_level > 0 ? selected.reorder_level : <span className="text-muted">Not set</span>}
              />
              <SheetRow
                label="Last movement"
                value={selected.last_movement_at ? new Date(selected.last_movement_at).toLocaleString() : null}
              />
            </SheetSection>
          </>
        )}
      </DetailSheet>
    </div>
  );
}
