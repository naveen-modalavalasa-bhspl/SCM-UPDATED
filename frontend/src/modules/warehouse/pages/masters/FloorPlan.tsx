import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import { Thermometer } from "lucide-react";
import { Card, Select } from "@/shared/components";
import { ErrorBanner } from "../../components/Feedback";
import { MetaGrid, MetaRow } from "../../components/DocumentMeta";
import { listLocations, warehouseOptions } from "../../api";
import { fmtQty, humanise } from "../../format";
import type { WarehouseLocation } from "../../types";

/**
 * A top-down plan of one warehouse, drawn from `whs_locations`.
 *
 * The coordinates are already in the table (`pos_x`, `pos_y`, `length_cm`,
 * `width_cm`), so this is a projection of real data rather than a drawing tool —
 * nothing here writes a layout back. The 3D version this replaces pulled in three.js
 * to show the same rectangles from an angle nobody could pick a bin from.
 *
 * Locations with no coordinates cannot be placed; they are listed under the plan
 * instead of being silently dropped at the origin, which is what the old screen did
 * and why every unplaced rack appeared stacked in one corner.
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

  const placed = locations.filter((l) => l.pos_x != null && l.pos_y != null);
  const unplaced = locations.filter((l) => l.pos_x == null || l.pos_y == null);

  /** Fits every rectangle into the viewBox with a small margin. */
  const bounds = useMemo(() => {
    if (placed.length === 0) return { w: 100, h: 100 };
    const maxX = Math.max(...placed.map((l) => Number(l.pos_x) + Number(l.length_cm ?? 100) / 100));
    const maxY = Math.max(...placed.map((l) => Number(l.pos_y) + Number(l.width_cm ?? 100) / 100));
    return { w: maxX * 1.08 || 100, h: maxY * 1.08 || 100 };
  }, [placed]);

  const fill = (l: WarehouseLocation) => {
    if (!l.is_active) return "fill-content2 stroke-line";
    if (l.temperature_controlled) return "fill-info-bg stroke-info";
    return "fill-brand-050 stroke-brand";
  };

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
        <Card className="p-4">
          {isLoading ? (
            <div className="py-20 text-center text-muted">Loading…</div>
          ) : placed.length === 0 ? (
            <div className="py-20 text-center text-sm text-muted">
              No location on this site has coordinates yet, so there is nothing to draw.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <svg
                viewBox={`0 0 ${bounds.w} ${bounds.h}`}
                className="h-auto w-full min-w-[520px]"
                role="img"
                aria-label="Warehouse floor plan"
              >
                {placed.map((l) => {
                  const x = Number(l.pos_x);
                  const y = Number(l.pos_y);
                  const w = Number(l.length_cm ?? 100) / 100;
                  const h = Number(l.width_cm ?? 100) / 100;
                  const active = selected?.id === l.id;
                  return (
                    <g
                      key={l.id}
                      onClick={() => setSelected(l)}
                      className="cursor-pointer"
                      role="button"
                      aria-label={l.code}
                    >
                      <rect
                        x={x}
                        y={y}
                        width={w}
                        height={h}
                        rx={Math.min(w, h) * 0.08}
                        strokeWidth={active ? 0.35 : 0.15}
                        className={`${fill(l)} ${active ? "opacity-100" : "opacity-90"}`}
                      />
                      <text
                        x={x + w / 2}
                        y={y + h / 2}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        className="fill-ink"
                        style={{ fontSize: Math.min(w, h) * 0.28 }}
                      >
                        {l.code}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-muted">
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded border border-brand bg-brand-050" /> Ambient
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded border border-info bg-info-bg" /> Temperature controlled
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded border border-line bg-content2" /> Inactive
            </span>
          </div>
        </Card>

        <Card className="p-4">
          <h2 className="mb-3 font-display text-base font-bold text-ink">
            {selected ? selected.code : "Pick a location"}
          </h2>

          {selected ? (
            <MetaGrid columns={2}>
              <MetaRow label="Name" value={selected.name} />
              <MetaRow label="Storage type" value={humanise(selected.storage_type)} />
              <MetaRow label="Barcode" value={selected.barcode} />
              <MetaRow label="Status" value={selected.is_active ? "Active" : "Inactive"} />
              <MetaRow label="Capacity (weight)" value={fmtQty(selected.capacity_weight)} />
              <MetaRow label="Capacity (volume)" value={fmtQty(selected.capacity_volume)} />
              <MetaRow
                label="Footprint"
                value={
                  selected.length_cm && selected.width_cm
                    ? `${selected.length_cm} × ${selected.width_cm} cm`
                    : "—"
                }
              />
              <MetaRow label="Height" value={selected.height_cm ? `${selected.height_cm} cm` : "—"} />
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
            <p className="text-sm text-muted">Click a rectangle on the plan to see its details.</p>
          )}

          {unplaced.length > 0 && (
            <div className="mt-6 border-t border-line pt-4">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
                Not on the plan ({unplaced.length})
              </div>
              <p className="mb-2 text-xs text-muted">These locations have no coordinates yet.</p>
              <div className="flex flex-wrap gap-1.5">
                {unplaced.map((l) => (
                  <Chip key={l.id} size="sm" variant="flat">{l.code}</Chip>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
