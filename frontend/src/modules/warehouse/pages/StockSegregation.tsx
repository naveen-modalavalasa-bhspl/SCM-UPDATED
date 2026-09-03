import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import { Card, ErrorBanner, PageHeader, ResponsiveList, StatCard, StatusPill, SubNav, type Column } from "@/shared/components";
import { FilterBar, FilterSelect } from "../components/FilterBar";
import { LabelSheet, type LabelSpec } from "../components/LabelPrint";
import { Lookup } from "../components/Lookup";
import { listBatches, listSerials, warehouseOptions, itemOptions, getItemLocations, listLocations } from "../api";
import { daysUntil, fmtDate, fmtQty, normaliseStatus } from "../format";
import type { Batch, SerialNumber } from "../types";
import { usePointLabel } from "../usePointLabel";

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
          <div className="col-span-1 border border-line rounded-xl bg-content1 overflow-hidden flex flex-col shadow-sm sticky top-6">
            <div className="bg-content2 px-4 py-3 border-b border-line font-semibold text-sm flex items-center justify-between">
              Storage Hierarchy
              {locationsQuery.isLoading && <div className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />}
            </div>
            
            <div className="p-2 space-y-1 overflow-y-auto max-h-[600px] min-h-[300px]">
              {selectedLocationId != null && (
                <button 
                  onClick={() => setSelectedLocationId(locationMap.get(selectedLocationId)?.parent_location_id ?? null)} 
                  className="flex items-center text-sm text-primary hover:bg-content2 p-2 rounded-lg w-full text-left font-medium transition-colors"
                >
                  <span className="mr-2">←</span> Back to {breadcrumbs.length > 1 ? breadcrumbs[breadcrumbs.length - 2].name || breadcrumbs[breadcrumbs.length - 2].code : "Root"}
                </button>
              )}
              
              <div className="px-2 py-2 text-xs font-bold text-muted uppercase tracking-wider">
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
                    className="w-full text-left p-2.5 hover:bg-content2 active:bg-content3 rounded-lg flex justify-between items-center text-sm transition-colors group"
                  >
                    <div className="flex flex-col">
                      <span className="font-semibold text-ink group-hover:text-primary transition-colors">{loc.code}</span>
                      {loc.name && <span className="text-xs text-muted truncate">{loc.name}</span>}
                    </div>
                    {hasChildren && <span className="text-muted">›</span>}
                  </button>
                );
              })}
              
              {(locationChildren.get(selectedLocationId ?? null) || []).length === 0 && (
                <div className="p-5 flex flex-col">
                  <div className="text-[10px] font-bold tracking-wider text-muted uppercase mb-4 text-center bg-content2 py-1.5 px-3 rounded-full self-center">
                    Complete Hierarchy
                  </div>
                  <div className="flex flex-col gap-0 mt-2">
                    {breadcrumbs.map((crumb, idx) => {
                      const isLast = idx === breadcrumbs.length - 1;
                      return (
                        <div key={crumb.id} className="flex items-start">
                          <div className="flex flex-col items-center mr-3 h-full pt-1">
                            <div 
                              className={`w-3 h-3 rounded-full flex-shrink-0 z-10 transition-all duration-300 ${
                                isLast 
                                  ? 'bg-primary ring-4 ring-primary/20 shadow-sm shadow-primary/40' 
                                  : 'bg-content3 border border-content1'
                              }`} 
                            />
                            {!isLast && <div className="w-px h-10 bg-line/80 -mt-1" />}
                          </div>
                          <div className={`pb-2 flex flex-col ${isLast ? 'opacity-100' : 'opacity-70'} transition-opacity`}>
                            <span className={`text-sm ${isLast ? 'font-bold text-primary' : 'font-semibold text-body'}`}>
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
                  <div key={itemGroup.item_id} className="space-y-4">
                    {/* Item Header */}
                    <div className="flex items-center gap-3 pb-2 border-b border-line">
                      <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center font-bold text-lg">
                        {itemGroup.item_code?.[0] ?? "I"}
                      </div>
                      <div>
                        <h3 className="font-semibold text-lg text-ink">{itemGroup.item_name || "Unknown Item"}</h3>
                        <div className="text-sm text-muted font-mono">{itemGroup.item_code}</div>
                      </div>
                    </div>

                    {/* Aggregate Stats for this Item */}
                    <div className="grid grid-cols-3 gap-3">
                      <StatCard label="Total Available" value={fmtQty(itemGroup.total_available) + (itemGroup.uom_code ? ` ${itemGroup.uom_code}` : "")} />
                      <StatCard label="Total Reserved" value={fmtQty(itemGroup.total_reserved) + (itemGroup.uom_code ? ` ${itemGroup.uom_code}` : "")} />
                      <StatCard label="Total On Hand" value={fmtQty(itemGroup.total_on_hand) + (itemGroup.uom_code ? ` ${itemGroup.uom_code}` : "")} />
                    </div>

                    {/* Locations for this Item */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      {itemGroup.locations.map((loc) => (
                        <Card key={loc.bin_id} className="overflow-hidden shadow-sm hover:shadow-md transition-shadow">
                          <div className="border-b border-line bg-content2 px-4 py-3">
                            <div className="font-semibold text-ink flex items-center gap-2">
                              <span className="text-primary">📍</span> {loc.bin_code}
                            </div>
                            <div className="text-[11px] text-muted mt-1 uppercase tracking-wider">{loc.location_path.join(" › ")}</div>
                            <div className="mt-3 flex gap-4 text-sm bg-content1 rounded-md p-2">
                              <div><span className="text-muted text-xs block">Available</span> <span className="font-semibold">{fmtQty(loc.total_available)}</span></div>
                              <div><span className="text-muted text-xs block">Reserved</span> <span className="font-semibold">{fmtQty(loc.total_reserved)}</span></div>
                              <div><span className="text-muted text-xs block">On Hand</span> <span className="font-semibold">{fmtQty(loc.total_on_hand)}</span></div>
                            </div>
                          </div>
                          
                          {loc.batches.length > 0 && (
                            <div className="divide-y divide-line max-h-60 overflow-y-auto">
                              {loc.batches.map((b) => {
                                const tone = expiryTone(b.days_to_expiry ?? null, "Expiry");
                                return (
                                  <div key={b.stock_id} className="p-3 text-sm hover:bg-content2/50 transition-colors">
                                    <div className="flex items-center justify-between mb-1">
                                      <span className="font-mono font-semibold text-ink">{b.batch_no || b.serial_number || b.asset_code || "Bulk"}</span>
                                      {b.days_to_expiry !== null && (
                                        <Chip size="sm" variant="flat" color={tone.color}>{tone.label}</Chip>
                                      )}
                                    </div>
                                    <div className="text-xs text-muted flex justify-between">
                                      <span>
                                        {b.project_name && <span className="text-primary mr-2">P: {b.project_name}</span>}
                                        Avail: {fmtQty(b.available_qty)} | Res: {fmtQty(b.reserved_qty)}
                                      </span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </Card>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
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
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Batches held" value={batches.data?.items.length ?? 0} />
            <StatCard label="Expiring in 90 days" value={expiring} tone="text-warn" />
            <StatCard label="Expired" value={expired} tone="text-bad" />
            <StatCard
              label="Quantity"
              value={fmtQty((batches.data?.items ?? []).reduce((s, b) => s + Number(b.initial_qty ?? 0), 0))}
            />
          </div>

          <FilterBar
            search={search}
            onSearch={setSearch}
            placeholder="Search batch, item, vendor or GRN…"
            onReset={() => { setSearch(""); setBucket(""); }}
          >
            <FilterSelect label="Expiry / Warranty" allLabel="Any date" value={bucket} onChange={setBucket}
                          options={EXPIRY_BUCKETS} />
          </FilterBar>

          <ErrorBanner error={batches.error} />

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
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-semibold text-ink">{b.batch_no}</span>
                    <Chip size="sm" variant="flat" color={tone.color}>{tone.label}</Chip>
                  </div>
                  <div className="truncate text-sm text-body">{b.item_name ?? b.item_code ?? "—"}</div>
                  <div className="text-[11px] text-muted">
                    {fmtQty(b.initial_qty)} · {b.vendor_name ?? "—"} · {label}: {fmtDate(b.expiry_date)}
                  </div>
                </div>
              );
            }}
          />
        </>
      ) : (
        <>
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
              className="min-h-11 rounded-lg border border-line px-3 text-sm font-semibold text-body hover:bg-content2"
            >
              {printing ? "Hide labels" : "Print labels"}
            </button>
          </FilterBar>

          <ErrorBanner error={serials.error} />

          {printing && (
            <Card className="mb-4 p-4">
              <LabelSheet labels={labels} title="serial labels" emptyHint="Nothing to label." />
            </Card>
          )}

          <ResponsiveList
            data={serialRows}
            columns={serialColumns}
            keyOf={(s) => s.id}
            loading={serials.isLoading}
            empty="No serial numbers match these filters."
            renderCard={(s) => (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-semibold text-ink">{s.serial_number}</span>
                  <StatusPill status={normaliseStatus(s.status)} />
                </div>
                <div className="truncate text-sm text-body">{s.item_name ?? s.item_code ?? "—"}</div>
                <div className="text-[11px] text-muted">
                  {s.warehouse_name ?? "—"} · {s.bin_code ?? "bulk"} · {s.asset_code ?? s.consumable_code ?? "—"}
                </div>
              </div>
            )}
          />
        </>
      )}
    </div>
  );
}
