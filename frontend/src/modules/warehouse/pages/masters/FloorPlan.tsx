import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Thermometer } from "lucide-react";
import {
  Card, ResponsiveList, Select, StatusPill, type Column,
} from "@/shared/components";
import { ErrorBanner } from "@/shared/components";
import { MetaGrid, MetaRow } from "../../components/DocumentMeta";
import { listLocations, warehouseOptions } from "../../api";
import { fmtQty, humanise } from "../../format";
import type { WarehouseLocation } from "../../types";

/**
 * The storage locations of one warehouse, from `whs_warehouse_locations`.
 *
 * This is a list, not a drawing. The live table carries no surveyed coordinates
 * (`pos_x`/`pos_y`, footprint), so there is nothing to plot — an invented layout
 * would look authoritative while being fiction. If those columns are ever added,
 * a plan view can sit alongside this list; the data it needs is named above.
 */
export default function FloorPlan() {
  const [warehouse, setWarehouse] = useState("");
  const [selected, setSelected] = useState<WarehouseLocation | null>(null);

  const { data: houses = [] } = useQuery({
    queryKey: ["wh-lookup", "warehouses", ""],
    queryFn: () => warehouseOptions(),
    staleTime: 5 * 60_000,
  });

  const warehouseId = warehouse ? Number(warehouse) : houses[0]?.id;

  const { data: locations = [], isLoading, error } = useQuery({
    queryKey: ["wh-locations", warehouseId],
    queryFn: () => listLocations(warehouseId as number),
    enabled: !!warehouseId,
  });

  const columns: Column<WarehouseLocation>[] = [
    {
      key: "code",
      header: "Code",
      render: (l) => <span className="font-mono text-xs font-semibold text-ink">{l.code}</span>,
    },
    { key: "name", header: "Name", render: (l) => l.name ?? "—" },
    {
      key: "storage_type",
      header: "Storage type",
      render: (l) => humanise(l.storage_type) || "—",
    },
    { key: "floor_level", header: "Floor", render: (l) => l.floor_level ?? "—" },
    { key: "shelf_level", header: "Shelf", render: (l) => l.shelf_level ?? "—" },
    {
      key: "capacity_weight",
      header: "Capacity",
      render: (l) => fmtQty(l.capacity_weight),
    },
    {
      key: "temperature_controlled",
      header: "Cold chain",
      render: (l) =>
        l.temperature_controlled ? (
          <span className="flex items-center gap-1 text-info">
            <Thermometer className="h-3 w-3" /> Yes
          </span>
        ) : (
          "—"
        ),
    },
    {
      key: "is_active",
      header: "Status",
      render: (l) => <StatusPill status={l.is_active ? "APPROVED" : "CLOSED"} />,
    },
  ];

  return (
    <div>
      <Card className="mb-4 p-3">
        <div className="max-w-sm">
          <Select
            value={warehouse || String(warehouseId ?? "")}
            onChange={setWarehouse}
            ariaLabel="Warehouse"
            placeholder="Warehouse"
            options={houses.map((w) => ({
              value: w.id,
              label: w.code ? `${w.code} — ${w.name}` : w.name,
            }))}
          />
        </div>
      </Card>

      <ErrorBanner error={error} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        <ResponsiveList
          data={locations}
          columns={columns}
          keyOf={(l) => l.id}
          loading={isLoading}
          onRowClick={(l) => setSelected(l)}
          empty="This warehouse has no storage locations yet."
          renderCard={(l) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-ink">{l.code}</span>
                <StatusPill status={l.is_active ? "APPROVED" : "CLOSED"} />
              </div>
              <div className="truncate text-sm font-medium text-body">{l.name ?? "—"}</div>
              <div className="truncate text-[11px] text-muted">
                {humanise(l.storage_type) || "—"}
                {l.temperature_controlled ? " · Cold chain" : ""}
              </div>
            </div>
          )}
        />

        <Card className="p-4">
          <h2 className="mb-3 font-display text-base font-bold text-ink">
            {selected ? selected.code : "Pick a location"}
          </h2>

          {selected ? (
            <MetaGrid columns={2}>
              <MetaRow label="Name" value={selected.name} />
              <MetaRow label="Description" value={selected.description} />
              <MetaRow label="Storage type" value={humanise(selected.storage_type)} />
              <MetaRow label="Barcode" value={selected.barcode} />
              <MetaRow label="Floor" value={selected.floor_level} />
              <MetaRow label="Shelf" value={selected.shelf_level} />
              <MetaRow label="Status" value={selected.is_active ? "Active" : "Inactive"} />
              <MetaRow label="Capacity (weight)" value={fmtQty(selected.capacity_weight)} />
              <MetaRow label="Capacity (volume)" value={fmtQty(selected.capacity_volume)} />
              <MetaRow
                label="Height"
                value={selected.height_cm ? `${selected.height_cm} cm` : "—"}
              />
              {selected.temperature_controlled && (
                <div className="col-span-2">
                  <div className="mb-0.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-info">
                    <Thermometer className="h-3 w-3" /> Cold chain
                  </div>
                  <div className="text-sm text-ink">
                    target {selected.target_temperature_celsius ?? "—"}°C, allowed{" "}
                    {selected.min_temperature_celsius ?? "—"}°C to{" "}
                    {selected.max_temperature_celsius ?? "—"}°C
                  </div>
                </div>
              )}
            </MetaGrid>
          ) : (
            <p className="text-sm text-muted">Pick a location to see its details.</p>
          )}
        </Card>
      </div>
    </div>
  );
}
