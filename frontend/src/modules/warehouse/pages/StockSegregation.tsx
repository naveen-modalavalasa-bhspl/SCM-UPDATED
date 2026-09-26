import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import { Card, ErrorBanner, PageHeader, ResponsiveList, StatCard, StatusPill, SubNav, type Column } from "@/shared/components";
import { FilterBar, FilterSelect } from "../components/FilterBar";
import { LabelSheet, type LabelSpec } from "../components/LabelPrint";
import { Lookup } from "../components/Lookup";
import { StockReportPanel } from "../components/StockReportPanel";
import { listBatches, listSerials, warehouseOptions, itemOptions, getItemLocations, listLocations } from "../api";
import { daysUntil, fmtDate, fmtQty, normaliseStatus } from "../format";
import type { Batch, SerialNumber } from "../types";
import { usePointLabel } from "../usePointLabel";
import { ScanLine } from "lucide-react";
import { CodeAssignmentScreen } from "./CodeAssignmentScreen";

/** One lot whose units are on screen: an item, at one location, in one batch. */
interface UnitsView {
  itemId: number;
  itemLabel: string;
  binId: number;
  binCode: string;
  binPath: string;
  batchId: number;
  batchNo?: string | null;
  available: number;
}

/** Where a unit physically is. The floor comes off the bin master (`floor_level`,
 *  the same value the Floor plan draws), so "which floor is this on" is answered
 *  here instead of by looking the bin code up on another screen. A unit in bulk
 *  storage has no bin and therefore no floor. */
const placeOf = (s: SerialNumber) =>
  [s.bin_floor_level != null ? `Floor ${s.bin_floor_level}` : null, s.bin_code ?? "bulk"]
    .filter(Boolean).join(" · ");

/**
 * Stock segregation — which individual units and batches you are holding, and which
 * of them you should stop selling.
 *
 * Two views over the same question. Batches are what expires; serials are what is
 * individually tracked, and carry the asset or consumable code generated during
 * putaway. Both are read-only here: neither is created by hand, and the screen that
 * let you type a serial in was how duplicates got into `whs_serial_numbers`.
 *
 * Expiry is bucketed rather than shown as a raw date, because "expires in 12 days"
 * is a decision and "2026-08-10" is arithmetic homework.
 */

const TABS = [
  { key: "locations", label: "Locations" },
  { key: "batches", label: "Batches" },
  { key: "serials", label: "Serial numbers" },
];

const EXPIRY_BUCKETS = [
  { value: "expired", label: "Expired" },
  { value: "30", label: "Within 30 days" },
  { value: "90", label: "Within 90 days" },
];

const SERIAL_STATUSES = [
  { value: "available", label: "Available" },
  { value: "issued", label: "Issued" },
  { value: "consumed", label: "Consumed" },
  { value: "returned", label: "Returned" },
  { value: "maintenance", label: "Maintenance" },
  { value: "scrapped", label: "Scrapped" },
];

function lifeDateLabel(row: Pick<Batch, "is_asset">) {
  return row.is_asset ? "Warranty" : "Expiry";
}

function expiryTone(days: number | null, label = "Expiry") {
  const lower = label.toLowerCase();
  if (days === null) return { label: `No ${lower}`, color: "default" as const };
  if (days < 0) return { label: `${label} ended ${-days}d ago`, color: "danger" as const };
  if (days <= 30) return { label: `${days}d left`, color: "danger" as const };
  if (days <= 90) return { label: `${days}d left`, color: "warning" as const };
  return { label: `${days}d left`, color: "success" as const };
}

