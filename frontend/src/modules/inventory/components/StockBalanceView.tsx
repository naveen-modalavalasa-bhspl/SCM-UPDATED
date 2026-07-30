import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Chip } from "@heroui/react";
import { Boxes, Layers, TriangleAlert, CalendarClock, Tag as TagIcon } from "lucide-react";
import { Button, Card, PageHeader, ResponsiveList, StatCard, type Column } from "@/shared/components";
import { FilterBar, FilterSelect, FilterToggle } from "./FilterBar";
import { DetailSheet, SheetRow, SheetSection } from "./DetailSheet";
import { getStockBalances, getStockDetail, getWarehouses } from "../api";
import type { StockBalanceItem, StockDetail, StockLot } from "../types";

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
  { value: 30, label: "Expiring in 30 days" },
  { value: 60, label: "Expiring in 60 days" },
  { value: 90, label: "Expiring in 90 days" },
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
      {(lot.serial_number || lot.asset_code) && (
        <div className="mt-1 font-mono text-[11px] text-muted">{lot.serial_number || lot.asset_code}</div>
      )}
    </div>
  );
}

export function StockBalanceView() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [expiringIn, setExpiringIn] = useState("");
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

  const filters = {
    search,
    warehouse_id: warehouseId,
    expiring_in_days: expiringIn ? Number(expiringIn) : undefined,
    include_zero: includeZero,
    below_reorder: belowReorder,
  };

  const { data, isLoading } = useQuery({
    queryKey: ["stock-balance", filters],
    queryFn: () => getStockBalances(filters),
  });
  const rows = data?.items ?? [];

  const kpis = useMemo(() => {
    let value = 0, low = 0, expiring = 0;
    const items = new Set<number>();
    rows.forEach((r) => {
      value += r.total_value;
      items.add(r.item_id);
      if (r.reorder_level > 0 && r.available_qty < r.reorder_level) low++;
      const left = daysTo(r.expiry_date);
      if (left !== null && left <= 30) expiring++;
    });
    return { value, low, expiring, items: items.size };
  }, [rows]);

  const activeFilters =
    [search, warehouseId, expiringIn].filter(Boolean).length + (includeZero ? 1 : 0) + (belowReorder ? 1 : 0);

  const clear = () => {
    setSearch(""); setWarehouseId(""); setExpiringIn("");
    setIncludeZero(false); setBelowReorder(false);
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
      key: "identifier",
      header: "Serial / Asset",
      hideOnNarrow: true,
      render: (r) => (
        <span className="font-mono text-xs text-body">
          {r.serial_number || r.asset_code || r.consumable_code || <span className="text-muted">—</span>}
        </span>
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
          <Button variant="ghost" onClick={() => navigate("/inventory/labels")}>
            <TagIcon size={14} /> Labels & Printing
          </Button>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Stock Lines" value={rows.length} icon={<Layers size={16} />} />
        <StatCard label="Distinct Items" value={kpis.items} icon={<Boxes size={16} />} />
        <StatCard
          label="Below Reorder"
          value={kpis.low}
          icon={<TriangleAlert size={16} />}
          tone={kpis.low ? "text-danger" : "text-muted"}
        />
        <StatCard
          label="Expiring ≤30d"
          value={kpis.expiring}
          icon={<CalendarClock size={16} />}
          tone={kpis.expiring ? "text-warning" : "text-muted"}
        />
      </div>

      <FilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Scan a barcode, or search item / batch / bin / serial…"
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
            <Button variant="ghost" onClick={() => setSelected(null)}>Close</Button>
            <Button onClick={() => navigate(`/inventory/ledger?item_id=${selected?.item_id}`)}>
              View movements
            </Button>
          </>
        }
      >
        {selected && (
          <>
            <SheetSection title="Quantities">
              <div className="grid grid-cols-3 gap-2">
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
              </div>
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
              <SheetRow label="Serial number" value={selected.serial_number} />
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
