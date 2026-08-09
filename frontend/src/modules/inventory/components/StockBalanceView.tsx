import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Chip } from "@heroui/react";
import { Boxes, Layers, TriangleAlert, CalendarClock, Tag as TagIcon, FileSpreadsheet } from "lucide-react";
import { Button, Card, PageHeader, ResponsiveGrid, ResponsiveList, StatCard, type Column } from "@/shared/components";
import { FilterBar, FilterSelect, FilterToggle } from "./FilterBar";
import { DetailSheet, SheetRow, SheetSection } from "./DetailSheet";
import { getStockBalances, getStockDetail, getStockSummary, getWarehouses } from "../api";
import type { StockBalanceItem, StockDetail, StockLot } from "../types";
import { useDebouncedValue } from "../hooks/useDebouncedValue";

/** Value columns read off stk_balance.valuation_rate / stock_value. Both are 0 across
 *  the live data, so an uncosted row says so rather than printing a confident ₹0.00. */
const money = (n?: number) =>
  !n ? <span className="text-muted">Not costed</span> : `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

const qty = (n: number, uom?: string) => `${n.toLocaleString("en-IN")}${uom ? ` ${uom}` : ""}`;

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
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [search, setSearch] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [expiringIn, setExpiringIn] = useState("");
  const [expiryFrom, setExpiryFrom] = useState("");
  const [expiryTo, setExpiryTo] = useState("");
  const [includeZero, setIncludeZero] = useState(false);
  const [belowReorder, setBelowReorder] = useState(false);
  const [selected, setSelected] = useState<StockBalanceItem | null>(null);

  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses"], queryFn: getWarehouses });

  // Opened only when a row is clicked: the lots and the walk down the location tree
  // are a second query, so the list itself stays one cheap page of stk_balance.
  const { data: detail, isLoading: detailLoading } = useQuery<StockDetail>({
    queryKey: ["stock-detail", selected?.id],
    queryFn: () => getStockDetail(selected!.id),
    enabled: !!selected,
  });

  const debouncedSearch = useDebouncedValue(search);

  const filters = {
    search: debouncedSearch,
    warehouse_id: warehouseId,
    expiring_in_days: ["30", "60", "90"].includes(expiringIn) ? Number(expiringIn) : undefined,
    expiry_status: expiringIn === "expired" ? "expired" : undefined,
    expired_in_last_days: expiringIn.startsWith("expired_") ? Number(expiringIn.split("_")[1]) : undefined,
    expiry_from: expiringIn === "custom" ? expiryFrom : undefined,
    expiry_to: expiringIn === "custom" ? expiryTo : undefined,
    include_zero: includeZero,
    below_reorder: belowReorder,
    page,
    size,
  };

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
  const stat = (n?: number) =>
    summaryLoading || n === undefined ? "—" : n.toLocaleString("en-IN");

  const activeFilters =
    [search, warehouseId, expiringIn, expiryFrom, expiryTo].filter(Boolean).length +
    (includeZero ? 1 : 0) +
    (belowReorder ? 1 : 0);

  const clear = () => {
    setSearch(""); setWarehouseId(""); setExpiringIn("");
    setExpiryFrom(""); setExpiryTo("");
    setIncludeZero(false); setBelowReorder(false);
    setPage(1);
  };

  const exportCsv = () => {
    const header = ["Item Code", "Item Name", "Category", "Warehouse", "Bin", "Batch", "Expiry", "Available", "Reserved", "On Hand", "Value"];
    const cell = (v: any) => {
      if (v == null) return '""';
      const s = String(v).replace(/"/g, '""');
      return `"${s}"`;
    };
    const body = rows.map((r) => [
      r.item_code, r.item_name, r.category_name, r.warehouse_name, r.bin_code, r.batch_number, r.expiry_date,
      r.available_qty, r.reserved_qty, r.physical_qty, r.total_value,
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
        <div className="min-w-0">
          <div className="truncate font-medium text-ink">{r.item_name}</div>
          <div className="font-mono text-[11px] text-muted">
            {r.item_code}{r.category_name ? ` · ${r.category_name}` : ""}
          </div>
        </div>
      ),
    },
    {
      key: "location",
      header: "Location",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-body">{r.warehouse_name}</div>
          <div className="text-[11px] text-muted">
            {r.bin_code || "No bin"}{r.project_name ? ` · ${r.project_name}` : ""}
          </div>
        </div>
      ),
    },
    {
      key: "batch",
      header: "Batch / Expiry",
      hideOnNarrow: true,
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-body">{r.batch_number || "—"}</div>
          <div className="text-[11px] text-muted">{r.expiry_date || "No expiry"}</div>
        </div>
      ),
    },
    {
      key: "available",
      header: "Available",
      className: "text-right",
      render: (r) => <span className="font-semibold text-ink">{qty(r.available_qty, r.uom_code)}</span>,
    },
    {
      key: "reserved",
      header: "Reserved",
      className: "text-right",
      render: (r) => (
        <span className={r.reserved_qty > 0 ? "text-warning" : "text-muted"}>{r.reserved_qty}</span>
      ),
    },
    {
      key: "total",
      header: "On Hand",
      className: "text-right",
      hideOnNarrow: true,
      render: (r) => <span className="text-body">{r.physical_qty}</span>,
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
            <Button variant="subtle" disabled={rows.length === 0} onClick={exportCsv}>
              <FileSpreadsheet size={14} /> Export CSV
            </Button>
            <Button variant="primary" onClick={() => navigate("/inventory/labels")}>
              <TagIcon size={14} /> Labels & Printing
            </Button>
          </>
        }
      />

      {/* An em dash while the count is in flight. Rendering 0 0 0 0 read as a real
          answer — "no stock, nothing expiring" — on a screen that was still loading. */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Stock Lines" value={stat(summary?.stock_lines)} icon={<Layers size={16} />} />
        <StatCard label="Distinct Items" value={stat(summary?.distinct_items)} icon={<Boxes size={16} />} />
        <StatCard
          label="Below Reorder"
          value={stat(summary?.below_reorder)}
          icon={<TriangleAlert size={16} />}
          tone={summary?.below_reorder ? "text-danger" : "text-muted"}
        />
        <StatCard
          label="Expiring ≤30d"
          value={stat(summary?.expiring_30_days)}
          icon={<CalendarClock size={16} />}
          tone={summary?.expiring_30_days ? "text-warning" : "text-muted"}
        />
      </div>

      <FilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Scan a barcode, or search item / batch / bin…"
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
              className="h-11 rounded-lg border border-line bg-content1 px-3 text-sm text-ink outline-none focus:border-brand"
            />
            <input
              type="date"
              value={expiryTo}
              min={expiryFrom || undefined}
              onChange={(e) => setExpiryTo(e.target.value)}
              aria-label="To expiry date"
              className="h-11 rounded-lg border border-line bg-content1 px-3 text-sm text-ink outline-none focus:border-brand"
            />
          </>
        )}
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
        <FilterToggle active={belowReorder} onChange={setBelowReorder}>Below reorder</FilterToggle>
        <FilterToggle active={includeZero} onChange={setIncludeZero}>Include zero stock</FilterToggle>
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
                  <span className="font-semibold text-ink">{r.item_name}</span>
                  <Chip size="sm" variant="flat" color={s.color}>{s.label}</Chip>
                </div>
                <div className="font-mono text-[11px] text-muted">{r.item_code}</div>
                <div className="text-xs text-muted">{r.warehouse_name} · {r.bin_code || "No bin"}</div>
                <div className="text-xs text-muted">
                  Batch {r.batch_number || "—"} · {r.expiry_date ? `Expires ${r.expiry_date}` : "No expiry"}
                </div>
                <div className="flex gap-4 text-sm">
                  <span>Available <strong>{qty(r.available_qty, r.uom_code)}</strong></span>
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
                  ["On hand", selected.physical_qty, "text-ink"],
                ] as const).map(([label, v, tone]) => (
                  <div key={label} className="rounded-lg border border-line/70 p-3">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</div>
                    <div className={`text-xl font-bold ${tone}`}>{v.toLocaleString("en-IN")}</div>
                    <div className="text-[10px] text-muted">{selected.uom_code}</div>
                  </div>
                ))}
              </ResponsiveGrid>
              {(selected.transit_qty ?? 0) > 0 && (
                <p className="mt-2 text-xs text-muted">
                  In transit: {selected.transit_qty} {selected.uom_code}
                </p>
              )}
            </SheetSection>

            <SheetSection title="Where it sits">
              <LocationPath path={detail?.location_path ?? [selected.warehouse_name]} />
              <SheetRow label="Project" value={selected.project_name} />
            </SheetSection>

            <SheetSection title="Identity & Tracking">
              <SheetRow label="Category" value={selected.category_name} />
              <SheetRow label="Asset code" value={selected.asset_code} />
              <SheetRow label="Barcode" value={selected.barcode_value} />
            </SheetSection>

            <SheetSection title={`Lots in ${selected.warehouse_name || "this warehouse"}`}>
              {detailLoading && <p className="text-sm text-muted">Loading lots…</p>}
              {!detailLoading && !detail?.lots.length && (
                <p className="text-sm text-muted">No lot rows for this item here.</p>
              )}
              <div className="space-y-2">
                {detail?.lots.map((lot) => <LotCard key={lot.id} lot={lot} uom={selected.uom_code} />)}
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