function LocationsTab() {
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  const [itemId, setItemId] = useState<number | null>(null);
  const [selectedLocationId, setSelectedLocationId] = useState<number | null>(null);
  /** The lot whose units are open. A stock movement re-files every unit it names
   *  onto its destination, so this is where the moved units are found afterwards. */
  const [viewing, setViewing] = useState<UnitsView | null>(null);

  const locationsQuery = useQuery({
    queryKey: ["wh-locations", warehouseId],
    queryFn: () => listLocations(warehouseId!),
    enabled: !!warehouseId,
  });

  const stockQuery = useQuery({
    queryKey: ["wh-location-stock", warehouseId, itemId, selectedLocationId],
    queryFn: () => getItemLocations({ warehouse_id: warehouseId!, item_id: itemId, location_id: selectedLocationId }),
    enabled: !!warehouseId,
  });

  const locationMap = useMemo(() => {
    if (!locationsQuery.data) return new Map();
    return new Map(locationsQuery.data.map(l => [l.id, l]));
  }, [locationsQuery.data]);

  const locationChildren = useMemo(() => {
    if (!locationsQuery.data) return new Map();
    const map = new Map<number | null, typeof locationsQuery.data>();
    for (const loc of locationsQuery.data) {
      const pid = loc.parent_location_id ?? null;
      if (!map.has(pid)) map.set(pid, []);
      map.get(pid)!.push(loc);
    }
    return map;
  }, [locationsQuery.data]);

  const breadcrumbs = useMemo(() => {
    const trail = [];
    let curr = selectedLocationId;
    while (curr != null) {
      const loc = locationMap.get(curr);
      if (!loc) break;
      trail.unshift(loc);
      curr = loc.parent_location_id ?? null;
    }
    return trail;
  }, [selectedLocationId, locationMap]);

  return (
    <div className="space-y-6">
      <div className="max-w-md">
        <Lookup
          name="wh-locations"
          label="Warehouse"
          placeholder="Select warehouse..."
          load={warehouseOptions}
          value={warehouseId ?? ""}
          onChange={(id) => {
            setWarehouseId(id === "" ? null : Number(id));
            setSelectedLocationId(null);
          }}
        />
      </div>

      {!warehouseId ? (
        <div className="rounded-lg border border-line p-12 text-center text-sm text-muted">
          Select a warehouse to browse storage locations.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 items-start">
          {/* Left pane: Location Browser */}
          <div className="col-span-1 border border-line rounded-xl bg-content1/50 backdrop-blur-xl overflow-hidden flex flex-col shadow-lg sticky top-6 ring-1 ring-black/5">
            <div className="bg-gradient-to-r from-content2 to-content1 px-4 py-3 border-b border-line font-semibold text-sm flex items-center justify-between shadow-sm">
              <div className="flex items-center gap-2 text-ink">
                <span className="text-primary opacity-80">🗂️</span>
                Storage Hierarchy
              </div>
              {locationsQuery.isLoading && <div className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />}
            </div>
            
            <div className="p-2 space-y-1 overflow-y-auto max-h-[600px] min-h-[300px]">
              {selectedLocationId != null && (
                <button 
                  onClick={() => setSelectedLocationId(locationMap.get(selectedLocationId)?.parent_location_id ?? null)} 
                  className="flex items-center text-sm text-primary hover:bg-primary/10 p-2.5 rounded-lg w-full text-left font-medium transition-all duration-200"
                >
                  <span className="mr-2 opacity-70">←</span> Back to {breadcrumbs.length > 1 ? breadcrumbs[breadcrumbs.length - 2].name || breadcrumbs[breadcrumbs.length - 2].code : "Root"}
                </button>
              )}
              
              <div className="px-3 py-2 text-[10px] font-extrabold text-muted uppercase tracking-widest">
                {selectedLocationId 
                  ? (locationMap.get(selectedLocationId)?.name || locationMap.get(selectedLocationId)?.code) 
                  : "Top Level Locations"}
              </div>
              
              {(locationChildren.get(selectedLocationId ?? null) || []).map((loc: any) => {
                const hasChildren = (locationChildren.get(loc.id) || []).length > 0;
                return (
                  <button 
                    key={loc.id} 
                    onClick={() => setSelectedLocationId(loc.id)} 
                    className="w-full text-left px-3 py-2.5 hover:bg-content2/80 active:bg-content3 rounded-xl flex justify-between items-center text-sm transition-all duration-200 group border border-transparent hover:border-line/50 hover:shadow-sm"
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${hasChildren ? 'bg-primary/10 text-primary group-hover:bg-primary group-hover:text-white' : 'bg-content3 text-body group-hover:bg-content2 group-hover:text-ink'}`}>
                        {hasChildren ? '📁' : '📍'}
                      </div>
                      <div className="flex flex-col">
                        <span className="font-semibold text-ink group-hover:text-primary transition-colors">{loc.code}</span>
                        {loc.name && <span className="text-[11px] text-muted truncate max-w-[120px]">{loc.name}</span>}
                      </div>
                    </div>
                    {hasChildren && <span className="text-muted opacity-50 group-hover:opacity-100 transition-opacity">›</span>}
                  </button>
                );
              })}
              
              {(locationChildren.get(selectedLocationId ?? null) || []).length === 0 && (
                <div className="p-6 flex flex-col items-center">
                  <div className="w-12 h-12 bg-primary/10 text-primary rounded-2xl flex items-center justify-center text-2xl mb-4 shadow-inner">
                    📦
                  </div>
                  <div className="text-[10px] font-extrabold tracking-widest text-primary uppercase mb-5 text-center bg-primary/5 py-1.5 px-4 rounded-full border border-primary/10">
                    Exact Location
                  </div>
                  <div className="flex flex-col gap-0 w-full relative">
                    <div className="absolute left-3.5 top-2 bottom-6 w-px bg-gradient-to-b from-primary/30 to-transparent" />
                    {breadcrumbs.map((crumb, idx) => {
                      const isLast = idx === breadcrumbs.length - 1;
                      return (
                        <div key={crumb.id} className="flex items-start mb-4 relative z-10">
                          <div className="flex flex-col items-center mr-4 h-full pt-1 w-7">
                            <div 
                              className={`w-3.5 h-3.5 rounded-full flex-shrink-0 transition-all duration-300 ${
                                isLast 
                                  ? 'bg-primary ring-4 ring-primary/20 shadow-md shadow-primary/40 scale-125' 
                                  : 'bg-content1 border-2 border-primary/40'
                              }`} 
                            />
                          </div>
                          <div className={`flex flex-col ${isLast ? 'opacity-100' : 'opacity-60 hover:opacity-100'} transition-opacity cursor-pointer`} onClick={() => !isLast && setSelectedLocationId(crumb.id)}>
                            <span className={`text-sm ${isLast ? 'font-bold text-primary' : 'font-semibold text-ink'}`}>
                              {crumb.code}
                            </span>
                            {crumb.name && (
                              <span className="text-xs text-muted truncate max-w-[180px]" title={crumb.name}>
                                {crumb.name}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Right pane: Stock details */}
          <div className="col-span-1 md:col-span-3 space-y-6">
            <div className="w-full md:w-72">
              <Lookup
                name="item-locations"
                label="Filter by Item (Optional)"
                placeholder="All Items"
                load={itemOptions}
                value={itemId ?? ""}
                onChange={(id) => setItemId(id === "" ? null : Number(id))}
              />
            </div>

            {/* The download sits ABOVE the stock it describes, and carries the item
                filter and the browsed location with it — a report button that ignores
                the filters on screen produces a file nobody can reconcile with what
                they were looking at. */}
            <StockReportPanel
              warehouseId={warehouseId}
              locationId={selectedLocationId}
              itemId={itemId}
            />

            <ErrorBanner error={stockQuery.error} />

            {stockQuery.isLoading && <div className="text-sm text-muted animate-pulse">Loading stock data...</div>}

            {stockQuery.isSuccess && !stockQuery.data?.length && (
              <div className="rounded-xl border border-dashed border-line p-12 text-center text-sm text-muted bg-content1/50">
                <div className="text-4xl mb-3 opacity-20">📦</div>
                No stock found in this location{itemId ? " for the selected item" : ""}.
              </div>
            )}

            {stockQuery.data && stockQuery.data.length > 0 && (
              <div className="space-y-8">
                {stockQuery.data.map(itemGroup => (
                  <div key={itemGroup.item_id} className="space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-500">
                    {/* Item Header */}
                    <div className="flex items-center gap-4 pb-3 border-b border-line">
                      <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 text-primary flex items-center justify-center font-bold text-xl shadow-inner border border-primary/10">
                        {itemGroup.item_code?.[0] ?? "I"}
                      </div>
                      <div>
                        <h3 className="font-bold text-xl text-ink tracking-tight">{itemGroup.item_name || "Unknown Item"}</h3>
                        <div className="text-sm text-muted font-mono bg-content2 inline-block px-2 py-0.5 rounded-md mt-1">{itemGroup.item_code}</div>
                      </div>
                    </div>

                    {/* Aggregate Stats for this Item */}
                    <div className="grid grid-cols-3 gap-4">
                      <StatCard label="Total Available" value={fmtQty(itemGroup.total_available) + (itemGroup.uom_code ? ` ${itemGroup.uom_code}` : "")} tone="text-success" />
                      <StatCard label="Total Reserved" value={fmtQty(itemGroup.total_reserved) + (itemGroup.uom_code ? ` ${itemGroup.uom_code}` : "")} tone="text-warn" />
                      <StatCard label="Total On Hand" value={fmtQty(itemGroup.total_on_hand) + (itemGroup.uom_code ? ` ${itemGroup.uom_code}` : "")} tone="text-ink" />
                    </div>

                    {/* Locations for this Item */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                      {itemGroup.locations.map((loc) => {
                        const availPercent = Number(loc.total_on_hand) > 0 ? (Number(loc.total_available) / Number(loc.total_on_hand)) * 100 : 0;
                        const resPercent = Number(loc.total_on_hand) > 0 ? (Number(loc.total_reserved) / Number(loc.total_on_hand)) * 100 : 0;
                        
                        return (
                          <Card key={loc.bin_id} className="overflow-hidden shadow-sm hover:shadow-lg transition-all duration-300 border border-line/60 bg-content1 group">
                            <div className="border-b border-line bg-gradient-to-br from-content2/80 to-content1 px-5 py-4">
                              <div className="font-bold text-ink flex items-center gap-2 text-lg">
                                <span className="text-primary text-xl">📍</span> {loc.bin_code}
                              </div>
                              <div className="text-[10px] font-bold text-muted mt-2 uppercase tracking-widest bg-content3/50 inline-block px-2 py-1 rounded-md">{loc.location_path.join(" › ")}</div>
                              
                              <div className="mt-5 space-y-2">
                                <div className="flex justify-between text-xs font-semibold">
                                  <span className="text-success">Avail: {fmtQty(loc.total_available)}</span>
                                  <span className="text-warn">Res: {fmtQty(loc.total_reserved)}</span>
                                  <span className="text-ink">Total: {fmtQty(loc.total_on_hand)}</span>
                                </div>
                                {/* Visual Progress Bar */}
                                <div className="h-2 w-full bg-content3 rounded-full overflow-hidden flex shadow-inner">
                                  <div className="h-full bg-success transition-all duration-1000" style={{ width: `${availPercent}%` }} />
                                  <div className="h-full bg-warn transition-all duration-1000" style={{ width: `${resPercent}%` }} />
                                </div>
                              </div>
                            </div>
                            
                            {loc.batches.length > 0 && (
                              <div className="divide-y divide-line max-h-60 overflow-y-auto custom-scrollbar">
                                {loc.batches.map((b) => {
                                  const tone = expiryTone(b.days_to_expiry ?? null, "Expiry");
                                  return (
                                    <div key={b.stock_id} className="p-4 text-sm hover:bg-primary/5 transition-colors group/batch cursor-default">
                                      <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-2">
                                          <span className="w-1.5 h-1.5 rounded-full bg-primary/40 group-hover/batch:bg-primary transition-colors" />
                                          <span className="font-mono font-bold text-ink">{b.batch_no || b.serial_number || b.asset_code || "Bulk"}</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                          {b.days_to_expiry !== null && (
                                            <Chip size="sm" variant="flat" color={tone.color} className="font-semibold shadow-sm">{tone.label}</Chip>
                                          )}
                                          <button
                                            type="button"
                                            onClick={() => setViewing({
                                              itemId: itemGroup.item_id,
                                              itemLabel: [itemGroup.item_code, itemGroup.item_name].filter(Boolean).join(" — "),
                                              binId: loc.bin_id,
                                              binCode: loc.bin_code,
                                              binPath: loc.location_path.slice(1).join(" / "),
                                              batchId: b.batch_id,
                                              batchNo: b.batch_no,
                                              available: b.available_qty,
                                            })}
                                            className="inline-flex min-h-8 items-center gap-1 rounded-md border border-line px-2 text-[11px] font-semibold text-body transition-colors hover:border-primary hover:text-primary"
                                            aria-label={`Units in ${b.batch_no || "this lot"} at ${loc.bin_code}`}
                                          >
                                            <ScanLine className="h-3.5 w-3.5" /> Units
                                          </button>
                                        </div>
                                      </div>
                                      <div className="text-xs text-muted flex justify-between items-center pl-3.5">
                                        <span>
                                          {b.project_name && <span className="text-primary font-semibold mr-2 bg-primary/10 px-1.5 py-0.5 rounded">P: {b.project_name}</span>}
                                        </span>
                                        <div className="flex gap-3 font-medium">
                                          <span className="text-success">A: {fmtQty(b.available_qty)}</span>
                                          <span className="text-warn">R: {fmtQty(b.reserved_qty)}</span>
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </Card>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* The units of one lot, by name — the same screen a movement picks them on,
        * opened as a viewer. Read off each unit's own location, so units a movement
        * re-filed show under the bay they were moved to. */}
      <CodeAssignmentScreen
        open={!!viewing}
        browse
        onClose={() => setViewing(null)}
        onSave={() => undefined}
        backLabel="Back to segregation"
        initial={[]}
        quantity={0}
        itemLabel={viewing?.itemLabel ?? ""}
        trackingType="NONE"
        noun="unit"
        unitMode="CODE"
        itemId={viewing?.itemId}
        warehouseId={warehouseId ?? undefined}
        binId={viewing?.binId}
        batchId={viewing?.batchId || undefined}
        unbatched
        scope={viewing ? {
          batchNo: viewing.batchNo,
          binCode: viewing.binCode,
          binPath: viewing.binPath,
          available: viewing.available,
        } : undefined}
      />
    </div>
  );
}

export default function StockSegregation() {
  const pointLabel = usePointLabel();
  const [tab, setTab] = useState("locations");
  const [search, setSearch] = useState("");
  const [bucket, setBucket] = useState("");
  const [serialStatus, setSerialStatus] = useState("");
  const [printing, setPrinting] = useState(false);

  const batches = useQuery({
    queryKey: ["wh-batches"],
    queryFn: () => listBatches({ size: 300 }),
    enabled: tab === "batches",
  });

  const serials = useQuery({
    queryKey: ["wh-serials", serialStatus],
    queryFn: () => listSerials({ size: 300, status: serialStatus || undefined }),
    enabled: tab === "serials",
  });

  const batchRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (batches.data?.items ?? []).filter((b) => {
      const days = daysUntil(b.expiry_date);
      if (bucket === "expired" && !(days !== null && days < 0)) return false;
      if (bucket === "30" && !(days !== null && days >= 0 && days <= 30)) return false;
      if (bucket === "90" && !(days !== null && days >= 0 && days <= 90)) return false;
      if (!q) return true;
      return [b.batch_no, b.item_code, b.item_name, b.vendor_name, b.grn_no].some((v) =>
        (v ?? "").toLowerCase().includes(q),
      );
    });
  }, [batches.data, search, bucket]);

  const serialRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (serials.data?.items ?? []).filter((s) => {
      if (!q) return true;
      return [s.serial_number, s.item_code, s.item_name, s.asset_code, s.consumable_code, s.bin_code].some(
        (v) => (v ?? "").toLowerCase().includes(q),
      );
    });
  }, [serials.data, search]);

  const batchColumns: Column<Batch>[] = [
    {
      key: "batch",
      header: "Batch",
      render: (b) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{b.batch_no}</div>
          <div className="text-[11px] text-muted">{b.grn_no ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "item",
      header: "Item",
      render: (b) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-ink">{b.item_code ?? "—"}</div>
          <div className="truncate text-xs text-muted">{b.item_name ?? "—"}</div>
        </div>
      ),
    },
    { key: "vendor", header: "Vendor", hideOnNarrow: true, render: (b) => b.vendor_name ?? "—" },
    {
      key: "qty",
      header: "Received",
      className: "text-right",
      render: (b) => <span className="tabular text-sm text-ink">{fmtQty(b.initial_qty)}</span>,
    },
    {
      key: "expiry",
      header: "Expiry / Warranty",
      render: (b) => {
        const label = lifeDateLabel(b);
        const tone = expiryTone(daysUntil(b.expiry_date), label);
        return (
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
            <div className="text-sm text-ink">{fmtDate(b.expiry_date)}</div>
            <Chip size="sm" variant="flat" color={tone.color}>{tone.label}</Chip>
          </div>
        );
      },
    },
    { key: "status", header: "Status", render: (b) => <StatusPill status={normaliseStatus(b.status)} /> },
  ];

  const serialColumns: Column<SerialNumber>[] = [
    {
      key: "serial",
      header: "Serial",
      render: (s) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{s.serial_number}</div>
          <div className="text-[11px] text-muted">{s.asset_code ?? s.consumable_code ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "item",
      header: "Item",
      render: (s) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-ink">{s.item_code ?? "—"}</div>
          <div className="truncate text-xs text-muted">{s.item_name ?? "—"}</div>
        </div>
      ),
    },
    { key: "batch", header: "Batch", hideOnNarrow: true, render: (s) => s.batch_no ?? "—" },
    {
      key: "where",
      header: "Where",
      render: (s) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-ink">{s.warehouse_name ?? "—"}</div>
          <div className="truncate text-[11px] text-muted">{placeOf(s)}</div>
        </div>
      ),
    },
    { key: "status", header: "Status", render: (s) => <StatusPill status={normaliseStatus(s.status)} /> },
  ];

  // FIXED 2026-08-21 — the printed sticker carried Serial, Batch and Bin, so read by
  // eye it did not say WHICH MATERIAL it was stuck to: the item code was nowhere and
  // the item name was an unlabelled subtitle. The five things a storekeeper checks
  // against the shelf — material, item, batch, code, expiry — are all written out and
  // labelled now, matching the block the Scan screen already prints (`ScanView`) and
  // the inventory label sheet (`inventory/LabelsPage`), so one unit reads the same way
  // wherever it is seen.
  //
  // Rows with no value are DROPPED rather than printed as "—". A 280px sticker has no
  // room to spend on absent fields, and "Batch —" reads as missing data rather than as
  // not-applicable.
  //
  // "Serial" is only printed when the unit really has one: for an unserialised unit
  // `warehouse._place_unit_codes` writes the asset/consumable code into
  // `serial_number` as well, so printing it raw put the same string on two lines under
  // two different names. Same rule as `UnitsPanel.realSerial`.
  const labels: LabelSpec[] = serialRows.slice(0, 200).map((s) => {
    const code = s.asset_code ?? s.consumable_code ?? null;
    const serial = s.serial_number && s.serial_number !== code ? s.serial_number : null;
    return {
      code: s.serial_number,
      title: code ?? s.serial_number,
      subtitle: s.item_name ?? s.item_code ?? "",
      kind: "qr" as const,
      meta: [
        { label: "Material", value: s.item_code ?? "" },
        { label: "Item", value: s.item_name ?? "" },
        { label: "Batch", value: s.batch_no ?? "" },
        { label: "Code", value: code ?? "" },
        { label: "Serial", value: serial ?? "" },
        { label: "Expiry", value: s.expiry_date ?? "" },
        { label: "Bin", value: placeOf(s) },
      ].filter((row) => row.value && row.value !== "—"),
    };
  });

  const expiring = (batches.data?.items ?? []).filter((b) => {
    const d = daysUntil(b.expiry_date);
    return d !== null && d >= 0 && d <= 90;
  }).length;
  const expired = (batches.data?.items ?? []).filter((b) => (daysUntil(b.expiry_date) ?? 1) < 0).length;

  return (
    <div>
      <PageHeader eyebrow={pointLabel} title="Stock segregation" />

      <SubNav label="Stock segregation" items={TABS} value={tab} onChange={setTab} />

      {tab === "locations" ? (
        <LocationsTab />
      ) : tab === "batches" ? (
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div className="rounded-xl bg-gradient-to-br from-content1 to-content2/50 border border-line shadow-sm p-4 hover:shadow-md transition-shadow">
              <div className="text-sm font-semibold text-muted mb-1 flex items-center gap-2"><span className="text-primary">📋</span> Batches held</div>
              <div className="text-3xl font-bold text-ink">{batches.data?.items.length ?? 0}</div>
            </div>
            <div className="rounded-xl bg-gradient-to-br from-warning/10 to-content1 border border-warning/20 shadow-sm p-4 hover:shadow-md transition-shadow">
              <div className="text-sm font-semibold text-warning-700 mb-1 flex items-center gap-2"><span>⏳</span> Expiring in 90 days</div>
              <div className="text-3xl font-bold text-warning-700">{expiring}</div>
            </div>
            <div className="rounded-xl bg-gradient-to-br from-danger/10 to-content1 border border-danger/20 shadow-sm p-4 hover:shadow-md transition-shadow">
              <div className="text-sm font-semibold text-danger mb-1 flex items-center gap-2"><span>⚠️</span> Expired</div>
              <div className="text-3xl font-bold text-danger">{expired}</div>
            </div>
            <div className="rounded-xl bg-gradient-to-br from-primary/10 to-content1 border border-primary/20 shadow-sm p-4 hover:shadow-md transition-shadow">
              <div className="text-sm font-semibold text-primary mb-1 flex items-center gap-2"><span>📦</span> Quantity</div>
              <div className="text-3xl font-bold text-primary">{fmtQty((batches.data?.items ?? []).reduce((s, b) => s + Number(b.initial_qty ?? 0), 0))}</div>
            </div>
          </div>

          <div className="bg-content1/50 backdrop-blur-md p-4 rounded-xl border border-line/60 shadow-sm mb-6 sticky top-4 z-20">
            <FilterBar
              search={search}
              onSearch={setSearch}
              placeholder="Search batch, item, vendor or GRN…"
              onReset={() => { setSearch(""); setBucket(""); }}
            >
              <FilterSelect label="Expiry / Warranty" allLabel="Any date" value={bucket} onChange={setBucket}
                            options={EXPIRY_BUCKETS} />
            </FilterBar>
          </div>

          <ErrorBanner error={batches.error} />

          <div className="bg-content1 rounded-xl shadow-sm border border-line/50 overflow-hidden">
            <ResponsiveList
              data={batchRows}
              columns={batchColumns}
              keyOf={(b) => b.id}
              loading={batches.isLoading}
              empty="No batches match these filters."
              renderCard={(b) => {
                const label = lifeDateLabel(b);
                const tone = expiryTone(daysUntil(b.expiry_date), label);
                return (
                  <div className="space-y-2 p-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-primary/40" />
                        <span className="font-mono text-sm font-bold text-ink">{b.batch_no}</span>
                      </div>
                      <Chip size="sm" variant="flat" color={tone.color} className="shadow-sm font-semibold">{tone.label}</Chip>
                    </div>
                    <div className="truncate text-sm font-medium text-body pl-3.5">{b.item_name ?? b.item_code ?? "—"}</div>
                    <div className="text-[11px] text-muted flex gap-2 items-center pl-3.5">
                      <span className="bg-content2 px-1.5 py-0.5 rounded text-ink font-semibold">{fmtQty(b.initial_qty)}</span>
                      <span>·</span>
                      <span className="truncate max-w-[120px]">{b.vendor_name ?? "—"}</span>
                      <span>·</span>
                      <span className="text-ink">{label}: {fmtDate(b.expiry_date)}</span>
                    </div>
                  </div>
                );
              }}
            />
          </div>
        </div>
      ) : (
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="bg-content1/50 backdrop-blur-md p-4 rounded-xl border border-line/60 shadow-sm mb-6 sticky top-4 z-20">
            <FilterBar
              search={search}
              onSearch={setSearch}
              placeholder="Search serial, asset code, item or bin…"
              onReset={() => { setSearch(""); setSerialStatus(""); }}
            >
              <FilterSelect label="Status" value={serialStatus} onChange={setSerialStatus}
                            options={SERIAL_STATUSES} />
              <button
                type="button"
                onClick={() => setPrinting((p) => !p)}
                className="min-h-11 rounded-lg border border-primary/20 bg-primary/5 px-4 text-sm font-bold text-primary hover:bg-primary/10 transition-colors flex items-center gap-2"
              >
                <span>🖨️</span> {printing ? "Hide labels" : "Print labels"}
              </button>
            </FilterBar>
          </div>

          <ErrorBanner error={serials.error} />

          {printing && (
            <Card className="mb-6 p-6 shadow-md border border-line/80 bg-gradient-to-br from-content1 to-content2/30">
              <div className="mb-4 text-lg font-bold text-ink flex items-center gap-2"><span className="text-primary">🏷️</span> Print Serial Labels</div>
              <LabelSheet labels={labels} title="serial labels" emptyHint="Nothing to label." />
            </Card>
          )}

          <div className="bg-content1 rounded-xl shadow-sm border border-line/50 overflow-hidden">
            <ResponsiveList
              data={serialRows}
              columns={serialColumns}
              keyOf={(s) => s.id}
              loading={serials.isLoading}
              empty="No serial numbers match these filters."
              renderCard={(s) => (
                <div className="space-y-2 p-1 hover:bg-content2/30 transition-colors rounded-lg">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary/40" />
                      <span className="font-mono text-sm font-bold text-ink">{s.serial_number}</span>
                    </div>
                    <StatusPill status={normaliseStatus(s.status)} />
                  </div>
                  <div className="truncate text-sm font-medium text-body pl-3.5">{s.item_name ?? s.item_code ?? "—"}</div>
                  <div className="text-[11px] text-muted flex gap-2 items-center pl-3.5">
                    <span className="text-ink font-semibold">{s.warehouse_name ?? "—"}</span>
                    <span>·</span>
                    <span className="bg-content2 px-1.5 py-0.5 rounded text-ink font-mono">{s.bin_code ?? "bulk"}</span>
                    <span>·</span>
                    <span className="text-primary">{s.asset_code ?? s.consumable_code ?? "—"}</span>
                  </div>
                </div>
              )}
            />
          </div>
        </div>
      )}
    </div>
  );
}
